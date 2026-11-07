import type { Address } from "@paron-wif/core";

const env = {
  chainId: process.env.NEXT_PUBLIC_CHAIN_ID,
  chainName: process.env.NEXT_PUBLIC_CHAIN_NAME,
  rpcUrl: process.env.NEXT_PUBLIC_RPC_URL,
  explorerUrl: process.env.NEXT_PUBLIC_EXPLORER_URL,
  indexerUrl: process.env.NEXT_PUBLIC_INDEXER_URL,
  wif: process.env.NEXT_PUBLIC_ADDR_WIF,
  usdg: process.env.NEXT_PUBLIC_ADDR_USDG,
  series: process.env.NEXT_PUBLIC_ADDR_SERIES,
  vault: process.env.NEXT_PUBLIC_ADDR_VAULT,
  desk: process.env.NEXT_PUBLIC_ADDR_DESK,
  jury: process.env.NEXT_PUBLIC_ADDR_JURY,
};

const isAddress = (v: string | undefined): v is Address => !!v && /^0x[0-9a-fA-F]{40}$/.test(v);

export type LiveAddresses = { wif: Address; usdg: Address; series: Address; vault: Address; desk: Address; jury: Address };

export const appConfig = {
  chainId: Number(env.chainId || 46_630),
  chainName: env.chainName || "Flat World EVM / Target Chain",
  rpcUrl: env.rpcUrl || null,
  explorerUrl: env.explorerUrl || null,
  indexerUrl: env.indexerUrl || null,
  repoUrl: "https://github.com/Fatihmaull/paron-WIF",
  addresses: (isAddress(env.wif) && isAddress(env.usdg) && isAddress(env.series) && isAddress(env.vault) && isAddress(env.desk) && isAddress(env.jury)
    ? { wif: env.wif, usdg: env.usdg, series: env.series, vault: env.vault, desk: env.desk, jury: env.jury }
    : null) as LiveAddresses | null,
};

export const liveConfigured = appConfig.addresses !== null;

export function explorerTx(hash: string): string | null {
  return appConfig.explorerUrl ? `${appConfig.explorerUrl.replace(/\/$/, "")}/tx/${hash}` : null;
}
