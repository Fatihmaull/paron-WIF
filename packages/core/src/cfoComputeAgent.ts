/**
 * Autonomous $WIF Compute Agent ("CFO Compute Agent"), Loop 4 of the Paron WIF flywheel.
 *
 * Each tick the agent:
 *  1. observes LLM inference load (tokens/s, GPU utilization, queue depth) and forecasts the
 *     H100-equivalent hours it needs over its coverage horizon;
 *  2. keeps >= 10,000 $WIF held+staked (stakes up to its target) for the 10 bps fee and the
 *     priority matching lane;
 *  3. buys the cheapest canonical CU series whose ask is within its premium budget over the
 *     Compute Reference Index, in $WIF discount mode (its fee burn leg burns its own $WIF);
 *  4. redeems compute when load is imminent, independently probes every delivery and either
 *     confirms it or files an SLA dispute (burning $WIF) when p95 latency breaks the SLA;
 *  5. cash-settles excess inventory at the index when compute prices spike (hedge PnL);
 *  6. claims juror upside it earned from disputes it filed.
 *
 * The decision function is pure; execution goes through an AgentBackend, implemented here for the
 * deterministic ledger and in indexer/src/agent-runner.ts for a live chain via viem.
 */
import { keccak256, toHex } from "viem";
import { BPS, FEE_DISCOUNT_THRESHOLD, GPU_WEIGHT_BPS, SLA_MAX_P95_LATENCY_MS, WIF, type GpuTier } from "./constants.ts";
import type { ParonLedger } from "./engine/ledger.ts";
import { explainError } from "./engine/errors.ts";
import type { Address, Hex, RedemptionState } from "./types.ts";

// ------------------------------------------------------------------
// Inference load model (deterministic synthetic telemetry)
// ------------------------------------------------------------------

export type InferenceSample = {
  t: number;
  tokensPerSec: number;
  requestsPerSec: number;
  gpuUtilization: number;
  queueDepth: number;
  h100Equivalent: number;
};

/** Mulberry32 PRNG: deterministic across Node and browsers. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = a;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export class InferenceLoadModel {
  readonly tokensPerH100: number;
  private readonly seed: number;

  /** @param tokensPerH100 sustained decode throughput of one H100 for the served model mix. */
  constructor(seed = 2_611, tokensPerH100 = 2_400) {
    this.seed = seed;
    this.tokensPerH100 = tokensPerH100;
  }

  sample(t: number): InferenceSample {
    const hour = ((t / 3_600) % 24 + 24) % 24;
    // Asia-Pacific business-hours peak around 14:00 UTC+7 with a smaller US-evening shoulder.
    const diurnal = 0.55 + 0.35 * Math.sin(((hour - 3) / 24) * 2 * Math.PI) + 0.1 * Math.sin(((hour - 15) / 12) * 2 * Math.PI);
    const rnd = prng(this.seed + Math.floor(t / 300))();
    const burst = rnd > 0.92 ? 1.45 : 1 + (rnd - 0.5) * 0.12;
    const tokensPerSec = Math.max(4_000, 52_000 * diurnal * burst);
    const h100Equivalent = tokensPerSec / this.tokensPerH100;
    const provisioned = 24;
    return {
      t,
      tokensPerSec: Math.round(tokensPerSec),
      requestsPerSec: Math.round(tokensPerSec / 380),
      gpuUtilization: Math.min(0.99, h100Equivalent / provisioned),
      queueDepth: Math.max(0, Math.round((h100Equivalent - provisioned) * 9)),
      h100Equivalent: Math.round(h100Equivalent * 100) / 100,
    };
  }

  /** H100-equivalent GPU-hours (= CU) needed over [t, t + hours). */
  forecastCu(t: number, hours: number): number {
    let total = 0;
    for (let h = 0; h < hours; h += 1) total += this.sample(t + h * 3_600).h100Equivalent;
    return Math.ceil(total);
  }
}

// ------------------------------------------------------------------
// Observations, policy, actions
// ------------------------------------------------------------------

