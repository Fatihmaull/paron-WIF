/**
 * ProtocolSnapshot: the single read model the UI renders, whether the data comes from the local
 * deterministic ledger (simulation mode) or from contract reads + the indexer (live mode).
 */
import { GPU_TIERS, type GpuTier } from "./constants.ts";
import type { FlywheelStats, ParonLedger, SeriesMarket } from "./engine/ledger.ts";
import type { Address, Dispute, Lot, Order, ParonEvent, ProviderProfile, Redemption } from "./types.ts";

export type BookLevel = { price: bigint; qty: bigint };

export type SeriesView = {
  id: number;
  symbol: string;
  corridorId: number;
  corridorCode: string;
  corridorName: string;
  gpuTier: GpuTier;
  yymm: number;
  deliveryStart: bigint;
  deliveryEnd: bigint;
  market: SeriesMarket;
  bids: BookLevel[];
  asks: BookLevel[];
  boosted: boolean;
};

export type ProviderView = ProviderProfile & {
  name?: string;
  stakedWif: bigint;
  tier: number;
  marginBps: bigint;
  claimableUsdg: bigint;
  openLots: number;
  reliabilityBps: number;
};

export type BurnView = {
  seq: number;
  timestamp: bigint;
  actor: Address;
  wifBurned: bigint;
  totalWifBurned: bigint;
  reason: string;
  txHash: string;
};

export type TradeView = {
  seq: number;
  timestamp: bigint;
  seriesId: number;
  price: bigint;
  qty: bigint;
  maker: Address;
  taker: Address;
  takerIsBuyer: boolean;
  primary: boolean;
};

export type AccountView = {
  address: Address;
  wif: bigint;
  usdg: bigint;
  stakedWif: bigint;
  stakeLock: bigint;
  tier: number;
  marginBps: bigint;
  wifDiscount: boolean;
  earnedRebateUsdg: bigint;
  claimableUsdg: bigint;
  cu: Record<number, bigint>;
  orders: Order[];
  registeredProvider: boolean;
  faucetWifAt: bigint;
  faucetUsdgAt: bigint;
  pendingUpside: { disputeId: number; usdg: bigint; wif: bigint }[];
  votes: Record<number, { slash: bigint; uphold: bigint; claimed: boolean }>;
};

export type ProtocolSnapshot = {
  mode: "simulation" | "live";
  chainId: number;
  now: bigint;
  block: number;
  flywheel: FlywheelStats & { openInterestCu: bigint; wifTotalSupply: bigint };
  cri: { price: bigint; updatedAt: bigint };
  corridors: { id: number; code: string; name: string; votes: bigint }[];
  epoch: {
    current: number;
    endsAt: bigint;
    boosted: { active: boolean; corridorId: number };
    previousFinalized: boolean;
    previousWinner: number | null;
    previousTotal: bigint;
    tally: bigint[];
  };
  series: SeriesView[];
  lots: Lot[];
  providers: ProviderView[];
  redemptions: Redemption[];
  disputes: Dispute[];
  burns: BurnView[];
  burnStats: { reason: string; amount: bigint; count: number }[];
  trades: TradeView[];
  account: AccountView | null;
  params: {
    votingPeriod: bigint;
    epochLength: bigint;
    ackWindow: bigint;
    deliveryWindow: bigint;
    challengeWindow: bigint;
    maxIndexAge: bigint;
  };
};

export function burnsFromEvents(events: ParonEvent[], limit = 40): BurnView[] {
  const out: BurnView[] = [];
  for (let i = events.length - 1; i >= 0 && out.length < limit; i -= 1) {
    const e = events[i];
    if (e.name !== "WifFlywheelBurned") continue;
    out.push({
      seq: e.seq,
      timestamp: e.timestamp,
      actor: e.args.actor as Address,
      wifBurned: BigInt(e.args.wifBurned),
      totalWifBurned: BigInt(e.args.totalWifBurned),
      reason: String(e.args.reason),
      txHash: e.txHash,
    });
  }
  return out;
}

export function burnStatsFromEvents(events: ParonEvent[]): ProtocolSnapshot["burnStats"] {
  const by = new Map<string, { reason: string; amount: bigint; count: number }>();
  for (const e of events) {
    if (e.name !== "WifFlywheelBurned") continue;
    const reason = String(e.args.reason);
    const row = by.get(reason) ?? { reason, amount: 0n, count: 0 };
    row.amount += BigInt(e.args.wifBurned);
    row.count += 1;
    by.set(reason, row);
  }
  return [...by.values()].sort((a, b) => (b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : 0));
}

export function tradesFromEvents(events: ParonEvent[], limit = 60): TradeView[] {
  const out: TradeView[] = [];
  for (let i = events.length - 1; i >= 0 && out.length < limit; i -= 1) {
    const e = events[i];
    if (e.name !== "Trade") continue;
    out.push({
      seq: e.seq,
      timestamp: e.timestamp,
      seriesId: Number(e.args.seriesId),
      price: BigInt(e.args.price),
      qty: BigInt(e.args.qty),
      maker: e.args.maker as Address,
      taker: e.args.taker as Address,
      takerIsBuyer: Boolean(e.args.takerIsBuyer),
      primary: Number(e.args.lotId) !== 0,
    });
  }
  return out;
}

