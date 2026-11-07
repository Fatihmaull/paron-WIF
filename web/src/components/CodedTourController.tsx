"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  LEGACY_BOND_BPS,
  TOUR_ACTORS,
  TOUR_STEPS,
  WIF,
  createTourContext,
  explainError,
  flywheelRecord,
  formatPrice,
  formatUsdg,
  formatWifAmount,
  runTourBeat,
  sealReceipt,
  snapshotFromLedger,
  verifyReceiptChain,
  type TourActionRecord,
  type TourContext,
} from "@paron-wif/core";
import { useProtocol } from "@/lib/protocol";
import { LifecycleStepper } from "./RedemptionLifecycle";
import { Panel, Pill, fmtInt } from "./ui";

const BEAT_MS = 2_600;
const STEP_PAUSE_MS = 1_100;
type Status = "idle" | "playing" | "paused" | "done";

function BarRow({ label, value, max, tone, note }: { label: string; value: number; max: number; tone: string; note: string }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div className="between help" style={{ marginBottom: 3 }}>
        <span>{label}</span>
        <span className="num">{note}</span>
      </div>
      <div className="bar" style={{ height: 12 }}>
        <span className={tone} style={{ width: `${Math.max(2, (value / max) * 100)}%`, transition: "width 600ms" }} />
      </div>
    </div>
  );
}

