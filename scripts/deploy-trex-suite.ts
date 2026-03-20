import { ethers } from 'hardhat';
import OnchainID from '@onchain-id/solidity';

/**
 * This script deploys a complete T-REX suite using TREXFactory
 * Run: npx hardhat run scripts/deploy-trex-suite.ts --network localhost
 */
async function main() {
  const [deployer, tokenIssuer, tokenAgent, claimIssuer, aliceWallet, bobWallet] = await ethers.getSigners();

  console.log('🚀 Deploying T-REX Suite...');
  console.log('Deployer:', deployer.address);
  console.log('Token Issuer:', tokenIssuer.address);
  console.log('Token Agent:', tokenAgent.address);
  console.log('Claim Issuer:', claimIssuer.address);
  console.log('Alice:', aliceWallet.address);
  console.log('Bob:', bobWallet.address);
  console.log('');

  // Step 1: Deploy Implementation Contracts
  console.log('📦 Step 1: Deploying implementation contracts...');
  const claimTopicsRegistryImplementation = await ethers.deployContract('ClaimTopicsRegistry', deployer);
  await claimTopicsRegistryImplementation.deployed();
  console.log('  ✓ ClaimTopicsRegistry implementation:', claimTopicsRegistryImplementation.address);

  const trustedIssuersRegistryImplementation = await ethers.deployContract('TrustedIssuersRegistry', deployer);
  await trustedIssuersRegistryImplementation.deployed();
  console.log('  ✓ TrustedIssuersRegistry implementation:', trustedIssuersRegistryImplementation.address);

  const identityRegistryStorageImplementation = await ethers.deployContract('IdentityRegistryStorage', deployer);
  await identityRegistryStorageImplementation.deployed();
  console.log('  ✓ IdentityRegistryStorage implementation:', identityRegistryStorageImplementation.address);

  const identityRegistryImplementation = await ethers.deployContract('IdentityRegistry', deployer);
  await identityRegistryImplementation.deployed();
  console.log('  ✓ IdentityRegistry implementation:', identityRegistryImplementation.address);

  const modularComplianceImplementation = await ethers.deployContract('ModularCompliance', deployer);
  await modularComplianceImplementation.deployed();
  console.log('  ✓ ModularCompliance implementation:', modularComplianceImplementation.address);

  const tokenImplementation = await ethers.deployContract('Token', deployer);
  await tokenImplementation.deployed();
  console.log('  ✓ Token implementation:', tokenImplementation.address);

  // Step 2: Deploy Identity Implementation
  console.log('\n📦 Step 2: Deploying Identity implementation...');
  const identityImplementation = await new ethers.ContractFactory(
    OnchainID.contracts.Identity.abi,
    OnchainID.contracts.Identity.bytecode,
    deployer,
  ).deploy(deployer.address, true);
  await identityImplementation.deployed();
  console.log('  ✓ Identity implementation:', identityImplementation.address);

  // Step 3: Deploy Implementation Authority
  console.log('\n📦 Step 3: Deploying TREXImplementationAuthority...');
  const trexImplementationAuthority = await ethers.deployContract(
    'TREXImplementationAuthority',
    [true, ethers.constants.AddressZero, ethers.constants.AddressZero],
    deployer,
  );
  await trexImplementationAuthority.deployed();
  console.log('  ✓ TREXImplementationAuthority:', trexImplementationAuthority.address);

  // Add version to implementation authority
  const versionStruct = {
    major: 4,
    minor: 0,
    patch: 0,
  };
  const contractsStruct = {
    tokenImplementation: tokenImplementation.address,
    ctrImplementation: claimTopicsRegistryImplementation.address,
    irImplementation: identityRegistryImplementation.address,
    irsImplementation: identityRegistryStorageImplementation.address,
    tirImplementation: trustedIssuersRegistryImplementation.address,
    mcImplementation: modularComplianceImplementation.address,
  };
  await trexImplementationAuthority.connect(deployer).addAndUseTREXVersion(versionStruct, contractsStruct);
  console.log('  ✓ Version added to implementation authority');

  // Step 4: Deploy Identity Factory
  console.log('\n📦 Step 4: Deploying Identity Factory...');
  const identityImplementationAuthority = await new ethers.ContractFactory(
    OnchainID.contracts.ImplementationAuthority.abi,
    OnchainID.contracts.ImplementationAuthority.bytecode,
    deployer,
  ).deploy(identityImplementation.address);
  await identityImplementationAuthority.deployed();
  console.log('  ✓ Identity Implementation Authority:', identityImplementationAuthority.address);

  const identityFactory = await new ethers.ContractFactory(OnchainID.contracts.Factory.abi, OnchainID.contracts.Factory.bytecode, deployer).deploy(
    identityImplementationAuthority.address,
  );
  await identityFactory.deployed();
  console.log('  ✓ Identity Factory:', identityFactory.address);

  // Step 5: Deploy TREXFactory
  console.log('\n📦 Step 5: Deploying TREXFactory...');
  const trexFactory = await ethers.deployContract('TREXFactory', [trexImplementationAuthority.address, identityFactory.address], deployer);
  await trexFactory.deployed();
  console.log('  ✓ TREXFactory:', trexFactory.address);

  // Link identity factory to TREX factory
  await identityFactory.connect(deployer).addTokenFactory(trexFactory.address);
  console.log('  ✓ Identity Factory linked to TREXFactory');

  // Step 6: Deploy Compliance Module (optional - for country restrictions)
  console.log('\n📦 Step 6: Deploying compliance modules...');
  const countryAllowModule = await ethers.deployContract('CountryAllowModule', deployer);
  await countryAllowModule.deployed();
  console.log('  ✓ CountryAllowModule:', countryAllowModule.address);

  // Step 7: Deploy Claim Issuer
  console.log('\n📦 Step 7: Deploying Claim Issuer...');
  const claimIssuerContract = await ethers.deployContract('ClaimIssuer', [claimIssuer.address], claimIssuer);
  await claimIssuerContract.deployed();
  console.log('  ✓ ClaimIssuer:', claimIssuerContract.address);

  // Add signing key to claim issuer
  const claimIssuerSigningKey = ethers.Wallet.createRandom();
  await claimIssuerContract
    .connect(claimIssuer)
    .addKey(ethers.utils.keccak256(ethers.utils.defaultAbiCoder.encode(['address'], [claimIssuerSigningKey.address])), 3, 1);
  console.log('  ✓ Signing key added to Claim Issuer');

  // Step 8: Deploy a T-REX Suite using the factory
  console.log('\n📦 Step 8: Deploying T-REX Suite via Factory...');
  const salt = 'real-estate-token-001';
  const claimTopic = ethers.utils.keccak256(ethers.utils.toUtf8Bytes('KYC_CLAIM'));

  const tokenDetails = {
    owner: tokenIssuer.address,
    name: 'Real Estate Property Token',
    symbol: 'REPT',
    decimals: 18,
    irs: ethers.constants.AddressZero, // Deploy new IRS
    ONCHAINID: ethers.constants.AddressZero, // Factory will create one
    irAgents: [tokenAgent.address], // Agent who can register identities
    tokenAgents: [tokenAgent.address], // Agent who can mint tokens
    complianceModules: [countryAllowModule.address],
    complianceSettings: [
      new ethers.utils.Interface(['function batchAllowCountries(uint16[] calldata countries)']).encodeFunctionData('batchAllowCountries', [
        [1, 42, 66], // Allow US (1), France (42), Switzerland (66)
      ]),
    ],
  };

  const claimDetails = {
    claimTopics: [claimTopic],
    issuers: [claimIssuerContract.address],
    issuerClaims: [[claimTopic]], // This issuer can issue this claim topic
  };

  const deployTx = await trexFactory.connect(deployer).deployTREXSuite(salt, tokenDetails, claimDetails);
  const receipt = await deployTx.wait();

  // Extract token address from event
  const suiteDeployedEvent = receipt.events?.find((e: any) => e.event === 'TREXSuiteDeployed');
  const tokenAddress = suiteDeployedEvent?.args?.[0];
  const irAddress = suiteDeployedEvent?.args?.[1];
  const irsAddress = suiteDeployedEvent?.args?.[2];
  const tirAddress = suiteDeployedEvent?.args?.[3];
  const ctrAddress = suiteDeployedEvent?.args?.[4];
  const mcAddress = suiteDeployedEvent?.args?.[5];

  console.log('  ✓ T-REX Suite deployed!');
  console.log('    Token:', tokenAddress);
  console.log('    Identity Registry:', irAddress);
  console.log('    Identity Registry Storage:', irsAddress);
  console.log('    Trusted Issuers Registry:', tirAddress);
  console.log('    Claim Topics Registry:', ctrAddress);
  console.log('    Modular Compliance:', mcAddress);

  // Get token contract
  const token = await ethers.getContractAt('Token', tokenAddress);

  // Step 9: Unpause token (tokens start paused)
  console.log('\n📦 Step 9: Unpausing token...');
  await token.connect(tokenAgent).unpause();
  console.log('  ✓ Token unpaused and ready for transfers');

  // Summary
  console.log('\n✅ Deployment Complete!');
  console.log('\n📋 Summary:');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━Identity Registry:', irAddress);
  console.log('  Identity Registry:', irAddress);
  console.log('  Identity Registry Storage:', irsAddress);
  console.log('  Trusted Issuers Registry:', tirAddress);
  console.log('  Claim Topics Registry:', ctrAddress);
  console.log('  Modular Compliance:', mcAddress);
  console.log('  Country Allow Module:', countryAllowModule.address);
  console.log('  Claim Issuer:', claimIssuerContract.address);
  console.log('\n💡 Next steps:');
  console.log('  1. Save the contract addresses above');
  console.log('  2. Update interact-trex-flow.ts with these addresses');
  console.log('  3. Run: npx hardhat run scripts/interact-trex-flow.ts --network localhost');
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
