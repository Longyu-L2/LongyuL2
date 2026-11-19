# Contract monitoring (OpenZeppelin Monitor)

OpenZeppelin Monitor watches LONGYU's contracts on their chains and sends ops a Telegram message when an admin or safety event happens. It runs separately from the API, so it still alerts if the API is down or compromised. The API's own health endpoint covers everything else.

## What is watched

| Contract | Chain | Alerts on |
|---|---|---|
| MiningDistributor | LONGYU | veto, pause, unpause, vault change, limit changes, role changes; claims above `largeClaimWei` |
| MiningVault | LONGYU | distributor change, role changes |
| Faucet | LONGYU | limit changes, pause, unpause, withdrawals, role changes |
| PaymentRouter | BSC | treasury change, accepted-token change, pause, unpause, role changes |
| MigrationDistributor | where deployed | root set, sweep, pause, unpause, role changes |
| L2OutputOracle | BSC (L1 of the chain) | deleted state outputs |
| SystemConfig | BSC (L1 of the chain) | any rollup config change (batcher, gas, signer) |
| SuperchainConfig | BSC (L1 of the chain) | pause, unpause, guardian change |

Routine events (claims, drips, payments, daily roots) are not alerted here. The API indexes them and reports problems through `/v1/admin/health`.

## Set up

1. Copy `deployment.example.json` to `deployment.json`, and fill in `alerts.telegramChatId` and each deployed contract's address. Leave an address blank to skip that contract; a network nothing uses is left out.
2. Generate the config and check it:
   ```
   npx tsx ops/monitor/generate.ts ops/monitor/deployment.json ops/monitor/config
   ```
3. Build and run (from the repository root). The image pins Monitor 1.7.0:
   ```
   docker build -f ops/monitor/Dockerfile -t longyu-monitor .
   docker run -d --name longyu-monitor -v longyu-monitor-data:/app/data \
     -e LONGYU_TESTNET_RPC_URL=... -e BSC_TESTNET_RPC_URL=... -e BSC_RPC_URL=... -e TELEGRAM_BOT_TOKEN=... longyu-monitor
   ```
   Set only the RPC variables of networks in use.
4. Read the start-up log. In 1.7.0, a config error is only logged; the process does not exit with an error.

Alerts go to one Telegram chat. Create a bot with @BotFather, add it to the ops group or channel, and put the chat's ID in `alerts.telegramChatId` (a number, negative for groups, or a public `@name`). The bot's token is the `TELEGRAM_BOT_TOKEN` variable; it is never written into the config. The API sends its own ops notices to the same chat when it has the same two settings.

## Things to know

- **RPC requirements.** Monitor 1.7.0 reads every block with `eth_getBlockByNumber` and an unfiltered `eth_getLogs`. BNB's public `bsc-dataseed` endpoints refuse `eth_getLogs`, so use a provider (NodeReal, Ankr, QuickNode) or your own node. At 0.45-second blocks, each BSC network costs about 380,000 calls a day. The LONGYU network should point at your own node.
- **Missed blocks.** In 1.7.0, a block whose logs fail to load (for example on a rate limit) is skipped without a retry. The fix is on Monitor's unreleased main branch. Use a reliable RPC, and treat this monitor as a second line behind the API's health checks.
- **Block times.** BSC mainnet and testnet both measured 450 ms per block on 2026-11-17. The LONGYU chain makes a block every 250 ms. Each network reads every block since its last run (`max_past_blocks: "unlimited"`).
- **Proposer liveness.** Event monitors cannot alert on something that stops happening. Watch the proposer and batcher through their own metrics and balances (see chain/README.md).
