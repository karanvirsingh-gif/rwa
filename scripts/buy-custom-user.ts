import { ethers } from 'hardhat';
import * as fs from 'fs';
import * as path from 'path';

/**
 * CONFIGURATION
 */
const TOKEN_ADDRESS = "0xEA666A01880D529089e146dda6AFD0924aaf24Bf"; // The property token we used in identity register
const SHARE_COUNT = 2; // Number of shares to buy

async function main() {
    const [deployer] = await ethers.getSigners();
    
    // The custom User Wallet that we just registered in the whitelist
    const privateKey = "0x0d56d34ca575713569029c037a85ccaaa3850a648dbb1b81d1a32c2c0e19235b";
    const buyer = new ethers.Wallet(privateKey, ethers.provider);

    console.log(`\n💸 Buyer (${buyer.address}) getting ready to buy ${SHARE_COUNT} Shares for Token: ${TOKEN_ADDRESS}...`);

    const amoyPath = path.join(__dirname, '../deployments/amoy.json');
    const addr = JSON.parse(fs.readFileSync(amoyPath, 'utf8'));
    const feeData = await ethers.provider.getFeeData();
    const gasPrice = feeData.gasPrice?.mul(150).div(100) || ethers.utils.parseUnits('35', 'gwei');

    // --- STEP 1: FUNDING THE NEW WALLET WITH MATIC FOR GAS ---
    // Because this is a brand new wallet, it doesn't have any native crypto to pay for gas! 
    // The Admin will send it a little bit of MATIC first.
    const maticBalance = await ethers.provider.getBalance(buyer.address);
    if (maticBalance.lt(ethers.utils.parseEther("0.1"))) {
        console.log("   ⚠️ Buyer needs MATIC for gas fees! Sending 0.2 MATIC from admin...");
        const tx = await deployer.sendTransaction({
            to: buyer.address,
            value: ethers.utils.parseEther("0.2"),
            gasPrice
        });
        await tx.wait(2);
        console.log("   ✓ MATIC Received!");
    } else {
        console.log("   ✓ Buyer has sufficient MATIC for gas.");
    }

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

    const rawAmount = ethers.utils.parseUnits(SHARE_COUNT.toString(), decimals);
    const totalCost = rawAmount.mul(pricePerShare).div(ethers.BigNumber.from(10).pow(decimals));

    // --- STEP 2: FUNDING THE USER WITH USDC ---
    const usdcBalance = await usdc.balanceOf(buyer.address);
    if (usdcBalance.lt(totalCost)) {
        console.log('   ⚠️ Buyer low on USDC. Admin minting test funds...');
        const nonce = await ethers.provider.getTransactionCount(deployer.address);
        const mintTx = await usdc.mint(buyer.address, totalCost.mul(2), { gasPrice, nonce }); 
        await mintTx.wait(2);
        console.log('   ✓ USDC Minted!');
    } else {
        console.log('   ✓ Buyer has sufficient USDC.');
    }

    // --- STEP 3: BUYER APPROVES MARKETPLACE ---
    console.log('   Approving Marketplace to spend USDC...');
    const buyerNonce1 = await ethers.provider.getTransactionCount(buyer.address);
    const approveTx = await usdc.connect(buyer).approve(marketplace.address, totalCost, { gasPrice, nonce: buyerNonce1 });
    await approveTx.wait(2);

    // --- STEP 4: BUYER MAKES PURCHASE ---
    console.log('   Executing purchase through Marketplace (Compliance verification running in background!)...');
    const buyerNonce2 = await ethers.provider.getTransactionCount(buyer.address);
    const buyTx = await marketplace.connect(buyer).buyShares(TOKEN_ADDRESS, rawAmount, { gasPrice, gasLimit: 800000, nonce: buyerNonce2 });
    const receipt = await buyTx.wait(2);

    console.log(`   ✓ Transaction Success: ${receipt.transactionHash}`);

    // --- STEP 5: DISPLAY FINAL BALANCES ---
    const finalBalance = await token.balanceOf(buyer.address);
    console.log(`\n✅ PURCHASE COMPLETE!`);
    console.log(`   Buyer (${buyer.address}) now successfully owns: ${ethers.utils.formatUnits(finalBalance, decimals)} full shares of the Property!`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
