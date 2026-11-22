/**
 * Token logos for the explorer's pages, all from the explorer's own address (/logo/<token>), so the
 * pages' policy stays "img-src 'self'" and no page shows a broken image:
 * - LONGYU's own tokens: the brand mark; wrapped BNB: BNB's logo.
 * - A token made with LONGYU Launch whose creator set a logo: that logo, read from LONGYU's API
 *   (TOKEN_LOGO_API), checked to be a PNG, JPEG or WebP of at most 300 KB, and kept for ten minutes.
 * - Anything else: a round monogram drawn here from the token's symbol (letters and digits only).
 */
export const WBNB = "0x4200000000000000000000000000000000000006";
const MAX_BYTES = 300 * 1024;
const KEEP_MS = 10 * 60_000;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

export type Logo = { body: Buffer; type: string };

/** Light tints with a darker ink of the same hue, picked by the symbol. */
const TINTS: [string, string][] = [["#E6F4FE", "#0B6FDB"], ["#EDE9FE", "#5B3FD1"], ["#E7F6EF", "#0B8058"], ["#FDF1E3", "#A8610B"], ["#FDE8E7", "#B42318"], ["#E8EEF6", "#3A4A63"]];

/** A round monogram: the symbol's first two letters or digits on a tint chosen by the symbol. */
export function monogramSvg(symbol: string | null): Logo {
  const clean = (symbol ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const letters = clean.slice(0, 2) || "?";
  let h = 0;
  for (const c of clean) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const [bg, fg] = TINTS[h % TINTS.length]!;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><circle cx="20" cy="20" r="20" fill="${bg}"/><text x="20" y="25" text-anchor="middle" font-family="Inter,Arial,sans-serif" font-size="${letters.length > 1 ? 13 : 16}" font-weight="600" fill="${fg}">${letters}</text></svg>`;
  return { body: Buffer.from(svg), type: "image/svg+xml" };
}

/** Reads creators' logos from LONGYU's API, remembering answers (and their absence) for ten minutes. */
export function logoReader(apiUrl: string | undefined, fetchImpl: typeof fetch = fetch) {
  const kept = new Map<string, { logo: Logo | null; until: number }>();
  return async (token: string): Promise<Logo | null> => {
    if (!apiUrl) return null;
    const now = Date.now();
    const hit = kept.get(token);
    if (hit && hit.until > now) return hit.logo;
    let logo: Logo | null = null;
    try {
      const res = await fetchImpl(`${apiUrl.replace(/\/$/, "")}/v1/tokens/${token}/logo`, { signal: AbortSignal.timeout(5000) });
      const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
      if (res.ok && IMAGE_TYPES.has(type)) {
        const body = Buffer.from(await res.arrayBuffer());
        if (body.length > 0 && body.length <= MAX_BYTES) logo = { body, type };
      }
    } catch {
      // The API is out of reach: the monogram stands in, and the next ask tries again soon.
      kept.set(token, { logo: null, until: now + 30_000 });
      return null;
    }
    if (kept.size > 2000) kept.clear();
    kept.set(token, { logo, until: now + KEEP_MS });
    return logo;
  };
}
