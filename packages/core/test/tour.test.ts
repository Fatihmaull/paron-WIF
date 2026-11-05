import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { TOUR_STEPS, runFullTour, verifyReceiptChain } from "../src/tour.ts";
import { WIF } from "../src/constants.ts";

const golden = JSON.parse(readFileSync(new URL("../fixtures/tour-golden.json", import.meta.url), "utf8")) as {
  params: Record<string, string>;
  expect: Record<string, string>;
};

test("coded judge tour reproduces every on-chain golden number", () => {
  const ctx = runFullTour();
  assert.equal(ctx.world.ledger.params.wifPriceUsdg.toString(), golden.params.wifPriceUsdg);
  assert.equal(ctx.world.ledger.criIndex().price.toString(), golden.params.criH100Usdg);
  const mismatches: string[] = [];
  for (const [key, expected] of Object.entries(golden.expect)) {
    const actual = ctx.metrics[key];
    if (actual === undefined) mismatches.push(`${key}: missing (expected ${expected})`);
    else if (actual.toString() !== expected) mismatches.push(`${key}: ${actual} != ${expected}`);
  }
  assert.deepEqual(mismatches, [], "TypeScript engine diverged from the Solidity golden fixture");
});

test("tour produces six hash-chained audit receipts that detect tampering", () => {
  const ctx = runFullTour();
  assert.equal(ctx.receipts.length, TOUR_STEPS.length);
  assert.equal(verifyReceiptChain(ctx.receipts), -1);
  const tampered = structuredClone(ctx.receipts);
  tampered[4].metrics.jurorAUsdg = "999999999";
  assert.equal(verifyReceiptChain(tampered), 4);
  // Every step emits real protocol events.
  for (const r of ctx.receipts) assert.ok(r.actions.some((a) => a.events.length > 0), `step ${r.step} emitted events`);
});

test("every $WIF the tour burns is a real supply reduction", () => {
  const ctx = runFullTour();
  const l = ctx.world.ledger;
  assert.equal(l.wifTotalBurned(), l.flywheelStats().totalWifBurned);
  assert.equal(l.flywheelStats().totalWifBurned, BigInt(golden.expect.totalWifBurned));
  assert.ok(l.flywheelStats().totalWifBurned > 18_000n * WIF);
  const reasons = new Set(l.events({ name: "WifFlywheelBurned" }).map((e) => String(e.args.reason)));
  for (const r of ["TRADE_FEE", "TRADE_FEE_WIF", "SLA_DISPUTE_FILING", "SLA_JURY_VOTE", "SLA_SLASH_JURY", "CORRIDOR_ELECTION"]) {
    assert.ok(reasons.has(r), `burn reason ${r} exercised`);
  }
});
