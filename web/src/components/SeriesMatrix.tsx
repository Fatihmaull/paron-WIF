"use client";

import { useState } from "react";
import { GPU_LABEL, GPU_TIERS, GPU_WEIGHT_BPS, cuForGpuHours, formatPrice, gpuHoursForCu, type GpuTier, type SeriesView } from "@paron-wif/core";
import { useProtocol } from "@/lib/protocol";
import { NumField, Panel, Pill, fmtInt, fmtNum, formatDuration } from "./ui";

function deliveryStatus(s: SeriesView, now: bigint): { label: string; tone: "ok" | "info" | "outline" } {
  if (now >= s.deliveryEnd) return { label: "Expired", tone: "outline" };
  if (now >= s.deliveryStart) return { label: "Deliverable", tone: "ok" };
  return { label: `Forward · opens in ${formatDuration(Number(s.deliveryStart - now))}`, tone: "info" };
}

function monthLabel(yymm: number): string {
  const yy = Math.floor(yymm / 100);
  const mm = yymm % 100;
  return new Date(Date.UTC(2000 + yy, mm - 1, 1)).toLocaleString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
}

/** Canonical CU series: one per corridor x hardware x month, each with one deep book. */
export function SeriesMatrix({ selected, onSelect }: { selected: number; onSelect: (id: number) => void }) {
  const { snapshot } = useProtocol();
  return (
    <Panel title={<>Standardized series matrix · <b>1 CU = 1 H100-SXM-80GB hour</b></>} right={<Pill tone="accent">{snapshot.series.length} canonical books</Pill>}>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Series</th>
              <th>Hardware</th>
              <th>Corridor</th>
              <th>Delivery</th>
              <th className="num">Bid</th>
              <th className="num">Ask</th>
              <th className="num">Last</th>
              <th className="num">Volume</th>
              <th className="num">Open interest</th>
            </tr>
          </thead>
          <tbody>
            {snapshot.series.map((s) => {
              const st = deliveryStatus(s, snapshot.now);
              return (
                <tr key={s.id} className="click" data-selected={s.id === selected} onClick={() => onSelect(s.id)}>
                  <td>
                    <span className="row" style={{ gap: 6 }}>
                      <span className="num" style={{ fontWeight: 600 }}>{s.symbol}</span>
                      {s.boosted ? <Pill tone="burn" title="Won the last corridor election: -2.5% provider margin this epoch">boosted</Pill> : null}
                    </span>
                  </td>
                  <td>
                    {s.gpuTier} <span className="muted">{(Number(GPU_WEIGHT_BPS[s.gpuTier]) / 10_000).toFixed(2)}x</span>
                  </td>
                  <td className="dim">{s.corridorName}</td>
                  <td>
                    <span className="row" style={{ gap: 6 }}>
                      {monthLabel(s.yymm)} <Pill tone={st.tone}>{st.label}</Pill>
                    </span>
                  </td>
                  <td className="num bid">{s.market.bestBid ? formatPrice(s.market.bestBid) : "—"}</td>
                  <td className="num ask">{s.market.bestAsk ? formatPrice(s.market.bestAsk) : "—"}</td>
                  <td className="num">{s.market.lastTradePrice ? formatPrice(s.market.lastTradePrice) : "—"}</td>
                  <td className="num">{fmtInt(Number(s.market.volumeCu))} CU</td>
                  <td className="num accent">{fmtInt(Number(s.market.openInterestCu))} CU</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="help" style={{ marginTop: 10 }}>
        Prices in USDG per CU. Series are canonical and derived on-chain from (corridor, hardware, delivery month): anyone can list one, nobody can fragment one.
      </p>
    </Panel>
  );
}

/** Hardware Equivalent Converter: native GPU hours <-> canonical H100-equivalent CU. */
export function HardwareConverter() {
  const [tier, setTier] = useState<GpuTier>("A100");
  const [hours, setHours] = useState("40");
  const [cu, setCu] = useState("35");
  const [backTier, setBackTier] = useState<GpuTier>("H200");
  const h = Number(hours || 0);
  const c = Number(cu || 0);
  return (
    <Panel title="Hardware equivalent converter" right={<Pill tone="outline">on-chain weights</Pill>}>
      <div className="grid g-2" style={{ gap: 12 }}>
        <div className="field">
          <span className="label">Native hardware</span>
          <div className="input-wrap">
            <select value={tier} onChange={(e) => setTier(e.target.value as GpuTier)} aria-label="Native GPU">
              {GPU_TIERS.map((t) => (
                <option key={t} value={t}>
                  {t} · {(Number(GPU_WEIGHT_BPS[t]) / 10_000).toFixed(2)}x
                </option>
              ))}
            </select>
          </div>
        </div>
        <NumField id="conv-hours" label="GPU hours" value={hours} onChange={setHours} suffix={`${tier} h`} />
      </div>
      <div className="between" style={{ margin: "10px 0 14px", padding: "10px 12px", border: "1px solid var(--line)", borderRadius: 4 }}>
        <span className="dim">{fmtNum(h)} {tier} hours</span>
        <span className="num accent" style={{ fontSize: 18 }}>= {fmtNum(cuForGpuHours(tier, h), 2)} CU</span>
      </div>
      <div className="grid g-2" style={{ gap: 12 }}>
        <NumField id="conv-cu" label="Compute units" value={cu} onChange={setCu} suffix="CU" />
        <div className="field">
          <span className="label">Delivered on</span>
          <div className="input-wrap">
            <select value={backTier} onChange={(e) => setBackTier(e.target.value as GpuTier)} aria-label="Delivery GPU">
              {GPU_TIERS.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>
      <div className="between" style={{ margin: "10px 0 12px", padding: "10px 12px", border: "1px solid var(--line)", borderRadius: 4 }}>
        <span className="dim">{fmtNum(c)} CU</span>
        <span className="num" style={{ fontSize: 18 }}>= {fmtNum(gpuHoursForCu(backTier, c), 2)} {backTier} hours</span>
      </div>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>GPU</th>
              <th className="num">Weight</th>
              <th className="num">CU per hour</th>
            </tr>
          </thead>
          <tbody>
            {GPU_TIERS.map((t) => (
              <tr key={t}>
                <td title={GPU_LABEL[t]}>{GPU_LABEL[t]}</td>
                <td className="num">{(Number(GPU_WEIGHT_BPS[t]) / 10_000).toFixed(2)}x</td>
                <td className="num">{fmtNum(cuForGpuHours(t, 1), 2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}
