/**
 * Live-chain adapter: reads the same ProtocolSnapshot the simulation produces, straight from the
 * Paron WIF contracts (batched JSON-RPC), and sends real transactions from the connected wallet.
 */
import {
  createPublicClient,
  createWalletClient,
  custom,
  defineChain,
  http,
  maxUint256,
  type Abi,
  type PublicClient,
  type WalletClient,
} from "viem";
import {
  DISPUTE_STATUSES,
  GPU_TIERS,
  REDEMPTION_STATES,
  paronExchangeDeskAbi,
  paronSeriesTokenAbi,
  usdgAbi,
  wifFlywheelVaultAbi,
  wifSlaJuryAbi,
  wifTokenAbi,
  type AccountView,
  type Address,
  type BurnView,
  type Dispute,
  type Hex,
  type Lot,
  type Order,
  type ProtocolSnapshot,
  type ProviderView,
  type Redemption,
  type SeriesView,
  type TradeView,
} from "@paron-wif/core";
import { appConfig, type LiveAddresses } from "./config";
import type { Eip1193Provider } from "./eip6963";

export const liveChain = defineChain({
  id: appConfig.chainId,
  name: appConfig.chainName,
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: appConfig.rpcUrl ? [appConfig.rpcUrl] : [] } },
});

export function makeClients(provider: Eip1193Provider, account: Address): { pub: PublicClient; wallet: WalletClient } {
  const pub = createPublicClient({
    chain: liveChain,
    transport: appConfig.rpcUrl ? http(appConfig.rpcUrl, { batch: true }) : custom(provider),
  }) as PublicClient;
  const wallet = createWalletClient({ account, chain: liveChain, transport: custom(provider) });
  return { pub, wallet };
}

const W = wifTokenAbi as Abi;
const U = usdgAbi as Abi;
const S = paronSeriesTokenAbi as Abi;
const V = wifFlywheelVaultAbi as Abi;
const J = wifSlaJuryAbi as Abi;
const D = paronExchangeDeskAbi as Abi;

type Read = <T>(address: Address, abi: Abi, functionName: string, args?: unknown[]) => Promise<T>;

function reader(pub: PublicClient): Read {
  return <T,>(address: Address, abi: Abi, functionName: string, args: unknown[] = []) =>
    pub.readContract({ address, abi, functionName, args }) as Promise<T>;
}

const range = (from: number, to: number) => Array.from({ length: Math.max(0, to - from + 1) }, (_, i) => from + i);
const low = (a: string) => a.toLowerCase() as Address;

