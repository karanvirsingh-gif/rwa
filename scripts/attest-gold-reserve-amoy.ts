import { ethers } from 'hardhat';
import * as fs from 'fs';
import * as path from 'path';

/**
 * REPEATABLE - run whenever the custodian confirms a change in physical gold backing
 * (initial deposit, top-up, or a reduction after a physical redemption). Kept separate
 * from asset creation because attestation happens on its own cadence - custodian
 * audits, not new-asset onboarding - and the same PhysicalReserveModule instance is
 * reused for every gold asset (and later silver/art) without any new deployment here.
 *
 * Run: npx hardhat run scripts/attest-gold-reserve-amoy.ts --network polygon
 */

// =========================================================================
// CONFIGURATION - edit per attestation
// =========================================================================
const GOLD_ASSET_SALT = 'GOLD-BAR-002';
const ATTESTED_GRAMS = '1000';
const EVIDENCE_REF = 'vault-audit-ref-001'; // point this at your off-chain audit document/hash

const platformPath = path.join(__dirname, '../deployments/asset-platform-amoy.json');
const goldAssetsPath = path.join(__dirname, '../deployments/gold-assets-amoy.json');

function readJson(p: string): any {
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {};
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const platform = readJson(platformPath);
  const assets = readJson(goldAssetsPath);

  const asset = assets[GOLD_ASSET_SALT];
  if (!asset) {
    throw new Error(`No record for "${GOLD_ASSET_SALT}" in deployments/gold-assets-amoy.json - run create-gold-asset-amoy.ts first.`);
  }
  if (!platform.PhysicalReserveModule) {
    throw new Error('Run deploy-asset-platform-amoy.ts first.');
  }

  const feeData = await ethers.provider.getFeeData();
  const gasPrice = feeData.gasPrice?.mul(150).div(100) || ethers.utils.parseUnits('35', 'gwei');

  const module = await ethers.getContractAt('PhysicalReserveModule', platform.PhysicalReserveModule);

  console.log(`Attesting ${ATTESTED_GRAMS}g backing for "${GOLD_ASSET_SALT}" (compliance ${asset.compliance})...`);
  const tx = await module
    .connect(deployer)
    .attestAllocation(asset.compliance, ethers.utils.parseUnits(ATTESTED_GRAMS, 18), 'grams', EVIDENCE_REF, { gasPrice });
  await tx.wait();

  console.log('  Done. Investors can now buy up to', ATTESTED_GRAMS, 'grams of this asset.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
