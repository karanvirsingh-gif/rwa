// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import "./ITREXFactory.sol";
import "../token/Token.sol";
import "../compliance/modular/IModularCompliance.sol";
import "../compliance/modular/modules/SupplyLimitModule.sol";
import "../assets/AssetTreasury.sol";
import "../assets/AssetVault.sol";
import "../assets/YieldDistributor.sol";
import "../assets/AssetRegistry.sol";

/**
 * @title AssetFactory
 * @dev Single, platform-wide orchestrator for onboarding ANY asset class. Replaces
 * RealEstateVaultFactory.sol and gold/GoldVaultFactory.sol, and the copy-pasted
 * deploy-*-flow.ts scripts they required.
 *
 * Two distinct operations, two distinct cardinalities:
 *  - registerAssetType(): called ONCE per asset CLASS ("GOLD", "BOND", "SILVER"...).
 *    Registers which compliance modules every asset of that class must carry.
 *  - createAsset(): called ONCE PER INDIVIDUAL ASSET. Deploys a fresh T-REX suite,
 *    a fresh AssetTreasury/AssetVault/YieldDistributor instance (proxies against the
 *    shared implementations below - cheap, isolated state, same logic), binds the
 *    type's compliance modules, and hands control over to the real admin.
 *
 * This contract is itself deployed once, ever, for the whole platform (or once per
 * tenant in white-label mode) - it holds no per-asset state that needs isolating.
 */
