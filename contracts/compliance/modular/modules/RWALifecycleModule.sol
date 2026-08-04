// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import './AbstractModuleUpgradeable.sol';
import '../IModularCompliance.sol';
import '../../../token/IToken.sol';

/**
 * @title RWALifecycleModule
 * @dev Unified ERC-3643 compliance module that enforces the full lifecycle state machine
 *      for BOTH Private Credit loans and Bond instruments.
 *
 *      Design: Feature Flags (not forking)
 *      ------------------------------------
 *      Rather than a separate BondStateModule or branching `if assetType == BOND` chains,
 *      this module stores two boolean flags per asset:
 *
 *        hasRefund   — controls whether the REFUND state is reachable
 *                      (Private Credit: always true | Bond: configurable)
 *        hasMaturity — controls whether MATURED state is reachable AND whether
 *                      auto-freeze at maturityTimestamp applies in ACTIVE state
 *                      (Private Credit: always true | Bond: configurable)
 *
 *      State Machine (both asset types share this graph):
 *      ---------------------------------------------------
 *                        .----------- FUNDING ------------.
 *                        |                                |
 *                        v                                v
 *      [hasRefund=true] REFUND          ACTIVE ---------> DEFAULTED
 *                                         |
 *                          [hasMaturity=true]
 *                                         |
 *                                         v
 *                                       MATURED
 *
 *      Private Credit enforcement:
 *        - hasRefund = true (always)
 *        - hasMaturity = true (always)
 *        - transitionToActive requires totalSupply >= targetPrincipal
 *
 *      Bond enforcement:
 *        - hasRefund and hasMaturity are configured at creation time
 *        - transitionToActive does NOT require full raise (open-ended issuance)
 *
 *      Upgradeability:
 *        Follows the T-REX UUPS pattern (AbstractModuleUpgradeable).
 *        Deploy via: new ModuleProxy(address(impl), abi.encodeCall(RWALifecycleModule.initialize, ()))
 *        The proxy address is the permanent on-chain address. Only the logic can be upgraded.
 */
