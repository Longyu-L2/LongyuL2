import { blockNumberOf, formatCount, nextShown, parseLandingConfig } from "./landing-core.ts";
import { $, copyButtons, topBar, walletButton } from "./site.ts";

declare const __LANDING_CONFIG__: unknown;

const config = parseLandingConfig(__LANDING_CONFIG__);
topBar();
copyButtons();
walletButton(config);

// The live block height: read once a second while the page is in view, and counted up through the
// blocks in between.
if (config) {
  const block = $("block");
  let latest: number | null = null;
  let shown: number | null = null;
  let reading = false;
  let timers: number[] = [];

  const draw = () => {
    if (latest === null) return;
    const next = shown === null ? latest : nextShown(shown, latest);
    if (next === shown) return;
    shown = next;
    block.textContent = formatCount(next);
  };

  const read = async () => {
    if (reading) return;
    reading = true;
    try {
      const answer = await fetch(config.rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
        signal: AbortSignal.timeout(4000),
      });
      const height = answer.ok ? blockNumberOf(await answer.json()) : null;
      if (height !== null) latest = height;
    } catch {
      // A missed read changes nothing: the counter keeps the last height the node gave.
    } finally {
      reading = false;
    }
  };

  const start = () => {
    if (timers.length) return;
    void read();
    timers = [window.setInterval(read, 1000), window.setInterval(draw, 80)];
  };
  const stop = () => {
    for (const t of timers) window.clearInterval(t);
    timers = [];
  };
  document.addEventListener("visibilitychange", () => (document.hidden ? stop() : start()));
  if (!document.hidden) start();
}
