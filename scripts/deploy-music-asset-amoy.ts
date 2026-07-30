import { ethers } from 'hardhat';
import * as fs from 'fs';
import * as path from 'path';

/**
 * ONE-TIME SETUP SCRIPT for Music Assets.
 * 
 * This script registers the "MUSIC" asset type with the global AssetFactory.
 * No extra compliance modules (like CountryRestrict or MaxBalance) are added 
 * by default. The factory will natively attach the YieldDistributor.
 * 
 * Run this once. After this, your backend team takes over to dynamically create 
 * individual songs whenever a catalog is onboarded.
 *
 * Run: npx hardhat run scripts/deploy-music-asset-amoy.ts --network polygonAmoy
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
  const MUSIC = ethers.utils.formatBytes32String('MUSIC');

  if (!platform.MusicAssetTypeRegistered) {
    console.log('\n1. Registering MUSIC asset type on the Factory...');
    const tx = await assetFactory.connect(deployer).registerAssetType(MUSIC, [], { gasPrice });
    await tx.wait();
    savePlatformAddress('MusicAssetTypeRegistered', 'true');  
    console.log('  ✓ Successfully bound compliance modules to "MUSIC".');
  } else {
    console.log('\n✓ MUSIC asset type is already registered.');
  }

  console.log('\n=============================================================');
  console.log('🚀 SETUP COMPLETE!');
  console.log('You must provide the following to your BACKEND team:');
  console.log('1. AssetFactory Address:      ', platform.AssetFactory);
  console.log('2. Asset Type String:          "MUSIC"');
  console.log('\nWhen a new song is onboarded, the backend will use the Factory');
  console.log('to create the asset with the built-in YieldDistributor and modules.');
  console.log('=============================================================');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});