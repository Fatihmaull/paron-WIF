/**
 * Deterministic worlds for the zero-wallet experience.
 *
 *  - createProtocolWorld(): the deployment of contracts/script/DeployParonWif.s.sol (corridors, canonical
 *    series, buyback reserve, juror pools, CRI attestation), without seeded liquidity.
 *  - createTourWorld(): exactly the fixture of contracts/test/ParonWifTour.t.sol, so the coded tour
 *    reproduces the on-chain golden numbers.
 *  - createGenesisWorld(): a living market for the sandbox: several providers at different $WIF tiers,
 *    market-maker depth on every series, agent activity, a resolved SLA dispute and corridor elections.
 *
 * Demo keys are derived from labels at runtime and only ever sign inside the local simulation.
 */
import { keccak256, toHex } from "viem";
import { privateKeyToAddress } from "viem/accounts";
import { CORRIDORS, DEFAULT_PARAMS, SIM_GENESIS_TIME, USDG, WIF, type WorldParams } from "./constants.ts";
import { ParonLedger, labelAddress, signDigest } from "./engine/ledger.ts";
import type { Address, Hex } from "./types.ts";

export type ActorRole = "provider" | "market-maker" | "agent" | "juror" | "lab" | "judge" | "sponsor";

export type Actor = {
  key: string;
  name: string;
  role: ActorRole;
  address: Address;
  description: string;
  teeKey?: Hex;
  teeAddress?: Address;
};

export function demoKey(label: string): Hex {
  return keccak256(toHex(`paron-wif-demo-key:${label}`)) as Hex;
}

export function makeActor(key: string, name: string, role: ActorRole, description: string, withTee = false): Actor {
  const actor: Actor = { key, name, role, address: labelAddress(`actor:${key}`), description };
  if (withTee) {
    actor.teeKey = demoKey(`${key}:tee`);
    actor.teeAddress = privateKeyToAddress(actor.teeKey).toLowerCase() as Address;
  }
  return actor;
}

export type World = {
  ledger: ParonLedger;
  actors: Record<string, Actor>;
  series: { jkt: number; btm: number; sgp: number };
  name: string;
};

/** Canonical deployment, mirroring DeployParonWif.s.sol / ParonWifBase.setUp. */
export function createProtocolWorld(opts: { genesisTime?: bigint; params?: Partial<WorldParams>; sponsorJuryPool?: bigint } = {}): World {
  const ledger = new ParonLedger({ genesisTime: opts.genesisTime ?? SIM_GENESIS_TIME, params: opts.params });
  const a = ledger.addr;
  for (const c of CORRIDORS) ledger.registerCorridor(c.code, c.name);
  const jkt = ledger.createSeries(a.deployer, 0, "H100", 2611);
  const btm = ledger.createSeries(a.deployer, 1, "H200", 2611);
  const sgp = ledger.createSeries(a.deployer, 3, "B200", 2612);
  ledger.mintWif(a.treasury, 5_000_000n * WIF);
  ledger.mintUsdg(a.treasury, 100_000n * USDG);
  ledger.fundBuybackReserve(a.treasury, 2_000_000n * WIF);
  ledger.fundJuryBonusWif(a.treasury, 250_000n * WIF);
  ledger.fundJuryRewardPool(a.treasury, opts.sponsorJuryPool ?? 100n * USDG);
  ledger.attestReferenceIndex(a.attestor, DEFAULT_PARAMS.criH100Usdg, keccak256(toHex("CRI-H100 genesis basket")) as Hex);
  return { ledger, actors: {}, series: { jkt, btm, sgp }, name: "protocol" };
}

function fund(ledger: ParonLedger, actor: Actor, wif: bigint, usdg: bigint): void {
  if (wif > 0n) ledger.mintWif(actor.address, wif);
  if (usdg > 0n) ledger.mintUsdg(actor.address, usdg);
}

