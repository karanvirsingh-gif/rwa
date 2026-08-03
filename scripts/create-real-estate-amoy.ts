import { ethers } from 'hardhat';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Script to create a Real Estate Asset dynamically.
 * This utilizes the AssetFactory and the already registered "REAL_ESTATE" asset type.
 */

// =========================================================================
// CONFIGURATION
// =========================================================================
const ASSET_SALT = 'REAL-ESTATE-002';
const PRICE_USDC = '150'; // starting price
const MAX_SUPPLY = '2000'; // Max supply of the real estate token

const platformPath = path.join(__dirname, '../deployments/asset-platform-amoy.json');
const realEstateConfigPath = path.join(__dirname, '../deployments/amoy.json');
const realEstateRecordsPath = path.join(__dirname, '../deployments/real-estate-assets-amoy.json');

function readJson(p: string): any {
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {};
}

function writeAssetRecord(salt: string, record: any) {
  const all = readJson(realEstateRecordsPath);
  all[salt] = record;
  if (!fs.existsSync(path.dirname(realEstateRecordsPath))) {
    fs.mkdirSync(path.dirname(realEstateRecordsPath), { recursive: true });
  }
  fs.writeFileSync(realEstateRecordsPath, JSON.stringify(all, null, 2));
}

async function getGasPrice() {
  const feeData = await ethers.provider.getFeeData();
  return feeData.gasPrice?.mul(150).div(100) || ethers.utils.parseUnits('35', 'gwei');
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const platform = readJson(platformPath);
  const realEstate = readJson(realEstateConfigPath);
  const existingAssets = readJson(realEstateRecordsPath);

  if (!platform.AssetFactory) {
    throw new Error('AssetFactory not found in deployments/asset-platform-amoy.json');
  }
  if (!realEstate.Stablecoin) {
    throw new Error('Stablecoin not found in deployments/amoy.json');
  }
  if (existingAssets[ASSET_SALT]) {
    throw new Error(`"${ASSET_SALT}" already exists (see deployments/real-estate-assets-amoy.json) - change ASSET_SALT.`);
  }

  const gasPrice = await getGasPrice();
  console.log(`Creating Real Estate asset "${ASSET_SALT}"...`);
  console.log('Deployer:', deployer.address);

  const assetFactory = await ethers.getContractAt('AssetFactory', platform.AssetFactory);
  const supplyLimitModule = await ethers.getContractAt('SupplyLimitModule', platform.SupplyLimitModule);

  const claimTopic = ethers.utils.keccak256(ethers.utils.toUtf8Bytes('KYC_CLAIM'));
  const REAL_ESTATE = ethers.utils.formatBytes32String('REAL_ESTATE');
  const DECIMALS = 6; // Standard decimals for property fractions

  const tokenDetails = {
    owner: ethers.constants.AddressZero,
    name: `Property ${ASSET_SALT}`,
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
    assetType: REAL_ESTATE,
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

  console.log(`\n"${ASSET_SALT}" is live and saved to deployments/real-estate-assets-amoy.json`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
