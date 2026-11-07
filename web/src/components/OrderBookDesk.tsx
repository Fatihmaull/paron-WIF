"use client";

import { useEffect, useMemo, useState } from "react";
import {
  CORRIDOR_BOOST_MARGIN_BPS,
  FEE_DISCOUNT_THRESHOLD,
  LEGACY_BOND_BPS,
  MARGIN_TIER0_BPS,
  MARGIN_TIER1_BPS,
  MARGIN_TIER2_BPS,
  TIER1_STAKE,
  TIER2_STAKE,
  WIF,
  formatPrice,
  formatUsdg,
  formatWifAmount,
  type SeriesView,
} from "@paron-wif/core";
import { useProtocol } from "@/lib/protocol";
import { marginFor, quoteBuy } from "@/lib/quote";
import { KV, NumField, Panel, Pill, Toggle, fmtInt, parseDecimal } from "./ui";

const TIERS = [
  { tier: 0, name: "Tier 0", stake: 0n, bps: MARGIN_TIER0_BPS, eff: "2.0x" },
  { tier: 1, name: "Tier 1", stake: TIER1_STAKE, bps: MARGIN_TIER1_BPS, eff: "2.85x" },
  { tier: 2, name: "Tier 2 Prime", stake: TIER2_STAKE, bps: MARGIN_TIER2_BPS, eff: "4.0x" },
] as const;

export function OrderBook({ series, onPick }: { series: SeriesView; onPick: (price: bigint, side: "buy" | "sell") => void }) {
  const { snapshot } = useProtocol();
  const mine = new Set((snapshot.account?.orders ?? []).filter((o) => o.seriesId === series.id).map((o) => `${o.isBid ? "b" : "a"}:${o.price}`));
  const asks = series.asks.slice(0, 8);
  const bids = series.bids.slice(0, 8);
  const maxQty = [...asks, ...bids].reduce((m, l) => (l.qty > m ? l.qty : m), 1n);
  const spread = series.market.bestAsk && series.market.bestBid ? series.market.bestAsk - series.market.bestBid : 0n;
  const depth = (q: bigint) => `${Math.max(4, Number((q * 100n) / maxQty))}% 100%`;
  return (
    <Panel tight title={<>Order book · <b>{series.symbol}</b></>} right={<Pill tone="outline">price-time · $WIF lane first</Pill>}>
      <div className="book">
        <div className="book-head">
          <span>Price (USDG)</span>
          <span>Size (CU)</span>
          <span>Total</span>
        </div>
        {asks.length === 0 ? <div className="empty">No asks. Providers mint primary supply here.</div> : null}
        {[...asks].reverse().map((l) => (
          <div key={`a${l.price}`} className={`book-row ask click ${mine.has(`a:${l.price}`) ? "mine" : ""}`} style={{ backgroundSize: depth(l.qty) }} onClick={() => onPick(l.price, "buy")} title="Click to lift this ask">
            <span className="px">{formatPrice(l.price)}</span>
            <span>{fmtInt(Number(l.qty))}</span>
            <span className="muted">{formatUsdg(l.qty * l.price, 0)}</span>
          </div>
        ))}
        <div className="spread">
          <span>spread {spread ? formatPrice(spread) : "—"}</span>
          <span>last {series.market.lastTradePrice ? formatPrice(series.market.lastTradePrice) : "—"}</span>
          <span>CRI {formatPrice(snapshot.cri.price)}</span>
        </div>
        {bids.map((l) => (
          <div key={`b${l.price}`} className={`book-row bid click ${mine.has(`b:${l.price}`) ? "mine" : ""}`} style={{ backgroundSize: depth(l.qty) }} onClick={() => onPick(l.price, "sell")} title="Click to hit this bid">
            <span className="px">{formatPrice(l.price)}</span>
            <span>{fmtInt(Number(l.qty))}</span>
            <span className="muted">{formatUsdg(l.qty * l.price, 0)}</span>
          </div>
        ))}
        {bids.length === 0 ? <div className="empty">No bids yet.</div> : null}
      </div>
    </Panel>
  );
}

