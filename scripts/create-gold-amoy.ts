import { ethers } from 'hardhat';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Script to create a Gold Asset dynamically.
 * This utilizes the AssetFactory and the already registered "GOLD" asset type.
 */

// =========================================================================
// CONFIGURATION
// =========================================================================
const ASSET_SALT = 'GOLD-BAR-006';
const PRICE_USDC = '70'; // starting price per gram
const MAX_SUPPLY = '1000000'; // max supply of gold in grams

const ALLOWED_COUNTRY = 42;
const MAX_BALANCE_GRAMS = '200';
const MIN_PURCHASE_GRAMS = '1';
const TEST_RESERVE_GRAMS = '1000'; // Initial test attestation

const platformPath = path.join(__dirname, '../deployments/asset-platform-amoy.json');
const realEstateConfigPath = path.join(__dirname, '../deployments/amoy.json');
const goldRecordsPath = path.join(__dirname, '../deployments/gold-assets-amoy.json');

function readJson(p: string): any {
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {};
}

function writeAssetRecord(salt: string, record: any) {
  const all = readJson(goldRecordsPath);
  all[salt] = record;
  if (!fs.existsSync(path.dirname(goldRecordsPath))) {
    fs.mkdirSync(path.dirname(goldRecordsPath), { recursive: true });
  }
  fs.writeFileSync(goldRecordsPath, JSON.stringify(all, null, 2));
}

async function getGasPrice() {
  const feeData = await ethers.provider.getFeeData();
  return feeData.gasPrice?.mul(150).div(100) || ethers.utils.parseUnits('35', 'gwei');
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const platform = readJson(platformPath);
  const realEstate = readJson(realEstateConfigPath);
  const existingAssets = readJson(goldRecordsPath);

  if (!platform.AssetFactory) {
    throw new Error('AssetFactory not found in deployments/asset-platform-amoy.json');
  }
  if (!realEstate.Stablecoin) {
    throw new Error('Stablecoin not found in deployments/amoy.json');
  }
  if (existingAssets[ASSET_SALT]) {
    throw new Error(`"${ASSET_SALT}" already exists (see deployments/gold-assets-amoy.json) - change ASSET_SALT.`);
  }

  const gasPrice = await getGasPrice();
  console.log(`Creating Gold asset "${ASSET_SALT}"...`);
  console.log('Deployer:', deployer.address);

  const assetFactory = await ethers.getContractAt('AssetFactory', platform.AssetFactory);
  const countryAllowModule = await ethers.getContractAt('CountryAllowModule', platform.CountryAllowModule);
  const maxBalanceModule = await ethers.getContractAt('MaxBalanceModule', platform.MaxBalanceModule);
  const minimumInvestmentModule = await ethers.getContractAt('MinimumInvestmentModule', platform.MinimumInvestmentModule);
  const supplyLimitModule = await ethers.getContractAt('SupplyLimitModule', platform.SupplyLimitModule);

  const claimTopic = ethers.utils.keccak256(ethers.utils.toUtf8Bytes('KYC_CLAIM'));
  const GOLD = ethers.utils.formatBytes32String('GOLD');
  const DECIMALS = 18; // Gold is fully divisible

  // Note: PhysicalReserveModule is already registered globally to the "GOLD" asset type, 
  // so AssetFactory will bind it automatically. We only pass asset-specific modules here.
  const tokenDetails = {
    owner: ethers.constants.AddressZero,
    name: `Gold Bar ${ASSET_SALT}`,
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
    assetType: GOLD,
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

  // Tokens are paused by default in T-REX
  await (await token.connect(deployer).unpause({ gasPrice })).wait();
  console.log('  Token unpaused.');

  // Attest Initial Reserve via PhysicalReserveModule
  console.log('  Attesting initial physical reserve...');
  const physicalReserveModule = await ethers.getContractAt('PhysicalReserveModule', platform.PhysicalReserveModule);
  await (
    await physicalReserveModule
      .connect(deployer)
      .attestAllocation(complianceAddress, ethers.utils.parseUnits(TEST_RESERVE_GRAMS, DECIMALS), 'grams', 'initial-test-attestation', { gasPrice })
  ).wait();
  console.log(`  Initial test reserve attested: ${TEST_RESERVE_GRAMS}g.`);

  // Configure SupplyLimitModule (bound by the Factory during creation)
  console.log('  Configuring SupplyLimitModule...');
  const setLimitData = supplyLimitModule.interface.encodeFunctionData('setSupplyLimit', [ethers.utils.parseUnits(MAX_SUPPLY, DECIMALS)]);
  await (await compliance.connect(deployer).callModuleFunction(setLimitData, supplyLimitModule.address, { gasPrice })).wait();
  console.log(`  SupplyLimitModule configured to ${MAX_SUPPLY}g.`);

  writeAssetRecord(ASSET_SALT, {
    assetId,
    token: tokenAddress,
    vault: vaultAddress,
    treasury: treasuryAddress,
    distributor: distributorAddress,
    compliance: complianceAddress,
    allowedCountry: ALLOWED_COUNTRY,
    maxBalanceGrams: MAX_BALANCE_GRAMS,
    minPurchaseGrams: MIN_PURCHASE_GRAMS
  });

  console.log(`\n"${ASSET_SALT}" is live and saved to deployments/gold-assets-amoy.json`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