export type AgentSeriesObs = {
  id: number;
  symbol: string;
  gpuTier: GpuTier;
  deliveryStart: bigint;
  deliveryEnd: bigint;
  bestAsk: bigint;
  askQtyAtBest: bigint;
  bestBid: bigint;
};

export type AgentRedemptionObs = {
  id: number;
  seriesId: number;
  cuAmount: bigint;
  state: RedemptionState;
  p95LatencyMs: number;
  uptimeBps: number;
  challengeDeadline: bigint;
  receiptHash: Hex;
};

export type AgentObservation = {
  address: Address;
  now: bigint;
  wif: bigint;
  usdg: bigint;
  stakedWif: bigint;
  wifDiscount: boolean;
  criH100Usdg: bigint;
  criUpdatedAt: bigint;
  series: AgentSeriesObs[];
  holdings: Record<number, bigint>;
  redemptions: AgentRedemptionObs[];
  pendingUpside: { disputeId: number; usdg: bigint; wif: bigint }[];
};

export type AgentPolicy = {
  latencySlaMs: number;
  maxPriceUsdg: bigint;
  maxPremiumToIndexBps: bigint;
  stakeTargetWif: bigint;
  coverageHours: number;
  maxOrderCu: bigint;
  redeemBatchCu: bigint;
  hedgeTakeProfitBps: bigint;
  utilizationRedeemTrigger: number;
  minUsdgReserve: bigint;
};

export const DEFAULT_AGENT_POLICY: AgentPolicy = {
  latencySlaMs: SLA_MAX_P95_LATENCY_MS,
  maxPriceUsdg: 2_300_000n,
  maxPremiumToIndexBps: 300n,
  stakeTargetWif: 20_000n * WIF,
  coverageHours: 6,
  maxOrderCu: 120n,
  redeemBatchCu: 25n,
  hedgeTakeProfitBps: 800n,
  utilizationRedeemTrigger: 0.82,
  minUsdgReserve: 200n * 1_000_000n,
};

export type AgentAction =
  | { kind: "STAKE_WIF"; amount: bigint; why: string }
  | { kind: "BUY_CU"; seriesId: number; cu: bigint; maxPrice: bigint; useWifDiscount: boolean; why: string }
  | { kind: "REQUEST_REDEMPTION"; seriesId: number; cu: bigint; why: string }
  | { kind: "CONFIRM_DELIVERY"; redemptionId: number; measuredP95Ms: number; why: string }
  | { kind: "OPEN_SLA_DISPUTE"; redemptionId: number; measuredP95Ms: number; evidenceHash: Hex; reason: string; why: string }
  | { kind: "SETTLE_CASH"; seriesId: number; cu: bigint; why: string }
  | { kind: "CLAIM_UPSIDE"; disputeId: number; why: string }
  | { kind: "HOLD"; why: string };

export type AgentMemory = {
  entries: Record<number, { cu: bigint; cost: bigint }>;
  probes: Record<number, { measuredP95Ms: number; samples: number[]; evidenceHash: Hex }>;
  handled: Record<number, boolean>;
  ticks: number;
};

export function emptyMemory(): AgentMemory {
  return { entries: {}, probes: {}, handled: {}, ticks: 0 };
}

/** Independent latency probe of a delivered cluster: 12 synthetic requests around the true p95. */
export function probeDelivery(r: AgentRedemptionObs, seed = 7): { measuredP95Ms: number; samples: number[]; evidenceHash: Hex } {
  const rand = prng(seed * 1_000 + r.id);
  const truth = Math.max(40, r.p95LatencyMs);
  const samples = Array.from({ length: 12 }, () => Math.round(truth * (0.9 + rand() * 0.2)));
  const sorted = [...samples].sort((a, b) => a - b);
  const measuredP95Ms = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)];
  const evidenceHash = keccak256(toHex(JSON.stringify({ redemptionId: r.id, receipt: r.receiptHash, samples, measuredP95Ms }))) as Hex;
  return { measuredP95Ms, samples, evidenceHash };
}

