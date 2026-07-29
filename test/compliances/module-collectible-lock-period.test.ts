import { expect } from 'chai';
import { ethers, upgrades } from 'hardhat';
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers';
import { deploySuiteWithModularCompliancesFixture } from '../fixtures/deploy-full-suite.fixture';

async function deployLockPeriodFixture() {
  const context = await loadFixture(deploySuiteWithModularCompliancesFixture);
  const CollectibleLockPeriodModule = await ethers.getContractFactory('CollectibleLockPeriodModule');
  const complianceModule = await upgrades.deployProxy(CollectibleLockPeriodModule, []);
  
  return { ...context, suite: { ...context.suite, complianceModule } };
}

async function deployLockPeriodFullSuite() {
  const context = await loadFixture(deploySuiteWithModularCompliancesFixture);
  const CollectibleLockPeriodModule = await ethers.getContractFactory('CollectibleLockPeriodModule');
  const complianceModule = await upgrades.deployProxy(CollectibleLockPeriodModule, []);
  
  // Connect the token to the compliance engine so it actually enforces rules
  await context.suite.token.connect(context.accounts.deployer).setCompliance(context.suite.compliance.address);
  await context.suite.compliance.addModule(complianceModule.address);

  // Clear the massive balances given by the base fixture so we start fresh!
  await context.suite.token.connect(context.accounts.tokenAgent).burn(context.accounts.aliceWallet.address, 1000);
  await context.suite.token.connect(context.accounts.tokenAgent).burn(context.accounts.bobWallet.address, 500);

  return { ...context, suite: { ...context.suite, complianceModule } };
}

