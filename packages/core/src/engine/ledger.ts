/**
 * ParonLedger: a contract-exact, deterministic, in-memory replica of the Paron WIF protocol.
 *
 * Every public method mirrors one external contract function (same checks, same order of
 * state changes, same integer rounding, same custom-error names, same events). Transactions
 * are atomic: a thrown ParonError rolls the whole state back, exactly like an EVM revert.
 *
 * This is what powers the zero-wallet 60-Second Coded Judge Tour and the local sandbox. The
 * golden parity test (fixtures/tour-golden.json) proves it matches the Solidity implementation.
 */
import { hashMessage, keccak256, encodeAbiParameters, toHex, type Hex as ViemHex } from "viem";
import { publicKeyToAddress } from "viem/accounts";
import { secp256k1 } from "@noble/curves/secp256k1";
import {
  BPS,
  BUYBACK_SELL_DISCOUNT_BPS,
  CORRIDOR_BOOST_MARGIN_BPS,
  DEFAULT_PARAMS,
  DISPUTE_FILING_BURN,
  FAUCET_COOLDOWN,
  FEE_BURN_SHARE_BPS,
  FEE_DISCOUNT_THRESHOLD,
  FEE_JURY_SHARE_BPS,
  GPU_TIERS,
  JURY_POOL_DRAW_BPS,
  JURY_WIF_BONUS_BPS,
  MARGIN_TIER0_BPS,
  MARGIN_TIER1_BPS,
  MARGIN_TIER2_BPS,
  MAX_FILLS_PER_TX,
  MAX_EVICTIONS_PER_TX,
  MAX_LEVELS,
  MAX_ORDERS_PER_MAKER,
  MIN_ORDER_NOTIONAL,
  MAX_LOT_SCAN,
  PRICE_TICK,
  REBATE_PRECISION,
  SETTLEMENT_GRACE,
  SIM_GENESIS_TIME,
  SLA_COMPENSATION_BPS,
  SLA_MAX_P95_LATENCY_MS,
  SLA_MIN_UPTIME_BPS,
  SLASH_BURN_SHARE_BPS,
  SLASH_VOTER_SHARE_BPS,
  STANDARD_FEE_BPS,
  TIER1_STAKE,
  TIER2_STAKE,
  USDG_FAUCET_AMOUNT,
  WIF,
  WIF_FAUCET_AMOUNT,
  WIF_FEE_BPS,
  type GpuTier,
  type WorldParams,
} from "../constants.ts";
import { ceilDiv, deliveryWindow, min } from "../math.ts";
import type {
  Address,
  Corridor,
  Dispute,
  EventArgs,
  Hex,
  Lot,
  Order,
  ParonEvent,
  ProviderProfile,
  Redemption,
  SeriesInfo,
} from "../types.ts";
import { ParonError } from "./errors.ts";

type TokenState = {
  balances: Map<Address, bigint>;
  totalSupply: bigint;
  totalBurned: bigint;
  lastFaucetAt: Map<Address, bigint>;
};

type Level = { head: [number, number]; tail: [number, number]; qty: bigint };

export type SystemAddresses = {
  deployer: Address;
  treasury: Address;
  attestor: Address;
  wifToken: Address;
  usdgToken: Address;
  seriesToken: Address;
  vault: Address;
  desk: Address;
  jury: Address;
};

export type LedgerState = {
  now: bigint;
  block: number;
  params: WorldParams;
  addr: SystemAddresses;
  wif: TokenState;
  usdg: TokenState;
  cu: Map<string, bigint>;
  cuSupply: Map<number, bigint>;
  corridors: Corridor[];
  series: Map<number, SeriesInfo>;
  seriesKeys: Map<string, number>;
  seriesCount: number;
  vault: {
    wifPriceUsdg: bigint;
    priceOracle: Address;
    stakedWif: Map<Address, bigint>;
    stakeLock: Map<Address, bigint>;
    totalWifStaked: bigint;
    rebatePerWifStored: bigint;
    rebatePerWifPaid: Map<Address, bigint>;
    rebateAccrued: Map<Address, bigint>;
    juryRewardPoolUsdg: bigint;
    buybackUsdgPool: bigint;
    buybackReserveWif: bigint;
    juryBonusWifPool: bigint;
    totalWifBurnedByParon: bigint;
    totalFeesUsdg: bigint;
    totalRebatesDistributedUsdg: bigint;
    burnCount: number;
  };
  desk: {
    criH100Usdg: bigint;
    criUpdatedAt: bigint;
    criSourceHash: Hex;
    providers: Map<Address, ProviderProfile>;
    providerOrder: Address[];
    claimable: Map<Address, bigint>;
    openLotsAtTier: Map<string, number>;
    lotCount: number;
    lots: Map<number, Lot>;
    seriesLots: Map<number, number[]>;
    lotCursor: Map<number, number>;
    orderCount: number;
    orders: Map<number, Order>;
    levels: Map<string, bigint[]>;
    levelOf: Map<string, Level>;
    makerOrders: Map<string, number>;
    unsoldCu: Map<number, bigint>;
    lastTradePrice: Map<number, bigint>;
    volumeCu: Map<number, bigint>;
    volumeUsdg: Map<number, bigint>;
    tradeCount: Map<number, number>;
    redemptionCount: number;
    redemptions: Map<number, Redemption>;
  };
  jury: {
    genesisTime: bigint;
    disputeCount: number;
    disputes: Map<number, Dispute>;
    slashWeight: Map<string, bigint>;
    upholdWeight: Map<string, bigint>;
    claimed: Set<string>;
    corridorVotes: Map<string, bigint>;
    corridorVotesOf: Map<string, bigint>;
    epochTotalVotes: Map<number, bigint>;
    epochFinalized: Set<number>;
    epochWinner: Map<number, number>;
  };
  events: ParonEvent[];
  eventSeq: number;
  txSeq: number;
};

export type SeriesMarket = {
  bestBid: bigint;
  bestAsk: bigint;
  lastTradePrice: bigint;
  volumeCu: bigint;
  volumeUsdg: bigint;
  tradeCount: number;
  openInterestCu: bigint;
  unsoldCu: bigint;
};

export type FlywheelStats = {
  totalWifBurned: bigint;
  totalWifStaked: bigint;
  juryRewardPoolUsdg: bigint;
  buybackUsdgPool: bigint;
  buybackReserveWif: bigint;
  juryBonusWifPool: bigint;
  totalFeesUsdg: bigint;
  totalRebatesDistributedUsdg: bigint;
  wifPriceUsdg: bigint;
  burnCount: number;
};

/** Deterministic labelled address (sim only): last 20 bytes of keccak256("paron-wif:" + label). */
export function labelAddress(label: string): Address {
  const h = keccak256(toHex(`paron-wif:${label}`));
  return `0x${h.slice(26)}` as Address;
}

export function defaultSystemAddresses(): SystemAddresses {
  return {
    deployer: labelAddress("system:deployer"),
    treasury: labelAddress("system:treasury"),
    attestor: labelAddress("system:cri-attestor"),
    wifToken: labelAddress("contract:WifTokenMock"),
    usdgToken: labelAddress("contract:UsdgMock"),
    seriesToken: labelAddress("contract:ParonSeriesToken"),
    vault: labelAddress("contract:WifFlywheelVault"),
    desk: labelAddress("contract:ParonExchangeDesk"),
    jury: labelAddress("contract:WifSlaJury"),
  };
}

const lower = (a: string) => a.toLowerCase() as Address;
const makerKey = (seriesId: number, isBid: boolean, maker: string) => `${seriesId}:${isBid ? "b" : "a"}:${maker.toLowerCase()}`;
const sideKey = (seriesId: number, isBid: boolean) => `${seriesId}:${isBid ? "b" : "a"}`;
const levelKey = (seriesId: number, isBid: boolean, price: bigint) => `${seriesId}:${isBid ? "b" : "a"}:${price}`;
const pairKey = (a: number | string, b: string) => `${a}:${lower(b)}`;

function newToken(): TokenState {
  return { balances: new Map(), totalSupply: 0n, totalBurned: 0n, lastFaucetAt: new Map() };
}

export type LedgerOptions = {
  params?: Partial<WorldParams>;
  genesisTime?: bigint;
  addresses?: Partial<SystemAddresses>;
};

export class ParonLedger {
  s: LedgerState;

  constructor(options: LedgerOptions = {}) {
    const params: WorldParams = { ...DEFAULT_PARAMS, ...options.params };
    const addr = { ...defaultSystemAddresses(), ...options.addresses };
    const now = options.genesisTime ?? SIM_GENESIS_TIME;
    this.s = {
      now,
      block: 1,
      params,
      addr: Object.fromEntries(Object.entries(addr).map(([k, v]) => [k, lower(v)])) as SystemAddresses,
      wif: newToken(),
      usdg: newToken(),
      cu: new Map(),
      cuSupply: new Map(),
      corridors: [],
      series: new Map(),
      seriesKeys: new Map(),
      seriesCount: 0,
      vault: {
        wifPriceUsdg: params.wifPriceUsdg,
        priceOracle: lower(addr.deployer),
        stakedWif: new Map(),
        stakeLock: new Map(),
        totalWifStaked: 0n,
        rebatePerWifStored: 0n,
        rebatePerWifPaid: new Map(),
        rebateAccrued: new Map(),
        juryRewardPoolUsdg: 0n,
        buybackUsdgPool: 0n,
        buybackReserveWif: 0n,
        juryBonusWifPool: 0n,
        totalWifBurnedByParon: 0n,
        totalFeesUsdg: 0n,
        totalRebatesDistributedUsdg: 0n,
        burnCount: 0,
      },
      desk: {
        criH100Usdg: 0n,
        criUpdatedAt: 0n,
        criSourceHash: "0x",
        providers: new Map(),
        providerOrder: [],
        claimable: new Map(),
        openLotsAtTier: new Map(),
        lotCount: 0,
        lots: new Map(),
        seriesLots: new Map(),
        lotCursor: new Map(),
        orderCount: 0,
        orders: new Map(),
        levels: new Map(),
        levelOf: new Map(),
        makerOrders: new Map(),
        unsoldCu: new Map(),
        lastTradePrice: new Map(),
        volumeCu: new Map(),
        volumeUsdg: new Map(),
        tradeCount: new Map(),
        redemptionCount: 0,
        redemptions: new Map(),
      },
      jury: {
        genesisTime: now,
        disputeCount: 0,
        disputes: new Map(),
        slashWeight: new Map(),
        upholdWeight: new Map(),
        claimed: new Set(),
        corridorVotes: new Map(),
        corridorVotesOf: new Map(),
        epochTotalVotes: new Map(),
        epochFinalized: new Set(),
        epochWinner: new Map(),
      },
      events: [],
      eventSeq: 0,
      txSeq: 0,
    };
  }

  clone(): ParonLedger {
    const copy = Object.create(ParonLedger.prototype) as ParonLedger;
    copy.s = structuredClone(this.s);
    return copy;
  }

