// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "../../../token/IToken.sol";
import "../IModularCompliance.sol";
import "./AbstractModule.sol";

/**
 * @title PhysicalReserveModule
 * @dev Blocks minting beyond what a custodian has actually attested to holding.
 * Generalized for any vaulted physical asset - gold (grams), silver (grams), art or
 * collectibles (item count) - rather than hardcoded to one metal, so it is reused
 * verbatim across every physical-asset class registered via AssetFactory, never
 * rewritten per asset class.
 *
 * ONE deployment serves every asset of every physical-asset type: state is keyed by
 * the ModularCompliance address bound to that specific asset (the same convention
 * stock T-REX modules such as CountryAllowModule already use), so a single instance
 * tracks each asset's reserve independently.
 *
 * `RESERVE_MANAGER_ROLE` is expected to be held by a narrowly-scoped backend key tied
 * to the custodian integration / vault-audit process - not a general operations key -
 * since a false attestation here would let the platform mint unbacked tokens.
 */
contract PhysicalReserveModule is AbstractModule, AccessControl {
    bytes32 public constant RESERVE_MANAGER_ROLE = keccak256("RESERVE_MANAGER_ROLE");

    mapping(address => uint256) public allocatedUnits; // keyed by ModularCompliance address
    mapping(address => string) public unitLabel;        // "grams", "ounces", "items"...

    event ReserveAttested(address indexed compliance, uint256 units, string unitLabel, string evidenceRef);

    constructor(address admin) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(RESERVE_MANAGER_ROLE, admin);
    }

    /// @dev Called after a custodian confirms a deposit, withdrawal, or physical audit
    /// result. `evidenceRef` should point at the off-chain attestation document (hash,
    /// audit report ID) for the audit trail - this event is the on-chain half of it.
    function attestAllocation(address compliance, uint256 units, string calldata _unitLabel, string calldata evidenceRef)
        external
        onlyRole(RESERVE_MANAGER_ROLE)
    {
        allocatedUnits[compliance] = units;
        unitLabel[compliance] = _unitLabel;
        emit ReserveAttested(compliance, units, _unitLabel, evidenceRef);
    }

    /// @dev Only gates minting (_from == address(0)); ordinary transfers and
    /// redemption burns are unaffected since they cannot increase total backed supply.
    function moduleCheck(address _from, address, uint256 _value, address _compliance) external view override returns (bool) {
        if (_from != address(0)) {
            return true;
        }
        address token = IModularCompliance(_compliance).getTokenBound();
        return IToken(token).totalSupply() + _value <= allocatedUnits[_compliance];
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
}
