import { ethers } from 'hardhat';
import OnchainID from '@onchain-id/solidity';
import * as fs from 'fs';
import * as path from 'path';

/**
 * REPEATABLE - run once per new private credit loan you tokenize on the modern
 * asset infrastructure.
 *
 * Wires in the PrivateCreditStateModule (deployed once automatically if needed)
 * and initializes the Escrow/Funding state.
 *
 * Requires deploy-asset-platform-amoy.ts to have already run.
 *
 * Run: npx hardhat run scripts/create-private-credit-asset-amoy.ts --network polygon
 */

// =========================================================================
// CONFIGURATION - edit these per private credit loan
// =========================================================================
const LOAN_ASSET_SALT = 'CORP-LOAN-001'; // must be unique
const TARGET_PRINCIPAL_USDC = '10000'; // Target raise amount
const COUPON_RATE = 850; // 8.5%
const INVESTOR_ADDRESS = ''; // real wallet to KYC-verify now; leave blank to skip
const LOAN_SUPPLY_LIMIT = '10000'; // max tokens that can ever be minted (1 token = 1 USDC principal) — must equal or exceed TARGET_PRINCIPAL_USDC

const ALLOWED_COUNTRY = 42; // ISO 3166-1 numeric - optional compliance

const platformPath = path.join(__dirname, '../deployments/asset-platform-amoy.json');
const realEstatePath = path.join(__dirname, '../deployments/amoy.json');
const privateCreditAssetsPath = path.join(__dirname, '../deployments/private-credit-assets-amoy.json');

function readJson(p: string): any {
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {};
}

