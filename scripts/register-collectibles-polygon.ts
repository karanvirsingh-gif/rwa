import { ethers } from 'hardhat';
import * as fs from 'fs';
import * as path from 'path';

/**
 * ONE-TIME SETUP SCRIPT for Collectibles.
 *
 * Deploys CustodianAttestationModule and SupplyLimitModule as UUPS upgradeable
 * proxies (implementation → ModuleProxy), then registers the "COLLECTIBLES"
 * asset type on the global AssetFactory using the PROXY addresses.
 *
 * Using proxies means the compliance logic can be upgraded in the future without
 * re-registering the asset type or touching any existing token's compliance binding.
 *
 * IDEMPOTENT: each step is guarded by a JSON key — safe to re-run.
 *
 * Run: npx hardhat run scripts/register-collectibles-polygon.ts --network polygon
 */

const DELAY_MS = 2000;
const platformPath = path.join(__dirname, '../deployments/asset-platform-amoy.json');

function readJson(p: string): any {
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {};
}

function savePlatformAddress(key: string, value: string) {
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
    throw new Error('Run deploy-asset-platform-amoy.ts first. AssetFactory not found.');
  }

  const gasPrice = await getGasPrice();
  console.log('Deployer:', deployer.address);
  console.log('Connecting to AssetFactory at:', platform.AssetFactory);

  const assetFactory = await ethers.getContractAt('AssetFactory', platform.AssetFactory);
  const COLLECTIBLES = ethers.utils.formatBytes32String('COLLECTIBLES');

  // ===========================================================================
  // Step 1: CustodianAttestationModule — implementation
  // ===========================================================================
  let custodianImplAddress = platform.CustodianAttestationModuleImpl;

  if (!custodianImplAddress) {
    console.log('\n1. Deploying CustodianAttestationModule implementation...');
    const impl = await ethers.deployContract('CustodianAttestationModule', [], { gasPrice });
    await impl.deployed();
    custodianImplAddress = impl.address;
    savePlatformAddress('CustodianAttestationModuleImpl', custodianImplAddress);
    console.log('  ✓ Impl deployed at:', custodianImplAddress);
    await delay(DELAY_MS);
  } else {
    console.log('\n1. ✓ CustodianAttestationModule impl already at:', custodianImplAddress);
  }

  // ===========================================================================
  // Step 2: CustodianAttestationModule — UUPS proxy (permanent address)
  // ===========================================================================
  let custodianProxyAddress = platform.CustodianAttestationModule;

  if (!custodianProxyAddress) {
    console.log('\n2. Deploying CustodianAttestationModule proxy (UUPS)...');
    const impl = await ethers.getContractAt('CustodianAttestationModule', custodianImplAddress);
    const initData = impl.interface.encodeFunctionData('initialize', []);
    const proxy = await ethers.deployContract('ModuleProxy', [custodianImplAddress, initData], { gasPrice });
    await proxy.deployed();
    custodianProxyAddress = proxy.address;
    savePlatformAddress('CustodianAttestationModule', custodianProxyAddress);
    console.log('  ✓ Proxy deployed at:', custodianProxyAddress);
    await delay(DELAY_MS);
  } else {
    console.log('\n2. ✓ CustodianAttestationModule proxy already at:', custodianProxyAddress);
  }

  // ===========================================================================
  // Step 3: SupplyLimitModule — implementation
  // ===========================================================================
  let supplyLimitImplAddress = platform.SupplyLimitModuleImpl;

  if (!supplyLimitImplAddress) {
    console.log('\n3. Deploying SupplyLimitModule implementation...');
    const impl = await ethers.deployContract('SupplyLimitModule', [], { gasPrice });
    await impl.deployed();
    supplyLimitImplAddress = impl.address;
    savePlatformAddress('SupplyLimitModuleImpl', supplyLimitImplAddress);
    console.log('  ✓ Impl deployed at:', supplyLimitImplAddress);
    await delay(DELAY_MS);
  } else {
    console.log('\n3. ✓ SupplyLimitModule impl already at:', supplyLimitImplAddress);
  }

  // ===========================================================================
  // Step 4: SupplyLimitModule — UUPS proxy (permanent address)
  // ===========================================================================
  let supplyLimitProxyAddress = platform.SupplyLimitModuleProxy;

  if (!supplyLimitProxyAddress) {
    console.log('\n4. Deploying SupplyLimitModule proxy (UUPS)...');
    const supplyImpl = await ethers.getContractAt('SupplyLimitModule', supplyLimitImplAddress);
    const initData = supplyImpl.interface.encodeFunctionData('initialize', []);
    const proxy = await ethers.deployContract('ModuleProxy', [supplyLimitImplAddress, initData], { gasPrice });
    await proxy.deployed();
    supplyLimitProxyAddress = proxy.address;
    savePlatformAddress('SupplyLimitModuleProxy', supplyLimitProxyAddress);
    console.log('  ✓ Proxy deployed at:', supplyLimitProxyAddress);
    await delay(DELAY_MS);
  } else {
    console.log('\n4. ✓ SupplyLimitModule proxy already at:', supplyLimitProxyAddress);
  }

  // ===========================================================================
  // Step 5: Register COLLECTIBLES asset type using PROXY addresses
  // ===========================================================================
  if (!platform.CollectiblesAssetTypeRegistered) {
    console.log('\n5. Registering COLLECTIBLES asset type on the Factory...');
    const tx = await assetFactory
      .connect(deployer)
      .registerAssetType(COLLECTIBLES, [custodianProxyAddress, supplyLimitProxyAddress], { gasPrice });
    await tx.wait();
    savePlatformAddress('CollectiblesAssetTypeRegistered', 'true');
    console.log('  ✓ Successfully bound CustodianAttestationModule + SupplyLimitModule (proxies) to "COLLECTIBLES".');
    await delay(DELAY_MS);
  } else {
    console.log('\n5. ✓ COLLECTIBLES asset type is already registered.');
  }

  console.log('\n=============================================================');
  console.log('🚀 SETUP COMPLETE!');
  console.log('You must provide the following to your BACKEND team:');
  console.log('1. AssetFactory Address:               ', platform.AssetFactory);
  console.log('2. CustodianAttestationModule (proxy): ', custodianProxyAddress, '  <-- use this');
  console.log('3. SupplyLimitModule (proxy):           ', supplyLimitProxyAddress, '  <-- use this');
  console.log('4. Asset Type String:                   "COLLECTIBLES"');
  console.log('\nBoth modules are upgradeable. To upgrade:');
  console.log('  proxy.upgradeTo(newImplementation)  — proxy address never changes.');
  console.log('=============================================================');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});