import { ethers } from 'hardhat';
import * as fs from 'fs';
import * as path from 'path';

/**
 * ONE-TIME SETUP: Register Private Credit AND Bond asset types on the AssetFactory.
 *
 * This script:
 *   1. Deploys the RWALifecycleModule implementation
 *   2. Deploys a ModuleProxy (UUPS) pointing to it  →  permanent address stored on-chain
 *   3. Deploys/reuses an upgradeable SupplyLimitModule proxy
 *   4. Registers "PRIVATE_CREDIT" asset type (RWALifecycleModule + SupplyLimitModule)
 *   5. Registers "BOND"           asset type (RWALifecycleModule + SupplyLimitModule)
 *
 * Both asset types share the same RWALifecycleModule proxy — the per-token behaviour
 * is controlled by the feature flags (hasRefund, hasMaturity) set during initializeLoan().
 *
 * IDEMPOTENT: each step is guarded, so re-running is safe.
 *
 * Run: npx hardhat run scripts/register-rwa-types-amoy.ts --network polygon
 */

const DELAY_MS = 2000;
const platformPath = path.join(__dirname, '../deployments/asset-platform-amoy.json');

function readJson(p: string): any {
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {};
}

function saveAddress(key: string, value: string) {
  const all = readJson(platformPath);
  all[key] = value;
  fs.writeFileSync(platformPath, JSON.stringify(all, null, 2));
}

