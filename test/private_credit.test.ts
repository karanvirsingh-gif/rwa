import { ethers, upgrades } from 'hardhat';
import { expect } from 'chai';
import OnchainID from '@onchain-id/solidity';

describe('Private Credit - Generalized Architecture Flow', function () {
  let deployer: any, tokenAgent: any, claimIssuer: any, alice: any, bob: any, borrower: any;
  let usdc: any, registry: any, assetFactory: any;
  let trexFactory: any, identityFactory: any, identityImplementationAuthority: any;
  let claimIssuerContract: any, claimIssuerSigningKey: any;
  let claimTopic: any;
  let stateModule: any;
  
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

    // 4. Deploy and Register PrivateCreditStateModule
    stateModule = await ethers.deployContract('PrivateCreditStateModule', deployer);
    await stateModule.deployed();

    const PRIVATE_CREDIT = ethers.utils.formatBytes32String('PRIVATE_CREDIT');
    await assetFactory.connect(deployer).registerAssetType(PRIVATE_CREDIT, [stateModule.address]);
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

  it('should create a private credit asset via the AssetFactory', async function () {
    const PRIVATE_CREDIT = ethers.utils.formatBytes32String('PRIVATE_CREDIT');
    
    const tokenDetails = {
      owner: ethers.constants.AddressZero,
      name: 'Test Loan',
      symbol: 'TESTLN',
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
      salt: 'TEST-LOAN-001',
      assetType: PRIVATE_CREDIT,
      paymentToken: usdc.address,
      mode: 0, // STABLECOIN_DIRECT
      price: ethers.utils.parseUnits('1', 6),
      charityWallet: ethers.constants.AddressZero,
      admin: deployer.address,
      metadataURI: 'ipfs://test-loan',
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
    
    expect(tokenAddress).to.not.equal(ethers.constants.AddressZero);
    expect(vaultAddress).to.not.equal(ethers.constants.AddressZero);
  });

  it('should initialize the loan and place it in FUNDING state', async function () {
    const targetPrincipal = ethers.utils.parseUnits('10000', 6);
    const fundingDeadline = (await ethers.provider.getBlock('latest')).timestamp + 86400 * 7;
    const maturityTimestamp = fundingDeadline + (86400 * 365);
    const paymentFrequency = 86400 * 30;
    const couponRate = 850; // 8.5%
    const agreementHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("Loan Agreement"));

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

    const loanInfo = await stateModule.loanConfigs(tokenAddress);
    expect(loanInfo.state).to.equal(0); // 0 = FUNDING
  });

  it('should allow investors to buy into the loan during FUNDING but block P2P trading', async function () {
    await verifyIdentity(alice);
    await verifyIdentity(bob);

    await usdc.mint(alice.address, ethers.utils.parseUnits('5000', 6));
    await usdc.connect(alice).approve(vaultAddress, ethers.utils.parseUnits('5000', 6));
    
    // Alice buys 5000 tokens
    await vault.connect(alice).buy(ethers.utils.parseUnits('5000', 6));
    const aliceBal = await token.balanceOf(alice.address);
    expect(aliceBal).to.equal(ethers.utils.parseUnits('5000', 6));

    // Treasury should hold the USDC in escrow
    const treasuryBal = await usdc.balanceOf(treasuryAddress);
    expect(treasuryBal).to.equal(ethers.utils.parseUnits('5000', 6));

    // P2P transfer should be blocked (revert string depends on modular compliance)
    await expect(
      token.connect(alice).transfer(bob.address, ethers.utils.parseUnits('100', 6))
    ).to.be.reverted;
  });

  it('should transition to ACTIVE, disburse funds, and unlock P2P trading', async function () {
    // Bob buys the remaining 5000
    await usdc.mint(bob.address, ethers.utils.parseUnits('5000', 6));
    await usdc.connect(bob).approve(vaultAddress, ethers.utils.parseUnits('5000', 6));
    await vault.connect(bob).buy(ethers.utils.parseUnits('5000', 6));

    // Transition state
    await stateModule.connect(deployer).transitionToActive(tokenAddress);
    const loanInfo = await stateModule.loanConfigs(tokenAddress);
    expect(loanInfo.state).to.equal(1); // 1 = ACTIVE

    // Release escrow to borrower
    await treasury.connect(deployer).release(borrower.address, ethers.utils.parseUnits('10000', 6), 'Loan Funded');
    const borrowerBal = await usdc.balanceOf(borrower.address);
    expect(borrowerBal).to.equal(ethers.utils.parseUnits('10000', 6));

    // P2P trade should now be unlocked
    await token.connect(alice).transfer(bob.address, ethers.utils.parseUnits('100', 6));
    const bobTokenBal = await token.balanceOf(bob.address);
    expect(bobTokenBal).to.equal(ethers.utils.parseUnits('5100', 6)); // 5000 + 100
  });

  describe('Lifecycle Edge Cases & State Machine Enforcement', function () {
    let refundToken: any, defaultToken: any, matureToken: any;
    let refundCompliance: string, defaultCompliance: string, matureCompliance: string;
    
    before(async function () {
      const PRIVATE_CREDIT = ethers.utils.formatBytes32String('PRIVATE_CREDIT');
      const td = { owner: ethers.constants.AddressZero, name: 'T1', symbol: 'T1', decimals: 6, irs: ethers.constants.AddressZero, ONCHAINID: ethers.constants.AddressZero, irAgents: [tokenAgent.address], tokenAgents: [tokenAgent.address], complianceModules: [], complianceSettings: [] };
      const cd = { claimTopics: [claimTopic], issuers: [claimIssuerContract.address], issuerClaims: [[claimTopic]] };

      const createLoan = async (salt: string) => {
        const tx = await assetFactory.connect(deployer).createAsset({ salt, assetType: PRIVATE_CREDIT, paymentToken: usdc.address, mode: 0, price: 1000000, charityWallet: ethers.constants.AddressZero, admin: deployer.address, metadataURI: 'ipfs://' }, td, cd);
        const receipt = await tx.wait();
        const ev = receipt.events?.find((e: any) => e.event === 'AssetCreated');
        const t = await ethers.getContractAt('Token', ev.args[2]);
        await stateModule.connect(deployer).initializeLoan(t.address, ethers.utils.parseUnits('1000', 6), 9999999999, 9999999999, 30, 850, ethers.utils.keccak256(ethers.utils.toUtf8Bytes("H")), borrower.address);
        return { token: t, compliance: await t.compliance() };
      };

      const r1 = await createLoan('REFUND-001'); refundToken = r1.token; refundCompliance = r1.compliance;
      const r2 = await createLoan('DEFAULT-001'); defaultToken = r2.token; defaultCompliance = r2.compliance;
      const r3 = await createLoan('MATURE-001'); matureToken = r3.token; matureCompliance = r3.compliance;
    });

    it('REFUND State: Blocks P2P, Blocks Minting, Allows Burning', async function () {
      await stateModule.connect(deployer).transitionToRefund(refundToken.address);
      
      expect(await stateModule.moduleCheck(alice.address, bob.address, 100, refundCompliance)).to.be.false;
      expect(await stateModule.moduleCheck(ethers.constants.AddressZero, bob.address, 100, refundCompliance)).to.be.false;
      expect(await stateModule.moduleCheck(alice.address, ethers.constants.AddressZero, 100, refundCompliance)).to.be.true;
    });

    it('DEFAULTED State: Instantly freezes all token movement globally', async function () {
      await stateModule.connect(deployer).transitionToActive(defaultToken.address);
      await stateModule.connect(deployer).transitionToDefaulted(defaultToken.address);

      expect(await stateModule.moduleCheck(alice.address, bob.address, 100, defaultCompliance)).to.be.false; 
      expect(await stateModule.moduleCheck(ethers.constants.AddressZero, bob.address, 100, defaultCompliance)).to.be.false; 
      expect(await stateModule.moduleCheck(alice.address, ethers.constants.AddressZero, 100, defaultCompliance)).to.be.false; 
    });

    it('MATURED State: Blocks P2P, Allows Burning for Principal Redemption', async function () {
      await stateModule.connect(deployer).transitionToActive(matureToken.address);
      await stateModule.connect(deployer).transitionToMatured(matureToken.address);

      expect(await stateModule.moduleCheck(alice.address, bob.address, 100, matureCompliance)).to.be.false; 
      expect(await stateModule.moduleCheck(ethers.constants.AddressZero, bob.address, 100, matureCompliance)).to.be.false; 
      expect(await stateModule.moduleCheck(alice.address, ethers.constants.AddressZero, 100, matureCompliance)).to.be.true; 
    });
  });
});
