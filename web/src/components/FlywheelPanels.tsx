"use client";

import { formatUsdg, formatWifAmount, formatWifCompact } from "@paron-wif/core";
import { useProtocol } from "@/lib/protocol";
import { reasonLabel } from "./WifBurnBanner";
import { KV, Panel, Pill, ago, fmtInt, wifToNumber } from "./ui";

/** The 4-engine $WIF flywheel, each loop with its live on-chain metric. */
export function FlywheelDiagram() {
  const { snapshot } = useProtocol();
  const f = snapshot.flywheel;
  const by = new Map(snapshot.burnStats.map((b) => [b.reason, b.amount]));
  const feeBurns = (by.get("TRADE_FEE") ?? 0n) + (by.get("TRADE_FEE_WIF") ?? 0n) + (by.get("CASH_SETTLEMENT") ?? 0n);
  const juryBurns = (by.get("SLA_JURY_VOTE") ?? 0n) + (by.get("SLA_DISPUTE_FILING") ?? 0n) + (by.get("SLA_SLASH_JURY") ?? 0n) + (by.get("SLA_SLASH_MISSED_DEADLINE") ?? 0n);
  const electionBurns = by.get("CORRIDOR_ELECTION") ?? 0n;
  const agents = snapshot.providers.length;
  return (
    <Panel title={<>The Paron <b>$WIF</b> on-chain flywheel</>} right={<Pill tone="burn">{fmtInt(wifToNumber(f.totalWifBurned))} $WIF burned forever</Pill>}>
      <div className="loops">
        <div className="loop">
          <div className="loop-n">LOOP 1 · FEE BUY-AND-BURN</div>
          <h3>Every fill burns $WIF</h3>
          <p>30 bps fee (10 bps in $WIF mode). 50% burns $WIF, 30% funds the SLA jury, 20% streams to $WIF stakers.</p>
          <div className="loop-metric burn">{formatWifCompact(feeBurns)} $WIF</div>
          <div className="help">burned by fees · {formatUsdg(f.totalFeesUsdg)} collected</div>
        </div>
        <div className="loop">
          <div className="loop-n">LOOP 2 · MARGIN BOOST</div>
          <h3>Stake $WIF, free capital</h3>
          <p>Cash margin falls from 50% to 35% (25k $WIF) to 25% (100k $WIF): 4x capital efficiency vs a 150% bond.</p>
          <div className="loop-metric" style={{ color: "var(--stake)" }}>{formatWifCompact(f.totalWifStaked)} $WIF</div>
          <div className="help">staked by {agents} providers + agents</div>
        </div>
        <div className="loop">
          <div className="loop-n">LOOP 3 · BURN-TO-VOTE</div>
          <h3>Jury &amp; corridor elections</h3>
          <p>1 $WIF burned = 1 vote on SLA disputes and on the corridor that wins next epoch&apos;s margin boost. Winners earn USDG + $WIF.</p>
          <div className="loop-metric" style={{ color: "var(--vault)" }}>{formatWifCompact(juryBurns + electionBurns)} $WIF</div>
          <div className="help">{formatWifCompact(juryBurns)} jury · {formatWifCompact(electionBurns)} elections</div>
        </div>
        <div className="loop">
          <div className="loop-n">LOOP 4 · AUTONOMOUS AGENTS</div>
          <h3>Agents run on $WIF</h3>
          <p>AI agents stake $WIF for 10 bps fees and the priority matching lane, buy compute, police SLAs and hedge at the index.</p>
          <div className="loop-metric accent">{formatWifCompact(by.get("TRADE_FEE_WIF") ?? 0n)} $WIF</div>
          <div className="help">burned from traders&apos; and agents&apos; own wallets</div>
        </div>
      </div>
      <svg viewBox="0 0 1000 120" width="100%" height="110" role="img" aria-label="Fee and slash flows into The Paron Vault" style={{ marginTop: 14 }}>
        <defs>
          <marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0 0L10 5L0 10z" fill="#8c9099" />
          </marker>
        </defs>
        <g fontFamily="IBM Plex Mono, monospace" fontSize="12" fill="#a8adb5">
          <rect x="10" y="38" width="190" height="44" rx="5" fill="none" stroke="rgba(255,255,255,0.16)" />
          <text x="105" y="58" textAnchor="middle" fill="#f3f3f3">Traders · Agents</text>
          <text x="105" y="74" textAnchor="middle">fees + slashes</text>
          <line x1="200" y1="60" x2="380" y2="60" stroke="#8c9099" markerEnd="url(#arr)" />
          <rect x="385" y="30" width="230" height="60" rx="6" fill="rgba(176,156,251,0.08)" stroke="#b09cfb" />
          <text x="500" y="56" textAnchor="middle" fill="#f3f3f3">WifFlywheelVault</text>
          <text x="500" y="74" textAnchor="middle" fill="#b09cfb">The Paron Vault</text>
          <line x1="615" y1="45" x2="760" y2="20" stroke="#ff7a3d" markerEnd="url(#arr)" />
          <line x1="615" y1="60" x2="760" y2="60" stroke="#b09cfb" markerEnd="url(#arr)" />
          <line x1="615" y1="75" x2="760" y2="100" stroke="#6aa8f5" markerEnd="url(#arr)" />
          <text x="770" y="24" fill="#ff7a3d">50% → $WIF burned (0x…dEaD / burn)</text>
          <text x="770" y="64" fill="#b09cfb">30% → SLA jury voter pool</text>
          <text x="770" y="104" fill="#6aa8f5">20% → $WIF-staker rebates</text>
        </g>
      </svg>
    </Panel>
  );
}

