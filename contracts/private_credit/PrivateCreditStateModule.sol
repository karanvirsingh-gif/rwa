// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import '../compliance/modular/modules/AbstractModuleUpgradeable.sol';
import '../compliance/modular/IModularCompliance.sol';
import '../token/IToken.sol';

/**
 * @title PrivateCreditStateModule
 * @dev Enforces the lifecycle of a Private Credit loan mapped onto an ERC-3643 token.
 *      This completely isolates the credit logic from the generic AssetVault/Treasury.
 *
 *      Upgradeability: Follows the T-REX UUPS pattern (AbstractModuleUpgradeable).
 *      Deploy via ModuleProxy(address(impl), abi.encodeCall(initialize, ())).
 *      The proxy address is permanent; only the implementation logic can be upgraded.
 */
contract PrivateCreditStateModule is AbstractModuleUpgradeable {
    enum LoanState {
        FUNDING,
        ACTIVE,
        MATURED,
        DEFAULTED,
        REFUND
    }

    struct LoanDetails {
        uint256 targetPrincipal; // Max amount of tokens that can be minted
        uint256 fundingDeadline; // Timestamp
        uint256 maturityTimestamp; // Timestamp when loan is due
        uint256 paymentFrequency; // Frequency of coupon payments in seconds
        uint256 couponRateBps; // Interest rate in basis points (informative on-chain)
        bytes32 agreementHash; // SHA-256 hash of the off-chain Master Loan Agreement
        address borrower; // Wallet address of the borrower
        LoanState state; // Current lifecycle state
    }

    // =========================================================================
    // ERC-7201 Namespaced Storage
    // =========================================================================

    struct PrivateCreditStorage {
        /// @dev token address => loan details
        mapping(address => LoanDetails) loanConfigs;
    }

    // keccak256(abi.encode(uint256(keccak256("PrivateCredit.storage.PrivateCreditStateModule")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant _PRIVATE_CREDIT_STORAGE_LOCATION = 0x3e5f84c8c1f6dfb80a9c6e41bcd2e4e92eb3df3bd3f7f3a1a6e3b0ee3e1c4a00;

    function _getStorage() private pure returns (PrivateCreditStorage storage s) {
        // solhint-disable-next-line no-inline-assembly
        assembly {
            s.slot := _PRIVATE_CREDIT_STORAGE_LOCATION
        }
    }

    // =========================================================================
    // Events
    // =========================================================================

    event LoanInitialized(address indexed token, uint256 target, uint256 deadline, address borrower);
    event StateTransition(address indexed token, LoanState oldState, LoanState newState);

    // =========================================================================
    // Initializer (replaces constructor — called once via ModuleProxy)
    // =========================================================================

    /**
     * @dev Initializes the upgradeable contract. Must be called exactly once,
     *      via the ModuleProxy constructor (or initializer call).
     *      The caller becomes the owner (platform admin).
     */
    function initialize() external initializer {
        __AbstractModule_init();
    }

    // =========================================================================
    // Loan Configuration
    // =========================================================================

    /**
     * @dev Initialize the loan parameters for a specific token.
     *      Can only be called by the module owner (Platform Admin).
     */
    function initializeLoan(
        address token,
        uint256 targetPrincipal,
        uint256 fundingDeadline,
        uint256 maturityTimestamp,
        uint256 paymentFrequency,
        uint256 couponRateBps,
        bytes32 agreementHash,
        address borrower
    ) external onlyOwner {
        PrivateCreditStorage storage s = _getStorage();
        require(s.loanConfigs[token].targetPrincipal == 0, 'Loan already initialized');

        s.loanConfigs[token] = LoanDetails({
            targetPrincipal: targetPrincipal,
            fundingDeadline: fundingDeadline,
            maturityTimestamp: maturityTimestamp,
            paymentFrequency: paymentFrequency,
            couponRateBps: couponRateBps,
            agreementHash: agreementHash,
            borrower: borrower,
            state: LoanState.FUNDING
        });

        emit LoanInitialized(token, targetPrincipal, fundingDeadline, borrower);
    }

    /**
     * @dev Public getter for loan details (replaces the auto-generated public mapping getter).
     */
    function loanConfigs(address token) external view returns (LoanDetails memory) {
        return _getStorage().loanConfigs[token];
    }

    // =========================================================================
    // State Transitions
    // =========================================================================

    function transitionToActive(address token) external onlyOwner {
        _transition(token, LoanState.FUNDING, LoanState.ACTIVE);
    }

    function transitionToRefund(address token) external onlyOwner {
        _transition(token, LoanState.FUNDING, LoanState.REFUND);
    }

    function transitionToMatured(address token) external onlyOwner {
        _transition(token, LoanState.ACTIVE, LoanState.MATURED);
    }

    function transitionToDefaulted(address token) external onlyOwner {
        _transition(token, LoanState.ACTIVE, LoanState.DEFAULTED);
    }

    function _transition(address token, LoanState requiredOldState, LoanState newState) internal {
        PrivateCreditStorage storage s = _getStorage();
        LoanState oldState = s.loanConfigs[token].state;
        require(oldState == requiredOldState, 'Invalid state transition');

        s.loanConfigs[token].state = newState;
        emit StateTransition(token, oldState, newState);
    }

    // =========================================================================
    // ERC-3643 Compliance Hooks
    // =========================================================================

    function moduleCheck(address _from, address _to, uint256 /*_value*/, address _compliance) external view override returns (bool) {
        address token = IModularCompliance(_compliance).getTokenBound();
        LoanDetails memory config = _getStorage().loanConfigs[token];

        // If not initialized, allow (prevents breaking non-loan tokens bound by mistake)
        if (config.targetPrincipal == 0) return true;

        bool isMint = (_from == address(0));
        bool isBurn = (_to == address(0));
        bool isP2P = (!isMint && !isBurn);

        if (config.state == LoanState.FUNDING) {
            // Escrow phase: minting and burning allowed, no P2P trading
            if (isP2P) return false;
        } else if (config.state == LoanState.ACTIVE) {
            // Target reached: P2P trading allowed, NO MORE MINTING
            if (isMint) return false;
            // Auto-freeze P2P if maturity date has passed
            if (isP2P && block.timestamp >= config.maturityTimestamp) return false;
        } else if (config.state == LoanState.REFUND) {
            // Funding failed: only burning (refunds) allowed
            if (isMint || isP2P) return false;
        } else if (config.state == LoanState.MATURED) {
            // Matured: P2P frozen, investors can only burn to claim principal back
            if (isMint || isP2P) return false;
        } else if (config.state == LoanState.DEFAULTED) {
            // Defaulted: all transfers strictly frozen until restructuring
            return false;
        }

        return true;
    }

    function moduleMintAction(address /*_to*/, uint256 /*_value*/) external view override onlyComplianceCall {
        address token = IModularCompliance(msg.sender).getTokenBound();
        LoanDetails memory config = _getStorage().loanConfigs[token];

        if (config.targetPrincipal != 0) {
            require(config.state == LoanState.FUNDING, 'Not in funding phase');
            require(block.timestamp <= config.fundingDeadline, 'Funding deadline passed');

            uint256 currentSupply = IToken(token).totalSupply();
            require(currentSupply <= config.targetPrincipal, 'Exceeds target principal');
        }
    }

    function moduleTransferAction(address, address, uint256) external override onlyComplianceCall {}

    function moduleBurnAction(address, uint256) external override onlyComplianceCall {}

    // =========================================================================
    // Module Metadata
    // =========================================================================

    function name() external pure override returns (string memory) {
        return 'PrivateCreditStateModule';
    }

    function isPlugAndPlay() external pure override returns (bool) {
        return true;
    }

    function canComplianceBind(address) external pure override returns (bool) {
        return true;
    }
}
