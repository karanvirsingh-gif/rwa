// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import "./AbstractModuleUpgradeable.sol";
import "../IModularCompliance.sol";
import "../../../token/IToken.sol";

/**
 * @title CollectibleLockPeriodModule
 * @dev Enforces a mandatory holding period (e.g., 30 days) for Collectible fraction tokens.
 * 
 * Follows the standard T-REX AbstractModuleUpgradeable pattern:
 * - One singleton deployed behind a ModuleProxy.
 * - Configuration (lock duration) is keyed by compliance address.
 * 
 * Hook Logic:
 * - `moduleMintAction`: Automatically sets the lock expiration for primary market buyers.
 * - `moduleTransferAction`: Automatically sets the lock expiration for secondary market buyers.
 * - `moduleCheck`: Blocks any transfer if the sender's lock period has not yet expired.
 */
contract CollectibleLockPeriodModule is AbstractModuleUpgradeable {
    
    // Maps a specific Collectible's Compliance contract address to its configured lock duration in seconds.
    // Think of it as: Collectible => 30 Days
    mapping(address => uint256) public lockDurations;

    struct Lock {
        uint256 amount;
        uint256 expiresAt;
    }

    // Maps a specific Collectible's Compliance contract to a User's wallet, which stores an array of their active locks.
    // Think of it as: Collectible => Investor Wallet => [Lock 1, Lock 2]
    mapping(address => mapping(address => Lock[])) public userLocks;

    event LockDurationSet(address indexed compliance, uint256 duration);
    event LockApplied(address indexed compliance, address indexed user, uint256 amount, uint256 lockEndsAt);

    /// @dev Initializes the contract and sets the initial state.
    function initialize() external initializer {
        __AbstractModule_init();
    }

    // =========================================================================
    // Admin Configuration
    // =========================================================================

    /// @dev Called by the token issuer (via the compliance contract) to configure the lock duration.
    function setLockDuration(uint256 duration) external onlyComplianceCall {
        lockDurations[msg.sender] = duration;
        emit LockDurationSet(msg.sender, duration);
    }

    // =========================================================================
    // T-REX Module Hooks
    // =========================================================================

    /// @dev Checks if the sender has enough unlocked balance to complete the transfer.
    function moduleCheck(
        address _from,
        address /* _to */,
        uint256 _value,
        address _compliance
    ) external view override returns (bool) {
        
        // Mints don't have a sender to restrict
        if (_from == address(0)) {
            return true;
        }

        uint256 lockedSum = 0;
        Lock[] memory locks = userLocks[_compliance][_from];
        
        for (uint i = 0; i < locks.length; i++) {
            if (locks[i].expiresAt > block.timestamp) {
                lockedSum += locks[i].amount;
            }
        }

        // If they don't have any active locks, transfer is fine
        if (lockedSum == 0) return true;

        address token = IModularCompliance(_compliance).getTokenBound();
        uint256 balance = IToken(token).balanceOf(_from);

        // Ensure their balance MINUS the locked amount is at least what they are trying to send
        if (balance < lockedSum || (balance - lockedSum) < _value) {
            return false;
        }

        return true;
    }

    /// @dev Hook called after a secondary market trade. 
    /// Secondary market buyers DO NOT receive a new lock. 
    function moduleTransferAction(address /* _from */, address /* _to */, uint256 /* _value */) external override onlyComplianceCall {}

    /// @dev Hook called after a primary market purchase. Applies the lock to the initial buyer.
    function moduleMintAction(address _to, uint256 _value) external override onlyComplianceCall {
        _applyLock(msg.sender, _to, _value);
    }

    /// @dev Hook called after a burn. No lock logic needed for burns.
    function moduleBurnAction(address /* _from */, uint256 /* _value */) external override onlyComplianceCall {}

    // =========================================================================
    // Internal Logic
    // =========================================================================

    function _applyLock(address compliance, address user, uint256 amount) internal {
        uint256 duration = lockDurations[compliance];
        
        // If duration is 0, no lock applies to this asset
        if (duration > 0) {
            uint256 endsAt = block.timestamp + duration;
            userLocks[compliance][user].push(Lock({
                amount: amount,
                expiresAt: endsAt
            }));
            emit LockApplied(compliance, user, amount, endsAt);
        }
    }

    // =========================================================================
    // Standard Getters
    // =========================================================================

    function canComplianceBind(address) external pure override returns (bool) {
        return true;
    }

    function isPlugAndPlay() external pure override returns (bool) {
        return true;
    }

    function name() external pure override returns (string memory) {
        return "CollectibleLockPeriodModule";
    }
}