  // ==================================================================
  // Clock, transactions, events
  // ==================================================================

  get now(): bigint {
    return this.s.now;
  }

  get addr(): SystemAddresses {
    return this.s.addr;
  }

  get params(): WorldParams {
    return this.s.params;
  }

  advance(seconds: bigint | number): void {
    this.s.now += BigInt(seconds);
  }

  setTime(timestamp: bigint): void {
    if (timestamp < this.s.now) throw new ParonError("TimeTravel");
    this.s.now = timestamp;
  }

  private currentTx: Hex = "0x";

  /** Runs `fn` atomically: any thrown error restores the full pre-transaction state. */
  private tx<T>(fn: () => T): T {
    const backup = structuredClone(this.s);
    this.s.txSeq += 1;
    this.currentTx = keccak256(toHex(`paron-wif-sim-tx:${this.s.txSeq}`)) as Hex;
    try {
      const result = fn();
      this.s.block += 1;
      return result;
    } catch (error) {
      this.s = backup;
      throw error;
    }
  }

  private emit(contract: ParonEvent["contract"], name: string, args: EventArgs): void {
    this.s.eventSeq += 1;
    this.s.events.push({
      seq: this.s.eventSeq,
      block: this.s.block,
      timestamp: this.s.now,
      txHash: this.currentTx,
      contract,
      name,
      args,
    });
  }

  // ==================================================================
  // Token primitives (WIF 18d, USDG 6d, ERC-1155 CU)
  // ==================================================================

  wifBalance(a: Address): bigint {
    return this.s.wif.balances.get(lower(a)) ?? 0n;
  }

  usdgBalance(a: Address): bigint {
    return this.s.usdg.balances.get(lower(a)) ?? 0n;
  }

  cuBalance(a: Address, seriesId: number): bigint {
    return this.s.cu.get(pairKey(seriesId, a)) ?? 0n;
  }

  cuTotalSupply(seriesId: number): bigint {
    return this.s.cuSupply.get(seriesId) ?? 0n;
  }

  wifTotalSupply(): bigint {
    return this.s.wif.totalSupply;
  }

  wifTotalBurned(): bigint {
    return this.s.wif.totalBurned;
  }

  private move(token: TokenState, from: Address, to: Address, amount: bigint): void {
    if (amount === 0n) return;
    const f = lower(from);
    const have = token.balances.get(f) ?? 0n;
    if (have < amount) throw new ParonError("InsufficientBalance", { account: f, have, need: amount });
    token.balances.set(f, have - amount);
    const t = lower(to);
    token.balances.set(t, (token.balances.get(t) ?? 0n) + amount);
  }

  private mintToken(token: TokenState, to: Address, amount: bigint): void {
    const t = lower(to);
    token.balances.set(t, (token.balances.get(t) ?? 0n) + amount);
    token.totalSupply += amount;
  }

  /** WifTokenMock._burn + _recordBurn. */
  private burnWif(from: Address, amount: bigint): void {
    const f = lower(from);
    const have = this.s.wif.balances.get(f) ?? 0n;
    if (have < amount) throw new ParonError("InsufficientBalance", { account: f, have, need: amount });
    this.s.wif.balances.set(f, have - amount);
    this.s.wif.totalSupply -= amount;
    this.s.wif.totalBurned += amount;
    this.emit("WifToken", "WifBurned", { account: f, amount, totalBurned: this.s.wif.totalBurned });
  }

  private cuMove(seriesId: number, from: Address, to: Address, amount: bigint): void {
    if (amount === 0n) return;
    const fk = pairKey(seriesId, from);
    const have = this.s.cu.get(fk) ?? 0n;
    if (have < amount) throw new ParonError("InsufficientCu", { account: lower(from), seriesId, have, need: amount });
    this.s.cu.set(fk, have - amount);
    const tk = pairKey(seriesId, to);
    this.s.cu.set(tk, (this.s.cu.get(tk) ?? 0n) + amount);
  }

  private cuMint(seriesId: number, to: Address, amount: bigint): void {
    const tk = pairKey(seriesId, to);
    this.s.cu.set(tk, (this.s.cu.get(tk) ?? 0n) + amount);
    this.s.cuSupply.set(seriesId, this.cuTotalSupply(seriesId) + amount);
  }

  private cuBurn(seriesId: number, from: Address, amount: bigint): void {
    const fk = pairKey(seriesId, from);
    const have = this.s.cu.get(fk) ?? 0n;
    if (have < amount) throw new ParonError("InsufficientCu", { account: lower(from), seriesId, have, need: amount });
    this.s.cu.set(fk, have - amount);
    this.s.cuSupply.set(seriesId, this.cuTotalSupply(seriesId) - amount);
  }

  /** Owner mint used by deployment seeding (WifTokenMock.mint / UsdgMock.mint). */
  mintWif(to: Address, amount: bigint): void {
    this.tx(() => this.mintToken(this.s.wif, to, amount));
  }

  mintUsdg(to: Address, amount: bigint): void {
    this.tx(() => this.mintToken(this.s.usdg, to, amount));
  }

  faucetAvailableAt(token: "WIF" | "USDG", account: Address): bigint {
    const t = token === "WIF" ? this.s.wif : this.s.usdg;
    const last = t.lastFaucetAt.get(lower(account)) ?? 0n;
    return last === 0n ? 0n : last + FAUCET_COOLDOWN;
  }

  faucetWif(caller: Address): void {
    this.tx(() => this.faucet("WIF", caller));
  }

  faucetUsdg(caller: Address): void {
    this.tx(() => this.faucet("USDG", caller));
  }

  /** Header button: "Mint 50,000 $WIF + 10,000 USDG" in one click. */
  faucetBoth(caller: Address): void {
    this.tx(() => {
      this.faucet("WIF", caller);
      this.faucet("USDG", caller);
    });
  }

  private faucet(token: "WIF" | "USDG", caller: Address): void {
    const availableAt = this.faucetAvailableAt(token, caller);
    if (this.s.now < availableAt) throw new ParonError("FaucetCooldown", { availableAt });
    const t = token === "WIF" ? this.s.wif : this.s.usdg;
    t.lastFaucetAt.set(lower(caller), this.s.now);
    const amount = token === "WIF" ? WIF_FAUCET_AMOUNT : USDG_FAUCET_AMOUNT;
    this.mintToken(t, caller, amount);
    this.emit(token === "WIF" ? "WifToken" : "Usdg", "FaucetDrip", { account: lower(caller), amount });
  }

  /** Plain ERC-20 transfer (used by agents, the sandbox wallet and seeding). */
  transferWif(from: Address, to: Address, amount: bigint): void {
    this.tx(() => this.move(this.s.wif, from, to, amount));
  }

  transferUsdg(from: Address, to: Address, amount: bigint): void {
    this.tx(() => this.move(this.s.usdg, from, to, amount));
  }

  // ==================================================================
  // ParonSeriesToken
  // ==================================================================

  registerCorridor(code: string, name: string): number {
    return this.tx(() => {
      if (code.length < 2 || code.length > 4) throw new ParonError("InvalidCode");
      const id = this.s.corridors.length;
      this.s.corridors.push({ id, code, name });
      this.emit("ParonSeriesToken", "CorridorRegistered", { corridorId: id, code, name });
      return id;
    });
  }

  createSeries(caller: Address, corridorId: number, gpuTier: GpuTier, yymm: number): number {
    return this.tx(() => {
      if (corridorId >= this.s.corridors.length) throw new ParonError("UnknownCorridor", { corridorId });
      const yy = Math.floor(yymm / 100);
      const mm = yymm % 100;
      if (yy < 25 || mm === 0 || mm > 12) throw new ParonError("InvalidDeliveryMonth", { yymm });
      const key = `${corridorId}:${gpuTier}:${yymm}`;
      const existing = this.s.seriesKeys.get(key);
      if (existing) throw new ParonError("SeriesExists", { seriesId: existing });
      const { start, end } = deliveryWindow(yymm);
      const symbol = `CU-${this.s.corridors[corridorId].code}-${gpuTier}-${String(yymm).padStart(4, "0")}`;
      const id = ++this.s.seriesCount;
      this.s.seriesKeys.set(key, id);
      this.s.series.set(id, {
        id,
        symbol,
        corridorId,
        gpuTier,
        yymm,
        deliveryStart: start,
        deliveryEnd: end,
        creator: lower(caller),
      });
      this.emit("ParonSeriesToken", "SeriesCreated", {
        seriesId: id,
        symbol,
        corridorId,
        gpuTier: GPU_TIERS.indexOf(gpuTier),
        yymm,
        deliveryStart: start,
        deliveryEnd: end,
        creator: lower(caller),
      });
      return id;
    });
  }

  getSeries(seriesId: number): SeriesInfo {
    const s = this.s.series.get(seriesId);
    if (!s) throw new ParonError("UnknownSeries", { seriesId });
    return s;
  }

  listSeries(): SeriesInfo[] {
    return [...this.s.series.values()];
  }

  listCorridors(): Corridor[] {
    return this.s.corridors;
  }

  // ==================================================================
  // WifFlywheelVault
  // ==================================================================

  getProviderTier(provider: Address): number {
    const staked = this.stakedWif(provider);
    if (staked >= TIER2_STAKE) return 2;
    if (staked >= TIER1_STAKE) return 1;
    return 0;
  }

  getRequiredMarginBps(provider: Address): bigint {
    const tier = this.getProviderTier(provider);
    return tier === 2 ? MARGIN_TIER2_BPS : tier === 1 ? MARGIN_TIER1_BPS : MARGIN_TIER0_BPS;
  }

  hasWifFeeDiscount(trader: Address): boolean {
    return this.wifBalance(trader) + this.stakedWif(trader) >= FEE_DISCOUNT_THRESHOLD;
  }

  stakedWif(account: Address): bigint {
    return this.s.vault.stakedWif.get(lower(account)) ?? 0n;
  }

  stakeLock(account: Address): bigint {
    return this.s.vault.stakeLock.get(lower(account)) ?? 0n;
  }

  earnedRebate(account: Address): bigint {
    const v = this.s.vault;
    const a = lower(account);
    return (v.rebateAccrued.get(a) ?? 0n) +
      (this.stakedWif(a) * (v.rebatePerWifStored - (v.rebatePerWifPaid.get(a) ?? 0n))) / REBATE_PRECISION;
  }

  flywheelStats(): FlywheelStats {
    const v = this.s.vault;
    return {
      totalWifBurned: v.totalWifBurnedByParon,
      totalWifStaked: v.totalWifStaked,
      juryRewardPoolUsdg: v.juryRewardPoolUsdg,
      buybackUsdgPool: v.buybackUsdgPool,
      buybackReserveWif: v.buybackReserveWif,
      juryBonusWifPool: v.juryBonusWifPool,
      totalFeesUsdg: v.totalFeesUsdg,
      totalRebatesDistributedUsdg: v.totalRebatesDistributedUsdg,
      wifPriceUsdg: v.wifPriceUsdg,
      burnCount: v.burnCount,
    };
  }

