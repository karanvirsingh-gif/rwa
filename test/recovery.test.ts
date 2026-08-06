import { ethers, upgrades } from 'hardhat';
import { expect } from 'chai';
import OnchainID from '@onchain-id/solidity';

describe('Deposit and RecoveryRedeem Flow', function () {
  let deployer: any, tokenAgent: any, claimIssuer: any, alice: any, bob: any, borrower: any;
  let usdc: any, registry: any, assetFactory: any;
  let trexFactory: any, identityFactory: any, identityImplementationAuthority: any;
  let claimIssuerContract: any, claimIssuerSigningKey: any;
  let claimTopic: any;
  let lifecycleModule: any;
  
  let tokenAddress: string, vaultAddress: string, treasuryAddress: string;
  let token: any, vault: any, treasury: any, ir: any;

  before(async function () {
    [deployer, tokenAgent, claimIssuer, alice, bob, borrower] = await ethers.getSigners();

    // 1. Deploy Mock USDC
    usdc = await ethers.deployContract('Stablecoin', [], deployer);
    await usdc.deployed();

    // 2. T-REX Infrastructure
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
    identityImplementationAuthority = await new ethers.ContractFactory(
      OnchainID.contracts.ImplementationAuthority.abi,
      OnchainID.contracts.ImplementationAuthority.bytecode,
      deployer,
    ).deploy(identityImplementation.address);
    identityFactory = await new ethers.ContractFactory(
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
    trexFactory = await ethers.deployContract(
      'TREXFactory',
      [trexImplementationAuthority.address, identityFactory.address],
      deployer,
    );
    await identityFactory.addTokenFactory(trexFactory.address);

    claimIssuerContract = await ethers.deployContract('ClaimIssuer', [claimIssuer.address], claimIssuer);
    claimIssuerSigningKey = ethers.Wallet.createRandom();
    await claimIssuerContract
      .connect(claimIssuer)
      .addKey(ethers.utils.keccak256(ethers.utils.defaultAbiCoder.encode(['address'], [claimIssuerSigningKey.address])), 3, 1);
    claimTopic = ethers.utils.keccak256(ethers.utils.toUtf8Bytes('KYC_CLAIM'));

    // 3. Generalized Asset System
    registry = await upgrades.deployProxy(await ethers.getContractFactory('AssetRegistry', deployer), [deployer.address], { kind: 'uups' });
    await registry.deployed();

    const treasuryImpl = await ethers.deployContract('AssetTreasury', deployer);
    const vaultImpl = await ethers.deployContract('AssetVault', deployer);
    const distributorImpl = await ethers.deployContract('YieldDistributor', deployer);

    assetFactory = await upgrades.deployProxy(
      await ethers.getContractFactory('AssetFactory', deployer),
      [trexFactory.address, registry.address, vaultImpl.address, treasuryImpl.address, distributorImpl.address, deployer.address],
      { kind: 'uups' },
    );
    await assetFactory.deployed();

    await trexFactory.connect(deployer).transferOwnership(assetFactory.address);
    await registry.connect(deployer).grantRole(await registry.REGISTER_ROLE(), assetFactory.address);

    // 4. Deploy and Register RWALifecycleModule
    lifecycleModule = await upgrades.deployProxy(await ethers.getContractFactory('RWALifecycleModule', deployer), [], { kind: 'uups' });
    await lifecycleModule.deployed();

    const PRIVATE_CREDIT = ethers.utils.formatBytes32String('PRIVATE_CREDIT');
    await assetFactory.connect(deployer).registerAssetType(PRIVATE_CREDIT, [lifecycleModule.address]);
  });

  async function verifyIdentity(user: any) {
    const idProxy = await new ethers.ContractFactory(
      OnchainID.contracts.IdentityProxy.abi,
      OnchainID.contracts.IdentityProxy.bytecode,
      deployer,
    ).deploy(identityImplementationAuthority.address, deployer.address);
    await idProxy.deployed();
    await ir.connect(tokenAgent).registerIdentity(user.address, idProxy.address, 42);

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

  it('should create an asset, fund it, default it, and recover it flawlessly', async function () {
    const PRIVATE_CREDIT = ethers.utils.formatBytes32String('PRIVATE_CREDIT');
    
    const tokenDetails = {
      owner: ethers.constants.AddressZero,
      name: 'Recovery Loan',
      symbol: 'RECLOAN',
      decimals: 6,
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
    const params = {
      salt: 'RECOVERY-LOAN-001',
      assetType: PRIVATE_CREDIT,
      paymentToken: usdc.address,
      mode: 0, // STABLECOIN_DIRECT
      price: ethers.utils.parseUnits('1', 6),
      charityWallet: ethers.constants.AddressZero,
      admin: deployer.address,
      metadataURI: 'ipfs://recovery-loan',
    };

    const tx = await assetFactory.connect(deployer).createAsset(params, tokenDetails, claimDetails);
    const receipt = await tx.wait();
    const event = receipt.events?.find((e: any) => e.event === 'AssetCreated');
    
    tokenAddress = event.args[2];
    vaultAddress = event.args[3];
    treasuryAddress = event.args[4];

    token = await ethers.getContractAt('Token', tokenAddress);
    vault = await ethers.getContractAt('AssetVault', vaultAddress);
    treasury = await ethers.getContractAt('AssetTreasury', treasuryAddress);
    ir = await ethers.getContractAt('IdentityRegistry', await token.identityRegistry());
    
    await token.connect(tokenAgent).unpause();

    // Initialize loan
    const targetPrincipal = ethers.utils.parseUnits('10000', 6);
    const fundingDeadline = (await ethers.provider.getBlock('latest')).timestamp + 86400 * 7;
    const maturityTimestamp = fundingDeadline + (86400 * 365);
    const paymentFrequency = 86400 * 30;
    const couponRate = 850; // 8.5%
    const agreementHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("Loan Agreement"));

    // Ensure hasRefund=true, hasMaturity=true
    await lifecycleModule.connect(deployer).initializeLoan(
      tokenAddress,
      0, // PRIVATE_CREDIT
      targetPrincipal,
      fundingDeadline,
      maturityTimestamp,
      paymentFrequency,
      couponRate,
      agreementHash,
      borrower.address,
      true,
      true
    );

    // Verify identity for Alice and Bob
    await verifyIdentity(alice);
    await verifyIdentity(bob);

    // Alice and Bob buy the loan
    await usdc.mint(alice.address, ethers.utils.parseUnits('6000', 6));
    await usdc.connect(alice).approve(vaultAddress, ethers.utils.parseUnits('6000', 6));
    await vault.connect(alice).buy(ethers.utils.parseUnits('6000', 6));

    await usdc.mint(bob.address, ethers.utils.parseUnits('4000', 6));
    await usdc.connect(bob).approve(vaultAddress, ethers.utils.parseUnits('4000', 6));
    await vault.connect(bob).buy(ethers.utils.parseUnits('4000', 6));

    expect(await token.totalSupply()).to.equal(ethers.utils.parseUnits('10000', 6));

    // Transition to ACTIVE
    await lifecycleModule.connect(deployer).transitionToActive(tokenAddress);
    
    // Treasury has 10k USDC
    expect(await treasury.balance()).to.equal(ethers.utils.parseUnits('10000', 6));

    // Admin withdraws from treasury to borrower
    const withdrawerRole = await treasury.WITHDRAWER_ROLE();
    await treasury.connect(deployer).grantRole(withdrawerRole, deployer.address);
    await treasury.connect(deployer).release(borrower.address, ethers.utils.parseUnits('10000', 6), "Disbursement");

    expect(await treasury.balance()).to.equal(0);

    // Transition to DEFAULTED
    await lifecycleModule.connect(deployer).transitionToDefaulted(tokenAddress);

    // Transition to RECOVERY
    const settlementHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("Settlement"));
    await lifecycleModule.connect(deployer).transitionToRecovery(tokenAddress, settlementHash);

    const loanInfo = await lifecycleModule.loanConfigs(tokenAddress);
    expect(loanInfo.state).to.equal(5); // RECOVERY

    // Recover funds: Borrower (or anyone) deposits 5000 USDC to treasury
    await usdc.mint(deployer.address, ethers.utils.parseUnits('5000', 6));
    await usdc.connect(deployer).approve(treasuryAddress, ethers.utils.parseUnits('5000', 6));
    await treasury.connect(deployer).deposit(ethers.utils.parseUnits('5000', 6), "Recovery Payment");

    expect(await treasury.balance()).to.equal(ethers.utils.parseUnits('5000', 6));

    // Alice redeems recovery (She holds 60% of supply, should get 3000 USDC)
    const aliceBal = await token.balanceOf(alice.address);
    expect(aliceBal).to.equal(ethers.utils.parseUnits('6000', 6));
    
    const aliceUsdcBefore = await usdc.balanceOf(alice.address);
    await vault.connect(alice).redeemRecovery(aliceBal);
    const aliceUsdcAfter = await usdc.balanceOf(alice.address);
    
    expect(aliceUsdcAfter.sub(aliceUsdcBefore)).to.equal(ethers.utils.parseUnits('3000', 6));
    expect(await token.balanceOf(alice.address)).to.equal(0);

    // Bob redeems recovery (He holds 40% of supply, should get 2000 USDC)
    const bobBal = await token.balanceOf(bob.address);
    expect(bobBal).to.equal(ethers.utils.parseUnits('4000', 6));
    
    const bobUsdcBefore = await usdc.balanceOf(bob.address);
    await vault.connect(bob).redeemRecovery(bobBal);
    const bobUsdcAfter = await usdc.balanceOf(bob.address);
    
    expect(bobUsdcAfter.sub(bobUsdcBefore)).to.equal(ethers.utils.parseUnits('2000', 6));
    expect(await token.balanceOf(bob.address)).to.equal(0);

    // Treasury should be empty
    expect(await treasury.balance()).to.equal(0);
    expect(await token.totalSupply()).to.equal(0);
  });
});
