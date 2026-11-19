/** Small adapters for outside services: captcha, X sign-in, ops notices, push, identity verification, file storage. */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, normalize, sep } from "node:path";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

// ------------------------------------------------------------------ captcha

export interface Captcha {
  verify(token: string, ip?: string): Promise<boolean>;
}

export const devCaptcha: Captcha = { verify: async (token) => token === "dev-pass" };

export function turnstile(secret: string, fetchImpl: typeof fetch = fetch): Captcha {
  return {
    async verify(token, ip) {
      const body = new URLSearchParams({ secret, response: token });
      if (ip) body.set("remoteip", ip);
      const res = await fetchImpl("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body, signal: AbortSignal.timeout(10_000) });
      if (!res.ok) return false;
      return ((await res.json()) as { success?: boolean }).success === true;
    },
  };
}

// ---------------------------------------------------------------- X sign-in

/** Sign-in with X: OAuth 2.0 authorization code with PKCE, the API being a confidential client. */
export interface XProvider {
  /** The X page where the person approves the sign-in. */
  authorizeUrl(p: { state: string; codeChallenge: string }): string;
  /**
   * Trades the code X sent back for the account. Each call is one billed read of the account at X,
   * unless it throws XNotBilled: then it stopped before that read.
   */
  exchange(p: { code: string; codeVerifier: string }): Promise<XAccount>;
}

/** An exchange that failed before the account was read: X bills nothing for it. */
export class XNotBilled extends Error {}

export interface XAccount {
  /** X's numeric user id: it never changes, unlike the username. */
  id: string;
  username: string;
  /** The profile picture, when the account has set one. */
  avatar: string | null;
}

const X_AVATAR = /^https:\/\/pbs\.twimg\.com\/profile_images\/[0-9]{1,20}\/[A-Za-z0-9_-]{1,64}\.(?:jpg|jpeg|png|gif|webp)$/;

/**
 * The profile picture X reports, kept only when it is an image on X's own image host; X's
 * placeholder for accounts without a picture is on another host and counts as none. X reports the
 * 48-pixel size, and the same picture exists at 400 pixels.
 */
export function xAvatar(url: unknown): string | null {
  if (typeof url !== "string" || !X_AVATAR.test(url)) return null;
  return url.replace(/_normal(\.[a-z]+)$/, "_400x400$1");
}

const X_ID = /^[1-9][0-9]{0,18}$/;
const X_USERNAME = /^[A-Za-z0-9_]{1,15}$/;
/** Only what users/me needs. Without offline.access X issues no refresh token. */
const X_SCOPE = "tweet.read users.read";
const X_MAX_BODY = 64 * 1024;

export const pkceChallenge = (verifier: string): string => createHash("sha256").update(verifier).digest("base64url");

export interface XOptions {
  clientId: string;
  clientSecret: string;
  /** Registered with X as a callback URL; X compares it exactly. */
  redirectUri: string;
  authorizeUrl?: string;
  apiBaseUrl?: string;
  timeoutMs?: number;
}

export function xOAuth(o: XOptions, fetchImpl: typeof fetch = fetch): XProvider {
  const api = (o.apiBaseUrl ?? "https://api.x.com").replace(/\/$/, "");
  const timeoutMs = o.timeoutMs ?? 10_000;
  const basic = Buffer.from(`${o.clientId}:${o.clientSecret}`).toString("base64");
  /** Reads a JSON object from X. Errors name the step and what went wrong, never the response or a credential. */
  const send = async (step: string, url: string, init: RequestInit): Promise<Record<string, unknown>> => {
    let status: number;
    let text: string;
    try {
      // Never follow a redirect with a credential attached. The timeout covers reading the body too.
      const res = await fetchImpl(url, { ...init, redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
      status = res.status;
      text = await res.text();
    } catch (e) {
      // A network error can carry request details; only its kind (such as TimeoutError) is passed on.
      throw new Error(`X ${step} failed: ${(e as Error).name}`);
    }
    if (status !== 200) throw new Error(`X ${step} failed: ${status}`);
    if (text.length > X_MAX_BODY) throw new Error(`X ${step} failed: response too large`);
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`X ${step} failed: not JSON`);
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) throw new Error(`X ${step} failed: not an object`);
    return body as Record<string, unknown>;
  };
  return {
    authorizeUrl({ state, codeChallenge }) {
      const params = {
        response_type: "code",
        client_id: o.clientId,
        redirect_uri: o.redirectUri,
        scope: X_SCOPE,
        state,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
      };
      // Spaces as %20, as X documents the scope list.
      const query = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
      return `${o.authorizeUrl ?? "https://x.com/i/oauth2/authorize"}?${query}`;
    },
    async exchange({ code, codeVerifier }) {
      const token = await send("token exchange", `${api}/2/oauth2/token`, {
        method: "POST",
        headers: { authorization: `Basic ${basic}`, "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams({ code, grant_type: "authorization_code", redirect_uri: o.redirectUri, code_verifier: codeVerifier }).toString(),
      }).catch((e: Error) => {
        throw new XNotBilled(e.message);
      });
      const accessToken = token.access_token;
      if (typeof token.token_type !== "string" || token.token_type.toLowerCase() !== "bearer") throw new XNotBilled("X token exchange failed: not a bearer token");
      if (typeof accessToken !== "string" || !/^[\x21-\x7e]{1,4096}$/.test(accessToken)) throw new XNotBilled("X token exchange failed: no access token");
      // The access token is used for this one read and then dropped: it is never stored or logged.
      const me = await send("user read", `${api}/2/users/me?user.fields=profile_image_url`, { headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" } });
      const data = me.data;
      if (typeof data !== "object" || data === null) throw new Error("X user read failed: no user");
      const { id, username, profile_image_url } = data as { id?: unknown; username?: unknown; profile_image_url?: unknown };
      if (typeof id !== "string" || !X_ID.test(id)) throw new Error("X user read failed: invalid id");
      if (typeof username !== "string" || !X_USERNAME.test(username)) throw new Error("X user read failed: invalid username");
      // A picture that does not pass is left out; it never fails the sign-in.
      return { id, username, avatar: xAvatar(profile_image_url) };
    },
  };
}

/** The provider when X is not configured: every sign-in is refused. */
export const noX: XProvider = {
  authorizeUrl() {
    throw new Error("X sign-in is not configured");
  },
  async exchange() {
    throw new XNotBilled("X sign-in is not configured");
  },
};

/**
 * Stands in for X in tests and local development: the "authorize" link goes straight back to the
 * API's callback, and a code "dev:<id>:<username>" signs in as that account. Anyone who can reach
 * the API can therefore be anyone, so it is refused in production (see loadConfig and createDeps).
 */
export class DevX implements XProvider {
  /** Accounts returned so far, oldest first (kept short). */
  readonly exchanges: XAccount[] = [];
  /** Profile pictures by X id, for the accounts that have one. */
  readonly avatars = new Map<string, string>();
  private readonly challenges = new Set<string>();
  constructor(private readonly redirectUri: string) {}

  authorizeUrl({ state, codeChallenge }: { state: string; codeChallenge: string }): string {
    this.challenges.add(codeChallenge);
    if (this.challenges.size > 1000) this.challenges.delete(this.challenges.values().next().value!);
    return `${this.redirectUri}?state=${encodeURIComponent(state)}&code=${encodeURIComponent("dev:1000001:dev_miner")}`;
  }

  async exchange({ code, codeVerifier }: { code: string; codeVerifier: string }): Promise<XAccount> {
    // As X does, refuse a verifier that does not match the challenge the authorize link carried.
    if (!this.challenges.delete(pkceChallenge(codeVerifier))) throw new XNotBilled("X token exchange failed: verifier mismatch");
    const [prefix, id, username, ...rest] = code.split(":");
    if (prefix !== "dev" || rest.length > 0 || !id || !username || !X_ID.test(id) || !X_USERNAME.test(username)) {
      throw new XNotBilled("X token exchange failed: invalid code");
    }
    const account = { id, username, avatar: xAvatar(this.avatars.get(id)) };
    this.exchanges.push(account);
    if (this.exchanges.length > 200) this.exchanges.shift();
    return account;
  }
}

// -------------------------------------------------------------- ops notices

/** Short notices for the operators (orders, payments). Nothing a miner needs is sent this way. */
export interface Notifier {
  notify(subject: string, text: string): Promise<void>;
}

/** Writes notices to the log, when no Telegram chat is configured. */
export const logNotifier: Notifier = {
  async notify(subject, text) {
    console.log(`[notice] ${subject}\n${text}`);
  },
};

/** Posts notices to a Telegram chat through a bot. Telegram caps a message at 4096 characters. */
export function telegramNotifier(botToken: string, chatId: string, fetchImpl: typeof fetch = fetch, baseUrl = "https://api.telegram.org"): Notifier {
  return {
    async notify(subject, text) {
      let res: Response;
      try {
        res = await fetchImpl(`${baseUrl}/bot${botToken}/sendMessage`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, text: `${subject}\n\n${text}`.slice(0, 4096), disable_web_page_preview: true }),
          signal: AbortSignal.timeout(10_000),
        });
      } catch (e) {
        // A network error can carry the request URL, which holds the bot token.
        throw new Error(`telegram notice failed: ${(e as Error).name}`);
      }
      if (!res.ok) throw new Error(`telegram notice failed: ${res.status}`);
    },
  };
}

// --------------------------------------------------------------------- push

export interface PushSender {
  send(messages: { to: string; title: string; body: string }[]): Promise<void>;
}

export const noopPush: PushSender = { send: async () => undefined };

/** Expo's free push service; batches of up to 100. */
export function expoPush(fetchImpl: typeof fetch = fetch): PushSender {
  return {
    async send(messages) {
      for (let i = 0; i < messages.length; i += 100) {
        await fetchImpl("https://exp.host/--/api/v2/push/send", {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify(messages.slice(i, i + 100)),
        });
      }
    },
  };
}

// ---------------------------------------------------- identity verification

/**
 * Generic webhook format for liveness / face de-duplication vendors. A vendor-specific adapter
 * (Sumsub, FaceTec, Persona...) translates its payload to this shape and signs it, or the vendor
 * is configured to call this endpoint through a small relay.
 */
export interface VerificationWebhook {
  reference: string;
  status: "approved" | "rejected";
  /** Stable identifier of the person (face de-duplication ID, document hash). */
  uniqueKey?: string;
}

export function signWebhook(secret: string, rawBody: string): string {
  return `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
}

export function verifyWebhookSignature(secret: string, rawBody: string, header: string | undefined): boolean {
  if (!header) return false;
  const expected = Buffer.from(signWebhook(secret, rawBody));
  const got = Buffer.from(header);
  return expected.length === got.length && timingSafeEqual(expected, got);
}

// ------------------------------------------------------------------ storage

/**
 * Where published data files live. Paths are content-addressed (see rootFilePath), so a file is
 * written once and never changes; the claim page and anyone else can cache it forever.
 */
export interface FileStore {
  /** Public URL a path will have once written. */
  url(path: string): string;
  /** Writes a public file and returns its public URL. */
  put(path: string, contents: string): Promise<string>;
  /** Reads a file back from the store, or null when it does not exist. */
  get(path: string): Promise<string | null>;
}

const PUBLIC_JSON = { contentType: "application/json; charset=utf-8", cacheControl: "public, max-age=31536000, immutable" };

function checkPath(path: string): string {
  if (!/^[a-z0-9][a-z0-9/_.-]*$/.test(path) || path.includes("..") || path.includes("//")) throw new Error(`invalid file path: ${path}`);
  return path;
}

const joinUrl = (base: string, path: string) => `${base.replace(/\/$/, "")}/${path}`;

/** Files on local disk, served by the API under /data. Development and tests only. */
export function localFileStore(dir: string, publicBaseUrl: string): FileStore {
  const full = (path: string) => {
    const f = normalize(join(dir, checkPath(path)));
    if (!f.startsWith(normalize(dir) + sep)) throw new Error(`invalid file path: ${path}`);
    return f;
  };
  return {
    url: (path) => joinUrl(publicBaseUrl, checkPath(path)),
    async put(path, contents) {
      const f = full(path);
      mkdirSync(dirname(f), { recursive: true });
      // Write then rename, so a reader never sees half a file.
      writeFileSync(`${f}.tmp`, contents);
      renameSync(`${f}.tmp`, f);
      return joinUrl(publicBaseUrl, path);
    },
    async get(path) {
      const f = full(path);
      return existsSync(f) ? readFileSync(f, "utf8") : null;
    },
  };
}

/** The part of the S3 client the store uses, so tests can substitute it. */
export interface S3Sender {
  send(command: PutObjectCommand | GetObjectCommand): Promise<unknown>;
}

export interface S3Options {
  bucket: string;
  /** Region; "auto" for a Railway bucket or Cloudflare R2. */
  region: string;
  /** S3-compatible endpoint (a Railway bucket's ENDPOINT, or https://<account>.r2.cloudflarestorage.com). Omit for AWS S3. */
  endpoint?: string;
  /** Explicit keys (Railway, R2). Omit on AWS to use the default credential chain (instance role, env). */
  accessKeyId?: string;
  secretAccessKey?: string;
}

export function s3Client(o: S3Options): S3Client {
  return new S3Client({
    region: o.region,
    ...(o.endpoint
      ? {
          endpoint: o.endpoint,
          forcePathStyle: true,
          // S3-compatible stores do not all accept the SDK's default flexible checksums.
          requestChecksumCalculation: "WHEN_REQUIRED" as const,
          responseChecksumValidation: "WHEN_REQUIRED" as const,
        }
      : {}),
    ...(o.accessKeyId && o.secretAccessKey ? { credentials: { accessKeyId: o.accessKeyId, secretAccessKey: o.secretAccessKey } } : {}),
    maxAttempts: 5,
  });
}

/**
 * A Railway bucket, Cloudflare R2 or AWS S3. publicBaseUrl is where anyone can read the files: this
 * API's own /data address for a private bucket (Railway), or the bucket's public address (R2 custom
 * domain, S3 behind CloudFront) with a CORS rule allowing GET from any origin.
 * scripts/storage-check.ts checks it.
 */
export function s3FileStore(client: S3Sender, bucket: string, publicBaseUrl: string): FileStore {
  return {
    url: (path) => joinUrl(publicBaseUrl, checkPath(path)),
    async put(path, contents) {
      await client.send(new PutObjectCommand({
        Bucket: bucket,
        Key: checkPath(path),
        Body: contents,
        ContentType: PUBLIC_JSON.contentType,
        CacheControl: PUBLIC_JSON.cacheControl,
      }));
      return joinUrl(publicBaseUrl, path);
    },
    async get(path) {
      try {
        const res = (await client.send(new GetObjectCommand({ Bucket: bucket, Key: checkPath(path) }))) as {
          Body?: { transformToString(encoding?: string): Promise<string> };
        };
        return res.Body ? await res.Body.transformToString("utf-8") : null;
      } catch (e) {
        const err = e as { name?: string; $metadata?: { httpStatusCode?: number } };
        if (err.name === "NoSuchKey" || err.$metadata?.httpStatusCode === 404) return null;
        throw e;
      }
    },
  };
}
