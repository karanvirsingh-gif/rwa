import { ethers, upgrades } from 'hardhat';
import OnchainID from '@onchain-id/solidity';

/**
 * PRODUCTION Gold Tokenization Full Flow Script
 * 
 * 1. Deploys Mock USDC (Stablecoin)
 * 2. Deploys T-REX Infrastructure
 * 3. Deploys Upgradable Registry & Marketplace for Gold
 * 4. Registers a Gold Asset (UUPS Vault, T-REX Suite)
 * 5. Simulates User Buy/Sell using USDC
 */
async function main() {
    const [deployer, tokenIssuer, tokenAgent, claimIssuer, aliceWallet, bobWallet] = await ethers.getSigners();

    console.log('🚀 Starting PRODUCTION Gold Tokenization Flow...');

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
    // 2. Deploy Upgradable Gold Contracts
    // =========================================================================
    console.log('\n🏦 Step 2: Deploying Upgradable Gold Contracts...');

    // Registry Proxy
    const GoldRegistry = await ethers.getContractFactory('GoldRegistry', deployer);
    const registry = await upgrades.deployProxy(GoldRegistry, [deployer.address], { kind: 'uups' });
    await registry.deployed();
    console.log('  ✓ GoldRegistry (Proxy):', registry.address);

    // Vault Implementation (for Factory)
    const vaultImpl = await ethers.deployContract('GoldVault', deployer);
    await vaultImpl.deployed();

    // Vault Factory Proxy
    const GoldVaultFactory = await ethers.getContractFactory('GoldVaultFactory', deployer);
    const vaultFactory = await upgrades.deployProxy(GoldVaultFactory, [vaultImpl.address, deployer.address], { kind: 'uups' });
    await vaultFactory.deployed();
    console.log('  ✓ GoldVaultFactory (Proxy):', vaultFactory.address);

    // Marketplace Proxy
    const GoldMarketplace = await ethers.getContractFactory('GoldMarketplace', deployer);
    const marketplace = await upgrades.deployProxy(GoldMarketplace, [vaultFactory.address, deployer.address], { kind: 'uups' });
    await marketplace.deployed();
    console.log('  ✓ GoldMarketplace (Proxy):', marketplace.address);

    // =========================================================================
    // 3. Register Gold Asset
    // =========================================================================
    console.log('\n🪙  Step 3: Registering "1kg Solid Gold Bar" Asset...');

    const claimTopic = ethers.utils.keccak256(ethers.utils.toUtf8Bytes('KYC_CLAIM'));
    const countryAllowModule = await ethers.deployContract('CountryAllowModule', deployer);

    const tokenDetails = {
        owner: tokenIssuer.address,
        name: '1kg Solid Gold Bar Token',
        symbol: 'GLD-1KG',
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

    const deployTx = await trexFactory.connect(deployer).deployTREXSuite('gold-bar-001', tokenDetails, {
        claimTopics: [claimTopic],
        issuers: [claimIssuerContract.address],
        issuerClaims: [[claimTopic]],
    });
    const receipt = await deployTx.wait();
    const tokenAddress = receipt.events?.find((e: any) => e.event === 'TREXSuiteDeployed')?.args?.[0];
    const irAddress = receipt.events?.find((e: any) => e.event === 'TREXSuiteDeployed')?.args?.[1];

    // Deploy Vault through Factory
    const pricePerShare = ethers.utils.parseUnits("70", 6); // e.g. 70 USDC per share of gold
    await vaultFactory.connect(deployer).deployVault(tokenAddress, usdc.address, pricePerShare, deployer.address);
    const vaultAddress = await vaultFactory.vaults(tokenAddress);
    console.log('  ✓ Gold Vault (Proxy) Deployed:', vaultAddress);

    // Register in Registry
    await registry.connect(deployer).registerGold(tokenIssuer.address, "ipfs://gold-metadata-hash", tokenAddress, vaultAddress);
    console.log('  ✓ Gold NFT Registered');

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
    console.log('  ✓ Minted 1000 Gold Shares to Vault');

    // Bind Vault as Compliance Module
    const complianceAddr = await token.compliance();
    const compliance = await ethers.getContractAt('ModularCompliance', complianceAddr);
    await compliance.connect(tokenIssuer).addModule(vaultAddress);
    console.log('  ✓ Vault Bound to Compliance');

    // =========================================================================
    // 5. Simulation (Alice Buys and Sells using USDC)
    // =========================================================================
    console.log('\n👤 Step 5: User Interaction (Alice) using USDC...');

    const vault = await ethers.getContractAt('GoldVault', vaultAddress);

    // Give Alice some USDC
    await usdc.mint(aliceWallet.address, ethers.utils.parseUnits("5000", 6));
    await usdc.connect(aliceWallet).approve(marketplace.address, ethers.utils.parseUnits("5000", 6));
    console.log('  ✓ Alice Funded with 5000 USDC and approved Marketplace');

    // Alice Buys 10 shares
    console.log('  💸 Alice buying 10 shares of Gold (700 USDC total)...');
    await marketplace.connect(aliceWallet).buyShares(tokenAddress, ethers.utils.parseEther("10"));
    console.log('  ✓ Alice Gold Balance:', ethers.utils.formatEther(await token.balanceOf(aliceWallet.address)));

    // Yield Distribution (USDC)
    console.log('  💰 Depositing 50 USDC Yield (e.g., from gold lending)...');
    await usdc.mint(deployer.address, ethers.utils.parseUnits("50", 6));
    await usdc.connect(deployer).approve(vault.address, ethers.utils.parseUnits("50", 6));
    await vault.connect(deployer).depositYield(ethers.utils.parseUnits("50", 6));

    // Alice Claims Yield
    const aliceUsdcBefore = await usdc.balanceOf(aliceWallet.address);
    await vault.connect(aliceWallet).claimYield();
    const aliceUsdcAfter = await usdc.balanceOf(aliceWallet.address);
    console.log('  ✓ Alice USDC Yield Received:', ethers.utils.formatUnits(aliceUsdcAfter.sub(aliceUsdcBefore), 6));

    // Alice Sells 5 shares
    console.log('  💰 Alice selling 5 shares back...');
    await token.connect(aliceWallet).approve(marketplace.address, ethers.utils.parseEther("5"));
    await marketplace.connect(aliceWallet).sellShares(tokenAddress, ethers.utils.parseEther("5"));
    console.log('  ✓ Alice Final Gold Balance:', ethers.utils.formatEther(await token.balanceOf(aliceWallet.address)));
    console.log('  ✓ Alice Final USDC Balance:', ethers.utils.formatUnits(await usdc.balanceOf(aliceWallet.address), 6));

    console.log('\n✅ GOLD PRODUCTION FLOW VERIFIED!');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
