// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/security/PausableUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "./token/IToken.sol"; 
import "./registry/interface/IIdentityRegistry.sol";
import "./compliance/modular/modules/AbstractModule.sol";

/**
 * @title RealEstateVault
 * @dev Production-ready vault with UUPS Upgradability, Role-Based Access Control,
 * and Stablecoin support for Hold-to-Earn yield distribution.
 */
contract RealEstateVault is 
    Initializable, 
    UUPSUpgradeable, 
    AccessControlUpgradeable, 
    ReentrancyGuardUpgradeable, 
    PausableUpgradeable, 
    AbstractModule 
{
    // Roles
    bytes32 public constant PRICE_MANAGER_ROLE = keccak256("PRICE_MANAGER_ROLE");
    bytes32 public constant TREASURY_AGENT_ROLE = keccak256("TREASURY_AGENT_ROLE");
    bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");

    IToken public token; // The Property Token
    IERC20 public paymentToken; // e.g. USDC
    uint256 public pricePerShare; // Price in paymentToken units (e.g. 10^6 for USDC)

    // Sales Revenue (Owner's funds)
    uint256 public salesRevenue;

    // Dividend State (Magnified Dividend Algorithm)
    uint256 public magnifiedDividendPerShare;
    mapping(address => int256) public magnifiedDividendCorrections;
    mapping(address => uint256) public withdrawnDividends;
    uint256 public totalYieldDeposited;
    
    uint256 constant internal MAGNITUDE = 2**128;

    event SharesBought(address indexed buyer, uint256 amount, uint256 totalCost);
    event SharesSold(address indexed seller, uint256 amount, uint256 payout);
    event PriceUpdated(uint256 newPrice);
    event YieldDeposited(address indexed depositor, uint256 amount);
    event YieldClaimed(address indexed user, uint256 amount);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        address _token, 
        address _paymentToken, 
        uint256 _price,
        address admin
    ) public initializer {
        __AccessControl_init();
        __UUPSUpgradeable_init();
        __ReentrancyGuard_init();
        __Pausable_init();

        token = IToken(_token);
        paymentToken = IERC20(_paymentToken);
        pricePerShare = _price;

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(UPGRADER_ROLE, admin);
        _grantRole(PRICE_MANAGER_ROLE, admin);
        _grantRole(TREASURY_AGENT_ROLE, admin);
    }

    // =========================================================================
    // Trading Logic
    // =========================================================================

    /**
     * @dev Buy shares with Payment Token (USDC/USDT)
     * @param amount The amount of property tokens to buy
     */
    function buy(uint256 amount) external nonReentrant whenNotPaused {
        _buyFor(msg.sender, amount);
    }

    /**
     * @dev Buy shares for a beneficiary
     */
    function buyFor(address beneficiary, uint256 amount) external nonReentrant whenNotPaused {
        _buyFor(beneficiary, amount);
    }

    function _buyFor(address beneficiary, uint256 amount) internal {
        require(amount > 0, "Amount must be greater than 0");
        
        uint256 decimals = token.decimals();
        uint256 totalCost = (amount * pricePerShare) / (10**decimals);
        
        // Transfer stablecoins from buyer to vault
        require(paymentToken.transferFrom(msg.sender, address(this), totalCost), "Payment failed");

        // Verify KYC via Identity Registry
        require(token.identityRegistry().isVerified(beneficiary), "User not verified");

        // Transfer property tokens to beneficiary
        require(token.transfer(beneficiary, amount), "Token transfer failed");
        
        // Track Sales Revenue
        salesRevenue += totalCost;

        emit SharesBought(beneficiary, amount, totalCost);
    }

    /**
     * @dev Sell shares for Payment Token
     */
    function sell(uint256 amount) external nonReentrant whenNotPaused {
        require(amount > 0, "Amount must be greater than 0");
        
        uint256 decimals = token.decimals();
        uint256 payout = (amount * pricePerShare) / (10**decimals);
        
        require(paymentToken.balanceOf(address(this)) >= payout, "Insufficient liquidity");

        // Transfer tokens from Seller to Vault
        require(token.transferFrom(msg.sender, address(this), amount), "Token transfer failed");

        // Send payment back to seller
        require(paymentToken.transfer(msg.sender, payout), "Payment payout failed");

        emit SharesSold(msg.sender, amount, payout);
    }

    /**
     * @dev Withdraw Sales Revenue (Treasury Agent only)
     */
    function withdrawRevenue(uint256 amount) external onlyRole(TREASURY_AGENT_ROLE) {
        require(amount <= salesRevenue, "Insufficient revenue");
        salesRevenue -= amount;
        require(paymentToken.transfer(msg.sender, amount), "Transfer failed");
    }

    /**
     * @dev Update the price per share (Price Manager only)
     */
    function setPrice(uint256 _newPrice) external onlyRole(PRICE_MANAGER_ROLE) {
        pricePerShare = _newPrice;
        emit PriceUpdated(_newPrice);
    }

    // =========================================================================
    // Yield Distribution Logic (Hold-to-Earn)
    // =========================================================================

    /**
     * @dev Deposit Yield (Payment Token) into the vault
     */
    function depositYield(uint256 amount) external {
        require(amount > 0, "Must deposit something");
        uint256 totalSupply = token.totalSupply();
        require(totalSupply > 0, "No tokens to receive yield");
        
        // Transfer yield from depositor
        require(paymentToken.transferFrom(msg.sender, address(this), amount), "Yield deposit failed");

        totalYieldDeposited += amount;
        magnifiedDividendPerShare += (amount * MAGNITUDE) / totalSupply;
        
        emit YieldDeposited(msg.sender, amount);
    }

    /**
     * @dev Claim pending yield
     */
    function claimYield() external nonReentrant {
        uint256 withdrawable = withdrawableYieldOf(msg.sender);
        require(withdrawable > 0, "No yield to claim");

        withdrawnDividends[msg.sender] += withdrawable;
        require(paymentToken.transfer(msg.sender, withdrawable), "Yield transfer failed");
        
        emit YieldClaimed(msg.sender, withdrawable);
    }

    function withdrawableYieldOf(address user) public view returns (uint256) {
        return accumulativeDividendOf(user) - withdrawnDividends[user];
    }

    function accumulativeDividendOf(address user) public view returns (uint256) {
        return uint256(int256(magnifiedDividendPerShare * token.balanceOf(user)) + magnifiedDividendCorrections[user]) / MAGNITUDE;
    }

    // =========================================================================
    // Compliance Module Implementation
    // =========================================================================

    function moduleTransferAction(address _from, address _to, uint256 _value) external override onlyComplianceCall {
        magnifiedDividendCorrections[_from] += int256(magnifiedDividendPerShare * _value);
        magnifiedDividendCorrections[_to] -= int256(magnifiedDividendPerShare * _value);
    }

    function moduleMintAction(address _to, uint256 _value) external override onlyComplianceCall {
        magnifiedDividendCorrections[_to] -= int256(magnifiedDividendPerShare * _value);
    }

    function moduleBurnAction(address _from, uint256 _value) external override onlyComplianceCall {
        magnifiedDividendCorrections[_from] += int256(magnifiedDividendPerShare * _value);
    }

    function moduleCheck(address, address, uint256, address) external pure override returns (bool) {
        return true; 
    }

    function canComplianceBind(address) external pure override returns (bool) {
        return true;
    }

    function isPlugAndPlay() external pure override returns (bool) {
        return true;
    }

    function name() external pure override returns (string memory) {
        return "RealEstateVaultDividendModule";
    }

    // =========================================================================
    // Admin / Upgrade Logic
    // =========================================================================

    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyRole(UPGRADER_ROLE) {}
}
