# Backend Integration Guide (T-REX)

**Copy-paste ready code for backend integration.**

Three main flows: KYC verification → Register property → Buy/Sell shares.

---

## ✅ Setup (5 minutes)

### 1. Install ethers

```bash
npm install ethers
```

### 2. Environment variables

```bash
export RPC_URL="https://your-rpc-endpoint"
export PRIVATE_KEY="0xyour...key"
```

### 3. Contract addresses (amoy network)

```
STABLECOIN_ADDRESS = 0xF39906465Ac54E2370c4a189Af83b143f99F7010
IDENTITY_REGISTRY_ADDRESS = 0x192738Fb0FF12Aa5564FAF18dEa315ccdF5A98ec
REAL_ESTATE_REGISTRY_ADDRESS = 0xB79a38247D66369fD9A5dF844Eac0fe94a88abd1
REAL_ESTATE_MARKETPLACE_ADDRESS = 0x4f087f31e47F6EC53e3eAaE7Eb7234B7A459DfBA
```

---

## 🧩 Required ABIs (copy these)

### Identity Registry

```json
[
  "function isVerified(address) view returns (bool)",
  "function updateIdentity(address user, address identity)",
  "function updateCountry(address user, uint16 country)"
]
```

### RealEstateRegistry

```json
[
  "function registerProperty(address to, string uri, address tokenAddress, address vaultAddress) returns (uint256)",
  "function propertyTokens(uint256 propertyId) view returns (address)",
  "function propertyVaults(uint256 propertyId) view returns (address)"
]
```

### RealEstateMarketplace

```json
[
  "function buyShares(address tokenAddress, uint256 amount)",
  "function sellShares(address tokenAddress, uint256 amount)"
]
```

### ERC20 (stablecoin / property token)

```json
[
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function transferFrom(address from, address to, uint256 amount) returns (bool)"
]
```

---

## 🔌 Initialize contracts

```ts
import { ethers } from "ethers";

const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
const signer = new ethers.Wallet(process.env.PRIVATE_KEY!, provider);

const identityRegistryAbi = [
  "function isVerified(address) view returns (bool)",
  "function updateIdentity(address, address)",
  "function updateCountry(address, uint16)"
];
const marketplaceAbi = ["function buyShares(address, uint256)", "function sellShares(address, uint256)"];
const registryAbi = ["function registerProperty(address, string, address, address) returns (uint256)","function propertyTokens(uint256) view returns (address)","function propertyVaults(uint256) view returns (address)"];
const erc20Abi = ["function approve(address, uint256) returns (bool)","function balanceOf(address) view returns (uint256)","function transfer(address, uint256) returns (bool)","function transferFrom(address, address, uint256) returns (bool)"];

const identityRegistry = new ethers.Contract("0x192738Fb0FF12Aa5564FAF18dEa315ccdF5A98ec", identityRegistryAbi, signer);
const marketplace = new ethers.Contract("0x4f087f31e47F6EC53e3eAaE7Eb7234B7A459DfBA", marketplaceAbi, signer);
const registry = new ethers.Contract("0xB79a38247D66369fD9A5dF844Eac0fe94a88abd1", registryAbi, signer);
const stablecoin = new ethers.Contract("0xF39906465Ac54E2370c4a189Af83b143f99F7010", erc20Abi, signer);
```

---

## ✅ Flow 1: KYC - Check if user is verified

```ts
const userAddress = "0x...";
const isVerified = await identityRegistry.isVerified(userAddress);
console.log("User verified:", isVerified);
```

---

## ✅ Flow 2: KYC - Register/Update identity (requires AGENT_ROLE)

```ts
const userAddress = "0x...";
const identityContractAddress = "0x..."; // Identity contract for this user

await identityRegistry.updateIdentity(userAddress, identityContractAddress);
console.log("KYC registered");
```

---

## ✅ Flow 3: KYC - Set country (optional geofencing)

```ts
const userAddress = "0x...";
const countryCode = 250; // 250 = France (ISO 3166-1)

await identityRegistry.updateCountry(userAddress, countryCode);
console.log("Country set");
```

