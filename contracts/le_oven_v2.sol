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
    function token1() external view returns (address);
}

interface IDOUGH {
    function totalSupply() external view returns (uint256);
    function mint(address to, uint256 amount) external;
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function burn(uint256 amount) external;
}

// Main contract for Le Oven - $DOUGH staking protocol.
contract LeOvenV4 is Ownable, ReentrancyGuard {
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

    // Deposit ID counters
    uint256 public DEPOSIT_ID;
    uint256 public DEPOSIT_ID_LP;

    // Reward variables
    uint256 public accRewardPerShare; // Accumulated rewards per share.
    uint256 public totalShares; // Total number of shares.
    uint256 public accRewardPerShareLP; // Accumulated rewards per share.
    uint256 public totalSharesLP; // Total number of shares.
    uint256 public lastRewardBlock; // checkpoint block on last update of rewards for $dough staking
    uint256 public lastRewardBlockLP; // checkpoint block on last update of rewards for LP staking

    // Emission rates and decay
    uint256 public rewardPerBlock;
    uint256 public rewardPerBlockLP;
    uint256 public decay = 999999465 * 1e9; //0.999999465 * 1e18 ~ reward per block halvens every 6 months
    uint256 public decayLP = decay;

    // Min and max target price multiples
    uint256 public constant maxBakingTemp = 400; // Max price difference multiple (100x)
    uint256 public minBakingTemp = 5; // Min price difference multiple (2x)

    // Jeet penalty (penalty for withdrawing below target and forfeiting rewards)
    uint256 public jeetPenalty = 15; // 15% penalty for $DOUGH staking
    uint256 public jeetPenaltyLP = 20; // 20% penalty for LP staking

    // Variables that keep track of rewards: tokens burned (rewards) = netCirculatingDough - totalSupply
    uint256 public netCirculatingDough; //netCirculatingDough gets increased when new dough is minted, decreased when burned tokens are added to reward pool
    uint256 public burnRewardPercentage = 100; //Percentage of burned tokens that go towards rewards
    uint256 public burnRewardsLPRatio = 20; //Ratio of burned token rewards that go towards LP stakers

    //TODO remove
    bool public immutable isWETHReserve0;

    // dough
    IDOUGH public dough;
    // dough lp
    IUniswapPair public doughLp;

    // Info of each deposit.
    mapping(uint256 => DepositInfo) private depositInfo;
    mapping(uint256 => DepositInfo) private depositInfoLP;

    // Bool to enable deposits
    bool public preheated;

    // Events
    event Deposit(address indexed user, uint256 indexed depositId, uint224 indexed targetPrice, uint256 amount, uint256 shares);
    event DepositLP(address indexed user, uint256 indexed depositId, uint224 indexed targetPrice, uint256 amount, uint256 shares);
    event Withdrawal(address indexed user, uint256 indexed depositId, uint256 amount, bool isLP);
    event Jeet(address indexed user, uint256 indexed depositId, uint256 amount, bool isLP);
    event Claim(address indexed user, uint256 indexed depositId, uint256 amount, bool isLP);

    // Modifier that ensures caller is not a smart contract
    modifier nonContractCaller() {
        require(msg.sender == tx.origin, "contract not allowed");
        _;
    }

    // Constructooor
    constructor(
        IDOUGH _dough,
        IUniswapPair _doughLp,
        uint256 _rewardPerBlock,
        uint256 _rewardPerBlockLP,
        uint256 _decay
    ) Ownable(msg.sender) ReentrancyGuard() {
        dough = _dough;
        doughLp = _doughLp;
        rewardPerBlock = _rewardPerBlock;
        rewardPerBlockLP = _rewardPerBlockLP;
        lastRewardBlock = lastRewardBlockLP = block.number;
        netCirculatingDough = 1_000_000_000 * 1e9;
        decay = decayLP = _decay;
        isWETHReserve0 = doughLp.token1() == address(dough);
    }

    /**
     * @dev Computes decay => principal * (ratio ^ n)
     * @param principal: Principal amount.
     * @param ratio: Ratio.
     * @param n: Number of blocks.
     */
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

    /**
     * @dev View function to get pending rewards for a given deposit.
     * @param _depositId: Deposit ID.
     * @param _isLP: Whether the deposit is an LP deposit or not.
     * @param _withLimit: Whether to return raw pending rewards or to return pending rewards after deducting claimed rewards.
     * @notice If _withLimit is true, it returns pending rewards after checking if pending + claimed rewards > principal and reducing it appropriately.
     * @notice _withLimit only applies to $DOUGH stakers, as it this limit isn't there for LP stakers.
     */
    function getPendingRewards(uint256 _depositId, bool _isLP, bool _withLimit)
        external
        view
        returns (uint128)
    {
        DepositInfo storage dep = _isLP ? depositInfoLP[_depositId] : depositInfo[_depositId];
        uint128 pendingRaw = uint128(Math.mulDiv(
            dep.shares,
            _isLP ? accRewardPerShareLP : accRewardPerShare,
            1e12
        ));
        uint128 pending = pendingRaw - dep.rewardDeductible;
        if (!_withLimit) return pending;
        if (!_isLP) {
            uint128 pendingPlusClaimed = pending + dep.claimedRewards;
            if (pendingPlusClaimed > dep.amount) {
                pending -= (pendingPlusClaimed - dep.amount);
            }
        }
        return pending;
    }

    /**
     * @dev View function to get deposit info of _depositId
     * @param _depositId: Deposit ID.
     * @param _isLP: Whether the deposit is an LP deposit or not.
     */
    function getDepositInfo(uint256 _depositId, bool _isLP)
        external
        view
        returns (DepositInfo memory)
    {
        return _isLP ? depositInfoLP[_depositId] : depositInfo[_depositId];
    }

    /**
     * @dev Internal function to get current price from Uniswap V2 pool.
     */
    function _getCurrPrice() private view returns (uint224 currPrice) {
        (uint112 reserve0, uint112 reserve1, ) = doughLp.getReserves();
        if (isWETHReserve0) currPrice = UQ112x112.encode(reserve0 * 1e9).uqdiv(reserve1); //scaling reserve0 (WETH) by factor of 1e9 for more precision
        else currPrice = UQ112x112.encode(reserve1 * 1e9).uqdiv(reserve0); //scaling reserve1 (WETH) by factor of 1e9 for more precision
    }

    /**
     * @dev External view function to get current price from Uniswap V2 pool.
     */
    function getCurrPrice() external view returns (uint224) {
        return _getCurrPrice();
    }

    /**
     * @dev Preheat LeOven (enable/disable deposits)
     * @param _isPreheated: Whether to enable or disable deposits.
     * @notice Withdrawals/claims can never be disabled, this can only halt new deposits.
     */
    function preheat(bool _isPreheated) external onlyOwner {
        preheated = _isPreheated;
        if (_isPreheated) {
            //update last reward block if totalShares = 0
            if (totalShares == 0) lastRewardBlock = block.number;
            if (totalSharesLP == 0) lastRewardBlockLP = block.number;
        }
    }

    /**
     * @dev Updates reward variables.
     */
    function updateRewardVariables(
        uint256 _rewardPerBlock,
        uint256 _rewardPerBlockLP,
        uint256 _decay,
        uint256 _jeetPenalty,
        uint256 _minBakingTemp,
        uint256 _burnRewardPercentage,
        uint256 _burnRewardsLPRatio,
        bool _isLP
    ) external onlyOwner {
        if (_isLP) {
            require(_jeetPenalty <= 30, "exceeds max penalty for LP stakers");
            decayLP = _decay;
            jeetPenaltyLP = _jeetPenalty;
        } else {
            require(_jeetPenalty <= 30, "exceeds max penalty for Dough stakers");
            decay = _decay;
            jeetPenalty = _jeetPenalty;
        }
        require(_burnRewardPercentage <= 100 && _burnRewardPercentage > 30, "burn reward percentage out of bounds");

        //handle 2 cases - transitioning from burn rewards to emissions, and transitioning from emissions to burn rewards
        //case 1: transitioning from burn rewards to emissions
        if (rewardPerBlock == 0 && rewardPerBlockLP == 0 && (_rewardPerBlock > 0 || _rewardPerBlockLP > 0)) {
            lastRewardBlock = lastRewardBlockLP = block.number; //start new reward cycle
        }
        //case 2: transitioning from emissions to burn rewards
        if (rewardPerBlock > 0 && rewardPerBlockLP > 0 && (_rewardPerBlock == 0 || _rewardPerBlockLP == 0)) {
            netCirculatingDough = dough.totalSupply(); //set netCirculatingDough to totalSupply as we are now transitioning to burn tax rewards.
        }
        
        rewardPerBlock = _rewardPerBlock;
        rewardPerBlockLP = _rewardPerBlockLP;
        minBakingTemp = _minBakingTemp;
        burnRewardPercentage = _burnRewardPercentage;
        burnRewardsLPRatio = _burnRewardsLPRatio;
    }

    /**
     * @dev Force updates rewards for $DOUGH staking or LP staking.
     * @param _isLP: Whether to update rewards for LP staking or $DOUGH staking.
     */
    function forceUpdateRewards(bool _isLP) external onlyOwner {
        if (_isLP) updateRewardsLP();
        else updateRewards();
    }

    /**
     * @dev Internal function that updates the following for $DOUGH staking:
     * - rewardPerBlock - gets updated based on decay
     * - lastRewardBlock - gets updated to current block
     * - accRewardPerShare - gets increased by emissions (or burn tax if rewardPerBlock == 0) divided by totalShares
     */
    function updateRewards() private {
        if (totalShares == 0 || lastRewardBlock >= block.number) return;
        if (rewardPerBlock == 0) {
            // use burned tokens for rewards once emissions are depleted
            uint256 tokensBurnt = netCirculatingDough - dough.totalSupply(); //cannot underflow as netCirculatingDough >= totalSupply
            uint256 burntRewards = Math.mulDiv(tokensBurnt, burnRewardPercentage, 100);
            netCirculatingDough -= tokensBurnt; //netCirculatingDough == totalSupply after this
            if (totalSharesLP > 0 && rewardPerBlockLP == 0) {
                uint256 lpRewards = Math.mulDiv(burntRewards, burnRewardsLPRatio, 100);
                accRewardPerShare += Math.mulDiv(
                    burntRewards - lpRewards,
                    1e12,
                    totalShares
                );
                accRewardPerShareLP += Math.mulDiv(
                    lpRewards,
                    1e12,
                    totalSharesLP
                );
            } else {
                accRewardPerShare += Math.mulDiv(
                    burntRewards,
                    1e12,
                    totalShares
                );
            }
        } else {
            // accRewardPerShare += (block difference * rewardPerBlock) / total shares
            accRewardPerShare += Math.mulDiv(
                (block.number - lastRewardBlock) * rewardPerBlock,
                1e12,
                totalShares
            );
            rewardPerBlock = computeDecay(rewardPerBlock, decay, block.number - lastRewardBlock);
            lastRewardBlock = block.number; //don't need to update lastRewardBlock once emissions are depleted
            if (rewardPerBlock == 0) netCirculatingDough = dough.totalSupply(); //set netCirculatingDough to totalSupply as we are now transitioning to burn tax rewards.
        }
    }

    /**
     * @dev Internal function that updates the following for LP staking:
     * - rewardPerBlock - gets updated based on decay
     * - lastRewardBlock - gets updated to current block
     * - accRewardPerShare - gets increased by emissions (or burn tax if rewardPerBlock == 0) divided by totalShares
     */
    function updateRewardsLP() private {
        if (totalSharesLP == 0 || lastRewardBlockLP >= block.number) return;
        if (rewardPerBlockLP == 0) { 
            // use burned tokens for rewards once emissions are depleted
            uint256 tokensBurnt = netCirculatingDough - dough.totalSupply(); //cannot underflow as netCirculatingDough >= totalSupply
            uint256 burntRewards = Math.mulDiv(tokensBurnt, burnRewardPercentage, 100);
            netCirculatingDough -= tokensBurnt; //netCirculatingDough == totalSupply after this
            if (totalShares > 0 && rewardPerBlock == 0) {
                uint256 lpRewards = Math.mulDiv(burntRewards, burnRewardsLPRatio, 100);
                accRewardPerShare += Math.mulDiv(
                    burntRewards - lpRewards,
                    1e12,
                    totalShares
                );
                accRewardPerShareLP += Math.mulDiv(
                    lpRewards,
                    1e12,
                    totalSharesLP
                );
            } else {
                accRewardPerShareLP += Math.mulDiv(
                    burntRewards,
                    1e12,
                    totalSharesLP
                );
            }
        } else {
            // accRewardPerShare += (block difference * rewardPerBlock) / total shares
            accRewardPerShareLP += Math.mulDiv(
                (block.number - lastRewardBlockLP) * rewardPerBlockLP,
                1e12,
                totalSharesLP
            );
            rewardPerBlockLP = computeDecay(rewardPerBlockLP, decayLP, block.number - lastRewardBlockLP);
            lastRewardBlockLP = block.number;
            if (rewardPerBlockLP == 0) netCirculatingDough = dough.totalSupply(); //set netCirculatingDough to totalSupply as we are now transitioning to burn tax rewards.
        }
    }

    /**
     * @dev Deposit $DOUGH internal function
     * @param _amount: Amount of tokens to deposit.
     * @param _bakingTemperature: Target price multiple.
     * @param _account: Account address.
     */
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

    /**
     * @dev Deposit LP tokens internal function
     * @param _amount: Amount of tokens to deposit.
     * @param _bakingTemperature: Target price multiple.
     * @param _account: Account address.
     */
    function _depositLP(
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
        
        DepositInfo storage dep = depositInfoLP[++DEPOSIT_ID_LP];

        //calculate shares, emit event
        uint256 shares = UQ112x112.mul126_2x256(_bakingTemperature, _amount);
        emit DepositLP(_account, DEPOSIT_ID_LP, targetPrice, _amount, shares);

        // Update reward variables
        updateRewardsLP();

        //update storage variables
        dep.amount = uint128(_amount);
        dep.shares = uint128(shares);
        dep.rewardDeductible = uint128(Math.mulDiv(
            shares,
            accRewardPerShareLP,
            1e12
        ));
        dep.account = _account;
        dep.targetPrice = targetPrice;

        totalSharesLP += shares;
    }

    /**
     * @dev Claim rewards internal function for claiming/compounding. Returns raw rewards (without subtracting deductible).
     * @param _dep: DepositInfo for deposit.
     * @param _isLP: Whether the deposit is an LP deposit or not.
     */
    function _claimRaw(DepositInfo storage _dep, bool _isLP)
        private
        returns (uint128)
    {
        if (_isLP) {
            updateRewardsLP();
            return uint128(Math.mulDiv(
                _dep.shares,
                accRewardPerShareLP,
                1e12
            ));
        } else {
            updateRewards();
            return uint128(Math.mulDiv(
                _dep.shares,
                accRewardPerShare,
                1e12
            ));
        }
    }

    /**
     * @dev Stakes (deposits) tokens in LeOven.
     * @param _amount: Amount of tokens to deposit.
     * @param _bakingTemperature: Target price multiple - a Q126.2 binary fixed point number representing price multiple in increments of .25x or 25%.
     * @param _isLP: Whether the deposit is an LP deposit or not.
     */
    function stakeNbake(
        uint256 _amount,
        uint128 _bakingTemperature,
        bool _isLP
    ) external nonReentrant nonContractCaller {
        if (_isLP) {
            doughLp.transferFrom(msg.sender, address(this), _amount);
            _depositLP(_amount, _bakingTemperature, msg.sender);
        } else {
            dough.transferFrom(msg.sender, address(this), _amount);
            _deposit(_amount, _bakingTemperature, msg.sender);
        }
    }

    /**
     * @dev Withdraws a deposit from LeOven
     * @param _depositId: Deposit ID.
     * @param _isLP: Whether the deposit is an LP deposit or not.
     * @notice Requirements:
     * - Deposit must be unlocked (current price >= target price)
     * - Only the owner of the deposit can withdraw
     * @notice Claims all pending rewards as well.
     */
    function removeWhenGoldenBrown(uint256 _depositId, bool _isLP) 
        external
        nonReentrant
        nonContractCaller
    {
        DepositInfo storage dep = _isLP ? depositInfoLP[_depositId] : depositInfo[_depositId];
        require(dep.account == msg.sender, "not allowed");

        // Check current market price and make sure it's >= target price.
        uint224 currPrice = _getCurrPrice();
        require(currPrice >= dep.targetPrice, "deposit not unlocked");

        // Get pending rewards
        uint256 pending = _claimRaw(dep, _isLP) - dep.rewardDeductible;

        //mint rewards to sender, log events
        dough.mint(msg.sender, pending);
        netCirculatingDough += pending;
        emit Claim(msg.sender, _depositId, pending, _isLP);
        emit Withdrawal(msg.sender, _depositId, dep.amount, _isLP);

        //transfer principal amount, clear storage
        if (_isLP) {
            unchecked {
                totalSharesLP -= dep.shares; 
            }
            doughLp.transfer(msg.sender, dep.amount);
            delete depositInfoLP[_depositId];
        } else {
            unchecked {
                totalShares -= dep.shares;
            }
            dough.transfer(msg.sender, dep.amount);
            delete depositInfo[_depositId];
        }
    }

    /**
     * @dev Claim pending rewards for a deposit.
     * @param _depositId: Deposit ID.
     * @param _isLP: Whether the deposit is an LP deposit or not.
     * @notice Requirements:
     * - Deposit cannot be unlocked, requires current price < target price. If deposit is unlocked user can only withdraw.
     * - Only the owner of the deposit can claim.
     * - Can only claim rewards up to principal staked amount.
     * @notice Claims all pending rewards, user cannot claim a specific amount.
     */
    function collectBread(uint256 _depositId, bool _isLP)
        external
        nonReentrant
        nonContractCaller
        returns (uint128 pending)
    {
        DepositInfo storage dep = _isLP ? depositInfoLP[_depositId] : depositInfo[_depositId];
        require(dep.account == msg.sender, "not allowed");

        // Checks if deposit is unlocked
        uint224 currPrice = _getCurrPrice();
        require(currPrice < dep.targetPrice, "cannot claim once deposit is unlocked, must withdraw");

        // Get pending rewards, check if pending + claimed rewards > principal, and adjusts
        uint128 pendingRaw = _claimRaw(dep, _isLP);
        pending = pendingRaw - dep.rewardDeductible;
        if (!_isLP) {
            uint128 pendingPlusClaimed = pending + dep.claimedRewards;
            if (pendingPlusClaimed > dep.amount) {
                pendingRaw -= (pendingPlusClaimed - dep.amount);
                pending -= (pendingPlusClaimed - dep.amount);
            }
        }
        dep.rewardDeductible = pendingRaw;
        dep.claimedRewards += pending;

        // Mint rewards to sender, log event
        emit Claim(msg.sender, _depositId, pending, _isLP);
        dough.mint(msg.sender, pending);
        netCirculatingDough += pending;
    }

    /**
     * @dev Compounds pending rewards and creates a new deposit.
     * @param _depositId: Deposit ID.
     * @param _bakingTemperature: Target price multiple - a Q126.2 binary fixed point number representing price multiple in increments of .25x or 25%.
     * @param _isLP: Whether the deposit is an LP deposit or not.
     * @notice Requirements:
     * - Deposit cannot be unlocked, requires current price < target price. If deposit is unlocked user can only withdraw.
     * - Only the owner of the deposit can compound
     * - Can only compound rewards up to principal staked amount.
     */
    function stayBaked(
        uint256 _depositId,
        uint128 _bakingTemperature,
        bool _isLP
    ) 
        external
        nonReentrant
        nonContractCaller
        returns (uint128 pending) 
    {
        DepositInfo storage dep = _isLP ? depositInfoLP[_depositId] : depositInfo[_depositId];
        require(dep.account == msg.sender, "not allowed");

        // Checks if deposit is unlocked
        uint224 currPrice = _getCurrPrice();
        require(currPrice < dep.targetPrice, "cannot compound once deposit is unlocked");

        // Get pending rewards, check if pending + claimed rewards > principal, and adjusts
        uint128 pendingRaw = _claimRaw(dep, _isLP);
        pending = pendingRaw - dep.rewardDeductible;
        if (!_isLP) {
            uint128 pendingPlusClaimed = pending + dep.claimedRewards;
            if (pendingPlusClaimed > dep.amount) {
                pendingRaw -= (pendingPlusClaimed - dep.amount);
                pending -= (pendingPlusClaimed - dep.amount);
            }
        }
        dep.rewardDeductible = pendingRaw;
        dep.claimedRewards += uint128(pending);

        //create new deposit, log event
        emit Claim(msg.sender, _depositId, pending, _isLP);
        dough.mint(address(this), pending);
        netCirculatingDough += pending;
        _deposit(pending, _bakingTemperature, msg.sender);
    }

    /**
     * @dev Emergency withdraw - forfeit rewards and withdraw principal with penalty.
     * @param _depositId: Deposit ID.
     * @param _isLP: Whether the deposit is an LP deposit or not.
     * @notice Requirements:
     * - Deposit cannot have any claimed rewards. Claiming rewards forfeits right to jeet.
     * - Only the owner of the deposit can jeet.
     */
    function jeet(uint256 _depositId, bool _isLP) external nonReentrant nonContractCaller {
        DepositInfo storage dep = _isLP ? depositInfoLP[_depositId] : depositInfo[_depositId];
        require(dep.account == msg.sender, "not allowed");

        // Transfer principal to owner, delete deposit
        if (_isLP) {
            unchecked {
                totalSharesLP -= dep.shares;
            }
            uint256 pendingRewards = Math.mulDiv(
                dep.shares,
                accRewardPerShareLP,
                1e12
            ) - dep.rewardDeductible;
            accRewardPerShareLP += Math.mulDiv(
                pendingRewards,
                1e12,
                totalSharesLP
            );
            uint256 penalty = Math.mulDiv(dep.amount, jeetPenaltyLP, 100, Math.Rounding.Ceil);
            doughLp.transfer(msg.sender, dep.amount - penalty);
            doughLp.transfer(address(0), penalty);
            emit Jeet(msg.sender, _depositId, dep.amount - penalty, true);
            delete depositInfoLP[_depositId];
        } else {
            unchecked {
                totalShares -= dep.shares;
            }
            uint256 pendingRewards = Math.mulDiv(
                dep.shares,
                accRewardPerShare,
                1e12
            ) - dep.rewardDeductible;
            accRewardPerShare += Math.mulDiv(
                pendingRewards,
                1e12,
                totalShares
            );
            uint256 penalty = Math.mulDiv(dep.amount, jeetPenalty, 100, Math.Rounding.Ceil);
            require(dep.amount - penalty > dep.claimedRewards, "claimed rewards exceeds deposit amount - penalty");
            dough.transfer(msg.sender, (dep.amount - penalty) - dep.claimedRewards);
            dough.burn(penalty);
            emit Jeet(msg.sender, _depositId, dep.amount - penalty, false);
            delete depositInfo[_depositId];
        }
    }
}