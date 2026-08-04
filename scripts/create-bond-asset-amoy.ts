import { ethers } from 'hardhat';
import OnchainID from '@onchain-id/solidity';
import * as fs from 'fs';
import * as path from 'path';

/**
 * REPEATABLE - run once per new Bond issuance you tokenize.
 *
 * What this script does:
 *   1. Creates a new ERC-3643 token + vault/treasury/distributor via AssetFactory
 *   2. Unpauses the token
 *   3. Calls RWALifecycleModule.initializeLoan() with AssetType.BOND and the
 *      hasRefund / hasMaturity flags you configure below
 *   4. Optionally KYC-verifies an investor
 *   5. Writes all addresses to deployments/bond-assets-amoy.json
 *
 * ---
 * BOND FEATURE FLAGS:
 *
 *   hasRefund   = true  → REFUND state is reachable (transitionToRefund works)
 *                false  → transitionToRefund reverts; once ACTIVE no refund path
 *   hasMaturity = true  → MATURED state is reachable + auto-freeze P2P at maturityTimestamp
 *                false  → bond is open-ended; P2P never frozen by timestamp
 *
 * Scenarios:
 *   - Full-featured bond:  hasRefund=true,  hasMaturity=true   (most similar to private credit)
 *   - No-refund bond:      hasRefund=false, hasMaturity=true   (committed issuance, hard maturity)
 *   - Perpetual bond:      hasRefund=true,  hasMaturity=false  (maturityTimestamp MUST be 0)
 *   - Open-ended bond:     hasRefund=false, hasMaturity=false  (fully open-ended)
 *
 * Prerequisites:
 *   - deploy-asset-platform-amoy.ts has run
 *   - register-rwa-types-amoy.ts has run  (registers BOND type + module proxies)
 *
 * Run: npx hardhat run scripts/create-bond-asset-amoy.ts --network polygon
 */

// =============================================================================
// CONFIGURATION - edit these per bond issuance
// =============================================================================
const BOND_ASSET_SALT = 'CORP-BOND-002';      // Must be unique across all assets
const BOND_FACE_VALUE_USDC = '100000';            // Total issuance size in USDC
const COUPON_RATE_BPS = 600;                   // 6.00% annual coupon (informative on-chain)
const PAYMENT_FREQUENCY_DAYS = 90;               // Quarterly coupon payments

// --- Feature Flags (edit for your bond structure) ---
const HAS_REFUND = false;  // No refund path — investors commit on subscription
const HAS_MATURITY = true;   // Hard maturity date — P2P frozen at maturity

const FUNDING_PERIOD_DAYS = 30;                 // Subscription window (days from now)
const BOND_TERM_MONTHS = 24;                 // Bond maturity from end of funding window
const ISSUER_ADDRESS = '';                 // Issuer wallet (leave blank to use deployer)
const INVESTOR_ADDRESS = '';                 // Optional: KYC-verify this investor now
const ALLOWED_COUNTRY = 42;                 // ISO 3166-1 numeric for CountryAllow

