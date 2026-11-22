/**
 * Logos of the tokens LONGYU Launch makes. A token's creator (LaunchedToken.creator) signs the
 * image's hash; the API checks the signature and the creator on-chain, checks the image, and keeps
 * it in the file store. Anyone may read a logo. Only PNG, JPEG and WebP are taken (no SVG: it can
 * carry script), at most 256 KB and 64 to 1024 pixels a side, and every logo is served with its own
 * content type, nosniff and a policy that runs nothing.
 */
import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { getAddress, isAddress, type Address, type Hex } from "viem";
import { z } from "zod";
import type { Deps } from "../context.ts";
import { badRequest, forbidden, notFound } from "../lib/util.ts";

export const LOGO_MAX_BYTES = 256 * 1024;
export const LOGO_MIN_SIDE = 64;
export const LOGO_MAX_SIDE = 1024;

export type LogoType = "image/png" | "image/jpeg" | "image/webp";

/** The message a creator signs (EIP-191) to set a token's logo. */
export const logoMessage = (token: Address, chainId: bigint | number, sha256: string): string =>
  `LONGYU token logo\nToken: ${getAddress(token)}\nChain: ${chainId}\nImage: sha256:${sha256}`;

/** The image's type and size in pixels, read from its header; null for anything else. */
export function imageInfo(b: Buffer): { type: LogoType; width: number; height: number } | null {
  // PNG: signature, then the IHDR chunk with width and height.
  if (b.length >= 24 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) && b.toString("latin1", 12, 16) === "IHDR") {
    return { type: "image/png", width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  }
  // JPEG: walk the segments to the first start-of-frame.
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1]!;
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      const len = b.readUInt16BE(i + 2);
      if (len < 2) return null;
      const frame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (frame) return { type: "image/jpeg", height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
      i += 2 + len;
    }
    return null;
  }
  // WebP: RIFF container with a VP8, VP8L or VP8X chunk first.
  if (b.length >= 30 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") {
    const chunk = b.toString("latin1", 12, 16);
    if (chunk === "VP8 " && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) {
      return { type: "image/webp", width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
    }
    if (chunk === "VP8L" && b[20] === 0x2f) {
      const bits = b.readUInt32LE(21);
      return { type: "image/webp", width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    if (chunk === "VP8X") {
      return { type: "image/webp", width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1 };
    }
  }
  return null;
}

/** Why an image cannot be a logo, or null when it can. */
export function logoProblem(b: Buffer): string | null {
  if (b.length === 0 || b.length > LOGO_MAX_BYTES) return "A logo is a PNG, JPEG or WebP file of at most 256 KB.";
  const info = imageInfo(b);
  if (!info) return "A logo is a PNG, JPEG or WebP file of at most 256 KB.";
  const sides = [info.width, info.height];
  if (sides.some((s) => s < LOGO_MIN_SIDE || s > LOGO_MAX_SIDE)) return "A logo is 64 to 1024 pixels on each side.";
  return null;
}

interface StoredLogo {
  type: LogoType;
  data: string;
  sha256: string;
  by: Address;
  at: string;
}

const pathOf = (token: Address) => `logos/${token.toLowerCase()}.json`;

export function registerTokenLogos(app: FastifyInstance, deps: Deps): void {
  const tokenOf = (raw: string): Address => {
    if (!isAddress(raw, { strict: false })) throw badRequest("token_invalid", "Not a token address.");
    return getAddress(raw);
  };

  app.get("/v1/tokens/:token/logo", async (req, reply) => {
    const token = tokenOf((req.params as { token: string }).token);
    const body = await deps.files.get(pathOf(token));
    if (body === null) throw notFound();
    const logo = JSON.parse(body) as StoredLogo;
    return reply
      .header("content-type", logo.type)
      .header("content-security-policy", "default-src 'none'; sandbox")
      .header("cache-control", "public, max-age=300")
      .header("etag", `"${logo.sha256}"`)
      .send(Buffer.from(logo.data, "base64"));
  });

  app.post(
    "/v1/tokens/:token/logo",
    { bodyLimit: 400 * 1024, config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (req) => {
      const launcher = deps.config.TOKEN_LAUNCHER;
      if (!launcher) throw notFound("logos_unavailable");
      const token = tokenOf((req.params as { token: string }).token);
      const body = z
        .object({ image: z.string().min(1).max(Math.ceil(LOGO_MAX_BYTES / 3) * 4 + 4).regex(/^[A-Za-z0-9+/]+={0,2}$/), signature: z.string().regex(/^0x[0-9a-fA-F]{130,}$/).max(20_000) })
        .parse(req.body);
      const image = Buffer.from(body.image, "base64");
      const problem = logoProblem(image);
      if (problem) throw badRequest("logo_invalid", problem);
      const creator = await deps.chain.launchedTokenCreator(getAddress(launcher), token);
      if (!creator) throw forbidden("not_launched", "Only tokens made with LONGYU Launch can have a logo here.");
      const sha256 = createHash("sha256").update(image).digest("hex");
      const message = logoMessage(token, deps.config.CHAIN_ID, sha256);
      const signed = await deps.chain.verifySignature(creator, message, body.signature as Hex).catch(() => false);
      if (!signed) throw forbidden("not_creator", "The logo must be signed by the wallet that launched the token.");
      const info = imageInfo(image)!;
      const stored: StoredLogo = { type: info.type, data: image.toString("base64"), sha256, by: creator, at: new Date(Number(deps.clock.now()) * 1000).toISOString() };
      await deps.files.put(pathOf(token), JSON.stringify(stored));
      return { url: `${new URL(deps.config.PUBLIC_DATA_BASE_URL).origin}/v1/tokens/${token}/logo?v=${sha256.slice(0, 12)}` };
    },
  );
}
