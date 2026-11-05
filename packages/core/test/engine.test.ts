import { test } from "node:test";
import assert from "node:assert/strict";
import { keccak256, toHex } from "viem";
import { USDG, WIF } from "../src/constants.ts";
import { ParonError } from "../src/engine/errors.ts";
import { recoverSigner, signDigest } from "../src/engine/ledger.ts";
import { convertCuToGpuHours, convertGpuHoursToCu, deliveryWindow } from "../src/math.ts";
import { createProtocolWorld, deliverSigned, demoKey, makeActor } from "../src/seed.ts";
import { snapshotFromLedger } from "../src/snapshot.ts";
import type { Hex } from "../src/types.ts";

function world() {
  const w = createProtocolWorld();
  const l = w.ledger;
  const fund = (key: string, wif: bigint, usdg: bigint, tee = false) => {
    const a = makeActor(key, key, "provider", key, tee);
    if (wif) l.mintWif(a.address, wif);
    if (usdg) l.mintUsdg(a.address, usdg);
    return a;
  };
  return { w, l, fund };
}

test("hardware weights and canonical delivery windows mirror the contracts", () => {
  assert.equal(convertGpuHoursToCu("A100", 100n * WIF), 45n * WIF);
  assert.equal(convertGpuHoursToCu("GB200", 100n * WIF), 350n * WIF);
  assert.equal(convertCuToGpuHours("H200", 35n * WIF), 25n * WIF);
  assert.deepEqual(deliveryWindow(2611), { start: 1_793_491_200n, end: 1_796_083_200n });
  assert.deepEqual(deliveryWindow(2612), { start: 1_796_083_200n, end: 1_798_761_600n });
  const { w, l } = world();
  assert.equal(l.getSeries(w.series.btm).symbol, "CU-BTM-H200-2611");
  assert.throws(() => l.createSeries(l.addr.deployer, 1, "H200", 2611), (e: unknown) => e instanceof ParonError && e.errorName === "SeriesExists");
});

test("margin tiers: 50% / 35% / 25% of notional", () => {
  const { w, l, fund } = world();
  for (const [stake, expected] of [[0n, 100_000_000n], [25_000n * WIF, 70_000_000n], [100_000n * WIF, 50_000_000n]] as const) {
    const p = fund(`tier-${stake}`, stake + 1n, 1_000n * USDG);
    l.registerProviderAndStakeWif(p.address, "ipfs://p", stake);
    const before = l.usdgBalance(p.address);
    l.mintPrimarySeries(p.address, w.series.jkt, 100n, 2_000_000n);
    assert.equal(before - l.usdgBalance(p.address), expected);
  }
});

test("failed transactions roll back atomically like an EVM revert", () => {
  const { w, l, fund } = world();
  const p = fund("rollback-provider", 100_000n * WIF, 1_000n * USDG);
  l.registerProviderAndStakeWif(p.address, "ipfs://p", 100_000n * WIF);
  l.mintPrimarySeries(p.address, w.series.jkt, 10n, 2_000_000n);
  const poor = fund("poor-buyer", 0n, 5n * USDG);
  const before = structuredClone(l.s);
  // 10 CU x $2 = $20 > $5 balance: the transfer to the escrow fails after matching mutated the book.
  assert.throws(() => l.buySeriesOrPlaceBid(poor.address, w.series.jkt, 10n, 2_000_000n, false), (e: unknown) => e instanceof ParonError && e.errorName === "InsufficientBalance");
  assert.deepEqual(l.s.desk.lots, before.desk.lots);
  assert.deepEqual(l.s.desk.orders, before.desk.orders);
  assert.equal(l.events().length, before.events.length);
});

test("USDG is conserved and $WIF supply always equals minted minus burned", () => {
  const { w, l, fund } = world();
  const p = fund("cons-provider", 150_000n * WIF, 5_000n * USDG, true);
  l.registerProviderAndStakeWif(p.address, "ipfs://p", 100_000n * WIF);
  l.setAttestationSigner(p.address, p.teeAddress!);
  const { lotId } = l.mintPrimarySeries(p.address, w.series.btm, 200n, 2_240_000n);
  const buyer = fund("cons-buyer", 50_000n * WIF, 2_000n * USDG);
  const trader = fund("cons-trader", 0n, 2_000n * USDG);
  l.buySeriesOrPlaceBid(buyer.address, w.series.btm, 60n, 2_300_000n, true);
  l.buySeriesOrPlaceBid(trader.address, w.series.btm, 30n, 2_100_000n, false);
  l.placeAsk(buyer.address, w.series.btm, 10n, 2_100_000n);
  const rid = l.requestRedemption(buyer.address, w.series.btm, 20n, lotId, keccak256(toHex("ssh")) as Hex);
  l.acknowledgeRedemption(p.address, rid);
  deliverSigned(l, p, rid, "job", 700, 9_700);
  l.openSlaDispute(buyer.address, rid, keccak256(toHex("probe")) as Hex, "latency");
  l.advance(l.params.votingPeriod);
  l.resolveDispute(buyer.address, 1);
  l.claimVoterUpside(buyer.address, 1);

  const usdgTotal = [...l.s.usdg.balances.values()].reduce((a, b) => a + b, 0n);
  assert.equal(usdgTotal, l.s.usdg.totalSupply, "no USDG created or destroyed by the protocol");
  const wifTotal = [...l.s.wif.balances.values()].reduce((a, b) => a + b, 0n);
  assert.equal(wifTotal, l.wifTotalSupply());
  assert.equal(l.wifTotalSupply() + l.wifTotalBurned(), 5_000_000n * WIF + 150_000n * WIF + 50_000n * WIF);
  assert.equal(l.wifTotalBurned(), l.flywheelStats().totalWifBurned);
});

