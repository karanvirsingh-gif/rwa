import { ethers } from 'hardhat';
import OnchainID from '@onchain-id/solidity';
import * as fs from 'fs';
import * as path from 'path';

/**
 * REPEATABLE - run once per new gold bar you tokenize. Mirrors add-property-amoy.ts's
 * shape: edit the CONFIG block below, run it, get a live asset.
 *
 * Wires in three investor-eligibility rules and self-tests all three before
 * finishing, using cheap view-call simulation (no gas, no state change) so the proof
 * doesn't cost real transactions beyond what asset creation already needs. All three
 * are ordinary compliance modules - none of them ever require touching AssetVault,
 * AssetFactory, or any other core contract, for this asset or any future one:
 *   - Country restriction (CountryAllowModule, stock T-REX)
 *   - Max holding per investor (MaxBalanceModule, stock T-REX)
 *   - Minimum purchase size (MinimumInvestmentModule, same shape as the other two)
 *
 * Requires deploy-asset-platform-amoy.ts to have already run, including its Step 8
 * (CountryAllowModule/MaxBalanceModule/MinimumInvestmentModule).
 *
 * Run: npx hardhat run scripts/create-gold-asset-amoy.ts --network polygon
 */

// =========================================================================
// CONFIGURATION - edit these per gold bar
// =========================================================================
const GOLD_ASSET_SALT = 'GOLD-BAR-002'; // must be unique, ever
const GOLD_PRICE_USDC = '70'; // starting price per gram
const INVESTOR_ADDRESS = ''; // real wallet to KYC-verify now; leave blank to skip and do it later

const ALLOWED_COUNTRY = 42; // ISO 3166-1 numeric - only investors registered under this may hold this asset
const MAX_BALANCE_GRAMS = '200'; // per-investor cap
const MIN_PURCHASE_GRAMS = '1'; // smallest single purchase allowed
const TEST_RESERVE_GRAMS = '1000'; // initial attestation so self-tests below can run; re-attest for real via attest-gold-reserve-amoy.ts afterward

const platformPath = path.join(__dirname, '../deployments/asset-platform-amoy.json');
const realEstatePath = path.join(__dirname, '../deployments/amoy.json');
const goldAssetsPath = path.join(__dirname, '../deployments/gold-assets-amoy.json');

function readJson(p: string): any {
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {};
}

