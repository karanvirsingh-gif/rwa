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
    bool public isRecoveryMode;    // when true, redeem() routes to pro-rata recovery payout instead of fixed-price

    event Settled(address indexed beneficiary, uint256 amount, uint256 cost);
    event FiatCredited(address indexed beneficiary, uint256 amount, string offchainRef);
    event Redeemed(address indexed investor, uint256 amount, uint256 payout);
    event PriceUpdated(uint256 newPrice);
    event RecoveryRedeemed(address indexed investor, uint256 tokenAmount, uint256 payout);
    event RecoveryModeSet(bool status);

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

    /// @dev WALLET-triggered self-service redemption — single unified entry point.
    ///
    ///      Routes internally based on `isRecoveryMode`:
    ///        - false (default): standard fixed-price redemption via _redeemStandard()
    ///        - true:            pro-rata recovery redemption via _redeemRecovery()
    ///
    ///      The routing flag is set by the asset admin (DEFAULT_ADMIN_ROLE) atomically
    ///      alongside RWALifecycleModule.transitionToRecovery(). Once activated, the
    ///      standard fixed-price path is permanently blocked for this vault instance,
    ///      preventing any investor from draining the treasury at the wrong exchange rate.
    ///
    /// @param amount Number of tokens to burn (must be <= caller's balance).
    function redeem(uint256 amount) external nonReentrant whenNotPaused {
        require(amount > 0, "amount must be greater than 0");
        if (isRecoveryMode) {
            _redeemRecovery(amount);
        } else {
            _redeemStandard(amount);
        }
    }

    /// @dev Standard fixed-price redemption. Burns tokens and pays out at pricePerUnit.
    ///      Only reachable when isRecoveryMode == false.
    function _redeemStandard(uint256 amount) internal {
        uint256 payoutAmount = _cost(amount);
        require(paymentToken.balanceOf(address(treasury)) >= payoutAmount, "insufficient liquidity");

        token.burn(msg.sender, amount); // requires this Vault to hold TOKEN_AGENT on `token`
        treasury.payout(msg.sender, payoutAmount);

        emit Redeemed(msg.sender, amount, payoutAmount);
    }

    /// @dev Pro-rata recovery redemption. Burns tokens and pays out a proportional
    ///      share of the legal settlement funds deposited in the treasury.
    ///
    ///      Payout formula: (amount / totalSupplyBeforeBurn) × treasury.balance()
    ///
    ///      This is self-balancing: as investors redeem, both totalSupply and
    ///      treasury balance decrease proportionally, so every investor gets the
    ///      same per-token rate regardless of when they redeem. The last investor
    ///      to burn receives the remaining dust.
    ///
    ///      Pre-conditions (enforced off-chain by the platform before calling
    ///      transitionToRecovery and setRecoveryMode):
    ///        1. AssetTreasury.deposit() has been called with the recovered amount.
    ///        2. RWALifecycleModule is in RECOVERY state (burns are allowed by compliance).
    ///        3. isRecoveryMode has been set to true by the asset admin.
    ///
    ///      Only reachable when isRecoveryMode == true.
    function _redeemRecovery(uint256 amount) internal {
        uint256 supplyBeforeBurn = token.totalSupply();
        require(supplyBeforeBurn > 0, 'no token supply');

        uint256 treasuryBalance = paymentToken.balanceOf(address(treasury));
        require(treasuryBalance > 0, 'no recovery funds in treasury');

        // Pro-rata share: (investor tokens / total supply) x recovery pool
        uint256 payoutAmount = (amount * treasuryBalance) / supplyBeforeBurn;
        require(payoutAmount > 0, 'payout rounds to zero');

        token.burn(msg.sender, amount); // compliance module must be in RECOVERY state or this reverts
        treasury.payout(msg.sender, payoutAmount);

        emit RecoveryRedeemed(msg.sender, amount, payoutAmount);
    }

    // =========================================================================
    // Admin
    // =========================================================================

    /// @dev Activates or deactivates recovery routing for this vault instance.
    ///      Must be called by the asset admin (DEFAULT_ADMIN_ROLE) atomically alongside
    ///      RWALifecycleModule.transitionToRecovery() to avoid a race-condition window.
    ///
    ///      Effect:
    ///        true  — redeem() routes to _redeemRecovery() (pro-rata, fixed-price path blocked)
    ///        false — redeem() routes to _redeemStandard() (normal operation)
    function setRecoveryMode(bool _status) external onlyRole(DEFAULT_ADMIN_ROLE) {
        isRecoveryMode = _status;
        emit RecoveryModeSet(_status);
    }

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
