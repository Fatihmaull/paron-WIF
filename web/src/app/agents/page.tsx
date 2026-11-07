"use client";

import { AgentConsole } from "@/components/AgentConsole";

export default function AgentsPage() {
  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <div className="kicker">Agents &amp; AI · Loop 4 of the $WIF flywheel</div>
          <h1>Autonomous $WIF Compute Agents</h1>
          <p className="lede">
            AI agents are the natural buyers of compute. The CFO Compute Agent watches its LLM inference load, keeps $WIF staked for 10 bps fees and the priority lane, buys the cheapest
            H100-equivalent hour on the book, redeems capacity on peaks, independently probes every delivery and files a burn-backed SLA dispute when latency breaks its threshold.
          </p>
        </div>
      </div>
      <AgentConsole />
    </div>
  );
}