/** Pure decision function. Never reads the network, never mutates `obs`. */
export function decideActions(obs: AgentObservation, sample: InferenceSample, forecastCu: number, policy: AgentPolicy, memory: AgentMemory): AgentAction[] {
  const actions: AgentAction[] = [];

  // (2) $WIF eligibility and priority lane
  const heldPlusStaked = obs.wif + obs.stakedWif;
  if (obs.stakedWif < policy.stakeTargetWif && obs.wif > 0n) {
    const amount = policy.stakeTargetWif - obs.stakedWif < obs.wif ? policy.stakeTargetWif - obs.stakedWif : obs.wif;
    actions.push({ kind: "STAKE_WIF", amount, why: `keep ${policy.stakeTargetWif / WIF} $WIF staked for 10 bps fees + priority lane` });
  }
  const discountMode = heldPlusStaked >= FEE_DISCOUNT_THRESHOLD;

  // (4) delivery probes
  for (const r of obs.redemptions) {
    if (memory.handled[r.id]) continue;
    if (r.state === "Delivered" && obs.now <= r.challengeDeadline) {
      const probe = probeDelivery(r);
      if (probe.measuredP95Ms > policy.latencySlaMs) {
        actions.push({
          kind: "OPEN_SLA_DISPUTE",
          redemptionId: r.id,
          measuredP95Ms: probe.measuredP95Ms,
          evidenceHash: probe.evidenceHash,
          reason: `probe p95 ${probe.measuredP95Ms}ms > ${policy.latencySlaMs}ms SLA (receipt ${r.p95LatencyMs}ms, uptime ${(r.uptimeBps / 100).toFixed(2)}%)`,
          why: "independent probe breaches the SLA: burn 100 $WIF to file, let the jury slash",
        });
      } else {
        actions.push({ kind: "CONFIRM_DELIVERY", redemptionId: r.id, measuredP95Ms: probe.measuredP95Ms, why: `probe p95 ${probe.measuredP95Ms}ms within SLA` });
      }
    }
  }

  // (6) juror upside
  for (const p of obs.pendingUpside) actions.push({ kind: "CLAIM_UPSIDE", disputeId: p.disputeId, why: "claim USDG + $WIF juror upside" });

  // Inventory vs demand
  const held = Object.values(obs.holdings).reduce((a, b) => a + b, 0n);
  const inFlight = obs.redemptions.filter((r) => r.state === "Requested" || r.state === "Acknowledged").reduce((a, r) => a + r.cuAmount, 0n);
  const need = BigInt(forecastCu);
  const deficit = need - held - inFlight;

  // (3) buy the cheapest CU within the premium budget over CRI
  const budgetPrice = (obs.criH100Usdg * (BPS + policy.maxPremiumToIndexBps)) / BPS;
  const cap = budgetPrice < policy.maxPriceUsdg ? budgetPrice : policy.maxPriceUsdg;
  const cheapest = obs.series
    .filter((s) => s.bestAsk > 0n && obs.now < s.deliveryEnd)
    .sort((a, b) => (a.bestAsk === b.bestAsk ? a.id - b.id : a.bestAsk < b.bestAsk ? -1 : 1))[0];
  if (deficit > 0n && cheapest && cheapest.bestAsk <= cap && obs.usdg > policy.minUsdgReserve) {
    const spendable = obs.usdg - policy.minUsdgReserve;
    const affordable = spendable / ((cheapest.bestAsk * 10_030n) / 10_000n);
    let cu = deficit < policy.maxOrderCu ? deficit : policy.maxOrderCu;
    if (cu > cheapest.askQtyAtBest) cu = cheapest.askQtyAtBest;
    if (cu > affordable) cu = affordable;
    if (cu > 0n) {
      const premium = Number(((cheapest.bestAsk - obs.criH100Usdg) * 10_000n) / obs.criH100Usdg) / 100;
      actions.push({
        kind: "BUY_CU",
        seriesId: cheapest.id,
        cu,
        maxPrice: cheapest.bestAsk,
        useWifDiscount: discountMode,
        why: `forecast needs ${need} CU, holding ${held + inFlight}; ${cheapest.symbol} is the cheapest H100-eq hour (${premium >= 0 ? "+" : ""}${premium.toFixed(2)}% vs CRI)`,
      });
    }
  }

  // (4) redeem when load is imminent and a deliverable series is held
  if (sample.gpuUtilization >= policy.utilizationRedeemTrigger && inFlight === 0n) {
    const deliverable = obs.series.find((s) => obs.now >= s.deliveryStart && obs.now < s.deliveryEnd && (obs.holdings[s.id] ?? 0n) >= policy.redeemBatchCu);
    if (deliverable) {
      actions.push({
        kind: "REQUEST_REDEMPTION",
        seriesId: deliverable.id,
        cu: policy.redeemBatchCu,
        why: `GPU utilization ${(sample.gpuUtilization * 100).toFixed(0)}% >= ${(policy.utilizationRedeemTrigger * 100).toFixed(0)}%: pull ${policy.redeemBatchCu} CU of ${deliverable.symbol} onto the cluster`,
      });
    }
  }

  // (5) hedge: cash-settle inventory beyond demand when the index spikes over the average entry
  if (deficit < 0n) {
    for (const s of obs.series) {
      const entry = memory.entries[s.id];
      const holding = obs.holdings[s.id] ?? 0n;
      if (!entry || entry.cu === 0n || holding === 0n || obs.now < s.deliveryStart) continue;
      const avg = entry.cost / entry.cu;
      if (obs.criH100Usdg * BPS >= avg * (BPS + policy.hedgeTakeProfitBps)) {
        const excess = -deficit < holding ? -deficit : holding;
        actions.push({
          kind: "SETTLE_CASH",
          seriesId: s.id,
          cu: excess,
          why: `CRI ${(Number(obs.criH100Usdg) / 1e6).toFixed(2)} is >= ${Number(policy.hedgeTakeProfitBps) / 100}% over avg entry ${(Number(avg) / 1e6).toFixed(2)}: lock hedge PnL at the index`,
        });
        break;
      }
    }
  }

  if (actions.length === 0) actions.push({ kind: "HOLD", why: `coverage ok: need ${need} CU, holding ${held + inFlight}` });
  return actions;
}

