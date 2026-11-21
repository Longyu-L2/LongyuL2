# Signer

The service that holds LONGYU's four backend keys. It runs on the private network with no public address, and the API reaches it with a bearer token. It signs only what its policy allows, so a compromised API cannot move funds or sign anything else.

## What each key signs

| Key | Signs | Nothing else |
|---|---|---|
| Publisher | `MiningDistributor.proposeRoot` on this chain | No value, no other contract, no other function |
| Relayer | `MiningDistributor.claimMany` and `Faucet.drip` on this chain | The same |
| Faucet signer | The faucet's EIP-712 `Voucher`, within the amount, lifetime and daily limits | No transactions |
| Watch | `MiningDistributor.vetoPendingRoot` and `MiningDistributor.pause` on this chain. It holds the guardian role only, so it can stop a root or stop claims and never move funds | The same |

No key sends value, deploys a contract, signs a message or signs for another chain. A request with an unknown field is refused, so an access list, blobs or an authorization list can never be signed. The rules are in [src/policy.ts](src/policy.ts).

Each transaction is also held to limits on gas, fee per gas and data size, and each transaction key to a ceiling on the fees it may commit in one UTC day.

## Endpoints

| Method and path | Result |
|---|---|
| `GET /health` | `{ ok: true }`, without a token |
| `GET /v1/accounts` | The address of each configured key |
| `POST /v1/sign/transaction` | A signed transaction for the publisher, the relayer or the watch |
| `POST /v1/sign/voucher` | A signed faucet voucher |

## Settings

| Variable | Meaning |
|---|---|
| `SIGNER_TOKEN` | The API's bearer token, 32 characters or more. It must not be one of the keys |
| `CHAIN_ID` | The only chain the keys sign for |
| `DISTRIBUTOR_ADDRESS`, `FAUCET_ADDRESS` | The only contracts a transaction may call. Until the distributor is set, no transaction is signed |
| `PUBLISHER_KEY`, `RELAYER_KEY`, `FAUCET_SIGNER_KEY`, `WATCH_KEY` | One key per role; the same key in two roles is refused |
| `MAX_GAS`, `MAX_FEE_PER_GAS_WEI`, `MAX_DATA_BYTES` | Limits on one transaction |
| `MAX_DAILY_FEE_WEI` | The most each transaction key may commit to fees in one UTC day |
| `FAUCET_MAX_AMOUNT_WEI`, `FAUCET_MAX_DAILY_WEI`, `VOUCHER_MAX_TTL_SECONDS` | Voucher limits, kept at or under the faucet contract's own |

Defaults are in [src/config.ts](src/config.ts).

## Run

```sh
npm test -w @longyu/signer
npm run typecheck -w @longyu/signer
```

In production the service gets no public domain. The API's `SIGNER_URL` must be https, or http on a private network name.
