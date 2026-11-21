# LONGYU API reference (v1)

All amounts are wei, as decimal strings. All times are unix seconds, as decimal strings. Errors look like `{"error":"code","message":"..."}`.

## Account

| Method and path | Auth | Body | Result |
|---|---|---|---|
| `POST /v1/auth/x/start` | – (user for `wallet-change`) | `appChallenge, purpose` (`sign-in` or `wallet-change`), `client?` (`app`, the default, or `web`) | `authorizeUrl`: the X page to open. The state behind it lasts 10 minutes. A `wallet-change` is refused with `wallet_change_cooldown` (403) while the wallet cannot change yet |
| `GET /v1/auth/x/callback` | – | query `state` and `code`, or `error` | Where X sends the browser back. Redirects (302) to the app link with `?ticket=...`, or with `?error=` and one of `denied` (the person said no at X), `failed` (X did not confirm the account), `paused` (the day's ceiling on sign-ins is reached), `too_many` (this client reached its own ceiling for the day) or `too_soon` (this X account signed in a moment ago). A flow started with `client: "web"` goes to `WEB_AUTH_REDIRECT` instead, with `#ticket=...` or `#error=...` after the address, where no server sees it. An unknown, expired or used state gets a plain 400 page |
| `POST /v1/auth/x/finish` | – | `ticket, appVerifier, installId, platform` (`ios`, `android` or `web`), `referralCode?` | `accessToken, refreshToken, newUser`. `referralCode` counts on the first sign-in only |
| `POST /v1/auth/refresh` | – | `refreshToken` | New token pair; reusing an old refresh token ends the session |
| `POST /v1/auth/logout` | – | `refreshToken` | Ends the session |
| `GET /v1/me` | user | – | Profile (`xUsername`, `avatarUrl`, `handle`, `createdAt`), `miningDays`, `invites`, tier, wallet; `deviceAttested` turns false 30 days after the last device check. `avatarUrl` is the X profile picture, an address on `pbs.twimg.com`, or null |

Sign-in is with X only (OAuth 2.0 authorization code with PKCE; the API holds the client secret).

1. The app makes a random `appVerifier` (43 to 128 characters from `A-Z a-z 0-9 - . _ ~`), keeps it, and sends `appChallenge`, the base64url SHA-256 of it (43 characters), to `start`.
2. The app opens `authorizeUrl` in the system browser. After the person approves, X returns to `callback`, which redirects to the app link (`APP_AUTH_REDIRECT`, by default `longyumine://auth`).
3. The app sends the `ticket` from that link with its `appVerifier` to `finish`. A ticket lasts 5 minutes and works once, whether or not the attempt passes.

**In a browser** (LONGYU MINE on the web) the page sends `client: "web"` to `start` and goes to `authorizeUrl` itself; `callback` sends it back to `WEB_AUTH_REDIRECT`, and it sends the ticket to `finish` with `platform: "web"`. A ticket from a web flow works only with `platform: "web"`, and a ticket from the app only without it. While `WEB_MINING` is off, every web step answers `web_mining_unavailable` (403).

The account is tied to the X account's numeric id; the username and the profile picture are refreshed at each sign-in. Errors: `ticket_invalid` (403), `sign_in_unavailable` (503), `region_blocked` and `region_unknown` (403).

## Device and wallet

| Method and path | Auth | Body | Result |
|---|---|---|---|
| `POST /v1/device/challenge` | user | – | `challengeId, nonce` |
| `POST /v1/device/attest` | user | `challengeId, token, keyId?` | `attested`; moves a new account to T1. From a browser, `token` is the human check's answer: a browser cannot prove its device |
| `POST /v1/wallet/challenge` | user | – | SIWE `nonce, domain, chainId` |
| `POST /v1/wallet/link` | user | `message, signature, reauthTicket?, appVerifier?` | Links the first wallet. Changing it waits out a 7-day cooldown and needs a fresh sign-in with X: `reauthTicket` and `appVerifier` from a `wallet-change` flow this user started, approved as the same X account. Errors: `reauth_required`, `reauth_invalid` (403) |
| `POST /v1/push/register` | user | `token` (Expo push token) | – |

## Mining and rewards

| Method and path | Auth | Body | Result |
|---|---|---|---|
| `POST /v1/mining/challenge` | user | – | `challengeId, nonce, pulseRequired, work`. The human check is decided once per user per day, and is always required in a browser; a new challenge cancels the previous one. `work.bits` is the puzzle's size; `work.output` (`index, l2Block`, or null when BSC cannot be read) is the state root to rebuild |
| `POST /v1/mining/start` | user | `challengeId, attestationToken, captchaToken?, work?` | `startedAt, endsAt, creditedDay`. A phone must send `attestationToken` (`attestation_required`, 400); a browser sends `captchaToken` and no attestation. `work`: `counter` (the puzzle's answer) and `parts` (`stateRoot, messagePasserRoot, blockHash` of the state root's block). Required of the devices in `PHONE_WORK_PLATFORMS` (`work_required`, 403); a wrong answer is refused (`work_invalid`, `chain_check_failed`, 403) |
| `POST /v1/mining/check` | user | `index, parts` | `match, counted, checks`. A state root rebuilt during a running session (`no_active_session`, 409); one of the last eight posted (`output_too_old`, `output_unknown`, 400). Each newer root counts once; parts that differ from what the API's own node rebuilds are refused (`chain_check_failed`, 403) |
| `GET /v1/mining/status` | user | – | Session, streak, tier, estimated rate, `balances` (null until the account has a wallet), `invites` (`active`: invited accounts counted today; `bps`: what they add to the rate; `bpsEach` and `capBps`: the rule, with `bpsEach` 0 while the invite bonus is off) |
| `GET /v1/rewards` | user | – | The balances, `activeRootDay` and recent claims |
| `POST /v1/rewards/claim` | user | – | Queues a gasless claim |
| `GET /v1/rewards/proof/:address` | – | – | `chainId, distributor, day, cumulativeAmount, proof` for a direct claim |

**Balances** always add up: `earned = claimed + claimable + pending`.

| Field | Meaning |
|---|---|
| `claimed` | Paid out on chain |
| `claimable` | In the active root and not yet claimed |
| `pending` | Earned and not claimable yet: settled rewards waiting for their root, and an estimate for sessions not settled yet, the running one included |
| `entitled` | The account's cumulative entitlement in the ledger |
| `accrual` | `{ perHour, until }` while a session is running, otherwise null. The running session's part of `pending` grows at `perHour` until `until`; a client adds the time passed since `at` to `pending` and `earned` instead of asking again |
| `at` | When the numbers were taken |

## Verification

Mining does not need verification on testnet (see [MINING_SPEC.md](MINING_SPEC.md), "Tiers"). `verificationOpen` in `/v1/network` says whether an account can verify now.

| Method and path | Auth | Body | Result |
|---|---|---|---|
| `POST /v1/verification/session` | user | – | Starts a liveness and de-duplication check |
| `POST /v1/verification/webhook` | HMAC | `reference, status, uniqueKey?` | Vendor callback; header `x-longyu-signature: sha256=<hex>` |
| `POST /v1/verification/babt/challenge` | user | – | SIWE nonce for BNB Smart Chain (chain 56) |
| `POST /v1/verification/babt` | user | `message, signature` | Verifies holders of Binance's soulbound KYC token, one account each |

## Public

| Method and path | Result |
|---|---|
| `GET /health` | `ok` |
| `GET /v1/network` | Chain ID, RPC, explorer, gas token (BNB), reward token (tLONG), contract addresses, `verificationOpen` |
| `GET /v1/stats` | `miners` (accounts that can mine), `verifiedMiners`, total claimed, latest settlement |
| `GET /v1/leaderboard` | Top 100 by streak, among accounts that can mine and are not banned |
| `GET /data/roots/day-N-<hash16>.json` | A published data file, read from the store. The canonical URL is the `dataURI` in the root's on-chain `RootProposed` event |
| `POST /v1/faucet` | `address, captchaToken`; queued and sent by the relayer job; one per address per day |
| `POST /v1/appeals`, `GET /v1/appeals` | User appeals (signed in) |
| `GET /v1/boosts` | Signed in: the mining capacity plans (classes C1 to C5, each for 7, 30 or 90 days), whether the user may activate one, their current and upcoming plans, and recent orders with payment details |
| `POST /v1/boosts/orders` | Signed in, in an entitled tier: `plan`. Creates a boost order and returns the order ID, price, the pay-page link and the PaymentRouter call. The call carries the order's payment reference; the router derives the order ID from the reference, the token and the amount, so only the exact price pays the order |
| `GET /v1/orders/:orderId` | A business order's status and, while it is open, how to pay it (router, call, arguments, and the token approval first) |