  setWifPrice(caller: Address, priceUsdg: bigint): void {
    this.tx(() => {
      if (lower(caller) !== this.s.vault.priceOracle) throw new ParonError("NotOracle");
      if (priceUsdg === 0n) throw new ParonError("InvalidPrice");
      this.s.vault.wifPriceUsdg = priceUsdg;
      this.emit("WifFlywheelVault", "WifPriceUpdated", { priceUsdg });
    });
  }

  stakeWifForMarginBoost(caller: Address, amount: bigint): void {
    this.tx(() => this.vaultStake(caller, caller, amount));
  }

  unstakeWif(caller: Address, amount: bigint): void {
    this.tx(() => {
      if (amount === 0n) throw new ParonError("ZeroAmount");
      const a = lower(caller);
      const staked = this.stakedWif(a);
      if (amount > staked) throw new ParonError("InsufficientStake", { staked, requested: amount });
      const lockAmount = this.stakeLock(a);
      if (staked - amount < lockAmount) throw new ParonError("StakeLocked", { lockAmount });
      this.vaultAccrue(a);
      this.s.vault.stakedWif.set(a, staked - amount);
      this.s.vault.totalWifStaked -= amount;
      this.move(this.s.wif, this.s.addr.vault, a, amount);
      this.emit("WifFlywheelVault", "WifUnstaked", {
        account: a,
        amount,
        stakedTotal: staked - amount,
        tier: this.getProviderTier(a),
      });
    });
  }

  claimProviderRebate(caller: Address): bigint {
    return this.tx(() => {
      const a = lower(caller);
      this.vaultAccrue(a);
      const amount = this.s.vault.rebateAccrued.get(a) ?? 0n;
      if (amount === 0n) throw new ParonError("ZeroAmount");
      this.s.vault.rebateAccrued.set(a, 0n);
      this.move(this.s.usdg, this.s.addr.vault, a, amount);
      this.emit("WifFlywheelVault", "ProviderRebateClaimed", { account: a, amount });
      return amount;
    });
  }

  sellWifToBuyback(caller: Address, wifAmount: bigint, minUsdgOut: bigint): bigint {
    return this.tx(() => {
      const v = this.s.vault;
      if (wifAmount === 0n) throw new ParonError("ZeroAmount");
      const gross = (wifAmount * v.wifPriceUsdg) / WIF;
      const out = (gross * (BPS - BUYBACK_SELL_DISCOUNT_BPS)) / BPS;
      if (out === 0n) throw new ParonError("ZeroAmount");
      if (out < minUsdgOut) throw new ParonError("Slippage", { out, minOut: minUsdgOut });
      if (out > v.buybackUsdgPool) throw new ParonError("InsufficientBuybackPool", { available: v.buybackUsdgPool, needed: out });
      v.buybackUsdgPool -= out;
      this.move(this.s.wif, caller, this.s.addr.vault, wifAmount);
      this.vaultBurnHeld(wifAmount);
      this.move(this.s.usdg, this.s.addr.vault, caller, out);
      this.vaultRecordBurn(caller, wifAmount, 0n, "BUYBACK_SELL");
      this.emit("WifFlywheelVault", "WifSoldToBuyback", { seller: lower(caller), wifAmount, usdgOut: out });
      return out;
    });
  }

  fundBuybackReserve(caller: Address, amount: bigint): void {
    this.tx(() => {
      if (amount === 0n) throw new ParonError("ZeroAmount");
      this.move(this.s.wif, caller, this.s.addr.vault, amount);
      this.s.vault.buybackReserveWif += amount;
      this.emit("WifFlywheelVault", "BuybackReserveFunded", { from: lower(caller), amount });
      this.vaultBuybackAndBurn(caller, 0n, 0n, "BUYBACK_FLUSH");
    });
  }

  fundJuryBonusWif(caller: Address, amount: bigint): void {
    this.tx(() => {
      if (amount === 0n) throw new ParonError("ZeroAmount");
      this.move(this.s.wif, caller, this.s.addr.vault, amount);
      this.s.vault.juryBonusWifPool += amount;
      this.emit("WifFlywheelVault", "JuryBonusFunded", { from: lower(caller), amount });
    });
  }

  fundJuryRewardPool(caller: Address, amount: bigint): void {
    this.tx(() => {
      if (amount === 0n) throw new ParonError("ZeroAmount");
      this.move(this.s.usdg, caller, this.s.addr.vault, amount);
      this.s.vault.juryRewardPoolUsdg += amount;
      this.emit("WifFlywheelVault", "JuryRewardPoolFunded", { from: lower(caller), amount });
    });
  }

  // ---- vault internals ----

  private vaultStake(from: Address, account: Address, amount: bigint): void {
    if (amount === 0n) throw new ParonError("ZeroAmount");
    const a = lower(account);
    this.vaultAccrue(a);
    this.move(this.s.wif, from, this.s.addr.vault, amount);
    const staked = this.stakedWif(a) + amount;
    this.s.vault.stakedWif.set(a, staked);
    this.s.vault.totalWifStaked += amount;
    this.emit("WifFlywheelVault", "WifStaked", { account: a, amount, stakedTotal: staked, tier: this.getProviderTier(a) });
  }

  private vaultAccrue(account: Address): void {
    const v = this.s.vault;
    const stored = v.rebatePerWifStored;
    const paid = v.rebatePerWifPaid.get(account) ?? 0n;
    if (stored !== paid) {
      v.rebateAccrued.set(account, (v.rebateAccrued.get(account) ?? 0n) + (this.stakedWif(account) * (stored - paid)) / REBATE_PRECISION);
      v.rebatePerWifPaid.set(account, stored);
    }
  }

  private vaultDistributeRebate(amount: bigint): void {
    const v = this.s.vault;
    if (amount === 0n) return;
    if (v.totalWifStaked === 0n) {
      v.juryRewardPoolUsdg += amount;
      return;
    }
    v.rebatePerWifStored += (amount * REBATE_PRECISION) / v.totalWifStaked;
    v.totalRebatesDistributedUsdg += amount;
  }

  private vaultBurnHeld(amount: bigint): void {
    if (this.s.params.nativeBurn) this.burnWif(this.s.addr.vault, amount);
    else this.move(this.s.wif, this.s.addr.vault, "0x000000000000000000000000000000000000dead", amount);
  }

  private vaultRecordBurn(actor: Address, amount: bigint, vaultUsdgAdded: bigint, reason: string): void {
    const v = this.s.vault;
    v.totalWifBurnedByParon += amount;
    v.burnCount += 1;
    this.emit("WifFlywheelVault", "WifFlywheelBurned", {
      actor: lower(actor),
      wifBurned: amount,
      totalWifBurned: v.totalWifBurnedByParon,
      vaultUsdgAdded,
      reason,
    });
  }

  private vaultBuybackAndBurn(actor: Address, usdgAmount: bigint, vaultUsdgAdded: bigint, reason: string): bigint {
    const v = this.s.vault;
    v.buybackUsdgPool += usdgAmount;
    const price = v.wifPriceUsdg;
    const wifWanted = (v.buybackUsdgPool * WIF) / price;
    const wifToBurn = min(wifWanted, v.buybackReserveWif);
    if (wifToBurn === 0n) return 0n;
    const usdgSpent = (wifToBurn * price) / WIF;
    v.buybackUsdgPool -= usdgSpent;
    v.buybackReserveWif -= wifToBurn;
    if (usdgSpent > 0n) this.move(this.s.usdg, this.s.addr.vault, this.s.addr.treasury, usdgSpent);
    this.vaultBurnHeld(wifToBurn);
    this.vaultRecordBurn(actor, wifToBurn, vaultUsdgAdded, reason);
    return wifToBurn;
  }

  /** WifFlywheelVault.processProtocolFeeAndBurn, called by the desk with its own balance. */
  private vaultProcessFee(payer: Address, usdgFee: bigint, wifBurnAmount: bigint, reason: string): bigint {
    const v = this.s.vault;
    if (usdgFee === 0n) return 0n;
    const burnLeg = (usdgFee * FEE_BURN_SHARE_BPS) / BPS;
    const juryLeg = (usdgFee * FEE_JURY_SHARE_BPS) / BPS;
    const providerLeg = usdgFee - burnLeg - juryLeg;
    const wifMode = wifBurnAmount > 0n;
    this.move(this.s.usdg, this.s.addr.desk, this.s.addr.vault, wifMode ? usdgFee - burnLeg : usdgFee);
    v.totalFeesUsdg += usdgFee;
    v.juryRewardPoolUsdg += juryLeg;
    this.vaultDistributeRebate(providerLeg);
    let burned: bigint;
    if (wifMode) {
      this.move(this.s.wif, this.s.addr.desk, this.s.addr.vault, wifBurnAmount);
      this.vaultBurnHeld(wifBurnAmount);
      this.vaultRecordBurn(payer, wifBurnAmount, juryLeg + providerLeg, reason);
      burned = wifBurnAmount;
    } else {
      burned = this.vaultBuybackAndBurn(payer, burnLeg, juryLeg + providerLeg, reason);
    }
    this.emit("WifFlywheelVault", "ProtocolFeeRouted", {
      payer: lower(payer),
      usdgFee,
      burnLeg,
      juryLeg,
      providerLeg,
      wifMode,
    });
    return burned;
  }

  private vaultProcessSlashProceeds(provider: Address, burnUsdg: bigint, vaultUsdg: bigint, reason: string): bigint {
    const total = burnUsdg + vaultUsdg;
    if (total === 0n) return 0n;
    this.move(this.s.usdg, this.s.addr.desk, this.s.addr.vault, total);
    this.s.vault.juryRewardPoolUsdg += vaultUsdg;
    const wifBurned = this.vaultBuybackAndBurn(provider, burnUsdg, vaultUsdg, reason);
    this.emit("WifFlywheelVault", "SlashProceedsRouted", { provider: lower(provider), burnUsdg, vaultUsdg, wifBurned });
    return wifBurned;
  }

  private vaultDrawJuryReward(bps: bigint, cap: bigint): bigint {
    const v = this.s.vault;
    let out = (v.juryRewardPoolUsdg * bps) / BPS;
    if (out > cap) out = cap;
    if (out === 0n) return 0n;
    v.juryRewardPoolUsdg -= out;
    this.move(this.s.usdg, this.s.addr.vault, this.s.addr.jury, out);
    this.emit("WifFlywheelVault", "JuryRewardDrawn", { amount: out, poolAfter: v.juryRewardPoolUsdg });
    return out;
  }

  private vaultDrawJuryBonusWif(wifWanted: bigint): bigint {
    const v = this.s.vault;
    const out = min(wifWanted, v.juryBonusWifPool);
    if (out === 0n) return 0n;
    v.juryBonusWifPool -= out;
    this.move(this.s.wif, this.s.addr.vault, this.s.addr.jury, out);
    this.emit("WifFlywheelVault", "JuryBonusDrawn", { amount: out, poolAfter: v.juryBonusWifPool });
    return out;
  }

