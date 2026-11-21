/**
 * LONGYU testnet on Railway, as infrastructure as code (Railway CLI 5.42.1 or newer):
 *
 *   railway link            # once, to the Railway project
 *   railway config plan     # shows what would change
 *   railway config apply    # applies it after a confirmation
 *
 * Code reaches Railway with `railway up --service <name>` from the repository root (each service
 * builds its Dockerfile from the uploaded folder). Set REPOSITORY to build from GitHub instead.
 *
 * Services: Postgres, the API (which also runs the background jobs), the signer (which holds the
 * API's three signing keys), the chain (op-geth, op-node, op-batcher, op-proposer), the public RPC
 * gateway, LONGYU Scan (the explorer), the web pages, LONGYU MINE for browsers and OpenZeppelin Monitor. Every value marked preserve() is a secret or a
 * deployment-specific setting entered once in Railway (dashboard or `railway variables --set`); it never
 * lives in this repository. A variable Railway holds but this file does not declare would be deleted
 * on apply, which is why optional settings are declared too.
 */
import { bucket, defineRailway, github, postgres, preserve, project, service, volume } from "railway/iac";

/** A GitHub repository to build from ("owner/name"), or "" to deploy uploads with `railway up`. */
export const REPOSITORY: string = "";
export const BRANCH = "main";
const L2_CHAIN_ID = "668801";
/** The address wallets use: the `rpc` service behind Cloudflare. */
const PUBLIC_RPC_URL = "https://rpc-testnet.longyu.network";
/** LONGYU Scan behind Cloudflare. */
const PUBLIC_EXPLORER_URL = "https://scan-testnet.longyu.network";
/** The landing page: the `web` service's second name, behind Cloudflare. */
const PUBLIC_SITE_URL = "https://longyu.network";
/** The pages of the `web` service behind Cloudflare. */
const PUBLIC_WEB_URL = "https://testnet.longyu.network";
/** The API behind Cloudflare. */
const PUBLIC_API_URL = "https://api-testnet.longyu.network";
/** LONGYU MINE in a browser: the `mine` service behind Cloudflare. */
const PUBLIC_MINE_URL = "https://mine-testnet.longyu.network";

const source = REPOSITORY ? github(REPOSITORY, { branch: BRANCH }) : undefined;
/** Where Railway placed the project's volumes; moving a volume is destructive, so it is pinned. */
const VOLUME_REGION = "us-east4-eqdc4a";
const dockerfile = (path: string, watch: string[]) => ({ builder: "DOCKERFILE" as const, dockerfilePath: path, watchPatterns: watch });