/** _provider() in ParonWifBase: stake + 50,000 $WIF float, 50,000 USDG, register with the stake. */
function provider(ledger: ParonLedger, actor: Actor, stake: bigint): Actor {
  fund(ledger, actor, stake + 50_000n * WIF, 50_000n * USDG);
  ledger.registerProviderAndStakeWif(actor.address, `ipfs://paron-wif/providers/${actor.key}`, stake);
  if (actor.teeAddress) ledger.setAttestationSigner(actor.address, actor.teeAddress);
  return actor;
}

export const TOUR_ACTORS = {
  genesisProvider: makeActor("batam-riau-gpu-park", "Batam Riau GPU Park", "provider", "Tier-1 H200 provider (30k $WIF staked) seeding the first CU-BTM-H200 lot"),
  marketMaker: makeActor("flatline-market-maker", "Flatline Market Maker", "market-maker", "Quotes two-sided depth on every canonical series"),
  prime: makeActor("batam-prime-h200", "Batam Prime H200", "provider", "Flat-World Prime provider: 100k $WIF staked for 25% margin", true),
  agent: makeActor("cfo-compute-agent", "CFO Compute Agent", "agent", "Autonomous $WIF agent procuring and hedging inference compute"),
  lab: makeActor("inference-lab-a100", "Inference Lab (A100 fleet)", "lab", "Normalizes A100 workloads into canonical CU"),
  jurorA: makeActor("juror-alpha", "Juror Alpha", "juror", "Community $WIF holder"),
  jurorB: makeActor("juror-beta", "Juror Beta", "juror", "Community $WIF holder"),
  jurorC: makeActor("juror-gamma", "Juror Gamma", "juror", "Community $WIF holder"),
} as const;

/** The fixture of contracts/test/ParonWifTour.t.sol: protocol + seeded BTM book. */
export function createTourWorld(): World {
  const world = createProtocolWorld();
  const { ledger } = world;
  const t = TOUR_ACTORS;
  provider(ledger, t.genesisProvider, 30_000n * WIF);
  fund(ledger, t.marketMaker, 20_000n * WIF, 50_000n * USDG);
  fund(ledger, t.lab, 0n, 1_000n * USDG);
  fund(ledger, t.agent, 120_000n * WIF, 10_000n * USDG);
  fund(ledger, t.jurorA, 10_000n * WIF, 0n);
  fund(ledger, t.jurorB, 10_000n * WIF, 0n);
  fund(ledger, t.jurorC, 5_000n * WIF, 0n);

  const btm = world.series.btm;
  ledger.mintPrimarySeries(t.genesisProvider.address, btm, 40n, 2_200_000n);
  ledger.buySeriesOrPlaceBid(t.marketMaker.address, btm, 40n, 2_200_000n, false);
  ledger.buySeriesOrPlaceBid(t.marketMaker.address, btm, 40n, 2_150_000n, false);
  ledger.buySeriesOrPlaceBid(t.marketMaker.address, btm, 60n, 2_120_000n, false);
  world.actors = { ...t };
  world.name = "tour";
  return world;
}

export const GENESIS_ACTORS = {
  judge: makeActor("you", "You (judge sandbox wallet)", "judge", "Your local wallet. Mint test $WIF + USDG from the faucet."),
  nusantara: makeActor("nusantara-compute", "Nusantara Compute", "provider", "Jakarta H100 operator, Flat-World Prime (1.25M $WIF staked)", true),
  batam: makeActor("batam-riau-gpu-park", "Batam Riau GPU Park", "provider", "Batam-Singapore H200 campus, Prime tier", true),
  lionCity: makeActor("lion-city-ai-cloud", "Lion City AI Cloud", "provider", "Singapore B200 forward capacity, Tier 1", true),
  johor: makeActor("johor-green-dc", "Johor Green DC", "provider", "Renewable-powered Johor site, Tier 0 (no stake yet)", true),
  flatline: makeActor("flatline-market-maker", "Flatline Market Maker", "market-maker", "Two-sided quotes on every series, 2.5M $WIF staked for priority lane"),
  cfoAgent: makeActor("cfo-compute-agent", "CFO Compute Agent", "agent", "Autonomous inference-capacity buyer and hedger"),
  routerAgent: makeActor("inference-router-agent", "Inference Router Agent", "agent", "Routes LLM traffic to the cheapest H100-equivalent hours"),
  lab: makeActor("inference-lab-a100", "Inference Lab (A100 fleet)", "lab", "Legacy A100 workloads normalized into CU"),
  jurorA: makeActor("juror-alpha", "Juror Alpha", "juror", "Community $WIF holder"),
  jurorB: makeActor("juror-beta", "Juror Beta", "juror", "Community $WIF holder"),
  jurorC: makeActor("juror-gamma", "Juror Gamma", "juror", "Community $WIF holder"),
  community: makeActor("flat-world-community", "Flat-World Community", "juror", "Aggregated community corridor voters"),
} as const;

