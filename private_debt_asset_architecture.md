# 🏛️ Private Debt Asset — Blockchain Architecture Design
### Enterprise RWA Platform · Based on `realworldasset` T-REX (ERC-3643) Codebase

---

## 1. Executive Summary & Asset Comparison

Integrating **Private Debt Assets** (Corporate Bonds, Promissory Notes, Direct Lending Tranches, and Structured Credit) into the existing `realworldasset` repository requires transitioning from an **equity/property yield model** (Real Estate) and **physical commodity backing** (Gold) to a **cash-flow schedule and credit-covenant model**.

### How Private Debt Differs from Existing Asset Classes

| Dimension | Real Estate (Current) | Gold Asset | Private Debt (New Architecture) |
| :--- | :--- | :--- | :--- |
| **Asset Structure** | Indivisible Property NFT | Divisible physical bar lots | Divisible Debt Tranches (Senior, Mezzanine, Junior) |
| **Yield & Return** | Variable rental income | Negative carry (storage fee) | Fixed or floating coupon interest + principal repayment |
| **Lifecycle** | Perpetual / Open-ended | Open-ended (redeemable) | **Fixed Maturity Date** (with amortization/balloon schedules) |
| **Valuation** | Manual appraiser `setPrice` | Live Chainlink XAU/USD oracle | Par value ($1.00) discounted/premium by credit rating & yield curve |
| **Default Handling** | N/A (equity risk) | N/A (collateralized) | **Default / Acceleration events**, collateral liquidation, and transfer freezes |
| **Compliance Depth** | Geography + investor limits | Commodity laws + OFAC | **Securities laws (Reg D/S, MiFID II)**, Accredited Investor gating, FATCA/CRS |

---

## 2. Utilizing the Existing Codebase Effectively

A key strength of your current architecture is the **T-REX (ERC-3643) suite**. Over **85% of the existing codebase can be utilized without modification**.

### What Remains Unchanged (Plug-and-Play)
1. **Core T-REX Suite (`/contracts/factory/TREXFactory.sol`)**:
   - `TokenProxy`, `IdentityRegistryProxy`, `ClaimTopicsRegistryProxy`, `TrustedIssuersRegistryProxy`, and `ModularComplianceProxy` are reused 100% as-is.
2. **Identity & Claim Verification (`/contracts/registry/`)**:
   - The OnchainID verification pipeline automatically validates lenders/investors before any token minting or transfer occurs.
3. **Existing Compliance Modules (`/contracts/compliance/modular/modules/`)**:
   - `CountryAllowModule` / `CountryRestrictModule`: Essential for enforcing jurisdictional sanctions and tax withholding rules.
   - `MaxBalanceModule`: Prevents single-lender concentration risk in syndicated loans.
   - `TimeTransfersLimitsModule` / `TransferRestrictModule`: Enforces lock-up periods (e.g., Reg S 40-day/1-year distribution compliance periods).
   - `DailyTransferLimitModule`: Manages AML velocity checks.
   - `TransferFeesModule`: Enforces secondary trading administrative or servicing fees.
   - `ConditionalTransferModule`: Reused to freeze trading during restructuring or default resolution.

---

## 3. New Contracts Required for Private Debt

To support credit instruments, we implement four dedicated components following the established repository design patterns.

```
PrivateDebtRegistry (NFT Agreement) → PrivateDebtToken (ERC-3643) → PrivateDebtVault (Coupons + Principal)
```

### 3.1 `PrivateDebtRegistry.sol` — Replaces `RealEstateRegistry.sol`
Anchors the off-chain loan agreement, security documents, credit rating, and maturity schedule to an on-chain NFT.

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import "@openzeppelin/contracts-upgradeable/token/ERC721/extensions/ERC721URIStorageUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

