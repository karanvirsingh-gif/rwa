import { ethers, upgrades } from 'hardhat';
import * as fs from 'fs';
import * as path from 'path';

/**
 * UPGRADE SCRIPT: Deploy updated CollectibleLockPeriodModule
 * 
 * This deploys the NEW Queue-based CollectibleLockPeriodModule as a fresh proxy.
 * It ONLY updates the "CollectibleLockPeriodModule" key in the deployments JSON.
 * Nothing else in the deployments file is touched.
 * 
 * After running this, provide the new address to your backend team so they can
 * use it when creating new Collectibles via the AssetFactory.
 * 
 * NOTE: This does NOT re-register the asset type. Existing deployed Collectibles
 * that already have the old module bound will continue to use the old address
 * until they are individually migrated via their own compliance contract.
 */

const platformPath = path.join(__dirname, '../deployments/asset-platform-amoy.json');

function readJson(p: string): any {
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {};
}

function savePlatformAddress(key: string, value: string) {
  const all = readJson(platformPath);
  all[key] = value;
  fs.writeFileSync(platformPath, JSON.stringify(all, null, 2));
  console.log(`  ✓ Saved "${key}" → ${value} in deployments JSON`);
}

async function getGasPrice() {
  const feeData = await ethers.provider.getFeeData();
  return feeData.gasPrice?.mul(150).div(100) || ethers.utils.parseUnits('35', 'gwei');
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const platform = readJson(platformPath);

  console.log('=============================================================');
  console.log('  CollectibleLockPeriodModule — Deployment Script');
  console.log('=============================================================');
  console.log('Deployer:              ', deployer.address);
  console.log('Deployer Balance:      ', ethers.utils.formatEther(await deployer.getBalance()), 'MATIC');

  if (platform.CollectibleLockPeriodModule) {
    console.log('\n⚠️  WARNING: A previous deployment already exists at:');
    console.log('   Old Address:', platform.CollectibleLockPeriodModule);
    console.log('   This script will deploy a NEW proxy and overwrite that address.\n');
  }


  console.log('\n─── Deploying CollectibleLockPeriodModule as UUPS Proxy... ───');
  const CollectibleLockPeriodModule = await ethers.getContractFactory('CollectibleLockPeriodModule');
  const factoryWithGas = CollectibleLockPeriodModule.connect(deployer);

  const module = await upgrades.deployProxy(factoryWithGas, [], {
    kind: 'uups',
  });

  await module.deployed();

  console.log('  ✓ Proxy deployed at:  ', module.address);
  console.log('  ✓ Module name:         ', await module.name());
  console.log('  ✓ Is plug-and-play:    ', await module.isPlugAndPlay());
  console.log('  ✓ Owner:               ', await module.owner());

  // ─── Save ONLY the CollectibleLockPeriodModule key ──────────────────────
  savePlatformAddress('CollectibleLockPeriodModule', module.address);

  console.log('\n=============================================================');
  console.log('✅ DEPLOYMENT COMPLETE!');
  console.log('=============================================================');
  console.log('New Module Address:', module.address);
  console.log('\nNext steps:');
  console.log('1. Provide this new address to your backend team.');
  console.log('2. The AssetFactory must be updated (via registerAssetType or');
  console.log('   equivalent) to use this new address for future COLLECTIBLES.');
  console.log('3. Existing Collectibles with the OLD module will continue');
  console.log('   to use the old contract until individually migrated.');
  console.log('=============================================================');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
