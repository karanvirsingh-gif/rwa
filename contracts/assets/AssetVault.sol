// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/security/PausableUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "../token/IToken.sol";
import "./AssetTreasury.sol";

/**
 * @title AssetVault
 * @dev ONE implementation shared by every asset class - real estate, gold, silver,
 * bonds, whatever comes next. What differs per asset is data (assetType tag,
 * paymentMode, price), never code. Replaces RealEstateVault.sol and gold/GoldVault.sol.
 *
 * Deliberately does NOT hold funds (see AssetTreasury) and does NOT implement
 * AbstractModule / dividend accounting (see YieldDistributor) - this contract's only
 * job is primary settlement: turning a confirmed purchase into a mint, and a
 * redemption request into a burn + payout.
 *
 * Mint-on-settlement: totalSupply always equals exactly what investors hold. No
 * pre-minted inventory sits in this contract accruing yield nobody can claim.
 */
contract AssetVault is
    Initializable,
    UUPSUpgradeable,
    AccessControlUpgradeable,
    ReentrancyGuardUpgradeable,
    PausableUpgradeable
{
    bytes32 public constant SETTLEMENT_ROLE = keccak256("SETTLEMENT_ROLE"); // backend, mints on confirmed funds
    bytes32 public constant PRICE_ORACLE_ROLE = keccak256("PRICE_ORACLE_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");

    enum PaymentMode { STABLECOIN_DIRECT, FIAT_BACKEND_SETTLED }

    bytes32 public assetId;
    bytes32 public assetType;      // "REAL_ESTATE" | "GOLD" | "SILVER" | "BOND" ... a tag only, never branched on
    IToken public token;
    IERC20 public paymentToken;
    AssetTreasury public treasury;
    PaymentMode public paymentMode;
    uint256 public pricePerUnit;   // in paymentToken units, per whole unit of token (10**token.decimals())

    event Settled(address indexed beneficiary, uint256 amount, uint256 cost);
    event FiatCredited(address indexed beneficiary, uint256 amount, string offchainRef);
    event Redeemed(address indexed investor, uint256 amount, uint256 payout);
    event PriceUpdated(uint256 newPrice);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        bytes32 _assetId,
        bytes32 _assetType,
        address _token,
        address _paymentToken,
        address _treasury,
        PaymentMode _mode,
        uint256 _price,
        address admin
    ) public initializer {
        __AccessControl_init();
        __UUPSUpgradeable_init();
        __ReentrancyGuard_init();
        __Pausable_init();

        assetId = _assetId;
        assetType = _assetType;
        token = IToken(_token);
        paymentToken = IERC20(_paymentToken);
        treasury = AssetTreasury(_treasury);
        paymentMode = _mode;
        pricePerUnit = _price;

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(SETTLEMENT_ROLE, admin);
        _grantRole(PRICE_ORACLE_ROLE, admin);
        _grantRole(PAUSER_ROLE, admin);
        _grantRole(UPGRADER_ROLE, admin);
    }

    // =========================================================================
    // Primary settlement
    // =========================================================================

    /// @dev WALLET-triggered. Stablecoin rail only - investor must approve() this
    /// vault for `cost` beforehand.
    function buy(uint256 amount) external nonReentrant whenNotPaused {
        _buyFor(msg.sender, amount);
    }

    /// @dev WALLET-triggered, buying on behalf of a beneficiary address.
    function buyFor(address beneficiary, uint256 amount) external nonReentrant whenNotPaused {
        _buyFor(beneficiary, amount);
    }

    function _buyFor(address beneficiary, uint256 amount) internal {
        require(paymentMode == PaymentMode.STABLECOIN_DIRECT, "wrong rail for this asset");
        require(amount > 0, "amount must be greater than 0");

        uint256 cost = _cost(amount);
        require(paymentToken.transferFrom(msg.sender, address(treasury), cost), "payment failed");
        treasury.receiveFunds(cost);

        _settle(beneficiary, amount);
        emit Settled(beneficiary, amount, cost);
    }

    /// @dev BACKEND ONLY. Fiat rail - called by the Settlement Engine after the bank
    /// webhook confirms escrow lock. There is no wallet signature possible for a bank
    /// transfer, so this function must never accept a non-operator caller.
    function creditPurchase(address beneficiary, uint256 amount, string calldata offchainRef)
        external
        onlyRole(SETTLEMENT_ROLE)
        whenNotPaused
    {
        require(paymentMode == PaymentMode.FIAT_BACKEND_SETTLED, "wrong rail for this asset");
        require(amount > 0, "amount must be greater than 0");

        _settle(beneficiary, amount);
        emit FiatCredited(beneficiary, amount, offchainRef);
    }

    function _settle(address beneficiary, uint256 amount) internal {
        require(token.identityRegistry().isVerified(beneficiary), "beneficiary not verified");
        token.mint(beneficiary, amount); // requires this Vault to hold TOKEN_AGENT on `token`
    }

    // =========================================================================
    // Redemption
    // =========================================================================

    /// @dev WALLET-triggered self-service redemption - burn own tokens, atomic payout
    /// from the paired Treasury in the same transaction.
    function redeem(uint256 amount) external nonReentrant whenNotPaused {
        require(amount > 0, "amount must be greater than 0");
        uint256 payoutAmount = _cost(amount);
        require(paymentToken.balanceOf(address(treasury)) >= payoutAmount, "insufficient liquidity");

        token.burn(msg.sender, amount); // requires this Vault to hold TOKEN_AGENT on `token`
        treasury.payout(msg.sender, payoutAmount);

        emit Redeemed(msg.sender, amount, payoutAmount);
    }

    // =========================================================================
    // Admin
    // =========================================================================

    function setPrice(uint256 newPrice) external onlyRole(PRICE_ORACLE_ROLE) {
        pricePerUnit = newPrice;
        emit PriceUpdated(newPrice);
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    function _cost(uint256 amount) internal view returns (uint256) {
        return (amount * pricePerUnit) / (10 ** token.decimals());
    }

    function _authorizeUpgrade(address) internal override onlyRole(UPGRADER_ROLE) {}
}