export function TradeTicket({ series, preset }: { series: SeriesView; preset: { price: bigint; side: "buy" | "sell"; n: number } | null }) {
  const { snapshot, actions, busy, overlay } = useProtocol();
  const acct = snapshot.account;
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [qty, setQty] = useState("50");
  const [price, setPrice] = useState("");
  const eligible = !!acct?.wifDiscount;
  const [wifMode, setWifMode] = useState(true);
  useEffect(() => {
    if (preset) {
      setSide(preset.side);
      setPrice(formatPrice(preset.price).replace(/,/g, ""));
    }
  }, [preset]);
  useEffect(() => {
    if (!preset) setPrice(formatPrice(side === "buy" ? series.market.bestAsk || snapshot.cri.price : series.market.bestBid || snapshot.cri.price).replace(/,/g, ""));
  }, [series.id, side]); // eslint-disable-line react-hooks/exhaustive-deps

  const cu = BigInt(Math.max(0, Math.floor(Number(qty || 0))));
  const px = parseDecimal(price, 6) ?? 0n;
  const ticked = px > 0n && px % 10_000n === 0n;
  const useWif = wifMode && eligible;
  const q = useMemo(() => quoteBuy(series.asks, cu, px, useWif, snapshot.flywheel.wifPriceUsdg), [series.asks, cu, px, useWif, snapshot.flywheel.wifPriceUsdg]);
  const held = acct?.cu[series.id] ?? 0n;
  const proceeds = (() => {
    let remaining = cu;
    let out = 0n;
    for (const b of series.bids) {
      if (remaining === 0n || b.price < px) break;
      const take = remaining < b.qty ? remaining : b.qty;
      out += take * b.price;
      remaining -= take;
    }
    return { out, filled: cu - remaining, rest: remaining };
  })();
  const needWif = FEE_DISCOUNT_THRESHOLD - ((acct?.wif ?? 0n) + (acct?.stakedWif ?? 0n));

  return (
    <Panel tight title="Trade ticket" right={side === "buy" && useWif ? <Pill tone="burn">🔥 $WIF mode · 10 bps</Pill> : <Pill tone="outline">30 bps</Pill>}>
      <div className="tabs" role="tablist">
        <button type="button" data-tone="buy" data-active={side === "buy"} onClick={() => setSide("buy")}>Buy / bid</button>
        <button type="button" data-tone="sell" data-active={side === "sell"} onClick={() => setSide("sell")}>Sell / ask</button>
      </div>
      <div className="grid g-2" style={{ gap: 10 }}>
        <NumField id="t-qty" label="Quantity" value={qty} onChange={setQty} suffix="CU" help={side === "sell" ? `You hold ${fmtInt(Number(held))} CU` : undefined} />
        <NumField id="t-px" label={side === "buy" ? "Limit (max) price" : "Ask price"} value={price} onChange={setPrice} suffix="USDG" help={!ticked && px > 0n ? "Tick is $0.01" : undefined} />
      </div>
      {side === "buy" ? (
        <>
          <div style={{ margin: "12px 0" }}>
            <Toggle
              on={useWif}
              disabled={!eligible}
              onChange={setWifMode}
              label="$WIF fee mode: 66% fee rebate (10 bps)"
              sub={eligible ? "Half of the fee is paid by burning your own $WIF." : `Hold or stake 10,000 $WIF to unlock (${formatWifAmount(needWif > 0n ? needWif : 0n, 0)} more).`}
            />
          </div>
          <KV
            rows={[
              ["Fills now", `${fmtInt(Number(q.fillableCu))} CU${q.fillableCu > 0n ? ` @ avg ${formatPrice(q.avgPrice)}` : ""}`],
              ["Notional", formatUsdg(q.notional)],
              [`Protocol fee (${useWif ? "10" : "30"} bps)`, formatUsdg(q.feeUsdg, 4)],
              ["You save vs 30 bps", useWif ? <span className="ok">{formatUsdg(q.standardFeeUsdg - q.feeUsdg, 4)}</span> : "—"],
              [useWif ? "🔥 $WIF burned from your wallet" : "🔥 $WIF bought back & burned", <span className="burn">{formatWifAmount(q.wifBurned, 2)} $WIF</span>],
              ["Fee split: burn / jury / stakers", `${formatUsdg(q.burnLegUsdg, 4)} / ${formatUsdg(q.juryLegUsdg, 4)} / ${formatUsdg(q.providerLegUsdg, 4)}`],
              ...(q.restingCu > 0n ? ([["Rests as bid", `${fmtInt(Number(q.restingCu))} CU · escrow ${formatUsdg(q.restingEscrow)}`]] as [string, string][]) : []),
              ["Total cost", formatUsdg(q.notional + q.feeUsdg + (q.restingCu > 0n ? q.restingEscrow : 0n)), "total"],
            ]}
          />
          <button
            className="btn buy block"
            style={{ marginTop: 12 }}
            type="button"
            disabled={busy || !!overlay || cu === 0n || !ticked}
            onClick={() => void actions.buy(series.id, cu, px, useWif)}
          >
            Buy {fmtInt(Number(cu))} CU {q.restingCu > 0n ? "· rest as bid" : ""}
          </button>
        </>
      ) : (
        <>
          <KV
            rows={[
              ["Hits bids now", `${fmtInt(Number(proceeds.filled))} CU`],
              ["Proceeds (buyer pays the fee)", formatUsdg(proceeds.out)],
              ["Rests as ask", `${fmtInt(Number(proceeds.rest))} CU @ ${px ? formatPrice(px) : "—"}`],
            ]}
          />
          <button className="btn sell block" style={{ marginTop: 12 }} type="button" disabled={busy || !!overlay || cu === 0n || !ticked || cu > held} onClick={() => void actions.sell(series.id, cu, px)}>
            {cu > held ? "Not enough CU" : `Sell ${fmtInt(Number(cu))} CU`}
          </button>
          <p className="help" style={{ marginTop: 6 }}>No approval transaction: the ExchangeDesk is the canonical CU clearing house.</p>
        </>
      )}
    </Panel>
  );
}

