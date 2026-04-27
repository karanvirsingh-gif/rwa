import { ethers } from 'hardhat';
import OnchainID from '@onchain-id/solidity';
import * as fs from 'fs';
import * as path from 'path';

async function verifyNewUser(userWalletAddress: string, tokenAddress: string) {
    // 1. Setup Accounts
    const [deployer] = await ethers.getSigners();
    const amoyPath = path.join(__dirname, '../deployments/amoy.json');
    const addr = JSON.parse(fs.readFileSync(amoyPath, 'utf8'));

    // Connect to your token's Identity Registry (IR)
    const token = await ethers.getContractAt('Token', tokenAddress);
    const irAddress = await token.identityRegistry();
    const ir = await ethers.getContractAt('IdentityRegistry', irAddress);
    const claimTopic = ethers.utils.keccak256(ethers.utils.toUtf8Bytes('KYC_CLAIM'));

    const gasPrice = ethers.utils.parseUnits('35', 'gwei');

    console.log(`\n👤 Starting Onboarding for User: ${userWalletAddress}`);

    // ==========================================
    // STEP 1: CREATE THE USER'S PASSPORT (ONCHAINID)
    // ==========================================
    console.log(`\n[Step 1] Deploying Identity (ONCHAINID) for User...`);
    const IdentityProxy = await ethers.getContractFactory(
        OnchainID.contracts.IdentityProxy.abi,
        OnchainID.contracts.IdentityProxy.bytecode,
        deployer
    );
    // Deploying the ONCHAINID contract
    const idProxy = await IdentityProxy.deploy(
        addr.IdentityImplementationAuthority,
        deployer.address, // Deployer must be the owner to add claims later!
        { gasPrice, gasLimit: 2000000 }
    );
    await idProxy.deployed();
    const idAddr = idProxy.address;
    console.log(`  ✓ ONCHAINID Created at: ${idAddr}`);

    // Wait slightly to let Polygon RPC nodes sync the new contract before calling addClaim
    console.log(`  ⏳ Waiting 10 seconds for Polygon nodes to sync...`);
    await new Promise((resolve) => setTimeout(resolve, 20000));

    // ==========================================
    // STEP 2: STAMP IT WITH THE KYC CLAIM (CLAIM ISSUER)
    // ==========================================
    console.log(`\n[Step 2] Adding KYC Claim (Simulating Claim Issuer)...`);
    const data = ethers.utils.hexlify(ethers.utils.toUtf8Bytes('Verified'));

    // The Claim Issuer securely signs a hash proving this specific ID is verified
    const hash = ethers.utils.keccak256(
        ethers.utils.defaultAbiCoder.encode(['address', 'uint256', 'bytes'], [idAddr, claimTopic, data])
    );
    const signature = await deployer.signMessage(ethers.utils.arrayify(hash)); // The trusted issuer signs it

    const id = await ethers.getContractAt(OnchainID.contracts.Identity.abi, idAddr);

    // Attaching the signed KYC Claim directly onto the user's new ONCHAINID contract
    const txClaim = await id.addClaim(
        claimTopic,
        1,
        addr.ClaimIssuer,
        signature,
        data,
        '',
        { gasPrice, gasLimit: 800000 }
    );
    await txClaim.wait();
    console.log(`  ✓ KYC Claim Stamp completely added to ONCHAINID!`);


    // ==========================================
    // STEP 3: PLATFORM ADMIN ADDS TO WHITELIST
    // ==========================================
    console.log(`\n[Step 3] Registering User specifically to the Property Token...`);

    // The Admin calls the Identity Registry for the specific token
    const txRegister = await ir.registerIdentity(
        userWalletAddress, // 1. the buyer's wallet
        idAddr,            // 2. the buyer's newly stamped passport
        42,                // 3. the buyer's country code (e.g., 42)
        { gasPrice, gasLimit: 800000 }
    );
    await txRegister.wait();
    console.log(`  ✓ User successfully whitelisted in Token Registry!`);

    // ==========================================
    // FINAL VERIFICATION
    // ==========================================
    const isVerified = await ir.isVerified(userWalletAddress);
    if (isVerified) {
        console.log(`\n✅ SUCCESS! The user can now buy the property tokens.`);
    } else {
        console.error(`\n❌ Verification failed.`);
    }
}

async function main() {
    // We will use the custom Private Key the user provided
    const userPrivateKey = "0x0d56d34ca575713569029c037a85ccaaa3850a648dbb1b81d1a32c2c0e19235b";
    const userWallet = new ethers.Wallet(userPrivateKey, ethers.provider);
    const userWalletAddress = userWallet.address; // Should be 0xec664c575E01FFb0E2cC2089D209129E8FCe17B3

    // The Token Address from your interact-state.json
    const tokenAddress = "0xEA666A01880D529089e146dda6AFD0924aaf24Bf";

    console.log(`🛠️ Starting Identity Registration Script for: ${userWalletAddress}`);
    await verifyNewUser(userWalletAddress, tokenAddress);
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
