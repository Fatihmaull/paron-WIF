/**
 * The 60-Second Coded Judge Tour (upgraded from the legacy PR #99 sample-path tour).
 *
 * Six steps, each a list of beats. Every beat is a real protocol call on the deterministic
 * ledger, so the tour shows genuine state transitions (balances, burns, votes, payouts) with no
 * wallet. The exact same sequence runs on-chain in contracts/test/ParonWifTour.t.sol and both
 * are asserted against fixtures/tour-golden.json.
 */
import { keccak256, toHex } from "viem";
import { DEFAULT_PARAMS, WIF } from "./constants.ts";
import { convertGpuHoursToCu } from "./math.ts";
import type { ParonLedger } from "./engine/ledger.ts";
import { TOUR_ACTORS, createTourWorld, deliverSigned, type World } from "./seed.ts";
import type { Hex, ParonEvent } from "./types.ts";

export type TourContext = {
  world: World;
  vars: Record<string, number>;
  metrics: Record<string, bigint>;
  receipts: TourReceipt[];
};

export type TourBeat = {
  id: string;
  caption: string;
  actor: keyof typeof TOUR_ACTORS | "protocol";
  call: string;
  run: (ctx: TourContext) => void;
};

export type TourStepDef = {
  n: number;
  key: string;
  title: string;
  summary: string;
  loop: "Loop 2 · Margin" | "Loop 1 · Burn" | "Loop 4 · Agents" | "CLOB" | "Mode B" | "Loop 3 · Jury" | "Loop 3 · Election";
  focus: "provider" | "agent" | "clob" | "delivery" | "jury" | "corridor";
  beats: TourBeat[];
  highlights: (ctx: TourContext) => { label: string; value: string }[];
};

export type TourActionRecord = {
  beat: string;
  caption: string;
  actor: string;
  call: string;
  timestamp: string;
  events: { contract: string; name: string; args: Record<string, string | number | boolean> }[];
};

export type TourReceipt = {
  schema: "paron-wif-tour-receipt/v1";
  step: number;
  key: string;
  title: string;
  chainId: number;
  mode: "deterministic-local-simulation";
  actions: TourActionRecord[];
  metrics: Record<string, string>;
  flywheel: { before: Record<string, string>; after: Record<string, string> };
  prevHash: Hex;
  hash: Hex;
};

const t = TOUR_ACTORS;
const ZERO_HASH = `0x${"0".repeat(64)}` as Hex;

