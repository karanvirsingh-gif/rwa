import { ethers } from 'hardhat';
import * as fs from 'fs';
import * as path from 'path';

/**
 * ONE-TIME SETUP SCRIPT for Real Estate.
 * 
 * This script deploys modules (if missing) and registers the 
 * "REAL_ESTATE" asset type with the global AssetFactory. 
 * 
 * Run: npx hardhat run scripts/register-real-estate-type-amoy.ts --network polygon
 */

const platformPath = path.join(__dirname, '../deployments/asset-platform-amoy.json');

function readJson(p: string): any {
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {};
}

function savePlatformAddress(key: string, value: string) {
  const all = readJson(platformPath);
  all[key] = value;
  fs.writeFileSync(platformPath, JSON.stringify(all, null, 2));
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
  const REAL_ESTATE = ethers.utils.formatBytes32String('REAL_ESTATE');

  let supplyLimitModuleAddress = platform.SupplyLimitModule;

  if (!supplyLimitModuleAddress) {
    console.log('\n2. Deploying SupplyLimitModule...');
    const SupplyLimitModule = await ethers.getContractFactory('SupplyLimitModule');
    const supplyLimitModule = await SupplyLimitModule.deploy({ gasPrice });
    await supplyLimitModule.deployed();
    await (await supplyLimitModule.initialize()).wait();
    supplyLimitModuleAddress = supplyLimitModule.address;
    savePlatformAddress('SupplyLimitModule', supplyLimitModuleAddress);
    console.log('  ✓ Deployed at:', supplyLimitModuleAddress);
  } else {
    console.log('\n✓ SupplyLimitModule is already deployed at:', supplyLimitModuleAddress);
  }

  if (!platform.RealEstateAssetTypeRegistered) {
    console.log('\n3. Registering REAL_ESTATE asset type on the Factory...');
    const tx = await assetFactory.connect(deployer).registerAssetType(REAL_ESTATE, [supplyLimitModuleAddress], { gasPrice });
    await tx.wait();
    savePlatformAddress('RealEstateAssetTypeRegistered', 'true');
    console.log('  ✓ Successfully bound SupplyLimitModule to "REAL_ESTATE".');
  } else {
    console.log('✓ REAL_ESTATE asset type is already registered.');
  }

  console.log('\n=============================================================');
  console.log('🚀 SETUP COMPLETE!');
  console.log('You must provide the following to your BACKEND team:');
  console.log('1. AssetFactory Address:      ', platform.AssetFactory);
  console.log('2. SupplyLimitModule Address: ', supplyLimitModuleAddress);
  console.log('3. Asset Type String:          "REAL_ESTATE"');
  console.log('\nWhen a user submits a form, the backend will use the Factory');
  console.log('to create the asset with these modules attached.');
  console.log('=============================================================');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
