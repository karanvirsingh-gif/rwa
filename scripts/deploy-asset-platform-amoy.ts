import { ethers } from 'hardhat';
import OnchainID from '@onchain-id/solidity';
import * as fs from 'fs';
import * as path from 'path';

/**
 * ONE-TIME setup for the generalized Asset Factory system on Amoy - AssetRegistry,
 * AssetFactory, the AssetVault/AssetTreasury/YieldDistributor implementations,
 * P2PMarketplace, and PhysicalReserveModule (gold today, silver/art reuse it
 * unchanged later).
 *
 * Deploys its OWN dedicated T-REX infrastructure rather than reusing the real
 * estate deployment's TREXFactory from deployments/amoy.json. Reason:
 * TREXFactory.deployTREXSuite is onlyOwner, and AssetFactory must BE that owner to
 * work. Transferring ownership of the real estate system's TREXFactory would break
 * add-property-amoy.ts's ability to create new properties going forward. Keeping
 * them fully separate means the existing real estate deployment is never touched.
 *
 * Run once:    npx hardhat run scripts/deploy-asset-platform-amoy.ts --network polygon
 * Safe to re-run: every step is idempotent and skips anything already recorded.
 */

const DELAY_MS = 2000;
const deploymentPath = path.join(__dirname, '../deployments/asset-platform-amoy.json');
const realEstateDeploymentPath = path.join(__dirname, '../deployments/amoy.json');

async function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getGasPrice() {
  const feeData = await ethers.provider.getFeeData();
  return feeData.gasPrice?.mul(150).div(100) || ethers.utils.parseUnits('35', 'gwei');
}

function saveAddress(key: string, address: string) {
  let addresses: any = {};
  if (fs.existsSync(deploymentPath)) {
    addresses = JSON.parse(fs.readFileSync(deploymentPath, 'utf8'));
  } else if (!fs.existsSync(path.dirname(deploymentPath))) {
    fs.mkdirSync(path.dirname(deploymentPath), { recursive: true });
  }
  addresses[key] = address;
  fs.writeFileSync(deploymentPath, JSON.stringify(addresses, null, 2));
}

function getAddress(key: string): string | undefined {
  if (fs.existsSync(deploymentPath)) {
    return JSON.parse(fs.readFileSync(deploymentPath, 'utf8'))[key];
  }
  return undefined;
}

/** Read-only - never writes back to the real estate deployment file. */
function getRealEstateAddress(key: string): string | undefined {
  if (fs.existsSync(realEstateDeploymentPath)) {
    return JSON.parse(fs.readFileSync(realEstateDeploymentPath, 'utf8'))[key];
  }
  return undefined;
}

