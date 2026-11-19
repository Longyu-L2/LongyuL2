# Web pages

LONGYU's landing page and its pages for a browser wallet: static HTML with one script each, built by esbuild and served from memory.

| Page | File | What it does |
|---|---|---|
| Landing | `landing.html` | The front page of `longyu.network`: the live block height, the network details and links to everything else |
| Claim | `index.html` | Claims mined rewards with a Merkle proof from the published data file |
| Bridge | `bridge.html` | Deposits from BSC, and the three steps of a withdrawal: start, prove, finalize |
| Swap | `swap.html` | LONGYU Swap: swap, add and remove liquidity |
| Safe | `safe.html` | Signs and executes transactions of a Safe multisig on LONGYU or BSC |
| Pay | `pay.html` | Pays an order through PaymentRouter on BSC |

Each page's logic is in a `*-core.ts` file that has no DOM and is unit-tested; the page script around it only reads the form and the wallet.

## Build

```sh
npm run build -w @longyu/web     # writes apps/web/dist
npm test -w @longyu/web
```

Contract addresses and RPC addresses are read from the environment at build time and are never guessed: a page whose address is missing or invalid builds closed, shows that it is not open yet, and no action on it works. The variables are listed at the top of [build.mjs](build.mjs).

The build also writes each page's Content-Security-Policy. A page may send requests only to the API and RPC addresses it was built with, and runs no inline script.

## Serve

[server.mjs](server.mjs) serves `dist/` and nothing else. `PAGES` names the pages that are public; any other page answers 404. Files are read once at start, so a request never touches the disk.

One service answers on several names. A name in `LANDING_HOSTS` serves the landing page and its own files (fonts, logo, share image) and none of the wallet pages; every other name serves the wallet pages and none of the landing page. A name in `REDIRECT_HOSTS` only sends its visitors to `REDIRECT_TO`. The landing page is built only when every address it links to is set (`SITE_URL`, `APP_URL`, `MINE_URL`, `EXPLORER_URL`, `L2_RPC_URL`, `CHAIN_ID`); `GITHUB_URL` and `X_URL` add their links when set. Its fonts are Inter, Sora and JetBrains Mono under the SIL Open Font License ([src/fonts/OFL.txt](src/fonts/OFL.txt)).