const usd = (v: bigint) => `$${(Number(v) / 1e6).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const wif = (v: bigint) => `${(Number(v / 10n ** 14n) / 1e4).toLocaleString("en-US", { maximumFractionDigits: 2 })} $WIF`;

export const TOUR_STEPS: TourStepDef[] = [
  {
    n: 1,
    key: "provider-stake",
    title: "Provider stakes 100,000 $WIF for a 25% margin",
    summary:
      "Batam Prime H200 registers permissionlessly (no KYB, no verifier), stakes 100,000 $WIF to reach Tier-2 Prime and mints 200 CU of CU-BTM-H200-2611 locking 25% cash margin instead of the legacy 150% bond.",
    loop: "Loop 2 · Margin",
    focus: "provider",
    beats: [
      {
        id: "register",
        caption: "Register + stake 100,000 $WIF in The Paron Vault",
        actor: "prime",
        call: "registerProviderAndStakeWif(uri, 100000e18)",
        run: (ctx) => {
          const l = ctx.world.ledger;
          l.advance(10);
          l.mintWif(t.prime.address, 150_000n * WIF);
          l.mintUsdg(t.prime.address, 50_000n * 1_000_000n);
          l.registerProviderAndStakeWif(t.prime.address, `ipfs://paron-wif/providers/${t.prime.key}`, 100_000n * WIF);
          l.setAttestationSigner(t.prime.address, t.prime.teeAddress!);
          ctx.metrics.providerMarginBps = l.getRequiredMarginBps(t.prime.address);
        },
      },
      {
        id: "mint",
        caption: "Mint 200 CU of CU-BTM-H200-2611 at $2.24 with 25% margin",
        actor: "prime",
        call: "mintPrimarySeries(BTM, 200, 2.24)",
        run: (ctx) => {
          const l = ctx.world.ledger;
          const before = l.usdgBalance(t.prime.address);
          const { lotId } = l.mintPrimarySeries(t.prime.address, ctx.world.series.btm, 200n, 2_240_000n);
          ctx.vars.lotId = lotId;
          ctx.metrics.providerMarginUsdg = before - l.usdgBalance(t.prime.address);
        },
      },
    ],
    highlights: (ctx) => [
      { label: "Margin required", value: `${Number(ctx.metrics.providerMarginBps ?? 0n) / 100}% (Tier-2 Prime)` },
      { label: "USDG locked", value: usd(ctx.metrics.providerMarginUsdg ?? 0n) },
      { label: "Legacy 150% bond would lock", value: usd(200n * 2_240_000n * 15_000n / 10_000n) },
      { label: "Capital efficiency", value: "4.0x vs 0.67x" },
    ],
  },
  {
    n: 2,
    key: "agent-buy",
    title: "AI agent buys 50 CU and burns its fee in $WIF",
    summary:
      "The CFO Compute Agent stakes 20,000 $WIF, then lifts 50 CU from the order book in $WIF discount mode: 10 bps instead of 30 bps, and the fee's 50% burn leg is paid by permanently burning the agent's own $WIF.",
    loop: "Loop 1 · Burn",
    focus: "agent",
    beats: [
      {
        id: "stake",
        caption: "Agent stakes 20,000 $WIF (fee discount + priority lane)",
        actor: "agent",
        call: "stakeWifForMarginBoost(20000e18)",
        run: (ctx) => {
          ctx.world.ledger.advance(10);
          ctx.world.ledger.stakeWifForMarginBoost(t.agent.address, 20_000n * WIF);
        },
      },
      {
        id: "buy",
        caption: "Buy 50 CU at up to $2.30 with useWifDiscount = true",
        actor: "agent",
        call: "buySeriesOrPlaceBid(BTM, 50, 2.30, true)",
        run: (ctx) => {
          const l = ctx.world.ledger;
          const fees = l.flywheelStats().totalFeesUsdg;
          const burned = l.flywheelStats().totalWifBurned;
          const { filledCu } = l.buySeriesOrPlaceBid(t.agent.address, ctx.world.series.btm, 50n, 2_300_000n, true);
          ctx.metrics.agentFillCu = filledCu;
          ctx.metrics.agentFeeUsdg = l.flywheelStats().totalFeesUsdg - fees;
          ctx.metrics.agentFeeWifBurned = l.flywheelStats().totalWifBurned - burned;
        },
      },
    ],
    highlights: (ctx) => [
      { label: "Filled", value: `${ctx.metrics.agentFillCu ?? 0n} CU @ $2.24` },
      { label: "Fee (10 bps)", value: usd(ctx.metrics.agentFeeUsdg ?? 0n) },
      { label: "Standard fee would be", value: usd(((ctx.metrics.agentFeeUsdg ?? 0n) * 3n)) },
      { label: "$WIF burned from agent", value: wif(ctx.metrics.agentFeeWifBurned ?? 0n) },
    ],
  },
  {
    n: 3,
    key: "secondary-clob",
    title: "Secondary CLOB fill and hardware normalization",
    summary:
      "40 A100 hours (0.45x) normalize to 18 CU; 25 H200 hours (1.40x) to 35 CU. The market maker undercuts the primary ask at $2.23 and the A100 lab lifts it instantly, paying the standard 30 bps fee, whose burn leg the buyback desk converts into burned $WIF.",
    loop: "CLOB",
    focus: "clob",
    beats: [
      {
        id: "mm-ask",
        caption: "Market maker posts a secondary ask: 20 CU @ $2.23",
        actor: "marketMaker",
        call: "placeAsk(BTM, 20, 2.23)",
        run: (ctx) => {
          ctx.world.ledger.advance(10);
          ctx.world.ledger.placeAsk(t.marketMaker.address, ctx.world.series.btm, 20n, 2_230_000n);
        },
      },
      {
        id: "lab-buy",
        caption: "Lab normalizes 40 A100 h -> 18 CU and lifts the ask",
        actor: "lab",
        call: "buySeriesOrPlaceBid(BTM, 18, 2.23, false)",
        run: (ctx) => {
          const l = ctx.world.ledger;
          const cu = convertGpuHoursToCu("A100", 40n * WIF) / WIF;
          const fees = l.flywheelStats().totalFeesUsdg;
          const burned = l.flywheelStats().totalWifBurned;
          const { filledCu } = l.buySeriesOrPlaceBid(t.lab.address, ctx.world.series.btm, cu, 2_230_000n, false);
          ctx.metrics.labFillCu = filledCu;
          ctx.metrics.labFeeUsdg = l.flywheelStats().totalFeesUsdg - fees;
          ctx.metrics.labFeeWifBurned = l.flywheelStats().totalWifBurned - burned;
        },
      },
    ],
    highlights: (ctx) => [
      { label: "40 A100 hours", value: "= 18 CU (0.45x)" },
      { label: "25 H200 hours", value: "= 35 CU (1.40x)" },
      { label: "Secondary fill", value: `${ctx.metrics.labFillCu ?? 0n} CU @ $2.23` },
      { label: "Buyback burn", value: wif(ctx.metrics.labFeeWifBurned ?? 0n) },
    ],
  },
  {
    n: 4,
    key: "happy-delivery",
    title: "Happy-path compute delivery with a signed receipt",
    summary:
      "The agent redeems 25 CU. The provider acknowledges, provisions the H200 cluster and posts an execution receipt signed by its TEE attestation key (p95 142 ms, 99.97% uptime). The agent confirms; escrowed principal plus margin settle to the provider, which also claims its $WIF-staker fee rebates.",
    loop: "Mode B",
    focus: "delivery",
    beats: [
      {
        id: "request",
        caption: "Agent requests redemption of 25 CU",
        actor: "agent",
        call: "requestRedemption(BTM, 25, lot, sshKey)",
        run: (ctx) => {
          const l = ctx.world.ledger;
          l.advance(10);
          ctx.vars.r1 = l.requestRedemption(t.agent.address, ctx.world.series.btm, 25n, ctx.vars.lotId, keccak256(toHex("agent-ssh-pubkey")) as Hex);
        },
      },
      {
        id: "ack",
        caption: "Provider acknowledges and provisions 17.86 H200 hours",
        actor: "prime",
        call: "acknowledgeRedemption(r1)",
        run: (ctx) => ctx.world.ledger.acknowledgeRedemption(t.prime.address, ctx.vars.r1),
      },
      {
        id: "deliver",
        caption: "Signed execution receipt: p95 142 ms, 99.97% uptime",
        actor: "prime",
        call: "deliverWithReceipt(r1, receipt, 142, 9997, teeSig)",
        run: (ctx) => {
          deliverSigned(ctx.world.ledger, t.prime, ctx.vars.r1, "job-log: 25 CU, p95 142ms", 142, 9_997);
        },
      },
      {
        id: "confirm",
        caption: "Agent confirms: escrow + margin settle to the provider",
        actor: "agent",
        call: "confirmDelivery(r1)",
        run: (ctx) => {
          const l = ctx.world.ledger;
          l.confirmDelivery(t.agent.address, ctx.vars.r1);
          ctx.metrics.happyPathProviderRelease = l.providerClaimable(t.prime.address);
        },
      },
      {
        id: "rebate",
        caption: "Provider claims its 20% fee-rebate share as a $WIF staker",
        actor: "prime",
        call: "claimProviderRebate()",
        run: (ctx) => {
          ctx.metrics.providerRebateClaimed = ctx.world.ledger.claimProviderRebate(t.prime.address);
        },
      },
    ],
    highlights: (ctx) => [
      { label: "Delivered", value: "25 CU = 17.86 H200 hours" },
      { label: "Released to provider", value: usd(ctx.metrics.happyPathProviderRelease ?? 0n) },
      { label: "Staker rebate claimed", value: usd(ctx.metrics.providerRebateClaimed ?? 0n) },
      { label: "Receipt", value: "EIP-191 signed by TEE key" },
    ],
  },
  {
    n: 5,
    key: "sla-jury",
    title: "SLA breach, $WIF burn-to-vote jury, slash and voter upside",
    summary:
      "The second 25 CU batch arrives degraded (p95 612 ms vs a 250 ms SLA). The agent's monitor files a dispute (burning 100 $WIF), jurors burn 5,000 $WIF to vote SLASH, the provider burns 1,000 to vote UPHOLD. SLASH wins: the agent gets 100% principal + 15% compensation, 25% of the remaining margin buys back and burns $WIF, and winning voters claim real USDG plus bonus $WIF.",
    loop: "Loop 3 · Jury",
    focus: "jury",
    beats: [
      {
        id: "request",
        caption: "Agent redeems the second 25 CU batch",
        actor: "agent",
        call: "requestRedemption(BTM, 25, lot, sshKey)",
        run: (ctx) => {
          const l = ctx.world.ledger;
          l.advance(10);
          ctx.vars.r2 = l.requestRedemption(t.agent.address, ctx.world.series.btm, 25n, ctx.vars.lotId, keccak256(toHex("agent-ssh-pubkey")) as Hex);
          l.acknowledgeRedemption(t.prime.address, ctx.vars.r2);
        },
      },
      {
        id: "breach",
        caption: "Degraded delivery: p95 612 ms, 97.80% uptime (SLA breach)",
        actor: "prime",
        call: "deliverWithReceipt(r2, receipt, 612, 9780, teeSig)",
        run: (ctx) => {
          deliverSigned(ctx.world.ledger, t.prime, ctx.vars.r2, "job-log: 25 CU, p95 612ms, 97.8% uptime", 612, 9_780);
        },
      },
      {
        id: "dispute",
        caption: "Agent files an SLA dispute with its probe log (burns 100 $WIF)",
        actor: "agent",
        call: "openSlaDispute(r2, evidenceHash, reason)",
        run: (ctx) => {
          ctx.vars.disputeId = ctx.world.ledger.openSlaDispute(
            t.agent.address,
            ctx.vars.r2,
            keccak256(toHex("agent-probe-log.json")) as Hex,
            "p95 612ms > 250ms SLA",
          );
        },
      },
      {
        id: "votes",
        caption: "Jurors burn 5,000 $WIF for SLASH; provider burns 1,000 for UPHOLD",
        actor: "jurorA",
        call: "voteOnDisputeWithWifBurn(d, slash, amount) x4",
        run: (ctx) => {
          const l = ctx.world.ledger;
          const d = ctx.vars.disputeId;
          l.voteOnDisputeWithWifBurn(t.jurorA.address, d, true, 2_500n * WIF);
          l.voteOnDisputeWithWifBurn(t.jurorB.address, d, true, 1_500n * WIF);
          l.voteOnDisputeWithWifBurn(t.jurorC.address, d, true, 1_000n * WIF);
          l.voteOnDisputeWithWifBurn(t.prime.address, d, false, 1_000n * WIF);
        },
      },
      {
        id: "resolve",
        caption: "15-minute round ends: SLASH wins, waterfall executes",
        actor: "protocol",
        call: "resolveDispute(d)",
        run: (ctx) => {
          const l = ctx.world.ledger;
          l.advance(DEFAULT_PARAMS.votingPeriod);
          const agentBefore = l.usdgBalance(t.agent.address);
          const burnedBefore = l.flywheelStats().totalWifBurned;
          l.resolveDispute(t.jurorA.address, ctx.vars.disputeId);
          const d = l.getDispute(ctx.vars.disputeId)!;
          ctx.metrics.slashVotes = d.slashVotes;
          ctx.metrics.upholdVotes = d.upholdVotes;
          ctx.metrics.agentSlashRefund = l.usdgBalance(t.agent.address) - agentBefore;
          ctx.metrics.slashBurnWif = l.flywheelStats().totalWifBurned - burnedBefore;
          ctx.metrics.disputeRewardPoolUsdg = d.rewardPoolUsdg;
          ctx.metrics.disputeRewardPoolWif = d.rewardPoolWif;
          ctx.metrics.juryPoolAfter = l.flywheelStats().juryRewardPoolUsdg;
          const slashEvent = l.events({ name: "ProviderSlashed" }).at(-1);
          ctx.metrics.voterShareUsdg = BigInt(slashEvent?.args.voterShare ?? 0n);
        },
      },
      {
        id: "claims",
        caption: "Winning voters claim USDG upside + bonus $WIF",
        actor: "jurorA",
        call: "claimVoterUpside(d) x4",
        run: (ctx) => {
          const l = ctx.world.ledger;
          const d = ctx.vars.disputeId;
          for (const [key, who] of [["jurorA", t.jurorA], ["jurorB", t.jurorB], ["jurorC", t.jurorC], ["agentJuror", t.agent]] as const) {
            const { usdgOut, wifOut } = l.claimVoterUpside(who.address, d);
            ctx.metrics[`${key}Usdg`] = usdgOut;
            ctx.metrics[`${key}Wif`] = wifOut;
          }
        },
      },
    ],
    highlights: (ctx) => [
      { label: "Votes (burned)", value: `${wif(ctx.metrics.slashVotes ?? 0n)} SLASH / ${wif(ctx.metrics.upholdVotes ?? 0n)} UPHOLD` },
      { label: "Agent refund", value: `${usd(ctx.metrics.agentSlashRefund ?? 0n)} (100% + 15%)` },
      { label: "Juror Alpha burned 2,500 $WIF, received", value: `${usd(ctx.metrics.jurorAUsdg ?? 0n)} + ${wif(ctx.metrics.jurorAWif ?? 0n)}` },
      { label: "Slash buyback burn", value: wif(ctx.metrics.slashBurnWif ?? 0n) },
    ],
  },
  {
    n: 6,
    key: "corridor-election",
    title: "Corridor election: burn $WIF to steer the next Vault boost",
    summary:
      "Jurors and the agent burn 6,500 $WIF for the Batam-Singapore H200 corridor; the market maker burns 2,500 for Jakarta. When the weekly epoch closes, anyone finalizes it and Batam-Singapore H200 providers mint at 22.5% margin instead of 25% for the next epoch.",
    loop: "Loop 3 · Election",
    focus: "corridor",
    beats: [
      {
        id: "votes",
        caption: "6,500 $WIF burned for Batam-Singapore H200, 2,500 for Jakarta",
        actor: "jurorA",
        call: "voteForComputeCorridor(corridor, amount) x4",
        run: (ctx) => {
          const l = ctx.world.ledger;
          l.voteForComputeCorridor(t.jurorA.address, 1, 3_000n * WIF);
          l.voteForComputeCorridor(t.jurorB.address, 1, 2_000n * WIF);
          l.voteForComputeCorridor(t.agent.address, 1, 1_500n * WIF);
          l.voteForComputeCorridor(t.marketMaker.address, 0, 2_500n * WIF);
          const tally = l.corridorTally(0);
          ctx.metrics.corridorBtmVotes = tally[1];
          ctx.metrics.corridorJktVotes = tally[0];
        },
      },
      {
        id: "finalize",
        caption: "Epoch closes: Batam-Singapore H200 elected, margin 25% -> 22.5%",
        actor: "protocol",
        call: "finalizeCorridorEpoch(0)",
        run: (ctx) => {
          const l = ctx.world.ledger;
          l.setTime(l.epochEndsAt(0));
          ctx.metrics.electedCorridor = BigInt(l.finalizeCorridorEpoch(t.jurorA.address, 0));
          ctx.metrics.boostedMarginBps = l.requiredMarginBpsFor(t.prime.address, ctx.world.series.btm);
          ctx.metrics.totalWifStaked = l.flywheelStats().totalWifStaked;
          ctx.metrics.totalWifBurned = l.flywheelStats().totalWifBurned;
        },
      },
    ],
    highlights: (ctx) => [
      { label: "Batam-Singapore H200", value: wif(ctx.metrics.corridorBtmVotes ?? 0n) },
      { label: "Jakarta H100", value: wif(ctx.metrics.corridorJktVotes ?? 0n) },
      { label: "Boosted margin", value: `${Number(ctx.metrics.boostedMarginBps ?? 2500n) / 100}%` },
      { label: "Total $WIF burned in the tour", value: wif(ctx.metrics.totalWifBurned ?? 0n) },
    ],
  },
];

