import { ethers } from 'hardhat';
import OnchainID from '@onchain-id/solidity';

/**
 * This script demonstrates the full T-REX flow:
 * 1. Create identities for users
 * 2. Register users in Identity Registry (KYC)
 * 3. Issue claims to users
 * 4. Mint tokens to users
 * 5. Transfer tokens between users
 * 
 * Run: npx hardhat run scripts/interact-trex-flow.ts --network localhost
 * 
 * NOTE: Make sure you've run deploy-trex-suite.ts first!
 * You'll need to update the contract addresses below with the ones from deployment.
 */
async function main() {
  // TODO: Update these addresses after running deploy-trex-suite.ts
  const TOKEN_ADDRESS = '0x06D0B63fCFa8c617179874998365938c946956A5'; // Update this
  const IR_ADDRESS = '0x98C7e2e706Df7FEaD0C8589AE20B03D36025B1a1'; // Update this
  const CLAIM_ISSUER_ADDRESS = '0x057ef64E23666F000b34aE31332854aCBd1c8544'; // Update this
  const IDENTITY_IMPLEMENTATION_AUTHORITY = '0x8A791620dd6260079BF849Dc5567aDC3F2FdC318'; // Update this

  // IMPORTANT: Match signer order from deploy-trex-suite.ts
  // [deployer, tokenIssuer, tokenAgent, claimIssuer, aliceWallet, bobWallet]
  const [deployer, tokenIssuer, tokenAgent, claimIssuer, aliceWallet, bobWallet] = await ethers.getSigners();

  console.log('🔄 T-REX Interaction Flow Demo\n');
  console.log('Token Issuer (Owner):', tokenIssuer.address);
  console.log('Token Agent:', tokenAgent.address);
  console.log('');

  // Get contracts
  const token = await ethers.getContractAt('Token', TOKEN_ADDRESS);
  const identityRegistry = await ethers.getContractAt('IdentityRegistry', IR_ADDRESS);
  const claimIssuerContract = await ethers.getContractAt('ClaimIssuer', CLAIM_ISSUER_ADDRESS);

  // Check if tokenAgent is already an agent, if not add it
  console.log('🔍 Checking agent permissions...');
  const AgentRole = await ethers.getContractAt('AgentRole', IR_ADDRESS);
  const isAgent = await AgentRole.isAgent(tokenAgent.address);

  if (!isAgent) {
    console.log('  ⚠️  Token agent not found, adding as agent (using owner)...');
    await identityRegistry.connect(tokenIssuer).addAgent(tokenAgent.address);
    console.log('  ✓ Token agent added to Identity Registry');
  } else {
    console.log('  ✓ Token agent already has permissions');
  }

  // Also ensure tokenAgent is an agent on the Token contract
  const tokenAgentRole = await ethers.getContractAt('AgentRole', TOKEN_ADDRESS);
  const isTokenAgent = await tokenAgentRole.isAgent(tokenAgent.address);

  if (!isTokenAgent) {
    console.log('  ⚠️  Token agent not found on Token, adding as agent...');
    await token.connect(tokenIssuer).addAgent(tokenAgent.address);
    console.log('  ✓ Token agent added to Token contract');
  } else {
    console.log('  ✓ Token agent already has permissions on Token');
  }
  console.log('');

  // Step 1: Create identities for Alice and Bob
  console.log('📝 Step 1: Creating identities...');
  const aliceIdentityProxy = await new ethers.ContractFactory(
    OnchainID.contracts.IdentityProxy.abi,
    OnchainID.contracts.IdentityProxy.bytecode,
    deployer,
  ).deploy(IDENTITY_IMPLEMENTATION_AUTHORITY, aliceWallet.address);
  await aliceIdentityProxy.deployed();

  // Get the Identity contract with the correct ABI
  const aliceIdentity = await ethers.getContractAt(OnchainID.contracts.Identity.abi, aliceIdentityProxy.address);
  console.log('  ✓ Alice Identity:', aliceIdentityProxy.address);

  const bobIdentityProxy = await new ethers.ContractFactory(
    OnchainID.contracts.IdentityProxy.abi,
    OnchainID.contracts.IdentityProxy.bytecode,
    deployer,
  ).deploy(IDENTITY_IMPLEMENTATION_AUTHORITY, bobWallet.address);
  await bobIdentityProxy.deployed();

  // Get the Identity contract with the correct ABI
  const bobIdentity = await ethers.getContractAt(OnchainID.contracts.Identity.abi, bobIdentityProxy.address);
  console.log('  ✓ Bob Identity:', bobIdentityProxy.address);

  // Step 2: Register identities in Identity Registry (KYC)
  console.log('\n📋 Step 2: Registering users in Identity Registry (KYC)...');

  const usersToRegister = [];
  const identitiesToRegister = [];
  const countriesToRegister = [];

  // Check Alice
  if (await identityRegistry.contains(aliceWallet.address)) {
    console.log('  ✓ Alice already registered, updating identity...');
    await identityRegistry.connect(tokenAgent).updateIdentity(aliceWallet.address, aliceIdentityProxy.address);
  } else {
    usersToRegister.push(aliceWallet.address);
    identitiesToRegister.push(aliceIdentityProxy.address);
    countriesToRegister.push(42);
  }

  // Check Bob
  if (await identityRegistry.contains(bobWallet.address)) {
    console.log('  ✓ Bob already registered, updating identity...');
    await identityRegistry.connect(tokenAgent).updateIdentity(bobWallet.address, bobIdentityProxy.address);
  } else {
    usersToRegister.push(bobWallet.address);
    identitiesToRegister.push(bobIdentityProxy.address);
    countriesToRegister.push(42);
  }

  if (usersToRegister.length > 0) {
    await identityRegistry
      .connect(tokenAgent)
      .batchRegisterIdentity(
        usersToRegister,
        identitiesToRegister,
        countriesToRegister,
      );
    console.log(`  ✓ Registered ${usersToRegister.length} new users with country code 42`);
  } else {
    console.log('  ✓ No new users to register');
  }

  // Step 3: Issue KYC claims
  console.log('\n✅ Step 3: Setting up claim issuer signing key...');
  const claimTopic = ethers.utils.keccak256(ethers.utils.toUtf8Bytes('KYC_CLAIM'));

  // Create a signing key for the claim issuer
  const claimIssuerSigningKey = ethers.Wallet.createRandom();
  const signingKeyPublicKey = ethers.utils.keccak256(ethers.utils.defaultAbiCoder.encode(['address'], [claimIssuerSigningKey.address]));

  // Add the signing key to the claim issuer contract (if not already added)
  // Key type 3 = MANAGEMENT_KEY, purpose 1 = CLAIM
  try {
    await claimIssuerContract.connect(claimIssuer).addKey(signingKeyPublicKey, 3, 1);
    console.log('  ✓ Signing key added to Claim Issuer');
  } catch (error: any) {
    if (error.message && error.message.includes('already exists')) {
      console.log('  ✓ Signing key already exists');
    } else {
      throw error;
    }
  }

  console.log('\n✅ Step 4: Issuing KYC claims...');

  // Create claim for Alice
  const aliceClaim = {
    data: ethers.utils.hexlify(ethers.utils.toUtf8Bytes('KYC Verified')),
    issuer: claimIssuerContract.address,
    topic: claimTopic,
    scheme: 1,
    identity: aliceIdentityProxy.address,
    signature: '',
  };
  aliceClaim.signature = await claimIssuerSigningKey.signMessage(
    ethers.utils.arrayify(
      ethers.utils.keccak256(
        ethers.utils.defaultAbiCoder.encode(['address', 'uint256', 'bytes'], [aliceIdentityProxy.address, aliceClaim.topic, aliceClaim.data]),
      ),
    ),
  );
  await aliceIdentity.connect(aliceWallet).addClaim(aliceClaim.topic, aliceClaim.scheme, aliceClaim.issuer, aliceClaim.signature, aliceClaim.data, '');
  console.log('  ✓ KYC claim issued to Alice');

  // Create claim for Bob
  const bobClaim = {
    data: ethers.utils.hexlify(ethers.utils.toUtf8Bytes('KYC Verified')),
    issuer: claimIssuerContract.address,
    topic: claimTopic,
    scheme: 1,
    identity: bobIdentityProxy.address,
    signature: '',
  };
  bobClaim.signature = await claimIssuerSigningKey.signMessage(
    ethers.utils.arrayify(
      ethers.utils.keccak256(
        ethers.utils.defaultAbiCoder.encode(['address', 'uint256', 'bytes'], [bobIdentityProxy.address, bobClaim.topic, bobClaim.data]),
      ),
    ),
  );
  await bobIdentity.connect(bobWallet).addClaim(bobClaim.topic, bobClaim.scheme, bobClaim.issuer, bobClaim.signature, bobClaim.data, '');
  console.log('  ✓ KYC claim issued to Bob');

  // Step 5: Mint tokens
  console.log('\n💰 Step 5: Minting tokens...');
  await token.connect(tokenAgent).mint(aliceWallet.address, ethers.utils.parseEther('1000'));
  await token.connect(tokenAgent).mint(bobWallet.address, ethers.utils.parseEther('500'));
  console.log('  ✓ Minted 1000 tokens to Alice');
  console.log('  ✓ Minted 500 tokens to Bob');

  // Check balances
  const aliceBalance = await token.balanceOf(aliceWallet.address);
  const bobBalance = await token.balanceOf(bobWallet.address);
  console.log(`\n  Alice balance: ${ethers.utils.formatEther(aliceBalance)} tokens`);
  console.log(`  Bob balance: ${ethers.utils.formatEther(bobBalance)} tokens`);

  // Step 6: Transfer tokens (Alice -> Bob)
  console.log('\n🔄 Step 6: Transferring tokens (Alice -> Bob)...');
  await token.connect(aliceWallet).transfer(bobWallet.address, ethers.utils.parseEther('100'));
  console.log('  ✓ Transferred 100 tokens from Alice to Bob');

  // Final balances
  const aliceFinalBalance = await token.balanceOf(aliceWallet.address);
  const bobFinalBalance = await token.balanceOf(bobWallet.address);
  console.log(`\n  Alice final balance: ${ethers.utils.formatEther(aliceFinalBalance)} tokens`);
  console.log(`  Bob final balance: ${ethers.utils.formatEther(bobFinalBalance)} tokens`);

  console.log('\n✅ Full flow completed successfully!');
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
