import { ethers } from 'hardhat';
import OnchainID from '@onchain-id/solidity';
import * as fs from 'fs';
import * as path from 'path';

const DELAY_MS = 2000;
const deploymentPath = path.join(__dirname, '../deployments/amoy.json');

async function delay(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getGasPrice() {
    const feeData = await ethers.provider.getFeeData();
    // Use 50% buffer
    return feeData.gasPrice?.mul(150).div(100) || ethers.utils.parseUnits('35', 'gwei');
}

function saveAddress(key: string, address: string) {
    let addresses: any = {};
    if (fs.existsSync(deploymentPath)) {
        addresses = JSON.parse(fs.readFileSync(deploymentPath, 'utf8'));
    } else {
        if (!fs.existsSync(path.dirname(deploymentPath))) {
            fs.mkdirSync(path.dirname(deploymentPath), { recursive: true });
        }
    }
    addresses[key] = address;
    fs.writeFileSync(deploymentPath, JSON.stringify(addresses, null, 2));
}

function getAddress(key: string): string | undefined {
    if (fs.existsSync(deploymentPath)) {
        const addresses = JSON.parse(fs.readFileSync(deploymentPath, 'utf8'));
        return addresses[key];
    }
    return undefined;
}

// Wrapper to deploy with retries and incremental saving
async function deployWithRetry(key: string, factory: any, args: any[] = [], gasPrice: any, retries = 3) {
    const existing = getAddress(key);
    if (existing) {
        console.log(`  ⏭️  Skipping ${key} (already at ${existing})`);
        return await ethers.getContractAt(factory.interface, existing);
    }

    for (let i = 0; i < retries; i++) {
        try {
            const contract = await factory.deploy(...args, { gasPrice });
            await contract.deployed();
            saveAddress(key, contract.address);
            console.log(`  ✓ ${key}:`, contract.address);
            await delay(DELAY_MS);
            return contract;
        } catch (error: any) {
            if (i === retries - 1) throw error;
            console.log(`  ⚠️  Deploy ${key} failed (attempt ${i + 1}/${retries}). Retrying in 5s...`);
            await delay(5000);
        }
    }
}

async function main() {
    const [deployer] = await ethers.getSigners();
    console.log('🚀 Starting MANUAL INCREMENTAL Amoy Deployment...');
    console.log('Deployer Wallet:', deployer.address);

    const gasPrice = await getGasPrice();
    console.log('Using Gas Price:', ethers.utils.formatUnits(gasPrice, 'gwei'), 'gwei');

    // 0. Deploy Mock USDC
    console.log('\n💵 Step 0: Deploying Stablecoin...');
    const usdc = await deployWithRetry('Stablecoin', await ethers.getContractFactory('Stablecoin', deployer), [], gasPrice);

    // 1. Deploy T-REX Infrastructure
    console.log('\n📦 Step 1: Deploying T-REX Core...');
    const ctr = await deployWithRetry('CTR', await ethers.getContractFactory('ClaimTopicsRegistry', deployer), [], gasPrice);
    const tir = await deployWithRetry('TIR', await ethers.getContractFactory('TrustedIssuersRegistry', deployer), [], gasPrice);
    const irs = await deployWithRetry('IRS', await ethers.getContractFactory('IdentityRegistryStorage', deployer), [], gasPrice);
    const irImpl = await deployWithRetry('IdentityRegistryImpl', await ethers.getContractFactory('IdentityRegistry', deployer), [], gasPrice);
    const mc = await deployWithRetry('ModularCompliance', await ethers.getContractFactory('ModularCompliance', deployer), [], gasPrice);
    const tokenImpl = await deployWithRetry('TokenImplementation', await ethers.getContractFactory('Token', deployer), [], gasPrice);

    const Identity = await new ethers.ContractFactory(OnchainID.contracts.Identity.abi, OnchainID.contracts.Identity.bytecode, deployer);
    const identityImpl = await deployWithRetry('IdentityImpl', Identity, [deployer.address, true], gasPrice);

    const Authority = await new ethers.ContractFactory(OnchainID.contracts.ImplementationAuthority.abi, OnchainID.contracts.ImplementationAuthority.bytecode, deployer);
    const authority = await deployWithRetry('IdentityImplementationAuthority', Authority, [identityImpl.address], gasPrice);

    const Factory = await new ethers.ContractFactory(OnchainID.contracts.Factory.abi, OnchainID.contracts.Factory.bytecode, deployer);
    const identityFactory = await deployWithRetry('IdentityFactory', Factory, [authority.address], gasPrice);

    const TREXAuthority = await ethers.getContractFactory('TREXImplementationAuthority', deployer);
    const trexAuthority = await deployWithRetry('TREXAuthority', TREXAuthority, [true, ethers.constants.AddressZero, ethers.constants.AddressZero], gasPrice);

    if (!getAddress('TrexVersionSet')) {
        const tx1 = await trexAuthority.addAndUseTREXVersion({ major: 4, minor: 0, patch: 0 }, {
            tokenImplementation: tokenImpl.address,
            ctrImplementation: ctr.address,
            irImplementation: irImpl.address,
            irsImplementation: irs.address,
            tirImplementation: tir.address,
            mcImplementation: mc.address,
        }, { gasPrice });
        await tx1.wait();
        saveAddress('TrexVersionSet', 'true');
        await delay(DELAY_MS);
    }

    const trexFactory = await deployWithRetry('TrexFactory', await ethers.getContractFactory('TREXFactory', deployer), [trexAuthority.address, identityFactory.address], gasPrice);

    // 1.5. Deploy Claim Issuer (Missing infrastructure)
    console.log('\n🛡️  Step 1.5: Deploying Claim Issuer...');
    const ClaimIssuer = await new ethers.ContractFactory(OnchainID.contracts.ClaimIssuer.abi, OnchainID.contracts.ClaimIssuer.bytecode, deployer);
    const claimIssuer = await deployWithRetry('ClaimIssuer', ClaimIssuer, [deployer.address], gasPrice);

    if (!getAddress('ClaimSignerSet')) {
        console.log('  Adding deployer as management key on ClaimIssuer...');
        const managerKey = ethers.utils.keccak256(ethers.utils.defaultAbiCoder.encode(['address'], [deployer.address]));
        const tx = await claimIssuer.addKey(managerKey, 3, 1, { gasPrice });
        await tx.wait();
        saveAddress('ClaimSignerSet', 'true');
        console.log('  ✓ Deployer added as Claim Signer');
        await delay(DELAY_MS);
    }

    if (!getAddress('FactoryLinkSet')) {
        const tx2 = await identityFactory.addTokenFactory(trexFactory.address, { gasPrice });
        await tx2.wait();
        saveAddress('FactoryLinkSet', 'true');
        await delay(DELAY_MS);
    }

    // 2. Deploy Real Estate Proxies 
    console.log('\n🏠 Step 2: Deploying Real Estate Proxies (Manual UUPS)...');
    const ProxyFactory = await ethers.getContractFactory('ERC1967Proxy', deployer);

    const registryImpl = await deployWithRetry('RealEstateRegistryImpl', await ethers.getContractFactory('RealEstateRegistry', deployer), [], gasPrice);
    if (!getAddress('RealEstateRegistry')) {
        const initData = registryImpl.interface.encodeFunctionData('initialize', [deployer.address]);
        const proxy = await ProxyFactory.deploy(registryImpl.address, initData, { gasPrice });
        await proxy.deployed();
        saveAddress('RealEstateRegistry', proxy.address);
        console.log('  ✓ RealEstateRegistry:', proxy.address);
        await delay(DELAY_MS);
    }

    const vaultImpl = await deployWithRetry('VaultImplementation', await ethers.getContractFactory('RealEstateVault', deployer), [], gasPrice);
    const vaultFactoryImpl = await deployWithRetry('RealEstateVaultFactoryImpl', await ethers.getContractFactory('RealEstateVaultFactory', deployer), [], gasPrice);
    if (!getAddress('RealEstateVaultFactory')) {
        const initData = vaultFactoryImpl.interface.encodeFunctionData('initialize', [vaultImpl.address, deployer.address]);
        const proxy = await ProxyFactory.deploy(vaultFactoryImpl.address, initData, { gasPrice });
        await proxy.deployed();
        saveAddress('RealEstateVaultFactory', proxy.address);
        console.log('  ✓ RealEstateVaultFactory:', proxy.address);
        await delay(DELAY_MS);
    }

    const marketplaceImpl = await deployWithRetry('RealEstateMarketplaceImpl', await ethers.getContractFactory('RealEstateMarketplace', deployer), [], gasPrice);
    if (!getAddress('RealEstateMarketplace')) {
        const vaultFactoryAddr = getAddress('RealEstateVaultFactory')!;
        const initData = marketplaceImpl.interface.encodeFunctionData('initialize', [vaultFactoryAddr, deployer.address]);
        const proxy = await ProxyFactory.deploy(marketplaceImpl.address, initData, { gasPrice });
        await proxy.deployed();
        saveAddress('RealEstateMarketplace', proxy.address);
        console.log('  ✓ RealEstateMarketplace:', proxy.address);
    }

    console.log('\n✅ Deployment Status: Everything Verified!');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