test("price-time priority with the $WIF priority lane", () => {
  const { w, l, fund } = world();
  const p = fund("lane-provider", 0n, 1_000n * USDG);
  l.registerProviderAndStakeWif(p.address, "ipfs://p", 0n);
  l.mintPrimarySeries(p.address, w.series.jkt, 10n, 2_000_000n);
  const plain = fund("plain", 0n, 100n * USDG);
  const holder = fund("holder", 15_000n * WIF, 100n * USDG);
  l.buySeriesOrPlaceBid(plain.address, w.series.jkt, 5n, 2_000_000n, false);
  l.buySeriesOrPlaceBid(holder.address, w.series.jkt, 5n, 2_000_000n, false);
  const a1 = l.placeAsk(plain.address, w.series.jkt, 5n, 2_500_000n).orderId;
  const a2 = l.placeAsk(holder.address, w.series.jkt, 5n, 2_500_000n).orderId;
  assert.equal(l.getOrder(a1)!.lane, 1);
  assert.equal(l.getOrder(a2)!.lane, 0);
  const buyer = fund("lane-buyer", 0n, 100n * USDG);
  l.buySeriesOrPlaceBid(buyer.address, w.series.jkt, 5n, 2_500_000n, false);
  assert.equal(l.getOrder(a2)!.qtyRemaining, 0n);
  assert.equal(l.getOrder(a1)!.qtyRemaining, 5n);
});

test("delivery receipts verify EIP-191 attestation signatures", () => {
  const key = demoKey("sig-test");
  const digest = keccak256(toHex("payload")) as Hex;
  const sig = signDigest(digest, key);
  const signer = recoverSigner(digest, sig);
  assert.match(signer ?? "", /^0x[0-9a-f]{40}$/);
  assert.notEqual(recoverSigner(keccak256(toHex("other")) as Hex, sig), signer);

  const { w, l, fund } = world();
  const p = fund("tee-provider", 150_000n * WIF, 5_000n * USDG, true);
  l.registerProviderAndStakeWif(p.address, "ipfs://p", 100_000n * WIF);
  l.setAttestationSigner(p.address, p.teeAddress!);
  const { lotId } = l.mintPrimarySeries(p.address, w.series.btm, 10n, 2_000_000n);
  const buyer = fund("tee-buyer", 0n, 100n * USDG);
  l.buySeriesOrPlaceBid(buyer.address, w.series.btm, 10n, 2_000_000n, false);
  const rid = l.requestRedemption(buyer.address, w.series.btm, 5n, lotId, "0x01");
  l.acknowledgeRedemption(p.address, rid);
  const receipt = keccak256(toHex("job")) as Hex;
  const forged = signDigest(l.deliveryReceiptDigest(rid, receipt, 100, 10_000), demoKey("impostor"));
  assert.throws(() => l.deliverWithReceipt(p.address, rid, receipt, 100, 10_000, forged), (e: unknown) => e instanceof ParonError && e.errorName === "InvalidAttestation");
  deliverSigned(l, p, rid, "job", 100, 10_000);
  assert.equal(l.getRedemption(rid)!.state, "Delivered");
});

test("missed deadline slashes without a vote; snapshot exposes the full read model", () => {
  const { w, l, fund } = world();
  const p = fund("slow-provider", 150_000n * WIF, 5_000n * USDG);
  l.registerProviderAndStakeWif(p.address, "ipfs://p", 100_000n * WIF);
  const { lotId } = l.mintPrimarySeries(p.address, w.series.btm, 100n, 2_000_000n);
  const holder = fund("slow-holder", 20_000n * WIF, 1_000n * USDG);
  l.buySeriesOrPlaceBid(holder.address, w.series.btm, 40n, 2_000_000n, true);
  const rid = l.requestRedemption(holder.address, w.series.btm, 10n, lotId, "0x01");
  l.advance(l.params.ackWindow + 1n);
  const before = l.usdgBalance(holder.address);
  l.claimMissedDeadline(holder.address, rid);
  assert.equal(l.usdgBalance(holder.address) - before, 23_000_000n);
  const snap = snapshotFromLedger(l, { account: holder.address });
  assert.equal(snap.series.length, 3);
  assert.equal(snap.redemptions[0].state, "Slashed");
  assert.equal(snap.account?.cu[w.series.btm], 30n);
  assert.ok(snap.flywheel.totalWifBurned > 0n);
});