export async function readLiveSnapshot(pub: PublicClient, a: LiveAddresses, account: Address | null): Promise<ProtocolSnapshot> {
  const read = reader(pub);
  const block = await pub.getBlock();
  const [stats, cri, criAt, seriesCount, corridorCount, epochBn, boosted, genesis, epochLength, votingPeriod, ackWindow, deliveryWindow, challengeWindow, maxIndexAge, lotCount, redemptionCount, disputeCount, orderCount, wifSupply] =
    await Promise.all([
      read<Record<string, bigint>>(a.vault, V, "getFlywheelStats"),
      read<bigint>(a.desk, D, "criH100Usdg"),
      read<bigint>(a.desk, D, "criUpdatedAt"),
      read<bigint>(a.series, S, "seriesCount"),
      read<bigint>(a.series, S, "corridorCount"),
      read<bigint>(a.jury, J, "currentEpoch"),
      read<[boolean, number]>(a.jury, J, "currentBoostedCorridor"),
      read<bigint>(a.jury, J, "genesisTime"),
      read<bigint>(a.jury, J, "epochLength"),
      read<bigint>(a.jury, J, "votingPeriod"),
      read<bigint>(a.desk, D, "ackWindow"),
      read<bigint>(a.desk, D, "deliveryWindow"),
      read<bigint>(a.desk, D, "challengeWindow"),
      read<bigint>(a.desk, D, "maxIndexAge"),
      read<bigint>(a.desk, D, "lotCount"),
      read<bigint>(a.desk, D, "redemptionCount"),
      read<bigint>(a.jury, J, "disputeCount"),
      read<bigint>(a.desk, D, "orderCount"),
      read<bigint>(a.wif, W, "totalSupply"),
    ]);
  const epoch = Number(epochBn);
  const [tally, prevTally, prevFinalized, prevWinner, corridorsRaw] = await Promise.all([
    read<bigint[]>(a.jury, J, "getCorridorTally", [epochBn]),
    epoch > 0 ? read<bigint[]>(a.jury, J, "getCorridorTally", [BigInt(epoch - 1)]) : Promise.resolve([] as bigint[]),
    epoch > 0 ? read<boolean>(a.jury, J, "epochFinalized", [BigInt(epoch - 1)]) : Promise.resolve(false),
    epoch > 0 ? read<number>(a.jury, J, "epochWinner", [BigInt(epoch - 1)]) : Promise.resolve(0),
    Promise.all(range(0, Number(corridorCount) - 1).map((i) => read<{ code: string; name: string }>(a.series, S, "getCorridor", [i]))),
  ]);
  const corridors = corridorsRaw.map((c, i) => ({ id: i, code: c.code, name: c.name, votes: tally[i] ?? 0n }));
  const series: SeriesView[] = await Promise.all(
    range(1, Number(seriesCount)).map(async (id) => {
      const [info, market, bids, asks] = await Promise.all([
        read<{ symbol: string; corridorId: number; gpuTier: number; yymm: number; deliveryStart: bigint; deliveryEnd: bigint; creator: Address }>(a.series, S, "getSeries", [BigInt(id)]),
        read<Record<string, bigint>>(a.desk, D, "getSeriesMarket", [BigInt(id)]),
        read<[bigint[], bigint[]]>(a.desk, D, "getBookSide", [BigInt(id), true, 10n]),
        read<[bigint[], bigint[]]>(a.desk, D, "getBookSide", [BigInt(id), false, 10n]),
      ]);
      return {
        id,
        symbol: info.symbol,
        corridorId: Number(info.corridorId),
        corridorCode: corridors[Number(info.corridorId)]?.code ?? "?",
        corridorName: corridors[Number(info.corridorId)]?.name ?? "?",
        gpuTier: GPU_TIERS[Number(info.gpuTier)],
        yymm: Number(info.yymm),
        deliveryStart: info.deliveryStart,
        deliveryEnd: info.deliveryEnd,
        creator: low(info.creator),
        market: {
          bestBid: market.bestBid,
          bestAsk: market.bestAsk,
          lastTradePrice: market.lastTradePrice,
          volumeCu: market.volumeCu,
          volumeUsdg: market.volumeUsdg,
          tradeCount: Number(market.tradeCount),
          openInterestCu: market.openInterestCu,
          unsoldCu: market.unsoldCu,
        },
        bids: bids[0].map((price, i) => ({ price, qty: bids[1][i] })),
        asks: asks[0].map((price, i) => ({ price, qty: asks[1][i] })),
        boosted: boosted[0] && Number(boosted[1]) === Number(info.corridorId),
      };
    }),
  );

  const lots: Lot[] = await Promise.all(
    range(Math.max(1, Number(lotCount) - 99), Number(lotCount)).map(async (id) => {
      const l = await read<Record<string, bigint | boolean | string | number>>(a.desk, D, "getLot", [BigInt(id)]);
      return {
        id,
        seriesId: Number(l.seriesId),
        provider: low(String(l.provider)),
        cuMinted: l.cuMinted as bigint,
        cuUnsold: l.cuUnsold as bigint,
        cuOutstanding: l.cuOutstanding as bigint,
        askPrice: l.askPrice as bigint,
        marginBps: BigInt(l.marginBps as number),
        tier: Number(l.tier),
        closed: Boolean(l.closed),
        marginLocked: l.marginLocked as bigint,
        escrowUsdg: l.escrowUsdg as bigint,
        askOrderId: Number(l.askOrderId),
      };
    }),
  );

  const redemptions: Redemption[] = await Promise.all(
    range(Math.max(1, Number(redemptionCount) - 49), Number(redemptionCount)).map(async (id) => {
      const r = await read<Record<string, bigint | number | string>>(a.desk, D, "getRedemption", [BigInt(id)]);
      return {
        id,
        seriesId: Number(r.seriesId),
        lotId: Number(r.lotId),
        holder: low(String(r.holder)),
        provider: low(String(r.provider)),
        cuAmount: r.cuAmount as bigint,
        principalUsdg: r.principalUsdg as bigint,
        marginUsdg: r.marginUsdg as bigint,
        state: REDEMPTION_STATES[Number(r.state)],
        requestedAt: r.requestedAt as bigint,
        ackDeadline: r.ackDeadline as bigint,
        deliveryDeadline: r.deliveryDeadline as bigint,
        challengeDeadline: r.challengeDeadline as bigint,
        deliveryRef: r.deliveryRef as Hex,
        receiptHash: r.receiptHash as Hex,
        p95LatencyMs: Number(r.p95LatencyMs),
        uptimeBps: Number(r.uptimeBps),
        disputeId: Number(r.disputeId),
      };
    }),
  );

  const disputes: Dispute[] = await Promise.all(
    range(Math.max(1, Number(disputeCount) - 29), Number(disputeCount)).map(async (id) => {
      const [d, reason] = await Promise.all([read<Record<string, bigint | number | string>>(a.jury, J, "getDispute", [BigInt(id)]), read<string>(a.jury, J, "disputeReason", [BigInt(id)])]);
      return {
        id,
        redemptionId: Number(d.redemptionId),
        challenger: low(String(d.challenger)),
        evidenceHash: d.evidenceHash as Hex,
        reason,
        openedAt: d.openedAt as bigint,
        votingEndsAt: d.votingEndsAt as bigint,
        status: DISPUTE_STATUSES[Number(d.status)],
        voterCount: Number(d.voterCount),
        slashVotes: d.slashVotes as bigint,
        upholdVotes: d.upholdVotes as bigint,
        rewardPoolUsdg: d.rewardPoolUsdg as bigint,
        rewardPoolWif: d.rewardPoolWif as bigint,
        claimedUsdg: d.claimedUsdg as bigint,
        claimedWif: d.claimedWif as bigint,
      };
    }),
  );

  const providerAddrs = [...new Set([...lots.map((l) => l.provider), ...(account ? [low(account)] : [])])];
  const providers: ProviderView[] = (
    await Promise.all(
      providerAddrs.map(async (p) => {
        const [prof, staked, marginBps, claimable] = await Promise.all([
          read<Record<string, bigint | number | string | boolean>>(a.desk, D, "getProvider", [p]),
          read<bigint>(a.vault, V, "stakedWif", [p]),
          read<number>(a.vault, V, "getRequiredMarginBps", [p]),
          read<bigint>(a.desk, D, "providerClaimableUsdg", [p]),
        ]);
        if (!prof.registered) return null;
        const delivered = prof.deliveredCu as bigint;
        const slashed = prof.slashedCu as bigint;
        const view: ProviderView = {
          address: p,
          registered: true,
          metadataUri: String(prof.metadataUri),
          attestationSigner: /^0x0{40}$/i.test(String(prof.attestationSigner)) ? null : low(String(prof.attestationSigner)),
          registeredAt: prof.registeredAt as bigint,
          deliveredCu: delivered,
          slashedCu: slashed,
          deliveredCount: Number(prof.deliveredCount),
          slashedCount: Number(prof.slashedCount),
          stakedWif: staked,
          tier: staked >= 100_000n * 10n ** 18n ? 2 : staked >= 25_000n * 10n ** 18n ? 1 : 0,
          marginBps: BigInt(marginBps),
          claimableUsdg: claimable,
          openLots: lots.filter((l) => l.provider === p && !l.closed).length,
          reliabilityBps: delivered + slashed === 0n ? 10_000 : Number((delivered * 10_000n) / (delivered + slashed)),
        };
        return view;
      }),
    )
  ).filter((p): p is ProviderView => p !== null);

  const [burns, trades] = await Promise.all([recentBurns(pub, a, block.number), recentTrades(pub, a, block.number)]);
  const openInterestCu = series.reduce((acc, s) => acc + s.market.openInterestCu, 0n);

  let accountView: AccountView | null = null;
  if (account) accountView = await readAccount(pub, a, low(account), series.map((s) => s.id), disputes, Number(orderCount));

  return {
    mode: "live",
    chainId: appConfig.chainId,
    now: block.timestamp,
    block: Number(block.number),
    flywheel: {
      totalWifBurned: stats.totalWifBurned,
      totalWifStaked: stats.totalWifStaked,
      juryRewardPoolUsdg: stats.juryRewardPoolUsdg,
      buybackUsdgPool: stats.buybackUsdgPool,
      buybackReserveWif: stats.buybackReserveWif,
      juryBonusWifPool: stats.juryBonusWifPool,
      totalFeesUsdg: stats.totalFeesUsdg,
      totalRebatesDistributedUsdg: stats.totalRebatesDistributedUsdg,
      wifPriceUsdg: stats.wifPriceUsdg,
      burnCount: Number(stats.burnCount),
      openInterestCu,
      wifTotalSupply: wifSupply,
    },
    cri: { price: cri, updatedAt: criAt },
    corridors,
    epoch: {
      current: epoch,
      endsAt: genesis + BigInt(epoch + 1) * epochLength,
      boosted: { active: boosted[0], corridorId: Number(boosted[1]) },
      previousFinalized: prevFinalized,
      previousWinner: epoch > 0 && prevFinalized ? Number(prevWinner) : null,
      previousTotal: prevTally.reduce((x, y) => x + y, 0n),
      tally,
    },
    series,
    lots,
    providers,
    redemptions,
    disputes,
    burns,
    burnStats: burnStatsOf(burns),
    trades,
    account: accountView,
    params: { votingPeriod, epochLength, ackWindow, deliveryWindow, challengeWindow, maxIndexAge },
  };
}

