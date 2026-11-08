import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

// Fill empty NEXT_PUBLIC_ADDR_* from deployments/<chainId>.json (written by DeployParonWif.s.sol).
// A value set in the environment always wins. No secrets are read here.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const chainId = process.env.NEXT_PUBLIC_CHAIN_ID || "46630";
const manifestFile = path.join(repoRoot, "deployments", `${chainId}.json`);
if (existsSync(manifestFile)) {
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8")) as { contracts: Record<string, string>; startBlock?: number };
  const map: Record<string, string> = {
    NEXT_PUBLIC_ADDR_WIF: manifest.contracts.WifToken,
    NEXT_PUBLIC_ADDR_USDG: manifest.contracts.Usdg,
    NEXT_PUBLIC_ADDR_SERIES: manifest.contracts.ParonSeriesToken,
    NEXT_PUBLIC_ADDR_VAULT: manifest.contracts.WifFlywheelVault,
    NEXT_PUBLIC_ADDR_DESK: manifest.contracts.ParonExchangeDesk,
    NEXT_PUBLIC_ADDR_JURY: manifest.contracts.WifSlaJury,
  };
  for (const [key, value] of Object.entries(map)) if (!process.env[key] && value) process.env[key] = value;
}

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ["@paron-wif/core"],
};

export default nextConfig;
