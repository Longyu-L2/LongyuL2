/** Pure formatting helpers (no React Native imports, so they run under plain Node tests). */

const DECIMALS = 18n;
const ONE = 10n ** DECIMALS;

/** "24000000000000000000" -> "24", "12345600000000000000" -> "12.3456" (up to `places` decimals). */
export function formatToken(wei: string | bigint, places = 4): string {
  const v = typeof wei === "bigint" ? wei : BigInt(wei || "0");
  const negative = v < 0n;
  const abs = negative ? -v : v;
  const whole = abs / ONE;
  const frac = abs % ONE;
  let fracStr = frac.toString().padStart(Number(DECIMALS), "0").slice(0, places).replace(/0+$/, "");
  const wholeStr = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  if (places > 0 && fracStr === "" && frac > 0n && whole === 0n) fracStr = "0".repeat(places - 1) + "1"; // tiny but non-zero
  return `${negative ? "-" : ""}${wholeStr}${fracStr ? `.${fracStr}` : ""}`;
}

/**
 * Like formatToken, with exactly `places` decimals (cut, never rounded up): for an amount that
 * changes in place, so its width stays the same. "1500000000000000000" -> "1.5000".
 */
export function formatTokenFixed(wei: string | bigint, places = 4): string {
  const v = typeof wei === "bigint" ? wei : BigInt(wei || "0");
  const abs = v < 0n ? -v : v;
  const whole = (abs / ONE).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const frac = (abs % ONE).toString().padStart(Number(DECIMALS), "0").slice(0, places);
  return `${v < 0n ? "-" : ""}${whole}${places > 0 ? `.${frac}` : ""}`;
}

/** Seconds -> "23h 59m", "5m", "0m". */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/** Fraction of a 24-hour session elapsed, clamped to [0, 1]. */
export function sessionProgress(startedAt: number, now: number, length = 86_400): number {
  if (length <= 0) return 1;
  return Math.min(1, Math.max(0, (now - startedAt) / length));
}

export function shortAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

export const tierName = (tier: number): string => ["Restricted", "Miner", "Verified", "Trusted"][tier] ?? "Unknown";

/** Translation key for a tier (see i18n.ts). */
export const tierKey = (tier: number) =>
  (["tierRestricted", "tierNewcomer", "tierVerified", "tierTrusted"] as const)[tier] ?? "tierRestricted";

/** A boost in basis points as mining power: 5000 -> "1.50×". */
export function multiplier(boostBps: number): string {
  return `${(1 + boostBps / 10_000).toFixed(2)}×`;
}

/** A boost in basis points as a percentage: 5000 -> "+50%". */
export function boostPercent(boostBps: number): string {
  return `+${Math.round(boostBps / 100)}%`;
}

/**
 * Fills "{name}" placeholders in a translated string. A missing or empty value is dropped together
 * with the separator before it, so "Good evening, {name}" becomes "Good evening".
 */
export function fill(template: string, vars: Record<string, string | number | null | undefined>): string {
  return template.replace(/([,，]\s*)?\{(\w+)\}/g, (match, sep: string | undefined, key: string) => {
    const v = vars[key];
    if (v === undefined || v === null || v === "") return "";
    return `${sep ?? ""}${v}`;
  });
}

/** "318,442,915" -> "318.4M", "48,213" -> "48.2K", "950" -> "950". Input may contain commas. */
export function compactNumber(value: string): string {
  const n = Number(value.replace(/,/g, ""));
  if (!Number.isFinite(n)) return value;
  const units: [number, string][] = [[1e9, "B"], [1e6, "M"], [1e3, "K"]];
  for (const [size, suffix] of units) {
    if (Math.abs(n) >= size) return `${(n / size).toFixed(1).replace(/\.0$/, "")}${suffix}`;
  }
  return String(n);
}

/** A capacity plan's class: "c3-30" -> "C3". Plans without a class suffix keep their own name. */
export function capacityClass(planId: string): string {
  return (planId.split("-")[0] ?? planId).toUpperCase();
}
