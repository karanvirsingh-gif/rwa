import { ethers } from 'hardhat';
import OnchainID from '@onchain-id/solidity';
import * as fs from 'fs';
import * as path from 'path';

/**
 * REPEATABLE - run once per new real estate property you tokenize on the modern
 * asset infrastructure.
 *
 * Wires in investor-eligibility rules and self-tests them before finishing,
 * using cheap view-call simulation (no gas, no state change):
 *   - Country restriction (CountryAllowModule)
 *
 * Requires deploy-asset-platform-amoy.ts to have already run.
 *
 * Run: npx hardhat run scripts/create-real-estate-asset-amoy.ts --network polygon
 */

// =========================================================================
// CONFIGURATION - edit these per real estate property
// =========================================================================
const PROPERTY_ASSET_SALT = 'REAL-ESTATE-001'; // must be unique
const PROPERTY_PRICE_USDC = '150'; // starting price per share
const INVESTOR_ADDRESS = ''; // real wallet to KYC-verify now; leave blank to skip

const ALLOWED_COUNTRY = 42; // ISO 3166-1 numeric - only investors registered under this may hold this asset

const platformPath = path.join(__dirname, '../deployments/asset-platform-amoy.json');
const realEstatePath = path.join(__dirname, '../deployments/amoy.json');
const realEstateAssetsPath = path.join(__dirname, '../deployments/real-estate-assets-amoy.json');

function readJson(p: string): any {
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {};
}

