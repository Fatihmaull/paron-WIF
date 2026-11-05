import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineChain, type Chain } from "viem";

export type Manifest = {
  schema: string;
  chainId: number;
  startBlock: number;
  deployer: string;
  treasury: string;
  wifIsMock: boolean;
  nativeBurn: boolean;
  wifPriceUsdg: number;
  series: { jkt: number; btm: number; sgp: number };
  contracts: {
    WifToken: `0x${string}`;
    Usdg: `0x${string}`;
    ParonSeriesToken: `0x${string}`;
    WifFlywheelVault: `0x${string}`;
    WifSlaJury: `0x${string}`;
    ParonExchangeDesk: `0x${string}`;
  };
};

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export type IndexerConfig = {
  rpcUrl: string | null;
  chainId: number;
  chainName: string;
  port: number;
  confirmations: bigint;
  pollMs: number;
  startBlock: bigint | null;
  dataDir: string;
  manifest: Manifest | null;
};

export function loadManifest(chainId: number, root = repoRoot): Manifest | null {
  const file = join(root, "deployments", `${chainId}.json`);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8")) as Manifest;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): IndexerConfig {
  const chainId = Number(env.NEXT_PUBLIC_CHAIN_ID || env.CHAIN_ID || 46_630);
  const rpcUrl = env.RPC_URL || env.NEXT_PUBLIC_RPC_URL || null;
  return {
    rpcUrl,
    chainId,
    chainName: env.NEXT_PUBLIC_CHAIN_NAME || "Flat World EVM / Target Chain",
    port: Number(env.INDEXER_PORT || 8_787),
    confirmations: BigInt(env.INDEXER_CONFIRMATIONS || 1),
    pollMs: Number(env.INDEXER_POLL_MS || 4_000),
    startBlock: env.INDEXER_START_BLOCK ? BigInt(env.INDEXER_START_BLOCK) : null,
    dataDir: join(repoRoot, "indexer", ".data"),
    manifest: loadManifest(chainId),
  };
}

export function chainFor(cfg: Pick<IndexerConfig, "chainId" | "chainName" | "rpcUrl">): Chain {
  return defineChain({
    id: cfg.chainId,
    name: cfg.chainName,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: cfg.rpcUrl ? [cfg.rpcUrl] : [] } },
  });
}
