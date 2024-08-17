// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../libraries/ABDKMath64x64.sol";
import "../libraries/UQ112x112.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

interface IUniswapPair {
    function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast);
}

interface IDOUGH {
    function mint(address to, uint256 amount) external;
    function burnFrom(address account, uint256 amount) external;
    function getRewardsAccumulated() external view returns (uint256);
    function clearRewardsAccumulated() external;
}

// Main contract for Le Oven - $DOUGH staking protocol.
contract LeOvenV3 is Ownable, ReentrancyGuard {
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

    uint256 public DEPOSIT_ID; // Deposit ID counter.
    uint256 private accRewardPerShare; // Accumulated rewards per share.
    uint256 private totalShares; // Total number of shares.
    uint256 private maxBakingTemp = 400; // Max price difference multiple (100x)
    uint256 private minBakingTemp = 5; // Min price difference multiple (1.25x)

    // dough
    IDOUGH private dough;
    // dough lp
    IUniswapPair private doughLp;
    // dough tokens reward per block
    uint256 private rewardPerBlock;
    // decay factor for reward per block
    uint256 private decay = 999999465 * 1e9; //0.999999465 * 1e18 ~ reward per block halvens every 3 months
    // checkpoint block on last update of rewards
    uint256 private lastRewardBlock;

    // Info of each deposit.
    mapping(uint256 => DepositInfo) private depositInfo;

    // Bool to enable deposits
    bool private preheated;

    // Events
    event Deposit(address indexed user, uint256 indexed depositId, uint224 indexed targetPrice, uint256 amount, uint256 shares);
    event Withdrawal(address indexed user, uint256 indexed depositId, uint256 amount);
    event Claim(address indexed user, uint256 indexed depositId, uint256 amount);
    event LogRewardPerBlockUpdate(uint256 newRewardPerBlock);
    event LogMaxBakingTempUpdate(uint256 newTemp);
    event LogMinBakingTempUpdate(uint256 newTemp);
    event LogDecayUpdate(uint256 newDecay);
    event LogUpdateRewards(
        uint256 lastRewardBlock,
        uint256 lpSupply,
        uint256 accRewardPerShare
    );

    constructor(
        IDOUGH _dough,
        IUniswapPair _doughLp,
        uint256 _rewardPerBlock
    ) Ownable(msg.sender) ReentrancyGuard() {
        dough = _dough;
        doughLp = _doughLp;
        rewardPerBlock = _rewardPerBlock;
        lastRewardBlock = block.number;
    }

    // Computes decay => principal * (ratio ^ n)
    function computeDecay(
        uint256 principal,
        uint256 ratio,
        uint256 n
    ) private pure returns (uint256) {
        return
            ABDKMath64x64.mulu(
                ABDKMath64x64.pow(
                    ABDKMath64x64.divu(ratio, 1e18),
                    n
                ),
                principal
            );
    }

    // Update additional rewards per block
    function updateRewardPerBlock(uint256 _rewardPerBlock) external onlyOwner {
        rewardPerBlock = _rewardPerBlock;
        emit LogRewardPerBlockUpdate(_rewardPerBlock);
    }

    // Update max baking temperature (price difference)
    function updateMaxBakingTemp(uint256 _maxBakingTemp) external onlyOwner {
        maxBakingTemp = _maxBakingTemp;
        emit LogMaxBakingTempUpdate(_maxBakingTemp);
    }

    // Update min baking temperature (price difference)
    function updateMinBakingTemp(uint256 _minBakingTemp) external onlyOwner {
        minBakingTemp = _minBakingTemp;
        emit LogMinBakingTempUpdate(_minBakingTemp);
    }

    // Update decay factor for rewards per block
    function updateDecay(uint256 _decay) external onlyOwner {
        decay = _decay;
        emit LogDecayUpdate(_decay);
    }

    // Get decay factor for rewards per block
    function getDecay() external view returns (uint256) {
        return decay;
    }

    // Get last reward block
    function getLastRewardBlock() external view returns (uint256) {
        return lastRewardBlock;
    }

    // View function to see claimable pending rewards on frontend.
    function getPendingRewards(uint256 depositId)
        external
        view
        returns (uint128 pending)
    {
        DepositInfo storage dep = depositInfo[depositId];
        uint128 pendingRaw = uint128(Math.mulDiv(
            dep.shares,
            accRewardPerShare,
            1e12
        ));
        pending = pendingRaw - dep.rewardDeductible;
        uint128 pendingPlusClaimed = pending + dep.claimedRewards;
        if (pendingPlusClaimed > dep.amount) {
            pending -= (pendingPlusClaimed - dep.amount);
        }
    }

    // View function to see raw pending rewards on frontend.
    function getRawPendingRewards(uint256 depositId)
        external
        view
        returns (uint128)
    {
        DepositInfo storage dep = depositInfo[depositId];
        uint128 pendingRaw = uint128(Math.mulDiv(
            dep.shares,
            accRewardPerShare,
            1e12
        ));
        return pendingRaw - dep.rewardDeductible;
    }

    // View function to get deposit info of depositId
    function getDepositInfo(uint256 depositId)
        external
        view
        returns (DepositInfo memory)
    {
        return depositInfo[depositId];
    }

    //Gets total rewards accumulated since last updateRewards() call.
    function getTotalRewardsAccumulated() public view returns (uint256) {
        uint256 doughRewardsAccumulated = dough.getRewardsAccumulated();
        uint256 rewardsFromEmissions = ((block.number - lastRewardBlock) * rewardPerBlock);
        return rewardsFromEmissions + doughRewardsAccumulated;
    }

    // View function to get accumulated rewards per share.
    function getAccRewardPerShare() external view returns (uint256) {
        return accRewardPerShare;
    }

    // View function to get current accumulated rewards per share (includes pending rewards).
    function getCurrAccRewardPerShare()
        external
        view
        returns (uint256)
    {
        return accRewardPerShare + Math.mulDiv(
            getTotalRewardsAccumulated(),
            1e12,
            totalShares
        );
    }

    // View function to get total shares.
    function getTotalShares() external view returns (uint256) {
        return totalShares;
    }

    // View function to get max baking temperature.
    function getMaxBakingTemp() external view returns (uint256) {
        return maxBakingTemp;
    }

    // View function to get min baking temperature.
    function getMinBakingTemp() external view returns (uint256) {
        return minBakingTemp;
    }

    // View function to get current reward rate per block.  
    function getRewardPerBlock() external view returns (uint256) {
        return rewardPerBlock;
    }

    // Internal function to get current price from Uniswap pool.
    function _getCurrPrice() private view returns (uint224 currPrice) {
        (uint112 reserve0, uint112 reserve1, ) = doughLp.getReserves();
        // currPrice = UQ112x112.encode(reserve0 * 1e9).uqdiv(reserve1); //scaling reserve0 (WETH) by factor of 1e9 for more precision
        currPrice = UQ112x112.encode(reserve1 * 1e9).uqdiv(reserve0); //scaling reserve1 (WETH) by factor of 1e9 for more precision
    }

    // Gets status of oven (whether it's preheated or not)
    function getIsOvenPreheated() external view returns (bool) {
        return preheated;
    }

    // Preheat LeOven (enable/disable deposits) NOTE: withdrawals/claims can never be disabled.
    function preheat(bool _isPreheated) external onlyOwner {
        preheated = _isPreheated;
        if (_isPreheated && totalShares == 0) {
            lastRewardBlock = block.number;
        }
    }

    //Force update reward variables.
    function forceUpdateRewards() external onlyOwner {
        updateRewards();
    }

    //Updates reward variables if block number > lastRewardBlock
    function updateRewards() private {
        if (lastRewardBlock >= block.number || totalShares == 0) return;

        // reward per share += (block difference * rewardPerBlock + accumulated rewards) / total shares
        accRewardPerShare += Math.mulDiv(
            getTotalRewardsAccumulated(),
            1e12,
            totalShares
        );
        dough.clearRewardsAccumulated();

        // update reward per block with decay
        rewardPerBlock = computeDecay(rewardPerBlock, decay, block.number - lastRewardBlock);
        lastRewardBlock = block.number;
        
        emit LogUpdateRewards(
            block.number,
            totalShares,
            accRewardPerShare
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

    // Claim rewards internal function for withdrawing. Returns actual pending rewards (subtracting deductible).
    function _claim(DepositInfo storage dep)
        private
        returns (uint128 pending)
    {
        // update reward variables
        updateRewards();

        // calculate pending rewards
        uint128 pendingRaw = uint128(Math.mulDiv(
            dep.shares,
            accRewardPerShare,
            1e12
        ));
        pending = pendingRaw - dep.rewardDeductible;
        dep.rewardDeductible = pendingRaw;
    }

    // Claim rewards internal function for claiming/compounding. Returns raw pending rewards (without subtracting deductible).
    function _claimRaw(DepositInfo storage dep)
        private
        returns (uint128 pendingRaw)
    {
        // update reward variables
        updateRewards();

        // calculate pending rewards
        pendingRaw = uint128(Math.mulDiv(
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
        dough.burnFrom(msg.sender, _amount);
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
        uint256 pending = _claim(dep);

        unchecked {
            totalShares -= dep.shares; //can never underflow - totalShares >= dep.shares
        }

        //mint pending rewards + deposit amount to sender, log event
        dough.mint(msg.sender, dep.amount + pending);
        emit Withdrawal(msg.sender, _depositId, dep.amount);
        emit Claim(msg.sender, _depositId, pending);

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

        // Checks if current market price is >= target price, and if so, withdraw first
        uint256 withdrawable;
        uint224 currPrice = _getCurrPrice();
        if (currPrice >= dep.targetPrice) {
            // current price is above target, claim + withdraw
            withdrawable = dep.amount;
            emit Withdrawal(msg.sender, _depositId, withdrawable);
            pending = _claim(dep);
            unchecked {
                totalShares -= dep.shares; //can never underflow - totalShares >= dep.shares
            }
            delete depositInfo[_depositId];
        } else {
            // current price is below target, claim only up to principal
            uint128 pendingRaw = _claimRaw(dep);
            pending = pendingRaw - dep.rewardDeductible;
            uint128 pendingPlusClaimed = pending + dep.claimedRewards;
            if (pendingPlusClaimed > dep.amount) {
                pendingRaw -= (pendingPlusClaimed - dep.amount);
                pending -= (pendingPlusClaimed - dep.amount);
                // pending = pending - (pending + dep.claimedRewards - dep.amount);
                //         = dep.amount - dep.claimedRewards; //this is correct
            }
            dep.rewardDeductible = pendingRaw;
            dep.claimedRewards += pending;
        }

        // Mint rewards to sender, log event
        dough.mint(msg.sender, uint256(pending) + withdrawable);
        emit Claim(msg.sender, _depositId, pending);
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

        uint128 pendingRaw = _claimRaw(dep);
        pending = pendingRaw - dep.rewardDeductible;
        uint128 pendingPlusClaimed = pending + dep.claimedRewards;
        if (pendingPlusClaimed > dep.amount) {
            pendingRaw -= (pendingPlusClaimed - dep.amount);
            pending -= (pendingPlusClaimed - dep.amount);
            // pending = pending - (pending + dep.claimedRewards - dep.amount);
            //         = dep.amount - dep.claimedRewards; //this is correct
        }
        dep.rewardDeductible = pendingRaw;
        dep.claimedRewards += uint128(pending);

        emit Claim(msg.sender, _depositId, pending);
        _deposit(pending, _bakingTemperature, msg.sender);
    }

}