contract PrivateDebtRegistry is Initializable, ERC721URIStorageUpgradeable, AccessControlUpgradeable, UUPSUpgradeable {
    bytes32 public constant ISSUER_ROLE = keccak256("ISSUER_ROLE");
    bytes32 public constant TRUSTEE_ROLE = keccak256("TRUSTEE_ROLE");

    enum DebtStatus { Active, Matured, Defaulted, Restructuring }

    struct DebtInstrument {
        string borrowerName;
        uint256 principalAmount;     // Total facility size (in payment token decimals, e.g., 1e6 for USDC)
        uint256 couponRateBps;       // e.g., 850 = 8.50% APR
        uint256 maturityTimestamp;   // Unix timestamp for loan maturity
        uint256 paymentFrequency;    // e.g., 30 days (monthly), 90 days (quarterly)
        string creditRating;         // e.g., "BBB+", "Private-AG"
        bytes32 agreementHash;       // SHA-256 hash of signed off-chain loan/indenture agreement
        address tokenAddress;        // Linked ERC-3643 T-REX Token
        address vaultAddress;        // Linked PrivateDebtVault
        DebtStatus status;
    }

    mapping(uint256 => DebtInstrument) public debtInstruments;
    mapping(address => uint256) public tokenToDebtId;

    event DebtRegistered(uint256 indexed debtId, address indexed tokenAddress, uint256 principalAmount, uint256 maturity);
    event DebtStatusUpdated(uint256 indexed debtId, DebtStatus newStatus);

    function initialize(address admin) public initializer {
        __ERC721_init("PrivateDebtRegistry", "PDR");
        __ERC721URIStorage_init();
        __AccessControl_init();
        __UUPSUpgradeable_init();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ISSUER_ROLE, admin);
        _grantRole(TRUSTEE_ROLE, admin);
    }

    function registerDebt(
        address to,
        string memory uri,
        uint256 principalAmount,
        uint256 couponRateBps,
        uint256 maturityTimestamp,
        uint256 paymentFrequency,
        string memory creditRating,
        bytes32 agreementHash,
        address tokenAddress,
        address vaultAddress
    ) external onlyRole(ISSUER_ROLE) returns (uint256 debtId) {
        // Mint NFT representing the Master Loan Agreement
        // Store debt details and map tokenAddress
    }

    function updateStatus(uint256 debtId, DebtStatus newStatus) external onlyRole(TRUSTEE_ROLE) {
        debtInstruments[debtId].status = newStatus;
        emit DebtStatusUpdated(debtId, newStatus);
    }

    function isTransferable(address tokenAddress) external view returns (bool) {
        uint256 debtId = tokenToDebtId[tokenAddress];
        DebtInstrument memory debt = debtInstruments[debtId];
        // Prevent transfers if defaulted, restructuring, or past maturity
        if (debt.status == DebtStatus.Defaulted || debt.status == DebtStatus.Restructuring) return false;
        if (block.timestamp >= debt.maturityTimestamp && debt.status != DebtStatus.Matured) return false;
        return true;
    }
}
```

### 3.2 `PrivateDebtVault.sol` — Replaces `RealEstateVault.sol`
Manages the two-phase lifecycle of private debt:
1. **Funding Phase**: Lenders deposit USDC to purchase debt tokens at Par ($1.00) until `principalAmount` is raised.
2. **Servicing Phase**: Borrower/Issuer deposits periodic interest coupons (distributed via magnified dividend algorithm) and final principal repayment upon maturity.

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import "./RealEstateVault.sol"; // Extends modular compliance & dividend distribution patterns

contract PrivateDebtVault is Initializable, UUPSUpgradeable, AccessControlUpgradeable, ReentrancyGuardUpgradeable, PausableUpgradeable, AbstractModule {
    bytes32 public constant BORROWER_ROLE = keccak256("BORROWER_ROLE");
    bytes32 public constant SERVICER_ROLE = keccak256("SERVICER_ROLE");

    IToken public debtToken;
    IERC20 public paymentToken;     // USDC / USDT
    PrivateDebtRegistry public registry;
    uint256 public debtId;

    // Capital Formation State
    uint256 public fundingDeadline;
    uint256 public totalFunded;
    bool public isFundingClosed;

    // Coupon & Principal State
    uint256 public totalCouponsDeposited;
    uint256 public principalRepaid;
    uint256 public magnifiedCouponPerShare;
    mapping(address => int256) public magnifiedCouponCorrections;
    mapping(address => uint256) public withdrawnCoupons;
    mapping(address => bool) public principalClaimed;

    event CouponDeposited(uint256 amount, uint256 period);
    event PrincipalRepaid(uint256 totalAmount);
    event PrincipalClaimed(address indexed lender, uint256 amount);

    // -------------------------------------------------------------------------
    // Funding Phase: Lenders fund the loan
    // -------------------------------------------------------------------------
    function fundLoan(uint256 tokenAmount) external nonReentrant whenNotPaused {
        require(!isFundingClosed, "Funding closed");
        require(block.timestamp <= fundingDeadline, "Funding window expired");
        // Verify investor KYC via IdentityRegistry
        // Transfer USDC from lender to vault, mint or transfer debt tokens
    }

    function drawdownPrincipal() external onlyRole(BORROWER_ROLE) {
        require(isFundingClosed || totalFunded == debtToken.totalSupply(), "Not fully funded");
        // Transfer accumulated USDC principal to borrower bank/wallet
    }

    // -------------------------------------------------------------------------
    // Servicing Phase: Coupon & Principal Distribution
    // -------------------------------------------------------------------------
    function depositCoupon(uint256 amount) external onlyRole(SERVICER_ROLE) {
        require(paymentToken.transferFrom(msg.sender, address(this), amount), "Transfer failed");
        totalCouponsDeposited += amount;
        magnifiedCouponPerShare += (amount * 2**128) / debtToken.totalSupply();
        emit CouponDeposited(amount, block.timestamp);
    }

    function depositPrincipalRepayment(uint256 amount) external onlyRole(SERVICER_ROLE) {
        require(paymentToken.transferFrom(msg.sender, address(this), amount), "Transfer failed");
        principalRepaid += amount;
        registry.updateStatus(debtId, PrivateDebtRegistry.DebtStatus.Matured);
        emit PrincipalRepaid(amount);
    }

    function claimCouponAndPrincipal() external nonReentrant {
        // Claim accumulated interest coupons
        // If Matured and principal repaid, burn debtToken and return par USDC principal
    }

    // AbstractModule compliance hooks to track shareholder balances for coupon distribution
    function moduleTransferAction(address _from, address _to, uint256 _value) external override onlyComplianceCall {
        magnifiedCouponCorrections[_from] += int256(magnifiedCouponPerShare * _value);
        magnifiedCouponCorrections[_to] -= int256(magnifiedCouponPerShare * _value);
    }
}
```