function burnStatsOf(burns: BurnView[]): ProtocolSnapshot["burnStats"] {
  const by = new Map<string, { reason: string; amount: bigint; count: number }>();
  for (const b of burns) {
    const row = by.get(b.reason) ?? { reason: b.reason, amount: 0n, count: 0 };
    row.amount += b.wifBurned;
    row.count += 1;
    by.set(b.reason, row);
  }
  return [...by.values()].sort((x, y) => (y.amount > x.amount ? 1 : -1));
}

async function recentBurns(pub: PublicClient, a: LiveAddresses, head: bigint): Promise<BurnView[]> {
  try {
    const logs = await pub.getContractEvents({ address: a.vault, abi: V, eventName: "WifFlywheelBurned", fromBlock: head > 20_000n ? head - 20_000n : 0n });
    return logs
      .slice(-40)
      .reverse()
      .map((l, i) => {
        const args = (l as unknown as { args: Record<string, unknown> }).args;
        return {
          seq: i,
          timestamp: 0n,
          actor: low(String(args.actor)),
          wifBurned: args.wifBurned as bigint,
          totalWifBurned: args.totalWifBurned as bigint,
          reason: String(args.reason),
          txHash: l.transactionHash ?? "",
        };
      });
  } catch {
    return [];
  }
}

