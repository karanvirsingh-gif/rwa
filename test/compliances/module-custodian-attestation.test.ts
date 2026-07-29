import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers';
import { ethers, upgrades } from 'hardhat';
import { expect } from 'chai';
import { deployComplianceFixture } from '../fixtures/deploy-compliance.fixture';
import { deploySuiteWithModularCompliancesFixture } from '../fixtures/deploy-full-suite.fixture';

async function deployCustodianAttestationFixture() {
  const context = await loadFixture(deployComplianceFixture);

  const module = await ethers.deployContract('CustodianAttestationModule');
  const proxy = await ethers.deployContract('ModuleProxy', [module.address, module.interface.encodeFunctionData('initialize')]);
  const complianceModule = await ethers.getContractAt('CustodianAttestationModule', proxy.address);

  await context.suite.compliance.addModule(complianceModule.address);

  return {
    ...context,
    suite: {
      ...context.suite,
      complianceModule,
    },
  };
}

async function deployCustodianAttestationFullSuite() {
  const context = await loadFixture(deploySuiteWithModularCompliancesFixture);
  const CustodianAttestationModule = await ethers.getContractFactory('CustodianAttestationModule');
  const complianceModule = await upgrades.deployProxy(CustodianAttestationModule, []);
  
  // Set the token's compliance, which will automatically call compliance.bindToken() securely!
  await context.suite.token.connect(context.accounts.deployer).setCompliance(context.suite.compliance.address);
  
  await context.suite.compliance.addModule(complianceModule.address);

  return {
    ...context,
    suite: {
      ...context.suite,
      complianceModule,
    },
  };
}

