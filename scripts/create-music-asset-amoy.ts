import { ethers } from 'hardhat';
import * as fs from 'fs';
import * as path from 'path';

/**
 * REPEATABLE - run once per new music asset you tokenize.
 *
 * Requires register-music-asset-amoy.ts to have already run.
 *
 * Run: npx hardhat run scripts/create-music-asset-amoy.ts --network polygon
 */

// =========================================================================
// CONFIGURATION - edit these per music asset
// =========================================================================
const MUSIC_SALT = `MUSIC-${Math.floor(Math.random() * 1000000)}`; // must be unique, ever
const MUSIC_PRICE_USDC = '100'; // starting price

const DECIMALS = 18;

const platformPath = path.join(__dirname, '../deployments/asset-platform-amoy.json');
const realEstatePath = path.join(__dirname, '../deployments/amoy.json');
const musicAssetsPath = path.join(__dirname, '../deployments/music-assets-amoy.json');

function readJson(p: string): any {
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {};
}

function writeAssetRecord(salt: string, record: any) {
  const all = readJson(musicAssetsPath);
  all[salt] = record;
  if (!fs.existsSync(path.dirname(musicAssetsPath))) {
    fs.mkdirSync(path.dirname(musicAssetsPath), { recursive: true });
  }
  fs.writeFileSync(musicAssetsPath, JSON.stringify(all, null, 2));
}

async function getGasPrice() {
  const feeData = await ethers.provider.getFeeData();
  return feeData.gasPrice?.mul(150).div(100) || ethers.utils.parseUnits('35', 'gwei');
}


async function main() {
  const [deployer] = await ethers.getSigners();
  const platform = readJson(platformPath);
  const realEstate = readJson(realEstatePath);
  const existingAssets = readJson(musicAssetsPath);

  if (!platform.AssetFactory) {
    throw new Error('Run deploy-asset-platform-amoy.ts first.');
  }

  if (!realEstate.Stablecoin) {
    throw new Error('No Stablecoin recorded in deployments/amoy.json.');
  }
  if (existingAssets[MUSIC_SALT]) {
    throw new Error(`"${MUSIC_SALT}" already exists (see deployments/music-assets-amoy.json) - change MUSIC_SALT.`);
  }

  const gasPrice = await getGasPrice();
  console.log(`Creating music asset "${MUSIC_SALT}"...`);
  console.log('Deployer:', deployer.address);

  const assetFactory = await ethers.getContractAt('AssetFactory', platform.AssetFactory);


  const claimTopic = ethers.utils.keccak256(ethers.utils.toUtf8Bytes('KYC_CLAIM'));
  const MUSIC = ethers.utils.formatBytes32String('MUSIC');

  const tokenDetails = {
    owner: ethers.constants.AddressZero,
    name: `Music ${MUSIC_SALT}`,
    symbol: MUSIC_SALT.replace(/-/g, '').slice(0, 11),
    decimals: DECIMALS,
    irs: ethers.constants.AddressZero,
    ONCHAINID: ethers.constants.AddressZero,
    irAgents: [deployer.address],
    tokenAgents: [deployer.address],
    // The modules are bound via AssetFactory.
    complianceModules: [],
    complianceSettings: [],
  };
  const claimDetails = {
    claimTopics: [claimTopic],
    issuers: [platform.ClaimIssuer],
    issuerClaims: [[claimTopic]],
  };
  const params = {
    salt: MUSIC_SALT,
    assetType: MUSIC,
    paymentToken: realEstate.Stablecoin,
    mode: 0, // AssetVault.PaymentMode.STABLECOIN_DIRECT
    price: ethers.utils.parseUnits(MUSIC_PRICE_USDC, 6),
    charityWallet: ethers.constants.AddressZero,
    admin: deployer.address, // a Safe multisig in production
    metadataURI: `ipfs://${MUSIC_SALT.toLowerCase()}-metadata`,
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
  const complianceAddress = await token.compliance();



  // T-REX tokens deploy paused by default; required before any transfer/P2P trade.
  await (await token.connect(deployer).unpause({ gasPrice })).wait();
  console.log('  Token unpaused.');




  writeAssetRecord(MUSIC_SALT, {
    assetId,
    token: tokenAddress,
    vault: vaultAddress,
    treasury: treasuryAddress,
    distributor: distributorAddress,
    compliance: complianceAddress,
  });

  console.log(`\n"${MUSIC_SALT}" is live and saved to deployments/music-assets-amoy.json`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
