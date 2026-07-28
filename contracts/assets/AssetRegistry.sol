// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

/**
 * @title AssetRegistry
 * @dev Plain lookup table: assetId -> {token, vault, treasury, distributor}.
 * Replaces RealEstateRegistry.sol and gold/GoldRegistry.sol, which minted an ERC-721
 * per asset. ERC-3643 is the only tokenization standard this platform issues -
 * introducing an ERC-721 into the asset-identity path is exactly the pattern the
 * platform's own locked decisions rule out, so this registry carries no token
 * semantics at all, just an event-logged mapping. One instance for the whole
 * platform (or one per tenant) - it holds no per-asset custody or settlement state,
 * so there is nothing that needs isolating between assets here.
 */
contract AssetRegistry is Initializable, AccessControlUpgradeable, UUPSUpgradeable {
    bytes32 public constant REGISTER_ROLE = keccak256("REGISTER_ROLE");
    bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");

    struct AssetRecord {
        bytes32 assetType;
        address token;
        address vault;
        address treasury;
        address distributor;
        string metadataURI;
        bool active;
    }

    mapping(bytes32 => AssetRecord) public assets;
    bytes32[] public assetIds;

    event AssetRegistered(
        bytes32 indexed assetId,
        bytes32 indexed assetType,
        address token,
        address vault,
        address treasury,
        address distributor
    );
    event AssetDeactivated(bytes32 indexed assetId);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address admin) public initializer {
        __AccessControl_init();
        __UUPSUpgradeable_init();

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(REGISTER_ROLE, admin);
        _grantRole(UPGRADER_ROLE, admin);
    }

    /// @dev Called by AssetFactory at the end of createAsset(). Not called directly.
    function register(
        bytes32 assetId,
        bytes32 assetType,
        address token,
        address vault,
        address treasury,
        address distributor,
        string calldata metadataURI
    ) external onlyRole(REGISTER_ROLE) {
        require(!assets[assetId].active, "asset already registered");

        assets[assetId] = AssetRecord(assetType, token, vault, treasury, distributor, metadataURI, true);
        assetIds.push(assetId);

        emit AssetRegistered(assetId, assetType, token, vault, treasury, distributor);
    }

    function deactivate(bytes32 assetId) external onlyRole(REGISTER_ROLE) {
        require(assets[assetId].active, "asset not active");
        assets[assetId].active = false;
        emit AssetDeactivated(assetId);
    }

    function totalAssets() external view returns (uint256) {
        return assetIds.length;
    }

    function getAsset(bytes32 assetId) external view returns (AssetRecord memory) {
        return assets[assetId];
    }

    function _authorizeUpgrade(address) internal override onlyRole(UPGRADER_ROLE) {}
}
