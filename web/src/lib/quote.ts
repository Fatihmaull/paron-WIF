import {
  BPS,
  FEE_BURN_SHARE_BPS,
  FEE_JURY_SHARE_BPS,
  STANDARD_FEE_BPS,
  WIF,
  WIF_FEE_BPS,
  type BookLevel,
} from "@paron-wif/core";

export type BuyQuote = {
  fillableCu: bigint;
  notional: bigint;
  avgPrice: bigint;
  feeUsdg: bigint;
  standardFeeUsdg: bigint;
  burnLegUsdg: bigint;
  juryLegUsdg: bigint;
  providerLegUsdg: bigint;
  wifBurned: bigint;
  restingCu: bigint;
  restingEscrow: bigint;
};

/** Mirrors ParonExchangeDesk.quoteBuy + the fee routing of WifFlywheelVault, from aggregated ask levels. */
export function quoteBuy(asks: BookLevel[], cu: bigint, maxPrice: bigint, wifMode: boolean, wifPriceUsdg: bigint): BuyQuote {
  let remaining = cu;
  let fillableCu = 0n;
  let notional = 0n;
  for (const level of asks) {
    if (remaining === 0n || level.price > maxPrice) break;
    const take = remaining < level.qty ? remaining : level.qty;
    fillableCu += take;
    notional += take * level.price;
    remaining -= take;
  }
  const feeBps = wifMode ? WIF_FEE_BPS : STANDARD_FEE_BPS;
  const feeUsdg = (notional * feeBps) / BPS;
  const standardFeeUsdg = (notional * STANDARD_FEE_BPS) / BPS;
  const burnLegUsdg = (feeUsdg * FEE_BURN_SHARE_BPS) / BPS;
  const juryLegUsdg = (feeUsdg * FEE_JURY_SHARE_BPS) / BPS;
  const providerLegUsdg = feeUsdg - burnLegUsdg - juryLegUsdg;
  const wifBurned = wifPriceUsdg > 0n ? (burnLegUsdg * WIF) / wifPriceUsdg : 0n;
  const restingCost = remaining * maxPrice;
  return {
    fillableCu,
    notional,
    avgPrice: fillableCu > 0n ? notional / fillableCu : 0n,
    feeUsdg,
    standardFeeUsdg,
    burnLegUsdg,
    juryLegUsdg,
    providerLegUsdg,
    wifBurned,
    restingCu: remaining,
    restingEscrow: restingCost + (restingCost * STANDARD_FEE_BPS) / BPS,
  };
}

export function marginFor(cu: bigint, price: bigint, marginBps: bigint): bigint {
  const raw = cu * price * marginBps;
  return raw === 0n ? 0n : (raw - 1n) / BPS + 1n;
}