  private vaultSetStakeLock(provider: Address, lockAmount: bigint): void {
    this.s.vault.stakeLock.set(lower(provider), lockAmount);
    this.emit("WifFlywheelVault", "StakeLockUpdated", { provider: lower(provider), lockAmount });
  }

  // ==================================================================
  // ParonExchangeDesk: index, providers
  // ==================================================================

  attestReferenceIndex(caller: Address, priceUsdgPerCu: bigint, sourceHash: Hex): void {
    this.tx(() => {
      if (lower(caller) !== this.s.addr.attestor) throw new ParonError("NotIndexAttestor");
      if (priceUsdgPerCu === 0n) throw new ParonError("InvalidPrice");
      const d = this.s.desk;
      d.criH100Usdg = priceUsdgPerCu;
      d.criUpdatedAt = this.s.now;
      d.criSourceHash = sourceHash;
      this.emit("ParonExchangeDesk", "ReferenceIndexAttested", { priceUsdgPerCu, sourceHash, timestamp: this.s.now });
    });
  }

  registerProviderAndStakeWif(caller: Address, metadataUri: string, wifStakeAmount: bigint): void {
    this.tx(() => {
      const a = lower(caller);
      const d = this.s.desk;
      let p = d.providers.get(a);
      if (!p) {
        p = {
          address: a,
          registered: true,
          metadataUri,
          attestationSigner: null,
          registeredAt: this.s.now,
          deliveredCu: 0n,
          slashedCu: 0n,
          deliveredCount: 0,
          slashedCount: 0,
        };
        d.providers.set(a, p);
        d.providerOrder.push(a);
      }
      p.metadataUri = metadataUri;
      if (wifStakeAmount > 0n) {
        this.move(this.s.wif, a, this.s.addr.desk, wifStakeAmount);
        this.vaultStake(this.s.addr.desk, a, wifStakeAmount);
      }
      this.emit("ParonExchangeDesk", "ProviderRegistered", {
        provider: a,
        metadataUri,
        wifStaked: wifStakeAmount,
        totalStaked: this.stakedWif(a),
      });
    });
  }

  setAttestationSigner(caller: Address, signer: Address): void {
    this.tx(() => {
      const p = this.s.desk.providers.get(lower(caller));
      if (!p) throw new ParonError("NotRegisteredProvider");
      p.attestationSigner = signer === "0x0000000000000000000000000000000000000000" ? null : lower(signer);
      this.emit("ParonExchangeDesk", "AttestationSignerSet", { provider: lower(caller), signer: lower(signer) });
    });
  }

  withdrawProviderBalance(caller: Address): bigint {
    return this.tx(() => {
      const a = lower(caller);
      const amount = this.s.desk.claimable.get(a) ?? 0n;
      if (amount === 0n) throw new ParonError("ZeroAmount");
      this.s.desk.claimable.set(a, 0n);
      this.move(this.s.usdg, this.s.addr.desk, a, amount);
      this.emit("ParonExchangeDesk", "ProviderWithdrawal", { provider: a, amount });
      return amount;
    });
  }

  getProvider(provider: Address): ProviderProfile | undefined {
    return this.s.desk.providers.get(lower(provider));
  }

  listProviders(): ProviderProfile[] {
    return this.s.desk.providerOrder.map((a) => this.s.desk.providers.get(a)!);
  }

  providerClaimable(provider: Address): bigint {
    return this.s.desk.claimable.get(lower(provider)) ?? 0n;
  }

  /** Margin requirement for a series: $WIF tier minus 2.5% when the series' corridor won the last election. */
  requiredMarginBpsFor(provider: Address, seriesId: number): bigint {
    let bps = this.getRequiredMarginBps(provider);
    const boost = this.currentBoostedCorridor();
    if (boost.active && this.getSeries(seriesId).corridorId === boost.corridorId) bps -= CORRIDOR_BOOST_MARGIN_BPS;
    return bps;
  }

  // ==================================================================
  // ParonExchangeDesk: primary issuance and trading
  // ==================================================================

  mintPrimarySeries(caller: Address, seriesId: number, cuAmount: bigint, askPriceUsdg: bigint): { lotId: number; orderId: number; filledCu: bigint } {
    return this.tx(() => {
      const provider = lower(caller);
      if (!this.s.desk.providers.get(provider)?.registered) throw new ParonError("NotRegisteredProvider");
      this.requireTradable(seriesId);
      if (cuAmount === 0n) throw new ParonError("ZeroAmount");
      this.checkPrice(askPriceUsdg);
      this.checkMinNotional(cuAmount * askPriceUsdg);

      const d = this.s.desk;
      const marginBps = this.requiredMarginBpsFor(provider, seriesId);
      const tier = this.getProviderTier(provider);
      const margin = ceilDiv(cuAmount * askPriceUsdg * marginBps, BPS);
      this.move(this.s.usdg, provider, this.s.addr.desk, margin);

      const lotId = ++d.lotCount;
      const lot: Lot = {
        id: lotId,
        seriesId,
        provider,
        cuMinted: cuAmount,
        cuUnsold: cuAmount,
        cuOutstanding: 0n,
        askPrice: askPriceUsdg,
        marginBps,
        tier,
        closed: false,
        marginLocked: margin,
        escrowUsdg: 0n,
        askOrderId: 0,
      };
      d.lots.set(lotId, lot);
      d.seriesLots.set(seriesId, [...(d.seriesLots.get(seriesId) ?? []), lotId]);
      d.unsoldCu.set(seriesId, (d.unsoldCu.get(seriesId) ?? 0n) + cuAmount);
      const tierKey = `${provider}:${tier}`;
      d.openLotsAtTier.set(tierKey, (d.openLotsAtTier.get(tierKey) ?? 0) + 1);
      this.syncStakeLock(provider);

      this.cuMint(seriesId, this.s.addr.desk, cuAmount);
      this.emit("ParonExchangeDesk", "LotMinted", {
        lotId,
        seriesId,
        provider,
        cuAmount,
        askPrice: askPriceUsdg,
        marginBps,
        marginLocked: margin,
      });

      const filledCu = this.matchAskAgainstBids(seriesId, provider, cuAmount, askPriceUsdg, lotId);
      let orderId = 0;
      if (cuAmount > filledCu) {
        orderId = this.newOrder(seriesId, provider, false, false, askPriceUsdg, cuAmount - filledCu, 0n, lotId);
        lot.askOrderId = orderId;
      }
      return { lotId, orderId, filledCu };
    });
  }

  buySeriesOrPlaceBid(caller: Address, seriesId: number, cuAmount: bigint, maxPriceUsdg: bigint, useWifDiscount: boolean): { filledCu: bigint; orderId: number } {
    return this.tx(() => {
      const buyer = lower(caller);
      this.requireTradable(seriesId);
      if (cuAmount === 0n) throw new ParonError("ZeroAmount");
      this.checkPrice(maxPriceUsdg);
      if (useWifDiscount && !this.hasWifFeeDiscount(buyer)) throw new ParonError("NotWifDiscountEligible");

      let remaining = cuAmount;
      let filled = 0n;
      let notional = 0n;
      let primaryCost = 0n;
      let fills = 0;
      while (remaining > 0n && fills < MAX_FILLS_PER_TX) {
        const { price, orderId } = this.clobHead(seriesId, false);
        if (orderId === 0 || price > maxPriceUsdg) break;
        const o = this.s.desk.orders.get(orderId)!;
        const maker = o.maker;
        const lotId = o.lotId;
        if (maker === buyer) throw new ParonError("SelfTrade");
        const take = remaining < o.qtyRemaining ? remaining : o.qtyRemaining;
        const cost = take * price;
        const done = this.clobFill(orderId, take);
        if (lotId !== 0) {
          this.sellPrimary(lotId, take, cost);
          primaryCost += cost;
          if (done) this.s.desk.lots.get(lotId)!.askOrderId = 0;
        } else {
          this.move(this.s.usdg, buyer, maker, cost);
        }
        this.recordTrade(seriesId, orderId, maker, buyer, true, price, take, lotId);
        remaining -= take;
        filled += take;
        notional += cost;
        fills += 1;
      }
      if (primaryCost > 0n) this.move(this.s.usdg, buyer, this.s.addr.desk, primaryCost);
      if (filled > 0n) {
        this.cuMove(seriesId, this.s.addr.desk, buyer, filled);
        this.chargeTakerFee(buyer, seriesId, notional, useWifDiscount);
      }
      let orderId = 0;
      if (remaining > 0n && remaining * maxPriceUsdg < MIN_ORDER_NOTIONAL) {
        // A dust remainder never rests. A pure dust order that fills nothing is rejected outright.
        if (filled === 0n) throw new ParonError("OrderTooSmall", { notional: remaining * maxPriceUsdg, minNotional: MIN_ORDER_NOTIONAL });
      } else if (remaining > 0n) {
        const cost = remaining * maxPriceUsdg;
        const escrow = cost + (cost * STANDARD_FEE_BPS) / BPS;
        this.move(this.s.usdg, buyer, this.s.addr.desk, escrow);
        orderId = this.newOrder(seriesId, buyer, true, useWifDiscount, maxPriceUsdg, remaining, escrow, 0);
      }
      return { filledCu: filled, orderId };
    });
  }

  placeAsk(caller: Address, seriesId: number, cuAmount: bigint, priceUsdg: bigint): { filledCu: bigint; orderId: number } {
    return this.tx(() => {
      const seller = lower(caller);
      this.requireTradable(seriesId);
      if (cuAmount === 0n) throw new ParonError("ZeroAmount");
      this.checkPrice(priceUsdg);
      this.cuMove(seriesId, seller, this.s.addr.desk, cuAmount);
      const filledCu = this.matchAskAgainstBids(seriesId, seller, cuAmount, priceUsdg, 0);
      let orderId = 0;
      const rest = cuAmount - filledCu;
      if (rest > 0n) {
        if (rest * priceUsdg >= MIN_ORDER_NOTIONAL) {
          orderId = this.newOrder(seriesId, seller, false, false, priceUsdg, rest, 0n, 0);
        } else {
          if (filledCu === 0n) throw new ParonError("OrderTooSmall", { notional: rest * priceUsdg, minNotional: MIN_ORDER_NOTIONAL });
          this.cuMove(seriesId, this.s.addr.desk, seller, rest); // dust remainder goes back
        }
      }
      return { filledCu, orderId };
    });
  }