contract AssetFactory is Initializable, UUPSUpgradeable, AccessControlUpgradeable {
    bytes32 public constant GOVERNANCE_ROLE = keccak256("GOVERNANCE_ROLE");             // Safe - registers asset CLASSES
    bytes32 public constant ASSET_ORIGINATOR_ROLE = keccak256("ASSET_ORIGINATOR_ROLE"); // backend - onboards individual assets
    bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");

    struct AssetTypeConfig {
        address[] complianceModules;
        bool registered;
    }

    /// @dev Bundled to keep createAsset() below the EVM's stack-depth limit - ten
    /// loose scalar parameters plus the TokenDetails/ClaimDetails structs would
    /// otherwise overflow it.
    struct AssetCreationParams {
        string salt;
        bytes32 assetType;
        address paymentToken;
        AssetVault.PaymentMode mode;
        uint256 price;
        address charityWallet;
        address admin;
        string metadataURI;
        /// @dev Required. The maximum number of tokens that can ever be minted for
        /// this asset. Enforced on-chain by SupplyLimitModule; reverts if 0.
        uint256 supplyLimit;
    }

    ITREXFactory public trexFactory;
    AssetRegistry public registry;
    address public vaultImplementation;
    address public treasuryImplementation;
    address public distributorImplementation;

    mapping(bytes32 => AssetTypeConfig) public assetTypes;
    mapping(bytes32 => bool) public assetIdUsed;

    /// @dev Slot 7. The single, platform-wide SupplyLimitModule instance.
    /// Every asset created by this factory has its supply cap set here atomically
    /// during createAsset(), before ownership is handed to the admin.
    /// Appended AFTER all V1 storage - never insert above this line.
    address public supplyLimitModule;

    event AssetTypeRegistered(bytes32 indexed assetType, address[] complianceModules);
    event AssetCreated(bytes32 indexed assetId, bytes32 indexed assetType, address token, address vault, address treasury, address distributor);
    event ImplementationsUpdated(address vaultImpl, address treasuryImpl, address distributorImpl);
    event SupplyLimitModuleSet(address indexed supplyLimitModule);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        address _trexFactory,
        address _registry,
        address _vaultImplementation,
        address _treasuryImplementation,
        address _distributorImplementation,
        address admin
    ) public initializer {
        __AccessControl_init();
        __UUPSUpgradeable_init();

        trexFactory = ITREXFactory(_trexFactory);
        registry = AssetRegistry(_registry);
        vaultImplementation = _vaultImplementation;
        treasuryImplementation = _treasuryImplementation;
        distributorImplementation = _distributorImplementation;

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(GOVERNANCE_ROLE, admin);
        _grantRole(ASSET_ORIGINATOR_ROLE, admin);
        _grantRole(UPGRADER_ROLE, admin);
    }

    /// @dev Called once via upgradeToAndCall() when upgrading the live proxy to V2.
    /// Sets the platform-wide SupplyLimitModule address that was already deployed.
    /// Uses reinitializer(2) so it can never be called again after this upgrade.
    function initializeV2(address _supplyLimitModule) public reinitializer(2) {
        require(_supplyLimitModule != address(0), "supply limit module required");
        supplyLimitModule = _supplyLimitModule;
        emit SupplyLimitModuleSet(_supplyLimitModule);
    }

    // =========================================================================
    // Asset CLASS registration - once per type, ever
    // =========================================================================

    /// @dev e.g. registerAssetType("GOLD", [allocatedBarBindingModule, t0SettlementModule, shariaApprovalModule])
    /// Modules passed here are shared across every asset of this type - they hold no
    /// per-asset balance, only category-wide rules, so reuse is safe.
    function registerAssetType(bytes32 assetType, address[] calldata complianceModules) external onlyRole(GOVERNANCE_ROLE) {
        assetTypes[assetType] = AssetTypeConfig(complianceModules, true);
        emit AssetTypeRegistered(assetType, complianceModules);
    }

    // =========================================================================
    // Individual asset onboarding - once per asset, regardless of type
    // =========================================================================

    /// @dev Bundled into a single memory value (one stack slot, however many fields)
    /// instead of four separate local address variables - the other half of the
    /// stack-depth fix alongside AssetCreationParams above.
    struct DeployedAsset {
        bytes32 assetId;
        address token;
        address vault;
        address treasury;
        address distributor;
    }

    function createAsset(
        AssetCreationParams calldata params,
        ITREXFactory.TokenDetails calldata tokenDetails,
        ITREXFactory.ClaimDetails calldata claimDetails
    ) external onlyRole(ASSET_ORIGINATOR_ROLE) returns (bytes32, address, address, address, address) {
        require(params.supplyLimit > 0, "supply limit must be greater than zero");
        require(supplyLimitModule != address(0), "upgrade to V2 first: call initializeV2");
        AssetTypeConfig memory cfg = assetTypes[params.assetType];
        require(cfg.registered, "unknown asset type - call registerAssetType first");

        DeployedAsset memory a;
        a.assetId = keccak256(abi.encodePacked(params.salt));
        require(!assetIdUsed[a.assetId], "asset already created for this salt");
        assetIdUsed[a.assetId] = true;

        a.token = _deployToken(params.salt, tokenDetails, claimDetails);
        a.treasury = _deployTreasury(a.assetId, params);
        a.vault = _deployVault(a.assetId, a.token, a.treasury, params);
        a.distributor = _deployDistributor(a.assetId, a.token, params);

        _wire(a.token, a.treasury, a.vault, a.distributor, cfg.complianceModules, params.supplyLimit);
        _handOver(a.token, a.treasury, a.vault, a.distributor, params.admin);

        registry.register(a.assetId, params.assetType, a.token, a.vault, a.treasury, a.distributor, params.metadataURI);

        emit AssetCreated(a.assetId, params.assetType, a.token, a.vault, a.treasury, a.distributor);
        return (a.assetId, a.token, a.vault, a.treasury, a.distributor);
    }

    function _deployToken(
        string calldata salt,
        ITREXFactory.TokenDetails calldata tokenDetails,
        ITREXFactory.ClaimDetails calldata claimDetails
    ) internal returns (address token) {
        // owner is forced to this factory so it can wire agents/modules below,
        // then handed over to the real admin in _handOver()
        ITREXFactory.TokenDetails memory td = tokenDetails;
        td.owner = address(this);

        trexFactory.deployTREXSuite(salt, td, claimDetails);
        token = trexFactory.getToken(salt);
    }

    function _deployTreasury(bytes32 assetId, AssetCreationParams calldata params) internal returns (address treasury) {
        bytes memory initData = abi.encodeWithSelector(AssetTreasury.initialize.selector, assetId, params.paymentToken, address(this));
        treasury = address(new ERC1967Proxy(treasuryImplementation, initData));
    }

    function _deployVault(bytes32 assetId, address token, address treasury, AssetCreationParams calldata params)
        internal
        returns (address vault)
    {
        bytes memory initData = abi.encodeWithSelector(
            AssetVault.initialize.selector, assetId, params.assetType, token, params.paymentToken, treasury, params.mode, params.price, address(this)
        );
        vault = address(new ERC1967Proxy(vaultImplementation, initData));
    }

    function _deployDistributor(bytes32 assetId, address token, AssetCreationParams calldata params) internal returns (address distributor) {
        bytes memory initData = abi.encodeWithSelector(
            YieldDistributor.initialize.selector, assetId, token, params.paymentToken, params.charityWallet, address(this)
        );
        distributor = address(new ERC1967Proxy(distributorImplementation, initData));
    }

    /// @dev Grants the Vault mint/burn rights on the token, binds the yield
    /// distributor, the platform-wide SupplyLimitModule (mandatory for every asset),
    /// and the asset type's compliance modules. Configures the supply cap atomically
    /// before handing ownership to the admin - there is no window where the token
    /// exists with an uncapped supply.
    function _wire(
        address token,
        address treasury,
        address vault,
        address distributor,
        address[] memory typeModules,
        uint256 supplyLimit
    ) internal {
        Token(token).addAgent(vault);

        AssetTreasury(treasury).grantRole(AssetTreasury(treasury).VAULT_ROLE(), vault);

        IModularCompliance compliance = IModularCompliance(address(Token(token).compliance()));
        compliance.addModule(distributor);

        // ── Supply cap (mandatory, platform-level) ────────────────────────────
        // addModule first, then configure via callModuleFunction because
        // setSupplyLimit() is guarded by onlyComplianceCall (msg.sender == compliance).
        compliance.addModule(supplyLimitModule);
        compliance.callModuleFunction(
            abi.encodeWithSelector(SupplyLimitModule.setSupplyLimit.selector, supplyLimit),
            supplyLimitModule
        );

        // ── Asset-type-specific behavioral modules ────────────────────────────
        for (uint256 i = 0; i < typeModules.length; i++) {
            compliance.addModule(typeModules[i]);
        }
    }

    /// @dev This factory holds every role on every contract it just deployed
    /// (granted to `address(this)` at each initialize() call) so it can wire them
    /// together. Once wiring is done, EVERY role - not just DEFAULT_ADMIN_ROLE -
    /// moves to `admin` (a Safe multisig in production), and the factory renounces
    /// its own copy of each one last, after all grants succeed. It never retains a
    /// standing privilege on any asset once this returns.
    function _handOver(address token, address treasury, address vault, address distributor, address admin) internal {
        OwnableUpgradeable(token).transferOwnership(admin);
        OwnableUpgradeable(address(Token(token).compliance())).transferOwnership(admin);

        AssetTreasury t = AssetTreasury(treasury);
        _moveRole(t, t.WITHDRAWER_ROLE(), admin);
        _moveRole(t, t.DEFAULT_ADMIN_ROLE(), admin); // must be last on this contract

        AssetVault v = AssetVault(vault);
        _moveRole(v, v.SETTLEMENT_ROLE(), admin);
        _moveRole(v, v.PRICE_ORACLE_ROLE(), admin);
        _moveRole(v, v.PAUSER_ROLE(), admin);
        _moveRole(v, v.UPGRADER_ROLE(), admin);
        _moveRole(v, v.DEFAULT_ADMIN_ROLE(), admin); // must be last on this contract

        YieldDistributor d = YieldDistributor(distributor);
        _moveRole(d, d.TREASURY_ROLE(), admin);
        _moveRole(d, d.UPGRADER_ROLE(), admin);
        _moveRole(d, d.DEFAULT_ADMIN_ROLE(), admin); // must be last on this contract
    }

    function _moveRole(AccessControlUpgradeable target, bytes32 role, address admin) internal {
        target.grantRole(role, admin);
        target.renounceRole(role, address(this));
    }

    // =========================================================================
    // Admin
    // =========================================================================

    function setImplementations(address _vaultImpl, address _treasuryImpl, address _distributorImpl) external onlyRole(GOVERNANCE_ROLE) {
        vaultImplementation = _vaultImpl;
        treasuryImplementation = _treasuryImpl;
        distributorImplementation = _distributorImpl;
        emit ImplementationsUpdated(_vaultImpl, _treasuryImpl, _distributorImpl);
    }

    /// @dev Allows governance to point the factory at a new SupplyLimitModule
    /// implementation after an upgrade. Existing assets are unaffected (their
    /// compliance contracts already hold the old module address).
    function setSupplyLimitModule(address _supplyLimitModule) external onlyRole(GOVERNANCE_ROLE) {
        require(_supplyLimitModule != address(0), "zero address");
        supplyLimitModule = _supplyLimitModule;
        emit SupplyLimitModuleSet(_supplyLimitModule);
    }

    function _authorizeUpgrade(address) internal override onlyRole(UPGRADER_ROLE) {}
}
