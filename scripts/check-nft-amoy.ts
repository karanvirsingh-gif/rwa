import { ethers } from 'hardhat';
import * as fs from 'fs';
import * as path from 'path';

async function main() {
    const amoyPath = path.join(__dirname, '../deployments/amoy.json');
    if (!fs.existsSync(amoyPath)) {
        throw new Error("No amoy.json found. Please deploy infrastructure first.");
    }
    const addr = JSON.parse(fs.readFileSync(amoyPath, 'utf8'));

    // Connect to the Registry
    const registry = await ethers.getContractAt('RealEstateRegistry', addr.RealEstateRegistry);

    // Check the latest Property
    // Note: AMOY-RWA-012 was likely ID 2 or 3 depending on previous runs
    // Let's try to find the current count
    console.log(`\n🔍 Connecting to Property Registry: ${addr.RealEstateRegistry}`);

    // We can iterate or just try ID 2 as per your previous run
    const tokenId = 3;

    try {
        console.log(`\n🖼️  Checking NFT Data for Property ID: ${tokenId}...`);

        const owner = await registry.ownerOf(tokenId);
        const uri = await registry.tokenURI(tokenId);
        const tokenAddr = await registry.propertyTokens(tokenId);
        const vaultAddr = await registry.propertyVaults(tokenId);

        console.log(`   Owner: ${owner}`);
        console.log(`   Metadata (URI): ${uri}`);
        console.log(`   Linked Token: ${tokenAddr}`);
        console.log(`   Linked Vault: ${vaultAddr}`);

        console.log(`\n✅ NFT Found! This is the 'Legal Deed' for your property shares.`);
    } catch (error) {
        console.log(`\n❌ Could not find NFT with ID ${tokenId}. Your latest property might have a different ID.`);
        console.log(`   Try changing 'tokenId' in this script if you have registered multiple properties.`);
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});