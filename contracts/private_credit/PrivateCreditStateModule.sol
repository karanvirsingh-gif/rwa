// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import "../compliance/modular/modules/AbstractModule.sol";
import "../compliance/modular/IModularCompliance.sol";
import "../token/IToken.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title PrivateCreditStateModule
 * @dev Enforces the lifecycle of a Private Credit loan mapped onto an ERC-3643 token.
 * This completely isolates the credit logic from the generic AssetVault/Treasury.
 */
contract PrivateCreditStateModule is AbstractModule, Ownable {
    enum LoanState { FUNDING, ACTIVE, MATURED, DEFAULTED, REFUND }

    struct LoanDetails {
        uint256 targetPrincipal; // Max amount of tokens that can be minted
        uint256 fundingDeadline; // Timestamp
        uint256 maturityTimestamp; // Timestamp when loan is due
        uint256 paymentFrequency; // Frequency of coupon payments in seconds
        uint256 couponRateBps;   // Interest rate (informative for on-chain)
        bytes32 agreementHash;   // SHA-256 hash of the off-chain Master Loan Agreement
        address borrower;        // Wallet address of the borrower
        LoanState state;         // Current lifecycle state
    }

    mapping(address => LoanDetails) public loanConfigs; // Token Address -> Details

    event LoanInitialized(address indexed token, uint256 target, uint256 deadline, address borrower);
    event StateTransition(address indexed token, LoanState oldState, LoanState newState);

    /**
     * @dev Initialize the loan parameters for a specific token.
     * Can only be called by the module owner (which would be the Platform Admin).
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
        require(loanConfigs[token].targetPrincipal == 0, "Loan already initialized");
        
        loanConfigs[token] = LoanDetails({
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
        LoanState oldState = loanConfigs[token].state;
        require(oldState == requiredOldState, "Invalid state transition");
        
        loanConfigs[token].state = newState;
        emit StateTransition(token, oldState, newState);
    }

    // =========================================================================
    // ERC-3643 Hooks
    // =========================================================================

    function moduleCheck(
        address _from,
        address _to,
        uint256 /*_value*/,
        address _compliance
    ) external view override returns (bool) {
        address token = IModularCompliance(_compliance).getTokenBound();
        LoanDetails memory config = loanConfigs[token];

        // 0. If not initialized, assume true (so we don't break non-loan tokens if mistakenly bound)
        if (config.targetPrincipal == 0) return true;

        bool isMint = (_from == address(0));
        bool isBurn = (_to == address(0));
        bool isP2P = (!isMint && !isBurn);

        if (config.state == LoanState.FUNDING) {
            // Escrow phase: Can buy (mint) and refund (burn), but no P2P trading.
            if (isP2P) return false;
        } else if (config.state == LoanState.ACTIVE) {
            // Target reached: P2P trading allowed, NO MORE MINTING.
            if (isMint) return false;
            
            // Auto-freeze P2P trading if the maturity date has passed
            if (isP2P && block.timestamp >= config.maturityTimestamp) {
                return false;
            }
        } else if (config.state == LoanState.REFUND) {
            // Funding failed: Only burning (refunds) allowed.
            if (isMint || isP2P) return false;
        } else if (config.state == LoanState.MATURED) {
            // Matured: P2P trading frozen. Investors can only burn to claim principal back.
            if (isMint || isP2P) return false;
        } else if (config.state == LoanState.DEFAULTED) {
            // Defaulted: All transfers strictly frozen until restructuring.
            return false;
        }

        return true;
    }

    function moduleMintAction(address /*_to*/, uint256 _value) external override onlyComplianceCall {
        address token = IModularCompliance(msg.sender).getTokenBound();
        LoanDetails memory config = loanConfigs[token];

        if (config.targetPrincipal != 0) {
            require(config.state == LoanState.FUNDING, "Not in funding phase");
            require(block.timestamp <= config.fundingDeadline, "Funding deadline passed");
            
            uint256 currentSupply = IToken(token).totalSupply();
            require(currentSupply <= config.targetPrincipal, "Exceeds target principal");
        }
    }

    function moduleTransferAction(address, address, uint256) external override onlyComplianceCall {}
    function moduleBurnAction(address, uint256) external override onlyComplianceCall {}

    // =========================================================================
    // Module Metadata
    // =========================================================================

    function name() external pure override returns (string memory) {
        return "PrivateCreditStateModule";
    }

    function isPlugAndPlay() external pure override returns (bool) {
        return true;
    }

    function canComplianceBind(address) external pure override returns (bool) {
        return true;
    }
}
