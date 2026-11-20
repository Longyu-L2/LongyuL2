# LONGYU Scan

LONGYU's own block explorer: an indexer and a server-rendered website in one Node service, with no third-party explorer software and no licence conditions.

- **Indexer** (`src/indexer.ts`). It follows the LONGYU node block by block into Postgres: blocks, transactions with receipts (including the L1 data fee and deposit fields), logs, ERC-20 and ERC-721 transfers, and token balances. Each block is one database transaction. A reorganised tip is detected by its parent hash, undone with its balance changes, and read again. LONGYU makes four blocks a second, so two things are kept out of the database: the deposit each block starts with (the sequencer recording BSC's latest block) is never stored, and blocks holding nothing else are deleted after `PRUNE_EMPTY_AFTER_HOURS` (default 24; 0 keeps them). Blocks with transactions stay for good. A page or API request for a deleted block or a system deposit is answered from the node.
- **Pages** (`src/web`). Home, blocks, transactions, addresses, tokens, the bridge (deposits from BSC, withdrawals to BSC) and search, in the brand colours (`brand/tokens.json`). The home page shows the chain's figures, a chart of the transactions of the last 14 days, and the latest blocks and transactions, which refresh without a reload. Calls and events are decoded with every LONGYU ABI plus the standard token and OP Stack interfaces.
- **Counts by day** (`src/migrations/003_daily_transactions.sql`). The indexer keeps the number of transactions of each UTC day beside its running total: a block adds to its day and a reorganisation takes away again, so the chart never has to count rows.
- **API** (`src/app.ts`). JSON under `/api/v1`, plus an Etherscan-compatible subset under `/api` (`account` `balance`, `txlist`, `tokentx`, `tokenbalance`; `stats` `tokensupply`; `contract` `verifysourcecode`, `checkverifystatus`, `getabi`, `getsourcecode`). The Etherscan-compatible `txlist` answers at most 100 transactions a page, and each carries at most the first 4,096 bytes of its input data; events in `/api/v1/tx/{hash}` and on a transaction's page carry at most the first 4,096 bytes of their data, with `data_bytes` giving the full size. `/api/v1/tx/{hash}` gives a transaction's input whole.
- **Contract verification** (`src/verify`). A project publishes its contract's source on the contract's page, from the form at `/verify` or with its own tools:

  ```sh
  forge verify-contract <address> src/Token.sol:Token --chain-id 668801     --verifier blockscout --verifier-url https://scan-testnet.longyu.network/api --watch
  ```

  The explorer compiles the source with the release of the Solidity compiler that was named (0.5.0 and later) and publishes it only when the result is the code at the address, byte for byte. Three things are set aside, each where the compiler itself says it is: the values of immutables, a library's own address, and, for a match marked *partial*, the metadata hash the compiler appends to a contract's code. When the explorer holds the transaction that created the contract, the compiled creation code must also be the start of that transaction's input; what follows is kept as the constructor's arguments. A source stays on the page only while the address holds the code it was matched against.

**Safety of verification**
- Compilers are the official builds from `binaries.soliditylang.org`. Each release's SHA-256 is pinned in `src/verify/compilers.json` and checked every time a build is read, from the download or from the disk.
- A compilation runs in a process of its own with an empty environment and Node's permission model: it can read its own script and nothing else, cannot write and cannot start a process. It is stopped after 120 seconds, or past 2 GB of memory, or past 16 MB of output. Node's permission model does not cover the network; what runs in that process is the pinned compiler, and the source it is given is data to it.
- A request's sources are the text it carries. Nothing is fetched for a request, and of its settings only those that shape bytecode reach the compiler.
- One compilation runs at a time and eight wait; past that, requests are refused. A visitor has six uploads a minute and thirty readings of a verified source a minute.
- The database takes `VERIFY_DAILY_BYTES` of verified source and ABI in 24 hours (default 100 MB). Someone who fills a day's amount stops verification for that day, and cannot fill the disk.
- `VERIFICATION=false` stops new verifications. Sources verified before stay on their pages.

**Safety**
- Everything on a page that comes from the chain is escaped, because token names and calldata are written by anyone. Control and bidi-override characters are also stripped from token names.
- Pages run no inline script, under a strict Content-Security-Policy.
- Static files are served from memory, not the file system.
- Requests are rate-limited per visitor (an IPv6 visitor is its /64), and a visitor's database query is cancelled after 5 seconds.
- The service never writes to the chain.

**Run**
```sh
npm run test -w @longyu/explorer        # unit tests (indexer, reorgs, pruning, escaping, formatting, verification)
npm run test:e2e -w @longyu/explorer    # Anvil: real transactions indexed and served, and forge verify-contract (needs Foundry)
cd apps/explorer && npx tsx scripts/demo.ts   # local demo with sample activity on http://127.0.0.1:4000
```

**Settings** (`src/config.ts`): `RPC_URL`, `CHAIN_ID` (checked against the node at start), `DATABASE_URL` (the explorer creates and uses its own database, `EXPLORER_DATABASE`, default `explorer`), `KNOWN_ADDRESSES` (names for LONGYU contracts, `address:Label` pairs), `PRUNE_EMPTY_AFTER_HOURS`, `PUBLIC_RPC_URL` (shown in the footer and used by the "Add to wallet" button), `BRIDGE_URL`, `SWAP_URL`, `WEBSITE_URL`, `MINE_URL`, `DEVELOPERS_URL` and `GITHUB_URL` (https links in the menu and the footer; each is left out when not set), `VERIFICATION`, `VERIFY_DAILY_BYTES` and `COMPILER_CACHE_DIR` (where downloaded compilers are kept; the system's temporary directory when not set), `TRUST_PROXY` (the proxy's addresses, when the proxy connects to the explorer directly), and `ORIGIN_SECRET` (the value Cloudflare adds as the `x-longyu-origin` header: with it set, anything else is refused except `/health`, and visitors are counted by the address Cloudflare reports. Needed on Railway, whose own proxy hides the visitor's address). On Railway it runs as the `explorer` service (`.railway/railway.ts`).
