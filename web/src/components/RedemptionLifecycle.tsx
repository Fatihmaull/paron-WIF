"use client";

import Link from "next/link";
import { useState } from "react";
import { SLA_MAX_P95_LATENCY_MS, SLA_MIN_UPTIME_BPS, formatPrice, formatUsdg, gpuHoursForCu, type Redemption, type SeriesView } from "@paron-wif/core";
import { useProtocol } from "@/lib/protocol";
import { Countdown, NumField, Panel, Pill, fmtInt, fmtNum } from "./ui";

const STEPS = ["Requested", "Acknowledged", "Delivered", "Disputed", "Settled"] as const;

function stepState(r: Redemption, i: number): "done" | "now" | "bad" | "dispute" | "todo" {
  const order: Record<string, number> = { Requested: 0, Acknowledged: 1, Delivered: 2, Disputed: 3, Finalized: 4, Slashed: 4 };
  const at = order[r.state] ?? 0;
  if (i === 3 && r.disputeId === 0 && at >= 3) return "todo";
  if (i === 4 && r.state === "Slashed") return "bad";
  if (i === 3 && r.disputeId !== 0) return r.state === "Disputed" ? "dispute" : "done";
  if (i < at) return "done";
  if (i === at) return r.state === "Finalized" ? "done" : "now";
  return "todo";
}

