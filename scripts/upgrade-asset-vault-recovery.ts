import { ethers } from 'hardhat';
import * as fs from 'fs';
import * as path from 'path';

/**
 * UPGRADE: AssetVault + AssetTreasury — recovery support + UUPS upgradeability
 * ------------------------------------------------------------------------------
 * Deploys:
 *   1. New AssetTreasury implementation (now UUPS upgradeable — adds UPGRADER_ROLE
 *      and _authorizeUpgrade()). Storage layout unchanged, additive only.
 *   2. New AssetVault implementation (adds redeemRecovery() for RECOVERY state).
 *
 * Then calls AssetFactory.setImplementations() ONCE with BOTH new impls so all
 * future assets get both upgrades atomically.
 *
 * Existing per-asset treasury and vault proxies are NOT upgraded (by design).
 *
 * Run: npx hardhat run scripts/upgrade-asset-vault-recovery.ts --network polygon
 *
 * NOTE: Run upgrade-rwa-lifecycle-recovery.ts first — this script does NOT touch
 *       the RWALifecycleModule proxy.
 */

const DELAY_MS = 2000;
const platformPath = path.join(__dirname, '../deployments/asset-platform-amoy.json');

function readJson(p: string): any {
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {};
}

function saveAddress(key: string, value: string) {
  const all = readJson(platformPath);
  all[key] = value;
  fs.writeFileSync(platformPath, JSON.stringify(all, null, 2));
}

