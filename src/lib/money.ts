// Decimal-safe money helpers for the New Bill Entry grid.
//
// We compute net amounts as `qty * unitPrice` — floating-point multiplication
// like `0.1 * 0.2` produces visible precision garbage. To avoid that, we scale
// both operands to their combined decimal precision using string parsing and
// BigInt, then round back down to 4 fractional digits (enough for MYR unit
// prices to two decimals and quantities to four). Display always uses two
// decimals via `formatMoney`.

const NUM_RE = /^-?\d+(?:\.\d+)?$/;

function parseDecimal(raw: string): { sign: 1n | -1n; whole: string; frac: string } | null {
  const s = raw.trim();
  if (!s || !NUM_RE.test(s)) return null;
  const sign: 1n | -1n = s.startsWith("-") ? -1n : 1n;
  const body = s.startsWith("-") ? s.slice(1) : s;
  const [w, f = ""] = body.split(".");
  return { sign, whole: w, frac: f };
}

/**
 * Multiply two decimal strings, returning a `number` accurate to 4 decimals.
 * Returns 0 for any malformed input (blank fields treated as zero).
 */
export function multiplyDecimal(a: string, b: string): number {
  if (!a || !b) return 0;
  const pa = parseDecimal(a);
  const pb = parseDecimal(b);
  if (!pa || !pb) return 0;
  const scaleA = pa.frac.length;
  const scaleB = pb.frac.length;
  const ai = BigInt(pa.whole + pa.frac || "0");
  const bi = BigInt(pb.whole + pb.frac || "0");
  const raw = pa.sign * pb.sign * ai * bi;
  const totalScale = scaleA + scaleB;
  const targetScale = 4;
  if (totalScale === targetScale) return Number(raw) / 10_000;
  if (totalScale > targetScale) {
    const drop = totalScale - targetScale;
    const divisor = 10n ** BigInt(drop);
    const halfRounded = (raw + (raw >= 0n ? divisor / 2n : -divisor / 2n)) / divisor;
    return Number(halfRounded) / 10_000;
  }
  const mul = 10n ** BigInt(targetScale - totalScale);
  return Number(raw * mul) / 10_000;
}

/** Half-away-from-zero round to 2 decimals. */
export function round2(n: number): number {
  if (!Number.isFinite(n)) return 0;
  const sign = n < 0 ? -1 : 1;
  return (sign * Math.round(Math.abs(n) * 100)) / 100;
}

/** Sum a list of already-rounded numbers with a final 2-decimal quantize. */
export function sumTo2dp(values: number[]): number {
  const cents = values.reduce((acc, v) => acc + Math.round(v * 100), 0);
  return cents / 100;
}

/** Format any finite number as MYR-style "1234.56". Non-finite → "0.00". */
export function formatMoney(n: number): string {
  return Number.isFinite(n) ? n.toFixed(2) : "0.00";
}

export interface LineAmounts {
  /** Net amount before tax (line net). */
  net: number;
  /** Tax amount (rounded to 2dp). */
  tax: number;
  /** Line grand total (net + tax, i.e. tax-inclusive gross). */
  grand: number;
}

/**
 * Compute per-line net/tax/grand given qty, unit price, rate (percentage) and
 * the Tax Inclusive flag. Rate is the numeric percentage from the N3 Tax Code
 * DTO (e.g. `10` for PT-10%). A missing / zero rate produces tax = 0.
 *
 * Tax-exclusive: net = round(qty*price, 2); tax = round(net*rate/100, 2).
 * Tax-inclusive: gross = round(qty*price, 2);
 *                tax = round(gross*rate/(100+rate), 2); net = gross - tax.
 */
export function computeLine(input: {
  qty: string;
  unitPrice: string;
  rate: number | null | undefined;
  inclusive: boolean;
}): LineAmounts {
  const rate = Number.isFinite(input.rate as number) ? Math.max(0, Number(input.rate)) : 0;
  const raw = multiplyDecimal(input.qty, input.unitPrice);
  if (input.inclusive) {
    const grand = round2(raw);
    if (rate <= 0) return { net: grand, tax: 0, grand };
    const tax = round2((grand * rate) / (100 + rate));
    const net = round2(grand - tax);
    return { net, tax, grand };
  }
  const net = round2(raw);
  const tax = rate > 0 ? round2((net * rate) / 100) : 0;
  const grand = round2(net + tax);
  return { net, tax, grand };
}