  cancelOrder(caller: Address, orderId: number): void {
    this.tx(() => {
      const o = this.s.desk.orders.get(orderId);
      if (!o || !o.active) throw new ParonError("OrderNotActive", { orderId });
      if (o.maker !== lower(caller)) throw new ParonError("NotOrderMaker");
      const qty = o.qtyRemaining;
      this.clobUnlink(orderId);
      o.qtyRemaining = 0n;
      if (o.isBid) {
        const refund = o.escrowUsdg;
        o.escrowUsdg = 0n;
        if (refund > 0n) this.move(this.s.usdg, this.s.addr.desk, o.maker, refund);
      } else if (o.lotId !== 0) {
        this.cancelPrimary(o.lotId, qty);
      } else {
        this.cuMove(o.seriesId, this.s.addr.desk, o.maker, qty);
      }
      this.emit("ParonExchangeDesk", "OrderCancelled", { orderId, seriesId: o.seriesId, qtyReturned: qty });
    });
  }

  // ==================================================================
  // Mode A: cash settlement at CRI-H100
  // ==================================================================

  settleCashAtIndex(caller: Address, seriesId: number, cuAmount: bigint): bigint {
    return this.tx(() => {
      const holder = lower(caller);
      const s = this.getSeries(seriesId);
      if (this.s.now < s.deliveryStart || this.s.now >= s.deliveryEnd + SETTLEMENT_GRACE) {
        throw new ParonError("OutsideSettlementWindow");
      }
      const d = this.s.desk;
      if (d.criUpdatedAt === 0n || this.s.now > d.criUpdatedAt + this.s.params.maxIndexAge) throw new ParonError("StaleIndex");
      if (cuAmount === 0n) throw new ParonError("ZeroAmount");

      const lotId = this.assignLot(seriesId, cuAmount, 0);
      const provider = d.lots.get(lotId)!.provider;
      const { principal, margin } = this.takeLotShare(lotId, cuAmount);
      const collateral = principal + margin;
      const gross = cuAmount * d.criH100Usdg;
      const settleValue = min(gross, collateral);
      const fee = (settleValue * (this.hasWifFeeDiscount(holder) ? WIF_FEE_BPS : STANDARD_FEE_BPS)) / BPS;
      const payout = settleValue - fee;
      const residual = collateral - settleValue;
      d.claimable.set(provider, (d.claimable.get(provider) ?? 0n) + residual);

      this.cuBurn(seriesId, holder, cuAmount);
      this.move(this.s.usdg, this.s.addr.desk, holder, payout);
      if (fee > 0n) {
        const burned = this.vaultProcessFee(holder, fee, 0n, "CASH_SETTLEMENT");
        this.emit("ParonExchangeDesk", "FeeCharged", { payer: holder, seriesId, feeUsdg: fee, wifBurned: burned, wifMode: false });
      }
      this.emit("ParonExchangeDesk", "CashSettled", {
        seriesId,
        lotId,
        holder,
        cuAmount,
        indexPrice: d.criH100Usdg,
        payoutUsdg: payout,
        feeUsdg: fee,
        providerResidual: residual,
      });
      return payout;
    });
  }

  // ==================================================================
  // Mode B: direct compute redemption
  // ==================================================================

  requestRedemption(caller: Address, seriesId: number, cuAmount: bigint, preferredLotId: number, deliveryRef: Hex): number {
    return this.tx(() => {
      const holder = lower(caller);
      const s = this.getSeries(seriesId);
      if (this.s.now < s.deliveryStart || this.s.now >= s.deliveryEnd) throw new ParonError("OutsideDeliveryWindow");
      if (cuAmount === 0n) throw new ParonError("ZeroAmount");
      const d = this.s.desk;
      const lotId = this.assignLot(seriesId, cuAmount, preferredLotId);
      const provider = d.lots.get(lotId)!.provider;
      const { principal, margin } = this.takeLotShare(lotId, cuAmount);
      this.cuMove(seriesId, holder, this.s.addr.desk, cuAmount);

      const id = ++d.redemptionCount;
      const r: Redemption = {
        id,
        seriesId,
        lotId,
        holder,
        provider,
        cuAmount,
        principalUsdg: principal,
        marginUsdg: margin,
        state: "Requested",
        requestedAt: this.s.now,
        ackDeadline: this.s.now + this.s.params.ackWindow,
        deliveryDeadline: 0n,
        challengeDeadline: 0n,
        deliveryRef,
        receiptHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
        p95LatencyMs: 0,
        uptimeBps: 0,
        disputeId: 0,
      };
      d.redemptions.set(id, r);
      this.emit("ParonExchangeDesk", "RedemptionRequested", {
        redemptionId: id,
        seriesId,
        lotId,
        holder,
        provider,
        cuAmount,
        principalUsdg: principal,
        marginUsdg: margin,
        ackDeadline: r.ackDeadline,
      });
      return id;
    });
  }

  acknowledgeRedemption(caller: Address, redemptionId: number): void {
    this.tx(() => {
      const r = this.redemptionOrThrow(redemptionId);
      if (r.provider !== lower(caller)) throw new ParonError("NotProvider");
      if (r.state !== "Requested") throw new ParonError("InvalidState", { state: r.state });
      if (this.s.now > r.ackDeadline) throw new ParonError("DeadlinePassed");
      r.state = "Acknowledged";
      r.deliveryDeadline = this.s.now + this.s.params.deliveryWindow;
      this.emit("ParonExchangeDesk", "RedemptionAcknowledged", { redemptionId, deliveryDeadline: r.deliveryDeadline });
    });
  }

  /** EIP-191 digest identical to ParonSettlementLib.receiptDigest (bound to chain id and desk). */
  deliveryReceiptDigest(redemptionId: number, receiptHash: Hex, p95LatencyMs: number, uptimeBps: number): Hex {
    const inner = keccak256(
      encodeAbiParameters(
        [{ type: "uint256" }, { type: "address" }, { type: "uint256" }, { type: "bytes32" }, { type: "uint32" }, { type: "uint16" }],
        [BigInt(this.s.params.chainId), this.s.addr.desk, BigInt(redemptionId), receiptHash as ViemHex, p95LatencyMs, uptimeBps],
      ),
    );
    return hashMessage({ raw: inner }) as Hex;
  }

  deliverWithReceipt(caller: Address, redemptionId: number, receiptHash: Hex, p95LatencyMs: number, uptimeBps: number, attestationSig: Hex): void {
    this.tx(() => {
      const r = this.redemptionOrThrow(redemptionId);
      const provider = lower(caller);
      if (r.provider !== provider) throw new ParonError("NotProvider");
      if (r.state !== "Acknowledged") throw new ParonError("InvalidState", { state: r.state });
      if (this.s.now > r.deliveryDeadline) throw new ParonError("DeadlinePassed");
      if (/^0x0*$/.test(receiptHash)) throw new ParonError("EmptyReceipt");
      const signer = this.s.desk.providers.get(provider)?.attestationSigner;
      if (signer) {
        const digest = this.deliveryReceiptDigest(redemptionId, receiptHash, p95LatencyMs, uptimeBps);
        if (recoverSigner(digest, attestationSig) !== signer) throw new ParonError("InvalidAttestation");
      }
      r.receiptHash = receiptHash;
      r.p95LatencyMs = p95LatencyMs;
      r.uptimeBps = uptimeBps;
      r.state = "Delivered";
      r.challengeDeadline = this.s.now + this.s.params.challengeWindow;
      const breach = p95LatencyMs > SLA_MAX_P95_LATENCY_MS || uptimeBps < SLA_MIN_UPTIME_BPS;
      this.emit("ParonExchangeDesk", "DeliveryReceiptPosted", {
        redemptionId,
        receiptHash,
        p95LatencyMs,
        uptimeBps,
        slaBreached: breach,
        challengeDeadline: r.challengeDeadline,
      });
    });
  }

  confirmDelivery(caller: Address, redemptionId: number): void {
    this.tx(() => {
      const r = this.redemptionOrThrow(redemptionId);
      if (r.holder !== lower(caller)) throw new ParonError("NotHolder");
      if (r.state !== "Delivered") throw new ParonError("InvalidState", { state: r.state });
      this.finalizeRedemption(redemptionId);
    });
  }

  finalizeDelivery(_caller: Address, redemptionId: number): void {
    this.tx(() => {
      const r = this.redemptionOrThrow(redemptionId);
      if (r.state !== "Delivered") throw new ParonError("InvalidState", { state: r.state });
      if (this.s.now <= r.challengeDeadline) throw new ParonError("ChallengeWindowOpen");
      this.finalizeRedemption(redemptionId);
    });
  }

  claimMissedDeadline(_caller: Address, redemptionId: number): void {
    this.tx(() => {
      const r = this.redemptionOrThrow(redemptionId);
      const missed = (r.state === "Requested" && this.s.now > r.ackDeadline) ||
        (r.state === "Acknowledged" && this.s.now > r.deliveryDeadline);
      if (!missed) throw new ParonError("DeadlineNotPassed");
      this.slash(redemptionId, false);
    });
  }

  isDisputable(redemptionId: number): boolean {
    const r = this.s.desk.redemptions.get(redemptionId);
    return !!r && r.state === "Delivered" && this.s.now <= r.challengeDeadline;
  }

  getRedemption(redemptionId: number): Redemption | undefined {
    return this.s.desk.redemptions.get(redemptionId);
  }

  listRedemptions(): Redemption[] {
    return [...this.s.desk.redemptions.values()];
  }

  getLot(lotId: number): Lot | undefined {
    return this.s.desk.lots.get(lotId);
  }

  listLots(): Lot[] {
    return [...this.s.desk.lots.values()];
  }

  getOrder(orderId: number): Order | undefined {
    return this.s.desk.orders.get(orderId);
  }

  listOrders(filter: { maker?: Address; seriesId?: number; activeOnly?: boolean } = {}): Order[] {
    return [...this.s.desk.orders.values()].filter(
      (o) =>
        (filter.maker === undefined || o.maker === lower(filter.maker)) &&
        (filter.seriesId === undefined || o.seriesId === filter.seriesId) &&
        (!filter.activeOnly || o.active),
    );
  }

  // ==================================================================
  // WifSlaJury
  // ==================================================================

  openSlaDispute(caller: Address, redemptionId: number, evidenceHash: Hex, reason: string): number {
    return this.tx(() => {
      const challenger = lower(caller);
      const r = this.s.desk.redemptions.get(redemptionId);
      if (!r || r.holder !== challenger) throw new ParonError("NotRedemptionHolder");
      if (!this.isDisputable(redemptionId)) throw new ParonError("NotDisputable", { redemptionId });
      if (/^0x0*$/.test(evidenceHash)) throw new ParonError("EmptyEvidence");
      this.juryBurnFrom(challenger, DISPUTE_FILING_BURN);
      const j = this.s.jury;
      const id = ++j.disputeCount;
      const dispute: Dispute = {
        id,
        redemptionId,
        challenger,
        evidenceHash,
        reason,
        openedAt: this.s.now,
        votingEndsAt: this.s.now + this.s.params.votingPeriod,
        status: "Open",
        voterCount: 1,
        slashVotes: DISPUTE_FILING_BURN,
        upholdVotes: 0n,
        rewardPoolUsdg: 0n,
        rewardPoolWif: 0n,
        claimedUsdg: 0n,
        claimedWif: 0n,
      };
      j.disputes.set(id, dispute);
      j.slashWeight.set(pairKey(id, challenger), DISPUTE_FILING_BURN);
      // desk.onDisputeOpened
      r.state = "Disputed";
      r.disputeId = id;
      this.emit("ParonExchangeDesk", "RedemptionDisputed", { redemptionId, disputeId: id });
      this.vaultRecordBurn(challenger, DISPUTE_FILING_BURN, 0n, "SLA_DISPUTE_FILING");
      this.emit("WifSlaJury", "DisputeOpened", {
        disputeId: id,
        redemptionId,
        challenger,
        evidenceHash,
        reason,
        votingEndsAt: dispute.votingEndsAt,
        filingBurn: DISPUTE_FILING_BURN,
      });
      return id;
    });
  }

