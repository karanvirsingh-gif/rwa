import { ethers } from 'hardhat';
import * as fs from 'fs';
import * as path from 'path';

/**
 * UPGRADE: AssetFactory — Fix UPGRADER_ROLE handover for AssetTreasury
 * -------------------------------------------------------------------
 * Deploys a new AssetFactory implementation that includes the patch in
 * _handOver() to properly move the UPGRADER_ROLE from the factory to the
 * asset admin. 
 *
 * Then upgrades the existing AssetFactory UUPS proxy.
 *
 * Run: npx hardhat run scripts/upgrade-asset-factory-fix.ts --network polygon
 */

const DELAY_MS = 2000;
const platformPath = path.join(__dirname, '../deployments/asset-platform-amoy.json');

function readJson(p: string): any {
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {};
}

function saveAddress(key: string, value: string) {
  const all = readJson(platformPath);
  all[key] = value;
  fs.writeFileSync(platformPath, JSON.stringify(all, null, 2));
}

async function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getGasPrice() {
  const feeData = await ethers.provider.getFeeData();
  return feeData.gasPrice?.mul(150).div(100) || ethers.utils.parseUnits('35', 'gwei');
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const platform = readJson(platformPath);

  const PROXY_ADDRESS = platform.AssetFactory;
  if (!PROXY_ADDRESS) {
    throw new Error('AssetFactory proxy not found in asset-platform-amoy.json');
  }

  const gasPrice = await getGasPrice();
  console.log('Deployer:             ', deployer.address);
  console.log('Gas price:            ', ethers.utils.formatUnits(gasPrice, 'gwei'), 'gwei');
  console.log('AssetFactory proxy:   ', PROXY_ADDRESS);
  console.log('Old AssetFactoryImpl: ', platform.AssetFactoryImpl);
  console.log('');

  // 1. Archive old impl
  if (platform.AssetFactoryImpl && !platform.AssetFactoryImplV1) {
    saveAddress('AssetFactoryImplV1', platform.AssetFactoryImpl);
    console.log('✓ Archived old factory impl as AssetFactoryImplV1:', platform.AssetFactoryImpl);
  }

  // 2. Deploy new Factory implementation
  console.log('\nStep 1: Deploying new AssetFactory implementation...');
  const Factory = await ethers.getContractFactory('AssetFactory', deployer);
  const newImpl = await Factory.deploy({ gasPrice });
  await newImpl.deployed();
  console.log('  ✓ New impl deployed at:', newImpl.address);
  await delay(DELAY_MS);

  // 3. Upgrade the proxy
  console.log('\nStep 2: Upgrading proxy to new implementation...');
  const proxy = await ethers.getContractAt('AssetFactory', PROXY_ADDRESS, deployer);
  const tx = await proxy.upgradeTo(newImpl.address, { gasPrice });
  const receipt = await tx.wait();
  console.log('  ✓ upgradeTo() tx:', receipt.transactionHash);
  
  // 4. Save
  saveAddress('AssetFactoryImpl', newImpl.address);
  console.log('\n  Saved AssetFactoryImpl ->', newImpl.address);
  console.log('\n✅ AssetFactory upgraded successfully.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
