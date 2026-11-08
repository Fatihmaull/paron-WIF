"use client";

import { CodedTourController } from "@/components/CodedTourController";

export default function TourPage() {
  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <div className="kicker">Zero wallet needed · deterministic · contract-exact</div>
          <h1>60-Second $WIF Flywheel Judge Tour</h1>
          <p className="lede">
            One click plays the whole protocol: a Prime provider stakes 100k $WIF for 25% margin, an AI agent buys compute and burns its fee in $WIF, a secondary fill normalizes A100 hours, a
            signed delivery settles, an SLA breach is slashed by a burn-to-vote jury whose winners get paid, and the community burns $WIF to elect the next corridor. The telemetry bar above follows
            the tour live.
          </p>
        </div>
      </div>
      <CodedTourController />
    </div>
  );
}
