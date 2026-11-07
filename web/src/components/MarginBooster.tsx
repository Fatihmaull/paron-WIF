"use client";

import { useState } from "react";
import { MARGIN_TIER0_BPS, MARGIN_TIER1_BPS, MARGIN_TIER2_BPS, TIER1_STAKE, TIER2_STAKE, WIF, formatUsdg, formatWifAmount } from "@paron-wif/core";
import { useProtocol } from "@/lib/protocol";
import { NumField, Panel, Pill, fmtInt, parseDecimal } from "./ui";

const LADDER = [
  { tier: 0, name: "Tier 0", need: 0n, bps: MARGIN_TIER0_BPS, eff: "2.0x", perks: "Permissionless listing" },
  { tier: 1, name: "Tier 1", need: TIER1_STAKE, bps: MARGIN_TIER1_BPS, eff: "2.85x", perks: "35% margin · $WIF priority lane" },
  { tier: 2, name: "Tier 2 · Flat-World Prime", need: TIER2_STAKE, bps: MARGIN_TIER2_BPS, eff: "4.0x", perks: "25% margin · Prime badge · fee rebates" },
] as const;

/** Panel 1: $WIF Margin Booster & Vault staking. */
export function MarginBooster() {
  const { snapshot, actions, busy, overlay } = useProtocol();
  const acct = snapshot.account;
  const [stake, setStake] = useState("100000");
  const [unstake, setUnstake] = useState("");
  const staked = acct?.stakedWif ?? 0n;
  const next = LADDER.find((t) => t.need > staked);
  const pct = next ? Number((staked * 1000n) / next.need) / 10 : 100;
  const stakeAmt = parseDecimal(stake, 18) ?? 0n;
  const unstakeAmt = parseDecimal(unstake, 18) ?? 0n;
  const free = staked - (acct?.stakeLock ?? 0n);
  return (
    <Panel title={<>Panel 1 · <b>$WIF margin booster &amp; vault staking</b></>} right={<Pill tone={acct?.tier === 2 ? "ok" : "accent"}>you: Tier {acct?.tier ?? 0}</Pill>}>
      <div className="grid g-3" style={{ gap: 10, marginBottom: 14 }}>
        {LADDER.map((t) => (
          <div key={t.tier} className="tier" data-active={acct?.tier === t.tier} style={{ cursor: "default" }}>
            <div className="tier-name">{t.name}</div>
            <div className="tier-margin">{Number(t.bps) / 100}% margin</div>
            <div className="tier-sub">{t.need === 0n ? "no stake" : `≥ ${fmtInt(Number(t.need / WIF))} $WIF staked`}</div>
            <div className="tier-sub">{t.eff} capital efficiency · {t.perks}</div>
          </div>
        ))}
      </div>
      <div className="field" style={{ marginBottom: 12 }}>
        <div className="between">
          <span className="label">Your stake {next ? `→ ${next.name}` : "· top tier reached"}</span>
          <span className="num">{formatWifAmount(staked, 0)} {next ? `/ ${fmtInt(Number(next.need / WIF))}` : ""} $WIF</span>
        </div>
        <div className="bar"><span className="fill-stake" style={{ width: `${pct}%` }} /></div>
      </div>
      <div className="grid g-2" style={{ gap: 12 }}>
        <div>
          <NumField id="stake-amt" label="Stake $WIF" value={stake} onChange={setStake} suffix="$WIF" help={`Wallet: ${formatWifAmount(acct?.wif ?? 0n, 0)} $WIF`} />
          <button className="btn block" style={{ marginTop: 8 }} type="button" disabled={busy || !!overlay || stakeAmt === 0n || stakeAmt > (acct?.wif ?? 0n)} onClick={() => void actions.stake(stakeAmt)}>
            Stake for margin boost
          </button>
        </div>
        <div>
          <NumField id="unstake-amt" label="Unstake $WIF" value={unstake} onChange={setUnstake} suffix="$WIF" help={acct?.stakeLock ? `${formatWifAmount(acct.stakeLock, 0)} locked while your tier lots are open` : "Unlocked"} />
          <button className="btn ghost block" style={{ marginTop: 8 }} type="button" disabled={busy || !!overlay || unstakeAmt === 0n || unstakeAmt > free} onClick={() => void actions.unstake(unstakeAmt)}>
            Unstake
          </button>
        </div>
      </div>
      <div className="between" style={{ marginTop: 14, padding: "10px 12px", border: "1px solid var(--line)", borderRadius: 4 }}>
        <span>
          <span className="dim">Your 20% fee-rebate stream: </span>
          <span className="num ok">{formatUsdg(acct?.earnedRebateUsdg ?? 0n, 4)}</span>
        </span>
        <button className="btn ghost sm" type="button" disabled={busy || !!overlay || !acct?.earnedRebateUsdg} onClick={() => void actions.claimRebate()}>
          Claim rebate
        </button>
      </div>
      <p className="help">
        The stake lock stops one $WIF stake from qualifying several providers: unstaking below your tier waits until the lots minted at that tier close.
      </p>
    </Panel>
  );
}

export function ProviderBoard() {
  const { snapshot, nameOf } = useProtocol();
  const rows = [...snapshot.providers].sort((a, b) => (b.stakedWif > a.stakedWif ? 1 : -1));
  return (
    <Panel title="Providers · $WIF tier & delivery record" right={<Pill tone="ok">no KYB · no verifier</Pill>}>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Provider</th>
              <th className="num">Staked</th>
              <th>Tier</th>
              <th className="num">Margin</th>
              <th className="num">Delivered</th>
              <th className="num">Slashed</th>
              <th className="num">Reliability</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.address}>
                <td>{nameOf(p.address)}</td>
                <td className="num">{formatWifAmount(p.stakedWif, 0)}</td>
                <td>{p.tier === 2 ? <Pill tone="ok">Prime</Pill> : p.tier === 1 ? <Pill tone="info">Tier 1</Pill> : <Pill tone="outline">Tier 0</Pill>}</td>
                <td className="num">{Number(p.marginBps) / 100}%</td>
                <td className="num">{fmtInt(Number(p.deliveredCu))} CU</td>
                <td className="num bad">{fmtInt(Number(p.slashedCu))} CU</td>
                <td className="num">{(p.reliabilityBps / 100).toFixed(1)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}
