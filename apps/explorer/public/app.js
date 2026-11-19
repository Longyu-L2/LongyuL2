// LONGYU Scan: small enhancements. Builds DOM with textContent only; never inserts HTML strings.
(() => {
  "use strict";

  // "/" focuses the search box.
  document.addEventListener("keydown", (e) => {
    const t = e.target;
    if (e.key === "/" && !(t instanceof HTMLInputElement) && !(t instanceof HTMLTextAreaElement)) {
      const input = document.querySelector(".search input");
      if (input) {
        e.preventDefault();
        input.focus();
      }
    }
  });

  // Copy buttons.
  document.addEventListener("click", async (e) => {
    const b = e.target instanceof Element ? e.target.closest("button.copy") : null;
    if (!b) return;
    try {
      await navigator.clipboard.writeText(b.getAttribute("data-copy") || "");
      b.classList.add("done");
      setTimeout(() => b.classList.remove("done"), 1200);
    } catch {
      /* clipboard unavailable */
    }
  });

  // The menu closes on a tap outside it and on Escape.
  const menu = document.querySelector("details.menu");
  if (menu) {
    document.addEventListener("click", (e) => {
      if (menu.open && e.target instanceof Node && !menu.contains(e.target)) menu.open = false;
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") menu.open = false;
    });
  }

  // Adds this chain to the visitor's wallet.
  const add = document.getElementById("add-network");
  if (add) {
    const label = add.textContent;
    const say = (text) => {
      add.textContent = text;
      setTimeout(() => (add.textContent = label), 2500);
    };
    add.addEventListener("click", async () => {
      const wallet = window.ethereum;
      if (!wallet || typeof wallet.request !== "function") return say("No wallet in this browser");
      const symbol = add.getAttribute("data-symbol") || "";
      try {
        await wallet.request({
          method: "wallet_addEthereumChain",
          params: [{
            chainId: `0x${Number(add.getAttribute("data-chain-id")).toString(16)}`,
            chainName: add.getAttribute("data-chain-name") || "",
            nativeCurrency: { name: symbol, symbol, decimals: 18 },
            rpcUrls: [add.getAttribute("data-rpc") || ""],
            blockExplorerUrls: [location.origin],
          }],
        });
        say("Added");
      } catch {
        say("Not added");
      }
    });
  }

  // Relative times stay current.
  const ago = (ts) => {
    const s = Math.max(0, Math.floor(Date.now() / 1000 - ts));
    if (s < 60) return `${s} s ago`;
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    return `${Math.floor(s / 86400)} d ago`;
  };
  const tick = () => document.querySelectorAll("time[data-ts]").forEach((el) => (el.textContent = ago(Number(el.getAttribute("data-ts")))));
  setInterval(tick, 5000);

  // Home page: new blocks and transactions appear without a reload.
  const blocks = document.getElementById("feed-blocks");
  const txs = document.getElementById("feed-txs");
  const height = document.getElementById("stat-height");
  if (!blocks || !txs) return;
  const rows = Math.max(blocks.children.length, txs.children.length, 1);
  const hex = /^0x[0-9a-f]+$/;
  let labels = {};
  try {
    labels = JSON.parse(txs.getAttribute("data-labels") || "{}");
  } catch {
    /* no names */
  }
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };
  const link = (href, text, cls) => {
    const a = el("a", cls, text);
    a.href = href;
    return a;
  };
  const short = (h, a, b) => (h.length > a + b + 2 ? `${h.slice(0, a)}…${h.slice(-b)}` : h);
  const time = (ts) => {
    const t = el("time", "", ago(ts));
    t.setAttribute("data-ts", String(ts));
    return t;
  };
  const units = (wei) => {
    const v = BigInt(wei);
    const whole = v / 10n ** 18n;
    const frac = (v % 10n ** 18n).toString().padStart(18, "0").slice(0, 6).replace(/0+$/, "");
    return `${whole.toLocaleString("en-US")}${frac ? `.${frac}` : ""}`;
  };
  // Written as the server writes it: two decimals, cut and not rounded.
  const percent = (part, whole) => {
    if (whole === 0n) return "0%";
    const s = ((part * 10000n) / whole).toString().padStart(3, "0");
    return `${s.slice(0, -2)}.${s.slice(-2)}%`;
  };
  const party = (word, address) => {
    const line = el("span");
    line.append(el("span", "muted", word), " ");
    if (typeof address === "string" && hex.test(address)) {
      const a = link(`/address/${address}`, typeof labels[address] === "string" ? labels[address] : short(address, 8, 6), "mono addr");
      a.title = address;
      line.append(a);
    } else line.append(el("span", "muted", "–"));
    return line;
  };
  const symbol = document.body.getAttribute("data-native") || "";
  let last = "";
  const refresh = async () => {
    try {
      const r = await fetch("/api/v1/home", { headers: { accept: "application/json" } });
      if (!r.ok) return;
      const d = await r.json();
      const top = d.blocks[0]?.hash || "";
      if (top === last) return;
      last = top;
      blocks.replaceChildren(...d.blocks.slice(0, rows).map((b) => {
        const li = el("li");
        const id = el("span", "id");
        id.append(link(`/block/${Number(b.number)}`, Number(b.number).toLocaleString("en-US")), time(Number(b.timestamp)));
        const side = el("span", "side");
        side.append(el("span", "", `${Number(b.tx_count).toLocaleString("en-US")} ${Number(b.tx_count) === 1 ? "txn" : "txns"}`), el("span", "muted", `Gas used ${percent(BigInt(b.gas_used), BigInt(b.gas_limit))}`));
        li.append(el("span", "tile bk"), id, side);
        return li;
      }));
      txs.replaceChildren(...d.txs.filter((t) => hex.test(t.hash)).slice(0, rows).map((t) => {
        const li = el("li");
        const id = el("span", "id");
        const a = link(`/tx/${t.hash}`, short(t.hash, 8, 6), "mono");
        a.title = t.hash;
        id.append(a, time(Number(t.timestamp)));
        const who = el("span", "who");
        who.append(party("From", t.from_address), party(t.contract_address ? "New" : "To", t.contract_address || t.to_address));
        li.append(el("span", "tile tx"), id, who, el("span", "amt num", `${units(t.value)} ${symbol}`));
        return li;
      }));
      if (height && d.blocks[0]) height.textContent = Number(d.blocks[0].number).toLocaleString("en-US");
    } catch {
      /* offline: try again on the next tick */
    }
  };
  setInterval(refresh, 4000);
})();