### 3.3 `DebtMaturityModule.sol` — New Compliance Module
A dedicated modular compliance rule that interfaces with `PrivateDebtRegistry` to freeze secondary trading when a bond reaches maturity, defaults, or enters restructuring.

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import "../compliance/modular/modules/AbstractModule.sol";
import "../../interface/IPrivateDebtRegistry.sol";

contract DebtMaturityModule is AbstractModule {
    IPrivateDebtRegistry public registry;

    constructor(address _registry) {
        registry = IPrivateDebtRegistry(_registry);
    }

    function moduleCheck(address /*_from*/, address /*_to*/, uint256 /*_value*/, address _compliance) external view override returns (bool) {
        address token = IModularCompliance(_compliance).getTokenBound();
        return registry.isTransferable(token);
    }

    function moduleTransferAction(address, address, uint256) external override onlyComplianceCall {}
    function moduleMintAction(address, uint256) external override onlyComplianceCall {}
    function moduleBurnAction(address, uint256) external override onlyComplianceCall {}
    function name() external pure override returns (string memory) { return "DebtMaturityModule"; }
    function isPlugAndPlay() external pure override returns (bool) { return true; }
    function canComplianceBind(address) external pure override returns (bool) { return true; }
}
```

### 3.4 `PrivateDebtAssetFactory.sol` — Orchestrator
Mirrors `TREXFactory` and `RealEstateVaultFactory` to deploy the entire suite in a single transaction:
1. Deploys T-REX suite (`Token`, `IdentityRegistry`, `ModularCompliance`, etc.).
2. Binds standard modules (`CountryAllow`, `TransferFees`, `MaxBalance`) + `DebtMaturityModule`.
3. Deploys ERC-1967 Proxy for `PrivateDebtVault` and binds it to compliance for coupon tracking.
4. Mints `PrivateDebtRegistry` NFT anchoring the credit facility.

---

## 4. End-to-End Architecture & Lifecycle Flow

```
                     ┌──────────────────────────────────────────┐
                     │     Off-Chain Loan Agreement / Indenture │
                     │     (Credit Rating, Covenants, Schedule) │
                     └────────────────────┬─────────────────────┘
                                          │ SHA-256 Agreement Hash
                     ┌────────────────────▼─────────────────────┐
                     │          PrivateDebtRegistry             │
                     │  NFT #101: Active Loan Facility          │
                     │  isTransferable(token) ──────────────────┼──────┐
                     └──────────────────────────────────────────┘      │
                                                                       │ (Checks Status)