async function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getGasPrice() {
  const feeData = await ethers.provider.getFeeData();
  return feeData.gasPrice?.mul(150).div(100) || ethers.utils.parseUnits('35', 'gwei');
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const platform = readJson(platformPath);

  if (!platform.AssetFactory) {
    throw new Error('AssetFactory not found. Run deploy-asset-platform-amoy.ts first.');
  }

  const gasPrice = await getGasPrice();
  console.log('Deployer:', deployer.address);
  console.log('Gas price:', ethers.utils.formatUnits(gasPrice, 'gwei'), 'gwei');

  const assetFactory = await ethers.getContractAt('AssetFactory', platform.AssetFactory);
  const PRIVATE_CREDIT = ethers.utils.formatBytes32String('PRIVATE_CREDIT');
  const BOND = ethers.utils.formatBytes32String('BOND');

  // ===========================================================================
  // Step 1: Deploy RWALifecycleModule implementation (if not done)
  // ===========================================================================
  let lifecycleImplAddress = platform.RWALifecycleModuleImpl;

  if (!lifecycleImplAddress) {
    console.log('\n1. Deploying RWALifecycleModule implementation...');
    const impl = await ethers.deployContract('RWALifecycleModule', [], { gasPrice });
    await impl.deployed();
    lifecycleImplAddress = impl.address;
    saveAddress('RWALifecycleModuleImpl', lifecycleImplAddress);
    console.log('  ✓ Impl deployed at:', lifecycleImplAddress);
    await delay(DELAY_MS);
  } else {
    console.log('\n1. ✓ RWALifecycleModule impl already at:', lifecycleImplAddress);
  }

  // ===========================================================================
  // Step 2: Deploy ModuleProxy wrapping the implementation (if not done)
  //         This is the PERMANENT address — never changes on upgrades.
  // ===========================================================================
  let lifecycleProxyAddress = platform.RWALifecycleModule;

  if (!lifecycleProxyAddress) {
    console.log('\n2. Deploying RWALifecycleModule proxy (UUPS)...');
    const impl = await ethers.getContractAt('RWALifecycleModule', lifecycleImplAddress);
    const initData = impl.interface.encodeFunctionData('initialize', []);
    const proxy = await ethers.deployContract('ModuleProxy', [lifecycleImplAddress, initData], { gasPrice });
    await proxy.deployed();
    lifecycleProxyAddress = proxy.address;
    saveAddress('RWALifecycleModule', lifecycleProxyAddress);
    console.log('  ✓ Proxy deployed at:', lifecycleProxyAddress);
    await delay(DELAY_MS);
  } else {
    console.log('\n2. ✓ RWALifecycleModule proxy already at:', lifecycleProxyAddress);
  }

  // ===========================================================================
  // Step 3: Deploy SupplyLimitModule implementation (if not done)
  // ===========================================================================
  let supplyLimitImplAddress = platform.SupplyLimitModuleImpl;

  if (!supplyLimitImplAddress) {
    console.log('\n3. Deploying SupplyLimitModule implementation...');
    const impl = await ethers.deployContract('SupplyLimitModule', [], { gasPrice });
    await impl.deployed();
    supplyLimitImplAddress = impl.address;
    saveAddress('SupplyLimitModuleImpl', supplyLimitImplAddress);
    console.log('  ✓ SupplyLimitModule impl deployed at:', supplyLimitImplAddress);
    await delay(DELAY_MS);
  } else {
    console.log('\n3. ✓ SupplyLimitModule impl already at:', supplyLimitImplAddress);
  }

  // ===========================================================================
  // Step 4: Deploy SupplyLimitModule proxy (if not done)
  // ===========================================================================
  let supplyLimitProxyAddress = platform.SupplyLimitModuleProxy;

  if (!supplyLimitProxyAddress) {
    console.log('\n4. Deploying SupplyLimitModule proxy (UUPS)...');
    const supplyImpl = await ethers.getContractAt('SupplyLimitModule', supplyLimitImplAddress);
    const initData = supplyImpl.interface.encodeFunctionData('initialize', []);
    const proxy = await ethers.deployContract('ModuleProxy', [supplyLimitImplAddress, initData], { gasPrice });
    await proxy.deployed();
    supplyLimitProxyAddress = proxy.address;
    saveAddress('SupplyLimitModuleProxy', supplyLimitProxyAddress);
    console.log('  ✓ SupplyLimitModule proxy deployed at:', supplyLimitProxyAddress);
    await delay(DELAY_MS);
  } else {
    console.log('\n4. ✓ SupplyLimitModule proxy already at:', supplyLimitProxyAddress);
  }

  // ===========================================================================
  // Step 5: Register PRIVATE_CREDIT asset type
  //         Modules: [RWALifecycleModule, SupplyLimitModule]
  // ===========================================================================
  if (!platform.RWAPrivateCreditTypeRegistered) {
    console.log('\n5. Registering PRIVATE_CREDIT asset type...');
    const tx = await assetFactory
      .connect(deployer)
      .registerAssetType(PRIVATE_CREDIT, [lifecycleProxyAddress, supplyLimitProxyAddress], { gasPrice });
    await tx.wait();
    saveAddress('RWAPrivateCreditTypeRegistered', 'true');
    console.log('  ✓ PRIVATE_CREDIT registered with RWALifecycleModule + SupplyLimitModule.');
    await delay(DELAY_MS);
  } else {
    console.log('\n5. ✓ PRIVATE_CREDIT already registered.');
  }

  // ===========================================================================
  // Step 6: Register BOND asset type
  //         Same modules — feature flags differentiate behaviour at runtime.
  // ===========================================================================
  if (!platform.RWABondTypeRegistered) {
    console.log('\n6. Registering BOND asset type...');
    const tx = await assetFactory
      .connect(deployer)
      .registerAssetType(BOND, [lifecycleProxyAddress, supplyLimitProxyAddress], { gasPrice });
    await tx.wait();
    saveAddress('RWABondTypeRegistered', 'true');
    console.log('  ✓ BOND registered with RWALifecycleModule + SupplyLimitModule.');
    await delay(DELAY_MS);
  } else {
    console.log('\n6. ✓ BOND already registered.');
  }

  // ===========================================================================
  // Summary
  // ===========================================================================
  console.log('\n=============================================================');
  console.log('✅ SETUP COMPLETE');
  console.log('=============================================================');
  console.log('RWALifecycleModule (impl):  ', lifecycleImplAddress);
  console.log('RWALifecycleModule (proxy): ', lifecycleProxyAddress, '  <-- use this address');
  console.log('SupplyLimitModule (impl):   ', supplyLimitImplAddress);
  console.log('SupplyLimitModule (proxy):  ', supplyLimitProxyAddress, '  <-- use this address');
  console.log('');
  console.log('Asset types registered:');
  console.log('  "PRIVATE_CREDIT"  →  both modules applied automatically on createAsset()');
  console.log('  "BOND"            →  both modules applied automatically on createAsset()');
  console.log('');
  console.log('Next steps:');
  console.log('  Private Credit: npx hardhat run scripts/create-private-credit-asset-amoy.ts --network polygon');
  console.log('  Bond:           npx hardhat run scripts/create-bond-asset-amoy.ts --network polygon');
  console.log('=============================================================');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
