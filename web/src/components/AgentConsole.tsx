"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  CfoComputeAgent,
  DEFAULT_AGENT_POLICY,
  GENESIS_ACTORS,
  InferenceLoadModel,
  LedgerAgentBackend,
  formatPrice,
  formatUsdg,
  formatWifAmount,
  type AgentLogEntry,
  type AgentMemory,
} from "@paron-wif/core";
import { useProtocol } from "@/lib/protocol";
import { runCounterparties, type CounterpartyMode } from "@/lib/simCounterparties";
import { KV, NumField, Panel, Pill, Toggle, fmtInt } from "./ui";

const AGENT = GENESIS_ACTORS.cfoAgent;
const TICK_SECONDS = 20 * 60;

function LoadChart({ now, model }: { now: number; model: InferenceLoadModel }) {
  const hours = Array.from({ length: 30 }, (_, i) => i - 23);
  const samples = hours.map((h) => ({ h, s: model.sample(now + h * 3_600) }));
  const max = Math.max(...samples.map((x) => x.s.tokensPerSec));
  const w = 720;
  const hgt = 150;
  const bw = w / samples.length;
  return (
    <svg viewBox={`0 0 ${w} ${hgt + 24}`} width="100%" height={hgt + 24} role="img" aria-label="LLM inference load, last 24 hours and 6-hour forecast">
      <rect x={23 * bw} y={0} width={7 * bw} height={hgt} fill="rgba(217,160,102,0.07)" />
      <text x={23 * bw + 6} y={14} fill="#d9a066" fontSize="11" fontFamily="IBM Plex Mono, monospace">forecast window</text>
      {samples.map(({ h, s }, i) => {
        const bh = (s.tokensPerSec / max) * (hgt - 20);
        const hot = s.gpuUtilization >= DEFAULT_AGENT_POLICY.utilizationRedeemTrigger;
        return (
          <g key={h}>
            <rect x={i * bw + 2} y={hgt - bh} width={bw - 4} height={bh} rx="2" fill={h > 0 ? "rgba(217,160,102,0.55)" : hot ? "#ff7a3d" : "#3a4250"}>
              <title>{`${h >= 0 ? "+" : ""}${h}h · ${s.tokensPerSec.toLocaleString("en-US")} tok/s · ${s.h100Equivalent} H100-eq · util ${(s.gpuUtilization * 100).toFixed(0)}%`}</title>
            </rect>
            {i % 6 === 0 ? (
              <text x={i * bw + bw / 2} y={hgt + 16} fill="#8c9099" fontSize="10" textAnchor="middle" fontFamily="IBM Plex Mono, monospace">
                {h === 0 ? "now" : `${h}h`}
              </text>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}

export function AgentConsole() {
  const { world, bump, snapshot, mode, nameOf } = useProtocol();
  const [latency, setLatency] = useState(String(DEFAULT_AGENT_POLICY.latencySlaMs));
  const [premium, setPremium] = useState(String(DEFAULT_AGENT_POLICY.maxPremiumToIndexBps));
  const [coverage, setCoverage] = useState(String(DEFAULT_AGENT_POLICY.coverageHours));
  const [auto, setAuto] = useState(false);
  const [providerMode, setProviderMode] = useState<CounterpartyMode>("degraded");
  const [log, setLog] = useState<AgentLogEntry[]>([]);
  const [ticks, setTicks] = useState(0);
  const memory = useRef<AgentMemory | null>(null);
  const worldRef = useRef(world);
  worldRef.current = world;
  const model = useMemo(() => new InferenceLoadModel(), []);

  const policy = useMemo(
    () => ({
      ...DEFAULT_AGENT_POLICY,
      latencySlaMs: Number(latency || DEFAULT_AGENT_POLICY.latencySlaMs),
      maxPremiumToIndexBps: BigInt(Math.floor(Number(premium || 0))),
      coverageHours: Math.max(1, Math.floor(Number(coverage || 6))),
    }),
    [latency, premium, coverage],
  );

  useEffect(() => {
    memory.current = null;
    setLog([]);
    setTicks(0);
  }, [world]);

  const running = useRef(false);
  const tick = async () => {
    if (running.current) return;
    running.current = true;
    try {
      const w = worldRef.current;
      const agent = new CfoComputeAgent(new LedgerAgentBackend(() => worldRef.current.ledger, AGENT.address), policy, model, memory.current ?? undefined);
      const report = await agent.tick();
      memory.current = agent.memory;
      const notes = runCounterparties(w, providerMode);
      w.ledger.advance(TICK_SECONDS);
      const extra: AgentLogEntry[] = notes.map((m) => ({ tick: report.tick, t: report.sample.t, kind: "observe", message: `counterparty: ${m}` }));
      setLog((prev) => [...prev, ...report.log, ...extra].slice(-240));
      setTicks(report.tick);
      bump();
    } finally {
      running.current = false;
    }
  };

  const tickRef = useRef(tick);
  tickRef.current = tick;
  useEffect(() => {
    if (!auto) return;
    const id = setInterval(() => void tickRef.current(), 2_200);
    return () => clearInterval(id);
  }, [auto]);

  const logRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [log]);

  const l = world.ledger;
  const a = AGENT.address;
  const burnedByAgent = l.events({ name: "WifFlywheelBurned" }).filter((e) => e.args.actor === a).reduce((acc, e) => acc + BigInt(e.args.wifBurned), 0n);
  const bought = l.events({ name: "Trade" }).filter((e) => e.args.taker === a && e.args.takerIsBuyer).reduce((acc, e) => acc + BigInt(e.args.qty), 0n);
  const disputesFiled = l.listDisputes().filter((d) => d.challenger === a).length;
  const reds = l.listRedemptions().filter((r) => r.holder === a);
  const now = Number(l.now);
  const sample = model.sample(now);
  const forecast = model.forecastCu(now, policy.coverageHours);

  return (
    <div className="stack">
      {mode === "live" ? (
        <div className="banner info" style={{ borderRadius: 6 }}>
          The in-browser agent runs on the deterministic simulation. The live agent signs real transactions from the CLI: <span className="num">AGENT_PRIVATE_KEY=… RPC_URL=… npm run agent</span>
        </div>
      ) : null}
      <div className="grid g-4">
        <div className="stat"><div className="stat-label">LLM load now</div><div className="stat-value">{fmtInt(sample.tokensPerSec)}</div><div className="stat-sub">tok/s · {sample.h100Equivalent} H100-eq · util {(sample.gpuUtilization * 100).toFixed(0)}%</div></div>
        <div className="stat"><div className="stat-label">{policy.coverageHours}h forecast</div><div className="stat-value">{fmtInt(forecast)} CU</div><div className="stat-sub">holding {fmtInt(Number(snapshot.series.reduce((acc, s) => acc + l.cuBalance(a, s.id), 0n)))} CU</div></div>
        <div className="stat"><div className="stat-label">$WIF burned by the agent</div><div className="stat-value burn">{formatWifAmount(burnedByAgent, 0)}</div><div className="stat-sub">fees in $WIF mode + dispute filings</div></div>
        <div className="stat"><div className="stat-label">Agent wallet</div><div className="stat-value">{formatUsdg(l.usdgBalance(a), 0)}</div><div className="stat-sub">{formatWifAmount(l.wifBalance(a), 0)} $WIF · {formatWifAmount(l.stakedWif(a), 0)} staked</div></div>
      </div>
      <div className="grid g-main">
        <Panel title={<>Inference load · <b>CFO Compute Agent</b></>} right={<Pill tone={l.hasWifFeeDiscount(a) ? "burn" : "outline"}>{l.hasWifFeeDiscount(a) ? "10 bps · $WIF priority lane" : "30 bps"}</Pill>}>
          <LoadChart now={now} model={model} />
          <div className="row" style={{ marginTop: 10 }}>
            <button className="btn" type="button" onClick={() => void tick()}>
              Run one agent tick (+20 min)
            </button>
            <div style={{ minWidth: 240 }}>
              <Toggle on={auto} onChange={setAuto} label="Auto-run" sub="one tick every 2.2 s" />
            </div>
            <div style={{ minWidth: 300 }}>
              <Toggle
                on={providerMode === "degraded"}
                onChange={(v) => setProviderMode(v ? "degraded" : "honest")}
                label={providerMode === "degraded" ? "Providers deliver degraded clusters" : "Providers deliver nominal clusters"}
                sub="toggle to watch the agent confirm vs. dispute"
              />
            </div>
          </div>
          <div className="overline" style={{ margin: "14px 0 6px" }}>Decision log · tick {ticks}</div>
          <div className="log" ref={logRef}>
            {log.length === 0 ? <div className="muted">Press “Run one agent tick”. The agent observes load, stakes $WIF, buys the cheapest CU vs the index, redeems on peaks and polices every delivery.</div> : null}
            {log.map((e, i) => (
              <div key={i} className={`log-line ${e.kind}`}>
                <span className="tag">{e.kind === "observe" ? "OBS" : e.kind === "decide" ? "PLAN" : e.kind === "act" ? "ACT" : "ERR"}</span>
                <span className="muted">#{String(e.tick).padStart(3, "0")} </span>
                {e.message}
              </div>
            ))}
          </div>
        </Panel>
        <div className="stack">
          <Panel title="Policy">
            <div className="grid g-2" style={{ gap: 10 }}>
              <NumField id="pol-lat" label="p95 latency SLA" value={latency} onChange={setLatency} suffix="ms" />
              <NumField id="pol-prem" label="Max premium vs CRI" value={premium} onChange={setPremium} suffix="bps" />
              <NumField id="pol-cov" label="Coverage horizon" value={coverage} onChange={setCoverage} suffix="h" />
              <div className="field"><span className="label">Fee mode</span><div className="input-wrap"><span className="num" style={{ padding: "0 10px" }}>$WIF discount (auto)</span></div></div>
            </div>
            <KV
              rows={[
                ["CU bought on the book", `${fmtInt(Number(bought))} CU`],
                ["Redemptions", `${reds.length} (${reds.filter((r) => r.state === "Finalized").length} delivered, ${reds.filter((r) => r.state === "Slashed").length} slashed)`],
                ["SLA disputes filed", String(disputesFiled)],
                ["CRI-H100", `${formatPrice(snapshot.cri.price)} USDG/CU`],
              ]}
            />
          </Panel>
          <Panel title="Agent fleet">
            {[GENESIS_ACTORS.cfoAgent, GENESIS_ACTORS.routerAgent].map((ag) => (
              <div key={ag.key} className="between" style={{ padding: "8px 0", borderBottom: "1px solid var(--line)" }}>
                <span>
                  <div style={{ fontWeight: 500 }}>{nameOf(ag.address)}</div>
                  <div className="help">{ag.description}</div>
                </span>
                <span className="num" style={{ textAlign: "right" }}>
                  {formatWifAmount(l.stakedWif(ag.address), 0)} $WIF staked
                  <div className="help">{snapshot.series.map((s) => `${s.corridorCode} ${l.cuBalance(ag.address, s.id)}`).join(" · ")} CU</div>
                </span>
              </div>
            ))}
            <p className="help">Run the same agent against a live deployment: <span className="num">npm run agent</span> (simulation) or with <span className="num">AGENT_PRIVATE_KEY</span> + <span className="num">RPC_URL</span> (live signing).</p>
          </Panel>
        </div>
      </div>
    </div>
  );
}
