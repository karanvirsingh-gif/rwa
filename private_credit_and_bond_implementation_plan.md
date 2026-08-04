# Unified Asset Lifecycle Module (Private Credit + Bond)

## Background

The current `PrivateCreditStateModule` implements a single, rigid lifecycle for private credit assets. 
The goal is to extend it to serve **both** Private Credit and Bond asset types within the same 
upgradeable module, using **feature flags** configured at asset creation time.

---

## Core Architectural Approach: Feature Flags, Not Forking

Rather than a separate `BondStateModule` or a long `if assetType == BOND` chain everywhere, the 
**cleanest industry-standard approach** is to use **feature flags** stored in `LoanDetails`. 
This is how protocols like Maple Finance and Goldfinch handle multi-product compliance in a single contract.

```
LoanDetails
├── assetType     → AssetType enum (for clarity / off-chain indexing)
├── hasRefund     → bool (private credit: always true | bond: configured at creation)
└── hasMaturity   → bool (private credit: always true | bond: configured at creation)
```

The state machine diagram for both types:

```
                  ┌─────────────────── FUNDING ──────────────────────┐
                  │                                                   │
                  ▼                                                   ▼
  [hasRefund=true only]  REFUND          ACTIVE ──────────────► DEFAULTED
                                           │
                              [hasMaturity=true only]
                                           │
                                           ▼
                                         MATURED
```

---

## Open Questions

> [!IMPORTANT]
> **1. Contract & File Rename?**
> Since this module now handles both Private Credit and Bonds, the name `PrivateCreditStateModule`
> is misleading. Suggested rename: **`RWALifecycleModule`** (placed at `contracts/rwa/RWALifecycleModule.sol`).
> Do you want to rename, or keep the existing name to avoid breaking existing deployment scripts?

> [!IMPORTANT]
> **2. Private Credit: Enforce target principal on `transitionToActive`?**
> Currently `transitionToActive` doesn't validate that the target principal was raised.
> For private credit, should we add `require(totalSupply >= targetPrincipal)` before allowing ACTIVE?
> This would be the correct real-world enforcement. Or is the admin trusted to call it only when ready?

> [!IMPORTANT]
> **3. Bond without maturity (`hasMaturity = false`): What happens to `transitionToMatured`?**
> Two options:
> - **Option A (Recommended)**: Revert if called — "this bond has no maturity configured"
> - **Option B**: Allow it anyway as an admin override (e.g. for early redemption events)

> [!IMPORTANT]
> **4. Bond ACTIVE state minting: Is re-minting allowed after going ACTIVE?**
> For a bond with `hasRefund = false`, the admin goes ACTIVE with partial supply. Should additional
> minting be allowed after that (to continue raising capital), or is ACTIVE always a mint-freeze?
> Current behavior: ACTIVE always freezes minting. Recommend keeping this.

---

## Proposed Changes

### 1. Rename + Relocate (if approved)

#### [DELETE] [PrivateCreditStateModule.sol](file:///Users/chicmic/Desktop/RWA/rwa/contracts/private_credit/PrivateCreditStateModule.sol)
#### [NEW] `contracts/rwa/RWALifecycleModule.sol`

> If rename is rejected, all changes below apply to the existing file in-place.

---

### 2. Modified `LoanDetails` Struct

Add three new fields. Since this is a **fresh deployment** (development phase), no storage migration needed.

```solidity
// BEFORE
struct LoanDetails {
    uint256 targetPrincipal;
    uint256 fundingDeadline;
    uint256 maturityTimestamp;
    uint256 paymentFrequency;
    uint256 couponRateBps;
    bytes32 agreementHash;
    address borrower;
    LoanState state;
}

// AFTER
enum AssetType { PRIVATE_CREDIT, BOND }

struct LoanDetails {
    AssetType assetType;        // NEW: asset classification
    uint256 targetPrincipal;
    uint256 fundingDeadline;
    uint256 maturityTimestamp;  // ignored in moduleCheck if hasMaturity = false
    uint256 paymentFrequency;
    uint256 couponRateBps;
    bytes32 agreementHash;
    address borrower;
    LoanState state;
    bool hasRefund;             // NEW: if false, REFUND state is never reachable
    bool hasMaturity;           // NEW: if false, maturity auto-freeze is skipped
}
```

> **Storage safety**: New fields are appended to the struct; no existing slot is moved. 
> ERC-7201 namespacing ensures no collision with the base contract's storage.

---

### 3. Modified `initializeLoan` Signature

```solidity
// BEFORE
function initializeLoan(
    address token,
    uint256 targetPrincipal,
    uint256 fundingDeadline,
    uint256 maturityTimestamp,
    uint256 paymentFrequency,
    uint256 couponRateBps,
    bytes32 agreementHash,
    address borrower
) external onlyOwner

// AFTER — adds 3 params at the end (backward-compat break, but dev phase = ok)
function initializeLoan(
    address token,
    AssetType assetType,        // NEW
    uint256 targetPrincipal,
    uint256 fundingDeadline,
    uint256 maturityTimestamp,  // pass 0 if hasMaturity = false
    uint256 paymentFrequency,
    uint256 couponRateBps,
    bytes32 agreementHash,
    address borrower,
    bool hasRefund,             // NEW: true for private credit, configurable for bond
    bool hasMaturity            // NEW: true for private credit, configurable for bond
) external onlyOwner
```

