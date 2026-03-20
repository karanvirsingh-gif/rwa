import { ethers } from 'hardhat';
import OnchainID from '@onchain-id/solidity';
import * as fs from 'fs';
import * as path from 'path';

const DELAY_MS = 2000;
const PROP_ID = "AMOY-RWA-011";
const statePath = path.join(__dirname, '../deployments/interact-state.json');
const amoyPath = path.join(__dirname, '../deployments/amoy.json');

function getState(key: string): string | undefined {
    if (fs.existsSync(statePath)) {
        const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
        return state[key];
    }
    return undefined;
}

function saveState(key: string, value: string) {
    let state: any = {};
    if (fs.existsSync(statePath)) state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    state[key] = value;
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

async function delay(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
    const [deployer, aliceWallet] = await ethers.getSigners();
    console.log(`\n🚀 Starting Robust Amoy Interaction [ID: ${PROP_ID}]...`);

    const addr = JSON.parse(fs.readFileSync(amoyPath, 'utf8'));
    const feeData = await ethers.provider.getFeeData();
    const gasPrice = feeData.gasPrice?.mul(150).div(100) || ethers.utils.parseUnits('35', 'gwei');
    console.log('Using Gas Price:', ethers.utils.formatUnits(gasPrice, 'gwei'), 'gwei');

    const registry = await ethers.getContractAt('RealEstateRegistry', addr.RealEstateRegistry);
    const vaultFactory = await ethers.getContractAt('RealEstateVaultFactory', addr.RealEstateVaultFactory);
    const marketplace = await ethers.getContractAt('RealEstateMarketplace', addr.RealEstateMarketplace);
    const usdc = await ethers.getContractAt('Stablecoin', addr.Stablecoin);

    // 1. Phase 1: Registration
    console.log('\n🏗️  Phase 1: Registering Property Suite...');
    if (!getState('TokenAddress')) {
        const tokenTx = await vaultFactory.createToken("Amoy RWA Token", "AMRWA", 6, addr.CTR, addr.TIR, addr.IRS, addr.ModularCompliance, { gasPrice });
        await tokenTx.wait();
        const filter = vaultFactory.filters.TokenCreated();
        const events = await vaultFactory.queryFilter(filter, -10);
        const tokenAddr = events[events.length - 1].args?.token;
        saveState('TokenAddress', tokenAddr);
        console.log('  ✓ Token Suite Deployed:', tokenAddr);
        await delay(DELAY_MS);
    }
    const tokenAddress = getState('TokenAddress')!;
    const token = await ethers.getContractAt('Token', tokenAddress);
    const irAddress = await token.identityRegistry();
    saveState('IRAddress', irAddress);

    if (!getState('VaultAddress')) {
        const pricePerShare = ethers.utils.parseUnits("100", 6);
        const vaultTx = await vaultFactory.deployVault(tokenAddress, usdc.address, pricePerShare, deployer.address, { gasPrice });
        await vaultTx.wait();
        const vaultAddr = await vaultFactory.vaults(tokenAddress);
        saveState('VaultAddress', vaultAddr);
        console.log('  ✓ Vault Proxy:', vaultAddr);
        await delay(DELAY_MS);
    }
    const vaultAddress = getState('VaultAddress')!;

    if (!getState('RegistryLinked')) {
        const regTx = await registry.registerProperty(deployer.address, "ipfs://meta", tokenAddress, vaultAddress, { gasPrice });
        await regTx.wait();
        saveState('RegistryLinked', 'true');
        console.log('  ✓ Registered in Master Registry');
        await delay(DELAY_MS);
    }

    // 2. Phase 2: Identities & Trust
    console.log('\n👤 Phase 2: Setting up Identities & Trust...');
    const ir = await ethers.getContractAt('IdentityRegistry', irAddress);
    const claimTopic = ethers.utils.keccak256(ethers.utils.toUtf8Bytes('KYC_CLAIM'));

    // Link Trust
    if (!getState('TrustedIssuerSet')) {
        console.log('  Linking Trusted Issuer...');
        const ctrAddr = await ir.topicsRegistry();
        const tirAddr = await ir.issuersRegistry();
        const ctr = await ethers.getContractAt('ClaimTopicsRegistry', ctrAddr);
        const tir = await ethers.getContractAt('TrustedIssuersRegistry', tirAddr);

        const topics = await ctr.getClaimTopics();
        if (!topics.some(t => t.eq(claimTopic))) {
            const txT = await ctr.addClaimTopic(claimTopic, { gasPrice });
            await txT.wait();
        }
        const isTrusted = await tir.isTrustedIssuer(addr.ClaimIssuer);
        if (!isTrusted) {
            const txI = await tir.addTrustedIssuer(addr.ClaimIssuer, [claimTopic], { gasPrice });
            await txI.wait();
        }
        saveState('TrustedIssuerSet', 'true');
        console.log('  ✓ Infrastructure Linked');
        await delay(DELAY_MS);
    }

    async function ensureId(userKey: string, userAddr: string) {
        let idAddr = getState(`ID_${userKey}`);
        if (!idAddr) {
            console.log(`  Creating Identity for ${userKey}...`);
            const IdentityProxy = await ethers.getContractFactory(OnchainID.contracts.IdentityProxy.abi, OnchainID.contracts.IdentityProxy.bytecode, deployer);
            const idProxy = await IdentityProxy.deploy(addr.IdentityImplementationAuthority, deployer.address, { gasPrice, gasLimit: 2000000 });
            await idProxy.deployed();
            idAddr = idProxy.address;
            saveState(`ID_${userKey}`, idAddr);
        }

        // Fix Registry Mapping
        const isRegistered = await ir.contains(userAddr);
        if (isRegistered) {
            const currentId = await ir.identity(userAddr);
            if (currentId.toLowerCase() !== idAddr.toLowerCase()) {
                console.log(`    ⚠️  Stale ID found for ${userKey}. Updating to ${idAddr}...`);
                const txU = await ir.updateIdentity(userAddr, idAddr, { gasPrice, gasLimit: 800000 });
                await txU.wait();
            }
        } else {
            console.log(`    Registering ${userKey} in Identity Registry...`);
            const txA = await ir.registerIdentity(userAddr, idAddr, 42, { gasPrice, gasLimit: 800000 });
            await txA.wait();
        }

        // Claim Setup
        const data = ethers.utils.hexlify(ethers.utils.toUtf8Bytes('Verified'));
        const hash = ethers.utils.keccak256(ethers.utils.defaultAbiCoder.encode(['address', 'uint256', 'bytes'], [idAddr, claimTopic, data]));
        const signature = await deployer.signMessage(ethers.utils.arrayify(hash));
        const id = await ethers.getContractAt(OnchainID.contracts.Identity.abi, idAddr);
        const claimId = ethers.utils.keccak256(ethers.utils.defaultAbiCoder.encode(['address', 'uint256'], [addr.ClaimIssuer, claimTopic]));

        let claimExists = false;
        try {
            const existingClaim = await id.getClaim(claimId);
            claimExists = (existingClaim && existingClaim.data !== '0x');
        } catch (e) { }

        if (!claimExists) {
            console.log(`    Adding KYC Claim for ${userKey}...`);
            const txB = await id.addClaim(claimTopic, 1, addr.ClaimIssuer, signature, data, '', { gasPrice, gasLimit: 800000 });
            await txB.wait();
        }

        // Final Verify
        const verified = await ir.isVerified(userAddr);
        if (!verified) throw new Error(`${userKey} verification failed`);
        console.log(`    ✓ ${userKey} Verified`);
        await delay(DELAY_MS);
    }

    await ensureId('Vault', vaultAddress);
    await ensureId('Marketplace', marketplace.address);
    await ensureId('Alice', aliceWallet.address);

    // 3. Phase 3: Minting
    console.log('\n📦 Phase 3: Operations...');
    if (!getState('TokensMinted')) {
        const isPaused = await token.paused();
        if (isPaused) {
            const tx3 = await token.unpause({ gasPrice });
            await tx3.wait();
        }
        console.log('  Minting 1000 Tokens to Vault...');
        const tx4 = await token.mint(vaultAddress, ethers.utils.parseUnits("1000", 6), { gasPrice });
        await tx4.wait();
        saveState('TokensMinted', 'true');
        console.log('  ✓ Minting Complete');
    }

    if (!getState('ComplianceBound')) {
        const compAddr = await token.compliance();
        const compliance = await ethers.getContractAt('ModularCompliance', compAddr);
        const isBound = await compliance.isModuleBound(vaultAddress);
        if (!isBound) {
            const tx5 = await compliance.addModule(vaultAddress, { gasPrice });
            await tx5.wait();
        }
        saveState('ComplianceBound', 'true');
        console.log('  ✓ Compliance Set');
    }

    // 4. Phase 4: Trading
    console.log('\n💸 Phase 4: Trading Simulation...');
    if (!getState('MarketplaceFunded')) {
        const tx6 = await usdc.mint(aliceWallet.address, ethers.utils.parseUnits("500", 6), { gasPrice });
        await tx6.wait();
        const tx7 = await usdc.connect(aliceWallet).approve(marketplace.address, ethers.utils.parseUnits("500", 6), { gasPrice });
        await tx7.wait();
        saveState('MarketplaceFunded', 'true');
        console.log('  ✓ Alice Funded 500 USDC');
    }

    if (!getState('PurchaseComplete')) {
        console.log('  Alice purchasing 2 shares...');
        const buyTx = await marketplace.connect(aliceWallet).buyShares(tokenAddress, 2, { gasPrice, gasLimit: 1000000 });
        await buyTx.wait();
        saveState('PurchaseComplete', 'true');
        console.log('  ✓ Alice successfully bought 2 shares!');
    }

    console.log('\n✅ ALL PHASES COMPLETE! RWA ECOSYSTEM VERIFIED ON AMOY.');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
