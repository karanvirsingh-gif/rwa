// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import "../IModularCompliance.sol";
import "../../../token/IToken.sol";
import "./AbstractModuleUpgradeable.sol";

/**
 * @title MinimumInvestmentModule
 * @dev Enforces a minimum purchase size - the smallest amount an investor may be
 * minted in one go. Only gates minting (_from == address(0)); ordinary transfers and
 * redemption burns are never blocked by it, since this is about the size of a fresh
 * investment, not a floor on every wallet-to-wallet trade.
 *
 * Same shape and settings convention as the stock CountryAllowModule/MaxBalanceModule
 * already in this repo: ONE deployment, reused across every asset that wants this
 * rule, with each asset's own minimum stored keyed by its own ModularCompliance
 * address. Settings are pushed through deployTREXSuite's complianceSettings at
 * asset-creation time (or later via ModularCompliance.callModuleFunction) - never a
 * new contract deployment or a change to AssetVault/AssetFactory.
 */
contract MinimumInvestmentModule is AbstractModuleUpgradeable {
    /// @dev compliance address => minimum purchase size, in the bound token's base units
    mapping(address => uint256) private _minInvestment;

    event MinimumInvestmentSet(address indexed compliance, uint256 minimum);

    /**
     * @notice This function should only be called once during the contract deployment.
     */
    function initialize() external initializer {
        __AbstractModule_init();
    }

    /**
     *  @dev Sets the minimum investment size for the calling compliance contract.
     *  Can be called only for a compliance contract that is bound to this module.
     *  @param _min the minimum purchase size, in the bound token's base units
     */
    function setMinInvestment(uint256 _min) external onlyComplianceCall {
        _minInvestment[msg.sender] = _min;
        emit MinimumInvestmentSet(msg.sender, _min);
    }

    function moduleTransferAction(address, address, uint256) external override onlyComplianceCall {}
    function moduleMintAction(address, uint256) external override onlyComplianceCall {}
    function moduleBurnAction(address, uint256) external override onlyComplianceCall {}

    function moduleCheck(address _from, address, uint256 _value, address _compliance) external view override returns (bool) {
        if (_from != address(0)) {
            return true;
        }
        return _value >= _minInvestment[_compliance];
    }

    function getMinInvestment(address _compliance) external view returns (uint256) {
        return _minInvestment[_compliance];
    }

    function canComplianceBind(address) external pure override returns (bool) {
        return true;
    }

    function isPlugAndPlay() external pure override returns (bool) {
        return true;
    }

    function name() public pure override returns (string memory _name) {
        return "MinimumInvestmentModule";
    }
}
