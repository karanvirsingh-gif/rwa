import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

async function main() {
    // Target Token to attest gold for
    const tokenAddress = "0x7cb758c1109bf33512b0666b761dbD19728E3068";
    
    // Amount to attest (in this example: 10,000 grams, but adjust based on your decimals if needed)
    // If your token has 0 decimals and 1 token = 1 gram, then you just pass the integer.
    // If the token uses 18 decimals, you would use parseUnits. 
    // Usually, physical reserves use the raw token amount corresponding to decimals.
    // We will set 50,000 tokens (grams) worth of attestation as an example.
    const amountToAttest = ethers.utils.parseUnits("50000", 18); // Changed to 18 decimals
    const unitLabel = "grams";
    const evidenceRef = "BRINKS_RECEIPT_2026_07_30";

    const [admin] = await ethers.getSigners();
    
    // Load platform deployments to get PhysicalReserveModule
    const amoyPath = path.join(__dirname, "../deployments/asset-platform-amoy.json");
    let physicalReserveModuleAddress = "";
    if (fs.existsSync(amoyPath)) {
        const addr = JSON.parse(fs.readFileSync(amoyPath, "utf8"));
        physicalReserveModuleAddress = addr.PhysicalReserveModule;
    }

    if (!physicalReserveModuleAddress) {
        console.error("❌ PhysicalReserveModule address not found in deployments!");
        return;
    }

    console.log(`\n==============================================`);
    console.log(`🏦 ATTESTING PHYSICAL RESERVE`);
    console.log(`==============================================`);
    console.log(`📍 Token Address:           ${tokenAddress}`);
    console.log(`📍 Physical Reserve Module: ${physicalReserveModuleAddress}`);
    console.log(`🔑 Admin (Signer):          ${admin.address}`);
    console.log(`📦 Amount to Attest:        ${ethers.utils.formatUnits(amountToAttest, 18)} ${unitLabel}`);
    
    // 1. Get the Token and its bound Compliance contract
    const token = await ethers.getContractAt("IToken", tokenAddress);
    
    let complianceAddress;
    try {
        complianceAddress = await token.compliance();
        console.log(`✅ Token Compliance Contract: ${complianceAddress}`);
    } catch (e) {
        console.error("❌ Failed to fetch compliance address. Is the token address correct?");
        return;
    }

    // 2. Connect to the Physical Reserve Module
    const reserveModule = await ethers.getContractAt("PhysicalReserveModule", physicalReserveModuleAddress);
    
    // 3. Check if admin has RESERVE_MANAGER_ROLE
    const RESERVE_MANAGER_ROLE = await reserveModule.RESERVE_MANAGER_ROLE();
    const hasRole = await reserveModule.hasRole(RESERVE_MANAGER_ROLE, admin.address);
    if (!hasRole) {
        console.error(`\n❌ ERROR: Your wallet (${admin.address}) does NOT have RESERVE_MANAGER_ROLE.`);
        console.error(`Only an account with this role can attest the reserve.`);
        return;
    }

    console.log(`\n⏳ Submitting attestation transaction to blockchain...`);
    
    // 4. Send the attestation transaction
    const tx = await reserveModule.connect(admin).attestAllocation(
        complianceAddress,
        amountToAttest,
        unitLabel,
        evidenceRef
    );

    console.log(`   Transaction sent! Hash: ${tx.hash}`);
    await tx.wait();
    
    console.log(`\n🎉 SUCCESS! Physical reserve successfully attested.`);
    console.log(`You can now mint up to ${ethers.utils.formatUnits(amountToAttest, 18)} ${unitLabel} for this token.`);
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
