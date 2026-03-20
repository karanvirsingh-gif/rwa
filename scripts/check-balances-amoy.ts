import { ethers } from 'hardhat';
import * as fs from 'fs';
import * as path from 'path';

/**
 * CONFIGURATION
 * Provide the Token Address you want to check!
 */
const TOKEN_ADDRESS = "0x18cCC7470cf606B5079B1bdEd906e614aB8962AB"; // Property Token

const amoyPath = path.join(__dirname, '../deployments/amoy.json');

async function main() {
    const [deployer, aliceWallet] = await ethers.getSigners();
    const user = aliceWallet;

    console.log(`\n🔍 Checking Balances for User: ${user.address}`);

    const addr = JSON.parse(fs.readFileSync(amoyPath, 'utf8'));
    const usdc = await ethers.getContractAt('Stablecoin', addr.Stablecoin);
    const token = await ethers.getContractAt('Token', TOKEN_ADDRESS);

    // 1. Check USDC
    const usdcBalance = await usdc.balanceOf(user.address);
    console.log(`   💵 USDC balance: ${ethers.utils.formatUnits(usdcBalance, 6)} USDC (Raw: ${usdcBalance.toString()})`);

    // 2. Check RWA Shares
    const rwaBalance = await token.balanceOf(user.address);
    const ticker = await token.symbol();
    const decimals = await token.decimals();
    console.log(`   🏢 RWA Shares (${ticker}): ${ethers.utils.formatUnits(rwaBalance, decimals)} shares (Raw Units: ${rwaBalance.toString()})`);

    if (rwaBalance.gt(0)) {
        console.log('\n✨ CONFIRMED: Alice is now a shareholder in this property!');
    } else {
        console.log('\n❌ This wallet does not hold any shares of this property.');
    }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
