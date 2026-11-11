"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { keccak256, toHex } from "viem";
import {
  GENESIS_ACTORS,
  ParonLedger,
  createGenesisWorld,
  explainError,
  formatWifAmount,
  shortAddress,
  snapshotFromLedger,
  systemLabel,
  type Address,
  type Hex,
  type ProtocolSnapshot,
  type World,
} from "@paron-wif/core";
import { appConfig, explorerTx, liveConfigured } from "./config";
import { discoverWallets, requestAccounts, switchToChain, walletChainId, connectErrorMessage, type DiscoveredWallet } from "./eip6963";
import { LiveWriter, makeClients, readLiveSnapshot } from "./live";

export type Toast = { id: number; kind: "ok" | "err" | "pending"; title: string; body?: string; href?: string | null };

export type Wallet = {
  wallet: DiscoveredWallet;
  address: Address;
  chainId: number;
};

export type Actions = {
  faucet: () => Promise<void>;
  stake: (amount: bigint) => Promise<void>;
  unstake: (amount: bigint) => Promise<void>;
  claimRebate: () => Promise<void>;
  registerProvider: (uri: string, stake: bigint) => Promise<void>;
  mint: (seriesId: number, cu: bigint, price: bigint, margin: bigint) => Promise<void>;
  buy: (seriesId: number, cu: bigint, maxPrice: bigint, wifMode: boolean, maxWifBurn: bigint) => Promise<void>;
  sell: (seriesId: number, cu: bigint, price: bigint) => Promise<void>;
  cancel: (orderId: number) => Promise<void>;
  requestRedemption: (seriesId: number, cu: bigint, lotId: number) => Promise<void>;
  acknowledge: (rid: number) => Promise<void>;
  deliver: (rid: number, p95: number, uptimeBps: number) => Promise<void>;
  confirm: (rid: number) => Promise<void>;
  finalize: (rid: number) => Promise<void>;
  claimMissed: (rid: number) => Promise<void>;
  settleCash: (seriesId: number, cu: bigint) => Promise<void>;
  withdraw: () => Promise<void>;
  openDispute: (rid: number, reason: string) => Promise<void>;
  vote: (did: number, slash: boolean, amount: bigint) => Promise<void>;
  resolve: (did: number) => Promise<void>;
  claimUpside: (did: number) => Promise<void>;
  voteCorridor: (cid: number, amount: bigint) => Promise<void>;
  finalizeEpoch: (epoch: number) => Promise<void>;
};

type Ctx = {
  mode: "simulation" | "live";
  snapshot: ProtocolSnapshot;
  me: Address;
  actions: Actions;
  busy: boolean;
  toasts: Toast[];
  dismiss: (id: number) => void;
  notify: (t: Omit<Toast, "id">) => number;
  nameOf: (address: string) => string;
  // simulation
  world: World;
  version: number;
  bump: () => void;
  advance: (seconds: number) => void;
  resetSandbox: () => void;
  adoptWorld: (world: World) => void;
  setOverlay: (world: World | null) => void;
  overlay: World | null;
  // wallet / live
  wallets: DiscoveredWallet[];
  wallet: Wallet | null;
  walletError: string | null;
  connecting: boolean;
  connect: (w: DiscoveredWallet) => Promise<void>;
  disconnect: () => void;
  switchChain: () => Promise<void>;
  wrongNetwork: boolean;
  liveAvailable: boolean;
  preferLive: boolean;
  setPreferLive: (v: boolean) => void;
  liveError: string | null;
};

const ProtocolContext = createContext<Ctx | null>(null);

export function useProtocol(): Ctx {
  const ctx = useContext(ProtocolContext);
  if (!ctx) throw new Error("useProtocol outside ProtocolProvider");
  return ctx;
}

const YOU = GENESIS_ACTORS.judge.address;
const BLOCK_TIME = 12;

