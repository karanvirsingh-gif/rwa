# T-REX Deployment & Learning Guide

This guide will help you deploy T-REX contracts locally and learn the full flow.

## 🎯 Best Approach: Hardhat Local Node (Recommended)

**Why Hardhat?**
- ✅ Fast and easy to reset
- ✅ Built-in console for debugging
- ✅ Can run existing tests to see examples
- ✅ Better for learning the full flow
- ✅ Scripts are already set up

**Why NOT Remix?**
- ❌ T-REX uses complex proxy patterns (harder to deploy manually)
- ❌ Multiple contracts need to be deployed in order
- ❌ Harder to manage dependencies
- ❌ Can't easily run the full flow

## 📋 Prerequisites

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Compile contracts:**
   ```bash
   npm run build
   ```

## 🚀 Step-by-Step Deployment

### Option 1: Using Hardhat Local Node (Recommended)

#### Step 1: Start a local Hardhat node
```bash
npx hardhat node
```
This starts a local blockchain. Keep this terminal open.

#### Step 2: Deploy T-REX Suite
In a **new terminal**, run:
```bash
npx hardhat run scripts/deploy-trex-suite.ts --network localhost
```

This will:
- Deploy all implementation contracts
- Deploy TREXFactory
- Deploy a complete T-REX suite (Token + Identity Registry + Compliance)
- Print all contract addresses

**Save the addresses** from the output!

#### Step 3: Interact with the contracts
Update `scripts/interact-trex-flow.ts` with the addresses from Step 2, then run:
```bash
npx hardhat run scripts/interact-trex-flow.ts --network localhost
```

This demonstrates:
- Creating identities for users
- Registering users (KYC)
- Issuing claims
- Minting tokens
- Transferring tokens

### Option 2: Run Existing Tests (Learn from Examples)

The test files show real usage patterns:

```bash
# Run all tests
npm test

# Run specific test
npx hardhat test test/factory.test.ts
npx hardhat test test/compliance.test.ts
```

Look at `test/fixtures/deploy-full-suite.fixture.ts` to see how deployment works.

## 🔍 Understanding the Flow

### What T-REX Provides:
1. **Token** - The security token (shares)
2. **Identity Registry** - Stores user identities and KYC status
3. **Claim Topics Registry** - Defines required claims (e.g., "KYC_CLAIM")
4. **Trusted Issuers Registry** - Who can issue claims
5. **Modular Compliance** - Rules (country restrictions, limits, etc.)

### Typical Flow:
1. **Deploy Suite** - Use `TREXFactory.deployTREXSuite()` to deploy everything
2. **Register Users** - Add users to Identity Registry with country code
3. **Issue Claims** - Claim issuer signs KYC claims for users
4. **Mint Tokens** - Token agent mints tokens to verified users
5. **Transfer Tokens** - Users can transfer (compliance is checked automatically)

## 📝 For Your Real Estate Use Case

After understanding T-REX, you'll create:

1. **PropertyRegistry.sol** - Stores property info, links to T-REX token
2. **PropertySale.sol** - Handles buying shares (calls token.transferFrom)

These contracts will:
- Call T-REX token functions
- Let T-REX handle all KYC/compliance
- Just manage property-specific logic

## 🛠️ Troubleshooting

**"Nonce too high" error:**
- Reset your local node: Stop and restart `npx hardhat node`

**"Contract not found" error:**
- Make sure you compiled: `npm run build`

**"Insufficient funds" error:**
- Hardhat node gives accounts 10,000 ETH by default
- Check account balances in the node output

## 📚 Next Steps

1. ✅ Deploy and run the scripts
2. ✅ Read the test files to understand usage
3. ✅ Modify the scripts to experiment
4. ✅ Then build your PropertyRegistry contract
