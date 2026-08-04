import { ethers } from 'hardhat';
import * as fs from 'fs';
import * as path from 'path';

/**
 * ONE-TIME SETUP SCRIPT for Real Estate.
 * 
 * This script deploys modules (if missing) and registers the 
 * "REAL_ESTATE" asset type with the global AssetFactory. 
 * 
 * This script uses the UUPS upgradeable Proxy pattern for the SupplyLimitModule.
 * 
 * Run: npx hardhat run scripts/register-real-estate-amoy.ts --network polygon
 */

const platformPath = path.join(__dirname, '../deployments/asset-platform-amoy.json');
const DELAY_MS = 2000;

function readJson(p: string): any {
    return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {};
}

function savePlatformAddress(key: string, value: string) {
    const all = readJson(platformPath);
    all[key] = value;
    fs.writeFileSync(platformPath, JSON.stringify(all, null, 2));
}

async function delay(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
    const [deployer] = await ethers.getSigners();
    const platform = readJson(platformPath);

    if (!platform.AssetFactory) {
        throw new Error('Run deploy-asset-platform-amoy.ts first. AssetFactory not found.');
    }

    console.log('Deployer:', deployer.address);
    console.log('Connecting to AssetFactory at:', platform.AssetFactory);

    const assetFactory = await ethers.getContractAt('AssetFactory', platform.AssetFactory);
    const REAL_ESTATE = ethers.utils.formatBytes32String('REAL_ESTATE');

    // ===========================================================================
    // Step 1: SupplyLimitModule — implementation
    // ===========================================================================
    let supplyLimitImplAddress = platform.SupplyLimitModuleImpl;

    if (!supplyLimitImplAddress) {
        console.log('\n1. Deploying SupplyLimitModule implementation...');
        const impl = await ethers.deployContract('SupplyLimitModule', []);
        await impl.deployed();
        supplyLimitImplAddress = impl.address;
        savePlatformAddress('SupplyLimitModuleImpl', supplyLimitImplAddress);
        console.log(`  ✓ Impl deployed at: ${supplyLimitImplAddress}`);
        await delay(DELAY_MS);
    } else {
        console.log(`\n1. ✓ SupplyLimitModule impl already at: ${supplyLimitImplAddress}`);
    }

    // ===========================================================================
    // Step 2: SupplyLimitModule — UUPS proxy (permanent address)
    // ===========================================================================
    let supplyLimitProxyAddress = platform.SupplyLimitModuleProxy;

    if (!supplyLimitProxyAddress) {
        console.log('\n2. Deploying SupplyLimitModule proxy (UUPS)...');
        const supplyImpl = await ethers.getContractAt('SupplyLimitModule', supplyLimitImplAddress);
        const initData = supplyImpl.interface.encodeFunctionData('initialize', []);
        const proxy = await ethers.deployContract('ModuleProxy', [supplyLimitImplAddress, initData]);
        await proxy.deployed();
        supplyLimitProxyAddress = proxy.address;
        savePlatformAddress('SupplyLimitModuleProxy', supplyLimitProxyAddress);
        console.log(`  ✓ Proxy deployed at: ${supplyLimitProxyAddress}`);
        await delay(DELAY_MS);
    } else {
        console.log(`\n2. ✓ SupplyLimitModule proxy already at: ${supplyLimitProxyAddress}`);
    }

    // ===========================================================================
    // Step 3: Register REAL_ESTATE asset type using PROXY addresses
    // ===========================================================================
    if (!platform.RealEstateAssetTypeRegistered) {
        console.log('\n3. Registering REAL_ESTATE asset type on the Factory...');
        const tx = await assetFactory.connect(deployer).registerAssetType(REAL_ESTATE, [supplyLimitProxyAddress]);
        await tx.wait();
        savePlatformAddress('RealEstateAssetTypeRegistered', 'true');
        console.log('  ✓ Successfully bound SupplyLimitModule (proxy) to "REAL_ESTATE".');
    } else {
        console.log('\n3. ✓ REAL_ESTATE asset type is already registered.');
    }

    console.log('\n=============================================================');
    console.log('🚀 SETUP COMPLETE!');
    console.log('You must provide the following to your BACKEND team:');
    console.log('1. AssetFactory Address:      ', platform.AssetFactory);
    console.log('2. SupplyLimitModule (proxy): ', supplyLimitProxyAddress, '  <-- use this');
    console.log('3. Asset Type String:          "REAL_ESTATE"');
    console.log('\nWhen a user submits a form, the backend will use the Factory');
    console.log('to create the asset with these modules attached.');
    console.log('=============================================================');
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
