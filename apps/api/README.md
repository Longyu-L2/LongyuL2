# API

LONGYU's backend, one Fastify service on Postgres. It signs people in with X, records mining sessions, settles each day with the [reward engine](../../packages/reward-engine), posts the day's root through the [signer](../signer), relays claims and serves the admin console.

Routes are documented in [docs/API.md](../../docs/API.md) and the rules they enforce in [docs/MINING_SPEC.md](../../docs/MINING_SPEC.md).

## Layout

| Path | Contents |
|---|---|
| [src/modules/](src/modules) | Routes: sign-in, mining, device wallet, verification, capacity plans, payments, the public data files, admin and health |
| [src/jobs/](src/jobs) | Background jobs, listed below |
| [src/services/](src/services) | The chain, the signer, device attestation, storage and the X client |
| [src/db/migrations/](src/db/migrations) | SQL migrations, applied in order at start |
| [admin/](admin) | The admin console, static files served at `/admin` |
| [scripts/](scripts) | The local devnet, the migration snapshot and a storage check |

## Jobs

Each job takes a lease in the database, so two instances of the API never run the same job at once.

| Job | Every | Does |
|---|---|---|
| indexer | 5 s | Follows the distributor's events: claims, activations and vetoes |
| settlement | 60 s | Settles the newest closed day and writes its data file |
| publisher | 60 s | Posts a settled day's root |
| watch | 30 s | Compares the roots on chain with the ones computed here; on a mismatch it vetoes a waiting root and pauses the distributor with the signer's guardian-only watch key |
| relayer | 15 s | Sends queued claims and faucet drips |
| payments | 30 s | Reads PaymentRouter on BSC, only when payments are configured |
| transfers | 30 s | Follows the reward token's transfers for the wallet-sweep rule |
| maintenance | 10 min | Reminders and clean-up |

`GET /v1/admin/health` reports the state of all of it as one list of checks, and answers 503 when any is critical.

## Keys

The API holds no signing key in production. `SIGNER_URL` and `SIGNER_TOKEN` point it at the signer service, and it refuses to start there with a raw key in its environment. Users' wallet keys are created on their own device and never reach the API.

## Run

```sh
npm test -w @longyu/api                # routes, jobs, settlement, attestation, payments
npm run test:e2e -w @longyu/api        # against the real contracts on Anvil
npm run typecheck -w @longyu/api
```

A local stack, with Anvil standing in for the chain and an embedded database:

```sh
cd apps/api
npm run devnet                         # starts Anvil, deploys the contracts, writes .env.devnet
node --env-file=.env.devnet --import tsx src/server.ts
```

Every setting is described in [.env.example](.env.example) and validated in [src/config.ts](src/config.ts). In production the service does not start without a database, a signer, X sign-in, the captcha secret, a storage bucket and the origin secret, or with any development switch on.

## Migration snapshot

```sh
SNAPSHOT_DAY=120 MIGRATION_CHAIN_ID=668800 MIGRATION_DISTRIBUTOR=0x... \
DATABASE_URL=postgres://... npm run migration:snapshot -w @longyu/api
```

It writes the allocation file and prints the root for `MigrationDistributor.setRoot`. `BSC_RPC_URL` and `BABT_ADDRESS` are read as the API reads them: an account verified with a BABT counts only while its address still holds one, and the snapshot stops if that read fails.
