/**
 * Event reducer: folds decoded protocol logs into the flywheel read model served by the API.
 * It consumes chain logs (src/indexer.ts) and deterministic-ledger events identically, so the
 * simulation fallback and a live chain produce the same API responses.
 *
 * Carried-over fixes from the legacy indexer: idempotent application keyed by (txHash, logIndex),
 * strict (block, logIndex) ordering, no KYB/verifier state (onboarding is permissionless).
 */
import { BPS, TIER1_STAKE, TIER2_STAKE, type ParonEvent } from "@paron-wif/core";

export type IndexedEvent = {
  key: string;
  blockNumber: number;
  logIndex: number;
  timestamp: number;
  txHash: string;
  contract: string;
  eventName: string;
  args: Record<string, unknown>;
};

type OrderRow = { id: number; seriesId: number; maker: string; isBid: boolean; price: bigint; qty: bigint; lotId: number; lane: number };

export type View = {
  applied: Set<string>;
  lastBlock: number;
  lastTimestamp: number;
  eventCount: number;
  flywheel: {
    totalWifBurned: bigint;
    burnCount: number;
    burnedByReason: Record<string, bigint>;
    totalWifStaked: bigint;
    totalFeesUsdg: bigint;
    juryRewardPoolUsdg: bigint;
    buybackReserveWif: bigint;
    juryBonusWifPool: bigint;
    wifPriceUsdg: bigint;
  };
  stakers: Map<string, bigint>;
  burns: { block: number; timestamp: number; txHash: string; actor: string; wifBurned: bigint; totalWifBurned: bigint; reason: string }[];
  cri: { price: bigint; updatedAt: number };
  corridors: Map<number, { id: number; code: string; name: string }>;
  corridorVotes: Map<string, bigint>;
  elected: Map<number, { corridorId: number; votes: bigint }>;
  series: Map<number, { id: number; symbol: string; corridorId: number; gpuTier: number; yymm: number; deliveryStart: bigint; deliveryEnd: bigint }>;
  market: Map<number, { lastPrice: bigint; volumeCu: bigint; volumeUsdg: bigint; trades: number; primarySoldCu: bigint; retiredCu: bigint }>;
  trades: { block: number; timestamp: number; seriesId: number; price: bigint; qty: bigint; maker: string; taker: string; takerIsBuyer: boolean; primary: boolean }[];
  orders: Map<number, OrderRow>;
  providers: Map<string, { address: string; metadataUri: string; registeredAt: number; deliveredCu: bigint; slashedCu: bigint; delivered: number; slashed: number }>;
  redemptions: Map<number, { id: number; seriesId: number; lotId: number; holder: string; provider: string; cuAmount: bigint; principalUsdg: bigint; marginUsdg: bigint; state: string; p95LatencyMs?: number; uptimeBps?: number; slaBreached?: boolean; disputeId?: number }>;
  disputes: Map<number, { id: number; redemptionId: number; challenger: string; reason: string; votingEndsAt: bigint; slashVotes: bigint; upholdVotes: bigint; status: string; rewardPoolUsdg: bigint; rewardPoolWif: bigint; voters: Set<string> }>;
};

export function createView(): View {
  return {
    applied: new Set(),
    lastBlock: 0,
    lastTimestamp: 0,
    eventCount: 0,
    flywheel: {
      totalWifBurned: 0n,
      burnCount: 0,
      burnedByReason: {},
      totalWifStaked: 0n,
      totalFeesUsdg: 0n,
      juryRewardPoolUsdg: 0n,
      buybackReserveWif: 0n,
      juryBonusWifPool: 0n,
      wifPriceUsdg: 0n,
    },
    stakers: new Map(),
    burns: [],
    cri: { price: 0n, updatedAt: 0 },
    corridors: new Map(),
    corridorVotes: new Map(),
    elected: new Map(),
    series: new Map(),
    market: new Map(),
    trades: [],
    orders: new Map(),
    providers: new Map(),
    redemptions: new Map(),
    disputes: new Map(),
  };
}

