import { ethers } from 'hardhat';
import OnchainID from '@onchain-id/solidity';
import * as fs from 'fs';
import * as path from 'path';

/**
 * REPEATABLE - run once per new Private Credit loan you tokenize.
 *
 * What this script does:
 *   1. Creates a new ERC-3643 token + vault/treasury/distributor via AssetFactory
 *   2. Unpauses the token
 *   3. Calls RWALifecycleModule.initializeLoan() with AssetType.PRIVATE_CREDIT,
 *      hasRefund=true, hasMaturity=true (mandatory for Private Credit)
 *   4. Optionally KYC-verifies an investor
 *   5. Writes all addresses to deployments/private-credit-assets-amoy.json
 *
 * Prerequisites:
 *   - deploy-asset-platform-amoy.ts has run
 *   - register-rwa-types-amoy.ts has run  (registers PRIVATE_CREDIT type + module proxies)
 *
 * Run: npx hardhat run scripts/create-private-credit-asset-amoy.ts --network polygon
 */

// =============================================================================
// CONFIGURATION - edit these per private credit loan
// =============================================================================
const LOAN_ASSET_SALT = 'CORP-LOAN-010';          // Must be unique across all assets
const TARGET_PRINCIPAL_USDC = '50000';             // Total raise target in USDC
const COUPON_RATE_BPS = 850;                       // 8.50% annual coupon (informative on-chain)
const PAYMENT_FREQUENCY_DAYS = 30;                 // Coupon payment every 30 days
const FUNDING_PERIOD_DAYS = 14;                    // Funding window (days from now)
const LOAN_TERM_MONTHS = 12;                       // Loan term in months
const BORROWER_ADDRESS = '';                       // Borrower wallet (leave blank to use deployer)
const INVESTOR_ADDRESS = '';                       // Optional: KYC-verify this investor now
const ALLOWED_COUNTRY = 42;                        // ISO 3166-1 numeric for CountryAllow

const platformPath = path.join(__dirname, '../deployments/asset-platform-amoy.json');
const realEstatePath = path.join(__dirname, '../deployments/amoy.json');
const assetsOutputPath = path.join(__dirname, '../deployments/private-credit-assets-amoy.json');

function readJson(p: string): any {
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {};
}

