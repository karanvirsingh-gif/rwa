// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "../token/IToken.sol";

/**
 * @title P2PMarketplace
 * @dev Peer-to-peer secondary trading - Investor A sells directly to Investor B, with
 * the Vault, minting, and burning completely out of the picture. One instance for the
 * whole platform (or per tenant), not per asset - it is generic, taking the asset
 * token as a listing parameter.
 *
 * No escrow: the seller keeps custody of their tokens (via a standard approve()) until
 * the instant a trade fills. buyListing() moves both legs atomically in one
 * transaction - the token leg runs through IToken.transferFrom, which is the same
 * ERC-3643 Token contract every other transfer goes through, so identity/KYC, zone,
 * cap, and lock-up checks are already enforced at the protocol level with no
 * additional logic needed here. If either party fails compliance, the whole trade
 * reverts.
 */
contract P2PMarketplace is Initializable, UUPSUpgradeable, AccessControlUpgradeable, ReentrancyGuardUpgradeable {
    bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");

    struct Listing {
        address seller;
        address token;
        address paymentToken;
        uint256 amount;       // remaining amount available
        uint256 pricePerUnit; // in paymentToken units, per whole unit of token
        uint256 expiry;
        bool active;
    }

    mapping(bytes32 => Listing) public listings;

    event ListingCreated(
        bytes32 indexed id, address indexed seller, address indexed token, uint256 amount, uint256 pricePerUnit, uint256 expiry
    );
    event ListingFilled(bytes32 indexed id, address indexed buyer, uint256 amount, uint256 cost);
    event ListingCancelled(bytes32 indexed id);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address admin) public initializer {
        __AccessControl_init();
        __UUPSUpgradeable_init();
        __ReentrancyGuard_init();

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(UPGRADER_ROLE, admin);
    }

    /// @dev WALLET-triggered. Seller must approve() this contract for `amount` of
    /// `token` beforehand - tokens stay in the seller's wallet until a trade fills.
    function createListing(address token, address paymentToken, uint256 amount, uint256 pricePerUnit, uint256 expiry, uint256 nonce)
        external
        returns (bytes32 id)
    {
        require(amount > 0, "amount must be greater than 0");
        require(expiry > block.timestamp, "expiry must be in the future");

        id = keccak256(abi.encode(msg.sender, token, nonce));
        require(!listings[id].active, "listing already exists");

        listings[id] = Listing(msg.sender, token, paymentToken, amount, pricePerUnit, expiry, true);
        emit ListingCreated(id, msg.sender, token, amount, pricePerUnit, expiry);
    }

    /// @dev WALLET-triggered, seller only.
    function cancelListing(bytes32 id) external {
        require(listings[id].seller == msg.sender, "not the seller");
        require(listings[id].active, "listing not active");
        listings[id].active = false;
        emit ListingCancelled(id);
    }

    /// @dev WALLET-triggered, buyer. Both legs settle in one transaction or both revert.
    function buyListing(bytes32 id, uint256 amount) external nonReentrant {
        Listing storage l = listings[id];
        require(l.active, "listing not active");
        require(block.timestamp <= l.expiry, "listing expired");
        require(amount > 0 && amount <= l.amount, "invalid amount");

        uint256 cost = (amount * l.pricePerUnit) / (10 ** IToken(l.token).decimals());

        require(IERC20(l.paymentToken).transferFrom(msg.sender, l.seller, cost), "payment failed");
        require(IToken(l.token).transferFrom(l.seller, msg.sender, amount), "token transfer failed");

        l.amount -= amount;
        if (l.amount == 0) {
            l.active = false;
        }

        emit ListingFilled(id, msg.sender, amount, cost);
    }

    function getListing(bytes32 id) external view returns (Listing memory) {
        return listings[id];
    }

    function _authorizeUpgrade(address) internal override onlyRole(UPGRADER_ROLE) {}
}