function writeAssetRecord(salt: string, record: any) {
  const all = readJson(goldAssetsPath);
  all[salt] = record;
  if (!fs.existsSync(path.dirname(goldAssetsPath))) {
    fs.mkdirSync(path.dirname(goldAssetsPath), { recursive: true });
  }
  fs.writeFileSync(goldAssetsPath, JSON.stringify(all, null, 2));
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
  const existingAssets = readJson(goldAssetsPath);

  if (!platform.AssetFactory) {
    throw new Error('Run deploy-asset-platform-amoy.ts first.');
  }
  if (!platform.CountryAllowModule || !platform.MaxBalanceModule || !platform.MinimumInvestmentModule) {
    throw new Error('Business-rule modules not found - run the updated deploy-asset-platform-amoy.ts (Step 8) first.');
  }
  if (!realEstate.Stablecoin) {
    throw new Error('No Stablecoin recorded in deployments/amoy.json.');
  }
  if (existingAssets[GOLD_ASSET_SALT]) {
    throw new Error(`"${GOLD_ASSET_SALT}" already exists (see deployments/gold-assets-amoy.json) - change GOLD_ASSET_SALT.`);
  }

  const gasPrice = await getGasPrice();
  console.log(`Creating gold asset "${GOLD_ASSET_SALT}"...`);
  console.log('Deployer:', deployer.address);

  const assetFactory = await ethers.getContractAt('AssetFactory', platform.AssetFactory);
  const countryAllowModule = await ethers.getContractAt('CountryAllowModule', platform.CountryAllowModule);
  const maxBalanceModule = await ethers.getContractAt('MaxBalanceModule', platform.MaxBalanceModule);
  const minimumInvestmentModule = await ethers.getContractAt('MinimumInvestmentModule', platform.MinimumInvestmentModule);

  const claimTopic = ethers.utils.keccak256(ethers.utils.toUtf8Bytes('KYC_CLAIM'));
  const GOLD = ethers.utils.formatBytes32String('GOLD');
  const DECIMALS = 18;

  const tokenDetails = {
    owner: ethers.constants.AddressZero, // overwritten internally by AssetFactory, then handed to `admin` below
    name: `Gold Bar ${GOLD_ASSET_SALT}`,
    symbol: GOLD_ASSET_SALT.replace(/-/g, '').slice(0, 11),
    decimals: DECIMALS,
    irs: ethers.constants.AddressZero,
    ONCHAINID: ethers.constants.AddressZero,
    irAgents: [deployer.address],
    tokenAgents: [deployer.address],
    // Per-asset business rules - different from PhysicalReserveModule, which binds
    // automatically to every GOLD asset via registerAssetType. These are configured
    // fresh for THIS asset and could differ on the next one. All three are ordinary,
    // reusable modules - adding a fourth rule later never touches AssetVault/AssetFactory.
    complianceModules: [countryAllowModule.address, maxBalanceModule.address, minimumInvestmentModule.address],
    complianceSettings: [
      countryAllowModule.interface.encodeFunctionData('batchAllowCountries', [[ALLOWED_COUNTRY]]),
      maxBalanceModule.interface.encodeFunctionData('setMaxBalance', [ethers.utils.parseUnits(MAX_BALANCE_GRAMS, DECIMALS)]),
      minimumInvestmentModule.interface.encodeFunctionData('setMinInvestment', [ethers.utils.parseUnits(MIN_PURCHASE_GRAMS, DECIMALS)]),
    ],
  };
  const claimDetails = {
    claimTopics: [claimTopic],
    issuers: [platform.ClaimIssuer],
    issuerClaims: [[claimTopic]],
  };
  const params = {
    salt: GOLD_ASSET_SALT,
    assetType: GOLD,
    paymentToken: realEstate.Stablecoin,
    mode: 0, // AssetVault.PaymentMode.STABLECOIN_DIRECT
    price: ethers.utils.parseUnits(GOLD_PRICE_USDC, 6),
    charityWallet: ethers.constants.AddressZero,
    admin: deployer.address, // a Safe multisig in production
    metadataURI: `ipfs://${GOLD_ASSET_SALT.toLowerCase()}-metadata`,
  };

  const tx = await assetFactory.connect(deployer).createAsset(params, tokenDetails, claimDetails, { gasPrice });
  const receipt = await tx.wait();
  const event = receipt.events?.find((e: any) => e.event === 'AssetCreated');
  // event AssetCreated(bytes32 assetId, bytes32 assetType, address token, address vault, address treasury, address distributor)
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

  // Initial reserve attestation so the self-tests below aren't confounded by the
  // separate PhysicalReserveModule gate (which would otherwise block ANY mint
  // regardless of country/balance until backing is confirmed). Re-attest for real
  // amounts via attest-gold-reserve-amoy.ts as the custodian confirms them going forward.
  const physicalReserveModule = await ethers.getContractAt('PhysicalReserveModule', platform.PhysicalReserveModule);
  await (
    await physicalReserveModule
      .connect(deployer)
      .attestAllocation(complianceAddress, ethers.utils.parseUnits(TEST_RESERVE_GRAMS, DECIMALS), 'grams', 'initial-test-attestation', { gasPrice })
  ).wait();
  console.log(`  Initial test reserve attested: ${TEST_RESERVE_GRAMS}g.`);

  // Real investor onboarding (optional, unrelated to the self-tests below)
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
    console.log('  No INVESTOR_ADDRESS set - skipping real investor KYC, do it later via buy-gold-amoy.ts.');
  }

  // =========================================================================
  // Self-tests - prove country, max-balance, and min-purchase actually gate mints.
  // Two throwaway identities used only for this proof, never for a real purchase.
  // =========================================================================
  console.log('\nSelf-testing eligibility rules...');

  const allowedTestWallet = ethers.Wallet.createRandom();
  const disallowedTestWallet = ethers.Wallet.createRandom();
  const DISALLOWED_COUNTRY = ALLOWED_COUNTRY + 1;

  await verifyIdentity(ir, allowedTestWallet.address, ALLOWED_COUNTRY, claimTopic, platform, deployer, gasPrice);
  await verifyIdentity(ir, disallowedTestWallet.address, DISALLOWED_COUNTRY, claimTopic, platform, deployer, gasPrice);

  const smallAmount = ethers.utils.parseUnits('5', DECIMALS);
  const overMaxAmount = ethers.utils.parseUnits(MAX_BALANCE_GRAMS, DECIMALS).add(1);

  const results: { name: string; expected: boolean; actual: boolean }[] = [];

  const allowedCountryPasses = await compliance.canTransfer(ethers.constants.AddressZero, allowedTestWallet.address, smallAmount);
  results.push({ name: 'Allowed-country investor, valid amount -> should PASS', expected: true, actual: allowedCountryPasses });

  const disallowedCountryBlocked = await compliance.canTransfer(ethers.constants.AddressZero, disallowedTestWallet.address, smallAmount);
  results.push({ name: 'Disallowed-country investor, valid amount -> should FAIL (country)', expected: false, actual: disallowedCountryBlocked });

  const overMaxBlocked = await compliance.canTransfer(ethers.constants.AddressZero, allowedTestWallet.address, overMaxAmount);
  results.push({ name: `Allowed investor, amount over ${MAX_BALANCE_GRAMS}g cap -> should FAIL (max balance)`, expected: false, actual: overMaxBlocked });

  // Minimum purchase is now an ordinary compliance module too - same free view-call
  // check as the two rules above, no simulated transaction needed.
  const tooSmallAmount = ethers.utils.parseUnits(MIN_PURCHASE_GRAMS, DECIMALS).sub(1);
  const belowMinBlocked = !(await compliance.canTransfer(ethers.constants.AddressZero, allowedTestWallet.address, tooSmallAmount));
  results.push({ name: `Purchase below ${MIN_PURCHASE_GRAMS}g minimum -> should FAIL (min investment)`, expected: true, actual: belowMinBlocked });

  let allPassed = true;
  for (const r of results) {
    const pass = r.actual === r.expected;
    allPassed = allPassed && pass;
    console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${r.name} (got ${r.actual})`);
  }
  if (!allPassed) {
    throw new Error('One or more eligibility rule self-tests did not behave as expected - see FAIL lines above.');
  }

  writeAssetRecord(GOLD_ASSET_SALT, {
    assetId,
    token: tokenAddress,
    vault: vaultAddress,
    treasury: treasuryAddress,
    distributor: distributorAddress,
    compliance: complianceAddress,
    allowedCountry: ALLOWED_COUNTRY,
    maxBalanceGrams: MAX_BALANCE_GRAMS,
    minPurchaseGrams: MIN_PURCHASE_GRAMS,
  });

  console.log(`\n"${GOLD_ASSET_SALT}" is live, rules verified, and saved to deployments/gold-assets-amoy.json`);
  console.log(`Reserve currently attested at ${TEST_RESERVE_GRAMS}g (test value) - re-attest the real figure via attest-gold-reserve-amoy.ts.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
