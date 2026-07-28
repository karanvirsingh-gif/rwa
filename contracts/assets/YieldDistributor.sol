// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "../token/IToken.sol";
import "../compliance/modular/modules/AbstractModule.sol";

/**
 * @title YieldDistributor
 * @dev Recurring payouts to current holders - rental income, gold lease income, bond
 * coupons are all the same primitive to this contract. Extracted out of the Vault so
 * that primary settlement (mint/burn) and ongoing distribution are separate lifecycles
 * with separate backend operator roles. One instance per asset - dividend accounting
 * is intrinsically scoped to one token's total supply and cannot be pooled.
 *
 * Uses the magnified-dividend / cumulative-index pattern: `magnifiedDividendPerShare`
 * only ever increases, and `magnifiedDividendCorrections` is adjusted on every mint,
 * burn, and transfer so a balance change can never retroactively claim a distribution
 * that happened before it existed, nor lose an entitlement that already accrued.
 * Because this is bound as a compliance module, those hooks fire on every balance
 * change regardless of which contract caused it - Vault mint, Vault redeem burn, or a
 * P2PMarketplace secondary trade - so accounting stays correct everywhere.
 */
contract YieldDistributor is
    Initializable,
    UUPSUpgradeable,
    AccessControlUpgradeable,
    ReentrancyGuardUpgradeable,
    AbstractModule
{
    bytes32 public constant TREASURY_ROLE = keccak256("TREASURY_ROLE"); // backend Distribution Engine
    bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");

    uint256 internal constant MAGNITUDE = 2 ** 128;
    uint256 internal constant BPS_DENOMINATOR = 10_000;

    bytes32 public assetId;
    IToken public token;
    IERC20 public paymentToken;
    address public charityWallet; // Sharia purification routing target, optional

    uint256 public magnifiedDividendPerShare;
    mapping(address => int256) public magnifiedDividendCorrections;
    mapping(address => uint256) public withdrawnDividends;
    uint256 public totalDistributed;
    uint256 public totalPurified;

    event DistributionDeposited(address indexed depositor, uint256 grossAmount, uint256 purifiedAmount, string sourceRef);
    event YieldClaimed(address indexed investor, uint256 amount);
    event CharityWalletUpdated(address newWallet);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(bytes32 _assetId, address _token, address _paymentToken, address _charityWallet, address admin)
        public
        initializer
    {
        __AccessControl_init();
        __UUPSUpgradeable_init();
        __ReentrancyGuard_init();

        assetId = _assetId;
        token = IToken(_token);
        paymentToken = IERC20(_paymentToken);
        charityWallet = _charityWallet;

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(TREASURY_ROLE, admin);
        _grantRole(UPGRADER_ROLE, admin);
    }

    // =========================================================================
    // Distribution
    // =========================================================================

    /// @dev BACKEND ONLY - Distribution Engine, after aggregating this cycle's rental
    /// / lease / coupon income confirmed in the bank account or treasury off-chain.
    /// `purificationBps` routes that percentage to the charity wallet before the
    /// pro-rata split, for Sharia assets with purification_required = true.
    function depositDistribution(uint256 amount, uint16 purificationBps, string calldata sourceRef)
        external
        onlyRole(TREASURY_ROLE)
    {
        require(amount > 0, "amount must be greater than 0");
        require(purificationBps <= BPS_DENOMINATOR, "invalid bps");
        uint256 supply = token.totalSupply();
        require(supply > 0, "no holders yet");

        require(paymentToken.transferFrom(msg.sender, address(this), amount), "deposit failed");

        uint256 charityCut = (amount * purificationBps) / BPS_DENOMINATOR;
        uint256 net = amount - charityCut;

        if (charityCut > 0) {
            require(charityWallet != address(0), "charity wallet not set");
            require(paymentToken.transfer(charityWallet, charityCut), "purification transfer failed");
            totalPurified += charityCut;
        }

        totalDistributed += net;
        magnifiedDividendPerShare += (net * MAGNITUDE) / supply;

        emit DistributionDeposited(msg.sender, amount, net, sourceRef);
    }

    /// @dev WALLET-triggered - investor pulls their own share on demand.
    function claimYield() external nonReentrant {
        uint256 owed = withdrawableYieldOf(msg.sender);
        require(owed > 0, "nothing to claim");

        withdrawnDividends[msg.sender] += owed;
        require(paymentToken.transfer(msg.sender, owed), "payout failed");

        emit YieldClaimed(msg.sender, owed);
    }

    function withdrawableYieldOf(address investor) public view returns (uint256) {
        return accumulativeDividendOf(investor) - withdrawnDividends[investor];
    }

    function accumulativeDividendOf(address investor) public view returns (uint256) {
        return uint256(
            int256(magnifiedDividendPerShare * token.balanceOf(investor)) + magnifiedDividendCorrections[investor]
        ) / MAGNITUDE;
    }

    function setCharityWallet(address newWallet) external onlyRole(DEFAULT_ADMIN_ROLE) {
        charityWallet = newWallet;
        emit CharityWalletUpdated(newWallet);
    }

    // =========================================================================
    // Compliance-module hooks - the only reason this contract is bound to the token
    // =========================================================================

    function moduleMintAction(address to, uint256 value) external override onlyComplianceCall {
        magnifiedDividendCorrections[to] -= int256(magnifiedDividendPerShare * value);
    }

    function moduleBurnAction(address from, uint256 value) external override onlyComplianceCall {
        magnifiedDividendCorrections[from] += int256(magnifiedDividendPerShare * value);
    }

    function moduleTransferAction(address from, address to, uint256 value) external override onlyComplianceCall {
        magnifiedDividendCorrections[from] += int256(magnifiedDividendPerShare * value);
        magnifiedDividendCorrections[to] -= int256(magnifiedDividendPerShare * value);
    }

    function moduleCheck(address, address, uint256, address) external pure override returns (bool) {
        return true;
    }

    function canComplianceBind(address) external pure override returns (bool) {
        return true;
    }

    function isPlugAndPlay() external pure override returns (bool) {
        return true;
    }

    function name() external pure override returns (string memory) {
        return "YieldDistributor";
    }

    function _authorizeUpgrade(address) internal override onlyRole(UPGRADER_ROLE) {}
}
