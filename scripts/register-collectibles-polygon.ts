import { ethers } from 'hardhat';
import * as fs from 'fs';
import * as path from 'path';

/**
 * ONE-TIME SETUP SCRIPT for Collectibles.
 * 
 * This script only deploys the CustodianAttestationModule and CollectibleLockPeriodModule,
 * and registers the "COLLECTIBLES" asset type with the global AssetFactory. 
 * 
 * Run this once. After this, your backend team takes over to dynamically create 
 * individual collectibles whenever a user submits a form on the frontend.
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
  const COLLECTIBLES = ethers.utils.formatBytes32String('COLLECTIBLES');

  let custodianAddress = platform.CustodianAttestationModule;
  let lockPeriodAddress = platform.CollectibleLockPeriodModule;

  if (!custodianAddress) {
    console.log('\n1. Deploying CustodianAttestationModule...');
    const CustodianFactory = await ethers.getContractFactory('CustodianAttestationModule');
    const custodian = await CustodianFactory.deploy({ gasPrice });
    await custodian.deployed();
    custodianAddress = custodian.address;
    savePlatformAddress('CustodianAttestationModule', custodianAddress);
    console.log('  ✓ Deployed at:', custodianAddress);
  } else {
    console.log('\n✓ CustodianAttestationModule is already deployed at:', custodianAddress);
  }

  if (!lockPeriodAddress) {
    console.log('\n2. Deploying CollectibleLockPeriodModule...');
    const LockFactory = await ethers.getContractFactory('CollectibleLockPeriodModule');
    const lockPeriod = await LockFactory.deploy({ gasPrice });
    await lockPeriod.deployed();
    lockPeriodAddress = lockPeriod.address;
    savePlatformAddress('CollectibleLockPeriodModule', lockPeriodAddress);
    console.log('  ✓ Deployed at:', lockPeriodAddress);
  } else {
    console.log('\n✓ CollectibleLockPeriodModule is already deployed at:', lockPeriodAddress);
  }

  const isRegistered = platform.CollectiblesAssetTypeRegistered;
  if (!isRegistered) {
    console.log('\n3. Registering COLLECTIBLES asset type on the Factory...');
    const tx = await assetFactory.connect(deployer).registerAssetType(
      COLLECTIBLES, 
      [custodianAddress, lockPeriodAddress], 
      { gasPrice }
    );
    await tx.wait();
    savePlatformAddress('CollectiblesAssetTypeRegistered', 'true');
    console.log('  ✓ Successfully bound both modules to "COLLECTIBLES".');
  } else {
    console.log('\n✓ COLLECTIBLES asset type is already registered.');
  }

  console.log('\n=============================================================');
  console.log('🚀 SETUP COMPLETE!');
  console.log('You must provide the following to your BACKEND team:');
  console.log('1. AssetFactory Address:      ', platform.AssetFactory);
  console.log('2. Custodian Module Address:  ', custodianAddress);
  console.log('3. Lock Period Module Address:', lockPeriodAddress);
  console.log('4. Asset Type String:          "COLLECTIBLES"');
  console.log('\nWhen a user submits a form, the backend will use the Factory');
  console.log('to create the asset, and the modules to initialize the rules.');
  console.log('=============================================================');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});