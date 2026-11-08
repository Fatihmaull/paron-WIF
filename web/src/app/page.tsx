"use client";

import { useState } from "react";
import Link from "next/link";
import { formatPrice } from "@paron-wif/core";
import { HardwareConverter, SeriesMatrix } from "@/components/SeriesMatrix";
import { OrderBook, PositionsPanel, PrimaryMintDrawer, RecentTrades, TradeTicket } from "@/components/OrderBookDesk";
import { RedemptionLifecycle } from "@/components/RedemptionLifecycle";
import { Pill } from "@/components/ui";
import { useProtocol } from "@/lib/protocol";

export default function ExchangeDeskPage() {
  const { snapshot } = useProtocol();
  const [selected, setSelected] = useState(2);
  const [preset, setPreset] = useState<{ price: bigint; side: "buy" | "sell"; n: number } | null>(null);
  const series = snapshot.series.find((s) => s.id === selected) ?? snapshot.series[0];
  if (!series) return null;
  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <div className="kicker">Hooks &amp; DeFi · Consumer &amp; Payments</div>
          <h1>Compute Exchange Desk</h1>
          <p className="lede">
            Trade standardized GPU compute like a commodity. Providers lock 25–50% $WIF-boosted margin (not a 150% dead-cash bond), every fill feeds the $WIF burn engine, and
            delivery is policed by a burn-to-vote jury instead of a central verifier.
          </p>
        </div>
        <div className="row">
          <Pill tone="accent">CRI-H100 {formatPrice(snapshot.cri.price)} USDG/CU</Pill>
          <Link className="btn ghost" href="/flywheel">How the flywheel works →</Link>
        </div>
      </div>
      <SeriesMatrix selected={series.id} onSelect={setSelected} />
      <div className="grid g-desk">
        <div className="stack">
          <OrderBook series={series} onPick={(price, side) => setPreset({ price, side, n: Date.now() })} />
          <RecentTrades seriesId={series.id} />
        </div>
        <TradeTicket series={series} preset={preset} />
        <PrimaryMintDrawer series={series} />
      </div>
      <div className="grid g-main">
        <RedemptionLifecycle series={series} />
        <HardwareConverter />
      </div>
      <PositionsPanel />
    </div>
  );
}
