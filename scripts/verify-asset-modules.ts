import { ethers } from 'hardhat';

/**
 * Universal script to verify an asset's on-chain data and its modular compliance.
 * 
 * Usage:
 * Run: TOKEN_ADDRESS=0xYourTokenAddress npx hardhat run scripts/verify-asset-modules.ts --network polygon
 * Or just replace the TOKEN_ADDRESS variable below.
 */

// =========================================================================
// CONFIGURATION
// =========================================================================
const TOKEN_ADDRESS = process.env.TOKEN_ADDRESS || '0x79627F79E4709F8AD6fdE7eD1287d29aeaA60Fb5';
const MODULES_TO_VERIFY = [
  // You can optionally add specific module addresses you want to check if they are bound.
  // e.g., '0xModuleAddress1', '0xModuleAddress2'
  '0x8f476bb91026Fb66a0B71656089c85984CA18B8A',
  '0x5F09226829f2358CdF02D4611Fd09b75Df3bFa00'
];

async function main() {
  if (!TOKEN_ADDRESS) {
    throw new Error('Please provide a TOKEN_ADDRESS in the script or via environment variable.');
  }

  console.log(`\n======================================================`);
  console.log(`🔍 Verifying Asset at: ${TOKEN_ADDRESS}`);
  console.log(`======================================================\n`);

  // 1. Fetch Asset Details
  console.log('1️⃣  Fetching Token Details...');
  const token = await ethers.getContractAt('Token', TOKEN_ADDRESS);

  let name, symbol, decimals, totalSupply, complianceAddress;
  try {
    name = await token.name();
    symbol = await token.symbol();
    decimals = await token.decimals();
    totalSupply = await token.totalSupply();
    complianceAddress = await token.compliance();

    console.log(`   - Name:         ${name}`);
    console.log(`   - Symbol:       ${symbol}`);
    console.log(`   - Decimals:     ${decimals}`);
    console.log(`   - Total Supply: ${ethers.utils.formatUnits(totalSupply, decimals)}`);
    console.log(`   - Compliance:   ${complianceAddress}`);
  } catch (error: any) {
    console.error('❌ Failed to fetch token details. Is this a valid T-REX Token?');
    throw error;
  }

  // 2. Fetch Modular Compliance Details
  console.log('\n2️⃣  Fetching Modular Compliance Details...');
  if (complianceAddress === ethers.constants.AddressZero) {
    console.error('❌ Compliance address is zero. Asset is improperly configured.');
    return;
  }

  const compliance = await ethers.getContractAt('ModularCompliance', complianceAddress);

  let boundModules: string[] = [];
  try {
    boundModules = await compliance.getModules();
    console.log(`   - Total Bound Modules: ${boundModules.length}`);
    if (boundModules.length > 0) {
      console.log(`   - Modules List:`);
      for (const mod of boundModules) {
        console.log(`       * ${mod}`);
      }
    }
  } catch (error: any) {
    console.error('❌ Failed to fetch bound modules. Is the compliance address correct?');
    throw error;
  }

  // 3. Verify Specific Modules
  console.log('\n3️⃣  Verifying Specific Modules...');
  if (MODULES_TO_VERIFY.length === 0) {
    console.log('   - No specific modules provided to verify.');
  } else {
    for (const mod of MODULES_TO_VERIFY) {
      try {
        const isBound = await compliance.isModuleBound(mod);
        console.log(`   - Module ${mod}: ${isBound ? '✅ BOUND' : '❌ NOT BOUND'}`);
      } catch (error: any) {
        console.error(`   - Module ${mod}: ⚠️ ERROR checking bound status`);
      }
    }
  }

  // 4. Verify Identity Registry setup
  console.log('\n4️⃣  Checking Identity Registry...');
  try {
    const irAddress = await token.identityRegistry();
    console.log(`   - Identity Registry: ${irAddress}`);
    if (irAddress === ethers.constants.AddressZero) {
      console.warn('   ⚠️ Identity Registry is zero address!');
    }
  } catch (error: any) {
    console.error('   ❌ Failed to fetch Identity Registry.');
  }

  console.log(`\n✅ Verification Complete!\n`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
