import { ethers } from 'hardhat';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Script to create a MUSIC asset and configure its SupplyLimitModule.
 *
 * Run: npx hardhat run scripts/create-music-asset-amoy.ts --network polygon
 */

const ASSET_SALT = 'MUSIC-002'; // must be unique
const PRICE_USDC = '10'; // starting price per share
const SUPPLY_LIMIT = '10000'; // max supply

const platformPath = path.join(__dirname, '../deployments/asset-platform-amoy.json');
const amoyPath = path.join(__dirname, '../deployments/amoy.json');
const musicAssetsPath = path.join(__dirname, '../deployments/music-assets-amoy.json');

function readJson(p: string): any {
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {};
}

function writeAssetRecord(salt: string, record: any) {
  const all = readJson(musicAssetsPath);
  all[salt] = record;
  if (!fs.existsSync(path.dirname(musicAssetsPath))) {
    fs.mkdirSync(path.dirname(musicAssetsPath), { recursive: true });
  }
  fs.writeFileSync(musicAssetsPath, JSON.stringify(all, null, 2));
}

async function getGasPrice() {
  const feeData = await ethers.provider.getFeeData();
  return feeData.gasPrice?.mul(150).div(100) || ethers.utils.parseUnits('35', 'gwei');
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const platform = readJson(platformPath);
  const amoy = readJson(amoyPath);
  const existingAssets = readJson(musicAssetsPath);

  if (!platform.AssetFactory) {
    throw new Error('Run deploy-asset-platform-amoy.ts first.');
  }
  if (!platform.SupplyLimitModule) {
    throw new Error('SupplyLimitModule not found in deployments.');
  }
  if (!amoy.Stablecoin) {
    throw new Error('No Stablecoin recorded in deployments/amoy.json.');
  }
  if (existingAssets[ASSET_SALT]) {
    throw new Error(`"${ASSET_SALT}" already exists - change ASSET_SALT.`);
  }

  const gasPrice = await getGasPrice();
  console.log(`Creating music asset "${ASSET_SALT}"...`);
  console.log('Deployer:', deployer.address);

  const assetFactory = await ethers.getContractAt('AssetFactory', platform.AssetFactory);
  const supplyLimitModule = await ethers.getContractAt('SupplyLimitModule', platform.SupplyLimitModule);

  const claimTopic = ethers.utils.keccak256(ethers.utils.toUtf8Bytes('KYC_CLAIM'));
  const ASSET_TYPE_MUSIC = ethers.utils.formatBytes32String('MUSIC');
  const DECIMALS = 0; // Assuming Music assets are non-fractional for this test, or adjust to 6/18

  const tokenDetails = {
    owner: ethers.constants.AddressZero,
    name: `Music ${ASSET_SALT}`,
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
    assetType: ASSET_TYPE_MUSIC,
    paymentToken: amoy.Stablecoin,
    mode: 0, // AssetVault.PaymentMode.STABLECOIN_DIRECT
    price: ethers.utils.parseUnits(PRICE_USDC, 6),
    charityWallet: ethers.constants.AddressZero,
    admin: deployer.address,
    metadataURI: `ipfs://${ASSET_SALT.toLowerCase()}-metadata`,
  };

  console.log('\nCreating asset via AssetFactory...');
  const tx = await assetFactory.connect(deployer).createAsset(params, tokenDetails, claimDetails, { gasPrice });
  console.log('  Creation Tx Hash: ', tx.hash);
  const receipt = await tx.wait();
  const event = receipt.events?.find((e: any) => e.event === 'AssetCreated');
  const [assetId, , tokenAddress, vaultAddress, treasuryAddress, distributorAddress] = event!.args as any;

  console.log('  assetId:    ', assetId);
  console.log('  token:      ', tokenAddress);
  console.log('  vault:      ', vaultAddress);
  console.log('  treasury:   ', treasuryAddress);
  console.log('  distributor:', distributorAddress);

  const token = await ethers.getContractAt('Token', tokenAddress);
  const complianceAddress = await token.compliance();
  const compliance = await ethers.getContractAt('ModularCompliance', complianceAddress);

  console.log(`\nCompliance contract: ${complianceAddress}`);

  console.log('\nVerifying SupplyLimitModule binding...');
  const isBound = await compliance.isModuleBound(platform.SupplyLimitModule);
  console.log(`  Is SupplyLimitModule bound to Compliance? ${isBound}`);

  if (!isBound) {
    throw new Error('SupplyLimitModule was not bound by AssetFactory!');
  }

  console.log('\nSetting supply limit via ModularCompliance.callModuleFunction...');
  
  // Encode the call to setSupplyLimit(uint256)
  const limitAmount = ethers.utils.parseUnits(SUPPLY_LIMIT, DECIMALS);
  const callData = supplyLimitModule.interface.encodeFunctionData('setSupplyLimit', [limitAmount]);

  // Ensure deployer is owner of compliance contract!
  // Note: AssetFactory._handOver sets admin (deployer) as owner of the token and compliance contracts
  const complianceOwner = await compliance.owner();
  console.log(`  Compliance Owner: ${complianceOwner}`);
  console.log(`  Deployer Address: ${deployer.address}`);

  if (complianceOwner !== deployer.address) {
    throw new Error('Deployer is not the owner of the Compliance contract');
  }

  // Call the module function through the compliance contract
  const setLimitTx = await compliance.connect(deployer).callModuleFunction(callData, platform.SupplyLimitModule, { gasPrice });
  console.log('  Set Limit Tx Hash: ', setLimitTx.hash);
  await setLimitTx.wait();

  console.log(`  Successfully set supply limit to ${SUPPLY_LIMIT}`);

  // Verify the supply limit was set correctly
  const fetchedLimit = await supplyLimitModule.getSupplyLimit(complianceAddress);
  console.log(`  Fetched Supply Limit from module: ${ethers.utils.formatUnits(fetchedLimit, DECIMALS)}`);

  if (fetchedLimit.toString() !== limitAmount.toString()) {
    throw new Error('Supply limit mismatch after setting.');
  }

  await (await token.connect(deployer).unpause({ gasPrice })).wait();
  console.log('\nToken unpaused.');

  writeAssetRecord(ASSET_SALT, {
    assetId,
    token: tokenAddress,
    vault: vaultAddress,
    treasury: treasuryAddress,
    distributor: distributorAddress,
    compliance: complianceAddress,
    supplyLimit: SUPPLY_LIMIT,
  });

  console.log(`\n"${ASSET_SALT}" is live, Supply Limit configured, and saved to deployments/music-assets-amoy.json`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