// ------------------------------------------------------------------
// Execution
// ------------------------------------------------------------------

export type TxResult = { ok: true; txHash?: string; detail?: string } | { ok: false; error: string };

export interface AgentBackend {
  readonly address: Address;
  observe(): Promise<AgentObservation>;
  stake(amount: bigint): Promise<TxResult>;
  buy(seriesId: number, cu: bigint, maxPrice: bigint, useWifDiscount: boolean): Promise<TxResult & { filledCu?: bigint; notional?: bigint }>;
  requestRedemption(seriesId: number, cu: bigint, deliveryRef: Hex): Promise<TxResult>;
  confirmDelivery(redemptionId: number): Promise<TxResult>;
  openDispute(redemptionId: number, evidenceHash: Hex, reason: string): Promise<TxResult>;
  settleCash(seriesId: number, cu: bigint): Promise<TxResult>;
  claimUpside(disputeId: number): Promise<TxResult>;
}

export type AgentLogEntry = {
  tick: number;
  t: number;
  kind: "observe" | "decide" | "act" | "error";
  message: string;
  action?: AgentAction["kind"];
  ok?: boolean;
  txHash?: string;
};

export type AgentTickReport = {
  tick: number;
  sample: InferenceSample;
  forecastCu: number;
  observation: AgentObservation;
  actions: AgentAction[];
  results: { action: AgentAction; result: TxResult }[];
  log: AgentLogEntry[];
};

export class CfoComputeAgent {
  readonly backend: AgentBackend;
  readonly policy: AgentPolicy;
  readonly load: InferenceLoadModel;
  memory: AgentMemory;

  constructor(backend: AgentBackend, policy: AgentPolicy = DEFAULT_AGENT_POLICY, load = new InferenceLoadModel(), memory: AgentMemory = emptyMemory()) {
    this.backend = backend;
    this.policy = policy;
    this.load = load;
    this.memory = memory;
  }