contract RWALifecycleModule is AbstractModuleUpgradeable {

    // =========================================================================
    // Enums
    // =========================================================================

    enum AssetType {
        PRIVATE_CREDIT,
        BOND
    }

    enum LoanState {
        FUNDING,    // Initial escrow / capital-raising phase
        ACTIVE,     // Fully funded and live; P2P trading enabled
        MATURED,    // [hasMaturity=true] Loan/bond reached maturity; P2P frozen, burn to redeem
        DEFAULTED,  // All transfers strictly frozen until governance acts
        REFUND      // [hasRefund=true] Funding failed; burn-only (investor refunds)
    }

    // =========================================================================
    // Structs
    // =========================================================================

    struct LoanDetails {
        AssetType assetType;        // Classification for off-chain indexing and logic gates
        uint256 targetPrincipal;    // Max tokens that can be minted (funding cap)
        uint256 fundingDeadline;    // Unix timestamp: minting forbidden after this
        uint256 maturityTimestamp;  // Unix timestamp: auto-freeze P2P if hasMaturity=true (0 when hasMaturity=false)
        uint256 paymentFrequency;   // Coupon frequency in seconds (informative on-chain)
        uint256 couponRateBps;      // Annual coupon rate in basis points (informative on-chain)
        bytes32 agreementHash;      // SHA-256 hash of the off-chain agreement document
        address borrower;           // Wallet of the borrower / issuer
        LoanState state;            // Current lifecycle state
        bool hasRefund;             // If false, REFUND state is unreachable for this asset
        bool hasMaturity;           // If false, MATURED state is unreachable + no auto-freeze
    }

    // =========================================================================
    // ERC-7201 Namespaced Storage
    // =========================================================================

    struct RWALifecycleStorage {
        /// @dev token address => loan/bond details
        mapping(address => LoanDetails) loanConfigs;
    }

    // keccak256(abi.encode(uint256(keccak256("RWA.storage.RWALifecycleModule")) - 1)) & ~bytes32(uint256(0xff))
    // solhint-disable-next-line state-visibility
    uint256 private constant _RWA_LIFECYCLE_STORAGE_LOCATION =
        0xa1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e800;

    function _getStorage() private pure returns (RWALifecycleStorage storage s) {
        // solhint-disable-next-line no-inline-assembly
        assembly {
            s.slot := _RWA_LIFECYCLE_STORAGE_LOCATION
        }
    }

    // =========================================================================
    // Events
    // =========================================================================

    /**
     * @dev Emitted when a loan/bond is configured on the module for a token.
     * @param token        The ERC-3643 token address
     * @param assetType    PRIVATE_CREDIT or BOND
     * @param target       Target principal (funding cap) in token units
     * @param deadline     Funding deadline unix timestamp
     * @param borrower     Borrower/issuer wallet address
     * @param hasRefund    Whether REFUND state is enabled
     * @param hasMaturity  Whether MATURED state and maturity auto-freeze are enabled
     */
    event LoanInitialized(
        address indexed token,
        AssetType assetType,
        uint256 target,
        uint256 deadline,
        address borrower,
        bool hasRefund,
        bool hasMaturity
    );

    /**
     * @dev Emitted on every lifecycle state change.
     */
    event StateTransition(address indexed token, LoanState oldState, LoanState newState);

    // =========================================================================
    // Initializer (replaces constructor -- called once via ModuleProxy)
    // =========================================================================

    /**
     * @dev Initializes the upgradeable contract. Must be called exactly once,
     *      typically via the ModuleProxy constructor's `_data` parameter.
     *      The caller (proxy deployer) becomes the owner (platform admin).
     */
    function initialize() external initializer {
        __AbstractModule_init();
    }

    // =========================================================================
    // Loan / Bond Configuration
    // =========================================================================

    /**
     * @dev Configure the lifecycle parameters for a specific ERC-3643 token.
     *      Must be called by the platform admin (module owner) after asset creation.
     *
     * @param token               The token address (must be bound to a compliance that includes this module)
     * @param assetType           PRIVATE_CREDIT or BOND
     * @param targetPrincipal     Funding cap in token units (e.g., USDC with 6 decimals)
     * @param fundingDeadline     Unix timestamp after which minting is forbidden
     * @param maturityTimestamp   Unix timestamp of maturity; pass 0 when hasMaturity=false
     * @param paymentFrequency    Coupon payment frequency in seconds (informative)
     * @param couponRateBps       Annual coupon rate in basis points (informative)
     * @param agreementHash       SHA-256 hash of the off-chain legal agreement
     * @param borrower            Borrower/issuer wallet address
     * @param hasRefund           true: REFUND state reachable (call transitionToRefund)
     *                            false: transitionToRefund reverts for this asset
     * @param hasMaturity         true: MATURED state reachable + auto-freeze P2P at maturityTimestamp
     *                            false: transitionToMatured reverts + no timestamp-based freeze
     *
     * Validation rules enforced:
     *   - Private Credit must have both hasRefund=true and hasMaturity=true
     *   - When hasMaturity=false, maturityTimestamp must be 0 (avoids silent stale data)
     *   - When hasMaturity=true, maturityTimestamp must be after fundingDeadline
     */
    function initializeLoan(
        address token,
        AssetType assetType,
        uint256 targetPrincipal,
        uint256 fundingDeadline,
        uint256 maturityTimestamp,
        uint256 paymentFrequency,
        uint256 couponRateBps,
        bytes32 agreementHash,
        address borrower,
        bool hasRefund,
        bool hasMaturity
    ) external onlyOwner {
        RWALifecycleStorage storage s = _getStorage();
        require(s.loanConfigs[token].targetPrincipal == 0, 'Loan already initialized');
        require(token != address(0), 'Invalid token address');
        require(borrower != address(0), 'Invalid borrower address');
        require(fundingDeadline > block.timestamp, 'Funding deadline must be in the future');

        // Private Credit: both flags must be enabled (real-world enforcement)
        if (assetType == AssetType.PRIVATE_CREDIT) {
            require(hasRefund && hasMaturity, 'Private credit requires hasRefund=true and hasMaturity=true');
        }

        // Prevent accidental non-zero maturity timestamp when feature is disabled
        if (!hasMaturity) {
            require(maturityTimestamp == 0, 'Set maturityTimestamp to 0 when hasMaturity is false');
        } else {
            require(maturityTimestamp > fundingDeadline, 'Maturity must be after funding deadline');
        }

        s.loanConfigs[token] = LoanDetails({
            assetType: assetType,
            targetPrincipal: targetPrincipal,
            fundingDeadline: fundingDeadline,
            maturityTimestamp: maturityTimestamp,
            paymentFrequency: paymentFrequency,
            couponRateBps: couponRateBps,
            agreementHash: agreementHash,
            borrower: borrower,
            state: LoanState.FUNDING,
            hasRefund: hasRefund,
            hasMaturity: hasMaturity
        });

        emit LoanInitialized(token, assetType, targetPrincipal, fundingDeadline, borrower, hasRefund, hasMaturity);
    }

    /**
     * @dev Public getter for loan/bond details.
     *      (Replaces the auto-generated public mapping getter unavailable with ERC-7201.)
     */
    function loanConfigs(address token) external view returns (LoanDetails memory) {
        return _getStorage().loanConfigs[token];
    }

    // =========================================================================
    // State Transitions
    // =========================================================================

    /**
     * @dev Transition from FUNDING to ACTIVE.
     *
     *      Private Credit: enforces totalSupply >= targetPrincipal before activating.
     *      Bond: no supply requirement -- partial issuance is acceptable.
     *
     * @param token  The token address to transition.
     */
    function transitionToActive(address token) external onlyOwner {
        RWALifecycleStorage storage s = _getStorage();
        LoanDetails memory config = s.loanConfigs[token];

        // Private Credit: must have reached its funding target
        if (config.assetType == AssetType.PRIVATE_CREDIT) {
            uint256 currentSupply = IToken(token).totalSupply();
            require(currentSupply >= config.targetPrincipal, 'Target principal not yet reached');
        }
        // Bond with hasRefund=false (no refund possible): any raise amount can go ACTIVE

        _transition(token, LoanState.FUNDING, LoanState.ACTIVE);
    }

    /**
     * @dev Transition from FUNDING to REFUND.
     *      Only callable when hasRefund=true. Enables burn-only mode so investors get refunded.
     *
     * @param token  The token address to transition.
     */
    function transitionToRefund(address token) external onlyOwner {
        require(_getStorage().loanConfigs[token].hasRefund, 'Refund not enabled for this asset');
        _transition(token, LoanState.FUNDING, LoanState.REFUND);
    }

    /**
     * @dev Transition from ACTIVE to MATURED.
     *      Only callable when hasMaturity=true. Freezes P2P; investors burn to redeem.
     *
     * @param token  The token address to transition.
     */
    function transitionToMatured(address token) external onlyOwner {
        require(_getStorage().loanConfigs[token].hasMaturity, 'Maturity not enabled for this asset');
        _transition(token, LoanState.ACTIVE, LoanState.MATURED);
    }

    /**
     * @dev Transition from ACTIVE to DEFAULTED.
     *      Freezes all transfers until governance or restructuring occurs.
     *
     * @param token  The token address to transition.
     */
    function transitionToDefaulted(address token) external onlyOwner {
        _transition(token, LoanState.ACTIVE, LoanState.DEFAULTED);
    }

    /**
     * @dev Internal state transition helper. Validates old state and emits event.
     */
    function _transition(address token, LoanState requiredOldState, LoanState newState) internal {
        RWALifecycleStorage storage s = _getStorage();
        LoanState oldState = s.loanConfigs[token].state;
        require(oldState == requiredOldState, 'Invalid state transition');

        s.loanConfigs[token].state = newState;
        emit StateTransition(token, oldState, newState);
    }

    // =========================================================================
    // ERC-3643 Compliance Hooks
    // =========================================================================

    /**
     * @dev Core transfer gate. Called by ModularCompliance before every token transfer.
     *
     *      Transfer rules by state:
     *        FUNDING  : mint OK | burn OK | P2P BLOCKED  (escrow; no secondary market)
     *        ACTIVE   : mint BLOCKED | burn OK | P2P OK  (unless hasMaturity && past maturityTimestamp)
     *        REFUND   : mint BLOCKED | burn OK | P2P BLOCKED  (hasRefund=true only; burn=refund)
     *        MATURED  : mint BLOCKED | burn OK | P2P BLOCKED  (hasMaturity=true only; burn=redemption)
     *        DEFAULTED: all BLOCKED (frozen until restructuring)
     *
     *      Uninitialized tokens (targetPrincipal == 0) pass through without restriction.
     */
    function moduleCheck(
        address _from,
        address _to,
        uint256 /*_value*/,
        address _compliance
    ) external view override returns (bool) {
        address token = IModularCompliance(_compliance).getTokenBound();
        LoanDetails memory config = _getStorage().loanConfigs[token];

        // Not initialized -- do not interfere with other compliance modules
        if (config.targetPrincipal == 0) return true;

        bool isMint = (_from == address(0));
        bool isBurn = (_to == address(0));
        bool isP2P = (!isMint && !isBurn);

        if (config.state == LoanState.FUNDING) {
            // Escrow: minting to raise capital + burning for early exits; no P2P trading
            if (isP2P) return false;

        } else if (config.state == LoanState.ACTIVE) {
            // Live: P2P trading enabled; minting permanently closed
            if (isMint) return false;
            // Auto-freeze P2P only if maturity feature is ON and timestamp has passed
            if (isP2P && config.hasMaturity && block.timestamp >= config.maturityTimestamp) {
                return false;
            }

        } else if (config.state == LoanState.REFUND) {
            // Funding failed: burn-only so investors can reclaim USDC through vault
            if (isMint || isP2P) return false;

        } else if (config.state == LoanState.MATURED) {
            // Matured: secondary market frozen; investors burn tokens to claim principal
            if (isMint || isP2P) return false;

        } else if (config.state == LoanState.DEFAULTED) {
            // Defaulted: all movement blocked -- governance must restructure first
            return false;
        }

        return true;
    }

    /**
     * @dev Called by compliance on every mint. Enforces funding phase + deadline + cap.
     *      Skips enforcement for uninitialized tokens.
     */
    function moduleMintAction(address /*_to*/, uint256 /*_value*/) external view override onlyComplianceCall {
        address token = IModularCompliance(msg.sender).getTokenBound();
        LoanDetails memory config = _getStorage().loanConfigs[token];

        if (config.targetPrincipal != 0) {
            require(config.state == LoanState.FUNDING, 'Minting only allowed in FUNDING state');
            require(block.timestamp <= config.fundingDeadline, 'Funding deadline has passed');

            uint256 currentSupply = IToken(token).totalSupply();
            require(currentSupply <= config.targetPrincipal, 'Mint would exceed target principal cap');
        }
    }

    /**
     * @dev Called by compliance on every P2P transfer. No additional action needed.
     */
    // solhint-disable-next-line no-empty-blocks
    function moduleTransferAction(address, address, uint256) external override onlyComplianceCall {}

    /**
     * @dev Called by compliance on every burn. No additional action needed.
     */
    // solhint-disable-next-line no-empty-blocks
    function moduleBurnAction(address, uint256) external override onlyComplianceCall {}

    // =========================================================================
    // Module Metadata
    // =========================================================================

    function name() external pure override returns (string memory) {
        return 'RWALifecycleModule';
    }

    /**
     * @dev This module IS plug-and-play: it can be added to any compliance without pre-configuration.
     *      The `initializeLoan` call that follows is what activates enforcement.
     */
    function isPlugAndPlay() external pure override returns (bool) {
        return true;
    }

    /**
     * @dev Any compliance contract can bind this module.
     */
    function canComplianceBind(address) external pure override returns (bool) {
        return true;
    }
}