export function PrimaryMintDrawer({ series }: { series: SeriesView }) {
  const { snapshot, actions, busy, overlay } = useProtocol();
  const acct = snapshot.account;
  const currentTier = acct?.tier ?? 0;
  const [targetTier, setTargetTier] = useState<number>(2);
  const [cu, setCu] = useState("200");
  const [price, setPrice] = useState("2.24");
  const [stake, setStake] = useState("100000");
  const t = TIERS[targetTier];
  const boost = series.boosted ? CORRIDOR_BOOST_MARGIN_BPS : 0n;
  const marginBps = t.bps - boost;
  const amount = BigInt(Math.max(0, Math.floor(Number(cu || 0))));
  const px = parseDecimal(price, 6) ?? 0n;
  const notional = amount * px;
  const margin = marginFor(amount, px, marginBps);
  const legacy = (notional * LEGACY_BOND_BPS) / 10_000n;
  const staked = acct?.stakedWif ?? 0n;
  const stakeNeeded = t.stake > staked ? t.stake - staked : 0n;
  const currentMarginBps = TIERS[currentTier].bps - boost;
  const actualMargin = marginFor(amount, px, currentMarginBps);

  if (!acct?.registeredProvider) {
    return (
      <Panel tight title="Primary mint · become a provider" right={<Pill tone="ok">permissionless · no KYB</Pill>}>
        <p className="help" style={{ marginTop: 0 }}>
          The legacy flow waited on a KYB queue and a central verifier. Here anyone registers in one transaction: USDG margin and staked $WIF are the guarantee, the burn-to-vote jury is the arbiter.
        </p>
        <NumField id="reg-stake" label="Stake $WIF at registration (optional)" value={stake} onChange={setStake} suffix="$WIF" help="100,000 $WIF = Tier-2 Prime: 25% margin" />
        <button
          className="btn block"
          style={{ marginTop: 12 }}
          type="button"
          disabled={busy || !!overlay}
          onClick={() => void actions.registerProvider("ipfs://paron-wif/providers/you", (parseDecimal(stake, 18) ?? 0n))}
        >
          Register provider{stake && Number(stake) > 0 ? ` + stake ${fmtInt(Number(stake))} $WIF` : ""}
        </button>
        <p className="help">Your $WIF: {formatWifAmount(acct?.wif ?? 0n, 0)}. Use the faucet in the telemetry bar first.</p>
      </Panel>
    );
  }

  return (
    <Panel tight title={<>Primary mint · <b>{series.symbol}</b></>} right={<Pill tone={currentTier === 2 ? "ok" : "accent"}>you: {TIERS[currentTier].name}</Pill>}>
      <div className="field" style={{ marginBottom: 10 }}>
        <div className="between">
          <span className="label">$WIF margin boost slider</span>
          <span className="num accent">{(Number(marginBps) / 100).toFixed(1)}% margin</span>
        </div>
        <input className="slider" type="range" min={0} max={2} step={1} value={targetTier} onChange={(e) => setTargetTier(Number(e.target.value))} aria-label="Target margin tier" />
        <div className="tiers">
          {TIERS.map((x) => (
            <button key={x.tier} type="button" className="tier" data-active={x.tier === targetTier} data-current={x.tier === currentTier} onClick={() => setTargetTier(x.tier)}>
              <div className="tier-name">{x.name}</div>
              <div className="tier-margin">{(Number(x.bps - boost) / 100).toFixed(1)}%</div>
              <div className="tier-sub">{x.stake === 0n ? "no stake" : `${fmtInt(Number(x.stake / WIF))} $WIF`} · {x.eff}</div>
            </button>
          ))}
        </div>
        {series.boosted ? <p className="help ok">Corridor election winner: an extra -2.5% margin this epoch.</p> : null}
      </div>
      {stakeNeeded > 0n ? (
        <button className="btn ghost block" type="button" disabled={busy || !!overlay || (acct?.wif ?? 0n) < stakeNeeded} onClick={() => void actions.stake(stakeNeeded)} style={{ marginBottom: 10 }}>
          Stake {formatWifAmount(stakeNeeded, 0)} $WIF to unlock {t.name}
        </button>
      ) : null}
      <div className="grid g-2" style={{ gap: 10 }}>
        <NumField id="m-cu" label="Mint" value={cu} onChange={setCu} suffix="CU" />
        <NumField id="m-px" label="Ask price" value={price} onChange={setPrice} suffix="USDG" />
      </div>
      <KV
        rows={[
          ["Notional", formatUsdg(notional)],
          [`Margin at ${t.name} (${(Number(marginBps) / 100).toFixed(1)}%)`, <span className="accent">{formatUsdg(margin)}</span>],
          ["Legacy 150% cash bond", <span className="bad">{formatUsdg(legacy)}</span>],
          ["Capital freed vs legacy", <span className="ok">{formatUsdg(legacy > margin ? legacy - margin : 0n)}</span>],
          ["You will lock (current tier)", formatUsdg(actualMargin), "total"],
        ]}
      />
      <button
        className="btn block"
        style={{ marginTop: 12 }}
        type="button"
        disabled={busy || !!overlay || amount === 0n || px === 0n || px % 10_000n !== 0n}
        onClick={() => void actions.mint(series.id, amount, px, actualMargin)}
      >
        Mint {fmtInt(Number(amount))} CU &amp; list at {px ? formatPrice(px) : "—"}
      </button>
      <p className="help">Buyer principal is escrowed per lot and released to you on delivery or settlement.</p>
    </Panel>
  );
}