  async tick(): Promise<AgentTickReport> {
    const tick = ++this.memory.ticks;
    const obs = await this.backend.observe();
    const t = Number(obs.now);
    const sample = this.load.sample(t);
    const forecastCu = this.load.forecastCu(t, this.policy.coverageHours);
    const log: AgentLogEntry[] = [
      {
        tick,
        t,
        kind: "observe",
        message: `load ${sample.tokensPerSec.toLocaleString("en-US")} tok/s = ${sample.h100Equivalent} H100-eq, util ${(sample.gpuUtilization * 100).toFixed(0)}%, ${this.policy.coverageHours}h forecast ${forecastCu} CU`,
      },
    ];
    const actions = decideActions(obs, sample, forecastCu, this.policy, this.memory);
    const results: AgentTickReport["results"] = [];
    for (const action of actions) {
      log.push({ tick, t, kind: "decide", message: `${action.kind}: ${action.why}`, action: action.kind });
      if (action.kind === "HOLD") continue;
      const result = await this.execute(action);
      results.push({ action, result });
      log.push(
        result.ok
          ? { tick, t, kind: "act", message: `${action.kind} ok${result.detail ? `: ${result.detail}` : ""}`, action: action.kind, ok: true, txHash: result.txHash }
          : { tick, t, kind: "error", message: `${action.kind} failed: ${result.error}`, action: action.kind, ok: false },
      );
    }
    return { tick, sample, forecastCu, observation: obs, actions, results, log };
  }

  private async execute(action: AgentAction): Promise<TxResult> {
    const b = this.backend;
    switch (action.kind) {
      case "STAKE_WIF":
        return b.stake(action.amount);
      case "BUY_CU": {
        const r = await b.buy(action.seriesId, action.cu, action.maxPrice, action.useWifDiscount);
        if (r.ok && r.filledCu && r.notional) {
          const e = this.memory.entries[action.seriesId] ?? { cu: 0n, cost: 0n };
          this.memory.entries[action.seriesId] = { cu: e.cu + r.filledCu, cost: e.cost + r.notional };
        }
        return r;
      }
      case "REQUEST_REDEMPTION":
        return b.requestRedemption(action.seriesId, action.cu, keccak256(toHex(`cfo-agent:${b.address}:ssh-pubkey`)) as Hex);
      case "CONFIRM_DELIVERY": {
        const r = await b.confirmDelivery(action.redemptionId);
        if (r.ok) this.memory.handled[action.redemptionId] = true;
        return r;
      }
      case "OPEN_SLA_DISPUTE": {
        const r = await b.openDispute(action.redemptionId, action.evidenceHash, action.reason);
        if (r.ok) this.memory.handled[action.redemptionId] = true;
        return r;
      }
      case "SETTLE_CASH": {
        const r = await b.settleCash(action.seriesId, action.cu);
        if (r.ok) {
          const e = this.memory.entries[action.seriesId];
          if (e && e.cu > 0n) {
            const cu = action.cu > e.cu ? e.cu : action.cu;
            this.memory.entries[action.seriesId] = { cu: e.cu - cu, cost: e.cost - (e.cost * cu) / e.cu };
          }
        }
        return r;
      }
      case "CLAIM_UPSIDE":
        return b.claimUpside(action.disputeId);
      default:
        return { ok: true };
    }
  }
}

// ------------------------------------------------------------------
// Backend for the deterministic ledger
// ------------------------------------------------------------------

export class LedgerAgentBackend implements AgentBackend {
  readonly address: Address;
  private readonly ledger: () => ParonLedger;

  /** @param ledger getter so callers can swap the ledger instance (React state, cloned worlds). */
  constructor(ledger: ParonLedger | (() => ParonLedger), address: Address) {
    this.ledger = typeof ledger === "function" ? ledger : () => ledger;
    this.address = address.toLowerCase() as Address;
  }

  private run<T>(fn: (l: ParonLedger) => T, detail?: (v: T) => string): TxResult & { value?: T } {
    try {
      const value = fn(this.ledger());
      const tx = this.ledger().events().at(-1)?.txHash;
      return { ok: true, txHash: tx, detail: detail?.(value), value };
    } catch (error) {
      return { ok: false, error: explainError(error) };
    }
  }

