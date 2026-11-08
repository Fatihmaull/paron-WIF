/**
 * Live-chain end-to-end check (run by scripts/e2e-local.sh against anvil):
 *  1. index the freshly deployed + seeded contracts and cross-check the read model with contract views;
 *  2. run the autonomous CFO agent live (it fauceted itself, approves, stakes and buys in $WIF mode);
 *  3. re-index and verify the agent's $WIF fee burn landed on-chain.
 */
import assert from "node:assert/strict";
import { createPublicClient, createWalletClient, http, type Abi, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CfoComputeAgent, DEFAULT_AGENT_POLICY, paronExchangeDeskAbi, usdgAbi, wifFlywheelVaultAbi, wifTokenAbi, type Hex } from "@paron-wif/core";
import { chainFor, loadConfig } from "../src/config.ts";
import { ChainIndexer } from "../src/indexer.ts";
import { bookLevels } from "../src/reducer.ts";
import { ChainAgentBackend, printReport } from "../src/agent-runner.ts";

const cfg = loadConfig();
assert.ok(cfg.rpcUrl && cfg.manifest, "RPC_URL and deployments/<chainId>.json are required");
const manifest = cfg.manifest!;
const chain = chainFor(cfg);
const pub = createPublicClient({ chain, transport: http(cfg.rpcUrl!) }) as PublicClient;
const c = manifest.contracts;

const indexer = new ChainIndexer({ ...cfg, dataDir: `${cfg.dataDir}/e2e-${Date.now()}` }, manifest, pub);
const added = await indexer.syncOnce();
console.log(`[e2e] indexed ${added} events up to block ${indexer.cursor}`);
assert.equal(indexer.view.series.size, 3);
for (const id of [1, 2, 3]) {
  for (const isBid of [true, false]) {
    const [prices, qtys] = (await pub.readContract({ address: c.ParonExchangeDesk, abi: paronExchangeDeskAbi as Abi, functionName: "getBookSide", args: [BigInt(id), isBid, 24n] })) as [bigint[], bigint[]];
    const view = bookLevels(indexer.view, id, isBid, 24);
    assert.deepEqual(view.map((l) => [l.price, l.qty]), prices.map((p, i) => [p, qtys[i]]), `series ${id} ${isBid ? "bids" : "asks"} match the chain`);
  }
}
const stats = (await pub.readContract({ address: c.WifFlywheelVault, abi: wifFlywheelVaultAbi as Abi, functionName: "getFlywheelStats" })) as { totalWifBurned: bigint; totalWifStaked: bigint; juryRewardPoolUsdg: bigint };
assert.equal(indexer.view.flywheel.totalWifStaked, stats.totalWifStaked);
assert.equal(indexer.view.flywheel.totalWifBurned, stats.totalWifBurned);
assert.equal(indexer.view.flywheel.juryRewardPoolUsdg, stats.juryRewardPoolUsdg);
console.log("[e2e] indexer read model == on-chain views (book, staked, burned, jury pool)");

const key = process.env.AGENT_PRIVATE_KEY as Hex;
assert.ok(key, "AGENT_PRIVATE_KEY required");
const account = privateKeyToAccount(key);
const wallet = createWalletClient({ chain, transport: http(cfg.rpcUrl!), account });
for (const [token, abi] of [[c.WifToken, wifTokenAbi], [c.Usdg, usdgAbi]] as const) {
  const { request } = await pub.simulateContract({ address: token, abi: abi as Abi, functionName: "faucet", account });
  await pub.waitForTransactionReceipt({ hash: await wallet.writeContract(request) });
}
const backend = new ChainAgentBackend(pub, wallet, c);
await backend.ensureApprovals();
const agent = new CfoComputeAgent(backend, { ...DEFAULT_AGENT_POLICY, maxOrderCu: 40n, maxPremiumToIndexBps: 500n });
for (let i = 0; i < 2; i += 1) printReport(await agent.tick());
const burnedBefore = indexer.view.flywheel.totalWifBurned;
await indexer.syncOnce();
const agentBurn = indexer.view.burns.find((b) => b.actor === account.address.toLowerCase() && b.reason === "TRADE_FEE_WIF");
assert.ok(agentBurn, "the live agent's $WIF-mode fee burned its own $WIF on-chain");
assert.ok(indexer.view.flywheel.totalWifBurned > burnedBefore);
console.log(`[e2e] live agent burned ${agentBurn.wifBurned} wei of $WIF via TRADE_FEE_WIF; total burned ${indexer.view.flywheel.totalWifBurned}`);
console.log("[e2e] OK");
