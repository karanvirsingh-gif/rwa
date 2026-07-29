// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title AssetTreasury
 * @dev Minimal, asset-scoped fund custody. Deliberately holds no pricing, compliance,
 * or distribution logic - its only job is controlled receive/release of the payment
 * token backing ONE specific asset. One instance is deployed per asset (never shared
 * across assets or asset classes) so that a pause, bug, or incident on one asset's
 * Vault can never put another asset's investor funds at risk.
 */
contract AssetTreasury is Initializable, AccessControlUpgradeable, ReentrancyGuardUpgradeable {
    bytes32 public constant VAULT_ROLE = keccak256("VAULT_ROLE");           // the one paired AssetVault
    bytes32 public constant WITHDRAWER_ROLE = keccak256("WITHDRAWER_ROLE"); // backend treasury/distribution operator

    bytes32 public assetId;
    IERC20 public paymentToken;
    uint256 public totalReceived;

    event FundsReceived(address indexed from, uint256 amount);
    event FundsDeposited(address indexed from, uint256 amount, string reason);
    event FundsReleased(address indexed to, uint256 amount, string reason);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(bytes32 _assetId, address _paymentToken, address admin) public initializer {
        __AccessControl_init();
        __ReentrancyGuard_init();

        assetId = _assetId;
        paymentToken = IERC20(_paymentToken);

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    /**
     * @dev Called by the paired AssetVault immediately after it pulls payment from a
     * buyer. Emits the funds_locked evidence event the Settlement Engine watches for.
     */
    function receiveFunds(uint256 amount) external onlyRole(VAULT_ROLE) {
        totalReceived += amount;
        emit FundsReceived(msg.sender, amount);
    }

    /**
     * @dev Allows anyone (e.g., a borrower repaying principal, or a sponsor injecting capital) 
     * to securely deposit funds into the treasury. Emits an event for backend accounting.
     */
    function deposit(uint256 amount, string calldata reason) external nonReentrant {
        require(amount > 0, "amount must be greater than 0");
        require(paymentToken.transferFrom(msg.sender, address(this), amount), "deposit failed");
        
        totalReceived += amount;
        emit FundsDeposited(msg.sender, amount, reason);
    }

    /**
     * @dev Atomic payout back to an investor as the direct consequence of their own
     * redeem() call on the paired Vault - same transaction, same wallet-initiated
     * action, so this stays scoped to VAULT_ROLE rather than the backend operator.
     */
    function payout(address to, uint256 amount) external onlyRole(VAULT_ROLE) nonReentrant {
        require(paymentToken.transfer(to, amount), "payout failed");
        emit FundsReleased(to, amount, "redemption");
    }

    /**
     * @dev Discretionary release out of custody - sales revenue sweeps, distribution
     * funding, etc. Restricted to the backend treasury operator key, never the Vault.
     */
    function release(address to, uint256 amount, string calldata reason) external onlyRole(WITHDRAWER_ROLE) nonReentrant {
        require(paymentToken.transfer(to, amount), "release failed");
        emit FundsReleased(to, amount, reason);
    }

    function balance() external view returns (uint256) {
        return paymentToken.balanceOf(address(this));
    }
}
