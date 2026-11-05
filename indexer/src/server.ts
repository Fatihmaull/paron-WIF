/**
 * Indexer entrypoint.
 *  - Live mode: RPC_URL is set and deployments/<chainId>.json exists -> index the chain.
 *  - Simulation mode (default, zero config): serve the same API over the deterministic genesis world,
 *    advancing it with the autonomous agent so the feed keeps moving.
 */
import { createServer } from "node:http";
import { CfoComputeAgent, GENESIS_ACTORS, LedgerAgentBackend, createGenesisWorld } from "@paron-wif/core";
import { createApiHandler, type ApiSource } from "./api.ts";
import { loadConfig } from "./config.ts";
import { ChainIndexer } from "./indexer.ts";
import { applyEvent, createView, fromLedgerEvents } from "./reducer.ts";

export function simulationSource(): ApiSource & { step: () => Promise<void> } {
  const world = createGenesisWorld();
  const view = createView();
  let applied = 0;
  const sync = () => {
    const events = world.ledger.events();
    for (const e of fromLedgerEvents(events.slice(applied))) applyEvent(view, e);
    applied = events.length;
  };
  sync();
  const agent = new CfoComputeAgent(new LedgerAgentBackend(world.ledger, GENESIS_ACTORS.cfoAgent.address));
  return {
    mode: "simulation",
    chainId: world.ledger.params.chainId,
    view: () => view,
    now: () => Number(world.ledger.now),
    health: () => ({ indexedBlock: world.ledger.s.block, headBlock: world.ledger.s.block, lastError: null }),
    step: async () => {
      world.ledger.advance(600);
      await agent.tick();
      sync();
    },
  };
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  let source: ApiSource;
  if (cfg.rpcUrl && cfg.manifest) {
    const indexer = new ChainIndexer(cfg, cfg.manifest);
    indexer.start((added) => {
      if (added > 0) console.log(`[indexer] +${added} events, block ${indexer.cursor}`);
    });
    source = {
      mode: "live",
      chainId: cfg.chainId,
      view: () => indexer.view,
      now: () => indexer.view.lastTimestamp || Math.floor(Date.now() / 1000),
      health: () => ({ indexedBlock: Number(indexer.cursor), headBlock: Number(indexer.head), lastError: indexer.lastError }),
    };
    console.log(`[indexer] live mode on chain ${cfg.chainId} (${cfg.chainName}), desk ${cfg.manifest.contracts.ParonExchangeDesk}`);
  } else {
    const sim = simulationSource();
    setInterval(() => void sim.step(), 5_000);
    source = sim;
    console.log("[indexer] simulation mode: no RPC_URL / deployment manifest, serving the deterministic genesis world");
  }
  createServer(createApiHandler(source)).listen(cfg.port, () => {
    console.log(`[indexer] API on http://localhost:${cfg.port} (try /v1/flywheel)`);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) void main();
