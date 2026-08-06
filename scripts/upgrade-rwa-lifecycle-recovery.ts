import { ethers } from 'hardhat';
import * as fs from 'fs';
import * as path from 'path';

/**
 * UPGRADE: RWALifecycleModule — add RECOVERY state
 * --------------------------------------------------
 * Deploys a new RWALifecycleModule implementation that adds:
 *   - LoanState.RECOVERY (value 5, appended — storage safe)
 *   - LoanDetails.settlementHash field (appended — storage safe)
 *   - transitionToRecovery(token, settlementHash) function
 *   - RecoveryInitiated event
 *   - moduleCheck() RECOVERY branch (burn-only)
 *
 * The PROXY address (0x22a8d9633424593dF47CC78a726D0D049665Dfcb) NEVER changes.
 * All existing token compliance bindings, loanConfigs state, and registered asset
 * types continue to work uninterrupted.
 *
 * Run: npx hardhat run scripts/upgrade-rwa-lifecycle-recovery.ts --network polygon
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

  const PROXY_ADDRESS = platform.RWALifecycleModule;
  if (!PROXY_ADDRESS) {
    throw new Error('RWALifecycleModule proxy not found in asset-platform-amoy.json');
  }

  const gasPrice = await getGasPrice();
  console.log('Deployer:                  ', deployer.address);
  console.log('Gas price:                 ', ethers.utils.formatUnits(gasPrice, 'gwei'), 'gwei');
  console.log('RWALifecycleModule proxy:  ', PROXY_ADDRESS, ' <-- this address NEVER changes');
  console.log('Old impl:                  ', platform.RWALifecycleModuleImpl);
  console.log('');

  // ===========================================================================
  // Step 1: Archive old impl address for audit trail
  // ===========================================================================
  if (platform.RWALifecycleModuleImpl && !platform.RWALifecycleModuleImplV1) {
    saveAddress('RWALifecycleModuleImplV1', platform.RWALifecycleModuleImpl);
    console.log('✓ Archived old impl as RWALifecycleModuleImplV1:', platform.RWALifecycleModuleImpl);
  }

  // ===========================================================================
  // Step 2: Deploy new implementation
  // ===========================================================================
  console.log('\nStep 2: Deploying new RWALifecycleModule implementation...');
  const Factory = await ethers.getContractFactory('RWALifecycleModule', deployer);
  const newImpl = await Factory.deploy({ gasPrice });
  await newImpl.deployed();
  console.log('  ✓ New impl deployed at:', newImpl.address);
  await delay(DELAY_MS);

  // ===========================================================================
  // Step 3: Upgrade the proxy to point to new impl
  //         upgradeTo() is onlyOwner on the UUPS implementation
  // ===========================================================================
  console.log('\nStep 3: Upgrading proxy to new implementation...');
  const proxy = await ethers.getContractAt('RWALifecycleModule', PROXY_ADDRESS, deployer);

  const tx = await proxy.upgradeTo(newImpl.address, { gasPrice });
  const receipt = await tx.wait();
  console.log('  ✓ upgradeTo() tx:', receipt.transactionHash);
  await delay(DELAY_MS);


  
  // ===========================================================================
  // Step 4: Verify — read the new impl address from the proxy's ERC1967 slot
  // ===========================================================================
  console.log('\nStep 4: Verifying upgrade...');
  const IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
  const implSlotValue = await ethers.provider.getStorageAt(PROXY_ADDRESS, IMPL_SLOT);
  const implOnChain = ethers.utils.getAddress('0x' + implSlotValue.slice(26));

  if (implOnChain.toLowerCase() !== newImpl.address.toLowerCase()) {
    throw new Error(`Upgrade verification FAILED! On-chain impl: ${implOnChain}, expected: ${newImpl.address}`);
  }
  console.log('  ✓ On-chain impl matches new deployment:', implOnChain);

  // Quick sanity: call a view function through the proxy to confirm ABI is live
  const moduleNameViaProxy = await proxy.name();
  console.log('  ✓ proxy.name() via new impl:', moduleNameViaProxy);

  // ===========================================================================
  // Step 5: Save new impl address
  // ===========================================================================
  saveAddress('RWALifecycleModuleImpl', newImpl.address);
  console.log('\n  Saved RWALifecycleModuleImpl ->', newImpl.address);

  console.log('\n=============================================================');
  console.log('✅ RWALifecycleModule UPGRADE COMPLETE');
  console.log('=============================================================');
  console.log('Proxy (permanent):  ', PROXY_ADDRESS);
  console.log('New impl:           ', newImpl.address);
  console.log('Old impl (V1):      ', platform.RWALifecycleModuleImpl);
  console.log('');
  console.log('New capabilities available via proxy:');
  console.log('  • transitionToRecovery(tokenAddress, settlementDocHash)');
  console.log('  • moduleCheck() now allows burns in RECOVERY state');
  console.log('');
  console.log('Next: run upgrade-asset-vault-recovery.ts to deploy new AssetVaultImpl');
  console.log('=============================================================');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