/** Burns executed by the buyback desk out of the protocol reserve (all other burns destroy the actor's own $WIF). */
const RESERVE_BURN_REASONS = new Set(["TRADE_FEE", "CASH_SETTLEMENT", "SLA_SLASH_JURY", "SLA_SLASH_MISSED_DEADLINE", "BUYBACK_FLUSH"]);

const big = (v: unknown): bigint => (typeof v === "bigint" ? v : BigInt(String(v ?? 0)));
const num = (v: unknown): number => Number(v ?? 0);
const addr = (v: unknown): string => String(v ?? "").toLowerCase();

function market(view: View, seriesId: number) {
  let m = view.market.get(seriesId);
  if (!m) {
    m = { lastPrice: 0n, volumeCu: 0n, volumeUsdg: 0n, trades: 0, primarySoldCu: 0n, retiredCu: 0n };
    view.market.set(seriesId, m);
  }
  return m;
}

export function tierOf(staked: bigint): number {
  return staked >= TIER2_STAKE ? 2 : staked >= TIER1_STAKE ? 1 : 0;
}

/** Applies one event. Returns false when it was already applied (idempotency). */
export function applyEvent(view: View, e: IndexedEvent): boolean {
  if (view.applied.has(e.key)) return false;
  view.applied.add(e.key);
  view.eventCount += 1;
  view.lastBlock = Math.max(view.lastBlock, e.blockNumber);
  view.lastTimestamp = Math.max(view.lastTimestamp, e.timestamp);
  const a = e.args;
  const f = view.flywheel;

  switch (e.eventName) {
    // ---- vault ----
    case "WifFlywheelBurned": {
      const reason = String(a.reason);
      f.totalWifBurned = big(a.totalWifBurned);
      f.burnCount += 1;
      f.burnedByReason[reason] = (f.burnedByReason[reason] ?? 0n) + big(a.wifBurned);
      view.burns.unshift({
        block: e.blockNumber,
        timestamp: e.timestamp,
        txHash: e.txHash,
        actor: addr(a.actor),
        wifBurned: big(a.wifBurned),
        totalWifBurned: big(a.totalWifBurned),
        reason,
      });
      if (view.burns.length > 200) view.burns.pop();
      if (RESERVE_BURN_REASONS.has(reason)) f.buybackReserveWif -= big(a.wifBurned);
      break;
    }
    case "WifStaked":
      view.stakers.set(addr(a.account), big(a.stakedTotal));
      f.totalWifStaked += big(a.amount);
      break;
    case "WifUnstaked":
      view.stakers.set(addr(a.account), big(a.stakedTotal));
      f.totalWifStaked -= big(a.amount);
      break;
    case "ProtocolFeeRouted":
      f.totalFeesUsdg += big(a.usdgFee);
      f.juryRewardPoolUsdg += big(a.juryLeg);
      // With no stakers the 20% rebate leg refills the jury pool (WifFlywheelVault._distributeRebate).
      if (f.totalWifStaked === 0n) f.juryRewardPoolUsdg += big(a.providerLeg);
      break;
    case "SlashProceedsRouted":
      f.juryRewardPoolUsdg += big(a.vaultUsdg);
      break;
    case "JuryRewardPoolFunded":
      f.juryRewardPoolUsdg += big(a.amount);
      break;
    case "JuryRewardDrawn":
      f.juryRewardPoolUsdg = big(a.poolAfter);
      break;
    case "BuybackReserveFunded":
      f.buybackReserveWif += big(a.amount);
      break;
    case "JuryBonusFunded":
      f.juryBonusWifPool += big(a.amount);
      break;
    case "JuryBonusDrawn":
      f.juryBonusWifPool = big(a.poolAfter);
      break;
    case "WifPriceUpdated":
      f.wifPriceUsdg = big(a.priceUsdg);
      break;

    // ---- series token ----
    case "CorridorRegistered":
      view.corridors.set(num(a.corridorId), { id: num(a.corridorId), code: String(a.code), name: String(a.name) });
      break;
    case "SeriesCreated":
      view.series.set(num(a.seriesId), {
        id: num(a.seriesId),
        symbol: String(a.symbol),
        corridorId: num(a.corridorId),
        gpuTier: num(a.gpuTier),
        yymm: num(a.yymm),
        deliveryStart: big(a.deliveryStart),
        deliveryEnd: big(a.deliveryEnd),
      });
      market(view, num(a.seriesId));
      break;

    // ---- desk ----
    case "ReferenceIndexAttested":
      view.cri = { price: big(a.priceUsdgPerCu), updatedAt: num(a.timestamp) };
      break;
    case "ProviderRegistered": {
      const p = view.providers.get(addr(a.provider));
      if (p) p.metadataUri = String(a.metadataUri);
      else {
        view.providers.set(addr(a.provider), {
          address: addr(a.provider),
          metadataUri: String(a.metadataUri),
          registeredAt: e.timestamp,
          deliveredCu: 0n,
          slashedCu: 0n,
          delivered: 0,
          slashed: 0,
        });
      }
      break;
    }
    case "OrderPlaced":
      view.orders.set(num(a.orderId), {
        id: num(a.orderId),
        seriesId: num(a.seriesId),
        maker: addr(a.maker),
        isBid: Boolean(a.isBid),
        price: big(a.price),
        qty: big(a.qty),
        lotId: num(a.lotId),
        lane: num(a.lane),
      });
      break;
    case "OrderCancelled":
      // Cancelled unsold primary CU are burned before they ever enter open interest.
      view.orders.delete(num(a.orderId));
      break;
    case "Trade": {
      const sid = num(a.seriesId);
      const m = market(view, sid);
      const qty = big(a.qty);
      const price = big(a.price);
      m.lastPrice = price;
      m.volumeCu += qty;
      m.volumeUsdg += qty * price;
      m.trades += 1;
      const primary = num(a.lotId) !== 0;
      if (primary) m.primarySoldCu += qty;
      const o = view.orders.get(num(a.makerOrderId));
      if (o) {
        o.qty -= qty;
        if (o.qty <= 0n) view.orders.delete(o.id);
      }
      view.trades.unshift({
        block: e.blockNumber,
        timestamp: e.timestamp,
        seriesId: sid,
        price,
        qty,
        maker: addr(a.maker),
        taker: addr(a.taker),
        takerIsBuyer: Boolean(a.takerIsBuyer),
        primary,
      });
      if (view.trades.length > 500) view.trades.pop();
      break;
    }
    case "RedemptionRequested":
      view.redemptions.set(num(a.redemptionId), {
        id: num(a.redemptionId),
        seriesId: num(a.seriesId),
        lotId: num(a.lotId),
        holder: addr(a.holder),
        provider: addr(a.provider),
        cuAmount: big(a.cuAmount),
        principalUsdg: big(a.principalUsdg),
        marginUsdg: big(a.marginUsdg),
        state: "Requested",
      });
      break;
    case "RedemptionAcknowledged": {
      const r = view.redemptions.get(num(a.redemptionId));
      if (r) r.state = "Acknowledged";
      break;
    }
    case "DeliveryReceiptPosted": {
      const r = view.redemptions.get(num(a.redemptionId));
      if (r) {
        r.state = "Delivered";
        r.p95LatencyMs = num(a.p95LatencyMs);
        r.uptimeBps = num(a.uptimeBps);
        r.slaBreached = Boolean(a.slaBreached);
      }
      break;
    }
    case "RedemptionDisputed": {
      const r = view.redemptions.get(num(a.redemptionId));
      if (r) {
        r.state = "Disputed";
        r.disputeId = num(a.disputeId);
      }
      break;
    }
    case "RedemptionFinalized": {
      const r = view.redemptions.get(num(a.redemptionId));
      if (r) {
        r.state = "Finalized";
        market(view, r.seriesId).retiredCu += r.cuAmount;
        const p = view.providers.get(r.provider);
        if (p) {
          p.deliveredCu += r.cuAmount;
          p.delivered += 1;
        }
      }
      break;
    }
    case "ProviderSlashed": {
      const r = view.redemptions.get(num(a.redemptionId));
      if (r) {
        r.state = "Slashed";
        market(view, r.seriesId).retiredCu += r.cuAmount;
        const p = view.providers.get(r.provider);
        if (p) {
          p.slashedCu += r.cuAmount;
          p.slashed += 1;
        }
      }
      break;
    }
    case "CashSettled":
      market(view, num(a.seriesId)).retiredCu += big(a.cuAmount);
      break;

    // ---- jury ----
    case "DisputeOpened":
      view.disputes.set(num(a.disputeId), {
        id: num(a.disputeId),
        redemptionId: num(a.redemptionId),
        challenger: addr(a.challenger),
        reason: String(a.reason),
        votingEndsAt: big(a.votingEndsAt),
        slashVotes: big(a.filingBurn),
        upholdVotes: 0n,
        status: "Open",
        rewardPoolUsdg: 0n,
        rewardPoolWif: 0n,
        voters: new Set([addr(a.challenger)]),
      });
      break;
    case "BurnVoteCast": {
      const d = view.disputes.get(num(a.disputeId));
      if (d) {
        d.slashVotes = big(a.slashVotes);
        d.upholdVotes = big(a.upholdVotes);
        d.voters.add(addr(a.voter));
      }
      break;
    }
    case "DisputeResolved": {
      const d = view.disputes.get(num(a.disputeId));
      if (d) {
        d.status = a.slashed ? "ResolvedSlash" : "ResolvedUphold";
        d.rewardPoolUsdg = big(a.rewardPoolUsdg);
        d.rewardPoolWif = big(a.rewardPoolWif);
      }
      break;
    }
    case "CorridorVoteCast":
      view.corridorVotes.set(`${num(a.epoch)}:${num(a.corridorId)}`, big(a.corridorTotal));
      break;
    case "CorridorElected":
      view.elected.set(num(a.epoch), { corridorId: num(a.corridorId), votes: big(a.votes) });
      break;
    default:
      break;
  }
  return true;
}

