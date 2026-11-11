import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_LEVELS, MIN_ORDER_NOTIONAL, USDG, WIF } from "../src/constants.ts";
import { ParonError } from "../src/engine/errors.ts";
import { createProtocolWorld, makeActor } from "../src/seed.ts";

const errorName = (name: string) => (e: unknown) => e instanceof ParonError && e.errorName === name;

function setup() {
  const w = createProtocolWorld();
  const l = w.ledger;
  const actor = (key: string, wif = 0n, usdg = 2_000n * USDG, provider = false) => {
    const a = makeActor(key, key, "provider", key);
    if (wif) l.mintWif(a.address, wif);
    l.mintUsdg(a.address, usdg);
    if (provider) l.registerProviderAndStakeWif(a.address, "ipfs://p", wif);
    return a;
  };
  return { w, l, actor };
}

test("orders below the minimum notional are rejected or never rest", () => {
  const { w, l, actor } = setup();
  const p = actor("dust-provider", 100_000n * WIF, 10_000n * USDG, true);
  assert.throws(() => l.mintPrimarySeries(p.address, w.series.jkt, 2n, 2_000_000n), errorName("OrderTooSmall"));
  l.mintPrimarySeries(p.address, w.series.jkt, 10n, 2_000_000n);
  const buyer = actor("dust-buyer");
  assert.throws(() => l.buySeriesOrPlaceBid(buyer.address, w.series.jkt, 2n, 1_000_000n, false), errorName("OrderTooSmall"));
  const r = l.buySeriesOrPlaceBid(buyer.address, w.series.jkt, 11n, 2_000_000n, false);
  assert.deepEqual([r.filledCu, r.orderId], [10n, 0], "the 1 CU dust remainder does not rest");
  assert.ok(2_000_000n < MIN_ORDER_NOTIONAL);
});

test("a maker holds at most 8 orders per side; a filled order frees its slot", () => {
  const { w, l, actor } = setup();
  const p = actor("cap-provider", 100_000n * WIF, 10_000n * USDG, true);
  for (let i = 0n; i < 8n; i += 1n) l.mintPrimarySeries(p.address, w.series.jkt, 10n, 2_000_000n + i * 10_000n);
  assert.throws(() => l.mintPrimarySeries(p.address, w.series.jkt, 10n, 2_090_000n), errorName("TooManyOrders"));
  const buyer = actor("cap-buyer");
  l.buySeriesOrPlaceBid(buyer.address, w.series.jkt, 10n, 2_000_000n, false);
  l.mintPrimarySeries(p.address, w.series.jkt, 10n, 2_100_000n);
});

test("a three-wallet level-flooding attack cannot lock out a better bid", () => {
  const { w, l, actor } = setup();
  const attackers = [0, 1, 2].map((i) => actor(`attacker-${i}`, 0n, 1_000n * USDG));
  attackers.forEach((a, wi) => {
    for (let i = 0; i < 8; i += 1) l.buySeriesOrPlaceBid(a.address, w.series.jkt, 5n, 1_000_000n + BigInt(wi * 8 + i) * 10_000n, false);
  });
  assert.equal(l.getBookSide(w.series.jkt, true, 30).length, MAX_LEVELS);
  const before = l.usdgBalance(attackers[0].address);
  const honest = actor("honest-bidder", 0n, 1_000n * USDG);
  const { orderId } = l.buySeriesOrPlaceBid(honest.address, w.series.jkt, 10n, 1_300_000n, false);
  assert.ok(orderId > 0);
  const book = l.getBookSide(w.series.jkt, true, 30);
  assert.equal(book.length, MAX_LEVELS);
  assert.equal(book[0].price, 1_300_000n);
  assert.equal(book[23].price, 1_010_000n, "the $1.00 level was evicted");
  assert.equal(l.usdgBalance(attackers[0].address) - before, 5_015_000n, "escrow plus the 30 bps reserve is refunded");
  assert.equal(l.getOrder(1)!.active, false);
  const late = actor("late-bidder", 0n, 1_000n * USDG);
  assert.throws(() => l.buySeriesOrPlaceBid(late.address, w.series.jkt, 10n, 990_000n, false), errorName("TooManyLevels"));
  // Joining an existing level still works on a full side.
  l.buySeriesOrPlaceBid(late.address, w.series.jkt, 10n, 1_120_000n, false);
  assert.equal(l.getBookSide(w.series.jkt, true, 30).length, MAX_LEVELS);
});

test("primary ask levels are never evicted; secondary ask eviction returns the CU", () => {
  const { w, l, actor } = setup();
  const providers = [0, 1, 2].map((i) => actor(`prime-${i}`, 0n, 10_000n * USDG, true));
  providers.forEach((p, wi) => {
    for (let i = 0; i < 8; i += 1) l.mintPrimarySeries(p.address, w.series.jkt, 5n, 3_000_000n + BigInt(wi * 8 + i) * 10_000n);
  });
  const seller = actor("cheap-seller");
  l.buySeriesOrPlaceBid(seller.address, w.series.jkt, 2n, 3_000_000n, false);
  assert.throws(() => l.placeAsk(seller.address, w.series.jkt, 2n, 2_990_000n), errorName("TooManyLevels"));

  const s2 = setup();
  const prov = s2.actor("deep-provider", 100_000n * WIF, 100_000n * USDG, true);
  s2.l.mintPrimarySeries(prov.address, s2.w.series.jkt, 400n, 2_000_000n);
  const makers = [0, 1, 2].map((i) => s2.actor(`ask-maker-${i}`));
  makers.forEach((m, wi) => {
    s2.l.buySeriesOrPlaceBid(m.address, s2.w.series.jkt, 80n, 2_000_000n, false);
    const n = wi === 2 ? 7 : 8;
    for (let i = 0; i < n; i += 1) s2.l.placeAsk(m.address, s2.w.series.jkt, 5n, 3_000_000n + BigInt(wi * 8 + i) * 10_000n);
  });
  const honest = s2.actor("honest-seller");
  s2.l.buySeriesOrPlaceBid(honest.address, s2.w.series.jkt, 10n, 2_000_000n, false);
  const cuBefore = s2.l.cuBalance(makers[2].address, s2.w.series.jkt);
  s2.l.placeAsk(honest.address, s2.w.series.jkt, 10n, 2_500_000n);
  assert.equal(s2.l.getBookSide(s2.w.series.jkt, false, 30).length, MAX_LEVELS);
  assert.equal(s2.l.cuBalance(makers[2].address, s2.w.series.jkt) - cuBefore, 5n);
});