async function recentTrades(pub: PublicClient, a: LiveAddresses, head: bigint): Promise<TradeView[]> {
  try {
    const logs = await pub.getContractEvents({ address: a.desk, abi: D, eventName: "Trade", fromBlock: head > 20_000n ? head - 20_000n : 0n });
    return logs
      .slice(-60)
      .reverse()
      .map((l, i) => {
        const args = (l as unknown as { args: Record<string, unknown> }).args;
        return {
          seq: i,
          timestamp: 0n,
          seriesId: Number(args.seriesId),
          price: args.price as bigint,
          qty: args.qty as bigint,
          maker: low(String(args.maker)),
          taker: low(String(args.taker)),
          takerIsBuyer: Boolean(args.takerIsBuyer),
          primary: Number(args.lotId) !== 0,
        };
      });
  } catch {
    return [];
  }
}

async function readAccount(pub: PublicClient, a: LiveAddresses, me: Address, seriesIds: number[], disputes: Dispute[], orderCount: number): Promise<AccountView> {
  const read = reader(pub);
  const [wif, usdg, staked, lock, tier, marginBps, discount, earned, claimable, prof, faucetWifAt, faucetUsdgAt] = await Promise.all([
    read<bigint>(a.wif, W, "balanceOf", [me]),
    read<bigint>(a.usdg, U, "balanceOf", [me]),
    read<bigint>(a.vault, V, "stakedWif", [me]),
    read<bigint>(a.vault, V, "stakeLock", [me]),
    read<number>(a.vault, V, "getProviderTier", [me]),
    read<number>(a.vault, V, "getRequiredMarginBps", [me]),
    read<boolean>(a.vault, V, "hasWifFeeDiscount", [me]),
    read<bigint>(a.vault, V, "earnedRebate", [me]),
    read<bigint>(a.desk, D, "providerClaimableUsdg", [me]),
    read<Record<string, unknown>>(a.desk, D, "getProvider", [me]),
    read<bigint>(a.wif, W, "faucetAvailableAt", [me]).catch(() => 0n),
    read<bigint>(a.usdg, U, "faucetAvailableAt", [me]).catch(() => 0n),
  ]);
  const cu: Record<number, bigint> = {};
  await Promise.all(seriesIds.map(async (id) => (cu[id] = await read<bigint>(a.series, S, "balanceOf", [me, BigInt(id)]))));
  const orders: Order[] = (
    await Promise.all(
      range(Math.max(1, orderCount - 199), orderCount).map(async (id) => {
        const o = await read<Record<string, bigint | boolean | string | number>>(a.desk, D, "getOrder", [BigInt(id)]);
        if (low(String(o.maker)) !== me || !o.active) return null;
        const order: Order = {
          id,
          seriesId: Number(o.seriesId),
          maker: me,
          isBid: Boolean(o.isBid),
          wifDiscount: Boolean(o.wifDiscount),
          lane: Number(o.lane) === 0 ? 0 : 1,
          active: true,
          price: o.price as bigint,
          qtyRemaining: o.qtyRemaining as bigint,
          qtyOriginal: o.qtyRemaining as bigint,
          escrowUsdg: o.escrowUsdg as bigint,
          lotId: Number(o.lotId),
          createdAt: o.createdAt as bigint,
          prev: 0,
          next: 0,
        };
        return order;
      }),
    )
  ).filter((o): o is Order => o !== null);
  const pendingUpside: AccountView["pendingUpside"] = [];
  const votes: AccountView["votes"] = {};
  await Promise.all(
    disputes.map(async (d) => {
      const [up, slash, uphold, claimed] = await Promise.all([
        read<[bigint, bigint]>(a.jury, J, "pendingVoterUpside", [BigInt(d.id), me]),
        read<bigint>(a.jury, J, "slashWeightOf", [BigInt(d.id), me]),
        read<bigint>(a.jury, J, "upholdWeightOf", [BigInt(d.id), me]),
        read<boolean>(a.jury, J, "hasClaimed", [BigInt(d.id), me]),
      ]);
      if (up[0] > 0n || up[1] > 0n) pendingUpside.push({ disputeId: d.id, usdg: up[0], wif: up[1] });
      if (slash > 0n || uphold > 0n) votes[d.id] = { slash, uphold, claimed };
    }),
  );
  return {
    address: me,
    wif,
    usdg,
    stakedWif: staked,
    stakeLock: lock,
    tier: Number(tier),
    marginBps: BigInt(marginBps),
    wifDiscount: discount,
    earnedRebateUsdg: earned,
    claimableUsdg: claimable,
    cu,
    orders,
    registeredProvider: Boolean(prof.registered),
    faucetWifAt,
    faucetUsdgAt,
    pendingUpside,
    votes,
  };
}

