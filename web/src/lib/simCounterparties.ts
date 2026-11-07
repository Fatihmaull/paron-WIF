/**
 * Simulated counterparties for the sandbox: providers that acknowledge and deliver redemptions
 * (honestly or degraded), and community jurors that burn-vote on open disputes according to the
 * on-chain evidence, then resolve finished rounds. Everything goes through the contract-exact ledger.
 */
import { SLA_MAX_P95_LATENCY_MS, WIF, deliverSigned, type World } from "@paron-wif/core";

export type CounterpartyMode = "honest" | "degraded";

export function runCounterparties(world: World, mode: CounterpartyMode): string[] {
  const l = world.ledger;
  const notes: string[] = [];
  const providers = Object.values(world.actors).filter((a) => a.role === "provider");
  for (const r of l.listRedemptions()) {
    const p = providers.find((x) => x.address === r.provider);
    if (!p) continue;
    try {
      if (r.state === "Requested" && l.now <= r.ackDeadline) {
        l.acknowledgeRedemption(p.address, r.id);
        notes.push(`${p.name} acknowledged redemption #${r.id}`);
      } else if (r.state === "Acknowledged" && l.now <= r.deliveryDeadline) {
        const degraded = mode === "degraded";
        const p95 = degraded ? 560 + (r.id % 7) * 23 : 118 + (r.id % 5) * 9;
        const uptime = degraded ? 9_710 : 9_991;
        deliverSigned(l, p, r.id, `${p.key}: redemption ${r.id} ${degraded ? "degraded fabric" : "nominal"}`, p95, uptime);
        notes.push(`${p.name} posted a signed receipt for #${r.id}: p95 ${p95}ms`);
      }
    } catch {
      // A counterparty that cannot act simply does nothing this tick.
    }
  }
  const jurors = Object.values(world.actors).filter((a) => a.role === "juror" && a.key !== "flat-world-community");
  for (const d of l.listDisputes()) {
    if (d.status !== "Open") continue;
    const r = l.getRedemption(d.redemptionId);
    if (l.now < d.votingEndsAt) {
      const slash = !!r && r.p95LatencyMs > SLA_MAX_P95_LATENCY_MS;
      jurors.forEach((j, i) => {
        const w = l.voteWeight(d.id, j.address);
        if (w.slash > 0n || w.uphold > 0n) return;
        try {
          l.voteOnDisputeWithWifBurn(j.address, d.id, slash, BigInt(800 + i * 350) * WIF);
          notes.push(`${j.name} burned ${800 + i * 350} $WIF for ${slash ? "SLASH" : "UPHOLD"} on dispute #${d.id}`);
        } catch {
          // Out of $WIF: abstain.
        }
      });
    } else {
      try {
        const res = l.resolveDispute(jurors[0]?.address ?? l.addr.deployer, d.id);
        notes.push(`Dispute #${d.id} resolved: ${res.slashed ? "provider slashed" : "delivery upheld"}`);
      } catch {
        // Already resolved in the same tick.
      }
    }
  }
  return notes;
}
