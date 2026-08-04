import '@xyrusworx/hardhat-solidity-json';
import '@nomicfoundation/hardhat-toolbox';
import { HardhatUserConfig } from 'hardhat/config';
import '@openzeppelin/hardhat-upgrades';
import 'solidity-coverage';
import '@nomiclabs/hardhat-solhint';
import '@primitivefi/hardhat-dodoc';

const config: HardhatUserConfig = {
  solidity: {
    version: '0.8.17',
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
      // AssetFactory.createAsset() orchestrates 6+ sub-deployments and exceeds the
      // legacy codegen's stack-depth limit. viaIR only changes how solc generates
      // bytecode (Yul IR pipeline), not contract behavior - standard for factory-
      // style orchestration contracts.
      viaIR: true,
    },
  },
  gasReporter: {
    enabled: true,
  },
  dodoc: {
    runOnCompile: false,
    debugMode: true,
    outputDir: "./docgen",
    freshOutput: true,
  },
  networks: {
    polygon: {
      url: "https://polygon-amoy-bor-rpc.publicnode.com",
      chainId: 80002,
      accounts: ["ee5546801e07c46c5e4ecb282cae4e3f21389a5e97f4e41490185a5bcba6a1e2", "75de06ff2f872882ad3a4eef81b21fb348453d6b018abc96b865674da5bcfa72"],
      gasPrice: 40000000000, // 20 Gwei (higher base)
      timeout: 60000
    },

  },
};

export default config;
