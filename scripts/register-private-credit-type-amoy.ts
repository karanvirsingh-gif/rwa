import { ethers } from 'hardhat';
import * as fs from 'fs';
import * as path from 'path';

/**
 * ONE-TIME SETUP SCRIPT for Private Credit.
 * 
 * This script only deploys the PrivateCreditStateModule and registers the 
 * "PRIVATE_CREDIT" asset type with the global AssetFactory. 
 * 
 * Run this once. After this, your backend team takes over to dynamically create 
 * individual loans whenever a user submits a form on the frontend.
 *
 * Run: npx hardhat run scripts/register-private-credit-type-amoy.ts --network polygon
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
  const PRIVATE_CREDIT = ethers.utils.formatBytes32String('PRIVATE_CREDIT');

  let stateModuleAddress = platform.PrivateCreditStateModule;

  if (!stateModuleAddress) {
    console.log('\n1. Deploying PrivateCreditStateModule...');
    const stateModule = await ethers.deployContract('PrivateCreditStateModule', [], { gasPrice });
    await stateModule.deployed();
    stateModuleAddress = stateModule.address;
    savePlatformAddress('PrivateCreditStateModule', stateModuleAddress);
    console.log('  ✓ Deployed at:', stateModuleAddress);

    console.log('\n2. Registering PRIVATE_CREDIT asset type on the Factory...');
    const tx = await assetFactory.connect(deployer).registerAssetType(PRIVATE_CREDIT, [stateModuleAddress], { gasPrice });
    await tx.wait();
    savePlatformAddress('PrivateCreditAssetTypeRegistered', 'true');
    console.log('  ✓ Successfully bound PrivateCreditStateModule to "PRIVATE_CREDIT".');
  } else {
    console.log('\n✓ PrivateCreditStateModule is already deployed at:', stateModuleAddress);
    console.log('✓ PRIVATE_CREDIT asset type is already registered.');
  }

  console.log('\n=============================================================');
  console.log('🚀 SETUP COMPLETE!');
  console.log('You must provide the following to your BACKEND team:');
  console.log('1. AssetFactory Address:      ', platform.AssetFactory);
  console.log('2. StateModule Address:       ', stateModuleAddress);
  console.log('3. Asset Type String:          "PRIVATE_CREDIT"');
  console.log('\nWhen a borrower submits a form, the backend will use the Factory');
  console.log('to create the asset, and the StateModule to initialize the loan.');
  console.log('=============================================================');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
