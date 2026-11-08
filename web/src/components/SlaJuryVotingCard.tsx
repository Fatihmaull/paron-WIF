"use client";

import { useState } from "react";
import { SLA_MAX_P95_LATENCY_MS, SLA_MIN_UPTIME_BPS, WIF, formatUsdg, formatWifAmount, type Dispute } from "@paron-wif/core";
import { useProtocol } from "@/lib/protocol";
import { Countdown, NumField, Panel, Pill, parseDecimal } from "./ui";

function statusPill(d: Dispute, now: bigint) {
  if (d.status === "ResolvedSlash") return <Pill tone="bad">SLASHED</Pill>;
  if (d.status === "ResolvedUphold") return <Pill tone="ok">UPHELD</Pill>;
  if (now >= d.votingEndsAt) return <Pill tone="warn">voting ended · resolve</Pill>;
  return <Pill tone="dispute">voting open</Pill>;
}

function DisputeCard({ d }: { d: Dispute }) {
  const { snapshot, actions, busy, overlay, nameOf, me } = useProtocol();
  const [amount, setAmount] = useState("1000");
  const r = snapshot.redemptions.find((x) => x.id === d.redemptionId);
  const series = snapshot.series.find((s) => s.id === r?.seriesId);
  const total = d.slashVotes + d.upholdVotes || 1n;
  const slashPct = Number((d.slashVotes * 1000n) / total) / 10;
  const myVote = snapshot.account?.votes[d.id];
  const pending = snapshot.account?.pendingUpside.find((p) => p.disputeId === d.id);
  const open = d.status === "Open" && snapshot.now < d.votingEndsAt;
  const resolvable = d.status === "Open" && snapshot.now >= d.votingEndsAt;
  const burn = parseDecimal(amount, 18) ?? 0n;
  const disabled = busy || !!overlay;
  const wifPrice = snapshot.flywheel.wifPriceUsdg;
  const winning = d.status === "ResolvedSlash" ? d.slashVotes : d.upholdVotes;
  const burnedValue = (winning * wifPrice) / WIF;
  const rewardValue = d.rewardPoolUsdg + (d.rewardPoolWif * wifPrice) / WIF;
  const roi = burnedValue > 0n ? Number(((rewardValue - burnedValue) * 10_000n) / burnedValue) / 100 : 0;
  return (
    <div className="panel tight" style={{ marginBottom: 12 }}>
      <div className="between" style={{ marginBottom: 8 }}>
        <span className="row">
          <span className="num" style={{ fontWeight: 600 }}>Dispute #{d.id}</span>
          {statusPill(d, snapshot.now)}
          <span className="dim">redemption #{d.redemptionId} · {series?.symbol} · {r ? `${r.cuAmount} CU` : ""}</span>
        </span>
        {d.status === "Open" ? <span className="help">round ends <Countdown to={d.votingEndsAt} /></span> : null}
      </div>
      <div className="grid g-2" style={{ gap: 12 }}>
        <div>
          <div className="overline" style={{ marginBottom: 4 }}>Evidence</div>
          <div className="kv">
            <div className="kv-row"><span>Challenger</span><span>{nameOf(d.challenger)}</span></div>
            <div className="kv-row"><span>Provider</span><span>{r ? nameOf(r.provider) : "—"}</span></div>
            <div className="kv-row"><span>Reported p95 latency</span><span className={r && r.p95LatencyMs > SLA_MAX_P95_LATENCY_MS ? "bad" : "ok"}>{r?.p95LatencyMs ?? "—"} ms / SLA {SLA_MAX_P95_LATENCY_MS}</span></div>
            <div className="kv-row"><span>Reported uptime</span><span className={r && r.uptimeBps < SLA_MIN_UPTIME_BPS ? "bad" : "ok"}>{r ? (r.uptimeBps / 100).toFixed(2) : "—"}% / SLA {(SLA_MIN_UPTIME_BPS / 100).toFixed(2)}</span></div>
            <div className="kv-row"><span>Receipt hash</span><span title={r?.receiptHash}>{r?.receiptHash.slice(0, 14)}…</span></div>
            <div className="kv-row"><span>Evidence hash</span><span title={d.evidenceHash}>{d.evidenceHash.slice(0, 14)}…</span></div>
          </div>
          <p className="help" style={{ marginBottom: 0 }}>“{d.reason}”</p>
        </div>
        <div>
          <div className="overline" style={{ marginBottom: 4 }}>Burn-to-vote tally · 1 $WIF burned = 1 vote</div>
          <div className="bar" style={{ height: 12 }}>
            <span className="fill-ask" style={{ width: `${slashPct}%` }} />
            <span className="fill-bid" style={{ width: `${100 - slashPct}%` }} />
          </div>
          <div className="between help" style={{ marginTop: 4 }}>
            <span className="bad">SLASH {formatWifAmount(d.slashVotes, 0)}</span>
            <span>{d.voterCount} voters</span>
            <span className="ok">UPHOLD {formatWifAmount(d.upholdVotes, 0)}</span>
          </div>
          {open ? (
            <>
              <div style={{ marginTop: 10 }}>
                <NumField id={`vote-${d.id}`} label="$WIF to burn (permanent)" value={amount} onChange={setAmount} suffix="$WIF" help={myVote ? `You burned ${formatWifAmount(myVote.slash + myVote.uphold, 0)} for ${myVote.slash > 0n ? "SLASH" : "UPHOLD"}` : undefined} />
              </div>
              <div className="row" style={{ marginTop: 8 }}>
                <button className="btn sell sm" type="button" disabled={disabled || burn === 0n || (myVote?.uphold ?? 0n) > 0n} onClick={() => void actions.vote(d.id, true, burn)}>
                  🔥 Burn → SLASH_PROVIDER
                </button>
                <button className="btn buy sm" type="button" disabled={disabled || burn === 0n || (myVote?.slash ?? 0n) > 0n} onClick={() => void actions.vote(d.id, false, burn)}>
                  🔥 Burn → UPHOLD_DELIVERY
                </button>
              </div>
            </>
          ) : null}
          {resolvable ? (
            <button className="btn block" style={{ marginTop: 10 }} type="button" disabled={disabled} onClick={() => void actions.resolve(d.id)}>
              Resolve: execute the majority outcome
            </button>
          ) : null}
          {d.status !== "Open" ? (
            <div className="kv" style={{ marginTop: 10 }}>
              <div className="kv-row"><span>Winner pool</span><span>{formatUsdg(d.rewardPoolUsdg)} + {formatWifAmount(d.rewardPoolWif, 0)} $WIF</span></div>
              <div className="kv-row"><span>Claimed</span><span>{formatUsdg(d.claimedUsdg)} + {formatWifAmount(d.claimedWif, 0)} $WIF</span></div>
              <div className="kv-row"><span>Winning voters&apos; return on burned $WIF</span><span className={roi >= 0 ? "ok" : "bad"}>{roi >= 0 ? "+" : ""}{roi.toFixed(0)}%</span></div>
            </div>
          ) : null}
          {pending ? (
            <button className="btn buy block" style={{ marginTop: 10 }} type="button" disabled={disabled} onClick={() => void actions.claimUpside(d.id)}>
              Claim your upside: {formatUsdg(pending.usdg, 4)} + {formatWifAmount(pending.wif, 2)} $WIF
            </button>
          ) : null}
        </div>
      </div>
      {r?.holder === me.toLowerCase() && d.status === "ResolvedSlash" ? <p className="help ok">You were refunded 100% principal + 15% SLA compensation.</p> : null}
    </div>
  );
}

