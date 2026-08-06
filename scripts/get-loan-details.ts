import { ethers } from 'hardhat';

/**
 * Script to fetch the loan details from the RWALifecycleModule for a specific asset.
 * 
 * Usage:
 * Run: TOKEN_ADDRESS=0xYourTokenAddress npx hardhat run scripts/get-loan-details.ts --network polygon
 * You can also specify MODULE_ADDRESS to skip auto-detection:
 * MODULE_ADDRESS=0xYourModuleAddress TOKEN_ADDRESS=0xYourTokenAddress npx hardhat run scripts/get-loan-details.ts --network polygon
 */

async function main() {
    const TOKEN_ADDRESS = process.env.TOKEN_ADDRESS || '0xf1E27F371F4383173bbB055cA01A267872E23cF3';
    const MODULE_ADDRESS = "0x22a8d9633424593dF47CC78a726D0D049665Dfcb";

    if (!TOKEN_ADDRESS) {
        throw new Error('Please provide a TOKEN_ADDRESS in the script or via environment variable.');
    }

    console.log(`\n======================================================`);
    console.log(`🔍 Fetching Loan Details for Asset: ${TOKEN_ADDRESS}`);
    console.log(`======================================================\n`);

    let moduleAddressToUse = MODULE_ADDRESS;
    let loanDetails: any = null;

    if (!moduleAddressToUse) {
        console.log('No MODULE_ADDRESS provided. Attempting to find RWALifecycleModule from token compliance...\n');
        const token = await ethers.getContractAt('Token', TOKEN_ADDRESS);

        let complianceAddress;
        try {
            complianceAddress = await token.compliance();
        } catch (e) {
            throw new Error('Failed to fetch compliance address. Is this a valid T-REX token?');
        }

        if (complianceAddress === ethers.constants.AddressZero) {
            throw new Error('Compliance address is zero.');
        }

        const compliance = await ethers.getContractAt('ModularCompliance', complianceAddress);
        const boundModules = await compliance.getModules();

        for (const mod of boundModules) {
            try {
                const lifecycleModule = await ethers.getContractAt('RWALifecycleModule', mod);
                const details = await lifecycleModule.loanConfigs(TOKEN_ADDRESS);

                // If we successfully fetched the details, this might be the right module
                if (details) {
                    moduleAddressToUse = mod;
                    loanDetails = details;
                    // If borrower is initialized, we are sure this is the correct one
                    if (details.borrower !== ethers.constants.AddressZero) {
                        break;
                    }
                }
            } catch (e) {
                // Ignore and continue, this module doesn't have loanConfigs
            }
        }

        if (!moduleAddressToUse) {
            throw new Error("Could not automatically find an RWALifecycleModule bound to this asset. Please provide MODULE_ADDRESS via environment variable.");
        }
    }

    console.log(`✅ Found RWALifecycleModule at: ${moduleAddressToUse}`);

    if (!loanDetails) {
        const lifecycleModule = await ethers.getContractAt('RWALifecycleModule', moduleAddressToUse);
        loanDetails = await lifecycleModule.loanConfigs(TOKEN_ADDRESS);
    }

    // Token decimals for target principal
    const token = await ethers.getContractAt('Token', TOKEN_ADDRESS);
    let decimals = 18;
    try {
        decimals = await token.decimals();
    } catch (e) { }

    console.log(`\n📋 Loan Details:`);
    console.log(`   - Asset Type:         ${loanDetails.assetType}`);
    console.log(`   - Target Principal:   ${ethers.utils.formatUnits(loanDetails.targetPrincipal, decimals)}`);
    console.log(`   - Funding Deadline:   ${loanDetails.fundingDeadline.toNumber() === 0 ? 'Not Set' : new Date(loanDetails.fundingDeadline.toNumber() * 1000).toLocaleString()}`);
    console.log(`   - Maturity Timestamp: ${loanDetails.maturityTimestamp.toNumber() === 0 ? 'Not Set' : new Date(loanDetails.maturityTimestamp.toNumber() * 1000).toLocaleString()}`);
    console.log(`   - Payment Frequency:  ${loanDetails.paymentFrequency.toString()} seconds`);
    console.log(`   - Coupon Rate:        ${loanDetails.couponRateBps.toNumber() / 100}% (${loanDetails.couponRateBps} bps)`);
    console.log(`   - Agreement Hash:     ${loanDetails.agreementHash}`);
    console.log(`   - Borrower:           ${loanDetails.borrower}`);

    // Example states, mapping might be different based on actual implementation
    // 0: PENDING, 1: FUNDING, 2: ACTIVE, 3: DEFAULTED, 4: MATURED, 5: REFUNDED
    const stateMapping = ['PENDING', 'FUNDING', 'ACTIVE', 'DEFAULTED', 'MATURED', 'REFUNDED'];
    const stateStr = stateMapping[loanDetails.state] || loanDetails.state.toString();

    console.log(`   - State:              ${stateStr}`);
    console.log(`   - Has Refund:         ${loanDetails.hasRefund}`);
    console.log(`   - Has Maturity:       ${loanDetails.hasMaturity}`);
    console.log(`\n======================================================\n`);
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
