/**
 * Checks the data-file bucket and its public address before the first root is posted.
 *
 * On Railway, with the API's own settings (the bucket is private and the running API serves it):
 *   railway run --service api -- npm run storage:check
 *
 * Elsewhere:
 *   STORAGE_BUCKET=... STORAGE_ENDPOINT=... STORAGE_ACCESS_KEY_ID=... STORAGE_SECRET_ACCESS_KEY=... \
 *   PUBLIC_DATA_BASE_URL=https://api.<domain>/data npm run storage:check
 *
 * 1. Writes a probe file named like a root file (for a day that never comes), reads it back through
 *    the S3 API, then through the public URL as a browser on another site would.
 * 2. Checks that a private bucket answers nobody without keys, then deletes the probe.
 * For a bucket with its own public address (STORAGE_PUBLIC_READ=true), APPLY_CORS=true first applies
 * a CORS rule (GET/HEAD from any origin).
 * Exits non-zero with the reason if anything is wrong. Root URLs are permanent once on-chain,
 * so run this again after any change to the bucket, domain or keys.
 */
import { randomBytes } from "node:crypto";
import { DeleteObjectCommand, PutBucketCorsCommand } from "@aws-sdk/client-s3";
import { s3Client, s3FileStore } from "../src/services/external.ts";

const need = (name: string): string => {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`${name} is required`);
  return v;
};
const opt = (name: string): string | undefined => process.env[name]?.trim() || undefined;

const bucket = need("STORAGE_BUCKET");
const base = need("PUBLIC_DATA_BASE_URL");
const client = s3Client({
  bucket,
  region: opt("STORAGE_REGION") ?? "auto",
  endpoint: opt("STORAGE_ENDPOINT"),
  accessKeyId: opt("STORAGE_ACCESS_KEY_ID"),
  secretAccessKey: opt("STORAGE_SECRET_ACCESS_KEY"),
});
const store = s3FileStore(client, bucket, base);
const publicRead = ["true", "1"].includes(opt("STORAGE_PUBLIC_READ") ?? "");
const problems: string[] = [];

if (new URL(base).protocol !== "https:") console.warn("warning: PUBLIC_DATA_BASE_URL is not https; production refuses it");

if (publicRead && opt("APPLY_CORS") === "true") {
  await client.send(new PutBucketCorsCommand({
    Bucket: bucket,
    CORSConfiguration: {
      CORSRules: [{ AllowedOrigins: ["*"], AllowedMethods: ["GET", "HEAD"], AllowedHeaders: ["*"], MaxAgeSeconds: 86_400 }],
    },
  }));
  console.log("CORS rule applied: GET and HEAD from any origin");
}

// The API serves only root-file names, so the probe has one: day 9,999,999 is 27,000 years away.
const path = `roots/day-9999999-${randomBytes(8).toString("hex")}.json`;
const body = JSON.stringify({ probe: path, at: new Date().toISOString() });
const url = await store.put(path, body);
console.log(`wrote ${path}`);
try {
  if ((await store.get(path)) !== body) problems.push("reading the probe back through the S3 API returned different bytes");
  const origin = "https://claim.example";
  const res = await fetch(url, { headers: { origin } });
  if (res.status !== 200) {
    problems.push(publicRead
      ? `public URL ${url} returned HTTP ${res.status}; enable public access (a custom domain) for the bucket`
      : `public URL ${url} returned HTTP ${res.status}; the API must be running at that address, with PUBLIC_DATA_BASE_URL set to its own address plus /data`);
  } else {
    if ((await res.text()) !== body) problems.push("public URL served different bytes than were written");
    const allow = res.headers.get("access-control-allow-origin");
    if (allow !== "*" && allow !== origin) problems.push(`no CORS header on the public URL (got ${allow ?? "none"}); browsers cannot read the files`);
    if (!res.headers.get("content-type")?.startsWith("application/json")) problems.push(`content-type is ${res.headers.get("content-type")}`);
  }
  const endpoint = opt("STORAGE_ENDPOINT");
  if (!publicRead && endpoint) {
    const direct = await fetch(`${endpoint.replace(/\/+$/, "")}/${bucket}/${path}`);
    if (direct.status === 200) problems.push("the bucket answered a request without keys; it was expected to be private");
  }
} finally {
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: path }));
}

if (problems.length) {
  console.error("storage check FAILED:");
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`storage check passed: ${base} serves data files to browsers`);
