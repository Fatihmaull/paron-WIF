import { test } from "node:test";
import assert from "node:assert/strict";
import { CRI_MIN_INTERVAL, USDG, WIF } from "../src/constants.ts";
import { ParonError } from "../src/engine/errors.ts";
import { ParonLedger, labelAddress } from "../src/engine/ledger.ts";
import { createProtocolWorld, makeActor } from "../src/seed.ts";
import type { Address, Hex } from "../src/types.ts";

const SRC = ("0x" + "11".repeat(32)) as Hex;
const errorName = (name: string) => (e: unknown) => e instanceof ParonError && e.errorName === name;
const A = labelAddress("cri:a");
const B = labelAddress("cri:b");
const C = labelAddress("cri:c");

function multi(quorum: number): ParonLedger {
  return new ParonLedger({ cri: { attestors: [A, B, C], quorum } });
}

test("CRI publishes the median only once the attestor quorum is met", () => {
  const l = multi(2);
  l.attestReferenceIndex(A, 2_200_000n, SRC);
  assert.equal(l.criIndex().price, 0n, "one of two required attestors: nothing published");
  l.attestReferenceIndex(B, 2_250_000n, SRC);
  assert.equal(l.criIndex().price, 2_225_000n, "average of the two middle values");
  assert.throws(() => l.attestReferenceIndex(labelAddress("cri:stranger"), 1n, SRC), errorName("NotAttestor"));
  assert.throws(() => l.attestReferenceIndex(A, 0n, SRC), errorName("ZeroPrice"));
});

test("a malicious minority cannot move the median and a colluding quorum walks at most one step per hour", () => {
  const l = multi(2);
  l.attestReferenceIndex(A, 2_200_000n, SRC);
  l.attestReferenceIndex(B, 2_250_000n, SRC);
  l.advance(CRI_MIN_INTERVAL);
  l.attestReferenceIndex(C, 22_000_000n, SRC);
  assert.equal(l.criIndex().price, 2_250_000n, "median of 2.20 / 2.25 / 22.00 ignores the outlier");

  const solo = new ParonLedger();
  const att = solo.addr.attestor;
  solo.attestReferenceIndex(att, 2_200_000n, SRC);
  solo.advance(CRI_MIN_INTERVAL);
  solo.attestReferenceIndex(att, 22_000_000n, SRC);
  assert.equal(solo.criIndex().price, 2_420_000n, "+10% step, not 10x");
  solo.attestReferenceIndex(att, 22_000_000n, SRC);
  assert.equal(solo.criIndex().price, 2_420_000n, "a second publication inside the interval is held");
  solo.advance(CRI_MIN_INTERVAL);
  solo.attestReferenceIndex(att, 22_000_000n, SRC);
  assert.equal(solo.criIndex().price, 2_662_000n);
});

test("the $WIF reference price moves at most 10% and once per hour", () => {
  const l = new ParonLedger();
  const oracle = l.addr.deployer;
  assert.throws(() => l.setWifPrice(oracle, 501n), errorName("PriceUpdateTooSoon"));
  l.advance(3_600n);
  assert.throws(() => l.setWifPrice(oracle, 551n), errorName("PriceMoveTooLarge"));
  assert.throws(() => l.setWifPrice(oracle, 449n), errorName("PriceMoveTooLarge"));
  l.setWifPrice(oracle, 450n);
  assert.equal(l.flywheelStats().wifPriceUsdg, 450n);
  assert.throws(() => l.setWifPrice(oracle, 500n), errorName("PriceUpdateTooSoon"));
  assert.throws(() => l.setWifPrice(labelAddress("stranger") as Address, 450n), errorName("NotOracle"));
});

test("maxWifBurn stops a price move between quote and execution", () => {
  const w = createProtocolWorld();
  const l = w.ledger;
  const p = makeActor("slip-provider", "slip-provider", "provider", "");
  l.mintWif(p.address, 150_000n * WIF);
  l.mintUsdg(p.address, 50_000n * USDG);
  l.registerProviderAndStakeWif(p.address, "ipfs://p", 100_000n * WIF);
  l.mintPrimarySeries(p.address, w.series.jkt, 100n, 2_000_000n);
  const buyer = makeActor("slip-buyer", "slip-buyer", "agent", "");
  l.mintWif(buyer.address, 20_000n * WIF);
  l.mintUsdg(buyer.address, 1_000n * USDG);

  const quoted = l.quoteBuy(w.series.jkt, 10n, 2_000_000n, true).wifBurn;
  assert.equal(quoted, 20n * WIF);
  l.advance(3_600n);
  l.setWifPrice(l.addr.deployer, 450n); // -10%: the burn grows by 11.1%
  const before = l.wifBalance(buyer.address);
  assert.throws(() => l.buySeriesOrPlaceBid(buyer.address, w.series.jkt, 10n, 2_000_000n, true, quoted), errorName("WifBurnExceedsMax"));
  assert.equal(l.wifBalance(buyer.address), before, "the reverted trade took nothing");
  const r = l.buySeriesOrPlaceBid(buyer.address, w.series.jkt, 10n, 2_000_000n, true, (quoted * 12n) / 10n);
  assert.equal(r.filledCu, 10n);
  assert.equal(before - l.wifBalance(buyer.address), 22_222_222_222_222_222_222n);
  // Standard mode takes no $WIF, so any cap (even zero) is fine.
  l.buySeriesOrPlaceBid(buyer.address, w.series.jkt, 10n, 2_000_000n, false, 0n);
});