**Validation added inside `initializeLoan`:**
```solidity
// Private credit must always have refund and maturity
if (assetType == AssetType.PRIVATE_CREDIT) {
    require(hasRefund && hasMaturity, "Private credit requires both refund and maturity");
}
// Bond without maturity must have maturityTimestamp = 0
if (!hasMaturity) {
    require(maturityTimestamp == 0, "Set maturityTimestamp to 0 when hasMaturity is false");
}
```

---

### 4. Modified State Transitions

#### `transitionToActive` — add supply enforcement for Private Credit

```solidity
function transitionToActive(address token) external onlyOwner {
    PrivateCreditStorage storage s = _getStorage();
    LoanDetails memory config = s.loanConfigs[token];

    // Private credit: must reach target before going active
    if (config.assetType == AssetType.PRIVATE_CREDIT) {
        uint256 currentSupply = IToken(token).totalSupply();
        require(currentSupply >= config.targetPrincipal, "Target principal not reached");
    }
    // Bond with hasRefund=false: allowed to go active with any supply raised

    _transition(token, LoanState.FUNDING, LoanState.ACTIVE);
}
```

#### `transitionToRefund` — gate with `hasRefund` flag

```solidity
function transitionToRefund(address token) external onlyOwner {
    require(_getStorage().loanConfigs[token].hasRefund, "Refund not enabled for this asset");
    _transition(token, LoanState.FUNDING, LoanState.REFUND);
}
```

#### `transitionToMatured` — gate with `hasMaturity` flag

```solidity
function transitionToMatured(address token) external onlyOwner {
    require(_getStorage().loanConfigs[token].hasMaturity, "Maturity not enabled for this asset");
    _transition(token, LoanState.ACTIVE, LoanState.MATURED);
}
```

---

### 5. Modified `moduleCheck` — conditional maturity freeze

```solidity
} else if (config.state == LoanState.ACTIVE) {
    if (isMint) return false;
    // Only auto-freeze P2P if maturity is configured AND timestamp has passed
    if (isP2P && config.hasMaturity && block.timestamp >= config.maturityTimestamp) {
        return false;
    }
}
```

---

### 6. Updated Events

```solidity
// Add assetType to LoanInitialized for off-chain indexing
event LoanInitialized(
    address indexed token,
    AssetType assetType,        // NEW
    uint256 target,
    uint256 deadline,
    address borrower,
    bool hasRefund,             // NEW
    bool hasMaturity            // NEW
);
```

---

### 7. Updated Deployment Scripts

#### [MODIFY] `scripts/create-private-credit-asset-amoy.ts`
- Pass `AssetType.PRIVATE_CREDIT`, `hasRefund: true`, `hasMaturity: true` in `initializeLoan` call

#### [NEW] `scripts/create-bond-asset-amoy.ts`  
- Template script showing Bond creation with configurable `hasRefund` and `hasMaturity`

---

## Complete Lifecycle Matrix

| Scenario | `assetType` | `hasRefund` | `hasMaturity` | Target reached? | Can go ACTIVE? | Can go REFUND? | Auto-freeze at maturity? |
|---|---|---|---|---|---|---|---|
| Private Credit | `PRIVATE_CREDIT` | `true` | `true` | Required (enforced) | ✅ | ✅ | ✅ |
| Bond (full features) | `BOND` | `true` | `true` | Not required | ✅ | ✅ | ✅ |
| Bond (no refund) | `BOND` | `false` | `true` | Not required | ✅ | ❌ reverts | ✅ |
| Bond (no maturity) | `BOND` | `true` | `false` | Not required | ✅ | ✅ | ❌ |
| Bond (open-ended) | `BOND` | `false` | `false` | Not required | ✅ | ❌ reverts | ❌ |

---

## Verification Plan

### Automated
```bash
npx hardhat compile
npx hardhat test --grep "RWALifecycleModule"
```

### Manual Scenarios to Test
1. Deploy proxy → `initializeLoan` with `PRIVATE_CREDIT` → call `transitionToActive` with partial supply → expect revert
2. Deploy proxy → `initializeLoan` with `BOND, hasRefund=false` → call `transitionToRefund` → expect revert
3. Deploy proxy → `initializeLoan` with `BOND, hasMaturity=false` → call `transitionToMatured` → expect revert
4. Deploy proxy → `initializeLoan` with `BOND, hasMaturity=false` in ACTIVE state → verify P2P trades succeed past any timestamp
5. Upgrade implementation → verify all `loanConfigs` storage persists through the proxy
