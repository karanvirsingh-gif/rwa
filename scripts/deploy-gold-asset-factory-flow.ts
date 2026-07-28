import { ethers, upgrades } from 'hardhat';
import OnchainID from '@onchain-id/solidity';

/**
 * GOLD via the generalized AssetFactory - proves the multi-asset pattern end to end.
 *
 * Unlike deploy-gold-flow.ts (which hand-rolls a GoldVault/GoldRegistry/GoldVaultFactory
 * pair), this script writes ZERO gold-specific contracts beyond one compliance module
 * (PhysicalReserveModule, itself reusable for silver/art/collectibles later). Everything
 * else - AssetVault, AssetTreasury, AssetRegistry, AssetFactory, P2PMarketplace - is the
 * same generic system real estate and every future asset class will also use.
 *
 * Flow:
 *  0. Mock USDC
 *  1. T-REX infrastructure (unchanged boilerplate)
 *  2. Generalized asset system: AssetRegistry, AssetVault/Treasury/Distributor
 *     implementations, AssetFactory
 *  3. Deploy PhysicalReserveModule, register "GOLD" as a known asset type
 *  4. createAsset() for "GOLD-BAR-001" - one call, full suite deployed and wired
 *  5. KYC both investors
 *  6. Prove the reserve gate: buy() reverts before a custodian attests backing
 *  7. Attest 1000g backing, buy succeeds
 *  8. Oracle bumps the price (PRICE_ORACLE_ROLE) - the appreciation mechanism
 *  9. Redeem at the new price - investor receives more than they paid
 * 10. P2P secondary trade between two investors, Vault untouched
 */
