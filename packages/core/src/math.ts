import { BPS, GPU_WEIGHT_BPS, WIF, type GpuTier } from "./constants.ts";

export const min = (a: bigint, b: bigint): bigint => (a < b ? a : b);
export const max = (a: bigint, b: bigint): bigint => (a > b ? a : b);

/** Solidity `a == 0 ? 0 : (a - 1) / b + 1`. */
export function ceilDiv(a: bigint, b: bigint): bigint {
  return a === 0n ? 0n : (a - 1n) / b + 1n;
}

/** Mirror of ParonSeriesToken.convertGpuHoursToCu. Inputs/outputs share any fixed-point scale. */
export function convertGpuHoursToCu(tier: GpuTier, hoursScaled: bigint): bigint {
  return (hoursScaled * GPU_WEIGHT_BPS[tier]) / BPS;
}

/** Mirror of ParonSeriesToken.convertCuToGpuHours. */
export function convertCuToGpuHours(tier: GpuTier, cuScaled: bigint): bigint {
  return (cuScaled * BPS) / GPU_WEIGHT_BPS[tier];
}

/** Floating helper for display-only conversions (e.g. 25 CU of H200 = 17.86 native hours). */
export function gpuHoursForCu(tier: GpuTier, cu: number): number {
  return (cu * 10_000) / Number(GPU_WEIGHT_BPS[tier]);
}

export function cuForGpuHours(tier: GpuTier, hours: number): number {
  return (hours * Number(GPU_WEIGHT_BPS[tier])) / 10_000;
}

/** $WIF needed to cover `usdgAmount` at `priceUsdg` (USDG base units per 1 $WIF), floored like the contracts. */
export function usdgToWif(usdgAmount: bigint, priceUsdg: bigint): bigint {
  return (usdgAmount * WIF) / priceUsdg;
}

export function wifToUsdg(wifAmount: bigint, priceUsdg: bigint): bigint {
  return (wifAmount * priceUsdg) / WIF;
}

/** Delivery month YYMM -> [start, end) unix seconds, identical to ParonSeriesToken._monthStart. */
export function monthStart(year: number, month: number): bigint {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const mp = (month + 9) % 12;
  const doy = Math.floor((153 * mp + 2) / 5);
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return BigInt(era * 146_097 + doe - 719_468) * 86_400n;
}

export function deliveryWindow(yymm: number): { start: bigint; end: bigint } {
  const yy = Math.floor(yymm / 100);
  const mm = yymm % 100;
  const start = monthStart(2000 + yy, mm);
  const end = mm === 12 ? monthStart(2001 + yy, 1) : monthStart(2000 + yy, mm + 1);
  return { start, end };
}
