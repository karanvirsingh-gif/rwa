// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import "./AbstractModuleUpgradeable.sol";

/**
 * @title CustodianAttestationModule
 * @dev Enforces real-world physical custody conditions for Collectible assets.
 * 
 * Follows the standard T-REX AbstractModuleUpgradeable pattern:
 * - One singleton deployed behind a ModuleProxy.
 * - Configuration (custodians) is keyed by compliance address.
 * 
 * Transfers: Blocked if attestation is expired (> 90 days) or `isDamaged`.
 * Burns: Always allowed (supports native AssetVault.redeem() during insurance payouts).
 */
contract CustodianAttestationModule is AbstractModuleUpgradeable {
    
    uint256 public constant ATTESTATION_EXPIRY = 90 days;

    struct Attestation {
        uint256 timestamp;
        bool    isDamaged;
        string  evidenceRef;
    }

    // Maps a specific Collectible's Compliance contract address to its current physical condition.
    // Think of it as: Collectible => Attestation
    mapping(address => Attestation) public attestations;

    // Maps a specific Collectible's Compliance contract address to the wallet address of its real-world custodian (e.g., Brink's).
    // Think of it as: Collectible => Custodian Wallet Address
    mapping(address => address) public custodians;

    event CustodianAttested(
        address indexed compliance,
        bool    isDamaged,
        string  evidenceRef,
        uint256 timestamp
    );
    
    event CustodianSet(address indexed compliance, address custodian);

    /// @dev Initializes the contract and sets the initial state.
    function initialize() external initializer {
        __AbstractModule_init();
    }

    // =========================================================================
    // Admin Configuration
    // =========================================================================

    /// @dev Called by the token issuer (via the compliance contract) to set the physical custodian.
    function setCustodian(address custodian) external onlyComplianceCall {
        custodians[msg.sender] = custodian;
        emit CustodianSet(msg.sender, custodian);
    }

    // =========================================================================
    // Role-Restricted Actions
    // =========================================================================

    /// @dev Called by the assigned physical custodian to attest to the item's condition.
    /// If `isDamaged` is true, all non-burn transfers are immediately blocked.
    function attest(address compliance, bool isDamaged, string calldata evidenceRef) external {
        require(msg.sender == custodians[compliance], "caller is not the custodian");

        attestations[compliance] = Attestation({
            timestamp: block.timestamp,
            isDamaged: isDamaged,
            evidenceRef: evidenceRef
        });

        emit CustodianAttested(compliance, isDamaged, evidenceRef, block.timestamp);
    }

    // =========================================================================
    // T-REX Module Hooks
    // =========================================================================

    function moduleCheck(
        address /* _from */,
        address _to,
        uint256 /* _value */,
        address _compliance
    ) external view override returns (bool) {
        
        // ── Burns ─────────────────────────────────────────────────────────
        // Burns (_to == address(0)) are natively allowed. In the contracts/assets 
        // pattern, AssetVault.redeem() naturally fails unless the AssetTreasury 
        // is funded (e.g. via an insurance payout).
        if (_to == address(0)) {
            return true;
        }

        // ── All other transfers ───────────────────────────────────────────
        Attestation memory a = attestations[_compliance];

        // Block: item has never been attested (not yet confirmed in custody)
        if (a.timestamp == 0) return false;

        // Block: attestation expired — custodian hasn't reported in 90 days
        if (block.timestamp > a.timestamp + ATTESTATION_EXPIRY) return false;

        // Block: item is Damaged — protects secondary buyers from worthless assets
        if (a.isDamaged) return false;

        return true;
    }

    function moduleTransferAction(address, address, uint256) external override onlyComplianceCall {}
    function moduleMintAction(address, uint256) external override onlyComplianceCall {}
    function moduleBurnAction(address, uint256) external override onlyComplianceCall {}

    function canComplianceBind(address) external pure override returns (bool) {
        return true;
    }

    function isPlugAndPlay() external pure override returns (bool) {
        return true;
    }

    function name() external pure override returns (string memory) {
        return "CustodianAttestationModule";
    }
}
