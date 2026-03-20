import { ethers } from 'hardhat';
import OnchainID from '@onchain-id/solidity';
import * as fs from 'fs';
import * as path from 'path';

/**
 * CONFIGURATION
 * Edit these values for your new property!
 */
const PROPERTY_ID = "AMOY-RWA-013";
const PROPERTY_PRICE_USDC = "150"; // $150 per share
const MINT_AMOUNT = "2000";       // Total supply of tokens for this property

const DELAY_MS = 2000;
const amoyPath = path.join(__dirname, '../deployments/amoy.json');

async function delay(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
    const [deployer, aliceWallet] = await ethers.getSigners();
    console.log(`\n🏡 Registering NEW Property Suite: ${PROPERTY_ID}...`);

    const addr = JSON.parse(fs.readFileSync(amoyPath, 'utf8'));
    const feeData = await ethers.provider.getFeeData();
    const gasPrice = feeData.gasPrice?.mul(150).div(100) || ethers.utils.parseUnits('35', 'gwei');

    const registry = await ethers.getContractAt('RealEstateRegistry', addr.RealEstateRegistry);
    const vaultFactory = await ethers.getContractAt('RealEstateVaultFactory', addr.RealEstateVaultFactory);
    const trexFactory = await ethers.getContractAt('TREXFactory', addr.TrexFactory);
    const usdc = await ethers.getContractAt('Stablecoin', addr.Stablecoin);

    const claimTopic = ethers.utils.keccak256(ethers.utils.toUtf8Bytes('KYC_CLAIM'));

    // 1. Deploy new Token for this property
    console.log('🏗️  Deploying T-REX Token Suite via TREXFactory...');
    const salt = `${PROPERTY_ID}-${Date.now()}`;

    const tokenTx = await trexFactory.deployTREXSuite(
        salt,
        {
            owner: deployer.address,
            name: `Property ${PROPERTY_ID}`,
            symbol: `P${PROPERTY_ID.split('-').pop()}`,
            decimals: 6,
            irs: ethers.constants.AddressZero,
            ONCHAINID: ethers.constants.AddressZero,
            irAgents: [deployer.address],
            tokenAgents: [deployer.address],
            complianceModules: [],
            complianceSettings: []
        },
        {
            claimTopics: [claimTopic],
            issuers: [addr.ClaimIssuer],
            issuerClaims: [[claimTopic]]
        },
        { gasPrice }
    );
    const receipt = await tokenTx.wait();
    console.log(addr.ClaimIssuer);
    // Find Token address from event log
    const event = receipt.events?.find((e: any) => e.event === 'TREXSuiteDeployed');
    if (!event) {
        console.log("  ⚠️  TREXSuiteDeployed event not found by name. Searching by topic...");
        const topic = ethers.utils.id("TREXSuiteDeployed(address,address,address,address,address,address,string)");
        const log = receipt.logs.find((l: any) => l.topics[0] === topic);
        if (!log) throw new Error("TREXSuiteDeployed event log not found");
        // token is the first indexed param (topic[1])
        const tokenAddress = ethers.utils.defaultAbiCoder.decode(['address'], log.topics[1])[0];
        console.log('   ✓ Token Deployed (Topic Match):', tokenAddress);
        var finalTokenAddress = tokenAddress;
    } else {
        const tokenAddress = event.args?._token || event.args?.[0];
        console.log('   ✓ Token Deployed:', tokenAddress);
        var finalTokenAddress = tokenAddress;
    }
    const tokenAddress = finalTokenAddress;
    if (!tokenAddress) throw new Error("Failed to extract token address");

    // 2. Deploy Vault for this property
    console.log('🏦 Deploying Property Vault...');
    const pricePerShare = ethers.utils.parseUnits(PROPERTY_PRICE_USDC, 6);
    const vaultTx = await vaultFactory.deployVault(tokenAddress, usdc.address, pricePerShare, deployer.address, { gasPrice });
    await vaultTx.wait();
    const vaultAddress = await vaultFactory.vaults(tokenAddress);
    console.log('   ✓ Vault Deployed:', vaultAddress);

    // 3. Register in Master Registry
    console.log('📝 Registering in Master Registry...');
    const regTx = await registry.registerProperty(deployer.address, `ipfs://meta-${PROPERTY_ID}`, tokenAddress, vaultAddress, { gasPrice });
    await regTx.wait();
    console.log('   ✓ Registry Linked');

    // 4. Setup Identities & Verification
    console.log('\n👤 Verifying Identities (Syncing KYC to NEW Token Registry)...');
    const token = await ethers.getContractAt('Token', tokenAddress);
    const irAddress = await token.identityRegistry();
    const ir = await ethers.getContractAt('IdentityRegistry', irAddress);

    async function ensureVerified(userKey: string, userAddr: string, idAddr: string) {
        console.log(`   Syncing ${userKey} (${userAddr})...`);
        const isRegistered = await ir.contains(userAddr);
        if (!isRegistered) {
            const txA = await ir.registerIdentity(userAddr, idAddr, 42, { gasPrice, gasLimit: 800000 });
            await txA.wait();
        }

        const verified = await ir.isVerified(userAddr);
        if (!verified) throw new Error(`${userKey} verification failed on new token registry`);
        console.log(`     ✅ Verified`);
    }

    // Load Identities from state
    const statePath = path.join(__dirname, '../deployments/interact-state.json');
    if (!fs.existsSync(statePath)) throw new Error("Please run interact-amoy.ts first to create global identities!");
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));

    // Register all participants in the NEW token's registry
    await ensureVerified('Vault', vaultAddress, state['ID_Vault']);
    await ensureVerified('Marketplace', addr.RealEstateMarketplace, state['ID_Marketplace']);
    await ensureVerified('Alice', aliceWallet.address, state['ID_Alice']);

    // 5. Minting & Operations
    console.log('\n📦 Phase 3: Operations...');
    const isPaused = await token.paused();
    if (isPaused) {
        const tx3 = await token.unpause({ gasPrice });
        await tx3.wait();
    }
    console.log(`   Minting ${MINT_AMOUNT} Tokens to Vault...`);
    const tx4 = await token.mint(vaultAddress, ethers.utils.parseUnits(MINT_AMOUNT, 6), { gasPrice });
    await tx4.wait();

    const compAddr = await token.compliance();
    const compliance = await ethers.getContractAt('ModularCompliance', compAddr);
    const isBound = await compliance.isModuleBound(vaultAddress);
    if (!isBound) {
        console.log('   Binding Vault to Compliance...');
        const tx5 = await compliance.addModule(vaultAddress, { gasPrice });
        await tx5.wait();
    }
    console.log('   ✓ Operations Complete');

    console.log(`\n✅ PROPERTY ${PROPERTY_ID} IS NOW LIVE AND TRADABLE!`);
    console.log(`   Token Address: ${tokenAddress}`);
    console.log(`   Vault Address: ${vaultAddress}`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
