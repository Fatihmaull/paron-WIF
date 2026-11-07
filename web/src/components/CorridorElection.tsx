"use client";

import { useState } from "react";
import { formatWifAmount, formatWifCompact } from "@paron-wif/core";
import { useProtocol } from "@/lib/protocol";
import { Countdown, NumField, Panel, Pill, parseDecimal } from "./ui";

/** Panel 3: burn $WIF to elect the compute corridor that gets the next epoch's Vault margin boost. */
export function CorridorElection() {
  const { snapshot, actions, busy, overlay } = useProtocol();
  const [amount, setAmount] = useState("2500");
  const e = snapshot.epoch;
  const total = e.tally.reduce((a, b) => a + b, 0n) || 1n;
  const leader = e.tally.reduce((best, v, i) => (v > (e.tally[best] ?? 0n) ? i : best), 0);
  const burn = parseDecimal(amount, 18) ?? 0n;
  const boosted = e.boosted.active ? snapshot.corridors[e.boosted.corridorId] : null;
  return (
    <Panel title={<>Panel 3 · <b>Next compute corridor election</b></>} right={<span className="help">epoch {e.current} ends <Countdown to={e.endsAt} /></span>}>
      <div className="between" style={{ marginBottom: 12, padding: "10px 12px", border: "1px solid var(--line)", borderRadius: 4 }}>
        <span className="dim">Boost active this epoch</span>
        {boosted ? <Pill tone="burn">{boosted.name} · -2.5% provider margin</Pill> : <Pill tone="outline">none yet</Pill>}
      </div>
      {snapshot.corridors.map((c, i) => {
        const v = e.tally[i] ?? 0n;
        const pct = Number((v * 1000n) / total) / 10;
        return (
          <div key={c.id} style={{ marginBottom: 12 }}>
            <div className="between" style={{ marginBottom: 4 }}>
              <span className="row">
                <span className="num" style={{ fontWeight: 600 }}>{c.code}</span>
                <span>{c.name}</span>
                {i === leader && v > 0n ? <Pill tone="accent">leading</Pill> : null}
              </span>
              <span className="row">
                <span className="num">{formatWifCompact(v)} $WIF</span>
                <button className="btn burn sm" type="button" disabled={busy || !!overlay || burn === 0n} onClick={() => void actions.voteCorridor(c.id, burn)}>
                  Burn {formatWifAmount(burn, 0)}
                </button>
              </span>
            </div>
            <div className="bar"><span className={i === leader ? "fill-burn" : "fill-dim"} style={{ width: `${pct}%` }} /></div>
          </div>
        );
      })}
      <NumField id="corridor-burn" label="$WIF to burn per vote" value={amount} onChange={setAmount} suffix="$WIF" help="Votes are permanent burns. The winner's providers mint at 2.5% lower margin for the following epoch." />
      {e.current > 0 && !e.previousFinalized && e.previousTotal > 0n ? (
        <button className="btn ghost block" style={{ marginTop: 10 }} type="button" disabled={busy || !!overlay} onClick={() => void actions.finalizeEpoch(e.current - 1)}>
          Finalize epoch {e.current - 1} (permissionless)
        </button>
      ) : null}
      {e.previousWinner !== null ? <p className="help">Epoch {e.current - 1} winner: {snapshot.corridors[e.previousWinner]?.name}.</p> : null}
    </Panel>
  );
}