describe('Compliance Module: CustodianAttestation', () => {
  it('should deploy the CustodianAttestation contract and bind it to the compliance', async () => {
    const context = await loadFixture(deployCustodianAttestationFixture);

    expect(context.suite.complianceModule.address).not.to.be.undefined;
    expect(await context.suite.compliance.isModuleBound(context.suite.complianceModule.address)).to.be.true;
  });

  describe('Basic Module Standards', () => {
    describe('.name()', () => {
      it('should return the name of the module', async () => {
        const context = await loadFixture(deployCustodianAttestationFixture);
        expect(await context.suite.complianceModule.name()).to.be.equal('CustodianAttestationModule');
      });
    });

    describe('.isPlugAndPlay', () => {
      it('should return true', async () => {
        const context = await loadFixture(deployCustodianAttestationFullSuite);
        expect(await context.suite.complianceModule.isPlugAndPlay()).to.be.true;
      });
    });

    describe('.canComplianceBind', () => {
      it('should return true', async () => {
        const context = await loadFixture(deployCustodianAttestationFullSuite);
        expect(await context.suite.complianceModule.canComplianceBind(context.suite.compliance.address)).to.be.true;
      });
    });
  });

  describe('Upgradeability & Ownership', () => {
    describe('.owner', () => {
      it('should return owner', async () => {
        const context = await loadFixture(deployCustodianAttestationFixture);
        await expect(context.suite.complianceModule.owner()).to.eventually.be.eq(context.accounts.deployer.address);
      });
    });

    describe('.initialize', () => {
      it('should be called only once', async () => {
        const { accounts: { deployer } } = await loadFixture(deployComplianceFixture);
        const module = (await ethers.deployContract('CustodianAttestationModule')).connect(deployer);
        await module.initialize();

        await expect(module.initialize()).to.be.revertedWith('Initializable: contract is already initialized');
        expect(await module.owner()).to.be.eq(deployer.address);
      });
    });

    describe('.transferOwnership', () => {
      describe('when calling directly', () => {
        it('should revert', async () => {
          const context = await loadFixture(deployCustodianAttestationFixture);
          await expect(
            context.suite.complianceModule.connect(context.accounts.aliceWallet).transferOwnership(context.accounts.bobWallet.address)
          ).to.revertedWith('Ownable: caller is not the owner');
        });
      });

      describe('when calling with owner account', () => {
        it('should transfer ownership', async () => {
          const context = await loadFixture(deployCustodianAttestationFixture);
          await context.suite.complianceModule.connect(context.accounts.deployer).transferOwnership(context.accounts.bobWallet.address);
          
          const owner = await context.suite.complianceModule.owner();
          expect(owner).to.eq(context.accounts.bobWallet.address);
        });
      });
    });

    describe('.upgradeTo', () => {
      describe('when calling directly', () => {
        it('should revert', async () => {
          const context = await loadFixture(deployCustodianAttestationFixture);
          await expect(
            context.suite.complianceModule.connect(context.accounts.aliceWallet).upgradeTo(ethers.constants.AddressZero)
          ).to.revertedWith('Ownable: caller is not the owner');
        });
      });

      describe('when calling with owner account', () => {
        it('should upgrade proxy', async () => {
          const context = await loadFixture(deployCustodianAttestationFixture);
          const newImplementation = await ethers.deployContract('CustodianAttestationModule');

          await context.suite.complianceModule.connect(context.accounts.deployer).upgradeTo(newImplementation.address);

          const implementationAddress = await upgrades.erc1967.getImplementationAddress(context.suite.complianceModule.address);
          expect(implementationAddress).to.eq(newImplementation.address);
        });
      });
    });
  });

  describe('Admin Configuration (.setCustodian)', () => {
    describe('when calling directly', () => {
      it('should revert', async () => {
        const context = await loadFixture(deployCustodianAttestationFixture);
        await expect(
          context.suite.complianceModule.setCustodian(context.accounts.bobWallet.address)
        ).to.revertedWith('only bound compliance can call');
      });
    });

    describe('when calling via compliance', () => {
      it('should set custodian successfully', async () => {
        const context = await loadFixture(deployCustodianAttestationFixture);
        const custodianAddress = context.accounts.bobWallet.address;

        const tx = await context.suite.compliance.callModuleFunction(
          new ethers.utils.Interface(['function setCustodian(address)']).encodeFunctionData('setCustodian', [custodianAddress]),
          context.suite.complianceModule.address
        );

        await expect(tx)
          .to.emit(context.suite.complianceModule, 'CustodianSet')
          .withArgs(context.suite.compliance.address, custodianAddress);

        const savedCustodian = await context.suite.complianceModule.custodians(context.suite.compliance.address);
        expect(savedCustodian).to.equal(custodianAddress);
      });
    });
  });

  describe('Custodian Action (.attest)', () => {
    describe('when caller is not the custodian', () => {
      it('should revert', async () => {
        const context = await loadFixture(deployCustodianAttestationFixture);
        
        await expect(
          context.suite.complianceModule.connect(context.accounts.aliceWallet).attest(context.suite.compliance.address, false, "ipfs://proof")
        ).to.be.revertedWith('caller is not the custodian');
      });
    });

    describe('when called by the assigned custodian', () => {
      it('should update attestation and emit event', async () => {
        const context = await loadFixture(deployCustodianAttestationFixture);
        const custodianWallet = context.accounts.bobWallet;

        // Set custodian
        await context.suite.compliance.callModuleFunction(
          new ethers.utils.Interface(['function setCustodian(address)']).encodeFunctionData('setCustodian', [custodianWallet.address]),
          context.suite.complianceModule.address
        );

        // Attest
        const tx = await context.suite.complianceModule.connect(custodianWallet).attest(context.suite.compliance.address, false, "ipfs://proof1");
        
        const timestamp = (await ethers.provider.getBlock(tx.blockNumber!)).timestamp;

        await expect(tx)
          .to.emit(context.suite.complianceModule, 'CustodianAttested')
          .withArgs(context.suite.compliance.address, false, "ipfs://proof1", timestamp);

        const attestation = await context.suite.complianceModule.attestations(context.suite.compliance.address);
        expect(attestation.timestamp).to.equal(timestamp);
        expect(attestation.isDamaged).to.be.false;
        expect(attestation.evidenceRef).to.equal("ipfs://proof1");
      });

      it('should successfully overwrite a previous attestation', async () => {
        const context = await loadFixture(deployCustodianAttestationFixture);
        const custodianWallet = context.accounts.bobWallet;

        await context.suite.compliance.callModuleFunction(
          new ethers.utils.Interface(['function setCustodian(address)']).encodeFunctionData('setCustodian', [custodianWallet.address]),
          context.suite.complianceModule.address
        );

        // First attestation
        await context.suite.complianceModule.connect(custodianWallet).attest(context.suite.compliance.address, false, "ipfs://proof1");
        
        // Fast forward 1 day
        await time.increase(86400);

        // Second attestation
        const tx = await context.suite.complianceModule.connect(custodianWallet).attest(context.suite.compliance.address, true, "ipfs://proof2");
        const timestamp = (await ethers.provider.getBlock(tx.blockNumber!)).timestamp;

        const attestation = await context.suite.complianceModule.attestations(context.suite.compliance.address);
        expect(attestation.timestamp).to.equal(timestamp);
        expect(attestation.isDamaged).to.be.true; // Updated!
        expect(attestation.evidenceRef).to.equal("ipfs://proof2");
      });
    });
  });

  describe('Core Logic (.moduleCheck)', () => {
    const zeroAddress = '0x0000000000000000000000000000000000000000';

    describe('when burning tokens (insurance liquidation)', () => {
      it('should return true regardless of physical condition', async () => {
        const context = await loadFixture(deployCustodianAttestationFullSuite);
        const from = context.accounts.aliceWallet.address;
        const to = zeroAddress; // Burn

        // Even without ANY attestation set, burn must pass
        const result = await context.suite.complianceModule.moduleCheck(from, to, 100, context.suite.compliance.address);
        expect(result).to.be.true;
      });
    });

    describe('when minting tokens', () => {
      it('should return false if not attested', async () => {
        const context = await loadFixture(deployCustodianAttestationFullSuite);
        const from = zeroAddress; // Mint
        const to = context.accounts.aliceWallet.address;

        const result = await context.suite.complianceModule.moduleCheck(from, to, 100, context.suite.compliance.address);
        expect(result).to.be.false;
      });

      it('should return true if successfully attested', async () => {
        const context = await loadFixture(deployCustodianAttestationFullSuite);
        const custodianWallet = context.accounts.bobWallet;

        // Set Custodian & Attest
        await context.suite.compliance.callModuleFunction(
          new ethers.utils.Interface(['function setCustodian(address)']).encodeFunctionData('setCustodian', [custodianWallet.address]),
          context.suite.complianceModule.address
        );
        await context.suite.complianceModule.connect(custodianWallet).attest(context.suite.compliance.address, false, "ipfs://proof1");

        const from = zeroAddress; // Mint
        const to = context.accounts.aliceWallet.address;

        const result = await context.suite.complianceModule.moduleCheck(from, to, 100, context.suite.compliance.address);
        expect(result).to.be.true;
      });
    });

    describe('when transferring tokens', () => {
      it('should return false if never attested', async () => {
        const context = await loadFixture(deployCustodianAttestationFullSuite);
        const from = context.accounts.aliceWallet.address;
        const to = context.accounts.charlieWallet.address;

        const result = await context.suite.complianceModule.moduleCheck(from, to, 100, context.suite.compliance.address);
        expect(result).to.be.false;
      });

      it('should return false if attestation is expired (> 90 days)', async () => {
        const context = await loadFixture(deployCustodianAttestationFullSuite);
        const custodianWallet = context.accounts.bobWallet;

        await context.suite.compliance.callModuleFunction(
          new ethers.utils.Interface(['function setCustodian(address)']).encodeFunctionData('setCustodian', [custodianWallet.address]),
          context.suite.complianceModule.address
        );
        await context.suite.complianceModule.connect(custodianWallet).attest(context.suite.compliance.address, false, "ipfs://proof1");

        // Fast forward 91 days
        await time.increase(91 * 24 * 60 * 60);

        const from = context.accounts.aliceWallet.address;
        const to = context.accounts.charlieWallet.address;

        const result = await context.suite.complianceModule.moduleCheck(from, to, 100, context.suite.compliance.address);
        expect(result).to.be.false;
      });

      it('should return false if the item is marked as damaged', async () => {
        const context = await loadFixture(deployCustodianAttestationFullSuite);
        const custodianWallet = context.accounts.bobWallet;

        await context.suite.compliance.callModuleFunction(
          new ethers.utils.Interface(['function setCustodian(address)']).encodeFunctionData('setCustodian', [custodianWallet.address]),
          context.suite.complianceModule.address
        );
        // Attest as damaged = true
        await context.suite.complianceModule.connect(custodianWallet).attest(context.suite.compliance.address, true, "ipfs://proof1");

        const from = context.accounts.aliceWallet.address;
        const to = context.accounts.charlieWallet.address;

        const result = await context.suite.complianceModule.moduleCheck(from, to, 100, context.suite.compliance.address);
        expect(result).to.be.false;
      });

      it('should return true if actively attested and not damaged', async () => {
        const context = await loadFixture(deployCustodianAttestationFullSuite);
        const custodianWallet = context.accounts.bobWallet;

        await context.suite.compliance.callModuleFunction(
          new ethers.utils.Interface(['function setCustodian(address)']).encodeFunctionData('setCustodian', [custodianWallet.address]),
          context.suite.complianceModule.address
        );
        // Attest perfectly
        await context.suite.complianceModule.connect(custodianWallet).attest(context.suite.compliance.address, false, "ipfs://proof1");

        const from = context.accounts.aliceWallet.address;
        const to = context.accounts.charlieWallet.address;

        const result = await context.suite.complianceModule.moduleCheck(from, to, 100, context.suite.compliance.address);
        expect(result).to.be.true;
      });
    });
  });

  describe('Empty Hooks', () => {
    describe('.moduleTransferAction', () => {
      it('should revert when called directly', async () => {
        const context = await loadFixture(deployCustodianAttestationFullSuite);
        await expect(
          context.suite.complianceModule.moduleTransferAction(context.accounts.anotherWallet.address, context.accounts.anotherWallet.address, 10)
        ).to.be.revertedWith('only bound compliance can call');
      });

      it('should do nothing when called via compliance', async () => {
        const context = await loadFixture(deployCustodianAttestationFullSuite);
        await expect(
          context.suite.compliance.callModuleFunction(
            new ethers.utils.Interface(['function moduleTransferAction(address, address, uint256)']).encodeFunctionData(
              'moduleTransferAction', [context.accounts.anotherWallet.address, context.accounts.anotherWallet.address, 10]
            ),
            context.suite.complianceModule.address
          )
        ).to.eventually.be.fulfilled;
      });
    });

    describe('.moduleMintAction', () => {
      it('should revert when called directly', async () => {
        const context = await loadFixture(deployCustodianAttestationFullSuite);
        await expect(
          context.suite.complianceModule.moduleMintAction(context.accounts.anotherWallet.address, 10)
        ).to.be.revertedWith('only bound compliance can call');
      });

      it('should do nothing when called via compliance', async () => {
        const context = await loadFixture(deployCustodianAttestationFullSuite);
        await expect(
          context.suite.compliance.callModuleFunction(
            new ethers.utils.Interface(['function moduleMintAction(address, uint256)']).encodeFunctionData(
              'moduleMintAction', [context.accounts.anotherWallet.address, 10]
            ),
            context.suite.complianceModule.address
          )
        ).to.eventually.be.fulfilled;
      });
    });

    describe('.moduleBurnAction', () => {
      it('should revert when called directly', async () => {
        const context = await loadFixture(deployCustodianAttestationFullSuite);
        await expect(
          context.suite.complianceModule.moduleBurnAction(context.accounts.anotherWallet.address, 10)
        ).to.be.revertedWith('only bound compliance can call');
      });

      it('should do nothing when called via compliance', async () => {
        const context = await loadFixture(deployCustodianAttestationFullSuite);
        await expect(
          context.suite.compliance.callModuleFunction(
            new ethers.utils.Interface(['function moduleBurnAction(address, uint256)']).encodeFunctionData(
              'moduleBurnAction', [context.accounts.anotherWallet.address, 10]
            ),
            context.suite.complianceModule.address
          )
        ).to.eventually.be.fulfilled;
      });
    });
  });

  describe('Integration Tests (End-to-End)', () => {
    it('should block minting on the actual ERC-20 token before attestation', async () => {
      const context = await loadFixture(deployCustodianAttestationFullSuite);
      
      // Try to mint 100 tokens to Alice BEFORE setting custodian/attesting
      await expect(
        context.suite.token.connect(context.accounts.tokenAgent).mint(context.accounts.aliceWallet.address, 100)
      ).to.be.revertedWith('Compliance not followed');
    });

    it('should allow minting and transferring after a valid attestation', async () => {
      const context = await loadFixture(deployCustodianAttestationFullSuite);
      const custodianWallet = context.accounts.bobWallet;

      // 1. Setup Compliance
      await context.suite.compliance.callModuleFunction(
        new ethers.utils.Interface(['function setCustodian(address)']).encodeFunctionData('setCustodian', [custodianWallet.address]),
        context.suite.complianceModule.address
      );
      await context.suite.complianceModule.connect(custodianWallet).attest(context.suite.compliance.address, false, "ipfs://proof1");

      // 2. Minting should now succeed!
      await expect(
        context.suite.token.connect(context.accounts.tokenAgent).mint(context.accounts.aliceWallet.address, 100)
      ).to.eventually.be.fulfilled;

      // 3. Transferring should succeed (Bob is KYC verified in the fixture)!
      await expect(
        context.suite.token.connect(context.accounts.aliceWallet).transfer(context.accounts.bobWallet.address, 50)
      ).to.eventually.be.fulfilled;

      expect(await context.suite.token.balanceOf(context.accounts.bobWallet.address)).to.equal(550);
    });

    it('should freeze secondary market trading on the ERC-20 token when attestation expires', async () => {
      const context = await loadFixture(deployCustodianAttestationFullSuite);
      const custodianWallet = context.accounts.bobWallet;

      // Setup and Mint
      await context.suite.compliance.callModuleFunction(
        new ethers.utils.Interface(['function setCustodian(address)']).encodeFunctionData('setCustodian', [custodianWallet.address]),
        context.suite.complianceModule.address
      );
      await context.suite.complianceModule.connect(custodianWallet).attest(context.suite.compliance.address, false, "ipfs://proof1");
      await context.suite.token.connect(context.accounts.tokenAgent).mint(context.accounts.aliceWallet.address, 100);

      // Fast forward 91 days
      await time.increase(91 * 24 * 60 * 60);

      // Transfer should now be blocked by the ERC-20 token itself!
      await expect(
        context.suite.token.connect(context.accounts.aliceWallet).transfer(context.accounts.bobWallet.address, 50)
      ).to.be.revertedWith('Transfer not possible');
    });
  });
});