  voteOnDisputeWithWifBurn(caller: Address, disputeId: number, supportSlash: boolean, wifBurnAmount: bigint): void {
    this.tx(() => {
      const voter = lower(caller);
      const d = this.s.jury.disputes.get(disputeId);
      if (!d || d.status !== "Open") throw new ParonError("DisputeNotOpen", { disputeId });
      if (this.s.now >= d.votingEndsAt) throw new ParonError("VotingClosed", { votingEndsAt: d.votingEndsAt });
      if (wifBurnAmount === 0n) throw new ParonError("ZeroAmount");
      const key = pairKey(disputeId, voter);
      const slashWeight = this.s.jury.slashWeight.get(key) ?? 0n;
      const upholdWeight = this.s.jury.upholdWeight.get(key) ?? 0n;
      if (supportSlash ? upholdWeight !== 0n : slashWeight !== 0n) throw new ParonError("CannotVoteBothSides");
      if (slashWeight === 0n && upholdWeight === 0n) d.voterCount += 1;
      this.juryBurnFrom(voter, wifBurnAmount);
      if (supportSlash) {
        this.s.jury.slashWeight.set(key, slashWeight + wifBurnAmount);
        d.slashVotes += wifBurnAmount;
      } else {
        this.s.jury.upholdWeight.set(key, upholdWeight + wifBurnAmount);
        d.upholdVotes += wifBurnAmount;
      }
      this.vaultRecordBurn(voter, wifBurnAmount, 0n, "SLA_JURY_VOTE");
      this.emit("WifSlaJury", "BurnVoteCast", {
        disputeId,
        voter,
        supportSlash,
        wifBurned: wifBurnAmount,
        slashVotes: d.slashVotes,
        upholdVotes: d.upholdVotes,
      });
    });
  }

  resolveDispute(_caller: Address, disputeId: number): { slashed: boolean; rewardPoolUsdg: bigint; rewardPoolWif: bigint } {
    return this.tx(() => {
      const d = this.s.jury.disputes.get(disputeId);
      if (!d || d.status !== "Open") throw new ParonError("DisputeNotOpen", { disputeId });
      if (this.s.now < d.votingEndsAt) throw new ParonError("VotingStillOpen", { votingEndsAt: d.votingEndsAt });
      const slashed = d.slashVotes > d.upholdVotes;
      d.status = slashed ? "ResolvedSlash" : "ResolvedUphold";
      const r = this.redemptionOrThrow(d.redemptionId);
      if (r.state !== "Disputed") throw new ParonError("InvalidState", { state: r.state });
      let rewardUsdg = 0n;
      if (slashed) rewardUsdg = this.slash(d.redemptionId, true);
      else this.finalizeRedemption(d.redemptionId);
      rewardUsdg += this.vaultDrawJuryReward(JURY_POOL_DRAW_BPS, r.marginUsdg);
      const winningVotes = slashed ? d.slashVotes : d.upholdVotes;
      const bonusWif = this.vaultDrawJuryBonusWif((winningVotes * JURY_WIF_BONUS_BPS) / BPS);
      d.rewardPoolUsdg = rewardUsdg;
      d.rewardPoolWif = bonusWif;
      this.emit("WifSlaJury", "DisputeResolved", {
        disputeId,
        redemptionId: d.redemptionId,
        slashed,
        slashVotes: d.slashVotes,
        upholdVotes: d.upholdVotes,
        rewardPoolUsdg: rewardUsdg,
        rewardPoolWif: bonusWif,
      });
      return { slashed, rewardPoolUsdg: rewardUsdg, rewardPoolWif: bonusWif };
    });
  }

  pendingVoterUpside(disputeId: number, voter: Address): { usdg: bigint; wif: bigint } {
    const d = this.s.jury.disputes.get(disputeId);
    const key = pairKey(disputeId, voter);
    if (!d || (d.status !== "ResolvedSlash" && d.status !== "ResolvedUphold") || this.s.jury.claimed.has(key)) {
      return { usdg: 0n, wif: 0n };
    }
    const slashWon = d.status === "ResolvedSlash";
    const weight = (slashWon ? this.s.jury.slashWeight.get(key) : this.s.jury.upholdWeight.get(key)) ?? 0n;
    if (weight === 0n) return { usdg: 0n, wif: 0n };
    const winning = slashWon ? d.slashVotes : d.upholdVotes;
    return { usdg: (d.rewardPoolUsdg * weight) / winning, wif: (d.rewardPoolWif * weight) / winning };
  }

  claimVoterUpside(caller: Address, disputeId: number): { usdgOut: bigint; wifOut: bigint } {
    return this.tx(() => {
      const voter = lower(caller);
      const d = this.s.jury.disputes.get(disputeId);
      const slashWon = d?.status === "ResolvedSlash";
      if (!d || (!slashWon && d.status !== "ResolvedUphold")) throw new ParonError("DisputeNotResolved", { disputeId });
      const key = pairKey(disputeId, voter);
      const weight = (slashWon ? this.s.jury.slashWeight.get(key) : this.s.jury.upholdWeight.get(key)) ?? 0n;
      if (weight === 0n) throw new ParonError("NotWinningVoter");
      if (this.s.jury.claimed.has(key)) throw new ParonError("AlreadyClaimed");
      this.s.jury.claimed.add(key);
      const winning = slashWon ? d.slashVotes : d.upholdVotes;
      const usdgOut = (d.rewardPoolUsdg * weight) / winning;
      const wifOut = (d.rewardPoolWif * weight) / winning;
      d.claimedUsdg += usdgOut;
      d.claimedWif += wifOut;
      if (usdgOut > 0n) this.move(this.s.usdg, this.s.addr.jury, voter, usdgOut);
      if (wifOut > 0n) this.move(this.s.wif, this.s.addr.jury, voter, wifOut);
      this.emit("WifSlaJury", "VoterUpsideClaimed", { disputeId, voter, usdgAmount: usdgOut, wifAmount: wifOut });
      return { usdgOut, wifOut };
    });
  }

  voteWeight(disputeId: number, voter: Address): { slash: bigint; uphold: bigint; claimed: boolean } {
    const key = pairKey(disputeId, voter);
    return {
      slash: this.s.jury.slashWeight.get(key) ?? 0n,
      uphold: this.s.jury.upholdWeight.get(key) ?? 0n,
      claimed: this.s.jury.claimed.has(key),
    };
  }

  getDispute(disputeId: number): Dispute | undefined {
    return this.s.jury.disputes.get(disputeId);
  }

  listDisputes(): Dispute[] {
    return [...this.s.jury.disputes.values()];
  }

  currentEpoch(): number {
    return Number((this.s.now - this.s.jury.genesisTime) / this.s.params.epochLength);
  }

  epochEndsAt(epoch: number): bigint {
    return this.s.jury.genesisTime + BigInt(epoch + 1) * this.s.params.epochLength;
  }

  voteForComputeCorridor(caller: Address, corridorId: number, wifBurnAmount: bigint): void {
    this.tx(() => {
      const voter = lower(caller);
      if (corridorId >= this.s.corridors.length) throw new ParonError("UnknownCorridor", { corridorId });
      if (wifBurnAmount === 0n) throw new ParonError("ZeroAmount");
      const epoch = this.currentEpoch();
      this.juryBurnFrom(voter, wifBurnAmount);
      const j = this.s.jury;
      const key = `${epoch}:${corridorId}`;
      const total = (j.corridorVotes.get(key) ?? 0n) + wifBurnAmount;
      j.corridorVotes.set(key, total);
      j.corridorVotesOf.set(pairKey(epoch, voter), (j.corridorVotesOf.get(pairKey(epoch, voter)) ?? 0n) + wifBurnAmount);
      j.epochTotalVotes.set(epoch, (j.epochTotalVotes.get(epoch) ?? 0n) + wifBurnAmount);
      this.vaultRecordBurn(voter, wifBurnAmount, 0n, "CORRIDOR_ELECTION");
      this.emit("WifSlaJury", "CorridorVoteCast", { epoch, corridorId, voter, wifBurned: wifBurnAmount, corridorTotal: total });
    });
  }

  finalizeCorridorEpoch(_caller: Address, epoch: number): number {
    return this.tx(() => {
      const j = this.s.jury;
      if (epoch >= this.currentEpoch()) throw new ParonError("EpochNotEnded", { epoch });
      if (j.epochFinalized.has(epoch)) throw new ParonError("EpochAlreadyFinalized", { epoch });
      if ((j.epochTotalVotes.get(epoch) ?? 0n) === 0n) throw new ParonError("NoVotes", { epoch });
      let best = 0n;
      let winner = 0;
      for (let i = 0; i < this.s.corridors.length; i += 1) {
        const v = j.corridorVotes.get(`${epoch}:${i}`) ?? 0n;
        if (v > best) {
          best = v;
          winner = i;
        }
      }
      j.epochFinalized.add(epoch);
      j.epochWinner.set(epoch, winner);
      this.emit("WifSlaJury", "CorridorElected", { epoch, corridorId: winner, votes: best });
      return winner;
    });
  }

  currentBoostedCorridor(): { active: boolean; corridorId: number } {
    const epoch = this.currentEpoch();
    if (epoch === 0 || !this.s.jury.epochFinalized.has(epoch - 1)) return { active: false, corridorId: 0 };
    return { active: true, corridorId: this.s.jury.epochWinner.get(epoch - 1) ?? 0 };
  }

  corridorTally(epoch: number): bigint[] {
    return this.s.corridors.map((_, i) => this.s.jury.corridorVotes.get(`${epoch}:${i}`) ?? 0n);
  }

  epochFinalized(epoch: number): boolean {
    return this.s.jury.epochFinalized.has(epoch);
  }

  epochWinner(epoch: number): number | undefined {
    return this.s.jury.epochWinner.get(epoch);
  }

  private juryBurnFrom(account: Address, amount: bigint): void {
    if (this.s.params.nativeBurn) this.burnWif(account, amount);
    else this.move(this.s.wif, account, "0x000000000000000000000000000000000000dead", amount);
  }

  // ==================================================================
  // Views: market data
  // ==================================================================

