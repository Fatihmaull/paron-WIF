import { USDG, WIF } from "./constants.ts";

function group(intPart: string): string {
  return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Fixed-point bigint -> grouped decimal string with `digits` fraction digits (truncated, never rounded up). */
export function formatUnits(value: bigint, decimals: number, digits: number): string {
  const negative = value < 0n;
  const v = negative ? -value : value;
  const base = 10n ** BigInt(decimals);
  const intPart = v / base;
  let frac = (v % base).toString().padStart(decimals, "0").slice(0, digits);
  if (digits > 0 && frac.length < digits) frac = frac.padEnd(digits, "0");
  const body = digits > 0 ? `${group(intPart.toString())}.${frac}` : group(intPart.toString());
  return negative ? `-${body}` : body;
}

export function formatUsdg(value: bigint, digits = 2): string {
  return `$${formatUnits(value, 6, digits)}`;
}

/** Compact USDG for dense UI cells: $18.4k, $1.2M. */
export function formatUsdgCompact(value: bigint): string {
  const n = Number(value) / Number(USDG);
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (Math.abs(n) >= 10_000) return `$${(n / 1_000).toFixed(1)}k`;
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatWif(value: bigint, digits = 2): string {
  return `${formatUnits(value, 18, digits)} $WIF`;
}

export function formatWifAmount(value: bigint, digits = 2): string {
  return formatUnits(value, 18, digits);
}

export function formatWifCompact(value: bigint): string {
  const n = Number(value / 10n ** 12n) / 1e6;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 10_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

export function formatCu(value: bigint): string {
  return `${group(value.toString())} CU`;
}

export function formatPrice(value: bigint): string {
  return formatUnits(value, 6, 2);
}

export function formatBps(bps: bigint | number): string {
  const n = Number(bps);
  return `${(n / 100).toFixed(n % 100 === 0 ? 0 : 2)}%`;
}

export function shortAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

/** Parses a user-entered decimal ("12.5") into fixed-point bigint. Returns null when invalid. */
export function parseUnits(input: string, decimals: number): bigint | null {
  const s = input.trim().replace(/,/g, "");
  if (!/^\d*(\.\d*)?$/.test(s) || s === "" || s === ".") return null;
  const [i, f = ""] = s.split(".");
  if (f.length > decimals) return null;
  return BigInt(i || "0") * 10n ** BigInt(decimals) + BigInt((f + "0".repeat(decimals)).slice(0, decimals) || "0");
}

export const parseUsdg = (input: string) => parseUnits(input, 6);
export const parseWif = (input: string) => parseUnits(input, 18);

export function toNumberUsdg(value: bigint): number {
  return Number(value) / Number(USDG);
}

export function toNumberWif(value: bigint): number {
  return Number(value / 10n ** 12n) / 1e6;
}

export { USDG, WIF };