function writeAssetRecord(salt: string, record: any) {
  const all = readJson(privateCreditAssetsPath);
  all[salt] = record;
  if (!fs.existsSync(path.dirname(privateCreditAssetsPath))) {
    fs.mkdirSync(path.dirname(privateCreditAssetsPath), { recursive: true });
  }
  fs.writeFileSync(privateCreditAssetsPath, JSON.stringify(all, null, 2));
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
  const existingAssets = readJson(privateCreditAssetsPath);

  if (!platform.AssetFactory) {
    throw new Error('Run deploy-asset-platform-amoy.ts first.');
  }
  if (!realEstate.Stablecoin) {
    throw new Error('No Stablecoin recorded in deployments/amoy.json.');
  }
  if (existingAssets[LOAN_ASSET_SALT]) {
    throw new Error(`"${LOAN_ASSET_SALT}" already exists (see deployments/private-credit-assets-amoy.json) - change LOAN_ASSET_SALT.`);
  }

  const gasPrice = await getGasPrice();
  console.log(`Creating Private Credit asset "${LOAN_ASSET_SALT}"...`);
  console.log('Deployer:', deployer.address);

  const assetFactory = await ethers.getContractAt('AssetFactory', platform.AssetFactory);
  const PRIVATE_CREDIT = ethers.utils.formatBytes32String('PRIVATE_CREDIT');

  // Deploy and register PrivateCreditStateModule if not done yet
  if (!platform.PrivateCreditStateModule) {
    console.log('\nDeploying PrivateCreditStateModule and registering PRIVATE_CREDIT asset type...');
    const stateModule = await ethers.deployContract('PrivateCreditStateModule', [], { gasPrice });
    await stateModule.deployed();
    savePlatformAddress('PrivateCreditStateModule', stateModule.address);

    const tx = await assetFactory.connect(deployer).registerAssetType(PRIVATE_CREDIT, [stateModule.address], { gasPrice });
    await tx.wait();
    savePlatformAddress('PrivateCreditAssetTypeRegistered', 'true');
    console.log('  PrivateCreditStateModule bound and type registered.');
    platform.PrivateCreditStateModule = stateModule.address;
  }

  const stateModuleAddress = platform.PrivateCreditStateModule;
  const stateModule = await ethers.getContractAt('PrivateCreditStateModule', stateModuleAddress);

  // Use CountryAllowModule if available on the platform
  let complianceModules: string[] = [];
  let complianceSettings: string[] = [];
  if (platform.CountryAllowModule) {
    const countryAllowModule = await ethers.getContractAt('CountryAllowModule', platform.CountryAllowModule);
    complianceModules.push(countryAllowModule.address);
    complianceSettings.push(countryAllowModule.interface.encodeFunctionData('batchAllowCountries', [[ALLOWED_COUNTRY]]));
  }

  const claimTopic = ethers.utils.keccak256(ethers.utils.toUtf8Bytes('KYC_CLAIM'));
  const DECIMALS = 6; // Match USDC decimals for 1:1 parity

  const tokenDetails = {
    owner: ethers.constants.AddressZero,
    name: `Corporate Loan ${LOAN_ASSET_SALT}`,
    symbol: LOAN_ASSET_SALT.replace(/-/g, '').slice(0, 11),
    decimals: DECIMALS,
    irs: ethers.constants.AddressZero,
    ONCHAINID: ethers.constants.AddressZero,
    irAgents: [deployer.address],
    tokenAgents: [deployer.address],
    complianceModules: complianceModules,
    complianceSettings: complianceSettings,
  };
  const claimDetails = {
    claimTopics: [claimTopic],
    issuers: [platform.ClaimIssuer],
    issuerClaims: [[claimTopic]],
  };
  const params = {
    salt: LOAN_ASSET_SALT,
    assetType: PRIVATE_CREDIT,
    paymentToken: realEstate.Stablecoin,
    mode: 0, // AssetVault.PaymentMode.STABLECOIN_DIRECT
    price: ethers.utils.parseUnits('1', DECIMALS), // $1 per token
    charityWallet: ethers.constants.AddressZero,
    admin: deployer.address,
    metadataURI: `ipfs://${LOAN_ASSET_SALT.toLowerCase()}-metadata`,
    supplyLimit: ethers.utils.parseUnits(LOAN_SUPPLY_LIMIT, DECIMALS), // hard cap — SupplyLimitModule enforces this on every mint
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

  await (await token.connect(deployer).unpause({ gasPrice })).wait();
  console.log('  Token unpaused.');

  // =========================================================================
  // Initialize the Loan Parameters on the State Module
  // =========================================================================
  console.log('\nInitializing Loan Parameters on the State Module...');
  const targetPrincipal = ethers.utils.parseUnits(TARGET_PRINCIPAL_USDC, DECIMALS);
  const fundingDeadline = Math.floor(Date.now() / 1000) + 86400 * 7; // 7 days from now
  const maturityTimestamp = fundingDeadline + (86400 * 365); // 1 year maturity
  const paymentFrequency = 86400 * 30; // 30 days
  const agreementHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes(`Master Loan Agreement v1.0 ${LOAN_ASSET_SALT}`));
  const borrowerAddress = deployer.address; // The deployer can be the default borrower for the demo script

  await (await stateModule.connect(deployer).initializeLoan(
    tokenAddress,
    targetPrincipal,
    fundingDeadline,
    maturityTimestamp,
    paymentFrequency,
    COUPON_RATE,
    agreementHash,
    borrowerAddress,
    { gasPrice }
  )).wait();
  console.log(`  Loan target: $${TARGET_PRINCIPAL_USDC}. State is now FUNDING (Escrow Phase).`);

  if (INVESTOR_ADDRESS) {
    console.log(`\n  Verifying investor ${INVESTOR_ADDRESS}...`);
    const alreadyRegistered = await ir.contains(INVESTOR_ADDRESS);
    if (!alreadyRegistered) {
      await verifyIdentity(ir, INVESTOR_ADDRESS, ALLOWED_COUNTRY, claimTopic, platform, deployer, gasPrice);
      console.log('  Investor verified.');
    } else {
      console.log('  Investor already registered on this asset.');
    }
  } else {
    console.log('\n  No INVESTOR_ADDRESS set - skipping real investor KYC.');
  }

  writeAssetRecord(LOAN_ASSET_SALT, {
    assetId,
    token: tokenAddress,
    vault: vaultAddress,
    treasury: treasuryAddress,
    distributor: distributorAddress,
    stateModule: stateModuleAddress,
    targetPrincipalUsdc: TARGET_PRINCIPAL_USDC,
    borrower: borrowerAddress
  });

  console.log(`\n"${LOAN_ASSET_SALT}" is live, state initialized to FUNDING, and saved to deployments/private-credit-assets-amoy.json`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