  getBookSide(seriesId: number, isBid: boolean, depth = 10): { price: bigint; qty: bigint }[] {
    const arr = this.s.desk.levels.get(sideKey(seriesId, isBid)) ?? [];
    const out: { price: bigint; qty: bigint }[] = [];
    for (let i = arr.length - 1; i >= 0 && out.length < depth; i -= 1) {
      out.push({ price: arr[i], qty: this.s.desk.levelOf.get(levelKey(seriesId, isBid, arr[i]))?.qty ?? 0n });
    }
    return out;
  }

  getSeriesMarket(seriesId: number): SeriesMarket {
    const d = this.s.desk;
    const bids = d.levels.get(sideKey(seriesId, true)) ?? [];
    const asks = d.levels.get(sideKey(seriesId, false)) ?? [];
    const unsold = d.unsoldCu.get(seriesId) ?? 0n;
    return {
      bestBid: bids.length ? bids[bids.length - 1] : 0n,
      bestAsk: asks.length ? asks[asks.length - 1] : 0n,
      lastTradePrice: d.lastTradePrice.get(seriesId) ?? 0n,
      volumeCu: d.volumeCu.get(seriesId) ?? 0n,
      volumeUsdg: d.volumeUsdg.get(seriesId) ?? 0n,
      tradeCount: d.tradeCount.get(seriesId) ?? 0,
      unsoldCu: unsold,
      openInterestCu: this.cuTotalSupply(seriesId) - unsold,
    };
  }

  quoteBuy(seriesId: number, cuAmount: bigint, maxPriceUsdg: bigint, useWifDiscount: boolean): { fillableCu: bigint; notionalUsdg: bigint; feeUsdg: bigint; wifBurn: bigint } {
    const asks = this.s.desk.levels.get(sideKey(seriesId, false)) ?? [];
    let remaining = cuAmount;
    let fillableCu = 0n;
    let notionalUsdg = 0n;
    for (let i = asks.length; i > 0 && remaining > 0n; i -= 1) {
      const p = asks[i - 1];
      if (p > maxPriceUsdg) break;
      const q = this.s.desk.levelOf.get(levelKey(seriesId, false, p))?.qty ?? 0n;
      const take = remaining < q ? remaining : q;
      fillableCu += take;
      notionalUsdg += take * p;
      remaining -= take;
    }
    const feeUsdg = (notionalUsdg * (useWifDiscount ? WIF_FEE_BPS : STANDARD_FEE_BPS)) / BPS;
    const wifBurn = useWifDiscount ? (((feeUsdg * FEE_BURN_SHARE_BPS) / BPS) * WIF) / this.s.vault.wifPriceUsdg : 0n;
    return { fillableCu, notionalUsdg, feeUsdg, wifBurn };
  }

  events(filter?: { name?: string; contract?: ParonEvent["contract"] }): ParonEvent[] {
    if (!filter) return this.s.events;
    return this.s.events.filter((e) => (!filter.name || e.name === filter.name) && (!filter.contract || e.contract === filter.contract));
  }

  criIndex(): { price: bigint; updatedAt: bigint; sourceHash: Hex } {
    return { price: this.s.desk.criH100Usdg, updatedAt: this.s.desk.criUpdatedAt, sourceHash: this.s.desk.criSourceHash };
  }

  // ==================================================================
  // Desk internals (matching engine, lot accounting, settlement)
  // ==================================================================

  private requireTradable(seriesId: number): void {
    const s = this.getSeries(seriesId);
    if (this.s.now >= s.deliveryEnd) throw new ParonError("SeriesNotTradable", { seriesId });
  }

  private checkPrice(price: bigint): void {
    if (price === 0n || price % PRICE_TICK !== 0n) throw new ParonError("InvalidPrice");
  }

  private clobHead(seriesId: number, isBid: boolean): { price: bigint; orderId: number } {
    const arr = this.s.desk.levels.get(sideKey(seriesId, isBid)) ?? [];
    if (arr.length === 0) return { price: 0n, orderId: 0 };
    const price = arr[arr.length - 1];
    const level = this.s.desk.levelOf.get(levelKey(seriesId, isBid, price))!;
    return { price, orderId: level.head[0] !== 0 ? level.head[0] : level.head[1] };
  }

  private clobFill(orderId: number, take: bigint): boolean {
    const o = this.s.desk.orders.get(orderId)!;
    o.qtyRemaining -= take;
    this.s.desk.levelOf.get(levelKey(o.seriesId, o.isBid, o.price))!.qty -= take;
    const done = o.qtyRemaining === 0n;
    if (done) this.clobUnlink(orderId);
    return done;
  }

  private clobUnlink(orderId: number): void {
    const d = this.s.desk;
    const o = d.orders.get(orderId)!;
    const level = d.levelOf.get(levelKey(o.seriesId, o.isBid, o.price))!;
    const lane = o.lane;
    if (o.prev === 0) level.head[lane] = o.next;
    else d.orders.get(o.prev)!.next = o.next;
    if (o.next === 0) level.tail[lane] = o.prev;
    else d.orders.get(o.next)!.prev = o.prev;
    level.qty -= o.qtyRemaining;
    o.prev = 0;
    o.next = 0;
    o.active = false;
    const mk = makerKey(o.seriesId, o.isBid, o.maker);
    d.makerOrders.set(mk, (d.makerOrders.get(mk) ?? 0) - 1);
    if (level.head[0] === 0 && level.head[1] === 0) {
      const arr = d.levels.get(sideKey(o.seriesId, o.isBid))!;
      const idx = arr.lastIndexOf(o.price);
      if (idx >= 0) arr.splice(idx, 1);
    }
  }

  private checkMinNotional(notional: bigint): void {
    if (notional < MIN_ORDER_NOTIONAL) throw new ParonError("OrderTooSmall", { notional, minNotional: MIN_ORDER_NOTIONAL });
  }

  /** ParonClobLib.evictForBetterPrice: a strictly better price evicts the worst level of a full side. */
  private evictForBetterPrice(seriesId: number, isBid: boolean, price: bigint): void {
    const d = this.s.desk;
    const arr = d.levels.get(sideKey(seriesId, isBid)) ?? [];
    if (arr.length < MAX_LEVELS) return;
    const existing = d.levelOf.get(levelKey(seriesId, isBid, price));
    if (existing && (existing.head[0] !== 0 || existing.head[1] !== 0)) return; // joins an existing level
    const worst = arr[0];
    if (isBid ? price <= worst : price >= worst) throw new ParonError("TooManyLevels");
    for (let n = 0; n < MAX_EVICTIONS_PER_TX; n += 1) {
      if (arr.length < MAX_LEVELS) return;
      const lvl = d.levelOf.get(levelKey(seriesId, isBid, worst))!;
      const oid = lvl.head[0] !== 0 ? lvl.head[0] : lvl.head[1];
      const o = d.orders.get(oid)!;
      if (o.lotId !== 0) throw new ParonError("TooManyLevels"); // collateralised primary asks are never evicted
      const qty = o.qtyRemaining;
      this.clobUnlink(oid);
      o.qtyRemaining = 0n;
      if (isBid) {
        const refund = o.escrowUsdg;
        o.escrowUsdg = 0n;
        if (refund > 0n) this.move(this.s.usdg, this.s.addr.desk, o.maker, refund);
      } else {
        this.cuMove(seriesId, this.s.addr.desk, o.maker, qty);
      }
      this.emit("ParonExchangeDesk", "OrderCancelled", { orderId: oid, seriesId, qtyReturned: qty });
    }
    throw new ParonError("TooManyLevels");
  }

  private newOrder(seriesId: number, maker: Address, isBid: boolean, wifDiscount: boolean, price: bigint, qty: bigint, escrow: bigint, lotId: number): number {
    const d = this.s.desk;
    const lane: 0 | 1 = this.hasWifFeeDiscount(maker) ? 0 : 1;
    this.evictForBetterPrice(seriesId, isBid, price);
    const mk = makerKey(seriesId, isBid, maker);
    const held = d.makerOrders.get(mk) ?? 0;
    if (held >= MAX_ORDERS_PER_MAKER) throw new ParonError("TooManyOrders", { maker: lower(maker), max: MAX_ORDERS_PER_MAKER });
    d.makerOrders.set(mk, held + 1);
    const orderId = ++d.orderCount;
    const order: Order = {
      id: orderId,
      seriesId,
      maker: lower(maker),
      isBid,
      wifDiscount,
      lane,
      active: true,
      price,
      qtyRemaining: qty,
      qtyOriginal: qty,
      escrowUsdg: escrow,
      lotId,
      createdAt: this.s.now,
      prev: 0,
      next: 0,
    };
    d.orders.set(orderId, order);
    const lk = levelKey(seriesId, isBid, price);
    let level = d.levelOf.get(lk);
    if (!level) {
      level = { head: [0, 0], tail: [0, 0], qty: 0n };
      d.levelOf.set(lk, level);
    }
    if (level.head[0] === 0 && level.head[1] === 0) {
      const sk = sideKey(seriesId, isBid);
      const arr = d.levels.get(sk) ?? [];
      if (arr.length >= MAX_LEVELS) throw new ParonError("TooManyLevels");
      let j = arr.length;
      arr.push(price);
      while (j > 0 && (isBid ? arr[j - 1] > price : arr[j - 1] < price)) {
        arr[j] = arr[j - 1];
        j -= 1;
      }
      arr[j] = price;
      d.levels.set(sk, arr);
    }
    const tail = level.tail[lane];
    if (tail === 0) level.head[lane] = orderId;
    else {
      d.orders.get(tail)!.next = orderId;
      order.prev = tail;
    }
    level.tail[lane] = orderId;
    level.qty += qty;
    this.emit("ParonExchangeDesk", "OrderPlaced", { orderId, seriesId, maker: lower(maker), isBid, price, qty, lotId, lane });
    return orderId;
  }

  private matchAskAgainstBids(seriesId: number, seller: Address, qty: bigint, minPrice: bigint, lotId: number): bigint {
    let filled = 0n;
    let fills = 0;
    while (qty > filled && fills < MAX_FILLS_PER_TX) {
      const { price, orderId } = this.clobHead(seriesId, true);
      if (orderId === 0 || price < minPrice) break;
      const o = this.s.desk.orders.get(orderId)!;
      const bidder = o.maker;
      if (bidder === lower(seller)) throw new ParonError("SelfTrade");
      const take = qty - filled < o.qtyRemaining ? qty - filled : o.qtyRemaining;
      const cost = take * price;
      const fee = (cost * (o.wifDiscount && this.hasWifFeeDiscount(bidder) ? WIF_FEE_BPS : STANDARD_FEE_BPS)) / BPS;
      o.escrowUsdg -= cost + fee;
      const done = this.clobFill(orderId, take);
      if (lotId !== 0) this.sellPrimary(lotId, take, cost);
      else this.move(this.s.usdg, this.s.addr.desk, seller, cost);
      this.cuMove(seriesId, this.s.addr.desk, bidder, take);
      this.recordTrade(seriesId, orderId, bidder, seller, false, price, take, lotId);
      if (fee > 0n) {
        const burned = this.vaultProcessFee(bidder, fee, 0n, "TRADE_FEE");
        this.emit("ParonExchangeDesk", "FeeCharged", { payer: bidder, seriesId, feeUsdg: fee, wifBurned: burned, wifMode: false });
      }
      if (done) {
        const refund = o.escrowUsdg;
        o.escrowUsdg = 0n;
        if (refund > 0n) this.move(this.s.usdg, this.s.addr.desk, bidder, refund);
      }
      filled += take;
      fills += 1;
    }
    return filled;
  }