/** 2026-10-29T00:00Z: genesis of the sandbox, one corridor epoch before the judging window. */
export const SANDBOX_GENESIS_TIME = SIM_GENESIS_TIME - 7n * 86_400n;

/**
 * The sandbox market, built purely from protocol operations so every counter is real:
 * ~4.85M $WIF staked, ~1.4M $WIF burned, an ~$18k juror upside pool and ~12k CU open interest.
 */
export function createGenesisWorld(): World {
  const world = createProtocolWorld({ genesisTime: SANDBOX_GENESIS_TIME, sponsorJuryPool: 18_000n * USDG });
  const { ledger, series } = world;
  const g = GENESIS_ACTORS;
  const hour = 3_600;

  provider(ledger, g.nusantara, 1_250_000n * WIF);
  provider(ledger, g.batam, 900_000n * WIF);
  provider(ledger, g.lionCity, 60_000n * WIF);
  provider(ledger, g.johor, 0n);
  fund(ledger, g.flatline, 3_200_000n * WIF, 120_000n * USDG);
  ledger.stakeWifForMarginBoost(g.flatline.address, 2_500_000n * WIF);
  fund(ledger, g.cfoAgent, 160_000n * WIF, 30_000n * USDG);
  ledger.stakeWifForMarginBoost(g.cfoAgent.address, 20_000n * WIF);
  fund(ledger, g.routerAgent, 260_000n * WIF, 25_000n * USDG);
  ledger.stakeWifForMarginBoost(g.routerAgent.address, 120_000n * WIF);
  fund(ledger, g.lab, 0n, 5_000n * USDG);
  fund(ledger, g.jurorA, 150_000n * WIF, 500n * USDG);
  fund(ledger, g.jurorB, 120_000n * WIF, 500n * USDG);
  fund(ledger, g.jurorC, 90_000n * WIF, 500n * USDG);
  fund(ledger, g.community, 1_400_000n * WIF, 0n);

  // ---- Epoch 0 (Oct 29 - Nov 5): issuance and the forward market ----
  ledger.advance(2 * hour);
  ledger.mintPrimarySeries(g.nusantara.address, series.jkt, 6_000n, 2_180_000n);
  ledger.mintPrimarySeries(g.nusantara.address, series.jkt, 4_000n, 2_210_000n);
  ledger.mintPrimarySeries(g.batam.address, series.btm, 5_000n, 2_240_000n);
  ledger.mintPrimarySeries(g.batam.address, series.btm, 3_000n, 2_270_000n);
  ledger.mintPrimarySeries(g.lionCity.address, series.sgp, 4_000n, 2_310_000n);
  ledger.mintPrimarySeries(g.lionCity.address, series.sgp, 2_500n, 2_350_000n);
  ledger.mintPrimarySeries(g.johor.address, series.jkt, 800n, 2_250_000n);

  ledger.advance(6 * hour);
  ledger.buySeriesOrPlaceBid(g.flatline.address, series.jkt, 2_900n, 2_180_000n, true);
  ledger.buySeriesOrPlaceBid(g.flatline.address, series.btm, 2_800n, 2_240_000n, true);
  ledger.buySeriesOrPlaceBid(g.flatline.address, series.sgp, 2_400n, 2_310_000n, true);
  ledger.advance(12 * hour);
  ledger.buySeriesOrPlaceBid(g.routerAgent.address, series.jkt, 2_400n, 2_180_000n, true);
  ledger.buySeriesOrPlaceBid(g.routerAgent.address, series.btm, 1_300n, 2_240_000n, true);
  ledger.buySeriesOrPlaceBid(g.cfoAgent.address, series.btm, 150n, 2_240_000n, true);
  ledger.buySeriesOrPlaceBid(g.lab.address, series.jkt, 180n, 2_210_000n, false);

  // Corridor election, epoch 0
  ledger.advance(24 * hour);
  ledger.voteForComputeCorridor(g.community.address, 1, 420_000n * WIF);
  ledger.voteForComputeCorridor(g.community.address, 0, 310_000n * WIF);
  ledger.voteForComputeCorridor(g.community.address, 3, 160_000n * WIF);
  ledger.voteForComputeCorridor(g.community.address, 2, 70_000n * WIF);
  ledger.voteForComputeCorridor(g.jurorA.address, 1, 60_000n * WIF);
  ledger.voteForComputeCorridor(g.jurorB.address, 1, 40_000n * WIF);

  // Secondary quotes from the market maker (asks above primary, bids below)
  ledger.advance(12 * hour);
  ledger.placeAsk(g.flatline.address, series.jkt, 600n, 2_230_000n);
  ledger.placeAsk(g.flatline.address, series.btm, 500n, 2_290_000n);
  ledger.placeAsk(g.flatline.address, series.sgp, 300n, 2_380_000n);
  for (const [sid, prices] of [
    [series.jkt, [2_160_000n, 2_140_000n, 2_110_000n, 2_080_000n]],
    [series.btm, [2_210_000n, 2_190_000n, 2_160_000n, 2_120_000n]],
    [series.sgp, [2_280_000n, 2_250_000n, 2_220_000n]],
  ] as const) {
    let size = 420n;
    for (const p of prices) {
      ledger.buySeriesOrPlaceBid(g.flatline.address, sid, size, p, true);
      size += 180n;
    }
  }
  ledger.buySeriesOrPlaceBid(g.routerAgent.address, series.btm, 350n, 2_200_000n, true);
  ledger.buySeriesOrPlaceBid(g.lab.address, series.jkt, 120n, 2_150_000n, false);

  // ---- Nov 1+: delivery month opens; a historical delivery, a breach and a jury slash ----
  ledger.setTime(SIM_GENESIS_TIME - 3n * 86_400n);
  const happy = ledger.requestRedemption(g.cfoAgent.address, series.btm, 120n, 0, keccak256(toHex("cfo-agent:ssh")) as Hex);
  ledger.acknowledgeRedemption(g.batam.address, happy);
  ledger.advance(hour);
  deliverSigned(ledger, g.batam, happy, "batam: 120 CU llama-405b fine-tune, p95 131ms", 131, 9_996);
  ledger.confirmDelivery(g.cfoAgent.address, happy);

  ledger.advance(2 * hour);
  const nominal = ledger.requestRedemption(g.routerAgent.address, series.jkt, 400n, 0, keccak256(toHex("router:ssh")) as Hex);
  ledger.acknowledgeRedemption(g.nusantara.address, nominal);
  ledger.advance(hour);
  deliverSigned(ledger, g.nusantara, nominal, "nusantara: 400 CU qwen-72b serving, p95 147ms", 147, 9_993);
  ledger.confirmDelivery(g.routerAgent.address, nominal);

  ledger.advance(4 * hour);
  const breach = ledger.requestRedemption(g.routerAgent.address, series.jkt, 300n, 0, keccak256(toHex("router:ssh")) as Hex);
  ledger.acknowledgeRedemption(g.nusantara.address, breach);
  ledger.advance(2 * hour);
  deliverSigned(ledger, g.nusantara, breach, "nusantara: 300 CU, fabric degraded, p95 840ms", 840, 9_610);
  const did = ledger.openSlaDispute(g.routerAgent.address, breach, keccak256(toHex("router-probe-log-2026-11-02.json")) as Hex, "p95 840ms vs 250ms SLA; 96.1% uptime");
  ledger.voteOnDisputeWithWifBurn(g.jurorA.address, did, true, 32_000n * WIF);
  ledger.voteOnDisputeWithWifBurn(g.jurorB.address, did, true, 21_000n * WIF);
  ledger.voteOnDisputeWithWifBurn(g.jurorC.address, did, true, 9_500n * WIF);
  ledger.voteOnDisputeWithWifBurn(g.nusantara.address, did, false, 12_000n * WIF);
  ledger.advance(ledger.params.votingPeriod);
  ledger.resolveDispute(g.jurorA.address, did);
  ledger.claimVoterUpside(g.jurorA.address, did);
  ledger.claimVoterUpside(g.jurorB.address, did);

  // Mode A: the router agent hedged part of its JKT book at the index
  ledger.advance(3 * hour);
  ledger.attestReferenceIndex(ledger.addr.attestor, 2_260_000n, keccak256(toHex("CRI-H100 2026-11-02 basket")) as Hex);
  ledger.settleCashAtIndex(g.routerAgent.address, series.jkt, 200n);

  // ---- Epoch 1 starts Nov 5: epoch 0 finalized (Batam-Singapore H200 boosted), new votes underway ----
  ledger.setTime(SIM_GENESIS_TIME + 2n * BigInt(hour));
  ledger.finalizeCorridorEpoch(g.jurorC.address, 0);
  ledger.attestReferenceIndex(ledger.addr.attestor, 2_220_000n, keccak256(toHex("CRI-H100 2026-11-05 basket")) as Hex);
  ledger.voteForComputeCorridor(g.community.address, 0, 118_000n * WIF);
  ledger.voteForComputeCorridor(g.community.address, 1, 92_000n * WIF);
  ledger.voteForComputeCorridor(g.community.address, 3, 61_000n * WIF);
  ledger.voteForComputeCorridor(g.community.address, 2, 24_000n * WIF);
  ledger.advance(hour);
  ledger.buySeriesOrPlaceBid(g.cfoAgent.address, series.jkt, 30n, 2_190_000n, true);
  ledger.advance(6 * hour);

  world.actors = { ...g };
  world.name = "genesis";
  return world;
}

