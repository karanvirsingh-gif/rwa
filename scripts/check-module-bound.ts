import { ethers } from "hardhat";

async function main() {
    const modularComplianceAddress = "0x46F4Ca9eC240173cE833f35fF2515d0A94538F90";
    const supplyLimitAddress = "0x8f476bb91026Fb66a0B71656089c85984CA18B8A";

    console.log(`Checking if SupplyLimitModule (${supplyLimitAddress}) is bound to ModularCompliance (${modularComplianceAddress})...`);

    // We can use the IModularCompliance interface
    const modularCompliance = await ethers.getContractAt("IModularCompliance", modularComplianceAddress);

    try {
        const isBound = await modularCompliance.isModuleBound(supplyLimitAddress);
        console.log(`Is the module bound? ${isBound}`);
        
        if (isBound) {
            console.log("✅ The Supply Limit Module IS bound to the Modular Compliance contract.");
        } else {
            console.log("❌ The Supply Limit Module IS NOT bound to the Modular Compliance contract.");
        }
    } catch (error) {
        console.error("Error checking if module is bound:", error);
    }
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