const platformPath = path.join(__dirname, '../deployments/asset-platform-amoy.json');
const realEstatePath = path.join(__dirname, '../deployments/amoy.json');
const assetsOutputPath = path.join(__dirname, '../deployments/bond-assets-amoy.json');

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
  if (existingAssets[BOND_ASSET_SALT]) {
    throw new Error(`"${BOND_ASSET_SALT}" already exists in bond-assets-amoy.json — change BOND_ASSET_SALT.`);
  }

  // Validate flag combination before paying gas
  if (!HAS_MATURITY && BOND_TERM_MONTHS > 0) {
    console.warn('WARNING: HAS_MATURITY=false but BOND_TERM_MONTHS > 0. maturityTimestamp will be set to 0 as required by the module.');
  }

  const gasPrice = await getGasPrice();
  console.log(`\nCreating Bond asset "${BOND_ASSET_SALT}"...`);
  console.log('Deployer:', deployer.address);
  console.log('Feature flags: hasRefund=%s, hasMaturity=%s', HAS_REFUND, HAS_MATURITY);

  const assetFactory = await ethers.getContractAt('AssetFactory', platform.AssetFactory);
  const lifecycleModule = await ethers.getContractAt('RWALifecycleModule', platform.RWALifecycleModule);

  // AssetType enum: 0 = PRIVATE_CREDIT, 1 = BOND
  const ASSET_TYPE_BOND = 1;
  const BOND = ethers.utils.formatBytes32String('BOND');
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
    name: `Bond ${BOND_ASSET_SALT}`,
    symbol: BOND_ASSET_SALT.replace(/-/g, '').slice(0, 11),
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
    salt: BOND_ASSET_SALT,
    assetType: BOND,
    paymentToken: realEstate.Stablecoin,
    mode: 0,  // AssetVault.PaymentMode.STABLECOIN_DIRECT
    price: ethers.utils.parseUnits('1', DECIMALS), // $1 per bond token
    charityWallet: ethers.constants.AddressZero,
    admin: deployer.address,
    metadataURI: `ipfs://${BOND_ASSET_SALT.toLowerCase()}-metadata`,
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
  // 3. Initialize bond on RWALifecycleModule (BOND path)
  //
  //    BOND differences vs PRIVATE_CREDIT:
  //      - transitionToActive does NOT require totalSupply >= targetPrincipal
  //      - hasRefund and hasMaturity are configurable (see flags above)
  //      - maturityTimestamp must be 0 when hasMaturity=false
  // -------------------------------------------------------------------------
  console.log('\n[3/4] Initializing Bond on RWALifecycleModule...');

  const faceValue = ethers.utils.parseUnits(BOND_FACE_VALUE_USDC, DECIMALS);
  const now = Math.floor(Date.now() / 1000);
  const fundingDeadline = now + 86400 * FUNDING_PERIOD_DAYS;
  // maturityTimestamp = 0 when HAS_MATURITY is false (module enforces this)
  const maturityTimestamp = HAS_MATURITY ? fundingDeadline + 86400 * 30 * BOND_TERM_MONTHS : 0;
  const paymentFrequency = 86400 * PAYMENT_FREQUENCY_DAYS;
  const agreementHash = ethers.utils.keccak256(
    ethers.utils.toUtf8Bytes(`Bond Indenture Agreement v1.0 ${BOND_ASSET_SALT}`),
  );
  const issuer = ISSUER_ADDRESS || deployer.address;

  await (
    await lifecycleModule.connect(deployer).initializeLoan(
      tokenAddress,
      ASSET_TYPE_BOND,          // AssetType.BOND = 1
      faceValue,
      fundingDeadline,
      maturityTimestamp,        // 0 when HAS_MATURITY = false
      paymentFrequency,
      COUPON_RATE_BPS,
      agreementHash,
      issuer,
      HAS_REFUND,               // configurable for bonds
      HAS_MATURITY,             // configurable for bonds
      { gasPrice },
    )
  ).wait();

  console.log(`  ✓ Bond initialized.`);
  console.log(`    Face value: $${BOND_FACE_VALUE_USDC} USDC`);
  console.log(`    Coupon:     ${COUPON_RATE_BPS / 100}% annual`);
  console.log(`    hasRefund:  ${HAS_REFUND}`);
  console.log(`    hasMaturity:${HAS_MATURITY}`);
  console.log(`    Subscription deadline: ${new Date(fundingDeadline * 1000).toISOString()}`);
  if (HAS_MATURITY) {
    console.log(`    Maturity date:         ${new Date(maturityTimestamp * 1000).toISOString()}`);
  } else {
    console.log(`    Maturity date:         N/A (open-ended / perpetual)`);
  }
  console.log(`    State: FUNDING (minting enabled, P2P disabled)`);
  console.log('');

  if (!HAS_REFUND) {
    console.log('  ⚠️  hasRefund=false: transitionToRefund() will revert for this bond.');
  }
  if (!HAS_MATURITY) {
    console.log('  ⚠️  hasMaturity=false: transitionToMatured() will revert for this bond.');
    console.log('      P2P trades will never auto-freeze by timestamp.');
  }

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
  writeAssetRecord(BOND_ASSET_SALT, {
    assetId: assetId.toString(),
    token: tokenAddress,
    vault: vaultAddress,
    treasury: treasuryAddress,
    distributor: distributorAddress,
    stateModule: platform.RWALifecycleModule,
    assetType: 'BOND',
    faceValueUsdc: BOND_FACE_VALUE_USDC,
    couponRateBps: COUPON_RATE_BPS,
    hasRefund: HAS_REFUND,
    hasMaturity: HAS_MATURITY,
    subscriptionDeadline: new Date(fundingDeadline * 1000).toISOString(),
    maturityDate: HAS_MATURITY ? new Date(maturityTimestamp * 1000).toISOString() : null,
    issuer,
  });

  console.log(`\n✅ "${BOND_ASSET_SALT}" is live in FUNDING state.`);
  console.log('   Record saved to deployments/bond-assets-amoy.json');
  console.log('\nNext: when subscription period closes, call:');
  console.log('  lifecycleModule.transitionToActive(tokenAddress)  →  opens P2P trading');
  if (HAS_REFUND) {
    console.log('  lifecycleModule.transitionToRefund(tokenAddress)  →  if subscription fails');
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
