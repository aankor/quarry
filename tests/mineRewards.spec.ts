import * as anchor from "@project-serum/anchor";
import { expectTX } from "@saberhq/chai-solana";
import type { Provider } from "@saberhq/solana-contrib";
import {
  createInitMintInstructions,
  createMint,
  getATAAddress,
  getTokenAccount,
  sleep,
  Token,
  TokenAmount,
  u64,
} from "@saberhq/token-utils";
import type { PublicKey } from "@solana/web3.js";
import { Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import * as assert from "assert";
import { BN } from "bn.js";
import { expect } from "chai";
import invariant from "tiny-invariant";

import type {
  MineWrapper,
  MintWrapper,
  QuarrySDK,
  RewarderWrapper,
  StakeEvent,
} from "../src";
import { QUARRY_CODERS } from "../src";
import {
  DEFAULT_DECIMALS,
  DEFAULT_HARD_CAP,
  newUserStakeTokenAccount,
} from "./utils";
import { makeSDK } from "./workspace";

const ZERO = new BN(0);

describe("Mine Rewards", () => {
  const dailyRewardsRate = new BN(1_000 * LAMPORTS_PER_SOL);
  const annualRewardsRate = dailyRewardsRate.mul(new BN(365));

  const rewardsShare = dailyRewardsRate.div(new BN(10));
  const stakeAmount = 1_000_000000;

  let sdk: QuarrySDK;
  let provider: Provider;
  let mintWrapper: MintWrapper;
  let mine: MineWrapper;

  let stakedMintAuthority: anchor.web3.Keypair;
  let stakeTokenMint: anchor.web3.PublicKey;
  let stakeToken: Token;

  let rewarder: PublicKey;
  let rewarderWrapper: RewarderWrapper;

  before("Initialize SDK", () => {
    sdk = makeSDK();
    provider = sdk.provider;
    mintWrapper = sdk.mintWrapper;
    mine = sdk.mine;
  });

  let rewardsMint: PublicKey;
  let token: Token;
  let mintWrapperKey: PublicKey;
  let hardCap: TokenAmount;

  beforeEach("Initialize mint", async () => {
    const rewardsMintKP = Keypair.generate();
    rewardsMint = rewardsMintKP.publicKey;
    token = Token.fromMint(rewardsMint, DEFAULT_DECIMALS);
    hardCap = TokenAmount.parse(token, DEFAULT_HARD_CAP.toString());
    const { tx, mintWrapper: wrapperKey } = await mintWrapper.newWrapper({
      hardcap: hardCap.toU64(),
      tokenMint: rewardsMint,
    });

    await expectTX(
      await createInitMintInstructions({
        provider,
        mintKP: rewardsMintKP,
        decimals: DEFAULT_DECIMALS,
        mintAuthority: wrapperKey,
        freezeAuthority: wrapperKey,
      })
    ).to.be.fulfilled;

    mintWrapperKey = wrapperKey;
    await expectTX(tx, "Initialize mint").to.be.fulfilled;
  });

  beforeEach(async () => {
    stakedMintAuthority = Keypair.generate();
    stakeTokenMint = await createMint(
      provider,
      stakedMintAuthority.publicKey,
      DEFAULT_DECIMALS
    );
    stakeToken = Token.fromMint(stakeTokenMint, DEFAULT_DECIMALS, {
      name: "stake token",
    });

    const { tx: rewarderTx, key: rewarderKey } = await mine.createRewarder({
      mintWrapper: mintWrapperKey,
    });
    rewarder = rewarderKey;
    await expectTX(rewarderTx).eventually.to.be.fulfilled;

    rewarderWrapper = await mine.loadRewarderWrapper(rewarder);

    const setAnnualRewardsTX = await rewarderWrapper.setAndSyncAnnualRewards(
      annualRewardsRate,
      []
    );
    await expectTX(setAnnualRewardsTX).eventually.to.be.fulfilled;

    const { tx: createQuarryTX } = await rewarderWrapper.createQuarry({
      token: stakeToken,
    });
    await expectTX(createQuarryTX, "create quarry for stake token").to.be
      .fulfilled;
    const quarryWrapper = await rewarderWrapper.getQuarry(stakeToken);
    await expectTX(
      (
        await quarryWrapper.createMiner()
      ).tx,
      "create miner for user"
    ).to.be.fulfilled;

    await expectTX(
      quarryWrapper.setRewardsShare(rewardsShare),
      "set rewards share"
    ).to.be.fulfilled;

    // mint test tokens
    await newUserStakeTokenAccount(
      sdk,
      await rewarderWrapper.getQuarry(stakeToken),
      stakeToken,
      stakedMintAuthority,
      stakeAmount
    );
  });

  it("#stake", async () => {
    let quarry = await rewarderWrapper.getQuarry(stakeToken);
    expect(quarry).to.exist;
    const minerActions = await quarry.getMinerActions(
      provider.wallet.publicKey
    );
    // stake into the quarry
    const tx = minerActions.stake(new TokenAmount(stakeToken, stakeAmount));
    const receipt = await (await tx.send()).wait();

    const parser = new anchor.EventParser(
      sdk.programs.Mine.programId,
      sdk.programs.Mine.coder
    );
    const theParser = (logs: string[]) => {
      const events: StakeEvent[] = [];
      parser.parseLogs(logs, (event) => {
        events.push(event as StakeEvent);
      });
      return events;
    };
    const event = receipt.getEvents(theParser)[0];

    quarry = await rewarderWrapper.getQuarry(stakeToken);
    // Checks
    const payroll = quarry.payroll;
    assert.ok(event);
    const expectedRewardsPerTokenStored = payroll.calculateRewardPerToken(
      event.data.timestamp
    );
    expect(quarry.quarryData.rewardsPerTokenStored.toString()).to.equal(
      expectedRewardsPerTokenStored.toString()
    );
    const expectedRewardsRate = quarry.computeAnnualRewardsRate();
    expect(quarry.quarryData.annualRewardsRate.toString()).to.equal(
      expectedRewardsRate.toString()
    );
  });

  it("#claim", async () => {
    let quarry = await rewarderWrapper.getQuarry(stakeToken);
    expect(quarry).to.exist;
    let miner = await quarry.getMiner(provider.wallet.publicKey);
    invariant(miner, "miner does not exist");

    const minerActions = await quarry.getMinerActions(
      provider.wallet.publicKey
    );

    const stakeTx = minerActions.stake(
      new TokenAmount(stakeToken, stakeAmount)
    );
    await expectTX(stakeTx, "Stake").to.be.fulfilled;

    const wagesPerTokenPaid = miner.rewardsPerTokenPaid;

    // whitelist rewarder
    await expectTX(
      mintWrapper.newMinterWithAllowance(
        mintWrapperKey,
        rewarder,
        new u64(100_000_000_000000)
      ),
      "Minter add"
    ).to.be.fulfilled;

    // wait some time so we can earn some tokens
    await sleep(3_000);

    const tx = await minerActions.claim();
    const claimSent = await tx.send();
    await expectTX(tx, "Claim").to.be.fulfilled;
    const receipt = await claimSent.wait();
    receipt.printLogs();

    const claimEvent = QUARRY_CODERS.Mine.parseProgramLogEvents(
      receipt.response.meta?.logMessages ?? []
    )[0];
    invariant(claimEvent?.name === "ClaimEvent", "claim event not found");
    assert.ok(claimEvent, "claim event not found");

    quarry = await rewarderWrapper.getQuarry(stakeToken);
    miner = await quarry.getMiner(provider.wallet.publicKey);
    invariant(miner, "miner must exist");

    // Checks
    const payroll = quarry.payroll;
    const expectedWagesEarned = payroll.calculateRewardsEarned(
      claimEvent.data.timestamp,
      new BN(stakeAmount),
      wagesPerTokenPaid,
      ZERO
    );

    const fees = expectedWagesEarned.mul(new BN(1)).div(new BN(10_000));
    const rewardsAfterFees = expectedWagesEarned.sub(fees);

    expect(claimEvent.data.amount.isZero()).to.be.false;
    expect(claimEvent.data.amount).to.bignumber.eq(rewardsAfterFees);
    expect(claimEvent.data.fees).to.bignumber.eq(fees);
    expect(miner.rewardsEarned.toString()).to.equal(ZERO.toString());
    const rewardsTokenAccount = await getATAAddress({
      mint: rewardsMint,
      owner: provider.wallet.publicKey,
    });
    const rewardsTokenAccountInfo = await getTokenAccount(
      provider,
      rewardsTokenAccount
    );
    expect(rewardsTokenAccountInfo.amount.toString()).to.equal(
      claimEvent.data.amount.toString()
    );
  });

  it("#claimV1", async () => {
    let quarry = await rewarderWrapper.getQuarry(stakeToken);
    expect(quarry).to.exist;
    let miner = await quarry.getMiner(provider.wallet.publicKey);
    invariant(miner, "miner does not exist");

    const minerActions = await quarry.getMinerActions(
      provider.wallet.publicKey
    );

    const stakeTx = minerActions.stake(
      new TokenAmount(stakeToken, stakeAmount)
    );
    await expectTX(stakeTx, "Stake").to.be.fulfilled;

    const wagesPerTokenPaid = miner.rewardsPerTokenPaid;

    // whitelist rewarder
    await expectTX(
      mintWrapper.newMinterWithAllowance(
        mintWrapperKey,
        rewarder,
        new u64(100_000_000_000000)
      ),
      "Minter add"
    ).to.be.fulfilled;

    // wait some time so we can earn some tokens
    await sleep(3_000);

    const initRewardsPerTokenPaid = miner.rewardsPerTokenPaid;

    const mintWrapperBefore = await mintWrapper.fetchMintWrapper(
      mintWrapperKey
    );
    invariant(mintWrapperBefore);

    const tx = await minerActions.claimV1();

    const claimSent = await tx.send();
    await expectTX(tx, "Claim").to.be.fulfilled;
    const receipt = await claimSent.wait();
    receipt.printLogs();

    const mintWrapperAfter = await mintWrapper.fetchMintWrapper(mintWrapperKey);
    invariant(mintWrapperAfter);

    const minerAfter = await quarry.getMiner(provider.wallet.publicKey);
    invariant(minerAfter);
    const nextRewardsPerTokenPaid = minerAfter.rewardsPerTokenPaid;

    // check that rewards have changed
    const rewardsPerTokenPaidDiff = nextRewardsPerTokenPaid.sub(
      initRewardsPerTokenPaid
    );
    expect(rewardsPerTokenPaidDiff).to.not.bignumber.zero;

    const numMinted = mintWrapperAfter.totalMinted.sub(
      mintWrapperBefore.totalMinted
    );
    expect(numMinted).to.not.bignumber.zero;

    const claimEvent = QUARRY_CODERS.Mine.parseProgramLogEvents(
      receipt.response.meta?.logMessages ?? []
    )[0];
    invariant(claimEvent?.name === "ClaimEvent", "claim event not found");
    assert.ok(claimEvent, "claim event not found");

    quarry = await rewarderWrapper.getQuarry(stakeToken);
    miner = await quarry.getMiner(provider.wallet.publicKey);
    invariant(miner, "miner must exist");

    // Checks
    const payroll = quarry.payroll;
    const expectedWagesEarned = payroll.calculateRewardsEarned(
      claimEvent.data.timestamp,
      new BN(stakeAmount),
      wagesPerTokenPaid,
      ZERO
    );

    const fees = expectedWagesEarned.mul(new BN(1)).div(new BN(10_000));
    const rewardsAfterFees = expectedWagesEarned.sub(fees);

    expect(numMinted, "minted amount").to.bignumber.eq(expectedWagesEarned);

    expect(claimEvent.data.amount.isZero()).to.be.false;
    expect(claimEvent.data.amount).to.bignumber.eq(rewardsAfterFees);
    expect(claimEvent.data.fees).to.bignumber.eq(fees);
    expect(miner.rewardsEarned.toString()).to.equal(ZERO.toString());
    const rewardsTokenAccount = await getATAAddress({
      mint: rewardsMint,
      owner: provider.wallet.publicKey,
    });
    const rewardsTokenAccountInfo = await getTokenAccount(
      provider,
      rewardsTokenAccount
    );
    expect(rewardsTokenAccountInfo.amount.toString()).to.equal(
      claimEvent.data.amount.toString()
    );
  });

  it("Does not lose rewards when setting quarry share", async () => {
    const quarry = await rewarderWrapper.getQuarry(stakeToken);
    expect(quarry).to.exist;
    const miner = await quarry.getMiner(provider.wallet.publicKey);
    invariant(miner, "miner does not exist");

    const minerActions = await quarry.getMinerActions(
      provider.wallet.publicKey
    );

    const stakeTx = minerActions.stake(
      new TokenAmount(stakeToken, stakeAmount)
    );
    await expectTX(stakeTx, "Stake").to.be.fulfilled;

    // whitelist rewarder
    await expectTX(
      mintWrapper.newMinterWithAllowance(
        mintWrapperKey,
        rewarder,
        new u64(100_000_000_000000)
      ),
      "Minter add"
    ).to.be.fulfilled;

    const rewardsTokenAccount = await getATAAddress({
      mint: rewardsMint,
      owner: provider.wallet.publicKey,
    });
    expect(await provider.getAccountInfo(rewardsTokenAccount)).to.be.null;

    // wait some time so we can earn some tokens
    await sleep(3_000);

    await expectTX(
      quarry.setRewardsShare(new BN(42)).combine(await minerActions.claim()),
      "set rewards share and claim"
    ).to.be.fulfilled;

    const rewardsTokenAccountInfo = await getTokenAccount(
      provider,
      rewardsTokenAccount
    );
    expect(rewardsTokenAccountInfo.amount.isZero()).to.be.false;
  });
});
