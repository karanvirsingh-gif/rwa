import { ethers } from 'hardhat';
import OnchainID from '@onchain-id/solidity';
import * as fs from 'fs';
import * as path from 'path';

/**
 * SECOND gold asset - identical mechanics to create-gold-asset-amoy.ts, deliberately
 * different CONFIG to prove per-asset settings are actually independent, not shared:
 *
 *   GOLD-BAR-002 (first)          GOLD-BAR-003 (this one)
 *   ---------------------          ------------------------
 *   70 USDC/g                      75 USDC/g
 *   country 42 only                country 784 only (different investor base)
 *   max 200g per investor           max 500g per investor (bigger, institutional-leaning)
 *   min purchase 1g                 min purchase 10g (no small retail tickets)
 *   1000g test reserve              2500g test reserve (bigger bar)
 *
 * Same three module CONTRACTS as before (CountryAllowModule/MaxBalanceModule/
 * MinimumInvestmentModule) - nothing new deployed here, just different settings
 * passed in at creation time. That's the whole point: one ruleset engine, as many
 * distinct configurations as you have assets.
 *
 * Requires deploy-asset-platform-amoy.ts to have already run.
 * Run: npx hardhat run scripts/create-gold-asset-2-amoy.ts --network polygon
 */

// =========================================================================
// CONFIGURATION - edit these per gold bar
// =========================================================================
const GOLD_ASSET_SALT = 'GOLD-BAR-003'; // must be unique, ever
const GOLD_PRICE_USDC = '75'; // starting price per gram
const INVESTOR_ADDRESS = ''; // real wallet to KYC-verify now; leave blank to skip and do it later

const ALLOWED_COUNTRY = 784; // ISO 3166-1 numeric (UAE) - deliberately different from GOLD-BAR-002's 42
const MAX_BALANCE_GRAMS = '500'; // higher cap than GOLD-BAR-002 - larger ticket size
const MIN_PURCHASE_GRAMS = '10'; // higher minimum than GOLD-BAR-002 - no small retail tickets on this one
const TEST_RESERVE_GRAMS = '2500'; // bigger bar than GOLD-BAR-002's 1000g

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
  // Same three module CONTRACTS as GOLD-BAR-002 - reused, not redeployed.
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
    // This asset's OWN settings - independent of GOLD-BAR-002's, even though the
    // module contracts underneath are identical.
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

  // Initial reserve attestation, sized for THIS asset (2500g, not GOLD-BAR-002's 1000g).
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
  // Self-tests - prove THIS asset's own rules, not GOLD-BAR-002's, are in effect.
  // Two throwaway identities used only for this proof, never for a real purchase.
  // =========================================================================
  console.log('\nSelf-testing eligibility rules...');

  const allowedTestWallet = ethers.Wallet.createRandom();
  const disallowedTestWallet = ethers.Wallet.createRandom();
  const DISALLOWED_COUNTRY = ALLOWED_COUNTRY + 1; // a country NOT in this asset's allow-list

  await verifyIdentity(ir, allowedTestWallet.address, ALLOWED_COUNTRY, claimTopic, platform, deployer, gasPrice);
  await verifyIdentity(ir, disallowedTestWallet.address, DISALLOWED_COUNTRY, claimTopic, platform, deployer, gasPrice);

  const smallAmount = ethers.utils.parseUnits(MIN_PURCHASE_GRAMS, DECIMALS); // exactly at this asset's minimum
  const overMaxAmount = ethers.utils.parseUnits(MAX_BALANCE_GRAMS, DECIMALS).add(1);

  const results: { name: string; expected: boolean; actual: boolean }[] = [];

  const allowedCountryPasses = await compliance.canTransfer(ethers.constants.AddressZero, allowedTestWallet.address, smallAmount);
  results.push({ name: 'Allowed-country investor, valid amount -> should PASS', expected: true, actual: allowedCountryPasses });

  const disallowedCountryBlocked = await compliance.canTransfer(ethers.constants.AddressZero, disallowedTestWallet.address, smallAmount);
  results.push({ name: 'Disallowed-country investor, valid amount -> should FAIL (country)', expected: false, actual: disallowedCountryBlocked });

  const overMaxBlocked = await compliance.canTransfer(ethers.constants.AddressZero, allowedTestWallet.address, overMaxAmount);
  results.push({ name: `Allowed investor, amount over ${MAX_BALANCE_GRAMS}g cap -> should FAIL (max balance)`, expected: false, actual: overMaxBlocked });

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
  console.log(`Note: this asset's rules (country ${ALLOWED_COUNTRY}, max ${MAX_BALANCE_GRAMS}g, min ${MIN_PURCHASE_GRAMS}g) are`);
  console.log('independent of GOLD-BAR-002\'s - same module contracts, separate settings.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