describe('Compliance Module: CollectibleLockPeriod', () => {
  it('should deploy the CollectibleLockPeriod contract and bind it to the compliance', async () => {
    const context = await loadFixture(deployLockPeriodFullSuite);
    expect(await context.suite.compliance.isModuleBound(context.suite.complianceModule.address)).to.be.true;
  });

  describe('Basic Module Standards', () => {
    it('.name() should return the name of the module', async () => {
      const context = await loadFixture(deployLockPeriodFixture);
      expect(await context.suite.complianceModule.name()).to.equal('CollectibleLockPeriodModule');
    });

    it('.isPlugAndPlay should return true', async () => {
      const context = await loadFixture(deployLockPeriodFixture);
      expect(await context.suite.complianceModule.isPlugAndPlay()).to.be.true;
    });

    it('.canComplianceBind should return true', async () => {
      const context = await loadFixture(deployLockPeriodFixture);
      expect(await context.suite.complianceModule.canComplianceBind(ethers.constants.AddressZero)).to.be.true;
    });
  });

  describe('Upgradeability & Ownership', () => {
    it('.owner should return deployer', async () => {
      const context = await loadFixture(deployLockPeriodFixture);
      expect(await context.suite.complianceModule.owner()).to.equal(context.accounts.deployer.address);
    });

    it('.initialize should be called only once', async () => {
      const context = await loadFixture(deployLockPeriodFixture);
      await expect(context.suite.complianceModule.initialize()).to.be.revertedWith('Initializable: contract is already initialized');
    });

    describe('.transferOwnership', () => {
      it('should revert when calling directly as non-owner', async () => {
        const context = await loadFixture(deployLockPeriodFixture);
        await expect(
          context.suite.complianceModule.connect(context.accounts.aliceWallet).transferOwnership(context.accounts.aliceWallet.address)
        ).to.be.revertedWith('Ownable: caller is not the owner');
      });

      it('should transfer ownership when calling with owner account', async () => {
        const context = await loadFixture(deployLockPeriodFixture);
        await expect(
          context.suite.complianceModule.connect(context.accounts.deployer).transferOwnership(context.accounts.aliceWallet.address)
        ).to.eventually.be.fulfilled;
        expect(await context.suite.complianceModule.owner()).to.equal(context.accounts.aliceWallet.address);
      });
    });
  });

  describe('Admin Configuration (.setLockDuration)', () => {
    it('should revert when called directly by a wallet (even owner)', async () => {
      const context = await loadFixture(deployLockPeriodFullSuite);
      await expect(
        context.suite.complianceModule.connect(context.accounts.deployer).setLockDuration(30 * 24 * 60 * 60)
      ).to.be.revertedWith('only bound compliance can call');
    });

    it('should set lock duration successfully when called via compliance and emit event', async () => {
      const context = await loadFixture(deployLockPeriodFullSuite);
      
      const duration = 30 * 24 * 60 * 60; // 30 days
      const callData = new ethers.utils.Interface(['function setLockDuration(uint256)']).encodeFunctionData('setLockDuration', [duration]);

      await expect(
        context.suite.compliance.callModuleFunction(callData, context.suite.complianceModule.address)
      ).to.emit(context.suite.complianceModule, 'LockDurationSet').withArgs(context.suite.compliance.address, duration);

      expect(await context.suite.complianceModule.lockDurations(context.suite.compliance.address)).to.equal(duration);
    });
  });

  describe('Empty / Passive Hooks', () => {
    describe('.moduleTransferAction', () => {
      it('should revert when called directly', async () => {
        const context = await loadFixture(deployLockPeriodFullSuite);
        await expect(
          context.suite.complianceModule.moduleTransferAction(context.accounts.aliceWallet.address, context.accounts.bobWallet.address, 10)
        ).to.be.revertedWith('only bound compliance can call');
      });

      it('should do nothing when called via compliance', async () => {
        const context = await loadFixture(deployLockPeriodFullSuite);
        const callData = new ethers.utils.Interface(['function moduleTransferAction(address,address,uint256)']).encodeFunctionData(
          'moduleTransferAction', [context.accounts.aliceWallet.address, context.accounts.bobWallet.address, 10]
        );
        await expect(
          context.suite.compliance.callModuleFunction(callData, context.suite.complianceModule.address)
        ).to.eventually.be.fulfilled;
      });
    });

    describe('.moduleBurnAction', () => {
      it('should revert when called directly', async () => {
        const context = await loadFixture(deployLockPeriodFullSuite);
        await expect(
          context.suite.complianceModule.moduleBurnAction(context.accounts.aliceWallet.address, 10)
        ).to.be.revertedWith('only bound compliance can call');
      });

      it('should do nothing when called via compliance', async () => {
        const context = await loadFixture(deployLockPeriodFullSuite);
        const callData = new ethers.utils.Interface(['function moduleBurnAction(address,uint256)']).encodeFunctionData(
          'moduleBurnAction', [context.accounts.aliceWallet.address, 10]
        );
        await expect(
          context.suite.compliance.callModuleFunction(callData, context.suite.complianceModule.address)
        ).to.eventually.be.fulfilled;
      });
    });
  });

  describe('Active Hook (.moduleMintAction)', () => {
    it('should revert when called directly', async () => {
      const context = await loadFixture(deployLockPeriodFullSuite);
      await expect(
        context.suite.complianceModule.moduleMintAction(context.accounts.aliceWallet.address, 10)
      ).to.be.revertedWith('only bound compliance can call');
    });

    it('should NOT apply a lock if duration is 0', async () => {
      const context = await loadFixture(deployLockPeriodFullSuite);
      
      const callData = new ethers.utils.Interface(['function moduleMintAction(address,uint256)']).encodeFunctionData(
        'moduleMintAction', [context.accounts.aliceWallet.address, 100]
      );
      
      await expect(
        context.suite.compliance.callModuleFunction(callData, context.suite.complianceModule.address)
      ).to.not.emit(context.suite.complianceModule, 'LockApplied');
    });

    it('should successfully apply a lock if duration > 0 and emit event', async () => {
      const context = await loadFixture(deployLockPeriodFullSuite);
      const duration = 30 * 24 * 60 * 60; // 30 days
      
      // Set Duration
      await context.suite.compliance.callModuleFunction(
        new ethers.utils.Interface(['function setLockDuration(uint256)']).encodeFunctionData('setLockDuration', [duration]),
        context.suite.complianceModule.address
      );

      const callData = new ethers.utils.Interface(['function moduleMintAction(address,uint256)']).encodeFunctionData(
        'moduleMintAction', [context.accounts.aliceWallet.address, 100]
      );
      
      await expect(
        context.suite.compliance.callModuleFunction(callData, context.suite.complianceModule.address)
      ).to.emit(context.suite.complianceModule, 'LockApplied');
      
      // Check that the lock was saved in state
      const lockData = await context.suite.complianceModule.userLocks(context.suite.compliance.address, context.accounts.aliceWallet.address, 0);
      expect(lockData.amount).to.equal(100);
      expect(lockData.expiresAt.toNumber()).to.be.greaterThan(0);
    });
  });

  describe('Core Logic State Machine (.moduleCheck)', () => {
    it('Mints: should return true immediately if _from == address(0)', async () => {
      const context = await loadFixture(deployLockPeriodFullSuite);
      const result = await context.suite.complianceModule.moduleCheck(ethers.constants.AddressZero, context.accounts.aliceWallet.address, 100, context.suite.compliance.address);
      expect(result).to.be.true;
    });

    it('No Locks: should return true if the sender has no locks', async () => {
      const context = await loadFixture(deployLockPeriodFullSuite);
      const result = await context.suite.complianceModule.moduleCheck(context.accounts.aliceWallet.address, context.accounts.bobWallet.address, 10, context.suite.compliance.address);
      expect(result).to.be.true;
    });

    it('Zero-Value Transfer: should return true even if 100% locked', async () => {
      const context = await loadFixture(deployLockPeriodFullSuite);
      // Mint 100 locked tokens
      await context.suite.compliance.callModuleFunction(
        new ethers.utils.Interface(['function setLockDuration(uint256)']).encodeFunctionData('setLockDuration', [30 * 24 * 60 * 60]),
        context.suite.complianceModule.address
      );
      await context.suite.token.connect(context.accounts.tokenAgent).mint(context.accounts.aliceWallet.address, 100);

      // Attempt 0-value transfer
      const result = await context.suite.complianceModule.moduleCheck(context.accounts.aliceWallet.address, context.accounts.bobWallet.address, 0, context.suite.compliance.address);
      expect(result).to.be.true;
    });

    it('Full Lock: should return false if trying to transfer any amount > 0', async () => {
      const context = await loadFixture(deployLockPeriodFullSuite);
      await context.suite.compliance.callModuleFunction(
        new ethers.utils.Interface(['function setLockDuration(uint256)']).encodeFunctionData('setLockDuration', [30 * 24 * 60 * 60]),
        context.suite.complianceModule.address
      );
      await context.suite.token.connect(context.accounts.tokenAgent).mint(context.accounts.aliceWallet.address, 100);

      const result = await context.suite.complianceModule.moduleCheck(context.accounts.aliceWallet.address, context.accounts.bobWallet.address, 1, context.suite.compliance.address);
      expect(result).to.be.false;
    });

    it('Partial Lock Success/Fail: checks free balance vs locked balance', async () => {
      const context = await loadFixture(deployLockPeriodFullSuite);
      await context.suite.compliance.callModuleFunction(
        new ethers.utils.Interface(['function setLockDuration(uint256)']).encodeFunctionData('setLockDuration', [30 * 24 * 60 * 60]),
        context.suite.complianceModule.address
      );
      
      // Alice gets 100 locked tokens
      await context.suite.token.connect(context.accounts.tokenAgent).mint(context.accounts.aliceWallet.address, 100);
      
      // Admin turns off lock configuration temporarily to give Alice 50 FREE tokens
      await context.suite.compliance.callModuleFunction(
        new ethers.utils.Interface(['function setLockDuration(uint256)']).encodeFunctionData('setLockDuration', [0]),
        context.suite.complianceModule.address
      );
      await context.suite.token.connect(context.accounts.tokenAgent).mint(context.accounts.aliceWallet.address, 50);

      // Alice now has 150 tokens. 100 locked, 50 free.
      
      // Trying to transfer 50 should succeed
      const result1 = await context.suite.complianceModule.moduleCheck(context.accounts.aliceWallet.address, context.accounts.bobWallet.address, 50, context.suite.compliance.address);
      expect(result1).to.be.true;

      // Trying to transfer 51 should fail
      const result2 = await context.suite.complianceModule.moduleCheck(context.accounts.aliceWallet.address, context.accounts.bobWallet.address, 51, context.suite.compliance.address);
      expect(result2).to.be.false;
    });

    it('Time Expiry: should return true after time lock ends', async () => {
      const context = await loadFixture(deployLockPeriodFullSuite);
      await context.suite.compliance.callModuleFunction(
        new ethers.utils.Interface(['function setLockDuration(uint256)']).encodeFunctionData('setLockDuration', [30 * 24 * 60 * 60]),
        context.suite.complianceModule.address
      );
      await context.suite.token.connect(context.accounts.tokenAgent).mint(context.accounts.aliceWallet.address, 100);

      // Fast forward 31 days
      await time.increase(31 * 24 * 60 * 60);

      // Transfer 100 should now succeed
      const result = await context.suite.complianceModule.moduleCheck(context.accounts.aliceWallet.address, context.accounts.bobWallet.address, 100, context.suite.compliance.address);
      expect(result).to.be.true;
    });

    it('The Burn Edge Case: safely handles when an admin burns locked tokens', async () => {
      const context = await loadFixture(deployLockPeriodFullSuite);
      await context.suite.compliance.callModuleFunction(
        new ethers.utils.Interface(['function setLockDuration(uint256)']).encodeFunctionData('setLockDuration', [30 * 24 * 60 * 60]),
        context.suite.complianceModule.address
      );
      await context.suite.token.connect(context.accounts.tokenAgent).mint(context.accounts.aliceWallet.address, 100);

      // Admin maliciously (or legally) burns 50 of Alice's locked tokens!
      await context.suite.token.connect(context.accounts.tokenAgent).burn(context.accounts.aliceWallet.address, 50);

      // Alice's balance is now 50. But her lock is still 100.
      // She should NOT be able to transfer anything!
      const result = await context.suite.complianceModule.moduleCheck(context.accounts.aliceWallet.address, context.accounts.bobWallet.address, 1, context.suite.compliance.address);
      expect(result).to.be.false;
    });
  });

  describe('Integration Tests (End-to-End)', () => {
    it('1. Primary Market Enforcement (The 30-Day Lock)', async () => {
      const context = await loadFixture(deployLockPeriodFullSuite);
      await context.suite.compliance.callModuleFunction(
        new ethers.utils.Interface(['function setLockDuration(uint256)']).encodeFunctionData('setLockDuration', [30 * 24 * 60 * 60]),
        context.suite.complianceModule.address
      );
      
      // Mint 100 to Alice
      await context.suite.token.connect(context.accounts.tokenAgent).mint(context.accounts.aliceWallet.address, 100);

      // Alice attempts to transfer to Bob (verified)
      await expect(
        context.suite.token.connect(context.accounts.aliceWallet).transfer(context.accounts.bobWallet.address, 50)
      ).to.be.revertedWith('Transfer not possible');
    });

    it('2. Primary Market Lock Expiry', async () => {
      const context = await loadFixture(deployLockPeriodFullSuite);
      await context.suite.compliance.callModuleFunction(
        new ethers.utils.Interface(['function setLockDuration(uint256)']).encodeFunctionData('setLockDuration', [30 * 24 * 60 * 60]),
        context.suite.complianceModule.address
      );
      await context.suite.token.connect(context.accounts.tokenAgent).mint(context.accounts.aliceWallet.address, 100);

      // Fast forward 31 days
      await time.increase(31 * 24 * 60 * 60);

      await expect(
        context.suite.token.connect(context.accounts.aliceWallet).transfer(context.accounts.bobWallet.address, 50)
      ).to.eventually.be.fulfilled;
    });

    it('3. Secondary Market Freedom (No Lock Propagation)', async () => {
      const context = await loadFixture(deployLockPeriodFullSuite);
      await context.suite.compliance.callModuleFunction(
        new ethers.utils.Interface(['function setLockDuration(uint256)']).encodeFunctionData('setLockDuration', [30 * 24 * 60 * 60]),
        context.suite.complianceModule.address
      );
      
      // Mint to Alice, wait 31 days, sell to Bob
      await context.suite.token.connect(context.accounts.tokenAgent).mint(context.accounts.aliceWallet.address, 100);
      await time.increase(31 * 24 * 60 * 60);
      await context.suite.token.connect(context.accounts.aliceWallet).transfer(context.accounts.bobWallet.address, 50);

      // Bob tries to sell to Alice (who is also verified)
      // Bob should not be locked!
      await expect(
        context.suite.token.connect(context.accounts.bobWallet).transfer(context.accounts.aliceWallet.address, 25)
      ).to.eventually.be.fulfilled;
    });

    it('4. Dynamic Duration Changes (State Safety)', async () => {
      const context = await loadFixture(deployLockPeriodFullSuite);
      
      // Set to 30 days and mint to Alice
      await context.suite.compliance.callModuleFunction(
        new ethers.utils.Interface(['function setLockDuration(uint256)']).encodeFunctionData('setLockDuration', [30 * 24 * 60 * 60]),
        context.suite.complianceModule.address
      );
      await context.suite.token.connect(context.accounts.tokenAgent).mint(context.accounts.aliceWallet.address, 100);

      // Set to 0 days (e.g. platform wants to remove locks going forward)
      await context.suite.compliance.callModuleFunction(
        new ethers.utils.Interface(['function setLockDuration(uint256)']).encodeFunctionData('setLockDuration', [0]),
        context.suite.complianceModule.address
      );

      // Mint another 50 to Alice (these should be free)
      await context.suite.token.connect(context.accounts.tokenAgent).mint(context.accounts.aliceWallet.address, 50);

      // Alice tries to transfer 50 -> should succeed (using the free ones)
      await expect(
        context.suite.token.connect(context.accounts.aliceWallet).transfer(context.accounts.bobWallet.address, 50)
      ).to.eventually.be.fulfilled;

      // Alice tries to transfer 51 -> should fail! Her first 100 are still locked!
      await expect(
        context.suite.token.connect(context.accounts.aliceWallet).transfer(context.accounts.bobWallet.address, 51)
      ).to.be.revertedWith('Transfer not possible');
    });
  });
});