export function VaultComposition() {
  const { snapshot } = useProtocol();
  const f = snapshot.flywheel;
  return (
    <Panel title="The Paron Vault · balances">
      <KV
        rows={[
          ["Jury reward pool (voter upside)", formatUsdg(f.juryRewardPoolUsdg)],
          ["Juror bonus $WIF pool", `${formatWifAmount(f.juryBonusWifPool, 0)} $WIF`],
          ["Buyback reserve (burn inventory)", `${formatWifAmount(f.buybackReserveWif, 0)} $WIF`],
          ["Buyback USDG queue", formatUsdg(f.buybackUsdgPool)],
          ["Fees collected (all time)", formatUsdg(f.totalFeesUsdg)],
          ["Rebates streamed to stakers", formatUsdg(f.totalRebatesDistributedUsdg)],
          ["$WIF reference price (oracle)", `${formatUsdg(f.wifPriceUsdg, 4)}`],
          ["$WIF circulating supply", `${formatWifCompact(f.wifTotalSupply)}`],
        ]}
      />
      <p className="help" style={{ marginTop: 10 }}>
        USDG-paid burn legs buy $WIF from the buyback reserve at the reference price and burn it in the same transaction. Anyone can also sell $WIF into the fee-funded buyback pool, where it is burned on arrival.
      </p>
    </Panel>
  );
}

export function BurnFeed() {
  const { snapshot, nameOf } = useProtocol();
  const total = snapshot.burnStats.reduce((a, b) => a + b.amount, 0n) || 1n;
  return (
    <Panel title="Live burn feed" right={<Pill tone="burn">{snapshot.flywheel.burnCount} burns</Pill>}>
      <div className="bar" style={{ marginBottom: 6 }}>
        {snapshot.burnStats.map((b, i) => (
          <span key={b.reason} className={["fill-burn", "fill-vault", "fill-accent", "fill-stake", "fill-bid", "fill-dim"][i % 6]} style={{ width: `${Number((b.amount * 1000n) / total) / 10}%` }} title={`${reasonLabel(b.reason)}: ${formatWifAmount(b.amount, 0)} $WIF`} />
        ))}
      </div>
      <div className="legend" style={{ marginBottom: 10 }}>
        {snapshot.burnStats.map((b, i) => (
          <span key={b.reason}>
            <i style={{ background: ["var(--burn)", "var(--vault)", "var(--accent)", "var(--stake)", "var(--bid)", "#3a4250"][i % 6] }} />
            {reasonLabel(b.reason)} {formatWifCompact(b.amount)}
          </span>
        ))}
      </div>
      <div className="feed">
        {snapshot.burns.slice(0, 12).map((b, i) => (
          <div key={`${b.seq}-${b.txHash}`} className={`feed-row ${i === 0 ? "new" : ""}`}>
            <span className="when">{ago(snapshot.now, b.timestamp)}</span>
            <span>
              <span className="burn">🔥 {formatWifAmount(b.wifBurned, 2)} $WIF</span> <span className="dim">· {reasonLabel(b.reason)} · {nameOf(b.actor)}</span>
            </span>
            <span className="num muted">{formatWifCompact(b.totalWifBurned)}</span>
          </div>
        ))}
      </div>
    </Panel>
  );
}