/** Panel 2: decentralized $WIF SLA jury. Votes burn $WIF permanently; winners earn real USDG + bonus $WIF. */
export function SlaJuryVotingCard() {
  const { snapshot, actions, busy, overlay, me } = useProtocol();
  const disputes = [...snapshot.disputes].sort((a, b) => (a.status === "Open" ? -1 : 0) - (b.status === "Open" ? -1 : 0) || b.id - a.id);
  const disputable = snapshot.redemptions.filter((r) => r.holder === me.toLowerCase() && r.state === "Delivered" && snapshot.now <= r.challengeDeadline);
  return (
    <Panel title={<>Panel 2 · <b>Decentralized $WIF SLA jury</b> · votes burn $WIF permanently</>} right={<Pill tone="dispute">{disputes.filter((d) => d.status === "Open").length} open</Pill>}>
      <p className="help" style={{ marginTop: 0 }}>
        Replaces the legacy central verifier. A SLASH outcome refunds the buyer 100% + 15% from the provider&apos;s margin, sends 50% of the remaining margin to winning voters, buys back and burns $WIF with 25% and refills The Paron Vault with 25%.
      </p>
      {disputable.length > 0 ? (
        <div className="panel tight" style={{ marginBottom: 12, borderColor: "rgba(176,156,251,0.5)" }}>
          <div className="overline" style={{ marginBottom: 6 }}>Your deliveries inside the challenge window</div>
          {disputable.map((r) => (
            <div key={r.id} className="between" style={{ padding: "4px 0" }}>
              <span className="dim">#{r.id} · {r.cuAmount} CU · p95 {r.p95LatencyMs}ms · uptime {(r.uptimeBps / 100).toFixed(2)}%</span>
              <button className="btn ghost sm" type="button" disabled={busy || !!overlay} onClick={() => void actions.openDispute(r.id, `p95 ${r.p95LatencyMs}ms vs ${SLA_MAX_P95_LATENCY_MS}ms SLA; uptime ${(r.uptimeBps / 100).toFixed(2)}%`)}>
                Open dispute (burns 100 $WIF)
              </button>
            </div>
          ))}
        </div>
      ) : null}
      {disputes.length === 0 ? <div className="empty">No disputes yet.</div> : disputes.map((d) => <DisputeCard key={d.id} d={d} />)}
    </Panel>
  );
}