/** Transaction sender with automatic max-approvals per (token, spender). */
export class LiveWriter {
  private readonly pub: PublicClient;
  private readonly wallet: WalletClient;
  readonly a: LiveAddresses;
  readonly account: Address;

  constructor(pub: PublicClient, wallet: WalletClient, a: LiveAddresses, account: Address) {
    this.pub = pub;
    this.wallet = wallet;
    this.a = a;
    this.account = account;
  }

  async send(address: Address, abi: Abi, functionName: string, args: unknown[] = []): Promise<Hex> {
    const { request } = await this.pub.simulateContract({ address, abi, functionName, args, account: this.account });
    const hash = await this.wallet.writeContract(request);
    const receipt = await this.pub.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`Transaction reverted: ${hash}`);
    return hash;
  }

  async allow(token: Address, spender: Address, amount: bigint): Promise<void> {
    const abi = token === this.a.usdg ? U : W;
    const current = (await this.pub.readContract({ address: token, abi, functionName: "allowance", args: [this.account, spender] })) as bigint;
    if (current < amount) await this.send(token, abi, "approve", [spender, maxUint256]);
  }

  faucet = async () => {
    await this.send(this.a.wif, W, "faucet");
    return this.send(this.a.usdg, U, "faucet");
  };
  stake = async (amount: bigint) => (await this.allow(this.a.wif, this.a.vault, amount), this.send(this.a.vault, V, "stakeWifForMarginBoost", [amount]));
  unstake = (amount: bigint) => this.send(this.a.vault, V, "unstakeWif", [amount]);
  claimRebate = () => this.send(this.a.vault, V, "claimProviderRebate");
  registerProvider = async (uri: string, stake: bigint) => {
    if (stake > 0n) await this.allow(this.a.wif, this.a.desk, stake);
    return this.send(this.a.desk, D, "registerProviderAndStakeWif", [uri, stake]);
  };
  mint = async (seriesId: number, cu: bigint, price: bigint, margin: bigint) => {
    await this.allow(this.a.usdg, this.a.desk, margin);
    return this.send(this.a.desk, D, "mintPrimarySeries", [BigInt(seriesId), cu, price]);
  };
  buy = async (seriesId: number, cu: bigint, maxPrice: bigint, wifMode: boolean) => {
    await this.allow(this.a.usdg, this.a.desk, cu * maxPrice * 2n);
    if (wifMode) await this.allow(this.a.wif, this.a.desk, 10n ** 27n);
    return this.send(this.a.desk, D, "buySeriesOrPlaceBid", [BigInt(seriesId), cu, maxPrice, wifMode]);
  };
  sell = (seriesId: number, cu: bigint, price: bigint) => this.send(this.a.desk, D, "placeAsk", [BigInt(seriesId), cu, price]);
  cancel = (orderId: number) => this.send(this.a.desk, D, "cancelOrder", [BigInt(orderId)]);
  requestRedemption = (seriesId: number, cu: bigint, lotId: number, ref: Hex) => this.send(this.a.desk, D, "requestRedemption", [BigInt(seriesId), cu, BigInt(lotId), ref]);
  acknowledge = (rid: number) => this.send(this.a.desk, D, "acknowledgeRedemption", [BigInt(rid)]);
  deliver = (rid: number, receipt: Hex, p95: number, uptime: number) => this.send(this.a.desk, D, "deliverWithReceipt", [BigInt(rid), receipt, p95, uptime, "0x"]);
  confirm = (rid: number) => this.send(this.a.desk, D, "confirmDelivery", [BigInt(rid)]);
  finalize = (rid: number) => this.send(this.a.desk, D, "finalizeDelivery", [BigInt(rid)]);
  claimMissed = (rid: number) => this.send(this.a.desk, D, "claimMissedDeadline", [BigInt(rid)]);
  settleCash = (seriesId: number, cu: bigint) => this.send(this.a.desk, D, "settleCashAtIndex", [BigInt(seriesId), cu]);
  withdraw = () => this.send(this.a.desk, D, "withdrawProviderBalance");
  openDispute = async (rid: number, evidence: Hex, reason: string) => (await this.allow(this.a.wif, this.a.jury, 10n ** 27n), this.send(this.a.jury, J, "openSlaDispute", [BigInt(rid), evidence, reason]));
  vote = async (did: number, slash: boolean, amount: bigint) => (await this.allow(this.a.wif, this.a.jury, amount), this.send(this.a.jury, J, "voteOnDisputeWithWifBurn", [BigInt(did), slash, amount]));
  resolve = (did: number) => this.send(this.a.jury, J, "resolveDispute", [BigInt(did)]);
  claimUpside = (did: number) => this.send(this.a.jury, J, "claimVoterUpside", [BigInt(did)]);
  voteCorridor = async (cid: number, amount: bigint) => (await this.allow(this.a.wif, this.a.jury, amount), this.send(this.a.jury, J, "voteForComputeCorridor", [cid, amount]));
  finalizeEpoch = (epoch: number) => this.send(this.a.jury, J, "finalizeCorridorEpoch", [BigInt(epoch)]);
}
