import { test } from "node:test";
import assert from "node:assert/strict";
import { USDG, WIF } from "../src/constants.ts";
import {
  CfoComputeAgent,
  DEFAULT_AGENT_POLICY,
  InferenceLoadModel,
  LedgerAgentBackend,
  decideActions,
  emptyMemory,
  probeDelivery,
  type AgentObservation,
} from "../src/cfoComputeAgent.ts";
import { GENESIS_ACTORS, createGenesisWorld, createTourWorld, deliverSigned, TOUR_ACTORS } from "../src/seed.ts";
import { snapshotFromLedger } from "../src/snapshot.ts";

test("genesis world is a living market built purely from protocol operations", () => {
  const w = createGenesisWorld();
  const s = snapshotFromLedger(w.ledger, { account: GENESIS_ACTORS.judge.address });
  assert.equal(s.flywheel.totalWifStaked, 4_850_000n * WIF, "4.85M $WIF staked in margin vaults");
  assert.ok(s.flywheel.totalWifBurned > 1_400_000n * WIF, `burned ${s.flywheel.totalWifBurned / WIF}`);
  assert.ok(s.flywheel.juryRewardPoolUsdg > 15_000n * USDG);
  assert.ok(s.flywheel.openInterestCu > 11_000n, `OI ${s.flywheel.openInterestCu}`);
  for (const series of s.series) {
    assert.ok(series.bids.length >= 3 && series.asks.length >= 2, `${series.symbol} has two-sided depth`);
    assert.ok(series.market.bestBid < series.market.bestAsk, `${series.symbol} book is not crossed`);
  }
  assert.equal(s.epoch.current, 1);
  assert.deepEqual(s.epoch.boosted, { active: true, corridorId: 1 }, "Batam-Singapore H200 won epoch 0");
  assert.equal(s.disputes[0].status, "ResolvedSlash");
  assert.equal(w.ledger.wifTotalBurned(), s.flywheel.totalWifBurned);
});

test("load model is deterministic and forecasts H100-equivalent hours", () => {
  const a = new InferenceLoadModel(7);
  const b = new InferenceLoadModel(7);
  assert.deepEqual(a.sample(1_793_870_000), b.sample(1_793_870_000));
  assert.ok(a.forecastCu(1_793_870_000, 6) > 0);
});

test("decideActions stakes, buys the cheapest series in discount mode and disputes SLA breaches", () => {
  const obs: AgentObservation = {
    address: "0x0000000000000000000000000000000000000a11",
    now: 1_793_900_000n,
    wif: 50_000n * WIF,
    usdg: 5_000n * USDG,
    stakedWif: 0n,
    wifDiscount: true,
    criH100Usdg: 2_200_000n,
    criUpdatedAt: 1_793_890_000n,
    series: [
      { id: 1, symbol: "CU-JKT-H100-2611", gpuTier: "H100", deliveryStart: 1_793_491_200n, deliveryEnd: 1_796_083_200n, bestAsk: 2_250_000n, askQtyAtBest: 500n, bestBid: 2_150_000n },
      { id: 2, symbol: "CU-BTM-H200-2611", gpuTier: "H200", deliveryStart: 1_793_491_200n, deliveryEnd: 1_796_083_200n, bestAsk: 2_210_000n, askQtyAtBest: 40n, bestBid: 2_190_000n },
    ],
    holdings: { 1: 0n, 2: 0n },
    redemptions: [
      { id: 9, seriesId: 2, cuAmount: 25n, state: "Delivered", p95LatencyMs: 612, uptimeBps: 9_780, challengeDeadline: 1_793_910_000n, receiptHash: "0x12" },
    ],
    pendingUpside: [],
  };
  const sample = new InferenceLoadModel().sample(Number(obs.now));
  const actions = decideActions(obs, sample, 300, DEFAULT_AGENT_POLICY, emptyMemory());
  const kinds = actions.map((a) => a.kind);
  assert.ok(kinds.includes("STAKE_WIF"));
  assert.ok(kinds.includes("OPEN_SLA_DISPUTE"));
  const buy = actions.find((a) => a.kind === "BUY_CU");
  assert.ok(buy && buy.kind === "BUY_CU");
  assert.equal(buy.seriesId, 2, "cheapest H100-equivalent hour");
  assert.equal(buy.cu, 40n, "capped at the depth at the best ask");
  assert.equal(buy.useWifDiscount, true);
  assert.ok(probeDelivery(obs.redemptions[0]).measuredP95Ms > 250);
});

test("autonomous agent runs end-to-end on the deterministic ledger", async () => {
  const w = createTourWorld();
  const l = w.ledger;
  // Give the agent a provider to buy from and a breaching delivery to police.
  l.mintWif(TOUR_ACTORS.prime.address, 150_000n * WIF);
  l.mintUsdg(TOUR_ACTORS.prime.address, 50_000n * USDG);
  l.registerProviderAndStakeWif(TOUR_ACTORS.prime.address, "ipfs://prime", 100_000n * WIF);
  l.setAttestationSigner(TOUR_ACTORS.prime.address, TOUR_ACTORS.prime.teeAddress!);
  const { lotId } = l.mintPrimarySeries(TOUR_ACTORS.prime.address, w.series.btm, 400n, 2_240_000n);

  const agent = new CfoComputeAgent(new LedgerAgentBackend(l, TOUR_ACTORS.agent.address), { ...DEFAULT_AGENT_POLICY, maxOrderCu: 80n });
  const first = await agent.tick();
  assert.ok(first.results.some((r) => r.action.kind === "STAKE_WIF" && r.result.ok));
  const bought = first.results.find((r) => r.action.kind === "BUY_CU");
  assert.ok(bought?.result.ok, "agent bought CU");
  assert.ok(l.cuBalance(TOUR_ACTORS.agent.address, w.series.btm) > 0n);
  assert.ok(l.events({ name: "WifFlywheelBurned" }).some((e) => e.args.reason === "TRADE_FEE_WIF" && e.args.actor === TOUR_ACTORS.agent.address));

  const rid = l.requestRedemption(TOUR_ACTORS.agent.address, w.series.btm, 25n, lotId, "0x01");
  l.acknowledgeRedemption(TOUR_ACTORS.prime.address, rid);
  deliverSigned(l, TOUR_ACTORS.prime, rid, "degraded", 640, 9_700);
  l.advance(60);
  const second = await agent.tick();
  const dispute = second.results.find((r) => r.action.kind === "OPEN_SLA_DISPUTE");
  assert.ok(dispute?.result.ok, "agent filed the SLA dispute itself");
  assert.equal(l.getRedemption(rid)!.state, "Disputed");
  assert.ok(second.log.some((e) => e.kind === "observe"));
});
