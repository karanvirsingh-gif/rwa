import { ethers } from 'hardhat';
import * as fs from 'fs';
import * as path from 'path';
import OnchainID from '@onchain-id/solidity';

async function verifyNewUser(userWalletAddress: string, tokenAddress: string) {
    const [deployer] = await ethers.getSigners();
    const platformPath = path.join(__dirname, '../deployments/asset-platform-amoy.json');
    const platform = JSON.parse(fs.readFileSync(platformPath, 'utf8'));

    const token = await ethers.getContractAt('Token', tokenAddress);
    const irAddress = await token.identityRegistry();
    const ir = await ethers.getContractAt('IdentityRegistry', irAddress);
    const claimTopic = ethers.utils.keccak256(ethers.utils.toUtf8Bytes('KYC_CLAIM'));
    const gasPrice = ethers.utils.parseUnits('40', 'gwei');

    const isVerified = await ir.isVerified(userWalletAddress);
    if (isVerified) {
        console.log(`[Verification] User ${userWalletAddress} is already verified.`);
        return;
    }

    let idAddr = await ir.identity(userWalletAddress);

    if (idAddr === ethers.constants.AddressZero) {
        console.log(`\n[Verification] Deploying Identity for User...`);
        const IdentityProxy = await ethers.getContractFactory(
            OnchainID.contracts.IdentityProxy.abi,
            OnchainID.contracts.IdentityProxy.bytecode,
            deployer
        );
        const idProxy = await IdentityProxy.deploy(
            platform.IdentityImplementationAuthority,
            deployer.address,
            { gasPrice, gasLimit: 2000000 }
        );
        await idProxy.deployed();
        idAddr = idProxy.address;
        console.log(`[Verification] ONCHAINID Created at: ${idAddr}`);

        console.log(`[Verification] Waiting 15 seconds for Polygon nodes...`);
        await new Promise((resolve) => setTimeout(resolve, 15000));
    } else {
        console.log(`\n[Verification] User has existing identity at: ${idAddr}`);
    }

    const data = ethers.utils.hexlify(ethers.utils.toUtf8Bytes('Verified'));
    const hash = ethers.utils.keccak256(
        ethers.utils.defaultAbiCoder.encode(['address', 'uint256', 'bytes'], [idAddr, claimTopic, data])
    );
    const signature = await deployer.signMessage(ethers.utils.arrayify(hash));
    const id = await ethers.getContractAt(OnchainID.contracts.Identity.abi, idAddr);

    console.log(`[Verification] Adding KYC Claim...`);
    const txClaim = await id.addClaim(claimTopic, 1, platform.ClaimIssuer, signature, data, '', { gasPrice, gasLimit: 800000 });
    await txClaim.wait();

    if (await ir.identity(userWalletAddress) === ethers.constants.AddressZero) {
        console.log(`[Verification] Registering User...`);
        const txRegister = await ir.registerIdentity(userWalletAddress, idAddr, 42, { gasPrice, gasLimit: 800000 });
        await txRegister.wait();
        console.log(`[Verification] User registered successfully!`);
    } else {
        console.log(`[Verification] KYC Claim updated on existing identity!`);
    }
}