async function deployWithRetry(key: string, factory: any, args: any[], gasPrice: any, retries = 3): Promise<any> {
  const existing = getAddress(key);
  if (existing) {
    console.log(`  Skipping ${key} (already at ${existing})`);
    return ethers.getContractAt(factory.interface, existing);
  }

  for (let i = 0; i < retries; i++) {
    try {
      const contract = await factory.deploy(...args, { gasPrice });
      await contract.deployed();
      saveAddress(key, contract.address);
      console.log(`  ${key}:`, contract.address);
      await delay(DELAY_MS);
      return contract;
    } catch (error: any) {
      if (i === retries - 1) throw error;
      console.log(`  Deploy ${key} failed (attempt ${i + 1}/${retries}). Retrying in 5s...`);
      await delay(5000);
    }
  }
}

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log('Deploying the generalized Asset Factory platform to Amoy...');
  console.log('Deployer:', deployer.address);

  const gasPrice = await getGasPrice();
  console.log('Gas price:', ethers.utils.formatUnits(gasPrice, 'gwei'), 'gwei');

  const usdcAddress = getRealEstateAddress('Stablecoin');
  if (!usdcAddress) {
    throw new Error('No Stablecoin recorded in deployments/amoy.json - run deploy-amoy.ts first, or record one manually.');
  }
  console.log('Reusing the existing Stablecoin (a shared payment token, not a real-estate contract):', usdcAddress);

  // =========================================================================
  // Step 1: Dedicated T-REX infrastructure for this system
  // =========================================================================
  console.log("\nStep 1: Dedicated T-REX infrastructure (separate from real estate's)...");

  const ctr = await deployWithRetry('CTR', await ethers.getContractFactory('ClaimTopicsRegistry', deployer), [], gasPrice);
  const tir = await deployWithRetry('TIR', await ethers.getContractFactory('TrustedIssuersRegistry', deployer), [], gasPrice);
  const irs = await deployWithRetry('IRS', await ethers.getContractFactory('IdentityRegistryStorage', deployer), [], gasPrice);
  const irImpl = await deployWithRetry('IdentityRegistryImpl', await ethers.getContractFactory('IdentityRegistry', deployer), [], gasPrice);
  const mc = await deployWithRetry('ModularCompliance', await ethers.getContractFactory('ModularCompliance', deployer), [], gasPrice);
  const tokenImpl = await deployWithRetry('TokenImplementation', await ethers.getContractFactory('Token', deployer), [], gasPrice);

  const Identity = new ethers.ContractFactory(OnchainID.contracts.Identity.abi, OnchainID.contracts.Identity.bytecode, deployer);
  const identityImpl = await deployWithRetry('IdentityImpl', Identity, [deployer.address, true], gasPrice);

  const Authority = new ethers.ContractFactory(OnchainID.contracts.ImplementationAuthority.abi, OnchainID.contracts.ImplementationAuthority.bytecode, deployer);
  const authority = await deployWithRetry('IdentityImplementationAuthority', Authority, [identityImpl.address], gasPrice);

  const IdFactory = new ethers.ContractFactory(OnchainID.contracts.Factory.abi, OnchainID.contracts.Factory.bytecode, deployer);
  const identityFactory = await deployWithRetry('IdentityFactory', IdFactory, [authority.address], gasPrice);

  const trexAuthority = await deployWithRetry(
    'TREXAuthority',
    await ethers.getContractFactory('TREXImplementationAuthority', deployer),
    [true, ethers.constants.AddressZero, ethers.constants.AddressZero],
    gasPrice,
  );

  if (!getAddress('TrexVersionSet')) {
    const tx = await trexAuthority.addAndUseTREXVersion(
      { major: 4, minor: 0, patch: 0 },
      {
        tokenImplementation: tokenImpl.address,
        ctrImplementation: ctr.address,
        irImplementation: irImpl.address,
        irsImplementation: irs.address,
        tirImplementation: tir.address,
        mcImplementation: mc.address,
      },
      { gasPrice },
    );
    await tx.wait();
    saveAddress('TrexVersionSet', 'true');
    await delay(DELAY_MS);
  }

  const trexFactory = await deployWithRetry(
    'TrexFactory',
    await ethers.getContractFactory('TREXFactory', deployer),
    [trexAuthority.address, identityFactory.address],
    gasPrice,
  );

  const claimIssuer = await deployWithRetry(
    'ClaimIssuer',
    new ethers.ContractFactory(OnchainID.contracts.ClaimIssuer.abi, OnchainID.contracts.ClaimIssuer.bytecode, deployer),
    [deployer.address],
    gasPrice,
  );

  if (!getAddress('ClaimSignerSet')) {
    const managerKey = ethers.utils.keccak256(ethers.utils.defaultAbiCoder.encode(['address'], [deployer.address]));
    const tx = await claimIssuer.addKey(managerKey, 3, 1, { gasPrice });
    await tx.wait();
    saveAddress('ClaimSignerSet', 'true');
    await delay(DELAY_MS);
  }

  if (!getAddress('FactoryLinkSet')) {
    const tx = await identityFactory.addTokenFactory(trexFactory.address, { gasPrice });
    await tx.wait();
    saveAddress('FactoryLinkSet', 'true');
    await delay(DELAY_MS);
  }

  console.log('  Dedicated T-REX infrastructure ready.');

  // =========================================================================
  // Step 2: AssetRegistry (manual UUPS proxy, matching this repo's Amoy convention)
  // =========================================================================
  console.log('\nStep 2: AssetRegistry...');
  const ProxyFactory = await ethers.getContractFactory('ERC1967Proxy', deployer);

  const registryImpl = await deployWithRetry('AssetRegistryImpl', await ethers.getContractFactory('AssetRegistry', deployer), [], gasPrice);
  if (!getAddress('AssetRegistry')) {
    const initData = registryImpl.interface.encodeFunctionData('initialize', [deployer.address]);
    const proxy = await ProxyFactory.deploy(registryImpl.address, initData, { gasPrice });
    await proxy.deployed();
    saveAddress('AssetRegistry', proxy.address);
    console.log('  AssetRegistry:', proxy.address);
    await delay(DELAY_MS);
  }
  const registry = await ethers.getContractAt('AssetRegistry', getAddress('AssetRegistry')!);

  // =========================================================================
  // Step 3: Asset implementations (plain deploys - AssetFactory proxies these per asset)
  // =========================================================================
  console.log('\nStep 3: AssetTreasury / AssetVault / YieldDistributor implementations...');
  const treasuryImpl = await deployWithRetry('AssetTreasuryImpl', await ethers.getContractFactory('AssetTreasury', deployer), [], gasPrice);
  const vaultImpl = await deployWithRetry('AssetVaultImpl', await ethers.getContractFactory('AssetVault', deployer), [], gasPrice);
  const distributorImpl = await deployWithRetry('YieldDistributorImpl', await ethers.getContractFactory('YieldDistributor', deployer), [], gasPrice);

  // =========================================================================
  // Step 4: AssetFactory
  // =========================================================================
  console.log('\nStep 4: AssetFactory...');
  const factoryImpl = await deployWithRetry('AssetFactoryImpl', await ethers.getContractFactory('AssetFactory', deployer), [], gasPrice);
  if (!getAddress('AssetFactory')) {
    const initData = factoryImpl.interface.encodeFunctionData('initialize', [
      trexFactory.address,
      registry.address,
      vaultImpl.address,
      treasuryImpl.address,
      distributorImpl.address,
      deployer.address,
    ]);
    const proxy = await ProxyFactory.deploy(factoryImpl.address, initData, { gasPrice });
    await proxy.deployed();
    saveAddress('AssetFactory', proxy.address);
    console.log('  AssetFactory:', proxy.address);
    await delay(DELAY_MS);
  }
  const assetFactory = await ethers.getContractAt('AssetFactory', getAddress('AssetFactory')!);

  // =========================================================================
  // Step 5: Wiring - one-time, guarded so re-runs are safe
  // =========================================================================
  console.log('\nStep 5: Wiring...');
  if (!getAddress('TrexFactoryOwnershipTransferred')) {
    const tx = await trexFactory.connect(deployer).transferOwnership(assetFactory.address, { gasPrice });
    await tx.wait();
    saveAddress('TrexFactoryOwnershipTransferred', 'true');
    console.log('  AssetFactory now owns this dedicated TREXFactory');
    await delay(DELAY_MS);
  }
  if (!getAddress('RegisterRoleGranted')) {
    const tx = await registry.connect(deployer).grantRole(await registry.REGISTER_ROLE(), assetFactory.address, { gasPrice });
    await tx.wait();
    saveAddress('RegisterRoleGranted', 'true');
    console.log('  AssetFactory holds REGISTER_ROLE on AssetRegistry');
    await delay(DELAY_MS);
  }

  // =========================================================================
  // Step 6: P2PMarketplace - one instance, shared by every asset ever created
  // =========================================================================
  console.log('\nStep 6: P2PMarketplace...');
  const marketplaceImpl = await deployWithRetry('P2PMarketplaceImpl', await ethers.getContractFactory('P2PMarketplace', deployer), [], gasPrice);
  if (!getAddress('P2PMarketplace')) {
    const initData = marketplaceImpl.interface.encodeFunctionData('initialize', [deployer.address]);
    const proxy = await ProxyFactory.deploy(marketplaceImpl.address, initData, { gasPrice });
    await proxy.deployed();
    saveAddress('P2PMarketplace', proxy.address);
    console.log('  P2PMarketplace:', proxy.address);
    await delay(DELAY_MS);
  }

  // =========================================================================
  // Step 7: PhysicalReserveModule + register GOLD as a known asset type
  // =========================================================================
  console.log('\nStep 7: PhysicalReserveModule + registering GOLD...');
  const physicalReserveModule = await deployWithRetry(
    'PhysicalReserveModule',
    await ethers.getContractFactory('PhysicalReserveModule', deployer),
    [deployer.address],
    gasPrice,
  );
  if (!getAddress('GoldAssetTypeRegistered')) {
    const GOLD = ethers.utils.formatBytes32String('GOLD');
    const tx = await assetFactory.connect(deployer).registerAssetType(GOLD, [physicalReserveModule.address], { gasPrice });
    await tx.wait();
    saveAddress('GoldAssetTypeRegistered', 'true');
    console.log('  GOLD registered - every gold asset from here on reuses this exact module');
    await delay(DELAY_MS);
  }

  // =========================================================================
  // Step 8: Generic business-rule modules - NOT tied to "GOLD", reusable by any
  // future asset type. Configured per-asset (country list, balance cap) at
  // createAsset() time via tokenDetails.complianceModules/complianceSettings,
  // unlike PhysicalReserveModule which binds automatically to every GOLD asset.
  // =========================================================================
  console.log('\nStep 8: Country/max-balance modules (reusable across every future asset)...');
  const countryAllowModule = await deployWithRetry(
    'CountryAllowModule',
    await ethers.getContractFactory('CountryAllowModule', deployer),
    [],
    gasPrice,
  );
  const maxBalanceModule = await deployWithRetry(
    'MaxBalanceModule',
    await ethers.getContractFactory('MaxBalanceModule', deployer),
    [],
    gasPrice,
  );
  const minimumInvestmentModule = await deployWithRetry(
    'MinimumInvestmentModule',
    await ethers.getContractFactory('MinimumInvestmentModule', deployer),
    [],
    gasPrice,
  );
  console.log('  CountryAllowModule:     ', countryAllowModule.address);
  console.log('  MaxBalanceModule:       ', maxBalanceModule.address);
  console.log('  MinimumInvestmentModule:', minimumInvestmentModule.address);
  console.log('  Reference these in complianceModules/complianceSettings for any new asset - no contract changes, ever.');

  console.log('\nAsset Factory platform is live on Amoy. Addresses saved to deployments/asset-platform-amoy.json');
  console.log('Next: npx hardhat run scripts/create-gold-asset-amoy.ts --network polygon');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