export function PositionsPanel() {
  const { snapshot, actions, busy, overlay } = useProtocol();
  const acct = snapshot.account;
  if (!acct) return null;
  const series = new Map(snapshot.series.map((s) => [s.id, s]));
  const holdings = snapshot.series.filter((s) => (acct.cu[s.id] ?? 0n) > 0n);
  const myLots = snapshot.lots.filter((l) => l.provider === acct.address && !l.closed);
  return (
    <Panel title="Your positions" right={<Pill tone={acct.wifDiscount ? "burn" : "outline"}>{acct.wifDiscount ? "$WIF priority lane" : "standard lane"}</Pill>}>
      <div className="grid g-4" style={{ gap: 10, marginBottom: 12 }}>
        <div className="stat"><div className="stat-label">$WIF</div><div className="stat-value">{formatWifAmount(acct.wif, 0)}</div><div className="stat-sub">staked {formatWifAmount(acct.stakedWif, 0)}</div></div>
        <div className="stat"><div className="stat-label">USDG</div><div className="stat-value">{formatUsdg(acct.usdg)}</div><div className="stat-sub">provider claimable {formatUsdg(acct.claimableUsdg)}</div></div>
        <div className="stat"><div className="stat-label">Staker rebate</div><div className="stat-value">{formatUsdg(acct.earnedRebateUsdg, 4)}</div><div className="stat-sub">20% of all fees</div></div>
        <div className="stat"><div className="stat-label">Margin tier</div><div className="stat-value">{(Number(acct.marginBps) / 100).toFixed(0)}%</div><div className="stat-sub">Tier {acct.tier}{acct.stakeLock > 0n ? ` · ${formatWifAmount(acct.stakeLock, 0)} locked` : ""}</div></div>
      </div>
      <div className="row" style={{ marginBottom: 12 }}>
        <button className="btn ghost sm" type="button" disabled={busy || !!overlay || acct.earnedRebateUsdg === 0n} onClick={() => void actions.claimRebate()}>Claim rebate</button>
        <button className="btn ghost sm" type="button" disabled={busy || !!overlay || acct.claimableUsdg === 0n} onClick={() => void actions.withdraw()}>Withdraw provider balance</button>
      </div>
      <div className="table-scroll">
        <table>
          <thead>
            <tr><th>Holding / order</th><th>Side</th><th className="num">Price</th><th className="num">Size</th><th /></tr>
          </thead>
          <tbody>
            {holdings.map((s) => (
              <tr key={`h${s.id}`}><td className="num">{s.symbol}</td><td><Pill tone="ok">held</Pill></td><td className="num">—</td><td className="num">{fmtInt(Number(acct.cu[s.id]))} CU</td><td /></tr>
            ))}
            {acct.orders.map((o) => (
              <tr key={`o${o.id}`}>
                <td className="num">{series.get(o.seriesId)?.symbol} #{o.id}</td>
                <td><Pill tone={o.isBid ? "ok" : "bad"}>{o.isBid ? "bid" : o.lotId ? "primary ask" : "ask"}</Pill> {o.lane === 0 ? <Pill tone="burn">$WIF lane</Pill> : null}</td>
                <td className="num">{formatPrice(o.price)}</td>
                <td className="num">{fmtInt(Number(o.qtyRemaining))} CU</td>
                <td className="num"><button className="btn ghost sm" type="button" disabled={busy || !!overlay} onClick={() => void actions.cancel(o.id)}>Cancel</button></td>
              </tr>
            ))}
            {myLots.map((l) => (
              <tr key={`l${l.id}`}>
                <td className="num">{series.get(l.seriesId)?.symbol} lot #{l.id}</td>
                <td><Pill tone="accent">provider lot</Pill></td>
                <td className="num">{formatPrice(l.askPrice)}</td>
                <td className="num">{fmtInt(Number(l.cuOutstanding))} sold · {fmtInt(Number(l.cuUnsold))} unsold</td>
                <td className="num muted">margin {formatUsdg(l.marginLocked)}</td>
              </tr>
            ))}
            {holdings.length + acct.orders.length + myLots.length === 0 ? (
              <tr><td colSpan={5} className="muted">Nothing yet. Mint test tokens from the faucet, then buy CU or register as a provider.</td></tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

export function RecentTrades({ seriesId }: { seriesId: number }) {
  const { snapshot, nameOf } = useProtocol();
  const trades = snapshot.trades.filter((t) => t.seriesId === seriesId).slice(0, 10);
  return (
    <Panel tight title="Tape">
      {trades.length === 0 ? <div className="empty">No prints yet.</div> : null}
      <div className="table-scroll">
        <table>
          <tbody>
            {trades.map((t) => (
              <tr key={t.seq}>
                <td className={`num ${t.takerIsBuyer ? "bid" : "ask"}`}>{formatPrice(t.price)}</td>
                <td className="num">{fmtInt(Number(t.qty))} CU</td>
                <td className="dim" style={{ maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis" }}>{nameOf(t.takerIsBuyer ? t.taker : t.maker)}</td>
                <td>{t.primary ? <Pill tone="accent">primary</Pill> : <Pill tone="outline">secondary</Pill>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}
