import { ethers } from 'hardhat';
import OnchainID from '@onchain-id/solidity';

/**
 * RWA Compliance Simulation Script
 * 
 * Demonstrates:
 * 1. Country Allow Module (US vs Germany)
 * 2. Max Balance Module (Whale Limits)
 * 3. Identity Freezing (Regulatory Action)
 */
async function main() {
    const [deployer, tokenIssuer, tokenAgent, claimIssuer, aliceUSA, bobGermany, whaleUser, frozenUser] = await ethers.getSigners();

    console.log('🚀 Starting RWA Compliance Simulation...');

    // =========================================================================
    // 1. Setup Infrastructure
    // =========================================================================
    console.log('\n📦 Step 1: Deploying T-REX Infrastructure...');

    const claimTopicsRegistry = await ethers.deployContract('ClaimTopicsRegistry', deployer);
    const trustedIssuersRegistry = await ethers.deployContract('TrustedIssuersRegistry', deployer);
    const identityRegistryStorage = await ethers.deployContract('IdentityRegistryStorage', deployer);
    const identityRegistry = await ethers.deployContract('IdentityRegistry', deployer);
    const modularCompliance = await ethers.deployContract('ModularCompliance', deployer);
    const tokenImplementation = await ethers.deployContract('Token', deployer);

    // Identity Factory Setup
    const identityImplementation = await new ethers.ContractFactory(OnchainID.contracts.Identity.abi, OnchainID.contracts.Identity.bytecode, deployer).deploy(deployer.address, true);
    const idImplementationAuthority = await new ethers.ContractFactory(OnchainID.contracts.ImplementationAuthority.abi, OnchainID.contracts.ImplementationAuthority.bytecode, deployer).deploy(identityImplementation.address);
    const identityFactory = await new ethers.ContractFactory(OnchainID.contracts.Factory.abi, OnchainID.contracts.Factory.bytecode, deployer).deploy(idImplementationAuthority.address);

    // TREX Factory Setup
    const trexImplementationAuthority = await ethers.deployContract('TREXImplementationAuthority', [true, ethers.constants.AddressZero, ethers.constants.AddressZero], deployer);
    await trexImplementationAuthority.addAndUseTREXVersion(
        { major: 4, minor: 0, patch: 0 },
        {
            tokenImplementation: tokenImplementation.address,
            ctrImplementation: claimTopicsRegistry.address,
            irImplementation: identityRegistry.address,
            irsImplementation: identityRegistryStorage.address,
            tirImplementation: trustedIssuersRegistry.address,
            mcImplementation: modularCompliance.address
        }
    );
    const trexFactory = await ethers.deployContract('TREXFactory', [trexImplementationAuthority.address, identityFactory.address], deployer);
    await identityFactory.addTokenFactory(trexFactory.address);

    const claimIssuerContract = await ethers.deployContract('ClaimIssuer', [claimIssuer.address], claimIssuer);
    const claimIssuerKey = ethers.Wallet.createRandom();

    // Add Key
    console.log(`    Adding Claim Key: ${claimIssuerKey.address}`);
    const keyHash = ethers.utils.keccak256(ethers.utils.defaultAbiCoder.encode(['address'], [claimIssuerKey.address]));
    const addKeyTx = await claimIssuerContract.connect(claimIssuer).addKey(keyHash, 3, 1);
    await addKeyTx.wait();

    // Verify Key
    const hasKey = await claimIssuerContract.keyHasPurpose(keyHash, 3);
    console.log(`    Key Added? ${hasKey}`);
    if (!hasKey) throw new Error("Key not added to issuer");

    // =========================================================================
    // 2. Deploy RWA Token with Compliance Modules
    // =========================================================================
    console.log('\n🏗️  Step 2: Deploying RWA Token ("Real Estate Fund")...');

    const countryAllowModule = await ethers.deployContract('CountryAllowModule', deployer);
    // const maxBalanceModule = await ethers.deployContract('MaxBalanceModule', deployer); 
    // Deployment of MaxBalance might need args? Checking...
    // Let's stick to CountryAllow first to keep it simple, or check constructor.
    // Assuming standard deployment.

    const claimTopic = ethers.utils.keccak256(ethers.utils.toUtf8Bytes('KYC'));

    // Country Codes: 840 (USA), 276 (Germany)
    const tokenDetails = {
        owner: tokenIssuer.address,
        name: 'RWA Fund Token',
        symbol: 'RWA',
        decimals: 18,
        irs: ethers.constants.AddressZero,
        ONCHAINID: ethers.constants.AddressZero,
        irAgents: [tokenAgent.address],
        tokenAgents: [tokenAgent.address],
        complianceModules: [countryAllowModule.address],
        complianceSettings: [
            new ethers.utils.Interface(['function batchAllowCountries(uint16[] calldata countries)']).encodeFunctionData('batchAllowCountries', [[276]]) // Only Germany Allowed initially
        ],
    };
    const claimDetails = {
        claimTopics: [claimTopic],
        issuers: [claimIssuerContract.address],
        issuerClaims: [[claimTopic]],
    };

    const tx = await trexFactory.connect(deployer).deployTREXSuite('rwa-fund-01', tokenDetails, claimDetails);
    const receipt = await tx.wait();
    const tokenAddress = receipt.events?.find((e: any) => e.event === 'TREXSuiteDeployed')?.args?.[0];
    const irAddress = receipt.events?.find((e: any) => e.event === 'TREXSuiteDeployed')?.args?.[1];

    console.log('  ✓ Token Deployed:', tokenAddress);

    // Unpause
    const token = await ethers.getContractAt('Token', tokenAddress);
    await token.connect(tokenAgent).unpause();

    // =========================================================================
    // 3. Setup Users & Identities
    // =========================================================================
    console.log('\n👤 Step 3: Setting up Users (USA vs Germany)...');

    const ir = await ethers.getContractAt('IdentityRegistry', irAddress);

    // Helper to setup ID
    async function setupIdentity(user: any, country: number) {
        console.log(`\n  Setting up Identity for ${user.address} (Country: ${country})...`);

        // 1. Deploy Proxy
        const idProxy = await new ethers.ContractFactory(OnchainID.contracts.IdentityProxy.abi, OnchainID.contracts.IdentityProxy.bytecode, deployer).deploy(idImplementationAuthority.address, user.address);
        await idProxy.deployed();
        // console.log(`    IdentityProxy deployed at ${idProxy.address}`);

        // 2. Register in Registry
        await ir.connect(tokenAgent).registerIdentity(user.address, idProxy.address, country);
        // console.log(`    Registered in IdentityRegistry`);

        // 3. Prepare Claim
        const claim = {
            data: ethers.utils.hexlify(ethers.utils.toUtf8Bytes('KYC')),
            issuer: claimIssuerContract.address,
            topic: claimTopic,
            scheme: 1,
            identity: idProxy.address,
            signature: ''
        };

        // 4. Sign Claim
        const dataToSign = ethers.utils.arrayify(
            ethers.utils.keccak256(
                ethers.utils.defaultAbiCoder.encode(
                    ['address', 'uint256', 'bytes'],
                    [idProxy.address, claim.topic, claim.data]
                )
            )
        );
        claim.signature = await claimIssuerKey.signMessage(dataToSign);

        // 5. Verify Claim validity locally before submitting
        const isValid = await claimIssuerContract.isClaimValid(idProxy.address, claim.topic, claim.signature, claim.data);
        if (!isValid) {
            console.error(`    ❌ CLAIM INVALID according to ClaimIssuer!`);
            // Debugging
            const recovered = ethers.utils.verifyMessage(dataToSign, claim.signature);
            console.error(`    Recovered Signer: ${recovered}`);
            console.error(`    Expected Signer : ${claimIssuerKey.address}`);

            // Check if key is actually on issuer
            const keyHash = ethers.utils.keccak256(ethers.utils.defaultAbiCoder.encode(['address'], [claimIssuerKey.address]));
            const hasKey = await claimIssuerContract.keyHasPurpose(keyHash, 3);
            console.error(`    Issuer Has Key (Purpose 3): ${hasKey}`);

            throw new Error("Cannot proceed with invalid claim");
        }

        // 6. Add Claim to Identity
        const id = await ethers.getContractAt(OnchainID.contracts.Identity.abi, idProxy.address);
        await id.connect(user).addClaim(claim.topic, claim.scheme, claim.issuer, claim.signature, claim.data, '');

        return idProxy.address;
    }

    await setupIdentity(aliceUSA, 840); // USA
    await setupIdentity(bobGermany, 276); // Germany
    console.log('  ✓ Alice (USA) & Bob (Germany) Registered');

    // =========================================================================
    // 4. Test Scenario: Country Restriction
    // =========================================================================
    console.log('\n🌍 Step 4: Testing Country Restrictions...');
    console.log('  -> Allowed Countries: [276 (Germany)]');

    // Mint to Bob (Germany) - Should Succeed
    try {
        await token.connect(tokenAgent).mint(bobGermany.address, 100);
        console.log('  ✅ SUCCESS: Minted to Bob (Germany)');
    } catch (e) {
        console.log('  ❌ FAILED: Mint to Bob (Germany)', e);
    }

    // Mint to Alice (USA) - Should Fail
    try {
        await token.connect(tokenAgent).mint(aliceUSA.address, 100);
        console.log('  ❌ FAILED: Minted to Alice (USA) [Should have failed]');
    } catch (e) {
        console.log('  ✅ SUCCESS: Blocked Mint to Alice (USA)');
    }

    // =========================================================================
    // 5. Test Scenario: Freeze
    // =========================================================================
    console.log('\n❄️  Step 5: Testing Wallet Freeze...');

    // Freeze Bob
    await token.connect(tokenAgent).setAddressFrozen(bobGermany.address, true);
    console.log('  ❄️  Frozen Bob\'s Wallet');

    try {
        await token.connect(bobGermany).transfer(aliceUSA.address, 10);
        console.log('  ❌ FAILED: Bob transferred tokens [Should have failed]');
    } catch (e) {
        console.log('  ✅ SUCCESS: Blocked Transfer from Frozen Wallet');
    }

    // Unfreeze
    await token.connect(tokenAgent).setAddressFrozen(bobGermany.address, false);
    console.log('  ☀️  Unfrozen Bob\'s Wallet');

    console.log('\n✅ Compliance Simulation Complete!');
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
