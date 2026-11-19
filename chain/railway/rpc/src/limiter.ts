import { isIP } from "node:net";

/**
 * The address a rate limit counts by: an IPv4 address as it is, an IPv6 address by its /64 network
 * (one subscriber holds a whole /64). Returns null when the text is not an address.
 */
export function clientKey(text: string): string | null {
  const ip = text.trim();
  const version = isIP(ip);
  if (version === 4) return ip;
  if (version !== 6) return null;
  const bare = ip.split("%")[0]!.toLowerCase();
  // An IPv4 address written inside IPv6 (::ffff:203.0.113.5) counts as that IPv4 address.
  const mapped = /^(?:::ffff:|0{1,4}(?::0{1,4}){4}:ffff:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(bare);
  if (mapped && isIP(mapped[1]!) === 4) return mapped[1]!;
  const [head = "", tail] = bare.split("::");
  const left = head === "" ? [] : head.split(":");
  const right = tail === undefined || tail === "" ? [] : tail.split(":");
  // A dotted IPv4 ending takes the place of the last two groups.
  const groups = (parts: string[]) => parts.reduce((n, p) => n + (p.includes(".") ? 2 : 1), 0);
  const missing = tail === undefined ? 0 : 8 - groups(left) - groups(right);
  const all = [...left, ...Array<string>(Math.max(missing, 0)).fill("0"), ...right];
  return `${all.slice(0, 4).map((g) => (g.includes(".") ? "0" : g.replace(/^0+(?=.)/, ""))).join(":")}::/64`;
}

type Bucket = { tokens: number; at: number };

/** A token bucket per client: `rate` tokens a second, at most `burst` saved up. */
export class Limiter {
  private buckets = new Map<string, Bucket>();
  private rate: number;
  private burst: number;
  private maxKeys: number;

  constructor(rate: number, burst: number, maxKeys = 50_000) {
    this.rate = rate;
    this.burst = burst;
    this.maxKeys = maxKeys;
  }

  /** Takes `cost` tokens from the client's bucket; false when it does not hold that many. */
  take(key: string, cost: number, now: number): boolean {
    let b = this.buckets.get(key);
    if (!b) {
      if (this.buckets.size >= this.maxKeys) {
        this.sweep(now);
        // Still full of active clients: newcomers share one bucket, so memory stays bounded.
        if (this.buckets.size >= this.maxKeys) key = "overflow";
      }
      b = this.buckets.get(key);
      if (!b) {
        b = { tokens: this.burst, at: now };
        this.buckets.set(key, b);
      }
    }
    b.tokens = Math.min(this.burst, b.tokens + (Math.max(now - b.at, 0) / 1000) * this.rate);
    // Never moved back: a clock that steps back and forward again must not earn the time twice.
    b.at = Math.max(b.at, now);
    if (b.tokens < cost) return false;
    b.tokens -= cost;
    return true;
  }

  /** Forgets clients whose bucket has refilled: they are indistinguishable from new ones. */
  sweep(now: number): void {
    for (const [key, b] of this.buckets) {
      if (b.tokens + (Math.max(now - b.at, 0) / 1000) * this.rate >= this.burst) this.buckets.delete(key);
    }
  }

  get size(): number {
    return this.buckets.size;
  }
}