export function createTourContext(): TourContext {
  return { world: createTourWorld(), vars: {}, metrics: {}, receipts: [] };
}

function stringifyArgs(args: ParonEvent["args"]): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(args)) out[k] = typeof v === "bigint" ? v.toString() : v;
  return out;
}

function flywheelRecord(l: ParonLedger): Record<string, string> {
  const s = l.flywheelStats();
  return Object.fromEntries(Object.entries(s).map(([k, v]) => [k, String(v)]));
}

/** Executes one beat and returns the events it produced. */
export function runTourBeat(ctx: TourContext, beat: TourBeat): TourActionRecord {
  const l = ctx.world.ledger;
  const from = l.events().length;
  beat.run(ctx);
  const events = l.events().slice(from);
  return {
    beat: beat.id,
    caption: beat.caption,
    actor: beat.actor === "protocol" ? "protocol (permissionless)" : TOUR_ACTORS[beat.actor].name,
    call: beat.call,
    timestamp: new Date(Number(l.now) * 1000).toISOString(),
    events: events.map((e) => ({ contract: e.contract, name: e.name, args: stringifyArgs(e.args) })),
  };
}

/** Seals a step into a hash-chained JSON audit receipt. */
export function sealReceipt(ctx: TourContext, step: TourStepDef, actions: TourActionRecord[], before: Record<string, string>): TourReceipt {
  const prevHash = ctx.receipts.at(-1)?.hash ?? ZERO_HASH;
  const metrics = Object.fromEntries(Object.entries(ctx.metrics).map(([k, v]) => [k, v.toString()]));
  const body = {
    schema: "paron-wif-tour-receipt/v1" as const,
    step: step.n,
    key: step.key,
    title: step.title,
    chainId: ctx.world.ledger.params.chainId,
    mode: "deterministic-local-simulation" as const,
    actions,
    metrics,
    flywheel: { before, after: flywheelRecord(ctx.world.ledger) },
    prevHash,
  };
  const hash = keccak256(toHex(JSON.stringify(body))) as Hex;
  const receipt: TourReceipt = { ...body, hash };
  ctx.receipts.push(receipt);
  return receipt;
}

export function runTourStep(ctx: TourContext, n: number): TourReceipt {
  const step = TOUR_STEPS[n - 1];
  const before = flywheelRecord(ctx.world.ledger);
  const actions = step.beats.map((beat) => runTourBeat(ctx, beat));
  return sealReceipt(ctx, step, actions, before);
}

export function runFullTour(): TourContext {
  const ctx = createTourContext();
  for (const step of TOUR_STEPS) runTourStep(ctx, step.n);
  return ctx;
}

/** Recomputes the hash chain; returns the index of the first tampered receipt or -1. */
export function verifyReceiptChain(receipts: TourReceipt[]): number {
  let prev = ZERO_HASH;
  for (let i = 0; i < receipts.length; i += 1) {
    const { hash, ...body } = receipts[i];
    if (body.prevHash !== prev) return i;
    if (keccak256(toHex(JSON.stringify(body))) !== hash) return i;
    prev = hash;
  }
  return -1;
}
