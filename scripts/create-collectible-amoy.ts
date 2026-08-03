import { ethers } from 'hardhat';
import OnchainID from '@onchain-id/solidity';
import * as fs from 'fs';
import * as path from 'path';

/**
 * REPEATABLE - run once per new collectible asset you tokenize.
 *
 * Wires in the compliance modules registered for COLLECTIBLES:
 *   - CustodianAttestationModule (requires real-world physical custody attestation)
 *   - SupplyLimitModule (caps the maximum tokens that can be minted for this asset)
 *
 * Requires register-collectibles-polygon.ts to have already run.
 *
 * Run: npx hardhat run scripts/create-collectible-amoy.ts --network polygon
 */

// =========================================================================
// CONFIGURATION - edit these per collectible
// =========================================================================
const COLLECTIBLE_SALT = `COLLECTIBLE-${Math.floor(Math.random() * 1000000)}`; // must be unique, ever
const COLLECTIBLE_PRICE_USDC = '500'; // starting price

const DECIMALS = 18;

const platformPath = path.join(__dirname, '../deployments/asset-platform-amoy.json');
const realEstatePath = path.join(__dirname, '../deployments/amoy.json');
const collectibleAssetsPath = path.join(__dirname, '../deployments/collectible-assets-amoy.json');

function readJson(p: string): any {
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {};
}

function writeAssetRecord(salt: string, record: any) {
  const all = readJson(collectibleAssetsPath);
  all[salt] = record;
  if (!fs.existsSync(path.dirname(collectibleAssetsPath))) {
    fs.mkdirSync(path.dirname(collectibleAssetsPath), { recursive: true });
  }
  fs.writeFileSync(collectibleAssetsPath, JSON.stringify(all, null, 2));
}

async function getGasPrice() {
  const feeData = await ethers.provider.getFeeData();
  return feeData.gasPrice?.mul(150).div(100) || ethers.utils.parseUnits('35', 'gwei');
}



async function main() {
  const [deployer] = await ethers.getSigners();
  const platform = readJson(platformPath);
  const realEstate = readJson(realEstatePath);
  const existingAssets = readJson(collectibleAssetsPath);

  if (!platform.AssetFactory) {
    throw new Error('Run deploy-asset-platform-amoy.ts first.');
  }

  if (!realEstate.Stablecoin) {
    throw new Error('No Stablecoin recorded in deployments/amoy.json.');
  }
  if (existingAssets[COLLECTIBLE_SALT]) {
    throw new Error(`"${COLLECTIBLE_SALT}" already exists (see deployments/collectible-assets-amoy.json) - change COLLECTIBLE_SALT.`);
  }

  const gasPrice = await getGasPrice();
  console.log(`Creating collectible asset "${COLLECTIBLE_SALT}"...`);
  console.log('Deployer:', deployer.address);

  const assetFactory = await ethers.getContractAt('AssetFactory', platform.AssetFactory);


  const claimTopic = ethers.utils.keccak256(ethers.utils.toUtf8Bytes('KYC_CLAIM'));
  const COLLECTIBLES = ethers.utils.formatBytes32String('COLLECTIBLES');

  const tokenDetails = {
    owner: ethers.constants.AddressZero,
    name: `Collectible ${COLLECTIBLE_SALT}`,
    symbol: COLLECTIBLE_SALT.replace(/-/g, '').slice(0, 11),
    decimals: DECIMALS,
    irs: ethers.constants.AddressZero,
    ONCHAINID: ethers.constants.AddressZero,
    irAgents: [deployer.address],
    tokenAgents: [deployer.address],
    // The CustodianAttestationModule and SupplyLimitModule are bound via AssetFactory.
    complianceModules: [],
    complianceSettings: [],
  };
  const claimDetails = {
    claimTopics: [claimTopic],
    issuers: [platform.ClaimIssuer],
    issuerClaims: [[claimTopic]],
  };
  const params = {
    salt: COLLECTIBLE_SALT,
    assetType: COLLECTIBLES,
    paymentToken: realEstate.Stablecoin,
    mode: 0, // AssetVault.PaymentMode.STABLECOIN_DIRECT
    price: ethers.utils.parseUnits(COLLECTIBLE_PRICE_USDC, 6),
    charityWallet: ethers.constants.AddressZero,
    admin: deployer.address, // a Safe multisig in production
    metadataURI: `ipfs://${COLLECTIBLE_SALT.toLowerCase()}-metadata`,
  };

  const tx = await assetFactory.connect(deployer).createAsset(params, tokenDetails, claimDetails, { gasPrice });
  const receipt = await tx.wait();
  const event = receipt.events?.find((e: any) => e.event === 'AssetCreated');
  const [assetId, , tokenAddress, vaultAddress, treasuryAddress, distributorAddress] = event!.args as any;

  console.log('  assetId:    ', assetId);
  console.log('  token:      ', tokenAddress);
  console.log('  vault:      ', vaultAddress);
  console.log('  treasury:   ', treasuryAddress);
  console.log('  distributor:', distributorAddress);

  const token = await ethers.getContractAt('Token', tokenAddress);
  const irAddress = await token.identityRegistry();
  const ir = await ethers.getContractAt('IdentityRegistry', irAddress);
  const complianceAddress = await token.compliance();
  const compliance = await ethers.getContractAt('ModularCompliance', complianceAddress);

  // T-REX tokens deploy paused by default; required before any transfer/P2P trade.
  await (await token.connect(deployer).unpause({ gasPrice })).wait();
  console.log('  Token unpaused.');





  writeAssetRecord(COLLECTIBLE_SALT, {
    assetId,
    token: tokenAddress,
    vault: vaultAddress,
    treasury: treasuryAddress,
    distributor: distributorAddress,
    compliance: complianceAddress,
  });

  console.log(`\n"${COLLECTIBLE_SALT}" is live and saved to deployments/collectible-assets-amoy.json`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
