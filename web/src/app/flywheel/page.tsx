"use client";

import { BurnFeed, FlywheelDiagram, VaultComposition } from "@/components/FlywheelPanels";
import { MarginBooster, ProviderBoard } from "@/components/MarginBooster";
import { SlaJuryVotingCard } from "@/components/SlaJuryVotingCard";
import { CorridorElection } from "@/components/CorridorElection";

export default function FlywheelPage() {
  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <div className="kicker">The $WIF flywheel · SLA jury · corridor elections</div>
          <h1>$WIF Flywheel Hub</h1>
          <p className="lede">
            $WIF is the economic heartbeat of every Paron transaction: it cuts provider margin, discounts fees, burns on every fill, and is the only way to vote. Participation has upside: winning jurors
            are paid in real USDG from slashed margin plus bonus $WIF.
          </p>
        </div>
      </div>
      <FlywheelDiagram />
      <div className="grid g-main">
        <MarginBooster />
        <VaultComposition />
      </div>
      <div className="grid g-main" id="jury">
        <SlaJuryVotingCard />
        <div className="stack">
          <CorridorElection />
          <BurnFeed />
        </div>
      </div>
      <ProviderBoard />
    </div>
  );
}
