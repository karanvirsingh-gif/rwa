# Quick Start: Deploy & Learn T-REX

## 🎯 Recommended: Hardhat Local Node

### 1. Start Local Blockchain
```bash
npx hardhat node
```
Keep this terminal open.

### 2. Deploy T-REX Suite
In a **new terminal**:
```bash
npx hardhat run scripts/deploy-trex-suite.ts --network localhost
```

**Copy the contract addresses** from the output!

### 3. Test the Flow
Update addresses in `scripts/interact-trex-flow.ts`, then:
```bash
npx hardhat run scripts/interact-trex-flow.ts --network localhost
```

## 📖 Alternative: Learn from Tests

```bash
npm test
```

See `test/fixtures/deploy-full-suite.fixture.ts` for deployment examples.

## ❓ Why Not Remix?

- T-REX uses complex proxy patterns
- Multiple contracts must deploy in order
- Hardhat scripts handle this automatically
- Better for learning the full flow

## 🏗️ For Real Estate Tokenization

After learning T-REX, you'll add:
- `PropertyRegistry.sol` - Links properties to T-REX tokens
- `PropertySale.sol` - Handles share purchases

These just call T-REX token functions - T-REX handles all KYC/compliance!
