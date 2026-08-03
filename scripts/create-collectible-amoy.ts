import { ethers } from 'hardhat';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Script to create a Collectible Asset dynamically.
 * This utilizes the AssetFactory and the already registered "COLLECTIBLES" asset type.
 */

// =========================================================================
// CONFIGURATION
// =========================================================================
const ASSET_SALT = 'COLLECTIBLE-002';
const PRICE_USDC = '100'; // starting price
const MAX_SUPPLY = '100'; // Max supply of the collectible

const platformPath = path.join(__dirname, '../deployments/asset-platform-amoy.json');
const realEstatePath = path.join(__dirname, '../deployments/amoy.json');
const collectiblesPath = path.join(__dirname, '../deployments/collectibles-amoy.json');

function readJson(p: string): any {
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {};
}

function writeAssetRecord(salt: string, record: any) {
  const all = readJson(collectiblesPath);
  all[salt] = record;
  if (!fs.existsSync(path.dirname(collectiblesPath))) {
    fs.mkdirSync(path.dirname(collectiblesPath), { recursive: true });
  }
  fs.writeFileSync(collectiblesPath, JSON.stringify(all, null, 2));
}

async function getGasPrice() {
  const feeData = await ethers.provider.getFeeData();
  return feeData.gasPrice?.mul(150).div(100) || ethers.utils.parseUnits('35', 'gwei');
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const platform = readJson(platformPath);
  const realEstate = readJson(realEstatePath);
  const existingAssets = readJson(collectiblesPath);

  if (!platform.AssetFactory) {
    throw new Error('AssetFactory not found in deployments/asset-platform-amoy.json');
  }
  if (!realEstate.Stablecoin) {
    throw new Error('Stablecoin not found in deployments/amoy.json');
  }
  if (existingAssets[ASSET_SALT]) {
    throw new Error(`"${ASSET_SALT}" already exists (see deployments/collectibles-amoy.json) - change ASSET_SALT.`);
  }

  const gasPrice = await getGasPrice();
  console.log(`Creating collectible asset "${ASSET_SALT}"...`);
  console.log('Deployer:', deployer.address);

  const assetFactory = await ethers.getContractAt('AssetFactory', platform.AssetFactory);
  const supplyLimitModule = await ethers.getContractAt('SupplyLimitModule', platform.SupplyLimitModule);

  const claimTopic = ethers.utils.keccak256(ethers.utils.toUtf8Bytes('KYC_CLAIM'));
  const COLLECTIBLES = ethers.utils.formatBytes32String('COLLECTIBLES');
  const DECIMALS = 0; // Collectibles are typically non-divisible

  const tokenDetails = {
    owner: ethers.constants.AddressZero,
    name: `Collectible ${ASSET_SALT}`,
    symbol: ASSET_SALT.replace(/-/g, '').slice(0, 11),
    decimals: DECIMALS,
    irs: ethers.constants.AddressZero,
    ONCHAINID: ethers.constants.AddressZero,
    irAgents: [deployer.address],
    tokenAgents: [deployer.address],
    complianceModules: [],
    complianceSettings: [],
  };

  const claimDetails = {
    claimTopics: [claimTopic],
    issuers: [platform.ClaimIssuer],
    issuerClaims: [[claimTopic]],
  };

  const params = {
    salt: ASSET_SALT,
    assetType: COLLECTIBLES,
    paymentToken: realEstate.Stablecoin,
    mode: 0, // AssetVault.PaymentMode.STABLECOIN_DIRECT
    price: ethers.utils.parseUnits(PRICE_USDC, 6),
    charityWallet: ethers.constants.AddressZero,
    admin: deployer.address,
    metadataURI: `ipfs://${ASSET_SALT.toLowerCase()}-metadata`,
  };

  console.log('Deploying via AssetFactory.createAsset...');
  const tx = await assetFactory.connect(deployer).createAsset(params, tokenDetails, claimDetails, { gasPrice });
  const receipt = await tx.wait();

  const event = receipt.events?.find((e: any) => e.event === 'AssetCreated');
  const [assetId, , tokenAddress, vaultAddress, treasuryAddress, distributorAddress] = event!.args as any;

  console.log('✅ Asset Created Successfully!');
  console.log('  assetId:    ', assetId);
  console.log('  token:      ', tokenAddress);
  console.log('  vault:      ', vaultAddress);
  console.log('  treasury:   ', treasuryAddress);
  console.log('  distributor:', distributorAddress);

  const token = await ethers.getContractAt('Token', tokenAddress);
  const complianceAddress = await token.compliance();
  const compliance = await ethers.getContractAt('ModularCompliance', complianceAddress);

  // Set the supply limit now that the deployer is the owner of the compliance contract
  console.log('  Configuring SupplyLimitModule...');
  const setLimitData = supplyLimitModule.interface.encodeFunctionData('setSupplyLimit', [ethers.utils.parseUnits(MAX_SUPPLY, DECIMALS)]);
  await (await compliance.connect(deployer).callModuleFunction(setLimitData, supplyLimitModule.address, { gasPrice })).wait();

  // Tokens are paused by default in T-REX
  await (await token.connect(deployer).unpause({ gasPrice })).wait();
  console.log('  Token unpaused.');

  writeAssetRecord(ASSET_SALT, {
    assetId,
    token: tokenAddress,
    vault: vaultAddress,
    treasury: treasuryAddress,
    distributor: distributorAddress,
    compliance: complianceAddress,
    maxSupply: MAX_SUPPLY
  });

  console.log(`\n"${ASSET_SALT}" is live and saved to deployments/collectibles-amoy.json`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