export default defineRailway(() => {
  const db = postgres("postgres");
  // The daily data files. A Railway bucket is private, so the API serves them at /data/roots/.
  // Same coast as the services; a bucket's region cannot be changed later.
  const data = bucket("longyu-data", { region: "iad" });

  // ------------------------------------------------------------------ chain
  // A full node with the path state scheme. 100 GB to start; Railway volumes grow online (Pro plan).
  const gethData = volume("op-geth-data", { sizeMB: 100_000, region: VOLUME_REGION });
  const geth = service("op-geth", {
    source,
    build: dockerfile("chain/railway/op-geth/Dockerfile", ["chain/railway/op-geth/**", "chain/testnet/genesis.json"]),
    deploy: { restartPolicyType: "ALWAYS" },
    // Never given a public domain: the public reaches the chain through the `rpc` gateway below.
    volumeMounts: { "/db": gethData },
    env: {
      L2_CHAIN_ID,
      GETH_CACHE_MB: "4096",
      GS_SEQUENCER_ADDRESS: preserve(),
      ENGINE_JWT_SECRET: preserve(),
      // Set only to relaunch the testnet from a new genesis: its SHA-256, which erases the old chain once.
      RESET_CHAIN_FOR_GENESIS: preserve(),
    },
  });

  const node = service("op-node", {
    source,
    build: dockerfile("chain/railway/op-node/Dockerfile", ["chain/railway/op-node/**", "chain/testnet/rollup.json"]),
    deploy: { restartPolicyType: "ALWAYS" },
    env: {
      L1_RPC_URL: preserve(),
      L1_RPC_KIND: preserve(),
      L1_RPC_RATE_LIMIT: preserve(),
      L2_ENGINE_HOST: geth.env.RAILWAY_PRIVATE_DOMAIN,
      ENGINE_JWT_SECRET: geth.env.ENGINE_JWT_SECRET,
      GS_SEQUENCER_PRIVATE_KEY: preserve(),
    },
  });

  const batcher = service("op-batcher", {
    source,
    build: dockerfile("chain/railway/op-batcher/Dockerfile", ["chain/railway/op-batcher/**"]),
    deploy: { restartPolicyType: "ALWAYS" },
    env: {
      L1_RPC_URL: node.env.L1_RPC_URL,
      L2_RPC_HOST: geth.env.RAILWAY_PRIVATE_DOMAIN,
      ROLLUP_RPC_HOST: node.env.RAILWAY_PRIVATE_DOMAIN,
      // Post every 300 BSC blocks (about 2 minutes 15 seconds): cheap, and well inside the 1,200-block channel timeout.
      MAX_CHANNEL_DURATION: "300",
      GS_BATCHER_PRIVATE_KEY: preserve(),
    },
  });

  const proposer = service("op-proposer", {
    source,
    build: dockerfile("chain/railway/op-proposer/Dockerfile", ["chain/railway/op-proposer/**"]),
    deploy: { restartPolicyType: "ALWAYS" },
    env: {
      L1_RPC_URL: node.env.L1_RPC_URL,
      ROLLUP_RPC_HOST: node.env.RAILWAY_PRIVATE_DOMAIN,
      L2OO_ADDRESS: preserve(),
      GS_PROPOSER_PRIVATE_KEY: preserve(),
    },
  });

  // ------------------------------------------------------------ public RPC
  // The address wallets and apps use. It serves a fixed list of read and send methods, limits each
  // client address, and passes the rest to op-geth over the private network. Port 8080. Reached at
  // rpc-testnet.longyu.network, behind Cloudflare; with ORIGIN_SECRET set, its Railway domain answers 403.
  const rpc = service("rpc", {
    source,
    build: dockerfile("chain/railway/rpc/Dockerfile", ["chain/railway/rpc/**"]),
    healthcheck: "/health",
    healthcheckTimeout: 60,
    deploy: { restartPolicyType: "ALWAYS" },
    env: {
      PORT: "8080",
      UPSTREAM_URL: "http://${{op-geth.RAILWAY_PRIVATE_DOMAIN}}:8545",
      CHAIN_ID: L2_CHAIN_ID,
      // Set only behind Cloudflare: then requests without Cloudflare's secret header are refused.
      ORIGIN_SECRET: preserve(),
      // Limits; each has a default in chain/railway/rpc/src/config.ts.
      RATE_PER_SECOND: preserve(),
      RATE_BURST: preserve(),
      MAX_BATCH: preserve(),
      MAX_BODY_BYTES: preserve(),
      MAX_RESPONSE_BYTES: preserve(),
      MAX_LOG_RANGE: preserve(),
      MAX_IN_FLIGHT: preserve(),
      MAX_IN_FLIGHT_PER_CLIENT: preserve(),
      UPSTREAM_TIMEOUT_MS: preserve(),
      ACCESS_LOG: preserve(),
    },
  });

  // ----------------------------------------------------------------- signer
  // Holds the publisher, relayer, faucet-voucher and watch keys, and signs only what
  // apps/signer/src/policy.ts allows: proposeRoot, claimMany, vetoPendingRoot and pause, and drip on the
  // two contracts below, and faucet vouchers, each within limits. The API holds no key; it asks this service over the private network, with the token.
  // Never give this service a public domain. Seal the four keys in the dashboard once they are set.
  // The limits keep the defaults in apps/signer/src/config.ts. Port 8080.
  const signer = service("signer", {
    source,
    build: dockerfile("apps/signer/Dockerfile", ["apps/signer/**", "packages/abis/**", "package.json", "package-lock.json"]),
    healthcheck: "/health",
    healthcheckTimeout: 60,
    deploy: { restartPolicyType: "ALWAYS" },
    env: {
      PORT: "8080",
      CHAIN_ID: L2_CHAIN_ID,
      SIGNER_TOKEN: preserve(),
      PUBLISHER_KEY: preserve(),
      RELAYER_KEY: preserve(),
      FAUCET_SIGNER_KEY: preserve(),
      // The automatic watch: a key with only the distributor's guardian role (veto and pause).
      WATCH_KEY: preserve(),
      // Until the mining contracts exist it starts without these and signs nothing.
      DISTRIBUTOR_ADDRESS: preserve(),
      FAUCET_ADDRESS: preserve(),
    },
  });

  // -------------------------------------------------------------------- API
  const api = service("api", {
    source,
    build: dockerfile("apps/api/Dockerfile", ["apps/api/**", "packages/**", "package.json", "package-lock.json"]),
    healthcheck: "/health",
    healthcheckTimeout: 60,
    deploy: { restartPolicyType: "ON_FAILURE", restartPolicyMaxRetries: 10 },
    // Port 8080. Add api-testnet.longyu.network (behind Cloudflare) in the dashboard.
    env: {
      NODE_ENV: "production",
      PORT: "8080",
      RUN_JOBS: "true",
      DATABASE_URL: db.env.DATABASE_URL,
      // Railway resolves ${{...}} references inside values: op-geth over the private network.
      RPC_URL: "http://${{op-geth.RAILWAY_PRIVATE_DOMAIN}}:8545",
      CHAIN_ID: L2_CHAIN_ID,
      PUBLIC_RPC_URL,
      EXPLORER_URL: "https://scan-testnet.longyu.network",
      CHAIN_NAME: "LONGYU Testnet",
      NATIVE_SYMBOL: "tBNB",
      FAUCET_DRIP_WEI: "200000000000000",
      SIWE_DOMAIN: "longyu.network",
      // The origin is public on Railway: only requests carrying Cloudflare's secret header are served.
      TRUST_PROXY: "false",
      REQUIRE_COUNTRY: "true",
      // The pages that may call the API from a browser: the claim page and LONGYU MINE's web build.
      WEB_ORIGINS: `${PUBLIC_WEB_URL},${PUBLIC_MINE_URL}`,
      // Mining in a browser, which passes a human check before every session. "false" turns it off
      // at once (browsers are then refused; the Android app is unaffected).
      WEB_MINING: "true",
      // Where sign-in with X returns a browser to.
      WEB_AUTH_REDIRECT: `${PUBLIC_MINE_URL}/`,
      // The invite bonus: an invited account that mines raises its inviter's weight that day.
      // "false" ends it from the next settlement on.
      INVITE_REWARD: "true",
      STORAGE_REGION: "auto",
      // The bucket is private and the API serves its files: this is the API's own public address
      // plus /data (the API refuses to start otherwise). It is written on-chain with every root.
      STORAGE_PUBLIC_READ: "false",
      PUBLIC_DATA_BASE_URL: "https://api-testnet.longyu.network/data",
      // The signing keys are in the signer service; the API holds only the token that asks it.
      SIGNER_URL: "http://${{signer.RAILWAY_PRIVATE_DOMAIN}}:8080",
      SIGNER_TOKEN: signer.env.SIGNER_TOKEN,
      // Sign-in with X returns to the app by its own link.
      APP_AUTH_REDIRECT: "longyumine://auth",
      // Secrets and deployment-specific settings.
      ORIGIN_SECRET: preserve(),
      JWT_SECRET: preserve(),
      PULSE_SECRET: preserve(),
      ADMIN_KEYS: preserve(),
      MONITOR_KEY_SHA256: preserve(),
      // The same two addresses as on the signer: the API refuses to start if they differ.
      DISTRIBUTOR_ADDRESS: preserve(),
      FAUCET_ADDRESS: preserve(),
      TURNSTILE_SECRET: preserve(),
      // The phones' work at the start of a session (modules/phone-work.ts): the output oracle on BSC
      // testnet (chain/testnet/l1-deployments.json), read through L1_RPC_URL. Browsers and the Android
      // app (1.0.4 and later, published 21 November 2026) must do it; earlier APKs must be updated.
      L1_OUTPUT_ORACLE: "0x2dC53f20F511Bf079167Ef013d6107787E620fE3",
      WORK_BITS: "15",
      PHONE_WORK_PLATFORMS: "web,android",
      // The X developer app: its OAuth 2.0 client, and this API's /v1/auth/x/callback as registered there.
      X_CLIENT_ID: preserve(),
      X_CLIENT_SECRET: preserve(),
      X_REDIRECT_URI: "https://api-testnet.longyu.network/v1/auth/x/callback",
      // X bills each completed sign-in (about $0.01): past this many in one UTC day the API stops
      // calling X until the next day. 5000 is at most about $50 a day.
      X_DAILY_SIGNIN_LIMIT: "5000",
      // Order and payment notices (both or neither).
      TELEGRAM_BOT_TOKEN: preserve(),
      TELEGRAM_CHAT_ID: preserve(),
      VERIFICATION_WEBHOOK_SECRET: preserve(),
      STORAGE_BUCKET: "${{longyu-data.BUCKET}}",
      STORAGE_ENDPOINT: "${{longyu-data.ENDPOINT}}",
      STORAGE_ACCESS_KEY_ID: "${{longyu-data.ACCESS_KEY_ID}}",
      STORAGE_SECRET_ACCESS_KEY: "${{longyu-data.SECRET_ACCESS_KEY}}",
      GOOGLE_SERVICE_ACCOUNT_JSON: preserve(),
      ANDROID_PACKAGE: preserve(),
      ANDROID_SIGNING_CERT_SHA256: preserve(),
      APPLE_TEAM_ID: preserve(),
      APPLE_BUNDLE_ID: preserve(),
      BSC_RPC_URL: preserve(),
      BABT_ADDRESS: preserve(),
      BLOCKED_COUNTRIES: preserve(),
      ACCESS_TOKEN_TTL_SECONDS: preserve(),
      ALERT_MIN_GAS_BALANCE: preserve(),
      // The batcher's and the proposer's gas on BSC, read by the health check.
      L1_RPC_URL: preserve(),
      L1_WATCH: preserve(),
      L1_MIN_GAS_BALANCE: preserve(),
      RISK_IP_CLUSTER_LIMIT: preserve(),
      RISK_ATTESTATION_FAILURES: preserve(),
      RISK_TIMING_STDDEV_SECONDS: preserve(),
      SWEEP_MIN_ACCOUNTS: preserve(),
      SWEEP_WINDOW_DAYS: preserve(),
      SWEEP_ALLOWLIST: preserve(),
      PAYMENT_ROUTER_ADDRESS: preserve(),
      PAYMENT_START_BLOCK: preserve(),
      TREASURY_ADDRESS: preserve(),
      PAYMENT_RPC_URL: preserve(),
      PAYMENT_CHAIN_ID: preserve(),
      PAYMENT_TOKENS: preserve(),
      PAYMENT_FINALITY: preserve(),
      BOOST_PLANS: preserve(),
      PAY_PAGE_URL: "https://testnet.longyu.network/pay.html",
      // Not read by the API. Declared so that an apply leaves the variable as it is.
      OTP_PEPPER: preserve(),
    },
  });

  // ------------------------------------------------------------ explorer
  // LONGYU Scan: indexer and website in one service, port 4000. It keeps its tables in its own
  // database on the same Postgres server, created on first start. An index belongs to one genesis:
  // a relaunch of the chain gets a new database name. Add scan-testnet.longyu.network (behind
  // Cloudflare) in the dashboard.
  const explorer = service("explorer", {
    source,
    build: dockerfile("apps/explorer/Dockerfile", ["apps/explorer/**", "packages/abis/**", "package.json", "package-lock.json"]),
    healthcheck: "/health",
    healthcheckTimeout: 120,
    deploy: { restartPolicyType: "ON_FAILURE", restartPolicyMaxRetries: 10 },
    env: {
      NODE_ENV: "production",
      PORT: "4000",
      DATABASE_URL: db.env.DATABASE_URL,
      EXPLORER_DATABASE: "explorer_2",
      // Blocks without transactions are deleted after a day; the node still serves them.
      PRUNE_EMPTY_AFTER_HOURS: "24",
      RPC_URL: "http://${{op-geth.RAILWAY_PRIVATE_DOMAIN}}:8545",
      CHAIN_ID: L2_CHAIN_ID,
      CHAIN_NAME: "LONGYU Testnet",
      NATIVE_SYMBOL: "tBNB",
      PUBLIC_RPC_URL,
      L1_EXPLORER_URL: "https://testnet.bscscan.com",
      BRIDGE_URL: `${PUBLIC_WEB_URL}/bridge.html`,
      SWAP_URL: `${PUBLIC_WEB_URL}/swap.html`,
      // The menu and the footer link to each of these that is set; GITHUB_URL once the repository is public.
      WEBSITE_URL: PUBLIC_SITE_URL,
      MINE_URL: PUBLIC_MINE_URL,
      DEVELOPERS_URL: `${PUBLIC_SITE_URL}/developers`,
      GITHUB_URL: preserve(),
      // Contract verification. "false" stops new verifications; sources verified before stay on their pages.
      VERIFICATION: "true",
      // Set only behind Cloudflare: then requests without Cloudflare's secret header are refused, and
      // rate limits apply per visitor. Railway's own proxy hides visitors, so TRUST_PROXY cannot do it.
      ORIGIN_SECRET: preserve(),
      TRUST_PROXY: preserve(),
      KNOWN_ADDRESSES: preserve(),
    },
  });

  // -------------------------------------------------------------------- web
  // The claim, pay, bridge, swap and Safe pages as fixed files, port 8080. Their settings are fixed into
  // the files when the image builds, so a changed value takes effect on the next deploy. All are public
  // values; the bridge addresses are the proxies in chain/testnet/l1-deployments.json. The pay page
  // stays closed (PAGES): the testnet takes no payments, so the API never issues an order to pay.
  // The Safe page is for the multisig signers: no page links to it. Reached at testnet.longyu.network.
  // The bare domain is a second name of this service and serves the landing page, which is built from
  // the same settings and links to the pages, the miner and the explorer. www only sends its visitors
  // to the bare domain.
  const web = service("web", {
    source,
    build: dockerfile("apps/web/Dockerfile", ["apps/web/**", "packages/abis/**", "package.json", "package-lock.json"]),
    healthcheck: "/health",
    healthcheckTimeout: 60,
    deploy: { restartPolicyType: "ON_FAILURE", restartPolicyMaxRetries: 10 },
    env: {
      PORT: "8080",
      PAGES: "claim,bridge,swap,safe",
      LANDING_HOSTS: "longyu.network",
      REDIRECT_HOSTS: "www.longyu.network",
      REDIRECT_TO: PUBLIC_SITE_URL,
      SITE_URL: PUBLIC_SITE_URL,
      APP_URL: PUBLIC_WEB_URL,
      // The landing page links to each of these that is set; GITHUB_URL once the repository is public.
      GITHUB_URL: preserve(),
      X_URL: preserve(),
      L1_PORTAL: "0xB1ba2E8af7137c607987F1c8d89c0f8b0c7D2623",
      L1_OUTPUT_ORACLE: "0x2dC53f20F511Bf079167Ef013d6107787E620fE3",
      L1_STANDARD_BRIDGE: "0xbd5585161c5E9797D2102e775D9C5439aB51279a",
      // tLONG on BSC testnet, and its bridged copy on LONGYU.
      L1_TOKEN: "0x88d5B1946BaB654e31Fbf0bcc3D022e995aB129C",
      L2_TOKEN: "0xF4769160D6dc78F66f61F0eA1638E65d43610163",
      // LONGYU Swap on LONGYU (chain/testnet/README.md).
      SWAP_ROUTER: "0xed3Eb7fe322424C14cc356Ab182021cAb8dCf01A",
      SWAP_FACTORY: "0xfE5372cA129113bf12EC70D1EE4A7cBB14f172B0",
      L2_RPC_URL: PUBLIC_RPC_URL,
      EXPLORER_URL: PUBLIC_EXPLORER_URL,
      // A keyed BSC testnet endpoint for the page's reads; the default is a free public one.
      L1_RPC_URL: preserve(),
      // The claim page: the API behind Cloudflare, and the mining contracts of 19 November 2026 with
      // the distributor that replaced the first one on 21 November 2026 (chain/testnet/README.md). REWARD_TOKEN is the bridged tLONG, the same as L2_TOKEN.
      API_URL: "https://api-testnet.longyu.network",
      CHAIN_ID: L2_CHAIN_ID,
      CHAIN_NAME: "LONGYU Testnet",
      NATIVE_SYMBOL: "tBNB",
      RPC_URL: PUBLIC_RPC_URL,
      REWARD_TOKEN: "0xF4769160D6dc78F66f61F0eA1638E65d43610163",
      DISTRIBUTOR: "0x35ACf3fDc2592E218FAb449697b499b5d156D886",
      // The claim page links to where rewards are earned, and so does the landing page.
      MINE_URL: PUBLIC_MINE_URL,
    },
  });

  // ------------------------------------------------------------------- mine
  // LONGYU MINE for browsers (phones without the Android app, computers, Apple devices): the app's
  // web build as fixed files, and the Android app's download at /download/android. Port 8080. The
  // two public settings are fixed into the files when the image builds and also tell the server
  // which API the page may call. The APK is not in the repository: copy the current one into
  // apps/mobile/site/downloads/ before `railway up` (apps/mobile/BUILD.md). Reached at
  // mine-testnet.longyu.network, behind Cloudflare.
  const mine = service("mine", {
    source,
    build: dockerfile("apps/mobile/site/Dockerfile", ["apps/mobile/**"]),
    healthcheck: "/health",
    healthcheckTimeout: 60,
    deploy: { restartPolicyType: "ON_FAILURE", restartPolicyMaxRetries: 10 },
    env: {
      PORT: "8080",
      APP_VARIANT: "testnet",
      EXPO_PUBLIC_API_URL: PUBLIC_API_URL,
      // Cloudflare Turnstile's site key (public; the secret is the API's TURNSTILE_SECRET).
      EXPO_PUBLIC_TURNSTILE_SITE_KEY: "0x4AAAAAAGIOJPdO99oNB7bQ",
      // Set only behind Cloudflare: then requests without Cloudflare's secret header are refused.
      ORIGIN_SECRET: preserve(),
    },
  });

  // ------------------------------------------------------------- monitoring
  const monitorData = volume("monitor-data", { sizeMB: 1_000, region: VOLUME_REGION });
  const monitor = service("monitor", {
    source,
    build: dockerfile("ops/monitor/Dockerfile", ["ops/monitor/**", "packages/abis/src/**"]),
    deploy: { restartPolicyType: "ALWAYS" },
    volumeMounts: { "/app/data": monitorData },
    env: {
      LONGYU_TESTNET_RPC_URL: "http://${{op-geth.RAILWAY_PRIVATE_DOMAIN}}:8545",
      BSC_TESTNET_RPC_URL: preserve(),
      BSC_RPC_URL: preserve(),
      // Alerts go to the Telegram chat named in ops/monitor/deployment.json.
      TELEGRAM_BOT_TOKEN: preserve(),
      // Not read by the monitor. Declared so that an apply leaves the variable as it is.
      RESEND_API_KEY: preserve(),
    },
  });

  return project("longyu-testnet", {
    resources: [db, data, gethData, geth, node, batcher, proposer, rpc, signer, api, explorer, web, mine, monitorData, monitor],
  });
});
