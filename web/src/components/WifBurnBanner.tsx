"use client";

import { formatWifAmount } from "@paron-wif/core";
import { useProtocol } from "@/lib/protocol";
import { Counter, ago, fmtInt, fmtUsd, formatDuration, usdgToNumber, wifToNumber } from "./ui";

const REASON_LABEL: Record<string, string> = {
  TRADE_FEE: "trade fee buyback",
  TRADE_FEE_WIF: "$WIF fee burn",
  CASH_SETTLEMENT: "settlement fee buyback",
  SLA_DISPUTE_FILING: "dispute filing",
  SLA_JURY_VOTE: "jury burn-vote",
  SLA_SLASH_JURY: "slash buyback",
  SLA_SLASH_MISSED_DEADLINE: "default buyback",
  CORRIDOR_ELECTION: "corridor vote",
  BUYBACK_SELL: "buyback sell",
  BUYBACK_FLUSH: "buyback flush",
};

export function reasonLabel(reason: string): string {
  return REASON_LABEL[reason] ?? reason;
}

/** Global $WIF flywheel telemetry: pinned under the header on every page. */
export function WifBurnBanner() {
  const { snapshot, actions, busy, overlay, nameOf } = useProtocol();
  const f = snapshot.flywheel;
  const acct = snapshot.account;
  const now = snapshot.now;
  const cooldown = acct ? Number((acct.faucetWifAt > acct.faucetUsdgAt ? acct.faucetWifAt : acct.faucetUsdgAt) - now) : 0;
  const last = snapshot.burns[0];
  const stakers = snapshot.providers.length;
  return (
    <div className="telemetry" role="region" aria-label="$WIF flywheel telemetry">
      <div className="tele-cell burn">
        <span className="tele-label">🔥 Total $WIF permanently burned</span>
        <Counter className="tele-value" value={wifToNumber(f.totalWifBurned)} format={(n) => `${fmtInt(n)} $WIF`} />
        <span className="tele-sub ticker">
          {last ? `+${formatWifAmount(last.wifBurned, 2)} · ${reasonLabel(last.reason)} · ${nameOf(last.actor)} · ${ago(now, last.timestamp)}` : `${f.burnCount} burns`}
        </span>
      </div>
      <div className="tele-cell stake">
        <span className="tele-label">🔒 $WIF staked in margin vaults</span>
        <Counter className="tele-value" value={wifToNumber(f.totalWifStaked)} format={(n) => `${fmtInt(n)} $WIF`} />
        <span className="tele-sub">{stakers} providers · 100k $WIF staked = 25% margin</span>
      </div>
      <div className="tele-cell vault">
        <span className="tele-label">💎 Paron Vault · voter upside pool</span>
        <Counter className="tele-value" value={usdgToNumber(f.juryRewardPoolUsdg)} format={(n) => `${fmtUsd(n)} USDG`} />
        <span className="tele-sub">+{fmtInt(wifToNumber(f.juryBonusWifPool))} bonus $WIF · {fmtUsd(usdgToNumber(f.totalRebatesDistributedUsdg))} rebates</span>
      </div>
      <div className="tele-cell oi">
        <span className="tele-label">⚡ Compute open interest</span>
        <Counter className="tele-value" value={Number(f.openInterestCu)} format={(n) => `${fmtInt(n)} CU`} />
        <span className="tele-sub">H100-eq hours · CRI-H100 {fmtUsd(usdgToNumber(snapshot.cri.price))}/CU</span>
      </div>
      <div className="tele-faucet">
        <button
          className="btn burn"
          type="button"
          disabled={busy || !!overlay || cooldown > 0}
          onClick={() => void actions.faucet()}
          title="Permissionless testnet faucet: 50,000 $WIF + 10,000 USDG per hour"
        >
          {cooldown > 0 ? `Faucet in ${formatDuration(cooldown)}` : "Testnet Faucet: Mint 50,000 $WIF + 10,000 USDG"}
        </button>
      </div>
    </div>
  );
}
