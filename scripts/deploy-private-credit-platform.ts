import { ethers, upgrades } from 'hardhat';
import OnchainID from '@onchain-id/solidity';

/**
 * PRIVATE CREDIT via the generalized AssetFactory - End-to-End Flow.
 *
 * This script proves that Private Credit can operate entirely on the generic
 * AssetVault and AssetTreasury components, using ONLY the PrivateCreditStateModule
 * to enforce the specialized Escrow, Funding, and Maturity logic.
 */
async function main() {
  const [deployer, tokenAgent, claimIssuer, alice, bob, borrower] = await ethers.getSigners();

  console.log('\n=== PRIVATE CREDIT via generalized AssetFactory ===\n');

  // =========================================================================
  // 0. Mock USDC
  // =========================================================================
  console.log('Step 0: Deploying Mock USDC...');
  const usdc = await ethers.deployContract('Stablecoin', [], deployer);
  await usdc.deployed();
  console.log('  usdc:', usdc.address);

  // =========================================================================
  // 1. T-REX infrastructure
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
  // 2. Generalized asset system
  // =========================================================================
  console.log('\nStep 2: Deploying the generalized Asset Factory system...');

  const registry = await upgrades.deployProxy(await ethers.getContractFactory('AssetRegistry', deployer), [deployer.address], {
    kind: 'uups',
  });
  await registry.deployed();

  const treasuryImpl = await ethers.deployContract('AssetTreasury', deployer);
  const vaultImpl = await ethers.deployContract('AssetVault', deployer);
  const distributorImpl = await ethers.deployContract('YieldDistributor', deployer);

  const assetFactory = await upgrades.deployProxy(
    await ethers.getContractFactory('AssetFactory', deployer),
    [trexFactory.address, registry.address, vaultImpl.address, treasuryImpl.address, distributorImpl.address, deployer.address],
    { kind: 'uups' },
  );
  await assetFactory.deployed();

  await trexFactory.connect(deployer).transferOwnership(assetFactory.address);
  await registry.connect(deployer).grantRole(await registry.REGISTER_ROLE(), assetFactory.address);
  console.log('  AssetFactory fully wired.');

  // =========================================================================
  // 3. Register PRIVATE_CREDIT Asset Type
  // =========================================================================
  console.log('\nStep 3: Registering PRIVATE_CREDIT asset type with new State Module...');
  
  const stateModule = await ethers.deployContract('PrivateCreditStateModule', deployer);
  await stateModule.deployed();
  
  const PRIVATE_CREDIT = ethers.utils.formatBytes32String('PRIVATE_CREDIT');
  await assetFactory.connect(deployer).registerAssetType(PRIVATE_CREDIT, [stateModule.address]);
  console.log('  PrivateCreditStateModule bound and type registered.');

  // =========================================================================
  // 4. Create the actual credit asset - "CORP-LOAN-001"
  // =========================================================================
  console.log('\nStep 4: Creating asset CORP-LOAN-001 via AssetFactory.createAsset()...');

  const claimTopic = ethers.utils.keccak256(ethers.utils.toUtf8Bytes('KYC_CLAIM'));
  const tokenDetails = {
    owner: ethers.constants.AddressZero, 
    name: 'Tech Startup Expansion Loan',
    symbol: 'LOAN001',
    decimals: 6, // Match USDC decimals for 1:1 price
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
  
  // 1 token = 1 USDC
  const initialPrice = ethers.utils.parseUnits('1', 6); 
  const params = {
    salt: 'CORP-LOAN-001',
    assetType: PRIVATE_CREDIT,
    paymentToken: usdc.address,
    mode: 0, // STABLECOIN_DIRECT
    price: initialPrice,
    charityWallet: ethers.constants.AddressZero,
    admin: deployer.address,
    metadataURI: 'ipfs://corp-loan-metadata',
  };

  const createTx = await assetFactory.connect(deployer).createAsset(params, tokenDetails, claimDetails);
  const createReceipt = await createTx.wait();
  const createdEvent = createReceipt.events?.find((e: any) => e.event === 'AssetCreated');
  const [assetId, , tokenAddress, vaultAddress, treasuryAddress, distributorAddress] = createdEvent!.args as any;

  console.log('  token:        ', tokenAddress);
  console.log('  vault:        ', vaultAddress);
  console.log('  treasury:     ', treasuryAddress);

  const token = await ethers.getContractAt('Token', tokenAddress);
  const vault = await ethers.getContractAt('AssetVault', vaultAddress);
  const treasury = await ethers.getContractAt('AssetTreasury', treasuryAddress);
  const irAddress = await token.identityRegistry();
  const ir = await ethers.getContractAt('IdentityRegistry', irAddress);

  // Unpause token for operations
  await token.connect(tokenAgent).unpause();

  // =========================================================================
  // 5. Initialize the Loan Parameters on the State Module
  // =========================================================================
  console.log('\nStep 5: Initializing Loan Parameters on the State Module...');
  const targetPrincipal = ethers.utils.parseUnits('10000', 6); // $10,000 target
  const fundingDeadline = (await ethers.provider.getBlock('latest')).timestamp + 86400 * 7; // 7 days from now
  const maturityTimestamp = fundingDeadline + (86400 * 365); // 1 year maturity
  const paymentFrequency = 86400 * 30; // 30 days
  const couponRate = 850; // 8.5%
  const agreementHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("Master Loan Agreement v1.0 PDF Content"));

  await stateModule.connect(deployer).initializeLoan(
    tokenAddress,
    targetPrincipal,
    fundingDeadline,
    maturityTimestamp,
    paymentFrequency,
    couponRate,
    agreementHash,
    borrower.address
  );
  console.log(`  Loan target: $10,000. State is now FUNDING (Escrow Phase).`);

  // =========================================================================
  // 6. KYC Investors
  // =========================================================================
  console.log('\nStep 6: Verifying Alice and Bob...');
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

  // =========================================================================
  // 7. The Escrow Phase (Investors Buy)
  // =========================================================================
  console.log('\nStep 7: Alice buys into the loan during FUNDING phase...');
  
  await usdc.mint(alice.address, ethers.utils.parseUnits('5000', 6));
  await usdc.connect(alice).approve(vaultAddress, ethers.utils.parseUnits('5000', 6));
  
  // Alice buys 5000 tokens ($5000)
  await vault.connect(alice).buy(ethers.utils.parseUnits('5000', 6));
  console.log('  Alice bought $5000 of the loan.');
  console.log('  USDC physically held in AssetTreasury (Escrow):', ethers.utils.formatUnits(await usdc.balanceOf(treasuryAddress), 6));

  // P2P transfer should be blocked in FUNDING state
  console.log('  Attempting P2P transfer during FUNDING phase (expect revert)...');
  let blockedAsExpected = false;
  try {
    await token.connect(alice).transfer(bob.address, ethers.utils.parseUnits('100', 6));
  } catch (err) {
    blockedAsExpected = true;
    console.log('  ✓ Correctly reverted (Escrow lock enforced by StateModule)');
  }
  if (!blockedAsExpected) throw new Error('P2P should be blocked in FUNDING state!');

  // =========================================================================
  // 8. Transition to ACTIVE & Funds Release
  // =========================================================================
  console.log('\nStep 8: Target reached! Admin transitions loan to ACTIVE...');
  
  // Mint remaining $5000 from bob just to hit target exactly
  await usdc.mint(bob.address, ethers.utils.parseUnits('5000', 6));
  await usdc.connect(bob).approve(vaultAddress, ethers.utils.parseUnits('5000', 6));
  await vault.connect(bob).buy(ethers.utils.parseUnits('5000', 6));

  await stateModule.connect(deployer).transitionToActive(tokenAddress);
  console.log('  State is now ACTIVE.');

  console.log('  Admin releases Escrowed USDC to Borrower...');
  await treasury.connect(deployer).release(borrower.address, ethers.utils.parseUnits('10000', 6), 'Loan Funded');
  
  console.log('  Borrower USDC Balance:', ethers.utils.formatUnits(await usdc.balanceOf(borrower.address), 6));
  console.log('  Treasury USDC Balance:', ethers.utils.formatUnits(await treasury.balance(), 6));

  // P2P should now be unlocked
  console.log('  Attempting P2P transfer again (should succeed)...');
  await token.connect(alice).transfer(bob.address, ethers.utils.parseUnits('100', 6));
  console.log('  ✓ Alice successfully sent $100 debt tokens to Bob on secondary market.');

  console.log('\n=== PRIVATE CREDIT FLOW SUCCESSFULLY VERIFIED ===');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
