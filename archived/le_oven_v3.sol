// SPDX-License-Identifier: MIT

// https://www.l3th1mc00k.xyz/

pragma solidity ^0.8.20;

import "../libraries/ABDKMath64x64.sol";
import "../libraries/UQ112x112.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

interface IUniswapPair {
    function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast);
    function totalSupply() external view returns (uint);
    function transferFrom(address from, address to, uint value) external returns (bool);
    function transfer(address to, uint value) external returns (bool);
}

interface IDOUGH {
    function totalSupply() external view returns (uint256);
    function mint(address to, uint256 amount) external;
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function burn(uint256 amount) external;
}

// Main contract for Le Oven - A novel reflection-based staking protocol built for diamond hands.
// Powered by Proof of Bake - staking based on a target price rather than a period of time.
contract LeOven is Ownable, ReentrancyGuard {
    using UQ112x112 for uint224;

    struct DepositInfo {
        uint128 amount; // How many tokens the user has provided.
        uint128 claimedRewards; // Amount of claimed rewards.
        uint128 shares; // Shares in reward pool. (amount * price difference multiple).
        uint128 rewardDeductible; // Reward deductible. (deposit.amount * accRewardPerShare at the time of staking)
        uint224 targetPrice; // Target price. Tokens can only be withdrawn if current price is above this.
        address account; // Owner account address.
        // pending reward = (deposit.shares * accRewardPerShare) - deposit.rewardDeductible
    }

    // Deposit ID counter
    uint256 public DEPOSIT_ID;

    // Reward variables
    uint256 public accRewardPerShare; // Accumulated rewards per share.
    uint256 public totalShares; // Total number of shares.

    // Variables that keep track of rewards: tokens burned (rewards) = totalSupplyAtInit + rewardsDistributed - totalSupply
    uint256 public immutable totalSupplyAtInit;
    uint256 public rewardsDistributed;
    uint256 public burnRewardRate = 100; //Ratio of burned tokens that go towards rewards

    // Min and max target price multiples
    uint256 public maxBakingTemp = 400; // Max price difference multiple (100x)
    uint256 public minBakingTemp = 5; // Min price difference multiple (1.25x)

    // Jeet penalty (penalty for withdrawing below target and forfeiting rewards)
    uint256 public jeetPenalty = 20;

    // dough
    IDOUGH public dough;
    // dough lp
    IUniswapPair public doughLp;

    // Info of each deposit.
    mapping(uint256 => DepositInfo) private depositInfo;

    // Bool to enable deposits
    bool public preheated;

    // Events
    event Deposit(address indexed user, uint256 indexed depositId, uint224 indexed targetPrice, uint256 amount, uint256 shares);
    event Withdrawal(address indexed user, uint256 indexed depositId, uint256 amount);
    event Claim(address indexed user, uint256 indexed depositId, uint256 amount);
    event Jeet(address indexed user, uint256 indexed depositId, uint256 amount, bool isLP);
    event LogMinBakingTempUpdate(uint256 newTemp);
    event LogUpdateRewards(
        uint256 lastRewardBlock,
        uint256 totalShares,
        uint256 accRewardPerShare,
        bool isLP
    );

    // Constructooor
    constructor(
        IDOUGH _dough,
        IUniswapPair _doughLp
    ) Ownable(msg.sender) ReentrancyGuard() {
        dough = _dough;
        doughLp = _doughLp;
        totalSupplyAtInit = dough.totalSupply();
    }

    // View function to see pending rewards on frontend.
    function getPendingRewards(uint256 _depositId)
        external
        view
        returns (uint128)
    {
        DepositInfo storage dep = depositInfo[_depositId];
        uint128 pendingRaw = uint128(Math.mulDiv(
            dep.shares,
            accRewardPerShare,
            1e12
        ));
        return pendingRaw - dep.rewardDeductible;
    }

    // View function to get deposit info of _depositId
    function getDepositInfo(uint256 _depositId)
        external
        view
        returns (DepositInfo memory)
    {
        return depositInfo[_depositId];
    }


    // View function to get current accumulated rewards per share (includes pending rewards).
    // TODO: Add burned tokens to rewards.
    function getCurrAccRewardPerShare()
        external
        view
        returns (uint256)
    {
        uint256 tokensBurned = totalSupplyAtInit + rewardsDistributed - dough.totalSupply();
        uint256 rewardsAddedPerShare = Math.mulDiv(
            tokensBurned,
            1e12,
            totalShares
        );
        return accRewardPerShare + rewardsAddedPerShare;
    }

    // Internal function to get current price from Uniswap pool.
    function _getCurrPrice() private view returns (uint224 currPrice) {
        (uint112 reserve0, uint112 reserve1, ) = doughLp.getReserves();
        currPrice = UQ112x112.encode(reserve0 * 1e9).uqdiv(reserve1); //scaling reserve1 (WETH) by factor of 1e9 for more precision
    }

    // Public getter function to get current price from Uniswap pool.
    function getCurrPrice() external view returns (uint224) {
        return _getCurrPrice();
    }

    // Preheat LeOven (enable/disable deposits) NOTE: withdrawals/claims can never be disabled.
    function preheat(bool _isPreheated) external onlyOwner {
        preheated = _isPreheated;
    }

    // Update min baking temperature (price difference)
    function updateMinBakingTemp(uint256 _minBakingTemp) external onlyOwner {
        minBakingTemp = _minBakingTemp;
        emit LogMinBakingTempUpdate(_minBakingTemp);
    }

    // Update jeet penalty
    function updateJeetPenalty(uint256 _jeetPenalty) external onlyOwner {
        require(_jeetPenalty <= 30, "exceeds max penalty"); //safeguard against excessive penalties
        jeetPenalty = _jeetPenalty;
    }

    //Force update reward variables.
    function forceUpdateRewards() external onlyOwner {
        updateRewards();
    }

    //Updates reward variables if block number > lastRewardBlock
    function updateRewards() private {
        // reward per share += (block difference * rewardPerBlock + accumulated rewards) / total shares
        if (totalShares == 0) return;
        uint256 tokensBurned = totalSupplyAtInit + rewardsDistributed - dough.totalSupply();
        accRewardPerShare += Math.mulDiv(
            tokensBurned,
            1e12,
            totalShares
        );
        emit LogUpdateRewards(
            block.number,
            totalShares,
            accRewardPerShare,
            false
        );
    }

    // Deposit tokens internal function
    function _deposit(
        uint256 _amount,
        uint128 _bakingTemperature,
        address _account
    ) private {
        // Checks
        require(preheated, "oven not preheated");
        require(_amount > 0, "invalid amount");
        require(_bakingTemperature >= minBakingTemp && _bakingTemperature <= maxBakingTemp, "invalid target price"); // must be between 1.25x (+25%) and maxBakingTemp (max price multiple)

        // Get current price and target price
        uint224 currPrice = _getCurrPrice();
        uint224 targetPrice = UQ112x112.mul126_2x112_112(_bakingTemperature, currPrice);
        
        DepositInfo storage dep = depositInfo[++DEPOSIT_ID];

        //calculate shares, emit event
        uint256 shares = UQ112x112.mul126_2x256(_bakingTemperature, _amount);
        emit Deposit(_account, DEPOSIT_ID, targetPrice, _amount, shares);

        // Update reward variables
        updateRewards();

        //update storage variables
        dep.amount = uint128(_amount);
        dep.shares = uint128(shares);
        dep.rewardDeductible = uint128(Math.mulDiv(
            shares,
            accRewardPerShare,
            1e12
        ));
        dep.account = _account;
        dep.targetPrice = targetPrice;

        totalShares += shares;
    }


    // Claim rewards internal function for claiming/compounding. Returns raw pending rewards (without subtracting deductible).
    function _claimRaw(DepositInfo storage dep)
        private
        returns (uint128)
    {
        updateRewards();
        return uint128(Math.mulDiv(
            dep.shares,
            accRewardPerShare,
            1e12
        ));                 
    }

    // Deposit tokens to LeOven
    // Target price difference is a Q126.2 binary fixed point number representing price difference as a multiple of .25 or 25%.
    function stakeNbake(
        uint256 _amount,
        uint128 _bakingTemperature
    ) external nonReentrant {
        dough.transferFrom(msg.sender, address(this), _amount);
        _deposit(_amount, _bakingTemperature, msg.sender);
    }

    // Withdraw tokens from LeOven.
    function removeWhenGoldenBrown(uint256 _depositId) 
        external
        nonReentrant
    {
        DepositInfo storage dep = depositInfo[_depositId];
        require(dep.account == msg.sender, "not allowed");

        // Check current market price and make sure it's >= target price.
        uint224 currPrice = _getCurrPrice();
        require(currPrice >= dep.targetPrice, "deposit not unlocked");

        // Get pending rewards
        uint256 pending = _claimRaw(dep) - dep.rewardDeductible;

        //mint rewards to sender, log events
        dough.mint(msg.sender, pending);
        rewardsDistributed += pending;
        emit Claim(msg.sender, _depositId, pending);
        emit Withdrawal(msg.sender, _depositId, dep.amount);

        //transfer principal amount, clear storage
        unchecked {
            totalShares -= dep.shares;
        }
        dough.transfer(msg.sender, dep.amount);
        delete depositInfo[_depositId];
    }

    // Claim rewards from LeOven.
    function collectBread(uint256 _depositId)
        external
        nonReentrant
        returns (uint128 pending)
    {
        DepositInfo storage dep = depositInfo[_depositId];
        require(dep.account == msg.sender, "not allowed");

        // Get pending rewards, check if pending + claimed rewards > principal, and adjusts
        uint128 pendingRaw = _claimRaw(dep);
        pending = pendingRaw - dep.rewardDeductible;
        dep.rewardDeductible = pendingRaw;
        dep.claimedRewards += pending;

        // Mint rewards to sender, log event
        emit Claim(msg.sender, _depositId, pending);
        dough.mint(msg.sender, pending);
        rewardsDistributed += pending;
    }

    //Compound rewards to new deposit.
    function stayBaked(
        uint256 _depositId,
        uint128 _bakingTemperature
    ) 
        external
        nonReentrant 
        returns (uint128 pending) 
    {
        DepositInfo storage dep = depositInfo[_depositId];
        require(dep.account == msg.sender, "not allowed");

        // Get pending rewards, check if pending + claimed rewards > principal, and adjusts
        uint128 pendingRaw = _claimRaw(dep);
        pending = pendingRaw - dep.rewardDeductible;
        dep.rewardDeductible = pendingRaw;
        dep.claimedRewards += pending;

        //create new deposit, log event
        emit Claim(msg.sender, _depositId, pending);
        _deposit(pending, _bakingTemperature, msg.sender);
    }

    // Forfeit deposit and withdraw principal with penalty. Only if no rewards have been claimed.
    function jeet(uint256 _depositId) external nonReentrant {
        DepositInfo storage dep = depositInfo[_depositId];
        require(dep.account == msg.sender, "not allowed");
        require(dep.claimedRewards < dep.amount, "principal amount already claimed, cannot jeet");

        // Transfer principal to owner, delete deposit
        unchecked {
            totalShares -= dep.shares;
        }
        uint256 penalty = Math.mulDiv(dep.amount, jeetPenalty, 100);
        if (dep.claimedRewards + penalty > dep.amount) {
            penalty = dep.amount - dep.claimedRewards;
        }
        uint256 jeetableAmount = dep.amount - (dep.claimedRewards + penalty);
        dough.transfer(msg.sender, jeetableAmount);
        dough.burn(penalty);
        emit Jeet(msg.sender, _depositId, jeetableAmount, false);
        delete depositInfo[_depositId];
    }

}