function writeAssetRecord(salt: string, record: any) {
  const all = readJson(realEstateAssetsPath);
  all[salt] = record;
  if (!fs.existsSync(path.dirname(realEstateAssetsPath))) {
    fs.mkdirSync(path.dirname(realEstateAssetsPath), { recursive: true });
  }
  fs.writeFileSync(realEstateAssetsPath, JSON.stringify(all, null, 2));
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

/** Registers + KYC-verifies an address on this asset's own identity registry. */
async function verifyIdentity(
  ir: any,
  address: string,
  country: number,
  claimTopic: string,
  platform: any,
  deployer: any,
  gasPrice: any,
) {
  const idProxy = await new ethers.ContractFactory(
    OnchainID.contracts.IdentityProxy.abi,
    OnchainID.contracts.IdentityProxy.bytecode,
    deployer,
  ).deploy(platform.IdentityImplementationAuthority, deployer.address, { gasPrice });
  await idProxy.deployed();
  await (await ir.connect(deployer).registerIdentity(address, idProxy.address, country, { gasPrice })).wait();

  const claim = {
    topic: claimTopic,
    issuer: platform.ClaimIssuer,
    identity: idProxy.address,
    data: ethers.utils.hexlify(ethers.utils.toUtf8Bytes('Verified')),
    scheme: 1,
    signature: '',
  };
  claim.signature = await deployer.signMessage(
    ethers.utils.arrayify(
      ethers.utils.keccak256(ethers.utils.defaultAbiCoder.encode(['address', 'uint256', 'bytes'], [idProxy.address, claim.topic, claim.data])),
    ),
  );
  const id = await ethers.getContractAt(OnchainID.contracts.Identity.abi, idProxy.address);
  await (await id.connect(deployer).addClaim(claim.topic, claim.scheme, claim.issuer, claim.signature, claim.data, '', { gasPrice })).wait();
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const platform = readJson(platformPath);
  const realEstate = readJson(realEstatePath);
  const existingAssets = readJson(realEstateAssetsPath);

  if (!platform.AssetFactory) {
    throw new Error('Run deploy-asset-platform-amoy.ts first.');
  }
  if (!platform.CountryAllowModule) {
    throw new Error('Business-rule modules not found - run deploy-asset-platform-amoy.ts first.');
  }
  if (!realEstate.Stablecoin) {
    throw new Error('No Stablecoin recorded in deployments/amoy.json.');
  }
  if (existingAssets[PROPERTY_ASSET_SALT]) {
    throw new Error(`"${PROPERTY_ASSET_SALT}" already exists (see deployments/real-estate-assets-amoy.json) - change PROPERTY_ASSET_SALT.`);
  }

  const gasPrice = await getGasPrice();
  console.log(`Creating real estate asset "${PROPERTY_ASSET_SALT}"...`);
  console.log('Deployer:', deployer.address);

  const assetFactory = await ethers.getContractAt('AssetFactory', platform.AssetFactory);
  const countryAllowModule = await ethers.getContractAt('CountryAllowModule', platform.CountryAllowModule);

  const claimTopic = ethers.utils.keccak256(ethers.utils.toUtf8Bytes('KYC_CLAIM'));
  const REAL_ESTATE = ethers.utils.formatBytes32String('REAL_ESTATE');
  const DECIMALS = 6; // Real estate shares usually have 6 or 18 decimals

  // Register REAL_ESTATE asset type if not already registered
  if (!platform.RealEstateAssetTypeRegistered) {
    console.log('\nRegistering REAL_ESTATE asset type (no default modules)...');
    const tx = await assetFactory.connect(deployer).registerAssetType(REAL_ESTATE, [], { gasPrice });
    await tx.wait();
    savePlatformAddress('RealEstateAssetTypeRegistered', 'true');
    console.log('  REAL_ESTATE asset type registered.');
  }

  const tokenDetails = {
    owner: ethers.constants.AddressZero,
    name: `Property ${PROPERTY_ASSET_SALT}`,
    symbol: PROPERTY_ASSET_SALT.replace(/-/g, '').slice(0, 11),
    decimals: DECIMALS,
    irs: ethers.constants.AddressZero,
    ONCHAINID: ethers.constants.AddressZero,
    irAgents: [deployer.address],
    tokenAgents: [deployer.address],
    complianceModules: [countryAllowModule.address],
    complianceSettings: [
      countryAllowModule.interface.encodeFunctionData('batchAllowCountries', [[ALLOWED_COUNTRY]]),
    ],
  };
  const claimDetails = {
    claimTopics: [claimTopic],
    issuers: [platform.ClaimIssuer],
    issuerClaims: [[claimTopic]],
  };
  const params = {
    salt: PROPERTY_ASSET_SALT,
    assetType: REAL_ESTATE,
    paymentToken: realEstate.Stablecoin,
    mode: 0, // AssetVault.PaymentMode.STABLECOIN_DIRECT
    price: ethers.utils.parseUnits(PROPERTY_PRICE_USDC, 6),
    charityWallet: ethers.constants.AddressZero,
    admin: deployer.address,
    metadataURI: `ipfs://${PROPERTY_ASSET_SALT.toLowerCase()}-metadata`,
  };

  console.log('\nCreating asset via AssetFactory...');
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

  await (await token.connect(deployer).unpause({ gasPrice })).wait();
  console.log('  Token unpaused.');

  if (INVESTOR_ADDRESS) {
    console.log(`  Verifying investor ${INVESTOR_ADDRESS}...`);
    const alreadyRegistered = await ir.contains(INVESTOR_ADDRESS);
    if (!alreadyRegistered) {
      await verifyIdentity(ir, INVESTOR_ADDRESS, ALLOWED_COUNTRY, claimTopic, platform, deployer, gasPrice);
      console.log('  Investor verified.');
    } else {
      console.log('  Investor already registered on this asset.');
    }
  } else {
    console.log('  No INVESTOR_ADDRESS set - skipping real investor KYC.');
  }

  // =========================================================================
  // Self-tests - prove country rule gates mints
  // =========================================================================
  console.log('\nSelf-testing eligibility rules...');

  const allowedTestWallet = ethers.Wallet.createRandom();
  const disallowedTestWallet = ethers.Wallet.createRandom();
  const DISALLOWED_COUNTRY = ALLOWED_COUNTRY + 1;

  await verifyIdentity(ir, allowedTestWallet.address, ALLOWED_COUNTRY, claimTopic, platform, deployer, gasPrice);
  await verifyIdentity(ir, disallowedTestWallet.address, DISALLOWED_COUNTRY, claimTopic, platform, deployer, gasPrice);

  const testAmount = ethers.utils.parseUnits('1', DECIMALS);
  const results: { name: string; expected: boolean; actual: boolean }[] = [];

  const allowedCountryPasses = await compliance.canTransfer(ethers.constants.AddressZero, allowedTestWallet.address, testAmount);
  results.push({ name: 'Allowed-country investor -> should PASS', expected: true, actual: allowedCountryPasses });

  const disallowedCountryBlocked = await compliance.canTransfer(ethers.constants.AddressZero, disallowedTestWallet.address, testAmount);
  results.push({ name: 'Disallowed-country investor -> should FAIL (country)', expected: false, actual: disallowedCountryBlocked });

  let allPassed = true;
  for (const r of results) {
    const pass = r.actual === r.expected;
    allPassed = allPassed && pass;
    console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${r.name} (got ${r.actual})`);
  }
  if (!allPassed) {
    throw new Error('One or more eligibility rule self-tests did not behave as expected.');
  }

  writeAssetRecord(PROPERTY_ASSET_SALT, {
    assetId,
    token: tokenAddress,
    vault: vaultAddress,
    treasury: treasuryAddress,
    distributor: distributorAddress,
    compliance: complianceAddress,
    allowedCountry: ALLOWED_COUNTRY,
  });

  console.log(`\n"${PROPERTY_ASSET_SALT}" is live, rules verified, and saved to deployments/real-estate-assets-amoy.json`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
