// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import "../RealEstateVault.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

/**
 * @title RealEstateVaultFactory
 * @dev Deploys RealEstateVault proxies for each Property Token.
 */
contract RealEstateVaultFactory is 
    Initializable,
    UUPSUpgradeable,
    AccessControlUpgradeable 
{
    bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");
    bytes32 public constant DEPLOYER_ROLE = keccak256("DEPLOYER_ROLE");

    address public vaultImplementation;
    mapping(address => address) public vaults;
    
    event VaultDeployed(address indexed token, address indexed proxy, address indexed implementation, uint256 price);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address _vaultImplementation, address admin) public initializer {
        __AccessControl_init();
        __UUPSUpgradeable_init();

        vaultImplementation = _vaultImplementation;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(DEPLOYER_ROLE, admin);
        _grantRole(UPGRADER_ROLE, admin);
    }

    /**
     * @dev Deploy a new RealEstateVault PROXY for a given token.
     */
    function deployVault(
        address token, 
        address paymentToken, 
        uint256 price,
        address vaultAdmin
    ) external onlyRole(DEPLOYER_ROLE) returns (address) {
        require(token != address(0), "Invalid token");
        require(vaults[token] == address(0), "Vault exists");

        // Prepare initialization data
        bytes memory initData = abi.encodeWithSelector(
            RealEstateVault.initialize.selector,
            token,
            paymentToken,
            price,
            vaultAdmin
        );

        // Deploy Proxy
        ERC1967Proxy proxy = new ERC1967Proxy(vaultImplementation, initData);
        
        address proxyAddress = address(proxy);
        vaults[token] = proxyAddress;

        emit VaultDeployed(token, proxyAddress, vaultImplementation, price);

        return proxyAddress;
    }

    function setVaultImplementation(address _newImplementation) external onlyRole(DEFAULT_ADMIN_ROLE) {
        vaultImplementation = _newImplementation;
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyRole(UPGRADER_ROLE) {}
}