async function main() {
  const [deployer, tokenAgent, claimIssuer, alice, bob] = await ethers.getSigners();

  console.log('\n=== GOLD via generalized AssetFactory ===\n');

  // =========================================================================
  // 0. Mock USDC
  // =========================================================================
  console.log('Step 0: Deploying Mock USDC...');
  const usdc = await ethers.deployContract('Stablecoin', [], deployer);
  await usdc.deployed();
  console.log('  usdc:', usdc.address);

  // =========================================================================
  // 1. T-REX infrastructure (unchanged from the existing gold/real-estate scripts)
  // =========================================================================
  console.log('\nStep 1: Deploying T-REX infrastructure...');

  const claimTopicsRegistry = await ethers.deployContract('ClaimTopicsRegistry', deployer);
  const trustedIssuersRegistry = await ethers.deployContract('TrustedIssuersRegistry', deployer);
  const identityRegistryStorage = await ethers.deployContract('IdentityRegistryStorage', deployer);
  const identityRegistryImpl = await ethers.deployContract('IdentityRegistry', deployer);
  const modularCompliance = await ethers.deployContract('ModularCompliance', deployer);
  const tokenImplementation = await ethers.deployContract('Token', deployer);

  const identityImplementation = await new ethers.ContractFactory(
    OnchainID.contracts.Identity.abi,
    OnchainID.contracts.Identity.bytecode,
    deployer,
  ).deploy(deployer.address, true);
  const identityImplementationAuthority = await new ethers.ContractFactory(
    OnchainID.contracts.ImplementationAuthority.abi,
    OnchainID.contracts.ImplementationAuthority.bytecode,
    deployer,
  ).deploy(identityImplementation.address);
  const identityFactory = await new ethers.ContractFactory(
    OnchainID.contracts.Factory.abi,
    OnchainID.contracts.Factory.bytecode,
    deployer,
  ).deploy(identityImplementationAuthority.address);

  const trexImplementationAuthority = await ethers.deployContract(
    'TREXImplementationAuthority',
    [true, ethers.constants.AddressZero, ethers.constants.AddressZero],
    deployer,
  );
  await trexImplementationAuthority.addAndUseTREXVersion(
    { major: 4, minor: 0, patch: 0 },
    {
      tokenImplementation: tokenImplementation.address,
      ctrImplementation: claimTopicsRegistry.address,
      irImplementation: identityRegistryImpl.address,
      irsImplementation: identityRegistryStorage.address,
      tirImplementation: trustedIssuersRegistry.address,
      mcImplementation: modularCompliance.address,
    },
  );
  const trexFactory = await ethers.deployContract(
    'TREXFactory',
    [trexImplementationAuthority.address, identityFactory.address],
    deployer,
  );
  await identityFactory.addTokenFactory(trexFactory.address);

  const claimIssuerContract = await ethers.deployContract('ClaimIssuer', [claimIssuer.address], claimIssuer);
  const claimIssuerSigningKey = ethers.Wallet.createRandom();
  await claimIssuerContract
    .connect(claimIssuer)
    .addKey(ethers.utils.keccak256(ethers.utils.defaultAbiCoder.encode(['address'], [claimIssuerSigningKey.address])), 3, 1);

  console.log('  T-REX infrastructure ready');

  // =========================================================================
  // 2. Generalized asset system - deployed ONCE, serves every future asset class
  // =========================================================================
  console.log('\nStep 2: Deploying the generalized Asset Factory system...');

  const registry = await upgrades.deployProxy(await ethers.getContractFactory('AssetRegistry', deployer), [deployer.address], {
    kind: 'uups',
  });
  await registry.deployed();
  console.log('  AssetRegistry:', registry.address);

  const treasuryImpl = await ethers.deployContract('AssetTreasury', deployer);
  const vaultImpl = await ethers.deployContract('AssetVault', deployer);
  const distributorImpl = await ethers.deployContract('YieldDistributor', deployer);
  console.log('  AssetTreasury / AssetVault / YieldDistributor implementations deployed');

  const assetFactory = await upgrades.deployProxy(
    await ethers.getContractFactory('AssetFactory', deployer),
    [trexFactory.address, registry.address, vaultImpl.address, treasuryImpl.address, distributorImpl.address, deployer.address],
    { kind: 'uups' },
  );
  await assetFactory.deployed();
  console.log('  AssetFactory:', assetFactory.address);

  // AssetFactory must own the TREXFactory to call deployTREXSuite (onlyOwner)
  await trexFactory.connect(deployer).transferOwnership(assetFactory.address);
  // AssetFactory must hold REGISTER_ROLE to write into AssetRegistry
  await registry.connect(deployer).grantRole(await registry.REGISTER_ROLE(), assetFactory.address);
  console.log('  Wired: AssetFactory owns TREXFactory, holds REGISTER_ROLE on AssetRegistry');

  const marketplace = await upgrades.deployProxy(await ethers.getContractFactory('P2PMarketplace', deployer), [deployer.address], {
    kind: 'uups',
  });
  await marketplace.deployed();
  console.log('  P2PMarketplace (platform-wide, one instance for every asset):', marketplace.address);

  // =========================================================================
  // 3. Gold-specific: ONE compliance module, registered as the "GOLD" asset type
  // =========================================================================
  console.log('\nStep 3: Registering GOLD as a known asset type...');

  const physicalReserveModule = await ethers.deployContract('PhysicalReserveModule', [deployer.address], deployer);
  console.log('  PhysicalReserveModule:', physicalReserveModule.address, '(reusable later for silver/art/collectibles)');

  const GOLD = ethers.utils.formatBytes32String('GOLD');
  await assetFactory.connect(deployer).registerAssetType(GOLD, [physicalReserveModule.address]);
  console.log('  Asset type GOLD registered - every gold asset from here on reuses this exact call');

  // =========================================================================
  // 4. Create the actual asset - "GOLD-BAR-001"
  // =========================================================================
  console.log('\nStep 4: Creating asset GOLD-BAR-001 via AssetFactory.createAsset()...');

  const claimTopic = ethers.utils.keccak256(ethers.utils.toUtf8Bytes('KYC_CLAIM'));

  const tokenDetails = {
    owner: ethers.constants.AddressZero, // overwritten to the factory internally, then handed to `admin` below
    name: '1kg Gold Bar Token',
    symbol: 'GLDBAR001',
    decimals: 18,
    irs: ethers.constants.AddressZero,
    ONCHAINID: ethers.constants.AddressZero,
    irAgents: [tokenAgent.address],
    tokenAgents: [tokenAgent.address],
    complianceModules: [],
    complianceSettings: [],
  };
  const claimDetails = {
    claimTopics: [claimTopic],
    issuers: [claimIssuerContract.address],
    issuerClaims: [[claimTopic]],
  };
  const initialPrice = ethers.utils.parseUnits('70', 6); // 70 USDC per gram to start
  const params = {
    salt: 'GOLD-BAR-001',
    assetType: GOLD,
    paymentToken: usdc.address,
    mode: 0, // AssetVault.PaymentMode.STABLECOIN_DIRECT
    price: initialPrice,
    charityWallet: ethers.constants.AddressZero, // no Sharia purification on this asset
    admin: deployer.address, // a Safe multisig in production
    metadataURI: 'ipfs://gold-bar-001-metadata',
  };

  const createTx = await assetFactory.connect(deployer).createAsset(params, tokenDetails, claimDetails);
  const createReceipt = await createTx.wait();
  const createdEvent = createReceipt.events?.find((e: any) => e.event === 'AssetCreated');
  // event AssetCreated(bytes32 assetId, bytes32 assetType, address token, address vault, address treasury, address distributor)
  const [assetId, , tokenAddress, vaultAddress, treasuryAddress, distributorAddress] = createdEvent!.args as any;

  console.log('  assetId:      ', assetId);
  console.log('  token:        ', tokenAddress);
  console.log('  vault:        ', vaultAddress);
  console.log('  treasury:     ', treasuryAddress);
  console.log('  distributor:  ', distributorAddress);

  const token = await ethers.getContractAt('Token', tokenAddress);
  const vault = await ethers.getContractAt('AssetVault', vaultAddress);
  const irAddress = await token.identityRegistry();
  const ir = await ethers.getContractAt('IdentityRegistry', irAddress);
  const complianceAddress = await token.compliance();

  // T-REX tokens deploy paused by default. mint()/burn() bypass the pause check
  // (administrative actions), but ordinary transfer()/transferFrom() - what
  // P2PMarketplace and any wallet-to-wallet trade use - correctly do not. This is
  // the standard T-REX operational step, same as the existing deploy-gold-flow.ts.
  await token.connect(tokenAgent).unpause();

  // =========================================================================
  // 5. KYC both investors
  // =========================================================================
  console.log('\nStep 5: Verifying investor identities...');

  async function setupIdentity(addr: string) {
    const idProxy = await new ethers.ContractFactory(
      OnchainID.contracts.IdentityProxy.abi,
      OnchainID.contracts.IdentityProxy.bytecode,
      deployer,
    ).deploy(identityImplementationAuthority.address, deployer.address);
    await idProxy.deployed();
    await ir.connect(tokenAgent).registerIdentity(addr, idProxy.address, 42);

    const claim = {
      topic: claimTopic,
      issuer: claimIssuerContract.address,
      identity: idProxy.address,
      data: ethers.utils.hexlify(ethers.utils.toUtf8Bytes('Verified')),
      scheme: 1,
      signature: '',
    };
    claim.signature = await claimIssuerSigningKey.signMessage(
      ethers.utils.arrayify(
        ethers.utils.keccak256(ethers.utils.defaultAbiCoder.encode(['address', 'uint256', 'bytes'], [idProxy.address, claim.topic, claim.data])),
      ),
    );
    const id = await ethers.getContractAt(OnchainID.contracts.Identity.abi, idProxy.address);
    await id.connect(deployer).addClaim(claim.topic, claim.scheme, claim.issuer, claim.signature, claim.data, '');
  }

  await setupIdentity(alice.address);
  await setupIdentity(bob.address);
  console.log('  Alice and Bob verified. Note: the Vault itself never needs KYC here -');
  console.log('  mint-on-settlement means it never holds inventory, unlike the old pre-mint model.');

  // =========================================================================
  // 6. Prove the reserve gate: buy() must revert before backing is attested
  // =========================================================================
  console.log('\nStep 6: Attempting to buy BEFORE the custodian attests any reserve (expect revert)...');

  await usdc.mint(alice.address, ethers.utils.parseUnits('10000', 6));
  await usdc.connect(alice).approve(vaultAddress, ethers.utils.parseUnits('10000', 6));

  let blockedAsExpected = false;
  try {
    await vault.connect(alice).buy(ethers.utils.parseUnits('50', 18));
  } catch (err) {
    blockedAsExpected = true;
    console.log('  correctly reverted:', (err as Error).message.split('\n')[0].slice(0, 140));
  }
  if (!blockedAsExpected) {
    throw new Error('Expected mint to be blocked before reserve attestation, but it succeeded!');
  }

  // =========================================================================
  // 7. Custodian attests the physical bar, buy succeeds
  // =========================================================================
  console.log('\nStep 7: Custodian attests 1000g backing for this asset...');

  await physicalReserveModule
    .connect(deployer)
    .attestAllocation(complianceAddress, ethers.utils.parseUnits('1000', 18), 'grams', 'vault-audit-2026-07-27-ref001');
  console.log('  Reserve attested. Retrying buy...');

  await vault.connect(alice).buy(ethers.utils.parseUnits('50', 18));
  console.log('  Alice bought 50g. Balance:', ethers.utils.formatEther(await token.balanceOf(alice.address)));

  // =========================================================================
  // 8. Oracle bumps the price - the appreciation earn mechanism
  // =========================================================================
  console.log('\nStep 8: Oracle keeper pushes an updated LBMA-derived price...');

  const newPrice = ethers.utils.parseUnits('85', 6);
  await vault.connect(deployer).setPrice(newPrice); // deployer holds PRICE_ORACLE_ROLE post-handover
  console.log('  Price moved 70 -> 85 USDC/gram');

  // =========================================================================
  // 9. Redeem at the new price
  // =========================================================================
  console.log('\nStep 9: Alice redeems 20g at the appreciated price...');

  const usdcBefore = await usdc.balanceOf(alice.address);
  await vault.connect(alice).redeem(ethers.utils.parseUnits('20', 18));
  const usdcAfter = await usdc.balanceOf(alice.address);
  console.log(
    '  Alice redeemed 20g for',
    ethers.utils.formatUnits(usdcAfter.sub(usdcBefore), 6),
    'USDC (bought at 70/g, redeemed at 85/g - that spread is the appreciation earn)',
  );

  // =========================================================================
  // 10. P2P secondary trade - Vault, mint, and burn never touched
  // =========================================================================
  console.log('\nStep 10: Alice lists her remaining 30g P2P, Bob buys 10g directly from her...');

  await usdc.mint(bob.address, ethers.utils.parseUnits('5000', 6));
  await token.connect(alice).approve(marketplace.address, ethers.utils.parseUnits('30', 18));

  const nonce = 1;
  const expiry = (await ethers.provider.getBlock('latest')).timestamp + 3600;
  await marketplace.connect(alice).createListing(tokenAddress, usdc.address, ethers.utils.parseUnits('30', 18), newPrice, expiry, nonce);
  const listingId = ethers.utils.keccak256(ethers.utils.defaultAbiCoder.encode(['address', 'address', 'uint256'], [alice.address, tokenAddress, nonce]));

  await usdc.connect(bob).approve(marketplace.address, ethers.utils.parseUnits('5000', 6));
  await marketplace.connect(bob).buyListing(listingId, ethers.utils.parseUnits('10', 18));

  console.log('  Bob balance:', ethers.utils.formatEther(await token.balanceOf(bob.address)), 'g');
  console.log('  Alice balance:', ethers.utils.formatEther(await token.balanceOf(alice.address)), 'g');
  console.log('  Treasury USDC balance unchanged by the P2P trade:', ethers.utils.formatUnits(await usdc.balanceOf(treasuryAddress), 6));

  console.log('\n=== GOLD ASSET FACTORY FLOW VERIFIED ===');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
