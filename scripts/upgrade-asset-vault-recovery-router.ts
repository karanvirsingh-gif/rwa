import { ethers } from 'hardhat';
import * as fs from 'fs';
import * as path from 'path';

/**
 * UPGRADE: AssetVault — Recovery Router Pattern
 * ------------------------------------------------------------------------------
 * Deploys a new AssetVault implementation that replaces the two separate public
 * redemption functions (redeem + redeemRecovery) with a single unified router:
 *
 *   redeem(amount)
 *     └─ if isRecoveryMode == false → _redeemStandard()  (fixed-price payout)
 *     └─ if isRecoveryMode == true  → _redeemRecovery()  (pro-rata payout)
 *
 * The admin sets isRecoveryMode via setRecoveryMode(bool) atomically alongside
 * RWALifecycleModule.transitionToRecovery().
 *
 * What this script does:
 *   1. Archives the current AssetVaultImpl address in the deployment JSON
 *   2. Deploys the new AssetVault implementation contract
 *   3. Sanity-checks the new ABI (setRecoveryMode must exist, redeemRecovery must NOT)
 *   4. Calls AssetFactory.setImplementations() with the new vault impl
 *      (treasury and distributor impls are passed through unchanged)
 *   5. Verifies the on-chain pointer matches the newly deployed address
 *   6. Saves the new AssetVaultImpl address to asset-platform-amoy.json
 *
 * Existing per-asset vault proxies are NOT affected (by design — each ERC1967Proxy
 * stores its own implementation pointer in the EIP-1967 slot 0x360894...).
 *
 * Pre-requisite: upgrade-asset-vault-recovery.ts must have been run first so
 * that AssetTreasuryImpl and YieldDistributorImpl exist in the deployment JSON.
 *
 * Run: npx hardhat run scripts/upgrade-asset-vault-recovery-router.ts --network polygon
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

  // =========================================================================
  // Pre-flight checks
  // =========================================================================
  const ASSET_FACTORY = platform.AssetFactory;
  if (!ASSET_FACTORY) throw new Error('AssetFactory not found in asset-platform-amoy.json');
  if (!platform.AssetTreasuryImpl) throw new Error('AssetTreasuryImpl not found — run upgrade-asset-vault-recovery.ts first');
  if (!platform.YieldDistributorImpl) throw new Error('YieldDistributorImpl not found in asset-platform-amoy.json');

  const gasPrice = await getGasPrice();
  console.log('');
  console.log('=============================================================');
  console.log('  AssetVault Recovery Router Upgrade');
  console.log('=============================================================');
  console.log('Deployer:              ', deployer.address);
  console.log('Gas price:             ', ethers.utils.formatUnits(gasPrice, 'gwei'), 'gwei');
  console.log('AssetFactory:          ', ASSET_FACTORY);
  console.log('Current AssetVaultImpl:', platform.AssetVaultImpl ?? '(none recorded)');
  console.log('');

  // =========================================================================
  // Step 1: Archive old vault impl for audit trail
  // =========================================================================
  console.log('Step 1: Archiving old AssetVaultImpl for audit trail...');
  if (platform.AssetVaultImpl && !platform.AssetVaultImplV2) {
    saveAddress('AssetVaultImplV2', platform.AssetVaultImpl);
    console.log('  Archived as AssetVaultImplV2:', platform.AssetVaultImpl);
  } else if (platform.AssetVaultImplV2) {
    console.log('  Skipping — AssetVaultImplV2 already archived:', platform.AssetVaultImplV2);
  } else {
    console.log('  No previous impl to archive — proceeding.');
  }

  // =========================================================================
  // Step 2: Deploy new AssetVault implementation
  // =========================================================================
  console.log('\nStep 2: Deploying new AssetVault implementation (recovery router)...');
  const VaultFactory = await ethers.getContractFactory('AssetVault', deployer);
  const newVaultImpl = await VaultFactory.deploy({ gasPrice });
  await newVaultImpl.deployed();
  console.log('  New AssetVaultImpl deployed at:', newVaultImpl.address);
  await delay(DELAY_MS);

  // =========================================================================
  // Step 3: ABI sanity checks
  // =========================================================================
  console.log('\nStep 3: ABI sanity checks...');

  // setRecoveryMode MUST exist
  try {
    newVaultImpl.interface.getFunction('setRecoveryMode');
    console.log('  setRecoveryMode(bool) confirmed in new vault impl ABI');
  } catch {
    throw new Error('Sanity check FAILED: setRecoveryMode() not found in new vault impl ABI');
  }

  // isRecoveryMode public getter MUST exist
  try {
    newVaultImpl.interface.getFunction('isRecoveryMode');
    console.log('  isRecoveryMode() public getter confirmed in new vault impl ABI');
  } catch {
    throw new Error('Sanity check FAILED: isRecoveryMode() not found in new vault impl ABI');
  }

  // redeemRecovery MUST NOT exist as an external function
  try {
    newVaultImpl.interface.getFunction('redeemRecovery');
    // If we reach here, the function still exists — this is a problem
    throw new Error('Sanity check FAILED: redeemRecovery() still present as external in new vault impl ABI — it should have been removed');
  } catch (e: any) {
    if (e.message.startsWith('Sanity check FAILED')) throw e;
    // Expected path: getFunction throws because the function does not exist
    console.log('  redeemRecovery() correctly absent from public ABI (function removed)');
  }

  // redeem() MUST still exist
  try {
    newVaultImpl.interface.getFunction('redeem');
    console.log('  redeem(uint256) confirmed as unified router in new vault impl ABI');
  } catch {
    throw new Error('Sanity check FAILED: redeem() not found in new vault impl ABI');
  }

  await delay(DELAY_MS);

  // =========================================================================
  // Step 4: Call AssetFactory.setImplementations()
  //         Treasury and Distributor impls are passed through unchanged
  // =========================================================================
  console.log('\nStep 4: Updating AssetFactory.setImplementations()...');
  const assetFactory = await ethers.getContractAt('AssetFactory', ASSET_FACTORY, deployer);

  const tx = await assetFactory.setImplementations(
    newVaultImpl.address,          // new vault impl — recovery router
    platform.AssetTreasuryImpl,    // unchanged
    platform.YieldDistributorImpl, // unchanged
    { gasPrice }
  );
  const receipt = await tx.wait();
  console.log('  setImplementations() tx:', receipt.transactionHash);
  await delay(DELAY_MS);

  // =========================================================================
  // Step 5: On-chain verification
  // =========================================================================
  console.log('\nStep 5: Verifying on-chain AssetFactory state...');
  const vaultImplOnChain      = await assetFactory.vaultImplementation();
  const treasuryImplOnChain   = await assetFactory.treasuryImplementation();
  const distributorImplOnChain = await assetFactory.distributorImplementation();

  if (vaultImplOnChain.toLowerCase() !== newVaultImpl.address.toLowerCase()) {
    throw new Error(`Vault impl mismatch! On-chain: ${vaultImplOnChain}, expected: ${newVaultImpl.address}`);
  }
  if (treasuryImplOnChain.toLowerCase() !== platform.AssetTreasuryImpl.toLowerCase()) {
    throw new Error(`Treasury impl changed unexpectedly! On-chain: ${treasuryImplOnChain}`);
  }
  if (distributorImplOnChain.toLowerCase() !== platform.YieldDistributorImpl.toLowerCase()) {
    throw new Error(`Distributor impl changed unexpectedly! On-chain: ${distributorImplOnChain}`);
  }
  console.log('  vaultImplementation:       ', vaultImplOnChain);
  console.log('  treasuryImplementation:    ', treasuryImplOnChain, '(unchanged)');
  console.log('  distributorImplementation: ', distributorImplOnChain, '(unchanged)');

  // =========================================================================
  // Step 6: Save new address to deployment JSON
  // =========================================================================
  console.log('\nStep 6: Saving new AssetVaultImpl to deployment JSON...');
  saveAddress('AssetVaultImpl', newVaultImpl.address);
  console.log('  Saved AssetVaultImpl ->', newVaultImpl.address);

  console.log('');
  console.log('=============================================================');
  console.log('AssetVault Recovery Router Upgrade COMPLETE');
  console.log('=============================================================');
  console.log('New AssetVaultImpl:     ', newVaultImpl.address);
  console.log('AssetFactory:           ', ASSET_FACTORY, '(pointer updated)');
  console.log('');
  console.log('What changed for future assets:');
  console.log('  redeem(amount) is now the single unified redemption entry point');
  console.log('  isRecoveryMode=false by default -> standard fixed-price payout');
  console.log('  Admin calls setRecoveryMode(true) at RECOVERY transition');
  console.log('  -> redeem() silently routes to pro-rata payout thereafter');
  console.log('  redeemRecovery() is no longer in the public ABI');
  console.log('');
  console.log('Operational checklist for RECOVERY transitions:');
  console.log('  1. AssetTreasury.deposit(amount, reason)');
  console.log('  2. RWALifecycleModule.transitionToRecovery(token, settlementHash)');
  console.log('  3. AssetVault.setRecoveryMode(true)  <- new required step');
  console.log('  4. Users call vault.redeem(amount) as usual');
  console.log('=============================================================');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
