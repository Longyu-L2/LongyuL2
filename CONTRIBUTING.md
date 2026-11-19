# Contributing

Bug reports and pull requests are welcome. For a security problem, do not open an issue: follow [SECURITY.md](SECURITY.md).

## Set up

Node 22 or later and [Foundry](https://book.getfoundry.sh/getting-started/installation) v1.5.1.

```sh
npm install

cd contracts
forge install --no-git foundry-rs/forge-std@v1.17.0
forge install --no-git OpenZeppelin/openzeppelin-contracts@v5.6.1
cd dex
forge install --no-git foundry-rs/forge-std@v1.17.0
cd ../..

cd apps/mobile && npm install --legacy-peer-deps && cd ../..
```

## Before you open a pull request

Run what your change touches. CI runs all of it.

| Area | Commands |
|---|---|
| Contracts | `cd contracts && forge test`, `cd contracts/dex && forge test` |
| Services | `npm run typecheck`, `npm test -w @longyu/<workspace>` |
| API against real contracts | `npm run test:e2e -w @longyu/api` |
| RPC gateway | `npm run test:rpc` |
| Deployment and monitoring configs | `npm run typecheck:ops && npm run test:ops` |
| App | `cd apps/mobile && npm run typecheck && npm test` |

## What we look for

- **A test for the behaviour.** A bug fix comes with a test that fails without it.
- **Exact dependency versions.** No ranges in the services' `package.json` files; the app follows Expo's ranges and its lockfile. Contract libraries are pinned by tag.
- **Integer maths for money.** Amounts are `bigint` in the smallest unit. The reward engine and the contracts must round the same way, and `contracts/test/EngineParity.t.sol` checks that they do.
- **No secrets.** Nothing from a `.env` file, no keys, no private addresses of services.
- **Comments that state a rule or a reason**, not what the next line does.
- **Small pull requests.** One change, described in the title.

A change to a deployed contract's behaviour, to the reward rules or to what the signer agrees to sign needs an issue first, so that the design is agreed before the code.

## Licence

Contributions are accepted under the repository's licences: MIT, and GPL-3.0-or-later for `contracts/dex`.
