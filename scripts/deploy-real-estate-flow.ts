import { ethers, upgrades } from 'hardhat';
import OnchainID from '@onchain-id/solidity';

/**
 * PRODUCTION Real Estate Tokenization Full Flow Script
 * 
 * 1. Deploys Mock USDC (Stablecoin)
 * 2. Deploys T-REX Infrastructure
 * 3. Deploys Upgradable Registry & Marketplace
 * 4. Registers a Property (UUPS Vault, T-REX Suite)
 * 5. Simulates User Buy/Sell using USDC
 */
async function main() {
    const [deployer, tokenIssuer, tokenAgent, claimIssuer, aliceWallet, bobWallet] = await ethers.getSigners();

    console.log('🚀 Starting PRODUCTION Real Estate Tokenization Flow...');

    // =========================================================================
    // 0. Deploy Mock Stablecoin
    // =========================================================================
    console.log('\n💵 Step 0: Deploying Mock USDC...');
    const usdc = await ethers.deployContract('Stablecoin', [], deployer);
    await usdc.deployed();
    console.log('  ✓ Mock USDC:', usdc.address);

    // =========================================================================
    // 1. Deploy T-REX Infrastructure
    // =========================================================================
    console.log('\n📦 Step 1: Deploying T-REX Infrastructure...');

    const claimTopicsRegistry = await ethers.deployContract('ClaimTopicsRegistry', deployer);
    const trustedIssuersRegistry = await ethers.deployContract('TrustedIssuersRegistry', deployer);
    const identityRegistryStorage = await ethers.deployContract('IdentityRegistryStorage', deployer);
    const identityRegistryImpl = await ethers.deployContract('IdentityRegistry', deployer);
    const modularCompliance = await ethers.deployContract('ModularCompliance', deployer);
    const tokenImplementation = await ethers.deployContract('Token', deployer);

    // Identity Factory
    const identityImplementation = await new ethers.ContractFactory(OnchainID.contracts.Identity.abi, OnchainID.contracts.Identity.bytecode, deployer).deploy(deployer.address, true);
    const identityImplementationAuthority = await new ethers.ContractFactory(OnchainID.contracts.ImplementationAuthority.abi, OnchainID.contracts.ImplementationAuthority.bytecode, deployer).deploy(identityImplementation.address);
    const identityFactory = await new ethers.ContractFactory(OnchainID.contracts.Factory.abi, OnchainID.contracts.Factory.bytecode, deployer).deploy(identityImplementationAuthority.address);

    // TREX Factory
    const trexImplementationAuthority = await ethers.deployContract('TREXImplementationAuthority', [true, ethers.constants.AddressZero, ethers.constants.AddressZero], deployer);
    await trexImplementationAuthority.addAndUseTREXVersion({ major: 4, minor: 0, patch: 0 }, {
        tokenImplementation: tokenImplementation.address,
        ctrImplementation: claimTopicsRegistry.address,
        irImplementation: identityRegistryImpl.address,
        irsImplementation: identityRegistryStorage.address,
        tirImplementation: trustedIssuersRegistry.address,
        mcImplementation: modularCompliance.address,
    });
    const trexFactory = await ethers.deployContract('TREXFactory', [trexImplementationAuthority.address, identityFactory.address], deployer);
    await identityFactory.addTokenFactory(trexFactory.address);

    const claimIssuerContract = await ethers.deployContract('ClaimIssuer', [claimIssuer.address], claimIssuer);
    const claimIssuerSigningKey = ethers.Wallet.createRandom();
    await claimIssuerContract.connect(claimIssuer).addKey(ethers.utils.keccak256(ethers.utils.defaultAbiCoder.encode(['address'], [claimIssuerSigningKey.address])), 3, 1);

    console.log('  ✓ T-REX Infrastructure Ready');

    // =========================================================================
    // 2. Deploy Upgradable Real Estate Contracts
    // =========================================================================
    console.log('\n🏠 Step 2: Deploying Upgradable Real Estate Contracts...');

    // Registry Proxy
    const RealEstateRegistry = await ethers.getContractFactory('RealEstateRegistry', deployer);
    const registry = await upgrades.deployProxy(RealEstateRegistry, [deployer.address], { kind: 'uups' });
    await registry.deployed();
    console.log('  ✓ RealEstateRegistry (Proxy):', registry.address);

    // Vault Implementation (for Factory)
    const vaultImpl = await ethers.deployContract('RealEstateVault', deployer);
    await vaultImpl.deployed();

    // Vault Factory Proxy
    const RealEstateVaultFactory = await ethers.getContractFactory('RealEstateVaultFactory', deployer);
    const vaultFactory = await upgrades.deployProxy(RealEstateVaultFactory, [vaultImpl.address, deployer.address], { kind: 'uups' });
    await vaultFactory.deployed();
    console.log('  ✓ RealEstateVaultFactory (Proxy):', vaultFactory.address);

    // Marketplace Proxy
    const RealEstateMarketplace = await ethers.getContractFactory('RealEstateMarketplace', deployer);
    const marketplace = await upgrades.deployProxy(RealEstateMarketplace, [vaultFactory.address, deployer.address], { kind: 'uups' });
    await marketplace.deployed();
    console.log('  ✓ RealEstateMarketplace (Proxy):', marketplace.address);

    // =========================================================================
    // 3. Register Property
    // =========================================================================
    console.log('\n🏗️  Step 3: Registering "Ocean View Villa" Property...');

    const claimTopic = ethers.utils.keccak256(ethers.utils.toUtf8Bytes('KYC_CLAIM'));
    const countryAllowModule = await ethers.deployContract('CountryAllowModule', deployer);

    const tokenDetails = {
        owner: tokenIssuer.address,
        name: 'Ocean View Villa Token',
        symbol: 'OVVT',
        decimals: 18,
        irs: ethers.constants.AddressZero,
        ONCHAINID: ethers.constants.AddressZero,
        irAgents: [tokenAgent.address],
        tokenAgents: [tokenAgent.address],
        complianceModules: [countryAllowModule.address],
        complianceSettings: [
            new ethers.utils.Interface(['function batchAllowCountries(uint16[] calldata countries)']).encodeFunctionData('batchAllowCountries', [[1, 42, 66]]),
        ],
    };

    const deployTx = await trexFactory.connect(deployer).deployTREXSuite('ocean-view-002', tokenDetails, {
        claimTopics: [claimTopic],
        issuers: [claimIssuerContract.address],
        issuerClaims: [[claimTopic]],
    });
    const receipt = await deployTx.wait();
    const tokenAddress = receipt.events?.find((e: any) => e.event === 'TREXSuiteDeployed')?.args?.[0];
    const irAddress = receipt.events?.find((e: any) => e.event === 'TREXSuiteDeployed')?.args?.[1];

    // Deploy Vault through Factory
    const pricePerShare = ethers.utils.parseUnits("100", 6); // 100 USDC per share
    await vaultFactory.connect(deployer).deployVault(tokenAddress, usdc.address, pricePerShare, deployer.address);
    const vaultAddress = await vaultFactory.vaults(tokenAddress);
    console.log('  ✓ Property Vault (Proxy) Deployed:', vaultAddress);

    // Register in Registry
    await registry.connect(deployer).registerProperty(tokenIssuer.address, "ipfs://meta", tokenAddress, vaultAddress);
    console.log('  ✓ Property NFT Registered');

    // =========================================================================
    // 4. Setup Identities & Initial Token Flow
    // =========================================================================
    console.log('\n🏪 Step 4: Setting up Identities & Funding...');

    const ir = await ethers.getContractAt('IdentityRegistry', irAddress);

    // Identity Helper
    async function setupId(addr: string, country: number) {
        const idProxy = await new ethers.ContractFactory(OnchainID.contracts.IdentityProxy.abi, OnchainID.contracts.IdentityProxy.bytecode, deployer).deploy(identityImplementationAuthority.address, deployer.address);
        await idProxy.deployed();
        await ir.connect(tokenAgent).registerIdentity(addr, idProxy.address, country);

        const claim = { topic: claimTopic, issuer: claimIssuerContract.address, identity: idProxy.address, data: ethers.utils.hexlify(ethers.utils.toUtf8Bytes('Verified')), scheme: 1, signature: '' };
        claim.signature = await claimIssuerSigningKey.signMessage(ethers.utils.arrayify(ethers.utils.keccak256(ethers.utils.defaultAbiCoder.encode(['address', 'uint256', 'bytes'], [idProxy.address, claim.topic, claim.data]))));

        const id = await ethers.getContractAt(OnchainID.contracts.Identity.abi, idProxy.address);
        await id.connect(deployer).addClaim(claim.topic, claim.scheme, claim.issuer, claim.signature, claim.data, '');
    }

    await setupId(vaultAddress, 42);
    await setupId(marketplace.address, 42);
    await setupId(aliceWallet.address, 42);
    console.log('  ✓ Marketplace, Vault, and Alice Identities Verified');

    // Mint Tokens to Vault
    const token = await ethers.getContractAt('Token', tokenAddress);
    await token.connect(tokenAgent).unpause();
    await token.connect(tokenAgent).mint(vaultAddress, ethers.utils.parseEther("1000"));
    console.log('  ✓ Minted 1000 Tokens to Vault');

    // Bind Vault as Compliance Module
    const complianceAddr = await token.compliance();
    const compliance = await ethers.getContractAt('ModularCompliance', complianceAddr);
    await compliance.connect(tokenIssuer).addModule(vaultAddress);
    console.log('  ✓ Vault Bound to Compliance');

    // =========================================================================
    // 5. Simulation (Alice Buys and Sells using USDC)
    // =========================================================================
    console.log('\n👤 Step 5: User Interaction (Alice) using USDC...');

    const vault = await ethers.getContractAt('RealEstateVault', vaultAddress);

    // Give Alice some USDC
    await usdc.mint(aliceWallet.address, ethers.utils.parseUnits("5000", 6));
    await usdc.connect(aliceWallet).approve(marketplace.address, ethers.utils.parseUnits("5000", 6));
    console.log('  ✓ Alice Funded with 5000 USDC and approved Marketplace');

    // Alice Buys 10 shares
    console.log('  💸 Alice buying 10 shares (1000 USDC total)...');
    await marketplace.connect(aliceWallet).buyShares(tokenAddress, ethers.utils.parseEther("10"));
    console.log('  ✓ Alice Balance:', ethers.utils.formatEther(await token.balanceOf(aliceWallet.address)));

    // Yield Distribution (USDC)
    console.log('  💰 Depositing 500 USDC Yield...');
    await usdc.mint(deployer.address, ethers.utils.parseUnits("500", 6));
    await usdc.connect(deployer).approve(vault.address, ethers.utils.parseUnits("500", 6));
    await vault.connect(deployer).depositYield(ethers.utils.parseUnits("500", 6));

    // Alice Claims Yield
    const aliceUsdcBefore = await usdc.balanceOf(aliceWallet.address);
    await vault.connect(aliceWallet).claimYield();
    const aliceUsdcAfter = await usdc.balanceOf(aliceWallet.address);
    console.log('  ✓ Alice USDC Yield Received:', ethers.utils.formatUnits(aliceUsdcAfter.sub(aliceUsdcBefore), 6));

    // Alice Sells 5 shares
    console.log('  💰 Alice selling 5 shares back...');
    await token.connect(aliceWallet).approve(marketplace.address, ethers.utils.parseEther("5"));
    await marketplace.connect(aliceWallet).sellShares(tokenAddress, ethers.utils.parseEther("5"));
    console.log('  ✓ Alice Final Balance:', ethers.utils.formatEther(await token.balanceOf(aliceWallet.address)));
    console.log('  ✓ Alice Final USDC Balance:', ethers.utils.formatUnits(await usdc.balanceOf(aliceWallet.address), 6));

    console.log('\n✅ PRODUCTION FLOW VERIFIED!');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