  async observe(): Promise<AgentObservation> {
    const l = this.ledger();
    const a = this.address;
    const holdings: Record<number, bigint> = {};
    const series: AgentSeriesObs[] = l.listSeries().map((s) => {
      holdings[s.id] = l.cuBalance(a, s.id);
      const m = l.getSeriesMarket(s.id);
      const best = l.getBookSide(s.id, false, 1)[0];
      return {
        id: s.id,
        symbol: s.symbol,
        gpuTier: s.gpuTier,
        deliveryStart: s.deliveryStart,
        deliveryEnd: s.deliveryEnd,
        bestAsk: m.bestAsk,
        askQtyAtBest: best?.qty ?? 0n,
        bestBid: m.bestBid,
      };
    });
    const pendingUpside = l
      .listDisputes()
      .map((d) => ({ disputeId: d.id, ...l.pendingVoterUpside(d.id, a) }))
      .filter((p) => p.usdg > 0n || p.wif > 0n);
    return {
      address: a,
      now: l.now,
      wif: l.wifBalance(a),
      usdg: l.usdgBalance(a),
      stakedWif: l.stakedWif(a),
      wifDiscount: l.hasWifFeeDiscount(a),
      criH100Usdg: l.criIndex().price,
      criUpdatedAt: l.criIndex().updatedAt,
      series,
      holdings,
      redemptions: l
        .listRedemptions()
        .filter((r) => r.holder === a)
        .map((r) => ({
          id: r.id,
          seriesId: r.seriesId,
          cuAmount: r.cuAmount,
          state: r.state,
          p95LatencyMs: r.p95LatencyMs,
          uptimeBps: r.uptimeBps,
          challengeDeadline: r.challengeDeadline,
          receiptHash: r.receiptHash,
        })),
      pendingUpside,
    };
  }

  async stake(amount: bigint) {
    return this.run((l) => l.stakeWifForMarginBoost(this.address, amount), () => `${amount / WIF} $WIF staked`);
  }

  async buy(seriesId: number, cu: bigint, maxPrice: bigint, useWifDiscount: boolean) {
    const fees = this.ledger().flywheelStats().totalWifBurned;
    const usdgBefore = this.ledger().usdgBalance(this.address);
    const r = this.run((l) => l.buySeriesOrPlaceBid(this.address, seriesId, cu, maxPrice, useWifDiscount));
    if (!r.ok) return r;
    const filledCu = r.value?.filledCu ?? 0n;
    const burned = this.ledger().flywheelStats().totalWifBurned - fees;
    const notional = usdgBefore - this.ledger().usdgBalance(this.address);
    return { ...r, filledCu, notional, detail: `${filledCu} CU filled, ${(Number(burned / 10n ** 14n) / 1e4).toFixed(2)} $WIF burned by the fee` };
  }

  async requestRedemption(seriesId: number, cu: bigint, deliveryRef: Hex) {
    return this.run((l) => l.requestRedemption(this.address, seriesId, cu, 0, deliveryRef), (id) => `redemption #${id}`);
  }

  async confirmDelivery(redemptionId: number) {
    return this.run((l) => l.confirmDelivery(this.address, redemptionId), () => `redemption #${redemptionId} finalized`);
  }

  async openDispute(redemptionId: number, evidenceHash: Hex, reason: string) {
    return this.run((l) => l.openSlaDispute(this.address, redemptionId, evidenceHash, reason), (id) => `dispute #${id} opened`);
  }

  async settleCash(seriesId: number, cu: bigint) {
    return this.run((l) => l.settleCashAtIndex(this.address, seriesId, cu), (payout) => `payout $${(Number(payout) / 1e6).toFixed(2)}`);
  }

  async claimUpside(disputeId: number) {
    return this.run((l) => l.claimVoterUpside(this.address, disputeId), (v) => `$${(Number(v.usdgOut) / 1e6).toFixed(4)} + ${(Number(v.wifOut / 10n ** 14n) / 1e4).toFixed(2)} $WIF`);
  }
}

export function gpuHoursFor(tier: GpuTier, cu: bigint): number {
  return (Number(cu) * 10_000) / Number(GPU_WEIGHT_BPS[tier]);
}
