import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createGenesisWorld, runFullTour } from "@paron-wif/core";
import { createApiHandler } from "../src/api.ts";
import { applyEvent, bookLevels, createView, fromLedgerEvents, openInterest } from "../src/reducer.ts";
import { backoffMs, getLogsAdaptive, isRangeError, isTransient, withRetry } from "../src/rpc.ts";
import { simulationSource } from "../src/server.ts";
import { ChainIndexer } from "../src/indexer.ts";
import { loadConfig, type Manifest } from "../src/config.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PublicClient } from "viem";

test("reducer rebuilds the exact flywheel state from events alone (cross-validated against the ledger)", () => {
  for (const ledger of [createGenesisWorld().ledger, runFullTour().world.ledger]) {
    const view = createView();
    for (const e of fromLedgerEvents(ledger.events())) applyEvent(view, e);
    const f = ledger.flywheelStats();
    assert.equal(view.flywheel.totalWifBurned, f.totalWifBurned);
    assert.equal(view.flywheel.totalWifStaked, f.totalWifStaked);
    assert.equal(view.flywheel.totalFeesUsdg, f.totalFeesUsdg);
    assert.equal(view.flywheel.juryRewardPoolUsdg, f.juryRewardPoolUsdg);
    assert.equal(view.flywheel.buybackReserveWif, f.buybackReserveWif);
    assert.equal(view.flywheel.juryBonusWifPool, f.juryBonusWifPool);
    for (const s of ledger.listSeries()) {
      assert.equal(openInterest(view, s.id), ledger.getSeriesMarket(s.id).openInterestCu, `${s.symbol} open interest`);
      for (const isBid of [true, false]) {
        const fromView = bookLevels(view, s.id, isBid, 24).map((l) => [l.price, l.qty]);
        const fromLedger = ledger.getBookSide(s.id, isBid, 24).map((l) => [l.price, l.qty]);
        assert.deepEqual(fromView, fromLedger, `${s.symbol} ${isBid ? "bids" : "asks"}`);
      }
    }
    // Idempotent: replaying the same log changes nothing.
    const burned = view.flywheel.totalWifBurned;
    for (const e of fromLedgerEvents(ledger.events())) assert.equal(applyEvent(view, e), false);
    assert.equal(view.flywheel.totalWifBurned, burned);
  }
});

test("rpc helpers retry transient failures and split oversized getLogs ranges", async () => {
  assert.ok(isTransient(new Error("HTTP 429 Too Many Requests")));
  assert.ok(!isTransient(new Error("execution reverted")));
  assert.ok(isRangeError({ message: "query returned more than 10000 results" }));
  assert.equal(backoffMs(0, 250, 8_000, () => 0.5), 125);
  assert.equal(backoffMs(10, 250, 8_000, () => 0.999), 7_992);

  let calls = 0;
  const value = await withRetry(async () => {
    calls += 1;
    if (calls < 3) throw new Error("ECONNRESET");
    return "ok";
  }, { sleep: async () => {} });
  assert.equal(value, "ok");
  assert.equal(calls, 3);
  await assert.rejects(withRetry(async () => { throw new Error("execution reverted"); }, { sleep: async () => {} }), /reverted/);

  const ranges: [bigint, bigint][] = [];
  const logs = await getLogsAdaptive(0n, 99n, async (from, to) => {
    if (to - from + 1n > 25n) throw new Error("block range too large");
    ranges.push([from, to]);
    return [Number(from)];
  }, 100n, { sleep: async () => {} });
  assert.deepEqual(logs, [0, 25, 50, 75]);
  assert.ok(ranges.every(([a, b]) => b - a + 1n <= 25n));
});

test("REST API serves the flywheel read model (simulation fallback, zero config)", async () => {
  const source = simulationSource();
  await source.step();
  const server = createServer(createApiHandler(source)).listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const health = await (await fetch(`${base}/health`)).json();
    assert.equal(health.ok, true);
    assert.equal(health.mode, "simulation");

    const flywheel = await (await fetch(`${base}/v1/flywheel`)).json();
    assert.ok(BigInt(flywheel.totalWifBurned) > 1_400_000n * 10n ** 18n);
    assert.equal(flywheel.totalWifStaked, (4_850_000n * 10n ** 18n).toString(), "4.85M $WIF staked in margin vaults");
    assert.ok(flywheel.recentBurns.length > 0);

    const series = await (await fetch(`${base}/v1/series`)).json();
    assert.deepEqual(series.map((s: { symbol: string }) => s.symbol), ["CU-JKT-H100-2611", "CU-BTM-H200-2611", "CU-SGP-B200-2612"]);
    assert.ok(series.every((s: { bestBid: string; bestAsk: string }) => BigInt(s.bestBid) < BigInt(s.bestAsk)));

    const book = await (await fetch(`${base}/v1/series/2/book?depth=5`)).json();
    assert.ok(book.bids.length > 0 && book.asks.length > 0);
    const dispute = await (await fetch(`${base}/v1/disputes/1`)).json();
    assert.equal(dispute.status, "ResolvedSlash");
    assert.ok(dispute.voters.length >= 4);
    const corridors = await (await fetch(`${base}/v1/corridors`)).json();
    assert.equal(corridors.epochs[0].elected.corridorId, 1);
    const providers = await (await fetch(`${base}/v1/providers`)).json();
    assert.ok(providers.some((p: { tier: number }) => p.tier === 2));
    assert.equal((await fetch(`${base}/v1/series/99/book`)).status, 404);
    assert.equal((await fetch(`${base}/nope`)).status, 404);
  } finally {
    server.close();
  }
});

test("indexer always reads a fresh chain head (no cached block number)", async () => {
  const calls: unknown[] = [];
  const fake = {
    getBlockNumber: async (args?: unknown) => {
      calls.push(args);
      return 0n;
    },
  } as unknown as PublicClient;
  const manifest = {
    chainId: 31337,
    startBlock: 0,
    contracts: {
      WifToken: "0x0000000000000000000000000000000000000001",
      Usdg: "0x0000000000000000000000000000000000000002",
      ParonSeriesToken: "0x0000000000000000000000000000000000000003",
      WifFlywheelVault: "0x0000000000000000000000000000000000000004",
      WifSlaJury: "0x0000000000000000000000000000000000000005",
      ParonExchangeDesk: "0x0000000000000000000000000000000000000006",
    },
  } as unknown as Manifest;
  const cfg = { ...loadConfig({}), dataDir: mkdtempSync(join(tmpdir(), "paron-wif-idx-")) };
  const indexer = new ChainIndexer(cfg, manifest, fake);
  assert.equal(await indexer.syncOnce(), 0);
  assert.deepEqual(calls, [{ cacheTime: 0 }]);
});
