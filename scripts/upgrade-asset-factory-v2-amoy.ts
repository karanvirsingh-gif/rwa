import { ethers } from 'hardhat';
import * as fs from 'fs';
import * as path from 'path';

/**
 * ONE-TIME UPGRADE: AssetFactory V1 → V2
 *
 * What this does:
 *   1. Compiles + deploys a fresh AssetFactoryImpl (new logic, new address).
 *   2. Calls upgradeToAndCall() on the LIVE proxy, atomically:
 *        a. Points the proxy at the new implementation.
 *        b. Calls initializeV2(_supplyLimitModule) in the same tx so the
 *           supplyLimitModule storage slot is set before any createAsset() call.
 *
 * What does NOT change:
 *   - AssetFactory proxy address (the one your backend/frontend already use).
 *   - All other platform addresses (registry, vault/treasury/distributor impls, etc.).
 *   - All existing assets — they were already created and are fully independent.
 *
 * Pre-requisites:
 *   - deploy-asset-platform-amoy.ts must have run (AssetFactory proxy exists).
 *   - SupplyLimitModule must be deployed (it is — it's in asset-platform-amoy.json).
 *   - The caller must hold UPGRADER_ROLE on the AssetFactory proxy.
 *
 * Run: npx hardhat run scripts/upgrade-asset-factory-v2-amoy.ts --network polygon
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

  // ── Pre-flight checks ──────────────────────────────────────────────────────
  if (!platform.AssetFactory) {
    throw new Error('AssetFactory proxy not found. Run deploy-asset-platform-amoy.ts first.');
  }
  if (!platform.SupplyLimitModule) {
    throw new Error(
      'SupplyLimitModule not found in asset-platform-amoy.json.\n' +
      'Run register-real-estate-type-amoy.ts or register-private-credit-type-amoy.ts first.',
    );
  }
  if (platform.AssetFactoryV2Upgraded) {
    console.log('✓ AssetFactory is already on V2. Nothing to do.');
    console.log('  Proxy:              ', platform.AssetFactory);
    console.log('  Implementation V2:  ', platform.AssetFactoryImplV2);
    console.log('  SupplyLimitModule:  ', platform.SupplyLimitModule);
    return;
  }

  const gasPrice = await getGasPrice();
  console.log('Deployer:          ', deployer.address);
  console.log('AssetFactory proxy:', platform.AssetFactory);
  console.log('SupplyLimitModule: ', platform.SupplyLimitModule);
  console.log('');

  // ── Step 1: Deploy new implementation ────────────────────────────────────
  console.log('1. Deploying AssetFactory V2 implementation...');
  const AssetFactoryFactory = await ethers.getContractFactory('AssetFactory', deployer);
  const newImpl = await AssetFactoryFactory.deploy({ gasPrice });
  await newImpl.deployed();
  savePlatformAddress('AssetFactoryImplV2', newImpl.address);
  console.log('   ✓ New impl deployed at:', newImpl.address);

  // ── Step 2: Encode initializeV2 call ─────────────────────────────────────
  const initV2Data = AssetFactoryFactory.interface.encodeFunctionData('initializeV2', [
    platform.SupplyLimitModule,
  ]);

  // ── Step 3: upgradeToAndCall — atomic: upgrade + initializeV2 in one tx ──
  console.log('2. Upgrading proxy and setting supplyLimitModule atomically...');
  const proxy = await ethers.getContractAt('AssetFactory', platform.AssetFactory, deployer);
  const tx = await proxy.upgradeToAndCall(newImpl.address, initV2Data, { gasPrice });
  const receipt = await tx.wait();
  console.log('   ✓ Upgrade tx confirmed. Gas used:', receipt.gasUsed.toString());

  // ── Step 4: Verify on-chain state ─────────────────────────────────────────
  console.log('3. Verifying on-chain state...');
  const supplyLimitModuleOnChain = await proxy.supplyLimitModule();
  if (supplyLimitModuleOnChain.toLowerCase() !== platform.SupplyLimitModule.toLowerCase()) {
    throw new Error(
      `Mismatch! On-chain supplyLimitModule=${supplyLimitModuleOnChain} ` +
      `but expected ${platform.SupplyLimitModule}`,
    );
  }
  console.log('   ✓ supplyLimitModule on-chain:', supplyLimitModuleOnChain);

  // ── Persist ───────────────────────────────────────────────────────────────
  savePlatformAddress('AssetFactoryV2Upgraded', 'true');

  console.log('');
  console.log('=============================================================');
  console.log('🚀 UPGRADE COMPLETE — AssetFactory is now V2');
  console.log('');
  console.log('Proxy address (unchanged):  ', platform.AssetFactory);
  console.log('New implementation:          ', newImpl.address);
  console.log('SupplyLimitModule wired:     ', supplyLimitModuleOnChain);
  console.log('');
  console.log('What changed for your teams:');
  console.log('  Backend/Frontend: SAME proxy address. Update the ABI.');
  console.log('  createAsset() now requires a "supplyLimit" field (uint256).');
  console.log('  SupplyLimitModule is NO LONGER passed via registerAssetType.');
  console.log('=============================================================');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