┌──────────────────────────┐     ┌───────────────────────────┐         │
│ PrivateDebtAssetFactory  │────▶│    ERC-3643 Debt Token    │         │
│ deployDebtSuite()        │     │  ModularCompliance        │         │
└──────────────────────────┘     │  ├── DebtMaturityModule ◄─┼─────────┘
                                 │  ├── CountryAllowModule   │
                                 │  ├── MaxBalanceModule     │
                                 │  └── DailyTransferLimit   │
                                 └─────────────┬─────────────┘
                                               │
                                 ┌─────────────▼─────────────┐
                                 │     PrivateDebtVault      │
                                 │  ├── fundLoan(USDC)       │ ──▶ Capital Formation
                                 │  ├── depositCoupon(USDC)  │ ──▶ Periodic Interest
                                 │  └── depositPrincipal()   │ ──▶ Final Redemption
                                 └───────────────────────────┘
```

---

## 5. General Compliance Requirements for Private Debt

Private debt assets face stringent financial and securities regulations across major jurisdictions (SEC in USA, ESMA/MiFID II in EU, FCA in UK, MAS in Singapore). 

### 5.1 Mandated Claim Topics in `ClaimTopicsRegistry`
Unlike real estate or commodities, private debt issuances generally fall under **private placement exemptions** (e.g., US Reg D Rule 506(c), Reg S, Section 3(c)(7)). Lenders must possess specific OnchainID claims:

| Claim Topic | Name | Regulatory Purpose & Enforcement |
| :--- | :--- | :--- |
| **`1` (`KYC_CLAIM`)** | Liveness & Identity | Standard KYC/AML identity verification via trusted issuers. |
| **`2` (`AML_CLAIM`)** | Watchlist / PEP Screening | Ongoing FATF compliance, OFAC sanctions, and Adverse Media screening. |
| **`3` (`ACCREDITED_INVESTOR`)** | Wealth / Institutional Status | **Securities Law**: Confirms net worth > $1M or income > $200k (US) or Professional Client status (EU MiFID II). Required for private credit. |
| **`4` (`JURISDICTION_CLAIM`)** | Tax & Residency | Enforces tax withholding treaties (FATCA/CRS reporting) and blocks retail participation where prohibited. |
| **`5` (`QUALIFIED_PURCHASER`)** | Institutional Threshold | Used for syndicated institutional debt (> $5M in investments) under Section 3(c)(7) exemptions. |

### 5.2 Required Modular Compliance Stack
To ensure full regulatory compliance during secondary trading, bind the following modules to `ModularCompliance`:

1. **`DebtMaturityModule` (New)**: Freezes all trading upon loan maturity, default, or acceleration.
2. **`CountryAllowModule` (Existing)**: Blocks sanctioned countries (OFAC list: Iran, North Korea, Russia, Syria, etc.) and jurisdictions where the debt prospectus is not registered.
3. **`MaxBalanceModule` / Investor Count Cap (Existing)**: 
   - Enforces the **100-investor limit** for Section 3(c)(1) funds or **2,000-holder limit** under SEC Exchange Act Section 12(g) to avoid forced public company registration.
4. **`TimeTransfersLimitsModule` (Existing)**: Enforces **Reg S distribution compliance periods** (e.g., 40-day or 1-year lock-up preventing resale to US persons).
5. **`DailyTransferLimitModule` (Existing)**: Implements FATF Recommendation 16 transaction velocity monitoring.

---

## 6. Summary of Codebase Utilization vs. New Build

| Component / Contract | Status | Action Required |
| :--- | :---: | :--- |
| `TREXFactory.sol`, `TREXGateway.sol` | ✅ Existing | Zero changes. Deploys core ERC-3643 token proxies. |
| `IdentityRegistry.sol`, `ClaimTopicsRegistry.sol` | ✅ Existing | Zero changes. Configure with new Accredited Investor claim topics. |
| Standard Compliance Modules (`CountryAllow`, `MaxBalance`, etc.) | ✅ Existing | Zero changes. Reused directly in deployment script. |
| **`PrivateDebtRegistry.sol`** | 🆕 New Build | Replaces `RealEstateRegistry`. Adds credit rating, maturity, and agreement hashes. |
| **`PrivateDebtVault.sol`** | 🆕 New Build | Replaces `RealEstateVault`. Adds loan funding drawdown and coupon/principal servicing. |
| **`DebtMaturityModule.sol`** | 🆕 New Build | New compliance rule freezing transfers on maturity/default. |
| **`PrivateDebtAssetFactory.sol`** | 🆕 New Build | Orchestrator factory tying T-REX suite, Vault, and Registry together. |
| **`deploy-private-debt.ts`** | 🆕 New Build | Hardhat/Ethers deployment script automating the atomic setup. |
