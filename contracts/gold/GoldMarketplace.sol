// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "../factory/GoldVaultFactory.sol";
import "./GoldVault.sol";
import "../token/IToken.sol";

/**
 * @title GoldMarketplace
 * @dev Upgradable marketplace for buying and selling gold tokens using Stablecoins.
 */
contract GoldMarketplace is 
    Initializable,
    UUPSUpgradeable,
    AccessControlUpgradeable,
    ReentrancyGuardUpgradeable 
{
    bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");
    
    GoldVaultFactory public factory;

    event SharesBought(address indexed buyer, address indexed token, uint256 amount, uint256 cost);
    event SharesSold(address indexed seller, address indexed token, uint256 amount, uint256 payout);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address _factory, address admin) public initializer {
        __AccessControl_init();
        __UUPSUpgradeable_init();
        __ReentrancyGuard_init();

        factory = GoldVaultFactory(_factory);
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(UPGRADER_ROLE, admin);
    }

    /**
     * @dev Buy shares via the Gold Vault using Stablecoins.
     */
    function buyShares(address tokenAddress, uint256 amount) external nonReentrant {
        address vaultAddress = factory.vaults(tokenAddress);
        require(vaultAddress != address(0), "Vault not found");
        
        GoldVault vault = GoldVault(payable(vaultAddress));
        IERC20 paymentToken = vault.paymentToken();
        
        uint256 decimals = IToken(tokenAddress).decimals();
        uint256 totalCost = (amount * vault.pricePerShare()) / (10**decimals);

        // 1. Take payment from user
        require(paymentToken.transferFrom(msg.sender, address(this), totalCost), "Marketplace: Payment failed");

        // 2. Approve Vault to take payment
        paymentToken.approve(address(vault), totalCost);

        // 3. Execute buy in Vault
        vault.buyFor(msg.sender, amount);

        emit SharesBought(msg.sender, tokenAddress, amount, totalCost);
    }
    
    /**
     * @dev Sell shares via the Gold Vault
     */
    function sellShares(address tokenAddress, uint256 amount) external nonReentrant {
        address vaultAddress = factory.vaults(tokenAddress);
        require(vaultAddress != address(0), "Vault not found");
        
        IToken token = IToken(tokenAddress);
        GoldVault vault = GoldVault(payable(vaultAddress));

        // 1. Transfer tokens from User to Marketplace
        require(token.transferFrom(msg.sender, address(this), amount), "Transfer to Marketplace failed");

        // 2. Approve Vault to take tokens
        token.approve(address(vault), amount);

        // 3. Sell back to Vault (Vault sends payment to Marketplace)
        vault.sell(amount);

        // 4. Send payment back to User
        IERC20 paymentToken = vault.paymentToken();
        uint256 payout = paymentToken.balanceOf(address(this));
        require(paymentToken.transfer(msg.sender, payout), "Payout failed");

        emit SharesSold(msg.sender, tokenAddress, amount, payout);
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyRole(UPGRADER_ROLE) {}
}
