# Web pages

LONGYU's landing page and its pages for a browser wallet: static HTML with one script each, built by esbuild and served from memory.

| Page | File | What it does |
|---|---|---|
| Landing | `landing.html` | The front page of `longyu.network`: the live block height, the network details and links to everything else |
| Developers | `developers.html` | `longyu.network/developers`: the network's settings, deploy and verify commands for Foundry and Hardhat, and the addresses of the contracts on the chain. It sends no requests |
| Claim | `index.html` | Claims mined rewards with a Merkle proof from the published data file |
| Bridge | `bridge.html` | Deposits from BSC, and the three steps of a withdrawal: start, prove, finalize |
| Swap | `swap.html` | LONGYU Swap: swap any token against BNB, add and remove liquidity; `swap.html?token=0x…&mode=add` opens it on one token |
| Launch | `launch.html` | LONGYU Launch: makes a fixed-supply token with no owner, for gas only. Built when `TOKEN_LAUNCHER` is set |
| Safe | `safe.html` | Signs and executes transactions of a Safe multisig on LONGYU or BSC |
| Pay | `pay.html` | Pays an order through PaymentRouter on BSC |

Each page's logic is in a `*-core.ts` file that has no DOM and is unit-tested; the page script around it only reads the form and the wallet.

The swap, launch and bridge pages share a bar (Swap, Launch, Bridge, Explorer and the wallet button), a stylesheet ([src/app.css](src/app.css)) and the wallet dialog ([src/wallet-modal.ts](src/wallet-modal.ts)): browser wallets announce themselves (EIP-6963), the visitor picks one and the page sends every request to it; a phone without a wallet gets links that open the page in a wallet app. Tokens show their logo from the API (`GET /v1/tokens/<address>/logo`) or a monogram; the launch page lets a token's creator set its logo by signing a message ([src/launch-core.ts](src/launch-core.ts), `logoMessage`).

## Build

```sh
npm run build -w @longyu/web     # writes apps/web/dist
npm test -w @longyu/web
```

Contract addresses and RPC addresses are read from the environment at build time and are never guessed: a page whose address is missing or invalid builds closed, shows that it is not open yet, and no action on it works. The variables are listed at the top of [build.mjs](build.mjs).

`NETWORK` (`testnet`, the default, or `mainnet`) picks the network's profile in [src/networks.json](src/networks.json): BSC's chain and BscScan, LONGYU's chain id and name, the symbols. Only that profile reaches the built files. On mainnet LONG is locked until the TGE: the bridge moves BNB only, the swap page lists LONG as not tradable yet and trades other tokens, and the build stops when `CHAIN_ID` is not 668800. On both networks the swap page refuses any other token whose name or symbol passes for LONG or LONGYU, the rule the explorer and TokenLauncher use. The launch page, and every link to it, is built only when `TOKEN_LAUNCHER` is set; without it `PAGES` must not name `launch`.

The build also writes each page's Content-Security-Policy. A page may send requests only to the API and RPC addresses it was built with, and runs no inline script. The swap and launch pages may show images from the API (token logos), the launch page a logo chosen from the visitor's own file (`blob:`), and the three pages with the bar the icons wallets announce (`data:`).

`DEX_URL` and `BRIDGE_URL` (optional, like `https://dex.longyu.network`) are the swap, launch and bridge pages' own names: when set, the bar, the landing page and the developer page link Swap to `DEX_URL/`, Launch to `DEX_URL/launch` and Bridge to `BRIDGE_URL/`, and the pages name them as their canonical address.

## Serve

[server.mjs](server.mjs) serves `dist/` and nothing else. `PAGES` names the pages that are public; any other page answers 404. Files are read once at start, so a request never touches the disk.

One service answers on several names. A name in `LANDING_HOSTS` serves the landing page and its own files (share image) and none of the wallet pages; every other name serves the wallet pages and none of the landing page. A name in `HOST_PAGES` serves only the pages named for it, the first at `/` and each at `/<page>` and at its own file: `HOST_PAGES="dex.longyu.network=swap,launch; bridge.longyu.network=bridge"` serves the swap page at `dex.longyu.network/`, the launch page at `/launch` and the bridge at `bridge.longyu.network/`. Every name serves the shared files (icons, `app.css`, the lockup and the fonts). A name in `REDIRECT_HOSTS` only sends its visitors to `REDIRECT_TO`. The landing page is built only when every address it links to is set (`SITE_URL`, `APP_URL`, `MINE_URL`, `EXPLORER_URL`, `L2_RPC_URL`, `CHAIN_ID`); `GITHUB_URL` and `X_URL` add their links when set. The developer page is built with it, and lists a contract only when its address is set (`L2_TOKEN`, `SWAP_ROUTER`, `SWAP_FACTORY`, `TOKEN_LAUNCHER`, `L1_STANDARD_BRIDGE`, `L1_PORTAL`, `L1_TOKEN`); a value that is not an address stops the build. Its fonts are Inter, Sora and JetBrains Mono under the SIL Open Font License ([src/fonts/OFL.txt](src/fonts/OFL.txt)).
