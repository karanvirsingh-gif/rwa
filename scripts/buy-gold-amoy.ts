import { ethers } from 'hardhat';
import OnchainID from '@onchain-id/solidity';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Buys gold directly from an asset's AssetVault - mirrors buy-property-amoy.ts's
 * shape, but there's no marketplace in the loop for a primary purchase: the buyer's
 * wallet calls vault.buy() itself, which pulls USDC and mints straight to them
 * (mint-on-settlement). P2PMarketplace only comes into play for secondary,
 * wallet-to-wallet resale after this.
 *
 * If the buyer isn't verified on this asset yet, this script registers and KYC's
 * them first (same claim-issuer setup as create-gold-asset-amoy.ts), so you can run
 * this against any new buyer wallet without a separate onboarding step.
 *
 * Run: npx hardhat run scripts/buy-gold-amoy.ts --network polygon
 */

// =========================================================================
// CONFIGURATION
// =========================================================================
const GOLD_ASSET_SALT = 'GOLD-BAR-002';
const GRAMS_TO_BUY = '5';

const platformPath = path.join(__dirname, '../deployments/asset-platform-amoy.json');
const goldAssetsPath = path.join(__dirname, '../deployments/gold-assets-amoy.json');
const realEstatePath = path.join(__dirname, '../deployments/amoy.json');

function readJson(p: string): any {
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {};
}

async function main() {
  const [deployer, aliceWallet] = await ethers.getSigners();
  const buyer = aliceWallet; // swap for a different signer if buying on behalf of someone else

  const platform = readJson(platformPath);
  const assets = readJson(goldAssetsPath);
  const realEstate = readJson(realEstatePath);

  const asset = assets[GOLD_ASSET_SALT];
  if (!asset) {
    throw new Error(`No record for "${GOLD_ASSET_SALT}" in deployments/gold-assets-amoy.json - run create-gold-asset-amoy.ts first.`);
  }
  if (!realEstate.Stablecoin) {
    throw new Error('No Stablecoin recorded in deployments/amoy.json.');
  }

  const feeData = await ethers.provider.getFeeData();
  const gasPrice = feeData.gasPrice?.mul(150).div(100) || ethers.utils.parseUnits('35', 'gwei');

  console.log(`\nBuying ${GRAMS_TO_BUY}g of "${GOLD_ASSET_SALT}" for ${buyer.address}...`);

  const vault = await ethers.getContractAt('AssetVault', asset.vault);
  const token = await ethers.getContractAt('Token', asset.token);
  const usdc = await ethers.getContractAt('Stablecoin', realEstate.Stablecoin);

  const decimals = await token.decimals();
  const pricePerUnit = await vault.pricePerUnit();
  const rawAmount = ethers.utils.parseUnits(GRAMS_TO_BUY, decimals);
  const totalCost = rawAmount.mul(pricePerUnit).div(ethers.BigNumber.from(10).pow(decimals));

  console.log(`  Price per gram: ${ethers.utils.formatUnits(pricePerUnit, 6)} USDC`);
  console.log(`  Total cost:     ${ethers.utils.formatUnits(totalCost, 6)} USDC`);

  // =========================================================================
  // 1. Make sure the buyer is KYC-verified on THIS asset's identity registry
  // =========================================================================
  const irAddress = await token.identityRegistry();
  const ir = await ethers.getContractAt('IdentityRegistry', irAddress);
  const isRegistered = await ir.contains(buyer.address);

  if (!isRegistered) {
    console.log('  Buyer not yet verified on this asset - registering now...');
    if (!platform.ClaimIssuer || !platform.IdentityImplementationAuthority) {
      throw new Error('Missing ClaimIssuer / IdentityImplementationAuthority in deployments/asset-platform-amoy.json.');
    }
    const claimTopic = ethers.utils.keccak256(ethers.utils.toUtf8Bytes('KYC_CLAIM'));

    const idProxy = await new ethers.ContractFactory(
      OnchainID.contracts.IdentityProxy.abi,
      OnchainID.contracts.IdentityProxy.bytecode,
      deployer,
    ).deploy(platform.IdentityImplementationAuthority, deployer.address, { gasPrice });
    await idProxy.deployed();
    await (await ir.connect(deployer).registerIdentity(buyer.address, idProxy.address, 42, { gasPrice })).wait();

    const claim = {
      topic: claimTopic,
      issuer: platform.ClaimIssuer,
      identity: idProxy.address,
      data: ethers.utils.hexlify(ethers.utils.toUtf8Bytes('Verified')),
      scheme: 1,
      signature: '',
    };
    // deployer's key was registered as the ClaimIssuer's signing key during platform setup
    claim.signature = await deployer.signMessage(
      ethers.utils.arrayify(
        ethers.utils.keccak256(ethers.utils.defaultAbiCoder.encode(['address', 'uint256', 'bytes'], [idProxy.address, claim.topic, claim.data])),
      ),
    );
    const id = await ethers.getContractAt(OnchainID.contracts.Identity.abi, idProxy.address);
    await (await id.connect(deployer).addClaim(claim.topic, claim.scheme, claim.issuer, claim.signature, claim.data, '', { gasPrice })).wait();
    console.log('  Buyer verified.');
  } else {
    console.log('  Buyer already verified on this asset.');
  }

  // =========================================================================
  // 2. Fund check (testnet convenience only - mints mock USDC if short)
  // =========================================================================
  const balance = await usdc.balanceOf(buyer.address);
  if (balance.lt(totalCost)) {
    console.log('  Buyer low on USDC. Minting test funds...');
    await (await usdc.mint(buyer.address, totalCost.mul(2), { gasPrice })).wait();
  }

  // =========================================================================
  // 3. Approve the VAULT directly - no marketplace for a primary purchase
  // =========================================================================
  console.log('  Approving Vault to spend USDC...');
  await (await usdc.connect(buyer).approve(vault.address, totalCost, { gasPrice })).wait();

  // =========================================================================
  // 4. Buy - mints straight to the buyer if the reserve module allows it
  // =========================================================================
  console.log('  Executing buy()...');
  let receipt;
  try {
    // No hardcoded gasLimit - a gold mint loops 5 bound compliance modules
    // (YieldDistributor, PhysicalReserveModule, CountryAllowModule, MaxBalanceModule,
    // MinimumInvestmentModule), and that count only grows as more rules are added.
    // Auto-estimation adapts; a fixed number would need bumping every time and fail
    // silently (as an out-of-gas revert with no reason string) if forgotten.
    const buyTx = await vault.connect(buyer).buy(rawAmount, { gasPrice });
    receipt = await buyTx.wait();
  } catch (err) {
    console.error(
      '\nBuy failed. If the error mentions "Compliance not followed", the custodian likely hasn\'t attested ' +
        'enough reserve yet for this amount - run attest-gold-reserve-amoy.ts first.',
    );
    throw err;
  }
  console.log(`  Transaction: ${receipt.transactionHash}`);

  const finalBalance = await token.balanceOf(buyer.address);
  const totalSupply = await token.totalSupply();
  console.log(`\nGOLD STATS for "${GOLD_ASSET_SALT}":`);
  console.log(`  Total Supply:  ${ethers.utils.formatUnits(totalSupply, decimals)}g (grows on every buy - mint-on-settlement, no fixed inventory)`);
  console.log(`  Buyer Balance: ${ethers.utils.formatUnits(finalBalance, decimals)}g`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
