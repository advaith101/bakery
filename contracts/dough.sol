// SPDX-License-Identifier: MIT

// hollup... l3t h1m c00k.
// https://twitter.com/l3th1mc00k

pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/Context.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "@openzeppelin/contracts/access/extensions/AccessControlEnumerable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

abstract contract IDOUGH {
    /**
     * @notice Tokens minted event
     */
    event Mint(address to, uint256 amount);

    /**
     * @notice Tokens burned event
     */
    event Burn(address from, uint256 amount);
}

interface IUniswapV2Factory {
    function createPair(address tokenA, address tokenB)
        external
        returns (address pair);
}

interface IUniswapV2Router02 {
    function swapExactTokensForETHSupportingFeeOnTransferTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external;

    function factory() external pure returns (address);

    function WETH() external pure returns (address);

    function addLiquidityETH(
        address token,
        uint256 amountTokenDesired,
        uint256 amountTokenMin,
        uint256 amountETHMin,
        address to,
        uint256 deadline
    )
        external
        payable
        returns (
            uint256 amountToken,
            uint256 amountETH,
            uint256 liquidity
        );
}

//Main contract for $DOUGH
contract Dough is Context, Ownable, IERC20, AccessControlEnumerable {

    /**
     * @dev ERC-20 Variables
     */
    mapping(address => uint256) private _balances;

    mapping(address => mapping(address => uint256)) private _allowances;

    uint256 private _totalSupply;

    string private constant _name = "L3T H1M C00K";
    string private constant _symbol = "DOUGH";

    /**
     * @dev Dough specific variables
     */
    bytes32 public constant OVEN_ROLE = keccak256("OVEN_ROLE"); // Role for minting tokens

    // struct for tax info
    struct TaxInfo {
        uint32 burnTaxBuy;
        uint32 burnTaxSell;
        uint32 rewardTaxBuy;
        uint32 rewardTaxSell;
        uint32 developmentTaxBuy;
        uint32 developmentTaxSell;
    }

    // tax info - represented as numerator / 1000 (i.e. 20 = 2%, 10 = 1%, etc.)
    TaxInfo public taxInfo = TaxInfo({
        burnTaxBuy: 0,
        burnTaxSell: 0,
        rewardTaxBuy: 0,
        rewardTaxSell: 0,
        developmentTaxBuy: 0,
        developmentTaxSell: 0
    });

    // accumulated reward tokens
    uint256 public rewardsAccumulated;

    // fee exceptions
    mapping(address => bool) private _isExcludedFromFee;
    // development wallet
    address public developmentWallet;

    uint256 private constant INIT_SUPPLY = 930_000_000 * 1e9; // 1 billion tokens

    //uniswap info
    IUniswapV2Router02 public uniswapV2Router;
    address public uniswapV2Pair;

    //Ferment dough
    bool public fermented;
    
    // contract fee swap info
    bool private inSwap;
    bool private swapEnabled = true;
    uint256 public _swapTokensAtAmount = INIT_SUPPLY / 5000;
    modifier lockTheSwap {
        inSwap = true;
        _;
        inSwap = false;
    }

    // constructooor
    constructor() Ownable(msg.sender) {
        // create uniswap pair
        IUniswapV2Router02 _uniswapV2Router = IUniswapV2Router02(0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D);
        uniswapV2Router = _uniswapV2Router;
        uniswapV2Pair = IUniswapV2Factory(_uniswapV2Router.factory())
            .createPair(address(this), _uniswapV2Router.WETH());
        
        // set development wallet, default fee exclusions
        developmentWallet = msg.sender;
        _isExcludedFromFee[msg.sender] = true;
        _isExcludedFromFee[address(this)] = true;

        // setup roles
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
            
        // mint init supply
        _mint(msg.sender, INIT_SUPPLY);
        emit Transfer(address(0), msg.sender, INIT_SUPPLY);
    }

    /**
     * @dev fallback for receiving ETH - needed for swapping marketing tax tokens to ETH
     */
    receive() external payable {}

    /**
     * @notice ERC-20 Functions
     */
    /**
     * @dev Returns the name of the token.
     */
    function name() public pure returns (string memory) {
        return _name;
    }

    /**
     * @dev Returns the symbol of the token, usually a shorter version of the
     * name.
     */
    function symbol() public pure returns (string memory) {
        return _symbol;
    }

    /**
     * @dev Returns the number of decimals used to get its user representation.
     * For example, if `decimals` equals `2`, a balance of `505` tokens should
     * be displayed to a user as `5.05` (`505 / 10 ** 2`).
     *
     * Tokens usually opt for a value of 18, imitating the relationship between
     * Ether and Wei. This is the value {ERC20} uses, unless this function is
     * overridden;
     *
     * NOTE: This information is only used for _display_ purposes: it in
     * no way affects any of the arithmetic of the contract, including
     * {IERC20-balanceOf} and {IERC20-transfer}.
     */
    function decimals() public pure returns (uint8) {
        return 9;
    }

    /**
     * @dev See {IERC20-totalSupply}.
     */
    function totalSupply() public view override returns (uint256) {
        return _totalSupply;
    }

    /**
     * @dev See {IERC20-balanceOf}.
     */
    function balanceOf(address account)
        public
        view
        override
        returns (uint256)
    {
        return _balances[account];
    }

    /**
     * @dev See {IERC20-transfer}.
     *
     * Requirements:
     *
     * - `to` cannot be the zero address.
     * - the caller must have a balance of at least `amount`.
     */
    function transfer(address to, uint256 amount)
        public
        override
        returns (bool)
    {
        _transfer(_msgSender(), to, amount);
        return true;
    }

    /**
     * @dev See {IERC20-allowance}.
     */
    function allowance(address owner, address spender)
        public
        view
        override
        returns (uint256)
    {
        return _allowances[owner][spender];
    }

    /**
     * @dev See {IERC20-approve}.
     *
     * NOTE: If `amount` is the maximum `uint256`, the allowance is not updated on
     * `transferFrom`. This is semantically equivalent to an infinite approval.
     *
     * Requirements:
     *
     * - `spender` cannot be the zero address.
     */
    function approve(address spender, uint256 amount)
        public
        override
        returns (bool)
    {
        _approve(_msgSender(), spender, amount);
        return true;
    }

    /**
     * @dev See {IERC20-transferFrom}.
     *
     * Emits an {Approval} event indicating the updated allowance. This is not
     * required by the EIP. See the note at the beginning of {ERC20}.
     *
     * NOTE: Does not update the allowance if the current allowance
     * is the maximum `uint256`.
     *
     * Requirements:
     *
     * - `from` and `to` cannot be the zero address.
     * - `from` must have a balance of at least `amount`.
     * - the caller must have allowance for ``from``'s tokens of at least
     * `amount`.
     */
    function transferFrom(
        address from,
        address to,
        uint256 amount
    ) public override returns (bool) {
        address spender = _msgSender();
        _spendAllowance(from, spender, amount);
        _transfer(from, to, amount);
        return true;
    }

    /**
     * @dev Atomically increases the allowance granted to `spender` by the caller.
     *
     * This is an alternative to {approve} that can be used as a mitigation for
     * problems described in {IERC20-approve}.
     *
     * Emits an {Approval} event indicating the updated allowance.
     *
     * Requirements:
     *
     * - `spender` cannot be the zero address.
     */
    function increaseAllowance(address spender, uint256 addedValue)
        public
        returns (bool)
    {
        address owner = _msgSender();
        _approve(owner, spender, allowance(owner, spender) + addedValue);
        return true;
    }

    /**
     * @dev Atomically decreases the allowance granted to `spender` by the caller.
     *
     * This is an alternative to {approve} that can be used as a mitigation for
     * problems described in {IERC20-approve}.
     *
     * Emits an {Approval} event indicating the updated allowance.
     *
     * Requirements:
     *
     * - `spender` cannot be the zero address.
     * - `spender` must have allowance for the caller of at least
     * `subtractedValue`.
     */
    function decreaseAllowance(address spender, uint256 subtractedValue)
        public
        returns (bool)
    {
        address owner = _msgSender();
        uint256 currentAllowance = allowance(owner, spender);
        require(
            currentAllowance >= subtractedValue,
            "ERC20: decreased allowance below zero"
        );
        unchecked {
            _approve(owner, spender, currentAllowance - subtractedValue);
        }

        return true;
    }

    /**
     * @dev Moves `amount` of tokens from `from` to `to`.
     *
     * This internal function is equivalent to {transfer}, and can be used to
     * e.g. implement automatic token fees, slashing mechanisms, etc.
     *
     * Emits a {Transfer} event.
     *
     * Requirements:
     *
     * - `from` cannot be the zero address.
     * - `to` cannot be the zero address.
     * - `from` must have a balance of at least `amount`.
     */
    function _transfer(
        address from,
        address to,
        uint256 amount
    ) private {
        require(from != address(0), "ERC20: transfer from the zero address");
        require(to != address(0), "ERC20: transfer to the zero address");
        require(amount > 0, "Transfer amount must be greater than zero");

        if (from != owner() && to != owner()) {
            //Trade start check
            if (!fermented) {
                require(from == owner(), "DOUGH: This account cannot send tokens until dough is fermented");
            }
            //Swap and send tax tokens to development wallet
            uint256 contractTokenBalance = balanceOf(address(this));
            if (contractTokenBalance >= _swapTokensAtAmount && !inSwap && from != uniswapV2Pair && swapEnabled && !_isExcludedFromFee[from] && !_isExcludedFromFee[to]) {
                swapTokensForETH(contractTokenBalance);
                if (address(this).balance > 0) {
                    sendETHToFee(address(this).balance);
                }
            }
        }

        // set tax amount only if fee needs to be taken
        uint256 taxAmountDevelopment;
        uint256 taxAmountBurn;
        uint256 taxAmountReward;
        if (!(_isExcludedFromFee[from] || _isExcludedFromFee[to]) && !(from != uniswapV2Pair && to != uniswapV2Pair)) {
            if (from == uniswapV2Pair && to != address(uniswapV2Router)) {
                // buy
                taxAmountDevelopment = Math.mulDiv(amount, uint256(taxInfo.developmentTaxBuy), 1000);
                taxAmountBurn = Math.mulDiv(amount, uint256(taxInfo.burnTaxBuy), 1000);
                taxAmountReward = Math.mulDiv(amount, uint256(taxInfo.rewardTaxBuy), 1000);
            } else if (to == uniswapV2Pair && from != address(uniswapV2Router)) {
                // sell
                taxAmountDevelopment = Math.mulDiv(amount, uint256(taxInfo.developmentTaxSell), 1000);
                taxAmountBurn = Math.mulDiv(amount, uint256(taxInfo.burnTaxSell), 1000);
                taxAmountReward = Math.mulDiv(amount, uint256(taxInfo.rewardTaxSell), 1000);
            }
        }
        
        uint256 amountAfterTax;
        _balances[from] -= amount;
        unchecked {
            _totalSupply -= taxAmountBurn; // taxAmountBurn can never exceed total supply
            rewardsAccumulated += taxAmountReward; // rewardsAccumulated can never exceed total supply
            amountAfterTax = amount - (taxAmountDevelopment + taxAmountBurn + taxAmountReward); //cannot underflow as sum of taxes <= amount
            _balances[to] += amountAfterTax; // cannot overflow as totalSupply >= any balance
            _balances[address(this)] += taxAmountDevelopment; // cannot overflow as totalSupply >= any balance
        }
        
        emit Transfer(from, to, amountAfterTax);
    }

    /** @dev Creates `amount` tokens and assigns them to `account`, increasing
     * the total supply.
     *
     * Emits a {Transfer} event with `from` set to the zero address.
     *
     * Requirements:
     *
     * - `account` cannot be the zero address.
     */
    function _mint(address account, uint256 amount) private {
        require(account != address(0), "ERC20: mint to the zero address");
        _totalSupply += amount;
        unchecked {
            // Overflow not possible: balance + amount is at most totalSupply + amount, which is checked above.
            _balances[account] += amount;
        }
        emit Transfer(address(0), account, amount);
    }

    /**
     * @dev Destroys `amount` tokens from `account`, reducing the
     * total supply.
     *
     * Emits a {Transfer} event with `to` set to the zero address.
     *
     * Requirements:
     *
     * - `account` cannot be the zero address.
     * - `account` must have at least `amount` tokens.
     */
    function _burn(address account, uint256 amount) private {
        require(account != address(0), "ERC20: burn from the zero address");

        uint256 accountBalance = _balances[account];
        require(accountBalance >= amount, "ERC20: burn amount exceeds balance");
        unchecked {
            _balances[account] = accountBalance - amount;
            // Overflow not possible: amount <= accountBalance <= totalSupply.
            _totalSupply -= amount;
        }

        emit Transfer(account, address(0), amount);
    }

    /**
     * @dev Sets `amount` as the allowance of `spender` over the `owner` s tokens.
     *
     * This internal function is equivalent to `approve`, and can be used to
     * e.g. set automatic allowances for certain subsystems, etc.
     *
     * Emits an {Approval} event.
     *
     * Requirements:
     *
     * - `owner` cannot be the zero address.
     * - `spender` cannot be the zero address.
     */
    function _approve(
        address owner,
        address spender,
        uint256 amount
    ) private {
        require(owner != address(0), "ERC20: approve from the zero address");
        require(spender != address(0), "ERC20: approve to the zero address");

        _allowances[owner][spender] = amount;
        emit Approval(owner, spender, amount);
    }

    /**
     * @dev Updates `owner` s allowance for `spender` based on spent `amount`.
     *
     * Does not update the allowance amount in case of infinite allowance.
     * Revert if not enough allowance is available.
     *
     * Might emit an {Approval} event.
     */
    function _spendAllowance(
        address owner,
        address spender,
        uint256 amount
    ) private {
        uint256 currentAllowance = allowance(owner, spender);
        if (currentAllowance != type(uint256).max) {
            require(
                currentAllowance >= amount,
                "ERC20: insufficient allowance"
            );
            unchecked {
                _approve(owner, spender, currentAllowance - amount);
            }
        }
    }

    /**
     * @dev Destroys `amount` tokens from the caller.
     *
     * See {ERC20-_burn}.
     */
    function burn(uint256 amount) public {
        _burn(_msgSender(), amount);
    }

    /**
     * @dev Destroys `amount` tokens from `account`, deducting from the caller's
     * allowance.
     *
     * See {ERC20-_burn} and {ERC20-allowance}.
     *
     * Requirements:
     *
     * - the caller must have allowance for ``accounts``'s tokens of at least
     * `amount`.
     */
    function burnFrom(address account, uint256 amount) public {
        _spendAllowance(account, _msgSender(), amount);
        _burn(account, amount);
    }

    /**
     * @notice Gets the current reward balance of the contract
     */
    function getRewardsAccumulated() external view returns (uint256) {
        return rewardsAccumulated;
    }

    /**
     * @notice Gets tax info
     */
    function getTaxInfo() external view returns (TaxInfo memory) {
        return taxInfo;
    }

    /**
     * @notice Clears rewards accumulated
     */
    function clearRewardsAccumulated() external {
        require(hasRole(OVEN_ROLE, _msgSender()), "DOUGH: Must have OVEN_ROLE");
        assembly {
            sstore(rewardsAccumulated.slot, 0)
        }
    }

    /**
     * @notice Sets the tax
     */
    function setTaxInfo(
        uint32 _burnTaxBuy,
        uint32 _burnTaxSell,
        uint32 _rewardTaxBuy,
        uint32 _rewardTaxSell,
        uint32 _developmentTaxBuy,
        uint32 _developmentTaxSell
    ) external onlyOwner {
        require(
            _burnTaxBuy + _burnTaxSell + _rewardTaxBuy <= 150,
            "Total buy tax must be less than 15%");
        require(
            _burnTaxSell + _rewardTaxSell + _developmentTaxSell <= 150,
            "Total sell tax must be less than 15%");
        taxInfo = TaxInfo({
            burnTaxBuy: _burnTaxBuy,
            burnTaxSell: _burnTaxSell,
            rewardTaxBuy: _rewardTaxBuy,
            rewardTaxSell: _rewardTaxSell,
            developmentTaxBuy: _developmentTaxBuy,
            developmentTaxSell: _developmentTaxSell
        });
    }

    /**
     * @notice Sets the fee exceptions - for additional CEX/DEX listings
     */
    function setFeeException(address account, bool isExcluded)
        external
        onlyOwner
    {
        _isExcludedFromFee[account] = isExcluded;
    }


    /**
     * @notice Sets the development wallet
     */
    function setDevelopmentWallet(address _developmentWallet) external onlyOwner {
        developmentWallet = _developmentWallet;
    }

    /**
     * @notice Swaps tokens for ETH for marketing tax
     */
    function swapTokensForETH(uint256 tokenAmount) private lockTheSwap {
        address[] memory path = new address[](2);
        path[0] = address(this);
        path[1] = uniswapV2Router.WETH();
        _approve(address(this), address(uniswapV2Router), tokenAmount);
        uniswapV2Router.swapExactTokensForETHSupportingFeeOnTransferTokens(
            tokenAmount,
            0,
            path,
            address(this),
            block.timestamp
        );
    }

    // Send ETH to development wallet using low level call
    function sendETHToFee(uint256 amount) private {
        (bool success, ) = payable(developmentWallet).call{value: amount}("");
        require(success, "Unable to send ETH to marketing");
    }

    // Opens trading, cannot be closed once opened
    function fermentDough() external onlyOwner {
        fermented = true;
    }

    // Sets contract swap open for collecting fees
    function setSwapEnabled(bool _enabled) external onlyOwner {
        swapEnabled = _enabled;
    }

    // Sets swap tokens at amount for development fee
    function setSwapTokensAtAmount(uint256 _newSwapTokensAtAmount) external onlyOwner {
        _swapTokensAtAmount = _newSwapTokensAtAmount;
    }

    // Manually swaps contract tokens for ETH
    function manualswap() external {
        require(_msgSender() == owner() || _msgSender() == developmentWallet);
        swapTokensForETH(balanceOf(address(this)));
    }

    // Manually sends contract ETH to development wallet
    function manualsend() external {
        require(_msgSender() == owner() || _msgSender() == developmentWallet);
        sendETHToFee(address(this).balance);
    }

    /**
     * @notice Mints new tokens, increasing totalSupply, initSupply, and a users balance.
     */
    function mint(address to, uint256 amount) external returns (bool) {
        require(hasRole(OVEN_ROLE, _msgSender()), "DOUGH: Must have OVEN_ROLE");
        _mint(to, amount);
        return true;
    }
}