// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "../../../token/IToken.sol";
import "../IModularCompliance.sol";
import "./AbstractModuleUpgradeable.sol";

/**
 * @title PhysicalReserveModule
 * @dev Blocks minting beyond what a custodian has actually attested to holding.
 * Generalized for any vaulted physical asset - gold (grams), silver (grams), art or
 * collectibles (item count) - rather than hardcoded to one metal, so it is reused
 * verbatim across every physical-asset class registered via AssetFactory.
 *
 * ONE deployment (behind a UUPS proxy) serves every asset of every physical-asset type:
 * state is keyed by the ModularCompliance address bound to that specific asset
 * (the same convention stock T-REX modules such as CountryAllowModule already use).
 *
 * UPGRADEABILITY
 * --------------
 * Follows the industry-standard UUPS pattern used throughout this codebase:
 * - Implementation deployed once; all callers reference the proxy address.
 * - `_authorizeUpgrade` is restricted to DEFAULT_ADMIN_ROLE so only the
 *   platform multisig / admin can push a new implementation.
 * - State is stored in an ERC-7201 namespaced slot to prevent storage collisions
 *   across upgrades.
 *
 * ACCESS CONTROL
 * --------------
 * - DEFAULT_ADMIN_ROLE : granted to `admin` in `initialize()`. Can grant roles
 *                        and authorize upgrades.
 * - RESERVE_MANAGER_ROLE : held by the custodian integration backend. Can call
 *                          `attestAllocation`. Should be a narrowly-scoped key
 *                          since a false attestation would allow minting unbacked tokens.
 *
 * `RESERVE_MANAGER_ROLE` is expected to be held by a narrowly-scoped backend key
 * tied to the custodian integration / vault-audit process - not a general operations
 * key - since a false attestation here would let the platform mint unbacked tokens.
 */
contract PhysicalReserveModule is AbstractModuleUpgradeable, AccessControlUpgradeable {

    bytes32 public constant RESERVE_MANAGER_ROLE = keccak256("RESERVE_MANAGER_ROLE");

    /// @custom:storage-location erc7201:rwa.storage.PhysicalReserveModule
    struct PhysicalReserveModuleStorage {
        mapping(address => uint256) allocatedUnits; // keyed by ModularCompliance address
        mapping(address => string)  unitLabel;       // "grams", "ounces", "items"...
    }

    // keccak256(abi.encode(uint256(keccak256("rwa.storage.PhysicalReserveModule")) - 1)) & ~bytes32(uint256(0xff))
    uint256 private constant _STORAGE_SLOT =
        0x2eae3f92d14e48f9abd95f97bb53b3eece12a9e7d0d0a10f5a1a7f4f4b1df300;

    event ReserveAttested(address indexed compliance, uint256 units, string unitLabel, string evidenceRef);

    // =========================================================================
    // Initializer (replaces constructor for UUPS pattern)
    // =========================================================================

    /**
     * @dev Initializes the module, granting DEFAULT_ADMIN_ROLE and RESERVE_MANAGER_ROLE
     *      to `admin`. Called once through the proxy at deployment time.
     * @param admin Address to receive admin and reserve manager privileges.
     */
    function initialize(address admin) external initializer {
        require(admin != address(0), "admin cannot be zero address");
        __AbstractModule_init();   // OwnableUpgradeable + UUPSUpgradeable
        __AccessControl_init();
        _grantRole(DEFAULT_ADMIN_ROLE,    admin);
        _grantRole(RESERVE_MANAGER_ROLE, admin);
    }

    // =========================================================================
    // Reserve Management
    // =========================================================================

    /**
     * @dev Called after a custodian confirms a deposit, withdrawal, or physical audit
     *      result. `evidenceRef` should point at the off-chain attestation document
     *      (hash or audit report ID) for the audit trail.
     */
    function attestAllocation(
        address compliance,
        uint256 units,
        string calldata _unitLabel,
        string calldata evidenceRef
    ) external onlyRole(RESERVE_MANAGER_ROLE) {
        PhysicalReserveModuleStorage storage s = _getStorage();
        s.allocatedUnits[compliance] = units;
        s.unitLabel[compliance] = _unitLabel;
        emit ReserveAttested(compliance, units, _unitLabel, evidenceRef);
    }

    // =========================================================================
    // Read Helpers
    // =========================================================================

    function allocatedUnits(address compliance) external view returns (uint256) {
        return _getStorage().allocatedUnits[compliance];
    }

    function unitLabel(address compliance) external view returns (string memory) {
        return _getStorage().unitLabel[compliance];
    }

    // =========================================================================
    // T-REX Module Hooks
    // =========================================================================

    /**
     * @dev Only gates minting (_from == address(0)); ordinary transfers and
     *      redemption burns are unaffected since they cannot increase total backed supply.
     */
    function moduleCheck(
        address _from,
        address,
        uint256 _value,
        address _compliance
    ) external view override returns (bool) {
        if (_from != address(0)) {
            return true;
        }
        PhysicalReserveModuleStorage storage s = _getStorage();
        address token = IModularCompliance(_compliance).getTokenBound();
        return IToken(token).totalSupply() + _value <= s.allocatedUnits[_compliance];
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
        return "PhysicalReserveModule";
    }

    // =========================================================================
    // Upgrade Authorization
    // =========================================================================

    /**
     * @dev Override required because both AbstractModuleUpgradeable (onlyOwner) and
     *      UUPSUpgradeable define _authorizeUpgrade. We restrict to DEFAULT_ADMIN_ROLE
     *      which is the correct access-control authority for this contract.
     */
    function _authorizeUpgrade(address newImplementation)
        internal
        override(AbstractModuleUpgradeable)
        onlyRole(DEFAULT_ADMIN_ROLE)
    {}

    // =========================================================================
    // Interface Support
    // =========================================================================

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(AccessControlUpgradeable)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }

    // =========================================================================
    // ERC-7201 Namespaced Storage
    // =========================================================================

    function _getStorage() private pure returns (PhysicalReserveModuleStorage storage s) {
        // solhint-disable-next-line no-inline-assembly
        assembly {
            s.slot := _STORAGE_SLOT
        }
    }
}

