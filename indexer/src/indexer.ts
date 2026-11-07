/**
 * ChainIndexer: polls eth_getLogs for every Paron WIF contract, decodes logs with the generated ABIs,
 * applies them to the read model in strict (block, logIndex) order and persists a replayable log.
 */
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, decodeEventLog, http, type Abi, type Log, type PublicClient } from "viem";
import {
  bigintReplacer,
  paronExchangeDeskAbi,
  paronSeriesTokenAbi,
  usdgAbi,
  wifFlywheelVaultAbi,
  wifSlaJuryAbi,
  wifTokenAbi,
} from "@paron-wif/core";
import { chainFor, type IndexerConfig, type Manifest } from "./config.ts";
import { applyEvent, createView, type IndexedEvent, type View } from "./reducer.ts";
import { errorText, getLogsAdaptive, withRetry } from "./rpc.ts";

const IGNORED = new Set(["Transfer", "Approval", "TransferSingle", "TransferBatch", "ApprovalForAll", "URI", "OwnershipTransferred"]);

export function contractAbis(manifest: Manifest): Map<string, { name: string; abi: Abi }> {
  const c = manifest.contracts;
  return new Map<string, { name: string; abi: Abi }>([
    [c.WifToken.toLowerCase(), { name: "WifToken", abi: wifTokenAbi as Abi }],
    [c.Usdg.toLowerCase(), { name: "Usdg", abi: usdgAbi as Abi }],
    [c.ParonSeriesToken.toLowerCase(), { name: "ParonSeriesToken", abi: paronSeriesTokenAbi as Abi }],
    [c.WifFlywheelVault.toLowerCase(), { name: "WifFlywheelVault", abi: wifFlywheelVaultAbi as Abi }],
    [c.WifSlaJury.toLowerCase(), { name: "WifSlaJury", abi: wifSlaJuryAbi as Abi }],
    [c.ParonExchangeDesk.toLowerCase(), { name: "ParonExchangeDesk", abi: paronExchangeDeskAbi as Abi }],
  ]);
}

export function decodeLogs(logs: Log[], abis: Map<string, { name: string; abi: Abi }>, timestamps: Map<bigint, number>): IndexedEvent[] {
  const out: IndexedEvent[] = [];
  for (const log of logs) {
    const entry = abis.get(log.address.toLowerCase());
    if (!entry || log.blockNumber === null || log.logIndex === null || !log.transactionHash) continue;
    try {
      const decoded = decodeEventLog({ abi: entry.abi, data: log.data, topics: log.topics }) as unknown as {
        eventName?: string;
        args?: Record<string, unknown>;
      };
      const eventName = decoded.eventName;
      if (!eventName || IGNORED.has(eventName)) continue;
      const args = { ...(decoded.args ?? {}) };
      for (const [k, v] of Object.entries(args)) if (typeof v === "string" && v.startsWith("0x") && v.length === 42) args[k] = v.toLowerCase();
      out.push({
        key: `${log.transactionHash}:${log.logIndex}`,
        blockNumber: Number(log.blockNumber),
        logIndex: log.logIndex,
        timestamp: timestamps.get(log.blockNumber) ?? 0,
        txHash: log.transactionHash,
        contract: entry.name,
        eventName,
        args,
      });
    } catch {
      // Logs from events outside the generated ABIs are not part of the read model.
    }
  }
  return out.sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
}

type Persisted = { cursor: string; events: IndexedEvent[] };

export class ChainIndexer {
  readonly cfg: IndexerConfig;
  readonly manifest: Manifest;
  readonly client: PublicClient;
  view: View = createView();
  events: IndexedEvent[] = [];
  cursor: bigint;
  head: bigint = 0n;
  lastError: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly abis: Map<string, { name: string; abi: Abi }>;

  constructor(cfg: IndexerConfig, manifest: Manifest, client?: PublicClient) {
    this.cfg = cfg;
    this.manifest = manifest;
    this.client = client ?? (createPublicClient({ chain: chainFor(cfg), transport: http(cfg.rpcUrl ?? undefined, { retryCount: 0 }) }) as PublicClient);
    this.abis = contractAbis(manifest);
    this.cursor = (cfg.startBlock ?? BigInt(manifest.startBlock ?? 0)) - 1n;
    this.restore();
  }

  private get file(): string {
    return join(this.cfg.dataDir, `state-${this.manifest.chainId}-${this.manifest.contracts.ParonExchangeDesk.toLowerCase()}.json`);
  }

  private restore(): void {
    if (!existsSync(this.file)) return;
    const saved = JSON.parse(readFileSync(this.file, "utf8")) as Persisted;
    this.cursor = BigInt(saved.cursor);
    for (const e of saved.events) this.ingest(e);
  }

  private persist(): void {
    mkdirSync(this.cfg.dataDir, { recursive: true });
    const body: Persisted = { cursor: this.cursor.toString(), events: this.events };
    writeFileSync(this.file, JSON.stringify(body, bigintReplacer));
  }

  private ingest(e: IndexedEvent): void {
    if (applyEvent(this.view, e)) this.events.push(e);
  }

  /** One sync pass up to head - confirmations. Returns the number of new events. */
  async syncOnce(): Promise<number> {
    // cacheTime 0: viem otherwise reuses a block number for 4 s and a sync right after new blocks misses them.
    const latest = await withRetry(() => this.client.getBlockNumber({ cacheTime: 0 }));
    this.head = latest;
    const target = latest - this.cfg.confirmations;
    if (target <= this.cursor) return 0;
    const from = this.cursor + 1n;
    const addresses = [...this.abis.keys()] as `0x${string}`[];
    const logs = await getLogsAdaptive(from, target, (a, b) => this.client.getLogs({ address: addresses, fromBlock: a, toBlock: b }) as Promise<Log[]>);
    const blocks = [...new Set(logs.map((l) => l.blockNumber).filter((b): b is bigint => b !== null))];
    const timestamps = new Map<bigint, number>();
    for (const bn of blocks) {
      const block = await withRetry(() => this.client.getBlock({ blockNumber: bn }));
      timestamps.set(bn, Number(block.timestamp));
    }
    const decoded = decodeLogs(logs, this.abis, timestamps);
    let added = 0;
    for (const e of decoded) {
      const before = this.events.length;
      this.ingest(e);
      if (this.events.length > before) added += 1;
    }
    this.cursor = target;
    this.persist();
    return added;
  }

  start(onSync?: (added: number) => void): void {
    const loop = async () => {
      try {
        const added = await this.syncOnce();
        this.lastError = null;
        onSync?.(added);
      } catch (error) {
        this.lastError = errorText(error).slice(0, 300);
      } finally {
        this.timer = setTimeout(loop, this.cfg.pollMs);
      }
    };
    void loop();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
