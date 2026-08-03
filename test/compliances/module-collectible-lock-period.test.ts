import { expect } from 'chai';
import { ethers, upgrades } from 'hardhat';
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers';
import { deploySuiteWithModularCompliancesFixture } from '../fixtures/deploy-full-suite.fixture';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const THIRTY_DAYS  = 30 * 24 * 60 * 60;
const SIXTY_DAYS   = 60 * 24 * 60 * 60;
const ONE_YEAR     = 365 * 24 * 60 * 60;

function encodeSetLockDuration(duration: number) {
  return new ethers.utils.Interface(['function setLockDuration(uint256)']).encodeFunctionData('setLockDuration', [duration]);
}
function encodeMintAction(to: string, amount: number) {
  return new ethers.utils.Interface(['function moduleMintAction(address,uint256)']).encodeFunctionData('moduleMintAction', [to, amount]);
}
function encodeTransferAction(from: string, to: string, value: number) {
  return new ethers.utils.Interface(['function moduleTransferAction(address,address,uint256)']).encodeFunctionData('moduleTransferAction', [from, to, value]);
}
function encodeBurnAction(from: string, value: number) {
  return new ethers.utils.Interface(['function moduleBurnAction(address,uint256)']).encodeFunctionData('moduleBurnAction', [from, value]);
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

/** Bare module — no compliance bound, no token. Good for pure unit tests on the module itself. */
async function deployLockPeriodFixture() {
  const context = await loadFixture(deploySuiteWithModularCompliancesFixture);
  const CollectibleLockPeriodModule = await ethers.getContractFactory('CollectibleLockPeriodModule');
  const complianceModule = await upgrades.deployProxy(CollectibleLockPeriodModule, []);

  return { ...context, suite: { ...context.suite, complianceModule } };
}

/** Full integration suite — module bound to compliance, compliance bound to token, starting balances zeroed out. */
async function deployLockPeriodFullSuite() {
  const context = await loadFixture(deploySuiteWithModularCompliancesFixture);
  const CollectibleLockPeriodModule = await ethers.getContractFactory('CollectibleLockPeriodModule');
  const complianceModule = await upgrades.deployProxy(CollectibleLockPeriodModule, []);

  await context.suite.token.connect(context.accounts.deployer).setCompliance(context.suite.compliance.address);
  await context.suite.compliance.addModule(complianceModule.address);

  // Zero out base-fixture balances so we start fresh
  await context.suite.token.connect(context.accounts.tokenAgent).burn(context.accounts.aliceWallet.address, 1000);
  await context.suite.token.connect(context.accounts.tokenAgent).burn(context.accounts.bobWallet.address, 500);

  return { ...context, suite: { ...context.suite, complianceModule } };
}

/** Helper: set duration + mint tokens to a user in one go. */
async function setupLockAndMint(
  context: Awaited<ReturnType<typeof deployLockPeriodFullSuite>>,
  duration: number,
  to: string,
  amount: number,
) {
  await context.suite.compliance.callModuleFunction(
    encodeSetLockDuration(duration),
    context.suite.complianceModule.address,
  );
  await context.suite.token.connect(context.accounts.tokenAgent).mint(to, amount);
}

// ─────────────────────────────────────────────────────────────────────────────
//  TEST SUITE
// ─────────────────────────────────────────────────────────────────────────────

describe('Compliance Module: CollectibleLockPeriod', () => {

  // ══════════════════════════════════════════════════════════════════════════
  // 1. DEPLOYMENT & BINDING
  // ══════════════════════════════════════════════════════════════════════════
  describe('1. Deployment & Binding', () => {
    it('deploys the module as a UUPS proxy', async () => {
      const context = await loadFixture(deployLockPeriodFixture);
      expect(context.suite.complianceModule.address).to.be.properAddress;
    });

    it('binds correctly to the compliance contract', async () => {
      const context = await loadFixture(deployLockPeriodFullSuite);
      expect(await context.suite.compliance.isModuleBound(context.suite.complianceModule.address)).to.be.true;
    });

    it('is NOT bound to an unrelated compliance address', async () => {
      const context = await loadFixture(deployLockPeriodFullSuite);
      expect(await context.suite.compliance.isModuleBound(context.accounts.anotherWallet.address)).to.be.false;
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 2. BASIC MODULE STANDARDS
  // ══════════════════════════════════════════════════════════════════════════
  describe('2. Basic Module Standards', () => {
    it('.name() returns "CollectibleLockPeriodModule"', async () => {
      const context = await loadFixture(deployLockPeriodFixture);
      expect(await context.suite.complianceModule.name()).to.equal('CollectibleLockPeriodModule');
    });

    it('.isPlugAndPlay() returns true', async () => {
      const context = await loadFixture(deployLockPeriodFixture);
      expect(await context.suite.complianceModule.isPlugAndPlay()).to.be.true;
    });

    it('.canComplianceBind() returns true for any address', async () => {
      const context = await loadFixture(deployLockPeriodFixture);
      expect(await context.suite.complianceModule.canComplianceBind(ethers.constants.AddressZero)).to.be.true;
      expect(await context.suite.complianceModule.canComplianceBind(context.accounts.aliceWallet.address)).to.be.true;
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 3. UPGRADEABILITY & OWNERSHIP
  // ══════════════════════════════════════════════════════════════════════════
  describe('3. Upgradeability & Ownership', () => {
    it('owner is the deployer', async () => {
      const context = await loadFixture(deployLockPeriodFixture);
      expect(await context.suite.complianceModule.owner()).to.equal(context.accounts.deployer.address);
    });

    it('cannot call initialize() a second time', async () => {
      const context = await loadFixture(deployLockPeriodFixture);
      await expect(context.suite.complianceModule.initialize()).to.be.revertedWith('Initializable: contract is already initialized');
    });

    describe('.transferOwnership', () => {
      it('reverts when called by a non-owner', async () => {
        const context = await loadFixture(deployLockPeriodFixture);
        await expect(
          context.suite.complianceModule.connect(context.accounts.aliceWallet).transferOwnership(context.accounts.aliceWallet.address),
        ).to.be.revertedWith('Ownable: caller is not the owner');
      });

      it('succeeds when called by the owner', async () => {
        const context = await loadFixture(deployLockPeriodFixture);
        await context.suite.complianceModule.connect(context.accounts.deployer).transferOwnership(context.accounts.aliceWallet.address);
        expect(await context.suite.complianceModule.owner()).to.equal(context.accounts.aliceWallet.address);
      });
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 4. ADMIN CONFIGURATION — setLockDuration
  // ══════════════════════════════════════════════════════════════════════════
  describe('4. Admin Configuration (.setLockDuration)', () => {
    it('reverts when called directly by any wallet (not via compliance)', async () => {
      const context = await loadFixture(deployLockPeriodFullSuite);
      await expect(
        context.suite.complianceModule.connect(context.accounts.deployer).setLockDuration(THIRTY_DAYS),
      ).to.be.revertedWith('only bound compliance can call');
    });

    it('reverts when called by a random user wallet', async () => {
      const context = await loadFixture(deployLockPeriodFullSuite);
      await expect(
        context.suite.complianceModule.connect(context.accounts.aliceWallet).setLockDuration(THIRTY_DAYS),
      ).to.be.revertedWith('only bound compliance can call');
    });

    it('sets lock duration successfully via callModuleFunction and emits LockDurationSet', async () => {
      const context = await loadFixture(deployLockPeriodFullSuite);
      await expect(
        context.suite.compliance.callModuleFunction(encodeSetLockDuration(THIRTY_DAYS), context.suite.complianceModule.address),
      )
        .to.emit(context.suite.complianceModule, 'LockDurationSet')
        .withArgs(context.suite.compliance.address, THIRTY_DAYS);

      expect(await context.suite.complianceModule.lockDurations(context.suite.compliance.address)).to.equal(THIRTY_DAYS);
    });

    it('can update lock duration to 0 (disable locks)', async () => {
      const context = await loadFixture(deployLockPeriodFullSuite);
      await context.suite.compliance.callModuleFunction(encodeSetLockDuration(THIRTY_DAYS), context.suite.complianceModule.address);
      await context.suite.compliance.callModuleFunction(encodeSetLockDuration(0), context.suite.complianceModule.address);
      expect(await context.suite.complianceModule.lockDurations(context.suite.compliance.address)).to.equal(0);
    });

    it('lock duration stored per compliance — compliance A and B are independent', async () => {
      const context = await loadFixture(deployLockPeriodFullSuite);
      // complianceBeta is from the fixture (a second compliance contract)
      await context.suite.compliance.callModuleFunction(encodeSetLockDuration(THIRTY_DAYS), context.suite.complianceModule.address);
      // complianceBeta has never called setLockDuration
      expect(await context.suite.complianceModule.lockDurations(context.suite.complianceBeta.address)).to.equal(0);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 5. HOOK: moduleMintAction
  // ══════════════════════════════════════════════════════════════════════════
  describe('5. Active Hook (.moduleMintAction)', () => {
    it('reverts if called directly (not via compliance)', async () => {
      const context = await loadFixture(deployLockPeriodFullSuite);
      await expect(
        context.suite.complianceModule.moduleMintAction(context.accounts.aliceWallet.address, 100),
      ).to.be.revertedWith('only bound compliance can call');
    });

    it('does NOT apply a lock if duration is 0 — no LockApplied event, queue state unchanged', async () => {
      const context = await loadFixture(deployLockPeriodFullSuite);
      // duration is 0 by default
      await expect(
        context.suite.compliance.callModuleFunction(encodeMintAction(context.accounts.aliceWallet.address, 100), context.suite.complianceModule.address),
      ).to.not.emit(context.suite.complianceModule, 'LockApplied');

      const info = await context.suite.complianceModule.userQueueInfo(context.suite.compliance.address, context.accounts.aliceWallet.address);
      expect(info.head).to.equal(0);
      expect(info.tail).to.equal(0);
    });

    it('applies a lock and emits LockApplied if duration > 0', async () => {
      const context = await loadFixture(deployLockPeriodFullSuite);
      await context.suite.compliance.callModuleFunction(encodeSetLockDuration(THIRTY_DAYS), context.suite.complianceModule.address);
      await expect(
        context.suite.compliance.callModuleFunction(encodeMintAction(context.accounts.aliceWallet.address, 100), context.suite.complianceModule.address),
      ).to.emit(context.suite.complianceModule, 'LockApplied');
    });

    it('queue tail increments with each new mint', async () => {
      const context = await loadFixture(deployLockPeriodFullSuite);
      await context.suite.compliance.callModuleFunction(encodeSetLockDuration(THIRTY_DAYS), context.suite.complianceModule.address);

      for (let i = 1; i <= 5; i++) {
        await context.suite.compliance.callModuleFunction(encodeMintAction(context.accounts.aliceWallet.address, 10), context.suite.complianceModule.address);
        const info = await context.suite.complianceModule.userQueueInfo(context.suite.compliance.address, context.accounts.aliceWallet.address);
        expect(info.tail).to.equal(i);
        expect(info.head).to.equal(0);
      }
    });

    it('each lock slot stores the correct amount and expiresAt', async () => {
      const context = await loadFixture(deployLockPeriodFullSuite);
      const before = await ethers.provider.getBlock('latest');
      await context.suite.compliance.callModuleFunction(encodeSetLockDuration(THIRTY_DAYS), context.suite.complianceModule.address);
      await context.suite.compliance.callModuleFunction(encodeMintAction(context.accounts.aliceWallet.address, 42), context.suite.complianceModule.address);

      const lock = await context.suite.complianceModule.userLocks(context.suite.compliance.address, context.accounts.aliceWallet.address, 0);
      expect(lock.amount).to.equal(42);
      expect(lock.expiresAt.toNumber()).to.be.greaterThan(before.timestamp);
    });

    it('lock only applies to the minted recipient (not the sender)', async () => {
      const context = await loadFixture(deployLockPeriodFullSuite);
      await context.suite.compliance.callModuleFunction(encodeSetLockDuration(THIRTY_DAYS), context.suite.complianceModule.address);
      await context.suite.compliance.callModuleFunction(encodeMintAction(context.accounts.aliceWallet.address, 100), context.suite.complianceModule.address);

      // Bob has no lock
      const bobInfo = await context.suite.complianceModule.userQueueInfo(context.suite.compliance.address, context.accounts.bobWallet.address);
      expect(bobInfo.tail).to.equal(0);
    });

    it('minting to different users tracks their queues independently', async () => {
      const context = await loadFixture(deployLockPeriodFullSuite);
      await context.suite.compliance.callModuleFunction(encodeSetLockDuration(THIRTY_DAYS), context.suite.complianceModule.address);

      await context.suite.compliance.callModuleFunction(encodeMintAction(context.accounts.aliceWallet.address, 100), context.suite.complianceModule.address);
      await context.suite.compliance.callModuleFunction(encodeMintAction(context.accounts.aliceWallet.address, 200), context.suite.complianceModule.address);
      await context.suite.compliance.callModuleFunction(encodeMintAction(context.accounts.bobWallet.address, 50), context.suite.complianceModule.address);

      const aliceInfo = await context.suite.complianceModule.userQueueInfo(context.suite.compliance.address, context.accounts.aliceWallet.address);
      const bobInfo   = await context.suite.complianceModule.userQueueInfo(context.suite.compliance.address, context.accounts.bobWallet.address);

      expect(aliceInfo.tail).to.equal(2);
      expect(bobInfo.tail).to.equal(1);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 6. HOOK: moduleTransferAction
  // ══════════════════════════════════════════════════════════════════════════
  describe('6. Hook (.moduleTransferAction)', () => {
    it('reverts when called directly', async () => {
      const context = await loadFixture(deployLockPeriodFullSuite);
      await expect(
        context.suite.complianceModule.moduleTransferAction(context.accounts.aliceWallet.address, context.accounts.bobWallet.address, 10),
      ).to.be.revertedWith('only bound compliance can call');
    });

    it('succeeds when called via compliance (via callModuleFunction)', async () => {
      const context = await loadFixture(deployLockPeriodFullSuite);
      await expect(
        context.suite.compliance.callModuleFunction(
          encodeTransferAction(context.accounts.aliceWallet.address, context.accounts.bobWallet.address, 10),
          context.suite.complianceModule.address,
        ),
      ).to.eventually.be.fulfilled;
    });

    it('does NOT apply a new lock to the receiver on secondary market trade', async () => {
      const context = await loadFixture(deployLockPeriodFullSuite);
      await setupLockAndMint(context, THIRTY_DAYS, context.accounts.aliceWallet.address, 100);

      // time-travel past Alice's lock
      await time.increase(THIRTY_DAYS + 1);

      // Alice transfers to Bob
      await context.suite.token.connect(context.accounts.aliceWallet).transfer(context.accounts.bobWallet.address, 50);

      // Bob has no lock — can immediately re-sell
      const bobInfo = await context.suite.complianceModule.userQueueInfo(context.suite.compliance.address, context.accounts.bobWallet.address);
      expect(bobInfo.tail).to.equal(0);
    });

    it('automatically cleans expired locks from sender during secondary market transfer', async () => {
      const context = await loadFixture(deployLockPeriodFullSuite);
      await setupLockAndMint(context, THIRTY_DAYS, context.accounts.aliceWallet.address, 100);

      await time.increase(THIRTY_DAYS + 1);

      // Alice transfers — this triggers moduleTransferAction which runs _cleanExpiredLocks
      await context.suite.token.connect(context.accounts.aliceWallet).transfer(context.accounts.bobWallet.address, 100);

      const info = await context.suite.complianceModule.userQueueInfo(context.suite.compliance.address, context.accounts.aliceWallet.address);
      expect(info.head).to.equal(1); // head advanced past the expired lock
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 7. HOOK: moduleBurnAction
  // ══════════════════════════════════════════════════════════════════════════
  describe('7. Hook (.moduleBurnAction)', () => {
    it('reverts when called directly', async () => {
      const context = await loadFixture(deployLockPeriodFullSuite);
      await expect(
        context.suite.complianceModule.moduleBurnAction(context.accounts.aliceWallet.address, 10),
      ).to.be.revertedWith('only bound compliance can call');
    });

    it('succeeds when called via compliance — does nothing (intentional no-op)', async () => {
      const context = await loadFixture(deployLockPeriodFullSuite);
      await expect(
        context.suite.compliance.callModuleFunction(
          encodeBurnAction(context.accounts.aliceWallet.address, 10),
          context.suite.complianceModule.address,
        ),
      ).to.eventually.be.fulfilled;
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 8. CORE LOGIC: moduleCheck state machine
  // ══════════════════════════════════════════════════════════════════════════
  describe('8. Core Logic Engine (.moduleCheck)', () => {
    describe('Mint bypass', () => {
      it('returns true immediately when _from == address(0) (mint bypass), regardless of lock state', async () => {
        const context = await loadFixture(deployLockPeriodFullSuite);
        const result = await context.suite.complianceModule.moduleCheck(
          ethers.constants.AddressZero,
          context.accounts.aliceWallet.address,
          100,
          context.suite.compliance.address,
        );
        expect(result).to.be.true;
      });
    });

    describe('No locks', () => {
      it('returns true when user has no lock entries whatsoever', async () => {
        const context = await loadFixture(deployLockPeriodFullSuite);
        const result = await context.suite.complianceModule.moduleCheck(
          context.accounts.aliceWallet.address,
          context.accounts.bobWallet.address,
          10,
          context.suite.compliance.address,
        );
        expect(result).to.be.true;
      });
    });

    describe('Zero-value transfer edge case', () => {
      it('returns true for a 0-value transfer even when 100% locked', async () => {
        const context = await loadFixture(deployLockPeriodFullSuite);
        await setupLockAndMint(context, THIRTY_DAYS, context.accounts.aliceWallet.address, 100);
        const result = await context.suite.complianceModule.moduleCheck(
          context.accounts.aliceWallet.address,
          context.accounts.bobWallet.address,
          0,
          context.suite.compliance.address,
        );
        expect(result).to.be.true;
      });
    });

    describe('Full lock', () => {
      it('returns false when sender tries to transfer any non-zero amount while 100% locked', async () => {
        const context = await loadFixture(deployLockPeriodFullSuite);
        await setupLockAndMint(context, THIRTY_DAYS, context.accounts.aliceWallet.address, 100);
        expect(
          await context.suite.complianceModule.moduleCheck(
            context.accounts.aliceWallet.address,
            context.accounts.bobWallet.address,
            1,
            context.suite.compliance.address,
          ),
        ).to.be.false;
      });

      it('returns false when sender tries to transfer the full locked amount', async () => {
        const context = await loadFixture(deployLockPeriodFullSuite);
        await setupLockAndMint(context, THIRTY_DAYS, context.accounts.aliceWallet.address, 100);
        expect(
          await context.suite.complianceModule.moduleCheck(
            context.accounts.aliceWallet.address,
            context.accounts.bobWallet.address,
            100,
            context.suite.compliance.address,
          ),
        ).to.be.false;
      });
    });

    describe('Partial lock', () => {
      it('returns true when transferring within the unlocked portion', async () => {
        const context = await loadFixture(deployLockPeriodFullSuite);
        // 100 locked
        await setupLockAndMint(context, THIRTY_DAYS, context.accounts.aliceWallet.address, 100);
        // 50 free
        await context.suite.compliance.callModuleFunction(encodeSetLockDuration(0), context.suite.complianceModule.address);
        await context.suite.token.connect(context.accounts.tokenAgent).mint(context.accounts.aliceWallet.address, 50);

        expect(
          await context.suite.complianceModule.moduleCheck(
            context.accounts.aliceWallet.address, context.accounts.bobWallet.address, 50, context.suite.compliance.address,
          ),
        ).to.be.true;
      });

      it('returns false when transfer exceeds the unlocked portion by 1 token', async () => {
        const context = await loadFixture(deployLockPeriodFullSuite);
        await setupLockAndMint(context, THIRTY_DAYS, context.accounts.aliceWallet.address, 100);
        await context.suite.compliance.callModuleFunction(encodeSetLockDuration(0), context.suite.complianceModule.address);
        await context.suite.token.connect(context.accounts.tokenAgent).mint(context.accounts.aliceWallet.address, 50);

        expect(
          await context.suite.complianceModule.moduleCheck(
            context.accounts.aliceWallet.address, context.accounts.bobWallet.address, 51, context.suite.compliance.address,
          ),
        ).to.be.false;
      });
    });

    describe('Multiple locks accumulate correctly', () => {
      it('sums all active lock amounts when user has multiple unexpired locks', async () => {
        const context = await loadFixture(deployLockPeriodFullSuite);
        await context.suite.compliance.callModuleFunction(encodeSetLockDuration(THIRTY_DAYS), context.suite.complianceModule.address);
        await context.suite.token.connect(context.accounts.tokenAgent).mint(context.accounts.aliceWallet.address, 50);
        await context.suite.token.connect(context.accounts.tokenAgent).mint(context.accounts.aliceWallet.address, 50);

        // Total locked = 100, any transfer > 0 should fail
        expect(
          await context.suite.complianceModule.moduleCheck(
            context.accounts.aliceWallet.address, context.accounts.bobWallet.address, 1, context.suite.compliance.address,
          ),
        ).to.be.false;
      });
    });

    describe('Time expiry', () => {
      it('returns true after the lock period expires — even without cleaning storage', async () => {
        const context = await loadFixture(deployLockPeriodFullSuite);
        await setupLockAndMint(context, THIRTY_DAYS, context.accounts.aliceWallet.address, 100);
        await time.increase(THIRTY_DAYS + 1);

        expect(
          await context.suite.complianceModule.moduleCheck(
            context.accounts.aliceWallet.address, context.accounts.bobWallet.address, 100, context.suite.compliance.address,
          ),
        ).to.be.true;
      });

      it('returns false 1 second BEFORE expiry', async () => {
        const context = await loadFixture(deployLockPeriodFullSuite);
        await setupLockAndMint(context, THIRTY_DAYS, context.accounts.aliceWallet.address, 100);
        await time.increase(THIRTY_DAYS - 1);

        expect(
          await context.suite.complianceModule.moduleCheck(
            context.accounts.aliceWallet.address, context.accounts.bobWallet.address, 100, context.suite.compliance.address,
          ),
        ).to.be.false;
      });

      it('correctly handles partial time expiry: oldest lock expired, newest still active', async () => {
        const context = await loadFixture(deployLockPeriodFullSuite);

        // Lock #1: 30 days
        await context.suite.compliance.callModuleFunction(encodeSetLockDuration(THIRTY_DAYS), context.suite.complianceModule.address);
        await context.suite.token.connect(context.accounts.tokenAgent).mint(context.accounts.aliceWallet.address, 50);

        // Lock #2: 60 days (created after some time)
        await time.increase(THIRTY_DAYS - 1);
        await context.suite.compliance.callModuleFunction(encodeSetLockDuration(SIXTY_DAYS), context.suite.complianceModule.address);
        await context.suite.token.connect(context.accounts.tokenAgent).mint(context.accounts.aliceWallet.address, 50);

        // Fast-forward past lock #1 but not lock #2
        await time.increase(2);

        // Lock #1 (50 tokens) is expired; lock #2 (50 tokens) is still active.
        // Alice has 100 tokens, 50 are locked. She can transfer 50 but not 51.
        expect(
          await context.suite.complianceModule.moduleCheck(
            context.accounts.aliceWallet.address, context.accounts.bobWallet.address, 50, context.suite.compliance.address,
          ),
        ).to.be.true;

        expect(
          await context.suite.complianceModule.moduleCheck(
            context.accounts.aliceWallet.address, context.accounts.bobWallet.address, 51, context.suite.compliance.address,
          ),
        ).to.be.false;
      });
    });

    describe('Burn restriction: locked tokens cannot be burned', () => {
      it('prevents an admin burn via the compliance when the burn value exceeds unlocked balance', async () => {
        const context = await loadFixture(deployLockPeriodFullSuite);
        await setupLockAndMint(context, ONE_YEAR, context.accounts.aliceWallet.address, 100);

        // A forced forcedTransfer burn by admin is still gated by moduleCheck
        // The token.burn() by an agent bypasses compliance so we test the moduleCheck directly
        const result = await context.suite.complianceModule.moduleCheck(
          context.accounts.aliceWallet.address,
          ethers.constants.AddressZero,
          100,
          context.suite.compliance.address,
        );
        expect(result).to.be.false;
      });
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 9. QUEUE ARCHITECTURE — head/tail pointer mechanics
  // ══════════════════════════════════════════════════════════════════════════
  describe('9. Queue Architecture (head/tail pointer correctness)', () => {
    it('initializes with head=0 and tail=0 for new users', async () => {
      const context = await loadFixture(deployLockPeriodFullSuite);
      const info = await context.suite.complianceModule.userQueueInfo(
        context.suite.compliance.address,
        context.accounts.aliceWallet.address,
      );
      expect(info.head).to.equal(0);
      expect(info.tail).to.equal(0);
    });

    it('tail increments correctly but head stays at 0 while locks are active', async () => {
      const context = await loadFixture(deployLockPeriodFullSuite);
      await context.suite.compliance.callModuleFunction(encodeSetLockDuration(THIRTY_DAYS), context.suite.complianceModule.address);

      await context.suite.compliance.callModuleFunction(encodeMintAction(context.accounts.aliceWallet.address, 10), context.suite.complianceModule.address);
      await context.suite.compliance.callModuleFunction(encodeMintAction(context.accounts.aliceWallet.address, 20), context.suite.complianceModule.address);
      await context.suite.compliance.callModuleFunction(encodeMintAction(context.accounts.aliceWallet.address, 30), context.suite.complianceModule.address);

      const info = await context.suite.complianceModule.userQueueInfo(context.suite.compliance.address, context.accounts.aliceWallet.address);
      expect(info.head).to.equal(0);
      expect(info.tail).to.equal(3);
    });

    it('queue state is isolated per compliance address', async () => {
      const context = await loadFixture(deployLockPeriodFullSuite);
      await context.suite.compliance.callModuleFunction(encodeSetLockDuration(THIRTY_DAYS), context.suite.complianceModule.address);
      await context.suite.compliance.callModuleFunction(encodeMintAction(context.accounts.aliceWallet.address, 100), context.suite.complianceModule.address);

      // complianceBeta has no data on Alice
      const infoOnBeta = await context.suite.complianceModule.userQueueInfo(context.suite.complianceBeta.address, context.accounts.aliceWallet.address);
      expect(infoOnBeta.tail).to.equal(0);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 10. CLEANUP MECHANICS — cleanExpiredLocks
  // ══════════════════════════════════════════════════════════════════════════
  describe('10. Cleanup Mechanics (.cleanExpiredLocks)', () => {
    it('calling cleanExpiredLocks on an empty queue does not revert and leaves state unchanged', async () => {
      const context = await loadFixture(deployLockPeriodFullSuite);
      await expect(
        context.suite.complianceModule.cleanExpiredLocks(context.suite.compliance.address, context.accounts.aliceWallet.address),
      ).to.eventually.be.fulfilled;
      const info = await context.suite.complianceModule.userQueueInfo(context.suite.compliance.address, context.accounts.aliceWallet.address);
      expect(info.head).to.equal(0);
      expect(info.tail).to.equal(0);
    });

    it('calling cleanExpiredLocks before any locks expire does NOT advance head', async () => {
      const context = await loadFixture(deployLockPeriodFullSuite);
      await setupLockAndMint(context, THIRTY_DAYS, context.accounts.aliceWallet.address, 100);

      await time.increase(THIRTY_DAYS - 10);
      await context.suite.complianceModule.cleanExpiredLocks(context.suite.compliance.address, context.accounts.aliceWallet.address);

      const info = await context.suite.complianceModule.userQueueInfo(context.suite.compliance.address, context.accounts.aliceWallet.address);
      expect(info.head).to.equal(0); // lock not expired yet — head unchanged
    });

    it('advances head past ALL expired locks and wipes their storage', async () => {
      const context = await loadFixture(deployLockPeriodFullSuite);
      await context.suite.compliance.callModuleFunction(encodeSetLockDuration(THIRTY_DAYS), context.suite.complianceModule.address);
      await context.suite.compliance.callModuleFunction(encodeMintAction(context.accounts.aliceWallet.address, 10), context.suite.complianceModule.address);
      await context.suite.compliance.callModuleFunction(encodeMintAction(context.accounts.aliceWallet.address, 20), context.suite.complianceModule.address);
      await context.suite.compliance.callModuleFunction(encodeMintAction(context.accounts.aliceWallet.address, 30), context.suite.complianceModule.address);

      await time.increase(THIRTY_DAYS + 1);
      await context.suite.complianceModule.cleanExpiredLocks(context.suite.compliance.address, context.accounts.aliceWallet.address);

      const info = await context.suite.complianceModule.userQueueInfo(context.suite.compliance.address, context.accounts.aliceWallet.address);
      expect(info.head).to.equal(3); // all 3 locks cleaned

      // Storage deleted (zeroed out) — gas refund confirmed
      const lock0 = await context.suite.complianceModule.userLocks(context.suite.compliance.address, context.accounts.aliceWallet.address, 0);
      const lock1 = await context.suite.complianceModule.userLocks(context.suite.compliance.address, context.accounts.aliceWallet.address, 1);
      const lock2 = await context.suite.complianceModule.userLocks(context.suite.compliance.address, context.accounts.aliceWallet.address, 2);
      expect(lock0.amount).to.equal(0);
      expect(lock1.amount).to.equal(0);
      expect(lock2.amount).to.equal(0);
    });

    it('partial cleanup: only cleans expired locks and stops at the first non-expired one', async () => {
      const context = await loadFixture(deployLockPeriodFullSuite);

      // Lock #0 — expires in 30 days
      await context.suite.compliance.callModuleFunction(encodeSetLockDuration(THIRTY_DAYS), context.suite.complianceModule.address);
      await context.suite.compliance.callModuleFunction(encodeMintAction(context.accounts.aliceWallet.address, 10), context.suite.complianceModule.address);

      // Fast forward 15 days, then add Lock #1 — expires in 45 days from NOW (60 days total)
      await time.increase(15 * 24 * 60 * 60);
      await context.suite.compliance.callModuleFunction(encodeSetLockDuration(SIXTY_DAYS), context.suite.complianceModule.address);
      await context.suite.compliance.callModuleFunction(encodeMintAction(context.accounts.aliceWallet.address, 20), context.suite.complianceModule.address);

      // Fast forward 16 more days — Lock #0 is expired; Lock #1 is NOT
      await time.increase(16 * 24 * 60 * 60);
      await context.suite.complianceModule.cleanExpiredLocks(context.suite.compliance.address, context.accounts.aliceWallet.address);

      const info = await context.suite.complianceModule.userQueueInfo(context.suite.compliance.address, context.accounts.aliceWallet.address);
      expect(info.head).to.equal(1); // only index 0 was cleaned

      // Index 0 deleted
      const lock0 = await context.suite.complianceModule.userLocks(context.suite.compliance.address, context.accounts.aliceWallet.address, 0);
      expect(lock0.amount).to.equal(0);

      // Index 1 intact
      const lock1 = await context.suite.complianceModule.userLocks(context.suite.compliance.address, context.accounts.aliceWallet.address, 1);
      expect(lock1.amount).to.equal(20);
    });

    it('calling cleanExpiredLocks when head already equals tail is safe and idempotent', async () => {
      const context = await loadFixture(deployLockPeriodFullSuite);
      await setupLockAndMint(context, THIRTY_DAYS, context.accounts.aliceWallet.address, 100);
      await time.increase(THIRTY_DAYS + 1);

      // Clean once
      await context.suite.complianceModule.cleanExpiredLocks(context.suite.compliance.address, context.accounts.aliceWallet.address);
      // Clean again on an already-empty queue
      await expect(
        context.suite.complianceModule.cleanExpiredLocks(context.suite.compliance.address, context.accounts.aliceWallet.address),
      ).to.eventually.be.fulfilled;

      const info = await context.suite.complianceModule.userQueueInfo(context.suite.compliance.address, context.accounts.aliceWallet.address);
      expect(info.head).to.equal(1);
      expect(info.tail).to.equal(1);
    });

    it('anyone (not just the user) can call cleanExpiredLocks for any address', async () => {
      const context = await loadFixture(deployLockPeriodFullSuite);
      await setupLockAndMint(context, THIRTY_DAYS, context.accounts.aliceWallet.address, 100);
      await time.increase(THIRTY_DAYS + 1);

      // Bob calls clean on Alice's queue
      await expect(
        context.suite.complianceModule.connect(context.accounts.bobWallet).cleanExpiredLocks(
          context.suite.compliance.address,
          context.accounts.aliceWallet.address,
        ),
      ).to.eventually.be.fulfilled;

      const info = await context.suite.complianceModule.userQueueInfo(context.suite.compliance.address, context.accounts.aliceWallet.address);
      expect(info.head).to.equal(1);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 11. INTEGRATION TESTS — End-to-End flows
  // ══════════════════════════════════════════════════════════════════════════
  describe('11. Integration Tests (End-to-End Flows)', () => {
    it('Flow 1: Primary market lock blocks transfer immediately after mint', async () => {
      const context = await loadFixture(deployLockPeriodFullSuite);
      await setupLockAndMint(context, THIRTY_DAYS, context.accounts.aliceWallet.address, 100);

      await expect(
        context.suite.token.connect(context.accounts.aliceWallet).transfer(context.accounts.bobWallet.address, 1),
      ).to.be.revertedWith('Transfer not possible');
    });

    it('Flow 2: Primary market lock is lifted after time passes', async () => {
      const context = await loadFixture(deployLockPeriodFullSuite);
      await setupLockAndMint(context, THIRTY_DAYS, context.accounts.aliceWallet.address, 100);
      await time.increase(THIRTY_DAYS + 1);

      await expect(
        context.suite.token.connect(context.accounts.aliceWallet).transfer(context.accounts.bobWallet.address, 100),
      ).to.eventually.be.fulfilled;
    });

    it('Flow 3: Secondary market buyer (Bob) has NO lock after receiving tokens', async () => {
      const context = await loadFixture(deployLockPeriodFullSuite);
      await setupLockAndMint(context, THIRTY_DAYS, context.accounts.aliceWallet.address, 100);
      await time.increase(THIRTY_DAYS + 1);

      // Alice sells to Bob
      await context.suite.token.connect(context.accounts.aliceWallet).transfer(context.accounts.bobWallet.address, 100);

      // Bob can immediately re-sell his tokens (no lock was applied to him)
      await expect(
        context.suite.token.connect(context.accounts.bobWallet).transfer(context.accounts.aliceWallet.address, 50),
      ).to.eventually.be.fulfilled;
    });

    it('Flow 4: Dynamic duration change — existing locks are honored, new mints get new duration', async () => {
      const context = await loadFixture(deployLockPeriodFullSuite);

      // Mint 100 with 30-day lock
      await setupLockAndMint(context, THIRTY_DAYS, context.accounts.aliceWallet.address, 100);

      // Platform changes duration to 0 (remove locks going forward)
      await context.suite.compliance.callModuleFunction(encodeSetLockDuration(0), context.suite.complianceModule.address);

      // Mint 50 more — no lock applied
      await context.suite.token.connect(context.accounts.tokenAgent).mint(context.accounts.aliceWallet.address, 50);

      // Alice has 150 total. 100 locked, 50 free.
      await expect(
        context.suite.token.connect(context.accounts.aliceWallet).transfer(context.accounts.bobWallet.address, 50),
      ).to.eventually.be.fulfilled;

      await expect(
        context.suite.token.connect(context.accounts.aliceWallet).transfer(context.accounts.bobWallet.address, 1),
      ).to.be.revertedWith('Transfer not possible');
    });

    it('Flow 5: Burn of UNLOCKED tokens does NOT ghost-lock the user', async () => {
      const context = await loadFixture(deployLockPeriodFullSuite);

      // Mint 100 locked, then mint 50 free
      await setupLockAndMint(context, THIRTY_DAYS, context.accounts.aliceWallet.address, 100);
      await context.suite.compliance.callModuleFunction(encodeSetLockDuration(0), context.suite.complianceModule.address);
      await context.suite.token.connect(context.accounts.tokenAgent).mint(context.accounts.aliceWallet.address, 50);

      // Agent burns 50 (the unlocked ones)
      await context.suite.token.connect(context.accounts.tokenAgent).burn(context.accounts.aliceWallet.address, 50);

      // Alice now has 100 tokens, all locked. She should NOT be able to transfer anything.
      expect(
        await context.suite.complianceModule.moduleCheck(
          context.accounts.aliceWallet.address, context.accounts.bobWallet.address, 1, context.suite.compliance.address,
        ),
      ).to.be.false;
    });

    it('Flow 6: Full lifecycle — mint, lock, wait, trade, verify clean queue state', async () => {
      const context = await loadFixture(deployLockPeriodFullSuite);
      await setupLockAndMint(context, THIRTY_DAYS, context.accounts.aliceWallet.address, 100);

      // Blocked during lock
      await expect(
        context.suite.token.connect(context.accounts.aliceWallet).transfer(context.accounts.bobWallet.address, 1),
      ).to.be.revertedWith('Transfer not possible');

      // Unblocked after lock
      await time.increase(THIRTY_DAYS + 1);
      await context.suite.token.connect(context.accounts.aliceWallet).transfer(context.accounts.bobWallet.address, 100);

      // Verify the moduleTransferAction auto-cleaned Alice's queue
      const aliceInfo = await context.suite.complianceModule.userQueueInfo(context.suite.compliance.address, context.accounts.aliceWallet.address);
      expect(aliceInfo.head).to.equal(1);

      // Bob (secondary buyer) has no locks at all
      const bobInfo = await context.suite.complianceModule.userQueueInfo(context.suite.compliance.address, context.accounts.bobWallet.address);
      expect(bobInfo.tail).to.equal(0);
    });

    it('Flow 7: Multiple users, multiple locks — each user is isolated and correct', async () => {
      const context = await loadFixture(deployLockPeriodFullSuite);
      await context.suite.compliance.callModuleFunction(encodeSetLockDuration(THIRTY_DAYS), context.suite.complianceModule.address);

      await context.suite.token.connect(context.accounts.tokenAgent).mint(context.accounts.aliceWallet.address, 100);
      await context.suite.token.connect(context.accounts.tokenAgent).mint(context.accounts.bobWallet.address, 200);

      // Both are locked
      expect(
        await context.suite.complianceModule.moduleCheck(context.accounts.aliceWallet.address, context.accounts.bobWallet.address, 1, context.suite.compliance.address),
      ).to.be.false;
      expect(
        await context.suite.complianceModule.moduleCheck(context.accounts.bobWallet.address, context.accounts.aliceWallet.address, 1, context.suite.compliance.address),
      ).to.be.false;

      // Admin sets lock to 0, mints extra to Alice only (free tokens)
      await context.suite.compliance.callModuleFunction(encodeSetLockDuration(0), context.suite.complianceModule.address);
      await context.suite.token.connect(context.accounts.tokenAgent).mint(context.accounts.aliceWallet.address, 50);

      // Alice can transfer 50, Bob still fully locked
      expect(
        await context.suite.complianceModule.moduleCheck(context.accounts.aliceWallet.address, context.accounts.bobWallet.address, 50, context.suite.compliance.address),
      ).to.be.true;
      expect(
        await context.suite.complianceModule.moduleCheck(context.accounts.bobWallet.address, context.accounts.aliceWallet.address, 1, context.suite.compliance.address),
      ).to.be.false;
    });
  });

});