/** Provider-side helper: post a delivery receipt signed by the provider's TEE attestation key. */
export function deliverSigned(ledger: ParonLedger, providerActor: Actor, redemptionId: number, log: string, p95: number, uptimeBps: number): Hex {
  const receipt = keccak256(toHex(log)) as Hex;
  const digest = ledger.deliveryReceiptDigest(redemptionId, receipt, p95, uptimeBps);
  const sig = providerActor.teeKey ? signDigest(digest, providerActor.teeKey) : ("0x" as Hex);
  ledger.deliverWithReceipt(providerActor.address, redemptionId, receipt, p95, uptimeBps, sig);
  return receipt;
}

export function actorByAddress(world: World, address: string): Actor | undefined {
  const a = address.toLowerCase();
  return Object.values(world.actors).find((x) => x.address === a);
}

export function systemLabel(world: World, address: string): string | undefined {
  const a = address.toLowerCase();
  const addr = world.ledger.addr;
  const map: Record<string, string> = {
    [addr.desk]: "ParonExchangeDesk",
    [addr.vault]: "The Paron Vault",
    [addr.jury]: "WifSlaJury",
    [addr.treasury]: "Paron Treasury",
    [addr.attestor]: "CRI Attestor",
    [addr.deployer]: "Deployer",
  };
  return map[a];
}

export { DEFAULT_PARAMS };
