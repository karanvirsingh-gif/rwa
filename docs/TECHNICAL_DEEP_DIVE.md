# 🛠️ Real Estate Tokenization: Technical Flow & Manual Verification

This document is for developers and technical auditors to understand the exact state changes and contract calls that occur during the RWA lifecycle.

---

## 🏗️ 1. Core Architecture Components

### A. The Smart Contracts
- **`RealEstateRegistry`**: The factory that links everything. Stores the `Vault` address for each `Token`.
- **`RealEstateVault`**: Inherits from `AbstractModule` (T-REX Compliance) and `Ownable`. It is the central liquidity and yield engine.
- **`Token (T-REX)`**: The ERC-3643 compliant security token. It calls back to the Vault on every transfer.
- **`IdentityRegistry`**: Stores OnchainIDs and Country Codes.

---

## 🔄 2. Transaction Sequence: The "Trade" Flow

When a user calls `buy()` or `sell()` on the Marketplace/Vault:

1.  **Identity Verification**: The Vault calls `identityRegistry.isVerified(user)`.
2.  **Token Transfer**: The Vault calls `token.transfer(seller, buyer, amount)`.
3.  **Compliance Hook**: The Token contract calls its compliance module (`RealEstateVault`).
4.  **Yield Checkpoint**: The Vault executes `moduleTransferAction`, updating the `magnifiedDividendCorrections` for both the sender and receiver.

---

## 💰 3. The "Hold-to-Earn" Calculation

We use the **Magnified Dividend Algorithm**. This avoids loops and allows 10,000+ holders to earn yield simultaneously.

### Key State Variables in `RealEstateVault.sol`
- `magnifiedDividendPerShare`: A global accumulator that increases every time yield is deposited.
- `magnifiedDividendCorrections[address]`: A "correction" factor to ensure users don't claim yield from *before* they bought tokens.
- `withdrawnDividends[address]`: Tracks how much a user has already claimed.

### Manual Verification Formula
A user's total earned yield at any moment is:
`TotalEarned = (balanceOf(User) * magnifiedDividendPerShare) + magnifiedDividendCorrections(User)`
`Withdrawable = (TotalEarned - withdrawnDividends(User)) / MAGNITUDE`

---

## 🔍 4. Manual Verification Steps (Hardhat/Etherscan)

To manually verify the system state, run these checks:

### Step A: Verify Compliance Binding
1.  Call `token.compliance()` to get the compliance address.
2.  Call `compliance.isModuleBound(vaultAddress)`. 
    - **Expected**: `true`.
    - *Why?* If false, the Vault won't see transfers and yield tracking will break.

### Step B: Identify Check
1.  Call `identityRegistry.isVerified(userAddress)`.
    - **Expected**: `true` (if KYC'd).

### Step C: Yield Calculation Check
1.  Call `vault.withdrawableYieldOf(userAddress)`.
    - This returns the exact amount of WEI the user can claim right now.

---

## 🛡️ 5. Role & Permission Matrix

| Function | Authorized Caller | Risk |
| :--- | :--- | :--- |
| `mint()` | **Token Agent** | High (Dilution) |
| `depositYield()` | **Any (External)** | Low (Donation) |
| `withdrawRevenue()` | **Vault Owner** | Medium (Operational) |
| `pause()` | **Token Agent** | High (System halt) |
| `claimYield()` | **Token Holder** | Low (User Action) |
