import { ethers } from 'hardhat';
import * as fs from 'fs';
import * as path from 'path';

/**
 * CONFIGURATION
 * Provide the Token Address and the number of shares you want to buy!
 */
const TOKEN_ADDRESS = "0x18cCC7470cf606B5079B1bdEd906e614aB8962AB"; // Change this to your new Property Token
const SHARE_COUNT = 2; // Number of shares to buy

const amoyPath = path.join(__dirname, '../deployments/amoy.json');

async function main() {
    const [deployer, aliceWallet] = await ethers.getSigners();
    const buyer = aliceWallet; // We simulate Alice buying

    console.log(`\n💸 Buying ${SHARE_COUNT} Shares for Token: ${TOKEN_ADDRESS}...`);

    const addr = JSON.parse(fs.readFileSync(amoyPath, 'utf8'));
    const feeData = await ethers.provider.getFeeData();
    const gasPrice = feeData.gasPrice?.mul(150).div(100) || ethers.utils.parseUnits('35', 'gwei');

    const marketplace = await ethers.getContractAt('RealEstateMarketplace', addr.RealEstateMarketplace);
    const usdc = await ethers.getContractAt('Stablecoin', addr.Stablecoin);
    const token = await ethers.getContractAt('Token', TOKEN_ADDRESS);
    const vaultAddr = await (await ethers.getContractAt('RealEstateVaultFactory', addr.RealEstateVaultFactory)).vaults(TOKEN_ADDRESS);

    if (vaultAddr === ethers.constants.AddressZero) {
        throw new Error("No Vault found for this token address!");
    }
    const vault = await ethers.getContractAt('RealEstateVault', vaultAddr);
    const decimals = await token.decimals();
    const pricePerShare = await vault.pricePerShare();

    // Convert 5 -> 5,000,000 (raw amount for 6 decimals)
    const rawAmount = ethers.utils.parseUnits(SHARE_COUNT.toString(), decimals);

    // totalCost = (rawAmount * pricePerShare) / 10^decimals
    const totalCost = rawAmount.mul(pricePerShare).div(ethers.BigNumber.from(10).pow(decimals));

    console.log(`   Shares Requested: ${SHARE_COUNT} full shares`);
    console.log(`   Price per share: ${ethers.utils.formatUnits(pricePerShare, 6)} USDC`);
    console.log(`   Total Cost: ${ethers.utils.formatUnits(totalCost, 6)} USDC`);

    // 1. Funding Check (Optional for simulation)
    const balance = await usdc.balanceOf(buyer.address);
    if (balance.lt(totalCost)) {
        console.log('   ⚠️ Buyer low on USDC. Minting test funds...');
        const mintTx = await usdc.mint(buyer.address, 1000000000, { gasPrice });
        await mintTx.wait();
    }

    // 2. Approve Marketplace
    console.log('   Approving Marketplace to spend USDC...');
    const approveTx = await usdc.connect(buyer).approve(marketplace.address, totalCost, { gasPrice });
    await approveTx.wait();

    // 3. Purchase
    console.log('   Executing purchase through Marketplace...');
    // We pass the RAW amount (5,000,000) not the human number (5)
    const buyTx = await marketplace.connect(buyer).buyShares(TOKEN_ADDRESS, rawAmount, { gasPrice, gasLimit: 800000 });
    const receipt = await buyTx.wait();

    console.log(`   Transaction: ${receipt.transactionHash}`);

    // 4. Check Final Balance, Vault Balance and Total Supply
    const finalBalance = await token.balanceOf(buyer.address);
    const vaultBalance = await token.balanceOf(vaultAddr);
    const totalSupply = await token.totalSupply();
    console.log(`\n📊 PROPERTY STATS:`);
    console.log(`   Total Supply:  ${ethers.utils.formatUnits(totalSupply, decimals)} shares (Constant)`);
    console.log(`   Vault Balance: ${ethers.utils.formatUnits(vaultBalance, decimals)} shares (Decreasing)`);
    console.log(`   Buyer Balance: ${ethers.utils.formatUnits(finalBalance, decimals)} shares (Increasing)`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