export function ProtocolProvider({ children }: { children: ReactNode }) {
  const [world, setWorld] = useState<World>(() => createGenesisWorld());
  const [overlay, setOverlay] = useState<World | null>(null);
  const [version, setVersion] = useState(0);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [busy, setBusy] = useState(false);
  const toastId = useRef(0);

  const [wallets, setWallets] = useState<DiscoveredWallet[]>([]);
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [walletError, setWalletError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [preferLive, setPreferLive] = useState(true);
  const [liveSnap, setLiveSnap] = useState<ProtocolSnapshot | null>(null);
  const [liveError, setLiveError] = useState<string | null>(null);

  const bump = useCallback(() => setVersion((v) => v + 1), []);
  const dismiss = useCallback((id: number) => setToasts((ts) => ts.filter((t) => t.id !== id)), []);
  const notify = useCallback((t: Omit<Toast, "id">) => {
    const id = ++toastId.current;
    setToasts((ts) => [...ts.slice(-4), { ...t, id }]);
    if (t.kind !== "pending") setTimeout(() => setToasts((ts) => ts.filter((x) => x.id !== id)), t.kind === "err" ? 7_000 : 4_500);
    return id;
  }, []);

  useEffect(() => discoverWallets(setWallets), []);

  const wrongNetwork = !!wallet && wallet.chainId !== appConfig.chainId;
  const liveAvailable = liveConfigured && !!wallet && !wrongNetwork;
  const mode: "simulation" | "live" = liveAvailable && preferLive && !overlay ? "live" : "simulation";

  // Wallet event wiring
  useEffect(() => {
    const p = wallet?.wallet.provider;
    if (!p?.on) return;
    const onAccounts = (...args: unknown[]) => {
      const accounts = args[0] as string[];
      if (!accounts?.length) setWallet(null);
      else setWallet((w) => (w ? { ...w, address: accounts[0].toLowerCase() as Address } : w));
    };
    const onChain = (...args: unknown[]) => setWallet((w) => (w ? { ...w, chainId: Number.parseInt(String(args[0]), 16) } : w));
    p.on("accountsChanged", onAccounts);
    p.on("chainChanged", onChain);
    return () => {
      p.removeListener?.("accountsChanged", onAccounts);
      p.removeListener?.("chainChanged", onChain);
    };
  }, [wallet?.wallet]);

  const clients = useMemo(() => {
    if (!wallet || !appConfig.addresses) return null;
    const { pub, wallet: wc } = makeClients(wallet.wallet.provider, wallet.address);
    return { pub, writer: new LiveWriter(pub, wc, appConfig.addresses, wallet.address) };
  }, [wallet]);

  // Live polling
  useEffect(() => {
    if (mode !== "live" || !clients || !appConfig.addresses || !wallet) return;
    let dead = false;
    const load = async () => {
      try {
        const snap = await readLiveSnapshot(clients.pub, appConfig.addresses!, wallet.address);
        if (!dead) {
          setLiveSnap(snap);
          setLiveError(null);
        }
      } catch (error) {
        if (!dead) setLiveError(explainError(error));
      }
    };
    void load();
    const id = setInterval(load, 8_000);
    return () => {
      dead = true;
      clearInterval(id);
    };
  }, [mode, clients, wallet, version]);

  const active = overlay ?? world;
  const me: Address = mode === "live" && wallet ? wallet.address : YOU;
  const simSnap = useMemo(() => snapshotFromLedger(active.ledger, { account: me }), [active, me, version]);
  const snapshot = mode === "live" && liveSnap ? liveSnap : simSnap;

  const nameOf = useCallback(
    (address: string) => {
      const a = address.toLowerCase();
      if (a === me.toLowerCase()) return "You";
      if (mode === "simulation") {
        const actor = Object.values(active.actors).find((x) => x.address === a);
        if (actor) return actor.name;
        const sys = systemLabel(active, a);
        if (sys) return sys;
      }
      return shortAddress(a);
    },
    [active, me, mode],
  );

  // ---------------- actions ----------------
  const simRun = useCallback(
    async (label: string, fn: (l: ParonLedger, you: Address) => unknown, describe?: (v: unknown) => string) => {
      const l = world.ledger;
      const burned = l.flywheelStats().totalWifBurned;
      try {
        const v = fn(l, YOU);
        l.advance(BLOCK_TIME);
        const delta = l.flywheelStats().totalWifBurned - burned;
        bump();
        notify({
          kind: "ok",
          title: label,
          body: [describe?.(v), delta > 0n ? `🔥 ${formatWifAmount(delta)} $WIF burned` : null].filter(Boolean).join(" · ") || "Executed on the local deterministic ledger.",
        });
      } catch (error) {
        notify({ kind: "err", title: `${label} reverted`, body: explainError(error) });
      }
    },
    [world, bump, notify],
  );

  const liveRun = useCallback(
    async (label: string, fn: (w: LiveWriter) => Promise<Hex>) => {
      if (!clients) return;
      setBusy(true);
      const pending = notify({ kind: "pending", title: label, body: "Confirm in your wallet…" });
      try {
        const hash = await fn(clients.writer);
        dismiss(pending);
        notify({ kind: "ok", title: label, body: `Confirmed ${hash.slice(0, 10)}…`, href: explorerTx(hash) });
        bump();
      } catch (error) {
        dismiss(pending);
        notify({ kind: "err", title: `${label} failed`, body: explainError(error) });
      } finally {
        setBusy(false);
      }
    },
    [clients, notify, dismiss, bump],
  );

  const evidence = (rid: number, reason: string) => keccak256(toHex(JSON.stringify({ rid, reason, by: me }))) as Hex;
  const isLive = mode === "live";
  const usd = (v: unknown) => `$${(Number(v as bigint) / 1e6).toFixed(2)}`;

  const actions: Actions = {
    faucet: () =>
      isLive
        ? liveRun("Faucet: 50,000 $WIF + 10,000 USDG", (w) => w.faucet())
        : simRun("Faucet: minted 50,000 $WIF + 10,000 USDG", (l, you) => l.faucetBoth(you)),
    stake: (amount) => (isLive ? liveRun("Stake $WIF", (w) => w.stake(amount)) : simRun("Staked $WIF in The Paron Vault", (l, you) => l.stakeWifForMarginBoost(you, amount))),
    unstake: (amount) => (isLive ? liveRun("Unstake $WIF", (w) => w.unstake(amount)) : simRun("Unstaked $WIF", (l, you) => l.unstakeWif(you, amount))),
    claimRebate: () => (isLive ? liveRun("Claim staker rebate", (w) => w.claimRebate()) : simRun("Claimed staker rebate", (l, you) => l.claimProviderRebate(you), usd)),
    registerProvider: (uri, stake) =>
      isLive ? liveRun("Register provider", (w) => w.registerProvider(uri, stake)) : simRun("Registered as a provider (no KYB)", (l, you) => l.registerProviderAndStakeWif(you, uri, stake)),
    mint: (seriesId, cu, price, margin) =>
      isLive
        ? liveRun("Mint primary series", (w) => w.mint(seriesId, cu, price, margin))
        : simRun("Minted primary CU", (l, you) => l.mintPrimarySeries(you, seriesId, cu, price), (v) => `lot #${(v as { lotId: number }).lotId}`),
    buy: (seriesId, cu, maxPrice, wifMode, maxWifBurn) =>
      isLive
        ? liveRun("Buy CU", (w) => w.buy(seriesId, cu, maxPrice, wifMode, maxWifBurn))
        : simRun(wifMode ? "Bought CU (10 bps $WIF mode)" : "Bought CU (30 bps)", (l, you) => l.buySeriesOrPlaceBid(you, seriesId, cu, maxPrice, wifMode, maxWifBurn), (v) => {
            const r = v as { filledCu: bigint; orderId: number };
            return `${r.filledCu} CU filled${r.orderId ? `, rest bid #${r.orderId}` : ""}`;
          }),
    sell: (seriesId, cu, price) =>
      isLive ? liveRun("Sell CU", (w) => w.sell(seriesId, cu, price)) : simRun("Ask placed", (l, you) => l.placeAsk(you, seriesId, cu, price), (v) => `${(v as { filledCu: bigint }).filledCu} CU filled immediately`),
    cancel: (orderId) => (isLive ? liveRun("Cancel order", (w) => w.cancel(orderId)) : simRun(`Cancelled order #${orderId}`, (l, you) => l.cancelOrder(you, orderId))),
    requestRedemption: (seriesId, cu, lotId) =>
      isLive
        ? liveRun("Request compute redemption", (w) => w.requestRedemption(seriesId, cu, lotId, evidence(seriesId, "ssh")))
        : simRun("Redemption requested", (l, you) => l.requestRedemption(you, seriesId, cu, lotId, evidence(seriesId, "ssh")), (v) => `redemption #${v}`),
    acknowledge: (rid) => (isLive ? liveRun("Acknowledge redemption", (w) => w.acknowledge(rid)) : simRun(`Acknowledged #${rid}`, (l, you) => l.acknowledgeRedemption(you, rid))),
    deliver: (rid, p95, uptime) => {
      const receipt = keccak256(toHex(`receipt:${rid}:${p95}:${uptime}`)) as Hex;
      return isLive
        ? liveRun("Post delivery receipt", (w) => w.deliver(rid, receipt, p95, uptime))
        : simRun(`Delivery receipt posted for #${rid}`, (l, you) => l.deliverWithReceipt(you, rid, receipt, p95, uptime, "0x"));
    },
    confirm: (rid) => (isLive ? liveRun("Confirm delivery", (w) => w.confirm(rid)) : simRun(`Confirmed delivery #${rid}`, (l, you) => l.confirmDelivery(you, rid))),
    finalize: (rid) => (isLive ? liveRun("Finalize delivery", (w) => w.finalize(rid)) : simRun(`Finalized #${rid}`, (l, you) => l.finalizeDelivery(you, rid))),
    claimMissed: (rid) => (isLive ? liveRun("Claim missed deadline", (w) => w.claimMissed(rid)) : simRun(`Slashed #${rid} for a missed deadline`, (l, you) => l.claimMissedDeadline(you, rid))),
    settleCash: (seriesId, cu) => (isLive ? liveRun("Cash-settle at CRI", (w) => w.settleCash(seriesId, cu)) : simRun("Cash-settled at CRI-H100", (l, you) => l.settleCashAtIndex(you, seriesId, cu), (v) => `payout ${usd(v)}`)),
    withdraw: () => (isLive ? liveRun("Withdraw provider balance", (w) => w.withdraw()) : simRun("Withdrew provider balance", (l, you) => l.withdrawProviderBalance(you), usd)),
    openDispute: (rid, reason) =>
      isLive ? liveRun("Open SLA dispute", (w) => w.openDispute(rid, evidence(rid, reason), reason)) : simRun("SLA dispute opened (100 $WIF filing burn)", (l, you) => l.openSlaDispute(you, rid, evidence(rid, reason), reason), (v) => `dispute #${v}`),
    vote: (did, slash, amount) =>
      isLive ? liveRun("Burn-vote", (w) => w.vote(did, slash, amount)) : simRun(`Burn-voted ${slash ? "SLASH" : "UPHOLD"}`, (l, you) => l.voteOnDisputeWithWifBurn(you, did, slash, amount)),
    resolve: (did) => (isLive ? liveRun("Resolve dispute", (w) => w.resolve(did)) : simRun(`Resolved dispute #${did}`, (l, you) => l.resolveDispute(you, did), (v) => ((v as { slashed: boolean }).slashed ? "SLASH executed" : "UPHOLD: provider paid"))),
    claimUpside: (did) =>
      isLive ? liveRun("Claim voter upside", (w) => w.claimUpside(did)) : simRun("Claimed juror upside", (l, you) => l.claimVoterUpside(you, did), (v) => {
        const r = v as { usdgOut: bigint; wifOut: bigint };
        return `${usd(r.usdgOut)} + ${formatWifAmount(r.wifOut)} $WIF`;
      }),
    voteCorridor: (cid, amount) => (isLive ? liveRun("Corridor burn-vote", (w) => w.voteCorridor(cid, amount)) : simRun("Corridor vote burned", (l, you) => l.voteForComputeCorridor(you, cid, amount))),
    finalizeEpoch: (epoch) => (isLive ? liveRun("Finalize epoch", (w) => w.finalizeEpoch(epoch)) : simRun(`Finalized epoch ${epoch}`, (l, you) => l.finalizeCorridorEpoch(you, epoch))),
  };

  const advance = useCallback(
    (seconds: number) => {
      world.ledger.advance(seconds);
      bump();
    },
    [world, bump],
  );

  const resetSandbox = useCallback(() => {
    setWorld(createGenesisWorld());
    setOverlay(null);
    bump();
    notify({ kind: "ok", title: "Sandbox reset", body: "Fresh deterministic genesis world." });
  }, [bump, notify]);

  const adoptWorld = useCallback(
    (w: World) => {
      setWorld(w);
      setOverlay(null);
      bump();
    },
    [bump],
  );

  const connect = useCallback(async (w: DiscoveredWallet) => {
    setConnecting(true);
    setWalletError(null);
    try {
      const accounts = await requestAccounts(w.provider);
      const chainId = await walletChainId(w.provider);
      if (accounts[0]) setWallet({ wallet: w, address: accounts[0].toLowerCase() as Address, chainId });
    } catch (error) {
      setWalletError(connectErrorMessage(error));
    } finally {
      setConnecting(false);
    }
  }, []);

  const switchChain = useCallback(async () => {
    if (!wallet) return;
    try {
      await switchToChain(wallet.wallet.provider, { id: appConfig.chainId, name: appConfig.chainName, rpcUrl: appConfig.rpcUrl, explorerUrl: appConfig.explorerUrl });
      setWallet({ ...wallet, chainId: await walletChainId(wallet.wallet.provider) });
    } catch (error) {
      setWalletError(connectErrorMessage(error));
    }
  }, [wallet]);

  const value: Ctx = {
    mode,
    snapshot,
    me,
    actions,
    busy,
    toasts,
    dismiss,
    notify,
    nameOf,
    world: active,
    version,
    bump,
    advance,
    resetSandbox,
    adoptWorld,
    setOverlay,
    overlay,
    wallets,
    wallet,
    walletError,
    connecting,
    connect,
    disconnect: () => setWallet(null),
    switchChain,
    wrongNetwork,
    liveAvailable,
    preferLive,
    setPreferLive,
    liveError,
  };
  return <ProtocolContext.Provider value={value}>{children}</ProtocolContext.Provider>;
}

export { YOU };
