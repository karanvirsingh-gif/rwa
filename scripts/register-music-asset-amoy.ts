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
 * Run this once. After this, your backend team takes over to dynamically create 
 * individual songs whenever a catalog is onboarded.
 *
 * Usage: 
 *   npx hardhat run scripts/register-music-asset-amoy.ts --network polygon
 * ============================================================================
 */

const PLATFORM_CONFIG_PATH = path.join(__dirname, '../deployments/asset-platform-amoy.json');
const ASSET_TYPE_MUSIC = ethers.utils.formatBytes32String('MUSIC');

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

async function getGasPrice() {
  const feeData = await ethers.provider.getFeeData();
  // Add a 50% buffer to current gas price, or default to 35 gwei
  return feeData.gasPrice?.mul(150).div(100) || ethers.utils.parseUnits('35', 'gwei');
}

// --- Core Deployment Logic ---

async function deploySupplyLimitModule(existingAddress: string, gasPrice: any): Promise<string> {
  if (existingAddress) {
    console.log(`\n✓ SupplyLimitModule is already deployed at: ${existingAddress}`);
    return existingAddress;
  }

  console.log('\nDeploying SupplyLimitModule...');
  const SupplyLimitModule = await ethers.getContractFactory('SupplyLimitModule');
  const module = await SupplyLimitModule.deploy({ gasPrice });
  await module.deployed();
  
  console.log(`  ✓ SupplyLimitModule deployed to: ${module.address}`);
  
  const tx = await module.initialize({ gasPrice });
  await tx.wait();
  console.log('  ✓ SupplyLimitModule initialized');
  
  savePlatformConfig('SupplyLimitModule', module.address);
  return module.address;
}

async function registerMusicAssetType(
  assetFactory: any, 
  deployer: any, 
  isAlreadyRegistered: boolean, 
  supplyLimitModuleAddress: string, 
  gasPrice: any
) {
  if (isAlreadyRegistered) {
    console.log('\n✓ MUSIC asset type is already registered.');
    return;
  }

  console.log('\n1. Registering MUSIC asset type on the Factory...');
  const tx = await assetFactory.connect(deployer).registerAssetType(
    ASSET_TYPE_MUSIC, 
    [supplyLimitModuleAddress], 
    { gasPrice }
  );
  await tx.wait();
  
  savePlatformConfig('MusicAssetTypeRegistered', 'true');  
  console.log('  ✓ Successfully bound compliance modules to "MUSIC".');
}

function printSuccessSummary(factoryAddress: string, moduleAddress: string) {
  console.log('\n=============================================================');
  console.log('🚀 SETUP COMPLETE!');
  console.log('You must provide the following to your BACKEND team:');
  console.log(`1. AssetFactory Address:      ${factoryAddress}`);
  console.log(`2. Asset Type String:          "MUSIC"`);
  console.log(`3. SupplyLimitModule:         ${moduleAddress}`);
  console.log('\nWhen a new song is onboarded, the backend will use the Factory');
  console.log('to create the asset with the built-in YieldDistributor and modules.');
  console.log('=============================================================');
}

// --- Main Execution ---

async function main() {
  const [deployer] = await ethers.getSigners();
  const platformConfig = loadPlatformConfig();

  if (!platformConfig.AssetFactory) {
    throw new Error('Run deploy-asset-platform-amoy.ts first. AssetFactory not found.');
  }

  const gasPrice = await getGasPrice();
  
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Connecting to AssetFactory at: ${platformConfig.AssetFactory}`);

  // 1. Setup Contracts
  const assetFactory = await ethers.getContractAt('AssetFactory', platformConfig.AssetFactory);

  // 2. Deploy or Load Dependencies
  const supplyLimitModuleAddress = await deploySupplyLimitModule(
    platformConfig.SupplyLimitModule, 
    gasPrice
  );

  // 3. Register Asset Type
  await registerMusicAssetType(
    assetFactory, 
    deployer, 
    platformConfig.MusicAssetTypeRegistered, 
    supplyLimitModuleAddress, 
    gasPrice
  );

  // 4. Print Summary
  printSuccessSummary(platformConfig.AssetFactory, supplyLimitModuleAddress);
}

main().catch((error) => {
  console.error('Deployment failed:', error);
  process.exitCode = 1;
});