export function LifecycleStepper({ r }: { r: Redemption }) {
  return (
    <div className="lifecycle">
      {STEPS.map((label, i) => {
        const st = stepState(r, i);
        return (
          <div key={label} className="life-step" data-state={st}>
            <b>{i === 4 ? (r.state === "Slashed" ? "Slashed" : r.state === "Finalized" ? "Finalized" : "Settles") : label}</b>
            {i === 0 && st === "now" ? <span>ack in <Countdown to={r.ackDeadline} /></span> : null}
            {i === 1 && st === "now" && r.deliveryDeadline ? <span>deliver in <Countdown to={r.deliveryDeadline} /></span> : null}
            {i === 2 && r.challengeDeadline ? <span>p95 {r.p95LatencyMs}ms · {(r.uptimeBps / 100).toFixed(2)}%</span> : null}
            {i === 3 && r.disputeId ? <span>dispute #{r.disputeId}</span> : null}
          </div>
        );
      })}
    </div>
  );
}

function RedemptionCard({ r, series }: { r: Redemption; series: SeriesView | undefined }) {
  const { snapshot, actions, busy, overlay, nameOf, me } = useProtocol();
  const [p95, setP95] = useState("142");
  const [uptime, setUptime] = useState("99.97");
  const isHolder = r.holder === me.toLowerCase();
  const isProvider = r.provider === me.toLowerCase();
  const now = snapshot.now;
  const breach = r.p95LatencyMs > SLA_MAX_P95_LATENCY_MS || (r.uptimeBps > 0 && r.uptimeBps < SLA_MIN_UPTIME_BPS);
  const missed = (r.state === "Requested" && now > r.ackDeadline) || (r.state === "Acknowledged" && now > r.deliveryDeadline);
  const disabled = busy || !!overlay;
  return (
    <div style={{ borderTop: "1px solid var(--line)", paddingTop: 12, marginTop: 12 }}>
      <div className="between">
        <span className="row">
          <span className="num" style={{ fontWeight: 600 }}>#{r.id}</span>
          <span className="num">{series?.symbol}</span>
          <span className="dim">{fmtInt(Number(r.cuAmount))} CU = {fmtNum(gpuHoursForCu(series?.gpuTier ?? "H100", Number(r.cuAmount)))} {series?.gpuTier} h</span>
          {r.state === "Delivered" && breach ? <Pill tone="bad">SLA breach reported</Pill> : null}
        </span>
        <span className="help">
          holder {nameOf(r.holder)} · provider {nameOf(r.provider)} · escrow {formatUsdg(r.principalUsdg)} + margin {formatUsdg(r.marginUsdg)}
        </span>
      </div>
      <LifecycleStepper r={r} />
      <div className="row">
        {isProvider && r.state === "Requested" && !missed ? (
          <button className="btn sm" type="button" disabled={disabled} onClick={() => void actions.acknowledge(r.id)}>Acknowledge &amp; provision</button>
        ) : null}
        {isProvider && r.state === "Acknowledged" && !missed ? (
          <>
            <div style={{ width: 110 }}><NumField id={`p95-${r.id}`} label="p95 ms" value={p95} onChange={setP95} /></div>
            <div style={{ width: 110 }}><NumField id={`up-${r.id}`} label="uptime %" value={uptime} onChange={setUptime} /></div>
            <button className="btn sm" type="button" disabled={disabled} onClick={() => void actions.deliver(r.id, Number(p95 || 0), Math.round(Number(uptime || 0) * 100))}>Post execution receipt</button>
          </>
        ) : null}
        {isHolder && r.state === "Delivered" ? (
          <>
            <button className="btn buy sm" type="button" disabled={disabled} onClick={() => void actions.confirm(r.id)}>Confirm delivery</button>
            <button className="btn ghost sm" type="button" disabled={disabled || now > r.challengeDeadline} onClick={() => void actions.openDispute(r.id, `p95 ${r.p95LatencyMs}ms vs ${SLA_MAX_P95_LATENCY_MS}ms SLA; uptime ${(r.uptimeBps / 100).toFixed(2)}%`)}>
              Open SLA dispute (burns 100 $WIF)
            </button>
          </>
        ) : null}
        {r.state === "Delivered" && now > r.challengeDeadline ? (
          <button className="btn ghost sm" type="button" disabled={disabled} onClick={() => void actions.finalize(r.id)}>Finalize (challenge window over)</button>
        ) : null}
        {missed ? (
          <button className="btn danger sm" type="button" disabled={disabled} onClick={() => void actions.claimMissed(r.id)}>Slash: provider missed its deadline</button>
        ) : null}
        {r.state === "Disputed" ? <Link className="btn ghost sm" href="/flywheel#jury">Go to the $WIF SLA jury →</Link> : null}
        {r.state === "Delivered" ? <span className="help">challenge window <Countdown to={r.challengeDeadline} /></span> : null}
      </div>
    </div>
  );
}

export function RedemptionLifecycle({ series }: { series: SeriesView }) {
  const { snapshot, actions, busy, overlay, me } = useProtocol();
  const acct = snapshot.account;
  const held = acct?.cu[series.id] ?? 0n;
  const [cu, setCu] = useState("25");
  const [settle, setSettle] = useState("10");
  const deliverable = snapshot.now >= series.deliveryStart && snapshot.now < series.deliveryEnd;
  const cri = snapshot.cri.price;
  const amount = BigInt(Math.max(0, Math.floor(Number(cu || 0))));
  const settleAmount = BigInt(Math.max(0, Math.floor(Number(settle || 0))));
  const mine = snapshot.redemptions.filter((r) => r.holder === me.toLowerCase() || r.provider === me.toLowerCase());
  const recent = mine.length > 0 ? mine : snapshot.redemptions.filter((r) => r.seriesId === series.id).slice(-2);
  const seriesById = new Map(snapshot.series.map((s) => [s.id, s]));
  return (
    <Panel title={<>Dual settlement · <b>{series.symbol}</b></>} right={<Pill tone={deliverable ? "ok" : "info"}>{deliverable ? "delivery month open" : "forward: delivery not open yet"}</Pill>}>
      <div className="grid g-2">
        <div>
          <div className="overline" style={{ marginBottom: 6 }}>Mode B · direct compute redemption</div>
          <NumField id="r-cu" label="Redeem" value={cu} onChange={setCu} suffix="CU" help={`= ${fmtNum(gpuHoursForCu(series.gpuTier, Number(amount)))} ${series.gpuTier} hours · you hold ${fmtInt(Number(held))} CU`} />
          <button className="btn block" style={{ marginTop: 10 }} type="button" disabled={busy || !!overlay || !deliverable || amount === 0n || amount > held} onClick={() => void actions.requestRedemption(series.id, amount, 0)}>
            Request delivery of {fmtInt(Number(amount))} CU
          </button>
          <p className="help">Provider acknowledges, provisions, then posts a signed execution receipt. You confirm, or dispute to the $WIF jury.</p>
        </div>
        <div>
          <div className="overline" style={{ marginBottom: 6 }}>Mode A · cash settlement at CRI-H100</div>
          <NumField id="s-cu" label="Settle" value={settle} onChange={setSettle} suffix="CU" help={`Index ${formatPrice(cri)} USDG/CU → gross ${formatUsdg(settleAmount * cri)} (capped at principal + margin)`} />
          <button className="btn ghost block" style={{ marginTop: 10 }} type="button" disabled={busy || !!overlay || !deliverable || settleAmount === 0n || settleAmount > held} onClick={() => void actions.settleCash(series.id, settleAmount)}>
            Cash-settle {fmtInt(Number(settleAmount))} CU at the index
          </button>
          <p className="help">Agents hedge compute price spikes purely financially: no hardware, PnL = CRI − entry.</p>
        </div>
      </div>
      {recent.length > 0 ? (
        <div style={{ marginTop: 4 }}>
          <div className="overline" style={{ marginTop: 14 }}>{mine.length > 0 ? "Your redemptions" : "Recent redemptions on this series"}</div>
          {[...recent].reverse().map((r) => (
            <RedemptionCard key={r.id} r={r} series={seriesById.get(r.seriesId)} />
          ))}
        </div>
      ) : null}
    </Panel>
  );
}