async function main() {
    const [deployer] = await ethers.getSigners();
    const gasPrice = ethers.utils.parseUnits('40', 'gwei');

    // Load deployments
    const p = path.join(__dirname, '../deployments/private-credit-assets-amoy.json');
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    const platformPath = path.join(__dirname, '../deployments/asset-platform-amoy.json');
    const platform = JSON.parse(fs.readFileSync(platformPath, 'utf8'));
    const keys = Object.keys(data);
    const lastKey = keys[keys.length - 1];
    const asset = data[lastKey];

    console.log(`\n=== Testing Deposit and RedeemRecovery for ${lastKey} ===`);

    const token = await ethers.getContractAt('Token', asset.token);
    const vault = await ethers.getContractAt('AssetVault', asset.vault);
    const treasury = await ethers.getContractAt('AssetTreasury', asset.treasury);
    const lifecycleModule = await ethers.getContractAt('RWALifecycleModule', asset.stateModule);
    const stablecoin = await ethers.getContractAt('Stablecoin', '0xF39906465Ac54E2370c4a189Af83b143f99F7010'); // USDC from amoy.json

    // Test user
    const userPrivateKey = "0x0d56d34ca575713569029c037a85ccaaa3850a648dbb1b81d1a32c2c0e19235b";
    const user = new ethers.Wallet(userPrivateKey, ethers.provider);

    // Give user some MATIC if needed
    const maticBalance = await ethers.provider.getBalance(user.address);
    if (maticBalance.lt(ethers.utils.parseEther("0.1"))) {
        console.log(`[Setup] Sending MATIC to user...`);
        const tx = await deployer.sendTransaction({ to: user.address, value: ethers.utils.parseEther("0.2"), gasPrice });
        await tx.wait();
    }

    // Verify user in IdentityRegistry
    await verifyNewUser(user.address, asset.token);

    // 1. Initial State Check & Fund Loan
    let config = await lifecycleModule.loanConfigs(asset.token);
    let state = config.state;
    console.log(`\n[State] Current State: ${state} (0=FUNDING, 1=ACTIVE, 2=MATURED, 3=DEFAULTED, 4=REFUND, 5=RECOVERY)`);

    let supply = await token.totalSupply();
    if (supply.eq(0)) {
        if (state !== 0) {
            throw new Error(`Token supply is 0 but state is not FUNDING. It is ${state}`);
        }
        console.log(`\n[Fund] Supply is 0. Buying tokens to fund the loan...`);
        const targetPrincipalUsdc = ethers.utils.parseUnits(asset.targetPrincipalUsdc.toString(), 6);
        
        console.log(`[Fund] Setting Supply Limit for compliance...`);
        const complianceAddress = await token.compliance();
        const compliance = await ethers.getContractAt('ModularCompliance', complianceAddress);
        const supplyModule = await ethers.getContractAt('SupplyLimitModule', platform.SupplyLimitModuleProxy);
        const callData = supplyModule.interface.encodeFunctionData('setSupplyLimit', [targetPrincipalUsdc]);
        const supplyTx = await compliance.connect(deployer).callModuleFunction(callData, platform.SupplyLimitModuleProxy, { gasPrice, gasLimit: 800000 });
        await supplyTx.wait();

        // Ensure user has enough USDC
        let userUsdc = await stablecoin.balanceOf(user.address);
        if (userUsdc.lt(targetPrincipalUsdc)) {
            console.log(`[Fund] Minting USDC to user...`);
            const mintTx = await stablecoin.mint(user.address, targetPrincipalUsdc.mul(2), { gasPrice });
            await mintTx.wait();
        }

        // Approve and Buy
        console.log(`[Fund] User approving Vault for USDC...`);
        const approveTx = await stablecoin.connect(user).approve(vault.address, targetPrincipalUsdc, { gasPrice });
        await approveTx.wait();

        console.log(`[Fund] User calling vault.buy()...`);
        const tokenDecimals = await token.decimals();
        // Calculate amount of tokens to buy (assuming 1 token = 1 USDC or based on pricePerUnit)
        const pricePerUnit = await vault.pricePerUnit();
        // cost = amount * pricePerUnit / 10**decimals
        // we want cost = targetPrincipalUsdc, so amount = targetPrincipalUsdc * 10**decimals / pricePerUnit
        const buyAmount = targetPrincipalUsdc.mul(ethers.BigNumber.from(10).pow(tokenDecimals)).div(pricePerUnit);
        const buyTx = await vault.connect(user).buy(buyAmount, { gasPrice, gasLimit: 800000 });
        await buyTx.wait();
        console.log(`[Fund] Successfully bought tokens!`);
    }

    // 2. Transition State to RECOVERY
    config = await lifecycleModule.loanConfigs(asset.token);
    state = config.state;

    if (state === 0) {
        console.log(`\n[Transition] FUNDING -> ACTIVE`);
        const tx = await lifecycleModule.transitionToActive(asset.token, { gasPrice });
        await tx.wait();
        state = 1;
    }
    if (state === 1) {
        console.log(`[Transition] ACTIVE -> DEFAULTED`);
        const tx = await lifecycleModule.transitionToDefaulted(asset.token, { gasPrice });
        await tx.wait();
        state = 3;
    }
    if (state === 3) {
        console.log(`[Transition] DEFAULTED -> RECOVERY`);
        const settlementHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("Legal Settlement Document v1"));
        const tx = await lifecycleModule.transitionToRecovery(asset.token, settlementHash, { gasPrice });
        await tx.wait();
        state = 5;
    }

    if (state !== 5) {
        throw new Error(`State is ${state}, expected 5 (RECOVERY)`);
    }
    console.log(`[State] Asset is now in RECOVERY mode.`);

    // 3. Test Deposit to Treasury
    console.log(`\n[Deposit] Admin depositing recovery funds into Treasury...`);
    const depositUsdcAmount = ethers.utils.parseUnits("5000", 6); // Deposit 5k USDC
    let adminUsdc = await stablecoin.balanceOf(deployer.address);
    if (adminUsdc.lt(depositUsdcAmount)) {
        const tx = await stablecoin.mint(deployer.address, depositUsdcAmount, { gasPrice });
        await tx.wait();
    }
    const depositApproveTx = await stablecoin.approve(treasury.address, depositUsdcAmount, { gasPrice });
    await depositApproveTx.wait();

    const depositTx = await treasury.deposit(depositUsdcAmount, "Post-default legal settlement payment", { gasPrice });
    await depositTx.wait();
    console.log(`[Deposit] Successfully deposited 5000 USDC into AssetTreasury.`);

    // 4. Test Redeem Recovery
    const userTokenBalance = await token.balanceOf(user.address);
    if (userTokenBalance.eq(0)) {
        throw new Error(`User ${user.address} has no tokens to redeem!`);
    }

    // Activate recovery routing on the vault (must be done atomically with transitionToRecovery)
    // This gates redeem() to route through _redeemRecovery() (pro-rata) instead of _redeemStandard() (fixed-price)
    console.log(`\n[RecoveryMode] Enabling recovery mode on vault...`);
    const recoveryModeTx = await vault.connect(deployer).setRecoveryMode(true, { gasPrice });
    await recoveryModeTx.wait();
    console.log(`[RecoveryMode] Recovery mode activated — redeem() now routes to pro-rata payout.`);

    const userUsdcBefore = await stablecoin.balanceOf(user.address);
    console.log(`\n[Redeem] User token balance: ${ethers.utils.formatUnits(userTokenBalance, 18)}`);
    console.log(`[Redeem] User USDC balance before: ${ethers.utils.formatUnits(userUsdcBefore, 6)}`);
    console.log(`[Redeem] Calling vault.redeem() — routes internally to redeemRecovery logic...`);

    const redeemTx = await vault.connect(user).redeem(userTokenBalance, { gasPrice, gasLimit: 800000 });
    await redeemTx.wait();

    const userUsdcAfter = await stablecoin.balanceOf(user.address);
    console.log(`[Redeem] User USDC balance after: ${ethers.utils.formatUnits(userUsdcAfter, 6)}`);
    
    const usdcGained = userUsdcAfter.sub(userUsdcBefore);
    console.log(`[Result] User successfully redeemed tokens and received ${ethers.utils.formatUnits(usdcGained, 6)} USDC!`);
    console.log(`\n=== Deposit and RedeemRecovery flow tested successfully! ===\n`);
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
