import { ethers } from 'hardhat';
import * as fs from 'fs';
import * as path from 'path';

/**
 * ============================================================================
 * ONE-TIME SETUP SCRIPT for Gold Assets
 * ============================================================================
 *
 * This script registers (or re-registers) the "GOLD" asset type with the
 * global AssetFactory, binding it to two compliance modules:
 *
 *   1. PhysicalReserveModule  — UUPS upgradeable proxy. Guards minting against
 *                               custodian-attested supply. initialize(admin) is
 *                               called via proxy initData at deploy time.
 *
 *   2. SupplyLimitModule      — UUPS upgradeable proxy. Caps the maximum number
 *                               of tokens that can ever be minted per asset.
 *
 * Both module proxy addresses are read from / written to asset-platform-amoy.json
 * so the script is fully idempotent on re-runs.
 *
 * Run: npx hardhat run scripts/register-gold-amoy.ts --network polygon
 * ============================================================================
 */

const platformPath = path.join(__dirname, '../deployments/asset-platform-amoy.json');
const DELAY_MS = 2000;

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

async function main() {
  const [deployer] = await ethers.getSigners();
  const platform = readJson(platformPath);

  if (!platform.AssetFactory) {
    throw new Error('AssetFactory not found. Run deploy-asset-platform-amoy.ts first.');
  }

  console.log('Deployer:', deployer.address);
  console.log('Connecting to AssetFactory at:', platform.AssetFactory);

  const assetFactory = await ethers.getContractAt('AssetFactory', platform.AssetFactory);
  const GOLD = ethers.utils.formatBytes32String('GOLD');

  // ===========================================================================
  // Step 1: PhysicalReserveModule — implementation (UUPS)
  // ===========================================================================
  let physicalReserveImplAddress = platform.PhysicalReserveModuleImpl;

  if (!physicalReserveImplAddress) {
    console.log('\n1. Deploying PhysicalReserveModule implementation...');
    const impl = await ethers.deployContract('PhysicalReserveModule', []);
    await impl.deployed();
    physicalReserveImplAddress = impl.address;
    savePlatformAddress('PhysicalReserveModuleImpl', physicalReserveImplAddress);
    console.log(`  ✓ Impl deployed at: ${physicalReserveImplAddress}`);
    await delay(DELAY_MS);
  } else {
    console.log(`\n1. ✓ PhysicalReserveModule impl already at: ${physicalReserveImplAddress}`);
  }

  // ===========================================================================
  // Step 2: PhysicalReserveModule — UUPS proxy (permanent address)
  // ===========================================================================
  let physicalReserveProxyAddress = platform.PhysicalReserveModuleProxy;

  if (!physicalReserveProxyAddress) {
    console.log('\n2. Deploying PhysicalReserveModule proxy (UUPS)...');
    const reserveImpl = await ethers.getContractAt('PhysicalReserveModule', physicalReserveImplAddress);
    // initialize(admin) grants DEFAULT_ADMIN_ROLE + RESERVE_MANAGER_ROLE to deployer
    const initData = reserveImpl.interface.encodeFunctionData('initialize', [deployer.address]);
    const proxy = await ethers.deployContract('ModuleProxy', [physicalReserveImplAddress, initData]);
    await proxy.deployed();
    physicalReserveProxyAddress = proxy.address;
    savePlatformAddress('PhysicalReserveModuleProxy', physicalReserveProxyAddress);
    console.log(`  ✓ Proxy deployed at: ${physicalReserveProxyAddress}`);
    await delay(DELAY_MS);
  } else {
    console.log(`\n2. ✓ PhysicalReserveModule proxy already at: ${physicalReserveProxyAddress}`);
  }

  // ===========================================================================
  // Step 3: SupplyLimitModule — implementation (UUPS)
  // ===========================================================================
  let supplyLimitImplAddress = platform.SupplyLimitModuleImpl;

  if (!supplyLimitImplAddress) {
    console.log('\n3. Deploying SupplyLimitModule implementation...');
    const impl = await ethers.deployContract('SupplyLimitModule', []);
    await impl.deployed();
    supplyLimitImplAddress = impl.address;
    savePlatformAddress('SupplyLimitModuleImpl', supplyLimitImplAddress);
    console.log(`  ✓ Impl deployed at: ${supplyLimitImplAddress}`);
    await delay(DELAY_MS);
  } else {
    console.log(`\n3. ✓ SupplyLimitModule impl already at: ${supplyLimitImplAddress}`);
  }

  // ===========================================================================
  // Step 4: SupplyLimitModule — UUPS proxy (permanent address)
  // ===========================================================================
  let supplyLimitProxyAddress = platform.SupplyLimitModuleProxy;

  if (!supplyLimitProxyAddress) {
    console.log('\n4. Deploying SupplyLimitModule proxy (UUPS)...');
    const supplyImpl = await ethers.getContractAt('SupplyLimitModule', supplyLimitImplAddress);
    const initData = supplyImpl.interface.encodeFunctionData('initialize', []);
    const proxy = await ethers.deployContract('ModuleProxy', [supplyLimitImplAddress, initData]);
    await proxy.deployed();
    supplyLimitProxyAddress = proxy.address;
    savePlatformAddress('SupplyLimitModuleProxy', supplyLimitProxyAddress);
    console.log(`  ✓ Proxy deployed at: ${supplyLimitProxyAddress}`);
    await delay(DELAY_MS);
  } else {
    console.log(`\n4. ✓ SupplyLimitModule proxy already at: ${supplyLimitProxyAddress}`);
  }

  // ===========================================================================
  // Step 5: Register GOLD with both proxy modules
  // Uses GoldAssetTypeRegisteredWithProxy flag to differentiate from the old
  // non-proxy registration (GoldAssetTypeRegistered) done by deploy-asset-platform-amoy.ts.
  // registerAssetType overwrites the previous binding for the GOLD type — safe to call.
  // ===========================================================================
  if (!platform.GoldAssetTypeRegisteredWithProxy) {
    console.log('\n5. Registering GOLD asset type with proxy-based modules...');
    const tx = await assetFactory
      .connect(deployer)
      .registerAssetType(GOLD, [physicalReserveProxyAddress, supplyLimitProxyAddress]);
    await tx.wait();
    savePlatformAddress('GoldAssetTypeRegisteredWithProxy', 'true');
    console.log('  ✓ GOLD bound to: PhysicalReserveModuleProxy + SupplyLimitModuleProxy');
    await delay(DELAY_MS);
  } else {
    console.log('\n5. ✓ GOLD asset type already registered with proxy modules.');
  }

  console.log('\n=============================================================');
  console.log('🚀 SETUP COMPLETE!');
  console.log('Provide the following to your BACKEND team:');
  console.log(`1. AssetFactory:                     ${platform.AssetFactory}`);
  console.log(`2. PhysicalReserveModule (proxy):    ${physicalReserveProxyAddress}   <-- use this`);
  console.log(`3. SupplyLimitModule (proxy):        ${supplyLimitProxyAddress}   <-- use this`);
  console.log(`4. Asset Type String:                 "GOLD"`);
  console.log('\nTo upgrade either module:');
  console.log('  proxy.upgradeTo(newImplementation)  — proxy address never changes.');
  console.log('=============================================================');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
