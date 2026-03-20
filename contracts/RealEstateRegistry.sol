// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import "@openzeppelin/contracts-upgradeable/token/ERC721/extensions/ERC721URIStorageUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts/utils/Counters.sol";

/**
 * @title RealEstateRegistry
 * @dev Upgradable Registry for Property NFTs and their associated T-REX Assets.
 */
contract RealEstateRegistry is 
    Initializable,
    ERC721URIStorageUpgradeable, 
    AccessControlUpgradeable,
    UUPSUpgradeable 
{
    using Counters for Counters.Counter;
    Counters.Counter private _tokenIds;

    bytes32 public constant REGISTER_ROLE = keccak256("REGISTER_ROLE");
    bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");

    // Mapping from NFT ID to T-REX Token Address
    mapping(uint256 => address) public propertyTokens;
    // Mapping from NFT ID to Vault Address
    mapping(uint256 => address) public propertyVaults;

    event PropertyRegistered(uint256 indexed tokenId, address indexed tokenAddress, address indexed vaultAddress, string uri);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address admin) public initializer {
        __ERC721_init("RealEstateRegistry", "RER");
        __ERC721URIStorage_init();
        __AccessControl_init();
        __UUPSUpgradeable_init();

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(REGISTER_ROLE, admin);
        _grantRole(UPGRADER_ROLE, admin);
    }

    /**
     * @dev Register a new property and link its T-REX token and Vault.
     */
    function registerProperty(
        address to, 
        string memory uri, 
        address tokenAddress, 
        address vaultAddress
    ) public onlyRole(REGISTER_ROLE) returns (uint256) {
        _tokenIds.increment();

        uint256 newItemId = _tokenIds.current();
        _mint(to, newItemId);
        _setTokenURI(newItemId, uri);
        
        propertyTokens[newItemId] = tokenAddress;
        propertyVaults[newItemId] = vaultAddress;

        emit PropertyRegistered(newItemId, tokenAddress, vaultAddress, uri);

        return newItemId;
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyRole(UPGRADER_ROLE) {}

    // Support for ERC165
    function supportsInterface(bytes4 interfaceId) public view override(ERC721URIStorageUpgradeable, AccessControlUpgradeable) returns (bool) {
        return super.supportsInterface(interfaceId);
    }
}
