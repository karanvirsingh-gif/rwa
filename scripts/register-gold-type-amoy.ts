import { ethers } from 'hardhat';
import * as fs from 'fs';
import * as path from 'path';

/**
 * ONE-TIME SETUP SCRIPT for Gold.
 * 
 * This script registers the "GOLD" asset type with the global AssetFactory,
 * binding both the PhysicalReserveModule and the SupplyLimitModule.
 * 
 * Run: npx hardhat run scripts/register-gold-type-amoy.ts --network polygon
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
  const GOLD = ethers.utils.formatBytes32String('GOLD');

  let physicalReserveModuleAddress = platform.PhysicalReserveModule;
  let supplyLimitModuleAddress = platform.SupplyLimitModule;

  if (!physicalReserveModuleAddress) {
    console.log('\n1. Deploying PhysicalReserveModule...');
    const PhysicalReserveModule = await ethers.getContractFactory('PhysicalReserveModule');
    const physicalReserveModule = await PhysicalReserveModule.deploy({ gasPrice });
    await physicalReserveModule.deployed();
    physicalReserveModuleAddress = physicalReserveModule.address;
    savePlatformAddress('PhysicalReserveModule', physicalReserveModuleAddress);
    console.log('  ✓ Deployed at:', physicalReserveModuleAddress);
  } else {
    console.log('\n✓ PhysicalReserveModule is already deployed at:', physicalReserveModuleAddress);
  }

  if (!supplyLimitModuleAddress) {
    console.log('\n2. Deploying SupplyLimitModule...');
    const SupplyLimitModule = await ethers.getContractFactory('SupplyLimitModule');
    const supplyLimitModule = await SupplyLimitModule.deploy({ gasPrice });
    await supplyLimitModule.deployed();
    if (supplyLimitModule.initialize) {
        await (await supplyLimitModule.initialize()).wait();
    }
    supplyLimitModuleAddress = supplyLimitModule.address;
    savePlatformAddress('SupplyLimitModule', supplyLimitModuleAddress);
    console.log('  ✓ Deployed at:', supplyLimitModuleAddress);
  } else {
    console.log('\n✓ SupplyLimitModule is already deployed at:', supplyLimitModuleAddress);
  }

  console.log('\n3. Registering GOLD asset type on the Factory...');
  const tx = await assetFactory.connect(deployer).registerAssetType(
    GOLD, 
    [physicalReserveModuleAddress, supplyLimitModuleAddress], 
    { gasPrice }
  );
  await tx.wait();
  savePlatformAddress('GoldAssetTypeRegisteredWithSupplyLimit', 'true');
  console.log('  ✓ Successfully bound PhysicalReserve and SupplyLimit modules to "GOLD".');

  console.log('\n=============================================================');
  console.log('🚀 SETUP COMPLETE!');
  console.log('You must provide the following to your BACKEND team:');
  console.log('1. AssetFactory Address:        ', platform.AssetFactory);
  console.log('2. PhysicalReserve Module:      ', physicalReserveModuleAddress);
  console.log('3. SupplyLimit Module:          ', supplyLimitModuleAddress);
  console.log('4. Asset Type String:            "GOLD"');
  console.log('\nWhen a user submits a form, the backend will use the Factory');
  console.log('to create the asset with these modules attached.');
  console.log('=============================================================');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
