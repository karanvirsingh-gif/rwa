import { ethers } from 'hardhat';
import * as fs from 'fs';
import * as path from 'path';

/**
 * ============================================================================
 * ONE-TIME SETUP SCRIPT for Music Assets
 * ============================================================================
 * 
 * This script registers the "MUSIC" asset type with the global AssetFactory.
 * By default, it attaches the SupplyLimitModule to enforce supply constraints.
 * 
 * This script now uses the UUPS upgradeable Proxy pattern for the SupplyLimitModule.
 * 
 * Run this once. After this, your backend team takes over to dynamically create 
 * individual songs whenever a catalog is onboarded.
 *
 * Usage: 
 *   npx hardhat run scripts/register-music-asset-amoy.ts --network polygon
 * ============================================================================
 */

const PLATFORM_CONFIG_PATH = path.join(__dirname, '../deployments/asset-platform-amoy.json');
const ASSET_TYPE_MUSIC = ethers.utils.formatBytes32String('MUSIC');
const DELAY_MS = 2000;

// --- Utility Functions ---

function loadPlatformConfig(): any {
  if (!fs.existsSync(PLATFORM_CONFIG_PATH)) {
    return {};
  }
  return JSON.parse(fs.readFileSync(PLATFORM_CONFIG_PATH, 'utf8'));
}

function savePlatformConfig(key: string, value: string) {
  const config = loadPlatformConfig();
  config[key] = value;
  fs.writeFileSync(PLATFORM_CONFIG_PATH, JSON.stringify(config, null, 2));
}

async function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Main Execution ---

async function main() {
  const [deployer] = await ethers.getSigners();
  const platformConfig = loadPlatformConfig();

  if (!platformConfig.AssetFactory) {
    throw new Error('Run deploy-asset-platform-amoy.ts first. AssetFactory not found.');
  }

  // We rely on hardhat.config.ts for gas price now, so we don't need manual overrides here.
  
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Connecting to AssetFactory at: ${platformConfig.AssetFactory}`);

  // 1. Setup Contracts
  const assetFactory = await ethers.getContractAt('AssetFactory', platformConfig.AssetFactory);

  // ===========================================================================
  // Step 2: SupplyLimitModule — implementation
  // ===========================================================================
  let supplyLimitImplAddress = platformConfig.SupplyLimitModuleImpl;

  if (!supplyLimitImplAddress) {
    console.log('\nDeploying SupplyLimitModule implementation...');
    const impl = await ethers.deployContract('SupplyLimitModule', []);
    await impl.deployed();
    supplyLimitImplAddress = impl.address;
    savePlatformConfig('SupplyLimitModuleImpl', supplyLimitImplAddress);
    console.log(`  ✓ Impl deployed at: ${supplyLimitImplAddress}`);
    await delay(DELAY_MS);
  } else {
    console.log(`\n✓ SupplyLimitModule impl already at: ${supplyLimitImplAddress}`);
  }

  // ===========================================================================
  // Step 3: SupplyLimitModule — UUPS proxy (permanent address)
  // ===========================================================================
  let supplyLimitProxyAddress = platformConfig.SupplyLimitModuleProxy;

  if (!supplyLimitProxyAddress) {
    console.log('\nDeploying SupplyLimitModule proxy (UUPS)...');
    const supplyImpl = await ethers.getContractAt('SupplyLimitModule', supplyLimitImplAddress);
    const initData = supplyImpl.interface.encodeFunctionData('initialize', []);
    const proxy = await ethers.deployContract('ModuleProxy', [supplyLimitImplAddress, initData]);
    await proxy.deployed();
    supplyLimitProxyAddress = proxy.address;
    savePlatformConfig('SupplyLimitModuleProxy', supplyLimitProxyAddress);
    console.log(`  ✓ Proxy deployed at: ${supplyLimitProxyAddress}`);
    await delay(DELAY_MS);
  } else {
    console.log(`\n✓ SupplyLimitModule proxy already at: ${supplyLimitProxyAddress}`);
  }

  // ===========================================================================
  // Step 4: Register MUSIC asset type using PROXY addresses
  // ===========================================================================
  const isAlreadyRegistered = platformConfig.MusicAssetTypeRegistered;

  if (isAlreadyRegistered) {
    console.log('\n✓ MUSIC asset type is already registered.');
  } else {
    console.log('\nRegistering MUSIC asset type on the Factory...');
    const tx = await assetFactory
      .connect(deployer)
      .registerAssetType(ASSET_TYPE_MUSIC, [supplyLimitProxyAddress]);
    await tx.wait();
    
    savePlatformConfig('MusicAssetTypeRegistered', 'true');  
    console.log('  ✓ Successfully bound SupplyLimitModule (proxy) to "MUSIC".');
  }

  // 5. Print Summary
  console.log('\n=============================================================');
  console.log('🚀 SETUP COMPLETE!');
  console.log('You must provide the following to your BACKEND team:');
  console.log(`1. AssetFactory Address:      ${platformConfig.AssetFactory}`);
  console.log(`2. Asset Type String:          "MUSIC"`);
  console.log(`3. SupplyLimitModule (proxy): ${supplyLimitProxyAddress}   <-- use this`);
  console.log('\nWhen a new song is onboarded, the backend will use the Factory');
  console.log('to create the asset with the built-in YieldDistributor and modules.');
  console.log('=============================================================');
}

main().catch((error) => {
  console.error('Deployment failed:', error);
  process.exitCode = 1;
});