  private chargeTakerFee(payer: Address, seriesId: number, notional: bigint, wifMode: boolean): void {
    const fee = (notional * (wifMode ? WIF_FEE_BPS : STANDARD_FEE_BPS)) / BPS;
    if (fee === 0n) return;
    let wifBurn = 0n;
    if (wifMode) {
      const burnLeg = (fee * FEE_BURN_SHARE_BPS) / BPS;
      wifBurn = (burnLeg * WIF) / this.s.vault.wifPriceUsdg;
      if (wifBurn > 0n) {
        this.move(this.s.wif, payer, this.s.addr.desk, wifBurn);
        this.move(this.s.usdg, payer, this.s.addr.desk, fee - burnLeg);
      }
    }
    if (wifBurn === 0n) this.move(this.s.usdg, payer, this.s.addr.desk, fee);
    const burned = this.vaultProcessFee(payer, fee, wifBurn, wifBurn > 0n ? "TRADE_FEE_WIF" : "TRADE_FEE");
    this.emit("ParonExchangeDesk", "FeeCharged", { payer: lower(payer), seriesId, feeUsdg: fee, wifBurned: burned, wifMode: wifBurn > 0n });
  }

  private sellPrimary(lotId: number, qty: bigint, cost: bigint): void {
    const d = this.s.desk;
    const lot = d.lots.get(lotId)!;
    lot.cuUnsold -= qty;
    lot.cuOutstanding += qty;
    lot.escrowUsdg += cost;
    d.unsoldCu.set(lot.seriesId, (d.unsoldCu.get(lot.seriesId) ?? 0n) - qty);
  }

  private recordTrade(seriesId: number, makerOrderId: number, maker: Address, taker: Address, takerIsBuyer: boolean, price: bigint, qty: bigint, lotId: number): void {
    const d = this.s.desk;
    d.lastTradePrice.set(seriesId, price);
    d.volumeCu.set(seriesId, (d.volumeCu.get(seriesId) ?? 0n) + qty);
    d.volumeUsdg.set(seriesId, (d.volumeUsdg.get(seriesId) ?? 0n) + qty * price);
    d.tradeCount.set(seriesId, (d.tradeCount.get(seriesId) ?? 0) + 1);
    this.emit("ParonExchangeDesk", "Trade", {
      seriesId,
      makerOrderId,
      maker: lower(maker),
      taker: lower(taker),
      takerIsBuyer,
      price,
      qty,
      lotId,
    });
  }

  private assignLot(seriesId: number, cuAmount: bigint, preferredLotId: number): number {
    const d = this.s.desk;
    if (preferredLotId !== 0) {
      const p = d.lots.get(preferredLotId);
      if (!p || p.seriesId !== seriesId || p.cuOutstanding < cuAmount) throw new ParonError("LotCapacity", { lotId: preferredLotId });
      return preferredLotId;
    }
    const ids = d.seriesLots.get(seriesId) ?? [];
    let scanned = 0;
    for (let i = d.lotCursor.get(seriesId) ?? 0; i < ids.length && scanned < MAX_LOT_SCAN; i += 1) {
      const lot = d.lots.get(ids[i])!;
      if (lot.closed && i === (d.lotCursor.get(seriesId) ?? 0)) {
        d.lotCursor.set(seriesId, i + 1);
        continue;
      }
      if (lot.cuOutstanding >= cuAmount) return ids[i];
      scanned += 1;
    }
    throw new ParonError("NoLotCapacity", { seriesId, cuAmount });
  }

  private takeLotShare(lotId: number, cuAmount: bigint): { principal: bigint; margin: bigint } {
    const lot = this.s.desk.lots.get(lotId)!;
    const principal = (lot.escrowUsdg * cuAmount) / lot.cuOutstanding;
    const margin = (lot.marginLocked * cuAmount) / (lot.cuOutstanding + lot.cuUnsold);
    lot.escrowUsdg -= principal;
    lot.marginLocked -= margin;
    lot.cuOutstanding -= cuAmount;
    if (lot.cuOutstanding === 0n && lot.cuUnsold === 0n) this.closeLot(lotId);
    return { principal, margin };
  }

  private cancelPrimary(lotId: number, qty: bigint): void {
    const d = this.s.desk;
    const lot = d.lots.get(lotId)!;
    const release = (lot.marginLocked * qty) / (lot.cuOutstanding + lot.cuUnsold);
    lot.marginLocked -= release;
    lot.cuUnsold -= qty;
    lot.askOrderId = 0;
    d.unsoldCu.set(lot.seriesId, (d.unsoldCu.get(lot.seriesId) ?? 0n) - qty);
    this.cuBurn(lot.seriesId, this.s.addr.desk, qty);
    d.claimable.set(lot.provider, (d.claimable.get(lot.provider) ?? 0n) + release);
    if (lot.cuOutstanding === 0n && lot.cuUnsold === 0n) this.closeLot(lotId);
  }

  private closeLot(lotId: number): void {
    const d = this.s.desk;
    const lot = d.lots.get(lotId)!;
    if (lot.closed) return;
    lot.closed = true;
    const residual = lot.marginLocked + lot.escrowUsdg;
    if (residual > 0n) {
      lot.marginLocked = 0n;
      lot.escrowUsdg = 0n;
      d.claimable.set(lot.provider, (d.claimable.get(lot.provider) ?? 0n) + residual);
    }
    const tierKey = `${lot.provider}:${lot.tier}`;
    d.openLotsAtTier.set(tierKey, (d.openLotsAtTier.get(tierKey) ?? 0) - 1);
    this.syncStakeLock(lot.provider);
  }

  private syncStakeLock(provider: Address): void {
    const d = this.s.desk;
    let lockAmount = 0n;
    if ((d.openLotsAtTier.get(`${provider}:2`) ?? 0) > 0) lockAmount = TIER2_STAKE;
    else if ((d.openLotsAtTier.get(`${provider}:1`) ?? 0) > 0) lockAmount = TIER1_STAKE;
    this.vaultSetStakeLock(provider, lockAmount);
  }

  private redemptionOrThrow(redemptionId: number): Redemption {
    const r = this.s.desk.redemptions.get(redemptionId);
    if (!r) throw new ParonError("InvalidState", { state: "None" });
    return r;
  }

  private finalizeRedemption(redemptionId: number): void {
    const d = this.s.desk;
    const r = d.redemptions.get(redemptionId)!;
    r.state = "Finalized";
    const released = r.principalUsdg + r.marginUsdg;
    d.claimable.set(r.provider, (d.claimable.get(r.provider) ?? 0n) + released);
    const p = d.providers.get(r.provider)!;
    p.deliveredCu += r.cuAmount;
    p.deliveredCount += 1;
    this.cuBurn(r.seriesId, this.s.addr.desk, r.cuAmount);
    this.emit("ParonExchangeDesk", "RedemptionFinalized", { redemptionId, provider: r.provider, releasedUsdg: released });
  }

  private slash(redemptionId: number, viaJury: boolean): bigint {
    const d = this.s.desk;
    const r = d.redemptions.get(redemptionId)!;
    r.state = "Slashed";
    let compensation = (r.principalUsdg * SLA_COMPENSATION_BPS) / BPS;
    if (compensation > r.marginUsdg) compensation = r.marginUsdg;
    const remainder = r.marginUsdg - compensation;
    let voterShare = (remainder * SLASH_VOTER_SHARE_BPS) / BPS;
    const burnShare = (remainder * SLASH_BURN_SHARE_BPS) / BPS;
    let vaultShare = remainder - voterShare - burnShare;
    const p = d.providers.get(r.provider)!;
    p.slashedCu += r.cuAmount;
    p.slashedCount += 1;
    this.cuBurn(r.seriesId, this.s.addr.desk, r.cuAmount);
    this.move(this.s.usdg, this.s.addr.desk, r.holder, r.principalUsdg + compensation);
    if (viaJury) {
      if (voterShare > 0n) this.move(this.s.usdg, this.s.addr.desk, this.s.addr.jury, voterShare);
    } else {
      vaultShare += voterShare;
      voterShare = 0n;
    }
    if (burnShare + vaultShare > 0n) {
      this.vaultProcessSlashProceeds(r.provider, burnShare, vaultShare, viaJury ? "SLA_SLASH_JURY" : "SLA_SLASH_MISSED_DEADLINE");
    }
    this.emit("ParonExchangeDesk", "ProviderSlashed", {
      redemptionId,
      provider: r.provider,
      holder: r.holder,
      principalRefund: r.principalUsdg,
      slaCompensation: compensation,
      voterShare,
      burnShare,
      vaultShare,
      viaJury,
    });
    return voterShare;
  }
}

// ==================================================================
// Attestation signatures (secp256k1, low-s, v in {27, 28})
// ==================================================================

const SECP256K1_HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(bytes: Uint8Array): Hex {
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}` as Hex;
}

/** Mirror of ParonSettlementLib.recover: returns the lowercase signer or null for malformed signatures. */
export function recoverSigner(digest: Hex, signature: Hex): Address | null {
  try {
    const sig = hexToBytes(signature);
    if (sig.length !== 65) return null;
    const r = BigInt(bytesToHex(sig.slice(0, 32)));
    const s = BigInt(bytesToHex(sig.slice(32, 64)));
    const v = sig[64];
    if (s > SECP256K1_HALF_N) return null;
    if (v !== 27 && v !== 28) return null;
    const point = new secp256k1.Signature(r, s).addRecoveryBit(v - 27).recoverPublicKey(hexToBytes(digest));
    return lower(publicKeyToAddress(bytesToHex(point.toRawBytes(false))));
  } catch {
    return null;
  }
}

/** Signs a 32-byte digest (already EIP-191 prefixed) and returns r || s || v. */
export function signDigest(digest: Hex, privateKey: Hex): Hex {
  const sig = secp256k1.sign(hexToBytes(digest), hexToBytes(privateKey));
  const bytes = new Uint8Array(65);
  bytes.set(hexToBytes(sig.r.toString(16).padStart(64, "0")), 0);
  bytes.set(hexToBytes(sig.s.toString(16).padStart(64, "0")), 32);
  bytes[64] = 27 + (sig.recovery ?? 0);
  return bytesToHex(bytes);
}