function writeAssetRecord(salt: string, record: any) {
  const all = readJson(assetsOutputPath);
  all[salt] = record;
  if (!fs.existsSync(path.dirname(assetsOutputPath))) {
    fs.mkdirSync(path.dirname(assetsOutputPath), { recursive: true });
  }
  fs.writeFileSync(assetsOutputPath, JSON.stringify(all, null, 2));
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
      ethers.utils.keccak256(
        ethers.utils.defaultAbiCoder.encode(['address', 'uint256', 'bytes'], [idProxy.address, claim.topic, claim.data]),
      ),
    ),
  );
  const id = await ethers.getContractAt(OnchainID.contracts.Identity.abi, idProxy.address);
  await (
    await id.connect(deployer).addClaim(claim.topic, claim.scheme, claim.issuer, claim.signature, claim.data, '', { gasPrice })
  ).wait();
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const platform = readJson(platformPath);
  const realEstate = readJson(realEstatePath);
  const existingAssets = readJson(assetsOutputPath);

  if (!platform.AssetFactory) throw new Error('Run deploy-asset-platform-amoy.ts first.');
  if (!platform.RWALifecycleModule) throw new Error('Run register-rwa-types-amoy.ts first (RWALifecycleModule proxy not found).');
  if (!realEstate.Stablecoin) throw new Error('No Stablecoin in deployments/amoy.json.');
  if (existingAssets[LOAN_ASSET_SALT]) {
    throw new Error(`"${LOAN_ASSET_SALT}" already exists in private-credit-assets-amoy.json — change LOAN_ASSET_SALT.`);
  }

  const gasPrice = await getGasPrice();
  console.log(`\nCreating Private Credit asset "${LOAN_ASSET_SALT}"...`);
  console.log('Deployer:', deployer.address);

  const assetFactory = await ethers.getContractAt('AssetFactory', platform.AssetFactory);
  const lifecycleModule = await ethers.getContractAt('RWALifecycleModule', platform.RWALifecycleModule);

  // AssetType enum: 0 = PRIVATE_CREDIT, 1 = BOND
  const ASSET_TYPE_PRIVATE_CREDIT = 0;
  const PRIVATE_CREDIT = ethers.utils.formatBytes32String('PRIVATE_CREDIT');
  const DECIMALS = 6; // Match USDC decimals for 1:1 parity

  // -------------------------------------------------------------------------
  // Optional: CountryAllow module binding
  // -------------------------------------------------------------------------
  const complianceModules: string[] = [];
  const complianceSettings: string[] = [];

  // if (platform.CountryAllowModule) {
  //   const cam = await ethers.getContractAt('CountryAllowModule', platform.CountryAllowModule);
  //   complianceModules.push(cam.address);
  //   complianceSettings.push(cam.interface.encodeFunctionData('batchAllowCountries', [[ALLOWED_COUNTRY]]));
  // }

  const claimTopic = ethers.utils.keccak256(ethers.utils.toUtf8Bytes('KYC_CLAIM'));

  // -------------------------------------------------------------------------
  // 1. Create the asset via AssetFactory
  // -------------------------------------------------------------------------
  const tokenDetails = {
    owner: ethers.constants.AddressZero,
    name: `Corporate Loan ${LOAN_ASSET_SALT}`,
    symbol: LOAN_ASSET_SALT.replace(/-/g, '').slice(0, 11),
    decimals: DECIMALS,
    irs: ethers.constants.AddressZero,
    ONCHAINID: ethers.constants.AddressZero,
    irAgents: [deployer.address],
    tokenAgents: [deployer.address],
    complianceModules,
    complianceSettings,
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
  };

  console.log('\n[1/4] Creating asset via AssetFactory...');
  const tx = await assetFactory.connect(deployer).createAsset(params, tokenDetails, claimDetails, { gasPrice });
  const receipt = await tx.wait();
  const event = receipt.events?.find((e: any) => e.event === 'AssetCreated');
  const [assetId, , tokenAddress, vaultAddress, treasuryAddress, distributorAddress] = event!.args as any;

  console.log('  assetId:    ', assetId.toString());
  console.log('  token:      ', tokenAddress);
  console.log('  vault:      ', vaultAddress);
  console.log('  treasury:   ', treasuryAddress);
  console.log('  distributor:', distributorAddress);

  // -------------------------------------------------------------------------
  // 2. Unpause the token
  // -------------------------------------------------------------------------
  const token = await ethers.getContractAt('Token', tokenAddress);
  console.log('\n[2/4] Unpausing token...');
  await (await token.connect(deployer).unpause({ gasPrice })).wait();
  console.log('  ✓ Token unpaused.');

  // -------------------------------------------------------------------------
  // 3. Initialize loan on the RWALifecycleModule (PRIVATE_CREDIT path)
  //
  //    hasRefund   = true  → REFUND state is reachable (mandatory for private credit)
  //    hasMaturity = true  → MATURED state is reachable + auto-freeze at maturity (mandatory)
  //    transitionToActive  → requires totalSupply >= targetPrincipal
  // -------------------------------------------------------------------------
  console.log('\n[3/4] Initializing Loan on RWALifecycleModule...');

  const targetPrincipal = ethers.utils.parseUnits(TARGET_PRINCIPAL_USDC, DECIMALS);
  const now = Math.floor(Date.now() / 1000);
  const fundingDeadline = now + 86400 * FUNDING_PERIOD_DAYS;
  const maturityTimestamp = fundingDeadline + 86400 * 30 * LOAN_TERM_MONTHS;
  const paymentFrequency = 86400 * PAYMENT_FREQUENCY_DAYS;
  const agreementHash = ethers.utils.keccak256(
    ethers.utils.toUtf8Bytes(`Master Loan Agreement v2.0 ${LOAN_ASSET_SALT}`),
  );
  const borrower = BORROWER_ADDRESS || deployer.address;

  await (
    await lifecycleModule.connect(deployer).initializeLoan(
      tokenAddress,
      ASSET_TYPE_PRIVATE_CREDIT,          // AssetType.PRIVATE_CREDIT = 0
      targetPrincipal,
      fundingDeadline,
      maturityTimestamp,
      paymentFrequency,
      COUPON_RATE_BPS,
      agreementHash,
      borrower,
      true,   // hasRefund  = true (mandatory for private credit)
      true,   // hasMaturity = true (mandatory for private credit)
      { gasPrice },
    )
  ).wait();

  console.log(`  ✓ Loan initialized.`);
  console.log(`    Target: $${TARGET_PRINCIPAL_USDC} USDC`);
  console.log(`    Coupon: ${COUPON_RATE_BPS / 100}% annual`);
  console.log(`    Funding deadline: ${new Date(fundingDeadline * 1000).toISOString()}`);
  console.log(`    Maturity:         ${new Date(maturityTimestamp * 1000).toISOString()}`);
  console.log(`    State: FUNDING (minting enabled, P2P disabled)`);

  // -------------------------------------------------------------------------
  // 4. Optional: KYC an investor
  // -------------------------------------------------------------------------
  const irAddress = await token.identityRegistry();
  const ir = await ethers.getContractAt('IdentityRegistry', irAddress);

  if (INVESTOR_ADDRESS) {
    console.log(`\n[4/4] Verifying investor ${INVESTOR_ADDRESS}...`);
    const alreadyRegistered = await ir.contains(INVESTOR_ADDRESS);
    if (!alreadyRegistered) {
      await verifyIdentity(ir, INVESTOR_ADDRESS, ALLOWED_COUNTRY, claimTopic, platform, deployer, gasPrice);
      console.log('  ✓ Investor KYC complete.');
    } else {
      console.log('  ✓ Investor already registered on this asset.');
    }
  } else {
    console.log('\n[4/4] No INVESTOR_ADDRESS set — skipping KYC.');
  }

  // -------------------------------------------------------------------------
  // 5. Persist deployment record
  // -------------------------------------------------------------------------
  writeAssetRecord(LOAN_ASSET_SALT, {
    assetId: assetId.toString(),
    token: tokenAddress,
    vault: vaultAddress,
    treasury: treasuryAddress,
    distributor: distributorAddress,
    stateModule: platform.RWALifecycleModule,
    assetType: 'PRIVATE_CREDIT',
    targetPrincipalUsdc: TARGET_PRINCIPAL_USDC,
    couponRateBps: COUPON_RATE_BPS,
    fundingDeadline: new Date(fundingDeadline * 1000).toISOString(),
    maturityDate: new Date(maturityTimestamp * 1000).toISOString(),
    borrower,
  });

  console.log(`\n✅ "${LOAN_ASSET_SALT}" is live in FUNDING state.`);
  console.log('   Record saved to deployments/private-credit-assets-amoy.json');
  console.log('\nNext: when fully funded, call:');
  console.log('  lifecycleModule.transitionToActive(tokenAddress)  →  opens P2P trading');
  console.log('  lifecycleModule.transitionToRefund(tokenAddress)  →  if funding fails');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