---

## 🏠 Flow 4: Register a property (requires REGISTER_ROLE)

```ts
const to = "0x..."; // Property owner/operator
const uri = "ipfs://Qm..."; // Property metadata
const tokenAddress = "0x..."; // Property ERC-20 token
const vaultAddress = "0x..."; // Property vault

const tx = await registry.registerProperty(to, uri, tokenAddress, vaultAddress);
await tx.wait();
console.log("Property registered");

// Verify property was registered
const propertyId = 1;
const token = await registry.propertyTokens(propertyId);
const vault = await registry.propertyVaults(propertyId);
console.log("Token:", token, "Vault:", vault);
```

---

## 💰 Flow 5: Buy shares (3 steps)

### Step 1: Verify user has KYC

```ts
const buyerAddress = "0x...";
const isVerified = await identityRegistry.isVerified(buyerAddress);
if (!isVerified) {
  throw new Error("User not KYC verified");
}
```

### Step 2: Approve stablecoin spending

```ts
const amountToSpend = ethers.parseUnits("1000", 6); // 1000 USDC (6 decimals)

await stablecoin.approve(
  "0x4f087f31e47F6EC53e3eAaE7Eb7234B7A459DfBA", // Marketplace address
  amountToSpend
);
console.log("Approved");
```

### Step 3: Buy shares

```ts
const propertyTokenAddress = "0x..."; // Token to buy
const amountOfShares = ethers.parseUnits("10", 18); // 10 shares

await marketplace.buyShares(propertyTokenAddress, amountOfShares);
console.log("Shares bought");
```

---

## 💸 Flow 6: Sell shares (2 steps)

### Step 1: Approve property token spending

```ts
const propertyTokenAddress = "0x...";
const amountOfShares = ethers.parseUnits("10", 18);

const propertyToken = new ethers.Contract(propertyTokenAddress, erc20Abi, signer);
await propertyToken.approve(
  "0x4f087f31e47F6EC53e3eAaE7Eb7234B7A459DfBA", // Marketplace address
  amountOfShares
);
console.log("Approved");
```

### Step 2: Sell shares

```ts
const propertyTokenAddress = "0x...";
const amountOfShares = ethers.parseUnits("10", 18);

await marketplace.sellShares(propertyTokenAddress, amountOfShares);
console.log("Shares sold");
```

---

## 📋 Complete working example

```ts
import { ethers } from "ethers";

async function main() {
  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
  const signer = new ethers.Wallet(process.env.PRIVATE_KEY!, provider);

  const identityAbi = ["function isVerified(address) view returns (bool)"];
  const marketplaceAbi = ["function buyShares(address, uint256)", "function sellShares(address, uint256)"];
  const erc20Abi = ["function approve(address, uint256) returns (bool)"];

  const idRegistry = new ethers.Contract("0x192738Fb0FF12Aa5564FAF18dEa315ccdF5A98ec", identityAbi, signer);
  const marketplace = new ethers.Contract("0x4f087f31e47F6EC53e3eAaE7Eb7234B7A459DfBA", marketplaceAbi, signer);
  const stablecoin = new ethers.Contract("0xF39906465Ac54E2370c4a189Af83b143f99F7010", erc20Abi, signer);

  // Check KYC
  const user = "0x..."; // Your user address
  const isKyc = await idRegistry.isVerified(user);
  console.log("KYC verified:", isKyc);

  // Approve + Buy
  const propertyToken = "0x..."; // Property token address
  const amount = ethers.parseUnits("10", 18);

  await stablecoin.approve(marketplace.target, ethers.parseUnits("1000", 6));
  await marketplace.buyShares(propertyToken, amount);
  console.log("Purchase complete!");
}

main().catch(console.error);
```

---

## 🆘 Error troubleshooting

| Error | Solution |
|-------|----------|
| "User not verified" | Call `updateIdentity` with identity address |
| "Insufficient allowance" | Call `approve` on stablecoin or token first |
| "Only AGENT_ROLE" | Use address with `AGENT_ROLE` |
| "Vault not found" | Check token address is registered in registry |

---
