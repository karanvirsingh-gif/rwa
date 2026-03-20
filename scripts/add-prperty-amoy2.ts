import { ethers } from 'hardhat';
import * as fs from 'fs';
import * as path from 'path';

const amoyPath = path.join(__dirname, '../deployments/amoy.json');

async function main() {
    const feeData = await ethers.provider.getFeeData();
    const gasPrice = feeData.gasPrice?.mul(150).div(100) || ethers.utils.parseUnits('35', 'gwei');

    const addr = JSON.parse(fs.readFileSync(amoyPath, 'utf8'));

    // Load Identities from state
    const statePath = path.join(__dirname, '../deployments/interact-state.json');
    if (!fs.existsSync(statePath)) throw new Error("Please run interact-amoy.ts first to create global identities!");
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));

    const irAddress = "0x552AEa3ae836714eE2c0408982047a5Ae70f32C8";
    const ir = await ethers.getContractAt('IdentityRegistry', irAddress);

    console.log(`\n👤 Verifying Identities (Syncing KYC to NEW Token Registry ${irAddress})...`);

    async function ensureVerified(userKey: string, userAddr: string, idAddr: string) {
        console.log(`   Syncing ${userKey} (${userAddr})...`);
        const isRegistered = await ir.contains(userAddr);
        if (!isRegistered) {
            console.log(`     Not registered. Registering now...`);
            const txA = await ir.registerIdentity(userAddr, idAddr, 42, { gasPrice, gasLimit: 800000 });
            await txA.wait();
        } else {
             console.log(`     Already registered!`);
        }

        const verified = await ir.isVerified(userAddr);
        if (!verified) throw new Error(`${userKey} verification failed on new token registry`);
        console.log(`     ✅ Verified`);
    }

    // ONLY running for Marketplace as requested
    await ensureVerified('Marketplace', addr.RealEstateMarketplace, state['ID_Marketplace']);

    console.log('\n✅ Marketplace Identity Registration Complete!');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
