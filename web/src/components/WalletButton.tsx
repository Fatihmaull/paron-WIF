"use client";

import { useState } from "react";
import { shortAddress } from "@paron-wif/core";
import { appConfig, liveConfigured } from "@/lib/config";
import { useProtocol } from "@/lib/protocol";

/** EIP-6963 wallet discovery and connection (MetaMask first, then any announced wallet). */
export function WalletButton() {
  const { wallets, wallet, connect, disconnect, connecting, walletError, wrongNetwork, switchChain, mode, preferLive, setPreferLive, liveAvailable } = useProtocol();
  const [open, setOpen] = useState(false);

  if (!wallet) {
    return (
      <div className="menu">
        <button className="btn ghost" type="button" onClick={() => setOpen((v) => !v)} disabled={connecting} aria-expanded={open}>
          {connecting ? "Waiting for wallet…" : "Connect wallet"}
        </button>
        {open ? (
          <div className="menu-pop" role="menu">
            <div className="overline" style={{ padding: "4px 10px 8px" }}>Wallets detected (EIP-6963)</div>
            {wallets.length === 0 ? (
              <div className="help" style={{ padding: "0 10px 8px" }}>
                No browser wallet found. The full protocol still runs in the deterministic simulation; install a wallet to trade on-chain.
              </div>
            ) : (
              wallets.map((w) => (
                <button
                  key={w.info.uuid}
                  className="item"
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    void connect(w);
                  }}
                >
                  {w.info.icon ? <img src={w.info.icon} alt="" /> : <span style={{ width: 22 }}>◆</span>}
                  <span>{w.info.name}</span>
                </button>
              ))
            )}
            {!liveConfigured ? (
              <div className="help" style={{ padding: "8px 10px 4px", borderTop: "1px solid var(--line)" }}>
                No contract deployment configured for chain {appConfig.chainId}; connecting shows your address while trading stays simulated.
              </div>
            ) : null}
          </div>
        ) : null}
        {walletError ? <span className="help bad" style={{ position: "absolute", right: 0, top: "110%", whiteSpace: "nowrap" }}>{walletError}</span> : null}
      </div>
    );
  }

  return (
    <div className="menu">
      <button className="btn ghost" type="button" onClick={() => setOpen((v) => !v)} title={wallet.address}>
        <span className="num">{shortAddress(wallet.address)}</span>
        {wrongNetwork ? <span className="pill bad">wrong network</span> : <span className={`pill ${mode === "live" ? "ok" : "accent"}`}>{mode}</span>}
      </button>
      {open ? (
        <div className="menu-pop" role="menu">
          <div className="help" style={{ padding: "4px 10px 8px" }}>
            {wallet.wallet.info.name} · chain {wallet.chainId}
          </div>
          {wrongNetwork ? (
            <button className="item" type="button" onClick={() => void switchChain()}>
              Switch to {appConfig.chainName} ({appConfig.chainId})
            </button>
          ) : null}
          {liveAvailable ? (
            <button className="item" type="button" onClick={() => setPreferLive(!preferLive)}>
              {preferLive ? "Use deterministic simulation" : "Use live chain"}
            </button>
          ) : null}
          <button
            className="item"
            type="button"
            onClick={() => {
              setOpen(false);
              disconnect();
            }}
          >
            Disconnect
          </button>
        </div>
      ) : null}
    </div>
  );
}