/** Live visual of the protocol state for the step being played, read straight from the tour ledger. */
function TourStage({ ctx, stepIndex, version }: { ctx: TourContext; stepIndex: number; version: number }) {
  const snap = useMemo(() => snapshotFromLedger(ctx.world.ledger), [ctx, version]);
  const step = TOUR_STEPS[Math.min(stepIndex, TOUR_STEPS.length - 1)];
  const m = ctx.metrics;
  const btm = snap.series.find((s) => s.id === ctx.world.series.btm)!;
  const l = ctx.world.ledger;
  if (step.focus === "provider") {
    const notional = 200n * 2_240_000n;
    const legacy = (notional * LEGACY_BOND_BPS) / 10_000n;
    const max = Number(legacy);
    return (
      <div>
        <BarRow label="Legacy Paron v1: 150% cash bond" value={max} max={max} tone="fill-ask" note={formatUsdg(legacy)} />
        <BarRow label="Paron WIF Tier 0 (no stake): 50%" value={Number(notional / 2n)} max={max} tone="fill-dim" note={formatUsdg(notional / 2n)} />
        <BarRow label="Paron WIF Tier-2 Prime (100k $WIF): 25%" value={Number(m.providerMarginUsdg ?? 0n)} max={max} tone="fill-accent" note={m.providerMarginUsdg ? formatUsdg(m.providerMarginUsdg) : "pending"} />
        <p className="help">Same 200 CU of CU-BTM-H200-2611 at $2.24. Staked: {formatWifAmount(l.stakedWif(TOUR_ACTORS.prime.address), 0)} $WIF.</p>
      </div>
    );
  }
  if (step.focus === "agent") {
    const fee = m.agentFeeUsdg ?? 0n;
    return (
      <div>
        <BarRow label="Standard fee, 30 bps" value={Number(fee * 3n || 336_000n)} max={Number(fee * 3n || 336_000n)} tone="fill-dim" note={formatUsdg(fee * 3n || 336_000n, 4)} />
        <BarRow label="$WIF mode fee, 10 bps" value={Number(fee || 112_000n)} max={Number(fee * 3n || 336_000n)} tone="fill-burn" note={formatUsdg(fee || 112_000n, 4)} />
        <div className="grid g-3" style={{ gap: 8 }}>
          <div className="highlight"><div className="hl-label">Agent holds</div><div className="hl-value">{fmtInt(Number(l.cuBalance(TOUR_ACTORS.agent.address, btm.id)))} CU</div></div>
          <div className="highlight"><div className="hl-label">$WIF burned from agent</div><div className="hl-value burn">{formatWifAmount(m.agentFeeWifBurned ?? 0n, 0)}</div></div>
          <div className="highlight"><div className="hl-label">Agent staked</div><div className="hl-value">{formatWifAmount(l.stakedWif(TOUR_ACTORS.agent.address), 0)}</div></div>
        </div>
      </div>
    );
  }
  if (step.focus === "clob") {
    return (
      <div className="grid g-2" style={{ gap: 12 }}>
        <div className="book">
          <div className="book-head"><span>Ask</span><span>CU</span><span /></div>
          {[...btm.asks.slice(0, 4)].reverse().map((a) => (
            <div key={`a${a.price}`} className="book-row ask"><span className="px">{formatPrice(a.price)}</span><span>{fmtInt(Number(a.qty))}</span><span /></div>
          ))}
          <div className="spread">last {btm.market.lastTradePrice ? formatPrice(btm.market.lastTradePrice) : "—"}</div>
          {btm.bids.slice(0, 3).map((b) => (
            <div key={`b${b.price}`} className="book-row bid"><span className="px">{formatPrice(b.price)}</span><span>{fmtInt(Number(b.qty))}</span><span /></div>
          ))}
        </div>
        <div>
          <div className="highlight" style={{ marginBottom: 8 }}><div className="hl-label">40 A100 hours × 0.45</div><div className="hl-value">= 18 CU</div></div>
          <div className="highlight" style={{ marginBottom: 8 }}><div className="hl-label">25 H200 hours × 1.40</div><div className="hl-value">= 35 CU</div></div>
          <div className="highlight"><div className="hl-label">Lab buyback burn (30 bps fee)</div><div className="hl-value burn">{formatWifAmount(m.labFeeWifBurned ?? 0n, 2)} $WIF</div></div>
        </div>
      </div>
    );
  }
  if (step.focus === "delivery") {
    const r = ctx.vars.r1 ? l.getRedemption(ctx.vars.r1) : undefined;
    return r ? (
      <div>
        <LifecycleStepper r={r} />
        <div className="grid g-3" style={{ gap: 8 }}>
          <div className="highlight"><div className="hl-label">Receipt</div><div className="hl-value" style={{ fontSize: 12 }}>{r.receiptHash === `0x${"0".repeat(64)}` ? "pending" : `${r.receiptHash.slice(0, 18)}…`}</div></div>
          <div className="highlight"><div className="hl-label">Telemetry</div><div className="hl-value">{r.p95LatencyMs ? `${r.p95LatencyMs} ms · ${(r.uptimeBps / 100).toFixed(2)}%` : "—"}</div></div>
          <div className="highlight"><div className="hl-label">Released to provider</div><div className="hl-value ok">{formatUsdg(l.providerClaimable(TOUR_ACTORS.prime.address))}</div></div>
        </div>
      </div>
    ) : (
      <div className="empty">Redemption pending…</div>
    );
  }
  if (step.focus === "jury") {
    const d = ctx.vars.disputeId ? l.getDispute(ctx.vars.disputeId) : undefined;
    const r = ctx.vars.r2 ? l.getRedemption(ctx.vars.r2) : undefined;
    const total = d ? d.slashVotes + d.upholdVotes || 1n : 1n;
    return (
      <div>
        {r ? <LifecycleStepper r={r} /> : null}
        {d ? (
          <>
            <div className="bar" style={{ height: 14 }}>
              <span className="fill-ask" style={{ width: `${Number((d.slashVotes * 1000n) / total) / 10}%`, transition: "width 600ms" }} />
              <span className="fill-bid" style={{ width: `${Number((d.upholdVotes * 1000n) / total) / 10}%`, transition: "width 600ms" }} />
            </div>
            <div className="between help" style={{ margin: "4px 0 10px" }}>
              <span className="bad">SLASH {formatWifAmount(d.slashVotes, 0)} $WIF burned</span>
              <span className="ok">UPHOLD {formatWifAmount(d.upholdVotes, 0)} $WIF burned</span>
            </div>
          </>
        ) : null}
        {m.agentSlashRefund ? (
          <div className="grid g-4" style={{ gap: 8 }}>
            <div className="highlight"><div className="hl-label">Agent refund (100% + 15%)</div><div className="hl-value ok">{formatUsdg(m.agentSlashRefund)}</div></div>
            <div className="highlight"><div className="hl-label">50% to winning voters</div><div className="hl-value">{formatUsdg(m.voterShareUsdg ?? 0n)}</div></div>
            <div className="highlight"><div className="hl-label">25% bought back &amp; burned</div><div className="hl-value burn">{formatWifAmount(m.slashBurnWif ?? 0n, 0)} $WIF</div></div>
            <div className="highlight"><div className="hl-label">Voter pool (+20% vault draw)</div><div className="hl-value">{formatUsdg(m.disputeRewardPoolUsdg ?? 0n)}</div></div>
          </div>
        ) : null}
        {m.jurorAUsdg ? (
          <table style={{ marginTop: 10 }}>
            <thead><tr><th>Winning voter</th><th className="num">Burned</th><th className="num">USDG upside</th><th className="num">Bonus $WIF</th><th className="num">Return</th></tr></thead>
            <tbody>
              {([["Juror Alpha", 2_500n, m.jurorAUsdg, m.jurorAWif], ["Juror Beta", 1_500n, m.jurorBUsdg, m.jurorBWif], ["Juror Gamma", 1_000n, m.jurorCUsdg, m.jurorCWif], ["CFO agent (filer)", 100n, m.agentJurorUsdg, m.agentJurorWif]] as const).map(([name, burned, u, w]) => {
                const price = l.flywheelStats().wifPriceUsdg;
                const cost = burned * price;
                const value = (u ?? 0n) + ((w ?? 0n) * price) / WIF;
                return (
                  <tr key={name}>
                    <td>{name}</td>
                    <td className="num">{fmtInt(Number(burned))} $WIF</td>
                    <td className="num ok">{formatUsdg(u ?? 0n)}</td>
                    <td className="num">{formatWifAmount(w ?? 0n, 0)}</td>
                    <td className="num ok">+{fmtInt(Number(((value - cost) * 100n) / (cost || 1n)))}%</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : null}
      </div>
    );
  }
  const tally = l.corridorTally(0);
  const max = tally.reduce((a, b) => (b > a ? b : a), 1n);
  return (
    <div>
      {snap.corridors.map((c, i) => (
        <BarRow key={c.id} label={`${c.code} · ${c.name}`} value={Number(tally[i] / WIF)} max={Number(max / WIF) || 1} tone={i === 1 ? "fill-burn" : "fill-dim"} note={`${formatWifAmount(tally[i], 0)} $WIF`} />
      ))}
      {m.boostedMarginBps ? <p className="ok" style={{ margin: 0 }}>Batam-Singapore H200 elected: Prime margin {Number(m.boostedMarginBps) / 100}% next epoch (from 25%).</p> : null}
    </div>
  );
}

export function CodedTourController() {
  const router = useRouter();
  const { setOverlay, adoptWorld, bump, notify } = useProtocol();
  const [ctx, setCtx] = useState<TourContext>(() => createTourContext());
  const [pos, setPos] = useState({ step: 0, beat: 0 });
  const [records, setRecords] = useState<Record<string, TourActionRecord>>({});
  const [status, setStatus] = useState<Status>("idle");
  const [speed, setSpeed] = useState(1);
  const [version, setVersion] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const actions = useRef<TourActionRecord[]>([]);
  const before = useRef<Record<string, string> | null>(null);

  useEffect(() => {
    setOverlay(ctx.world);
    return () => setOverlay(null);
  }, [ctx, setOverlay]);

  const totalBeats = TOUR_STEPS.reduce((a, s) => a + s.beats.length, 0);
  const done = Object.keys(records).length;

  const runNext = () => {
    const step = TOUR_STEPS[pos.step];
    if (!step) {
      setStatus("done");
      return;
    }
    if (pos.beat === 0) {
      before.current = flywheelRecord(ctx.world.ledger);
      actions.current = [];
    }
    try {
      const rec = runTourBeat(ctx, step.beats[pos.beat]);
      actions.current.push(rec);
      setRecords((r) => ({ ...r, [`${pos.step}:${pos.beat}`]: rec }));
      if (pos.beat + 1 >= step.beats.length) {
        sealReceipt(ctx, step, actions.current, before.current ?? flywheelRecord(ctx.world.ledger));
        const next = pos.step + 1;
        setPos({ step: next, beat: 0 });
        if (next >= TOUR_STEPS.length) setStatus("done");
      } else {
        setPos({ step: pos.step, beat: pos.beat + 1 });
      }
      setVersion((v) => v + 1);
      bump();
    } catch (error) {
      setStatus("paused");
      notify({ kind: "err", title: "Tour step reverted", body: explainError(error) });
    }
  };

  const runNextRef = useRef(runNext);
  runNextRef.current = runNext;
  useEffect(() => {
    if (status !== "playing") return;
    const delay = (pos.beat === 0 ? STEP_PAUSE_MS + BEAT_MS * 0.4 : BEAT_MS) / speed;
    const id = setTimeout(() => runNextRef.current(), delay);
    return () => clearTimeout(id);
  }, [status, pos, speed]);

  useEffect(() => {
    if (status !== "playing") return;
    const id = setInterval(() => setElapsed((e) => e + 0.25 * speed), 250);
    return () => clearInterval(id);
  }, [status, speed]);

  const restart = (autoplay: boolean) => {
    setCtx(createTourContext());
    setPos({ step: 0, beat: 0 });
    setRecords({});
    setElapsed(0);
    setVersion((v) => v + 1);
    setStatus(autoplay ? "playing" : "idle");
  };

  const download = () => {
    const body = {
      schema: "paron-wif-tour-receipts/v1",
      generatedAt: new Date(Number(ctx.world.ledger.now) * 1000).toISOString(),
      chainId: ctx.world.ledger.params.chainId,
      mode: "deterministic-local-simulation",
      parity: "Every metric is asserted on-chain by contracts/test/ParonWifTour.t.sol against packages/core/fixtures/tour-golden.json.",
      hashChainValid: verifyReceiptChain(ctx.receipts) === -1,
      receipts: ctx.receipts,
    };
    const blob = new Blob([JSON.stringify(body, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "paron-wif-judge-tour-receipts.json";
    a.click();
    URL.revokeObjectURL(url);
  };

  const stepIdx = status === "done" || pos.step >= TOUR_STEPS.length ? TOUR_STEPS.length - 1 : pos.step;
  const current = TOUR_STEPS[stepIdx];
  const highlights = current.highlights(ctx);

  return (
    <div className="tour-grid">
      <div className="stack">
        <Panel tight title="60-second coded judge tour" right={<Pill tone={status === "done" ? "ok" : status === "playing" ? "accent" : "outline"}>{status === "done" ? "complete" : status === "playing" ? `${elapsed.toFixed(0)}s` : status}</Pill>}>
          <div className="progress" style={{ marginBottom: 12 }}>
            <span style={{ width: `${(done / totalBeats) * 100}%` }} />
          </div>
          <div className="row" style={{ marginBottom: 12 }}>
            {status === "playing" ? (
              <button className="btn" type="button" onClick={() => setStatus("paused")}>❚❚ Pause</button>
            ) : status === "done" ? (
              <button className="btn" type="button" onClick={() => restart(true)}>↻ Replay</button>
            ) : (
              <button className="btn lg" type="button" onClick={() => setStatus("playing")}>▶ {done === 0 ? "Play the 60-second tour" : "Resume"}</button>
            )}
            <button className="btn ghost sm" type="button" disabled={status === "playing" || status === "done"} onClick={runNext}>Next beat</button>
            <button className="btn ghost sm" type="button" onClick={() => setSpeed((s) => (s === 1 ? 2 : s === 2 ? 4 : 1))}>{speed}x</button>
            <button className="btn ghost sm" type="button" onClick={() => restart(false)}>Reset</button>
          </div>
          <ol className="tour-steps">
            {TOUR_STEPS.map((s, i) => {
              const state = i < pos.step || status === "done" ? "done" : i === stepIdx ? "now" : "todo";
              return (
                <li key={s.key}>
                  <div className="tour-step" data-state={state}>
                    <span className="n">{state === "done" ? "✓" : String(s.n).padStart(2, "0")}</span>
                    <span>
                      <div className="t">{s.title}</div>
                      <div className="l">{s.loop}</div>
                    </span>
                  </div>
                </li>
              );
            })}
          </ol>
        </Panel>
        <Panel tight title="Audit receipts">
          <p className="help" style={{ marginTop: 0 }}>
            Each completed step seals a JSON receipt (every call, every event, flywheel before/after) into a keccak256 hash chain.
          </p>
          <div className="kv">
            {ctx.receipts.map((r) => (
              <div key={r.hash} className="kv-row">
                <span>Step {r.step} · {r.actions.reduce((a, x) => a + x.events.length, 0)} events</span>
                <span title={r.hash}>{r.hash.slice(0, 12)}…</span>
              </div>
            ))}
            {ctx.receipts.length === 0 ? <div className="help">No receipts yet.</div> : null}
          </div>
          <div className="row" style={{ marginTop: 10 }}>
            <button className="btn ghost sm" type="button" disabled={ctx.receipts.length === 0} onClick={download}>⬇ Download JSON receipts</button>
            <button className="btn ghost sm" type="button" disabled={status !== "done"} onClick={() => { adoptWorld(ctx.world); router.push("/flywheel"); }}>Continue in this world →</button>
          </div>
        </Panel>
      </div>
      <div className="stack">
        <Panel title={<>Step {current.n} · <b>{current.title}</b></>} right={<Pill tone="accent">{current.loop}</Pill>}>
          <p className="lede" style={{ marginBottom: 14 }}>{current.summary}</p>
          <ul className="beats">
            {current.beats.map((b, i) => {
              const rec = records[`${stepIdx}:${i}`];
              const state = rec ? "done" : stepIdx === pos.step && i === pos.beat && status === "playing" ? "now" : "pending";
              return (
                <li key={b.id} className="beat" data-state={state}>
                  <span>{rec ? "✓" : state === "now" ? "●" : "○"}</span>
                  <span>
                    <div>{b.caption}</div>
                    <div className="call">{b.call} · {b.actor === "protocol" ? "permissionless" : TOUR_ACTORS[b.actor].name}</div>
                  </span>
                  <span className="evs">{rec ? rec.events.map((e) => e.name).filter((n, j, arr) => arr.indexOf(n) === j).join(" · ") : ""}</span>
                </li>
              );
            })}
          </ul>
        </Panel>
        <Panel title="Live protocol state" right={<Pill tone="ok">golden-parity with the contracts</Pill>}>
          <TourStage ctx={ctx} stepIndex={stepIdx} version={version} />
        </Panel>
        <div className="highlight-grid">
          {highlights.map((h) => (
            <div key={h.label} className="highlight">
              <div className="hl-label">{h.label}</div>
              <div className="hl-value">{h.value}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