async function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getGasPrice() {
  const feeData = await ethers.provider.getFeeData();
  return feeData.gasPrice?.mul(150).div(100) || ethers.utils.parseUnits('35', 'gwei');
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const platform = readJson(platformPath);

  const ASSET_FACTORY = platform.AssetFactory;
  if (!ASSET_FACTORY) {
    throw new Error('AssetFactory not found in asset-platform-amoy.json');
  }
  if (!platform.YieldDistributorImpl) {
    throw new Error('YieldDistributorImpl not found in asset-platform-amoy.json');
  }

  const gasPrice = await getGasPrice();
  console.log('Deployer:            ', deployer.address);
  console.log('Gas price:           ', ethers.utils.formatUnits(gasPrice, 'gwei'), 'gwei');
  console.log('AssetFactory:        ', ASSET_FACTORY);
  console.log('Old AssetTreasuryImpl:', platform.AssetTreasuryImpl);
  console.log('Old AssetVaultImpl:  ', platform.AssetVaultImpl);
  console.log('');

  // ===========================================================================
  // Step 1: Archive old impl addresses for audit trail
  // ===========================================================================
  if (platform.AssetTreasuryImpl && !platform.AssetTreasuryImplV1) {
    saveAddress('AssetTreasuryImplV1', platform.AssetTreasuryImpl);
    console.log('✓ Archived old treasury impl as AssetTreasuryImplV1:', platform.AssetTreasuryImpl);
  }
  if (platform.AssetVaultImpl && !platform.AssetVaultImplV1) {
    saveAddress('AssetVaultImplV1', platform.AssetVaultImpl);
    console.log('✓ Archived old vault impl as AssetVaultImplV1:', platform.AssetVaultImpl);
  }

  // ===========================================================================
  // Step 2: Deploy new AssetTreasury implementation (UUPS upgradeable)
  // ===========================================================================
  console.log('\nStep 2: Deploying new AssetTreasury implementation (UUPS upgradeable)...');
  const TreasuryFactory = await ethers.getContractFactory('AssetTreasury', deployer);
  const newTreasuryImpl = await TreasuryFactory.deploy({ gasPrice });
  await newTreasuryImpl.deployed();
  console.log('  ✓ New AssetTreasuryImpl deployed at:', newTreasuryImpl.address);

  // Sanity: verify UPGRADER_ROLE is in the ABI
  const hasUpgraderRole = newTreasuryImpl.interface.getFunction('upgradeTo') !== undefined;
  if (!hasUpgraderRole) {
    throw new Error('Sanity check failed: upgradeTo() not found in new treasury impl ABI');
  }
  console.log('  ✓ upgradeTo() confirmed in new treasury impl ABI (UUPS ready)');
  await delay(DELAY_MS);

  // ===========================================================================
  // Step 3: Deploy new AssetVault implementation (redeemRecovery)
  // ===========================================================================
  console.log('\nStep 3: Deploying new AssetVault implementation (redeemRecovery)...');
  const VaultFactory = await ethers.getContractFactory('AssetVault', deployer);
  const newVaultImpl = await VaultFactory.deploy({ gasPrice });
  await newVaultImpl.deployed();
  console.log('  ✓ New AssetVaultImpl deployed at:', newVaultImpl.address);

  // Sanity: verify redeemRecovery is in the ABI
  const hasRedeemRecovery = newVaultImpl.interface.getFunction('redeemRecovery') !== undefined;
  if (!hasRedeemRecovery) {
    throw new Error('Sanity check failed: redeemRecovery() not found in new vault impl ABI');
  }
  console.log('  ✓ redeemRecovery() confirmed in new vault impl ABI');
  await delay(DELAY_MS);

  // ===========================================================================
  // Step 4: Single setImplementations() call — both new impls atomically
  //         Requires GOVERNANCE_ROLE on AssetFactory
  // ===========================================================================
  console.log('\nStep 4: Updating AssetFactory.setImplementations() with both new impls...');
  const assetFactory = await ethers.getContractAt('AssetFactory', ASSET_FACTORY, deployer);

  const tx = await assetFactory.setImplementations(
    newVaultImpl.address,          // new vault impl  — adds redeemRecovery()
    newTreasuryImpl.address,       // new treasury impl — now UUPS upgradeable
    platform.YieldDistributorImpl, // unchanged
    { gasPrice }
  );
  const receipt = await tx.wait();
  console.log('  ✓ setImplementations() tx:', receipt.transactionHash);
  await delay(DELAY_MS);

  // ===========================================================================
  // Step 5: Verify both addresses are live on AssetFactory
  // ===========================================================================
  console.log('\nStep 5: Verifying AssetFactory state...');
  const vaultImplOnChain     = await assetFactory.vaultImplementation();
  const treasuryImplOnChain  = await assetFactory.treasuryImplementation();

  if (vaultImplOnChain.toLowerCase() !== newVaultImpl.address.toLowerCase()) {
    throw new Error(`Vault impl mismatch! On-chain: ${vaultImplOnChain}, expected: ${newVaultImpl.address}`);
  }
  if (treasuryImplOnChain.toLowerCase() !== newTreasuryImpl.address.toLowerCase()) {
    throw new Error(`Treasury impl mismatch! On-chain: ${treasuryImplOnChain}, expected: ${newTreasuryImpl.address}`);
  }
  console.log('  ✓ vaultImplementation:   ', vaultImplOnChain);
  console.log('  ✓ treasuryImplementation:', treasuryImplOnChain);

  // ===========================================================================
  // Step 6: Save to deployments
  // ===========================================================================
  saveAddress('AssetVaultImpl', newVaultImpl.address);
  saveAddress('AssetTreasuryImpl', newTreasuryImpl.address);
  console.log('\n  Saved AssetVaultImpl    ->', newVaultImpl.address);
  console.log('  Saved AssetTreasuryImpl ->', newTreasuryImpl.address);

  console.log('\n=============================================================');
  console.log('✅ AssetVault + AssetTreasury UPGRADE COMPLETE');
  console.log('=============================================================');
  console.log('New AssetVaultImpl:    ', newVaultImpl.address);
  console.log('New AssetTreasuryImpl: ', newTreasuryImpl.address);
  console.log('AssetFactory:          ', ASSET_FACTORY, '(both impls updated)');
  console.log('');
  console.log('Effect on future assets:');
  console.log('  • AssetVault     → includes redeemRecovery() for RECOVERY state');
  console.log('  • AssetTreasury  → UUPS upgradeable (admin holds UPGRADER_ROLE)');
  console.log('=============================================================');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
