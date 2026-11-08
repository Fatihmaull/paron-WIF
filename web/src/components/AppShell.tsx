"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { appConfig } from "@/lib/config";
import { useProtocol } from "@/lib/protocol";
import { WalletButton } from "./WalletButton";
import { WifBurnBanner } from "./WifBurnBanner";
import { Toasts } from "./ui";

const NAV: [string, string][] = [
  ["/", "Exchange Desk"],
  ["/flywheel", "$WIF Flywheel"],
  ["/agents", "Agents"],
  ["/tour", "Judge Tour"],
];

export function BrandMark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <rect x="0.75" y="0.75" width="22.5" height="22.5" rx="5" fill="#000" stroke="#d9a066" strokeWidth="1.5" />
      <path d="M4 8.5h12.5l3.5 1.6h-3.8l-1.2 2.9h-1.7v2.6h3.2v1.9H7.4V15.6h3.2V13H8.9L7.7 10.1H4z" fill="#f3f3f3" />
      <circle cx="18.2" cy="17.2" r="1.6" fill="#ff7a3d" />
    </svg>
  );
}

function SimClock() {
  const { snapshot, advance, resetSandbox, overlay } = useProtocol();
  const t = new Date(Number(snapshot.now) * 1000);
  return (
    <div className="clockbar">
      <span>Sim clock</span>
      <span className="num" style={{ color: "var(--text)" }}>
        {t.toISOString().replace("T", " ").slice(0, 16)} UTC
      </span>
      {!overlay ? (
        <>
          {([
            ["+15m", 900],
            ["+6h", 21_600],
            ["+7d", 604_800],
          ] as const).map(([label, s]) => (
            <button key={label} className="btn ghost sm" type="button" onClick={() => advance(s)} title="Fast-forward the deterministic chain clock (voting rounds, challenge windows, epochs)">
              {label}
            </button>
          ))}
          <button className="btn ghost sm" type="button" onClick={resetSandbox}>
            Reset
          </button>
        </>
      ) : (
        <span className="pill accent">tour world</span>
      )}
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const path = usePathname();
  const { mode, wrongNetwork, switchChain, liveError, snapshot } = useProtocol();
  return (
    <div className="shell">
      <header className="topbar">
        <Link className="brand" href="/" aria-label="Paron WIF home">
          <BrandMark />
          <span className="brand-word">
            PARON <b>WIF</b>
          </span>
        </Link>
        <nav className="nav" aria-label="Primary">
          {NAV.map(([href, label]) => (
            <Link key={href} href={href} data-active={href === "/" ? path === "/" : path.startsWith(href)}>
              {label}
            </Link>
          ))}
        </nav>
        <div className="topbar-spacer" />
        <div className="topbar-actions">
          <span className="chip mode" title={mode === "live" ? "Reading and writing the deployed contracts" : "Contract-exact deterministic simulation (no wallet needed)"}>
            <span className={`dot ${mode === "live" ? "" : "sim"}`} />
            {mode === "live" ? `Live · ${appConfig.chainName} · ${appConfig.chainId}` : "Simulation · deterministic"}
          </span>
          <Link className="btn" href="/tour" aria-label="Play the 60-second judge tour">
            <span className="wide-only">▶ 60-Second Judge Tour</span>
            <span className="narrow-only">▶ Tour</span>
          </Link>
          <WalletButton />
        </div>
      </header>
      <WifBurnBanner />
      {wrongNetwork ? (
        <div className="banner warn">
          Your wallet is on another network. Paron WIF runs on {appConfig.chainName} ({appConfig.chainId}).
          <button className="btn ghost sm" type="button" onClick={() => void switchChain()}>
            Switch network
          </button>
        </div>
      ) : null}
      {liveError ? <div className="banner warn">Live read failed: {liveError}. Showing the last snapshot.</div> : null}
      {mode === "simulation" ? (
        <div className="banner sim">
          <span>
            Deterministic simulation of the deployed protocol: same maths, same errors, same events as the contracts (golden-parity tested). Block {snapshot.block}.
          </span>
          <span style={{ marginLeft: "auto" }}>
            <SimClock />
          </span>
        </div>
      ) : null}
      <main className="main" id="main">
        {children}
      </main>
      <footer className="footer">
        <span>
          Paron WIF · built for the Flat World ecosystem · <Link href="/tour">Judge Tour</Link> · <a href={appConfig.repoUrl}>GitHub</a> · chain {appConfig.chainId}
        </span>
        <span>Testnet demo. Tokens have no monetary value. Not investment advice.</span>
      </footer>
      <Toasts />
    </div>
  );
}
