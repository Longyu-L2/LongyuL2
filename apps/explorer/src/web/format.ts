/** Display formatting. Pure, so it is tested directly. */

const group = (s: string) => s.replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** 1234567890000000000000 with 18 decimals -> "1,234.56789". Unknown decimals show the raw integer. */
export function formatUnits(value: bigint | string, decimals: number | null, maxFraction = 6): string {
  const v = typeof value === "bigint" ? value : BigInt(value);
  if (decimals === null) return group(v.toString());
  const negative = v < 0n;
  const abs = negative ? -v : v;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = decimals > 0 ? (abs % base).toString().padStart(decimals, "0").slice(0, maxFraction).replace(/0+$/, "") : "";
  const sign = negative ? "-" : "";
  // Non-zero but below the shown precision: say so rather than print 0.
  if (!frac && whole === 0n && abs !== 0n) return `${sign}<0.${"0".repeat(Math.max(0, maxFraction - 1))}1`;
  return `${sign}${group(whole.toString())}${frac ? `.${frac}` : ""}`;
}

export function formatNumber(n: bigint | number | string): string {
  return group(String(n));
}

/** Gas prices on LONGYU are tiny: gwei with two decimals from 1 gwei, four from 0.0001 gwei, else wei. */
export function formatGasPrice(wei: bigint | string | null): string {
  if (wei === null) return "–";
  const v = BigInt(wei);
  if (v >= 1_000_000_000n) return `${formatUnits(v, 9, 2)} gwei`;
  if (v >= 100_000n) return `${formatUnits(v, 9, 4)} gwei`;
  return `${formatNumber(v)} wei`;
}

export function timeAgo(timestamp: bigint | number, now: number = Date.now() / 1000): string {
  const s = Math.max(0, Math.floor(now - Number(timestamp)));
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86_400)} d ago`;
}

export function utc(timestamp: bigint | number): string {
  return new Date(Number(timestamp) * 1000).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
}

export function short(hex: string, head = 6, tail = 4): string {
  return hex.length > head + tail + 2 ? `${hex.slice(0, head)}…${hex.slice(-tail)}` : hex;
}

export function percent(part: bigint, whole: bigint, digits = 2): string {
  if (whole === 0n) return "0%";
  const scaled = (part * 10n ** BigInt(digits + 2)) / whole;
  const s = scaled.toString().padStart(digits + 1, "0");
  return `${s.slice(0, -digits)}.${s.slice(-digits)}%`;
}