export function accountView(ledger: ParonLedger, address: Address): AccountView {
  const a = address.toLowerCase() as Address;
  const cu: Record<number, bigint> = {};
  for (const s of ledger.listSeries()) cu[s.id] = ledger.cuBalance(a, s.id);
  const pendingUpside: AccountView["pendingUpside"] = [];
  const votes: AccountView["votes"] = {};
  for (const d of ledger.listDisputes()) {
    const w = ledger.voteWeight(d.id, a);
    if (w.slash > 0n || w.uphold > 0n) votes[d.id] = w;
    const p = ledger.pendingVoterUpside(d.id, a);
    if (p.usdg > 0n || p.wif > 0n) pendingUpside.push({ disputeId: d.id, ...p });
  }
  return {
    address: a,
    wif: ledger.wifBalance(a),
    usdg: ledger.usdgBalance(a),
    stakedWif: ledger.stakedWif(a),
    stakeLock: ledger.stakeLock(a),
    tier: ledger.getProviderTier(a),
    marginBps: ledger.getRequiredMarginBps(a),
    wifDiscount: ledger.hasWifFeeDiscount(a),
    earnedRebateUsdg: ledger.earnedRebate(a),
    claimableUsdg: ledger.providerClaimable(a),
    cu,
    orders: ledger.listOrders({ maker: a, activeOnly: true }),
    registeredProvider: !!ledger.getProvider(a)?.registered,
    faucetWifAt: ledger.faucetAvailableAt("WIF", a),
    faucetUsdgAt: ledger.faucetAvailableAt("USDG", a),
    pendingUpside,
    votes,
  };
}

export function snapshotFromLedger(ledger: ParonLedger, opts: { account?: Address | null; names?: Record<string, string>; depth?: number } = {}): ProtocolSnapshot {
  const depth = opts.depth ?? 10;
  const epoch = ledger.currentEpoch();
  const boosted = ledger.currentBoostedCorridor();
  const tally = ledger.corridorTally(epoch);
  const corridors = ledger.listCorridors().map((c, i) => ({ ...c, votes: tally[i] ?? 0n }));
  const series: SeriesView[] = ledger.listSeries().map((s) => ({
    ...s,
    corridorCode: corridors[s.corridorId]?.code ?? "?",
    corridorName: corridors[s.corridorId]?.name ?? "?",
    market: ledger.getSeriesMarket(s.id),
    bids: ledger.getBookSide(s.id, true, depth),
    asks: ledger.getBookSide(s.id, false, depth),
    boosted: boosted.active && boosted.corridorId === s.corridorId,
  }));
  const lots = ledger.listLots();
  const providers: ProviderView[] = ledger.listProviders().map((p) => {
    const total = p.deliveredCu + p.slashedCu;
    return {
      ...p,
      name: opts.names?.[p.address],
      stakedWif: ledger.stakedWif(p.address),
      tier: ledger.getProviderTier(p.address),
      marginBps: ledger.getRequiredMarginBps(p.address),
      claimableUsdg: ledger.providerClaimable(p.address),
      openLots: lots.filter((l) => l.provider === p.address && !l.closed).length,
      reliabilityBps: total === 0n ? 10_000 : Number((p.deliveredCu * 10_000n) / total),
    };
  });
  const openInterestCu = series.reduce((acc, s) => acc + s.market.openInterestCu, 0n);
  const events = ledger.events();
  return {
    mode: "simulation",
    chainId: ledger.params.chainId,
    now: ledger.now,
    block: ledger.s.block,
    flywheel: { ...ledger.flywheelStats(), openInterestCu, wifTotalSupply: ledger.wifTotalSupply() },
    cri: { price: ledger.criIndex().price, updatedAt: ledger.criIndex().updatedAt },
    corridors,
    epoch: {
      current: epoch,
      endsAt: ledger.epochEndsAt(epoch),
      boosted,
      previousFinalized: epoch > 0 && ledger.epochFinalized(epoch - 1),
      previousWinner: epoch > 0 ? (ledger.epochWinner(epoch - 1) ?? null) : null,
      previousTotal: epoch > 0 ? ledger.corridorTally(epoch - 1).reduce((a, b) => a + b, 0n) : 0n,
      tally,
    },
    series,
    lots,
    providers,
    redemptions: ledger.listRedemptions(),
    disputes: ledger.listDisputes(),
    burns: burnsFromEvents(events),
    burnStats: burnStatsFromEvents(events),
    trades: tradesFromEvents(events),
    account: opts.account ? accountView(ledger, opts.account) : null,
    params: {
      votingPeriod: ledger.params.votingPeriod,
      epochLength: ledger.params.epochLength,
      ackWindow: ledger.params.ackWindow,
      deliveryWindow: ledger.params.deliveryWindow,
      challengeWindow: ledger.params.challengeWindow,
      maxIndexAge: ledger.params.maxIndexAge,
    },
  };
}

export function gpuTierIndex(tier: GpuTier): number {
  return GPU_TIERS.indexOf(tier);
}

/** JSON replacer that renders bigint as decimal strings (indexer API, receipts, downloads). */
export function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}