/** Aggregated book levels (best first) from the open-order set. */
export function bookLevels(view: View, seriesId: number, isBid: boolean, depth = 10): { price: bigint; qty: bigint; orders: number }[] {
  const levels = new Map<bigint, { price: bigint; qty: bigint; orders: number }>();
  for (const o of view.orders.values()) {
    if (o.seriesId !== seriesId || o.isBid !== isBid || o.qty <= 0n) continue;
    const l = levels.get(o.price) ?? { price: o.price, qty: 0n, orders: 0 };
    l.qty += o.qty;
    l.orders += 1;
    levels.set(o.price, l);
  }
  return [...levels.values()].sort((x, y) => (isBid ? (y.price > x.price ? 1 : -1) : x.price > y.price ? 1 : -1)).slice(0, depth);
}

export function openInterest(view: View, seriesId: number): bigint {
  const m = view.market.get(seriesId);
  return m ? m.primarySoldCu - m.retiredCu : 0n;
}

export function volume24h(view: View, seriesId: number, now: number): { cu: bigint; usdg: bigint } {
  let cu = 0n;
  let usdg = 0n;
  for (const t of view.trades) {
    if (t.seriesId !== seriesId || t.timestamp < now - 86_400) continue;
    cu += t.qty;
    usdg += t.qty * t.price;
  }
  return { cu, usdg };
}

/** Converts deterministic-ledger events (simulation fallback) into indexed events. */
export function fromLedgerEvents(events: ParonEvent[]): IndexedEvent[] {
  return events.map((e) => ({
    key: `${e.txHash}:${e.seq}`,
    blockNumber: e.block,
    logIndex: e.seq,
    timestamp: Number(e.timestamp),
    txHash: e.txHash,
    contract: e.contract,
    eventName: e.name,
    args: e.args,
  }));
}

export { BPS };
