import { CONFIG } from "../config";

/** Base units in one whole USDC (7 decimals). */
export const USDC_UNIT = 10n ** BigInt(CONFIG.usdcDecimals);

/** "1234.5" from base units, with at least `minDecimals` decimals. */
export function fmtToken(units: bigint, minDecimals = 2): string {
  const negative = units < 0n;
  const abs = negative ? -units : units;
  const whole = abs / USDC_UNIT;
  let frac = (abs % USDC_UNIT).toString().padStart(CONFIG.usdcDecimals, "0").replace(/0+$/, "");
  if (frac.length < minDecimals) frac = frac.padEnd(minDecimals, "0");
  const wholeStr = whole.toLocaleString("en-US");
  return `${negative ? "-" : ""}${wholeStr}${frac ? "." + frac : ""}`;
}

/** Base units from a decimal string, or null if it is not a valid amount. */
export function parseToken(input: string): bigint | null {
  const s = input.trim().replace(/,/g, "");
  const m = s.match(/^(\d+)(?:\.(\d*))?$/);
  if (!m) return null;
  const frac = m[2] ?? "";
  if (frac.length > CONFIG.usdcDecimals) return null;
  return BigInt(m[1]) * USDC_UNIT + BigInt(frac.padEnd(CONFIG.usdcDecimals, "0") || "0");
}

export function fmtSats(sats: number): string {
  return sats.toLocaleString("en-US");
}

export function fmtBtc(sats: number): string {
  return (sats / 1e8).toFixed(8).replace(/0+$/, "").replace(/\.$/, "");
}

/** USD per BTC implied by a price in satoshis per whole USDC. */
export function usdPerBtc(satsPerToken: bigint): number {
  return 1e8 / Number(satsPerToken);
}

/** Satoshis per whole USDC for a BTC price in USD. */
export function satsPerTokenFor(usdPerBtcPrice: number): bigint {
  return BigInt(Math.max(1, Math.round(1e8 / usdPerBtcPrice)));
}

export function fmtUsd(value: number): string {
  return value.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

export function fmtPct(bps: number): string {
  const pct = bps / 100;
  return `${Number.isInteger(pct) ? pct : pct.toFixed(2)}%`;
}

/** Signed difference of `price` against `reference`, e.g. "+2.4%" or "-25.1%". */
export function fmtPremium(price: number, reference: number): string {
  const diff = ((price - reference) / reference) * 100;
  return `${diff >= 0 ? "+" : ""}${diff.toFixed(1)}%`;
}

/** True when `price` rounds to 0.0% against `reference`, so a signed premium would read as noise ("-0.0%"). */
export function atMarket(price: number, reference: number): boolean {
  return Math.abs(((price - reference) / reference) * 100) < 0.05;
}

export function shortAddr(address: string, size = 4): string {
  return address.length <= 2 * size + 1 ? address : `${address.slice(0, size)}…${address.slice(-size)}`;
}

export function fmtDuration(totalSecs: number): string {
  const s = Math.max(0, Math.floor(totalSecs));
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3_600);
  const m = Math.floor((s % 3_600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s % 60}s`;
}
