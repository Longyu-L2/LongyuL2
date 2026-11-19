// LONGYU admin console. Served by the API from the same origin, under a strict CSP.
// Every value from the server is rendered as text (never as HTML): user handles, appeal messages
// and flag details are attacker-controlled.

const KEY_STORE = "longyu-admin-key";
const state = { key: "", admin: "", tab: "health", userId: null, payCfg: null, filters: {} };
try {
  state.key = sessionStorage.getItem(KEY_STORE) ?? "";
} catch {
  // Storage blocked: the key lives in memory for this page only.
}

// ------------------------------------------------------------------ helpers

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else if (k === "value") el.value = v;
    else if (k === "disabled" || k === "hidden" || k === "selected") el[k] = Boolean(v);
    else el.setAttribute(k, String(v));
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === undefined || kid === null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

const $ = (id) => document.getElementById(id);

function setStatus(message, kind = "") {
  const el = $("status");
  el.textContent = message ?? "";
  el.className = `status${message ? " show" : ""}${kind ? ` ${kind}` : ""}`;
}

class ApiError extends Error {}

async function api(method, path, body) {
  const headers = { "x-admin-key": state.key };
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: "omit", cache: "no-store" });
  let json = {};
  try {
    json = await res.json();
  } catch {
    // Non-JSON error page.
  }
  if (res.status === 401) {
    signOut("Your admin key was not accepted.");
    throw new ApiError("unauthorized");
  }
  if (!res.ok) {
    const detail = json.issues ? json.issues.map((i) => `${i.path}: ${i.message}`).join("; ") : json.message;
    throw new ApiError(`${json.error ?? `HTTP ${res.status}`}${detail ? ` (${detail})` : ""}`);
  }
  return json;
}

const when = (ts) => {
  if (ts === null || ts === undefined || ts === "") return "";
  const n = Number(ts);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString().slice(0, 16).replace("T", " ") : String(ts);
};

/** Formats an integer amount string with `decimals` places, keeping full precision. */
function units(value, decimals = 18) {
  if (value === null || value === undefined || value === "") return "";
  const s = String(value);
  if (!/^-?\d+$/.test(s)) return s;
  const neg = s.startsWith("-");
  const digits = (neg ? s.slice(1) : s).padStart(decimals + 1, "0");
  const int = decimals ? digits.slice(0, -decimals) : digits;
  const frac = decimals ? digits.slice(-decimals).replace(/0+$/, "") : "";
  return `${neg ? "-" : ""}${int.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${frac ? `.${frac}` : ""}`;
}

const short = (hex) => (typeof hex === "string" && hex.length > 18 ? `${hex.slice(0, 10)}…${hex.slice(-6)}` : hex ?? "");
const cssToken = (s) => String(s ?? "").toLowerCase().replace(/[^a-z_]/g, "");
const pill = (text) => h("span", { class: `pill ${cssToken(text)}` }, text ?? "");
const mono = (text, full) => h("span", { class: "mono", title: full ?? text }, text);

function table(columns, rows, emptyText = "Nothing here.") {
  if (!rows.length) return h("p", { class: "empty" }, emptyText);
  return h("div", { class: "table-wrap" }, h("table", {},
    h("thead", {}, h("tr", {}, columns.map((c) => h("th", {}, c.label)))),
    h("tbody", {}, rows.map((r) => h("tr", {}, columns.map((c) => h("td", { class: c.num ? "num" : "" }, c.render(r))))))));
}

function select(name, options, current, onchange) {
  return h("select", { name, onchange: (e) => onchange(e.target.value) },
    options.map((o) => h("option", { value: o, selected: o === current }, o)));
}

/** Runs an admin action, reports the result and reloads the current view. */
async function act(description, fn) {
  setStatus(`${description}…`);
  try {
    await fn();
    setStatus(`${description}: done.`, "ok");
  } catch (e) {
    if (!(e instanceof ApiError && e.message === "unauthorized")) setStatus(`${description} failed: ${e.message}`, "error");
    return;
  }
  await render();
}

function ask(question, { min = 1, pattern, hint } = {}) {
  const v = window.prompt(question);
  if (v === null) return null;
  const t = v.trim();
  if (t.length < min || (pattern && !pattern.test(t))) {
    setStatus(hint ?? `Please enter at least ${min} characters.`, "error");
    return null;
  }
  return t;
}

const TX = /^0x[0-9a-fA-F]{64}$/;
const explorerTx = (chainId, hash) => {
  if (!TX.test(hash ?? "")) return null;
  const base = String(chainId) === "56" ? "https://bscscan.com/tx/" : String(chainId) === "97" ? "https://testnet.bscscan.com/tx/" : null;
  return base ? h("a", { href: base + hash.toLowerCase(), target: "_blank", rel: "noopener noreferrer" }, short(hash)) : mono(short(hash), hash);
};

const userLink = (id, handle) =>
  h("button", { class: "secondary", type: "button", onclick: () => { state.userId = id; state.tab = "user"; render(); } }, handle ?? short(id));

// ------------------------------------------------------------------- views

const TABS = [
  ["health", "Health"], ["flags", "Flags"], ["bans", "Bans"], ["appeals", "Appeals"], ["settlements", "Settlements"], ["orders", "Orders"], ["payments", "Payments"],
];

const filter = (tab, fallback) => state.filters[tab] ?? fallback;
const setFilter = (tab) => (v) => { state.filters[tab] = v; render(); };

async function viewFlags() {
  const status = filter("flags", "open");
  const { flags } = await api("GET", `/v1/admin/flags?status=${encodeURIComponent(status)}`);
  return h("section", { class: "card" },
    h("div", { class: "row" }, h("h2", {}, "Risk flags"), select("status", ["open", "confirmed", "cleared"], status, setFilter("flags"))),
    table([
      { label: "Raised", render: (f) => when(f.created_at) },
      { label: "Account", render: (f) => userLink(f.user_id, f.handle) },
      { label: "Rule", render: (f) => f.kind },
      { label: "Severity", render: (f) => pill(f.severity) },
      { label: "Day", render: (f) => f.day, num: true },
      { label: "Detail", render: (f) => h("pre", { class: "mono" }, JSON.stringify(f.detail ?? {})) },
      { label: "", render: (f) => f.status !== "open" ? `by ${f.resolved_by ?? ""}` : h("div", { class: "row" },
        h("button", { class: "secondary", onclick: () => act("Clear flag", () => api("POST", `/v1/admin/flags/${f.id}/resolve`, { action: "clear" })) }, "Clear"),
        h("button", { onclick: () => act("Confirm flag", () => api("POST", `/v1/admin/flags/${f.id}/resolve`, { action: "confirm" })) }, "Confirm"),
        h("button", { class: "danger", onclick: () => requestBan(f.user_id, f.handle) }, "Request ban")) },
    ], flags, "No flags with this status."));
}

function requestBan(userId, handle) {
  const reason = ask(`Why ban ${handle}? A second admin must approve.`, { min: 5 });
  if (reason) act("Request ban", () => api("POST", "/v1/admin/bans", { userId, reason }));
}

async function viewBans() {
  const status = filter("bans", "pending");
  const { bans } = await api("GET", `/v1/admin/bans?status=${encodeURIComponent(status)}`);
  return h("section", { class: "card" },
    h("div", { class: "row" }, h("h2", {}, "Ban requests"), select("status", ["pending", "executed", "rejected"], status, setFilter("bans"))),
    h("p", { class: "muted" }, "A ban needs two admins: one requests it, a different one approves it."),
    table([
      { label: "Requested", render: (b) => when(b.created_at) },
      { label: "Account", render: (b) => userLink(b.target_user, b.handle) },
      { label: "Reason", render: (b) => b.reason },
      { label: "Requested by", render: (b) => b.requested_by },
      { label: "Status", render: (b) => pill(b.status) },
      { label: "Decided by", render: (b) => b.approved_by ?? "" },
      { label: "", render: (b) => b.status !== "pending" ? "" : h("div", { class: "row" },
        h("button", {
          class: "danger",
          disabled: b.requested_by === state.admin,
          title: b.requested_by === state.admin ? "Another admin must approve your request" : "Ban this account",
          onclick: () => { if (window.confirm(`Ban ${b.handle}? Their unclaimed rewards are forfeited.`)) act("Approve ban", () => api("POST", `/v1/admin/bans/${b.id}/approve`, {})); },
        }, "Approve"),
        h("button", { class: "secondary", onclick: () => act("Reject ban", () => api("POST", `/v1/admin/bans/${b.id}/reject`, {})) },
          b.requested_by === state.admin ? "Withdraw" : "Reject")) },
    ], bans, "No ban requests with this status."));
}

async function viewAppeals() {
  const { appeals } = await api("GET", "/v1/admin/appeals");
  return h("section", { class: "card" },
    h("h2", {}, "Open appeals"),
    h("p", { class: "muted" }, "Upholding clears the account's open holds. It does not lift a ban."),
    table([
      { label: "Sent", render: (a) => when(a.created_at) },
      { label: "Account", render: (a) => userLink(a.user_id, a.handle) },
      { label: "Message", render: (a) => h("pre", {}, a.message) },
      { label: "Response", render: (a) => {
        const box = h("textarea", { "aria-label": "Response to the user", maxlength: "2000" });
        const decide = (decision) => {
          const response = box.value.trim();
          if (response.length < 5) return setStatus("Write a response of at least 5 characters.", "error");
          act(`Appeal ${decision}`, () => api("POST", `/v1/admin/appeals/${a.id}/resolve`, { decision, response }));
        };
        return h("div", {}, box, h("div", { class: "row" },
          h("button", { onclick: () => decide("upheld") }, "Uphold"),
          h("button", { class: "secondary", onclick: () => decide("denied") }, "Deny")));
      } },
    ], appeals, "No open appeals."));
}

async function viewSettlements() {
  const { settlements } = await api("GET", "/v1/admin/settlements");
  return h("section", { class: "card" },
    h("h2", {}, "Daily settlements"),
    table([
      { label: "Day", render: (s) => s.day, num: true },
      { label: "Status", render: (s) => pill(s.status) },
      { label: "Total entitled (LONG)", render: (s) => units(s.total_entitled), num: true },
      { label: "Root", render: (s) => mono(short(s.root), s.root) },
      { label: "Data hash", render: (s) => mono(short(s.data_hash), s.data_hash) },
      { label: "Transaction", render: (s) => mono(short(s.tx_hash), s.tx_hash) },
      { label: "Alerts", render: (s) => {
        const alerts = s.stats?.alerts ?? [];
        return alerts.length ? h("pre", { class: "mono" }, alerts.join("\n")) : h("span", { class: "muted" }, "none");
      } },
      { label: "Stats", render: (s) => {
        const { alerts: _alerts, ...rest } = s.stats ?? {};
        return h("details", {}, h("summary", {}, "show"), h("pre", { class: "mono" }, JSON.stringify(rest, null, 1)));
      } },
    ], settlements, "No settlements yet."));
}

async function paymentConfig() {
  if (!state.payCfg) state.payCfg = await api("GET", "/v1/admin/payments/config");
  return state.payCfg;
}
const tokenOf = (cfg, address) => (cfg.tokens ?? []).find((t) => t.address.toLowerCase() === String(address ?? "").toLowerCase());
const money = (cfg, amount, token) => {
  const t = tokenOf(cfg, token);
  return t ? `${units(amount, t.decimals)} ${t.symbol}` : `${amount} (token ${short(token)})`;
};

function orderForm(cfg) {
  const f = {
    customer: h("input", { name: "customer", required: "required", maxlength: "200" }),
    product: h("select", { name: "product" }, cfg.products.map((p) => h("option", { value: p }, p))),
    token: h("select", { name: "token" }, cfg.tokens.map((t) => h("option", { value: t.symbol }, t.symbol))),
    amount: h("input", { name: "amount", inputmode: "decimal", placeholder: "1500.00", required: "required" }),
    days: h("input", { name: "days", type: "number", min: "1", max: "30", value: "7" }),
    description: h("textarea", { name: "description", maxlength: "2000", required: "required" }),
  };
  const result = h("div", {});
  const form = h("form", {
    class: "form",
    onsubmit: (e) => {
      e.preventDefault();
      act("Create order", async () => {
        const o = await api("POST", "/v1/admin/orders", {
          customer: f.customer.value, product: f.product.value, description: f.description.value,
          token: f.token.value, amount: f.amount.value.trim(), expiresInDays: Number(f.days.value),
        });
        state.lastOrder = o;
      });
    },
  },
  h("label", {}, "Customer", f.customer), h("label", {}, "Product", f.product), h("label", {}, "Token", f.token),
  h("label", {}, "Amount", f.amount), h("label", {}, "Expires in (days)", f.days),
  h("label", { class: "wide" }, "Description (shown to the payer)", f.description),
  h("div", {}, h("button", { type: "submit" }, "Create order")));
  if (state.lastOrder) {
    const o = state.lastOrder;
    const t = cfg.tokens.find((x) => x.symbol === o.token);
    result.append(h("div", { class: "card" },
      h("strong", {}, "New order. Send the payer this order ID and status link:"),
      h("pre", { class: "mono" }, `${o.orderId}\n${location.origin}/v1/orders/${o.orderId}\nAmount: ${t ? units(o.amount, t.decimals) : o.amount} ${o.token}, expires ${when(o.expiresAt)} UTC`),
      h("details", {}, h("summary", {}, "Payment call"), h("pre", { class: "mono" }, JSON.stringify(o.pay, null, 1)))));
  }
  return h("div", {}, form, result);
}

async function viewOrders() {
  const cfg = await paymentConfig();
  if (!cfg.enabled) return h("section", { class: "card" }, h("h2", {}, "Orders"), h("p", { class: "empty" }, "Payments are not configured on this server."));
  const status = filter("orders", "review");
  const { orders } = await api("GET", `/v1/admin/orders?status=${encodeURIComponent(status)}`);
  const resolve = (o, action) => {
    const note = ask(action === "accept" ? "Why accept this payment?" : "Refund note:", { min: 5 });
    if (!note) return;
    const body = { action, note };
    if (action === "refunded") {
      const tx = ask("Refund transaction hash (sent by the treasury multisig):", { pattern: TX, hint: "That is not a transaction hash." });
      if (!tx) return;
      body.refundTx = tx;
    }
    act(action === "accept" ? "Accept order" : "Record refund", () => api("POST", `/v1/admin/orders/${o.id}/resolve`, body));
  };
  return h("div", {},
    h("section", { class: "card" }, h("h2", {}, "New order"),
      h("p", { class: "muted" }, `Paid on chain ${cfg.chainId} through ${cfg.router}; funds go to the treasury ${cfg.treasury}. No product may change mining rewards.`),
      orderForm(cfg)),
    h("section", { class: "card" },
      h("div", { class: "row" }, h("h2", {}, "Orders"), select("status", ["review", "open", "paid", "refunded", "cancelled"], status, setFilter("orders"))),
      table([
        { label: "Created", render: (o) => when(o.created_at) },
        { label: "Customer", render: (o) => o.customer },
        { label: "Product", render: (o) => o.product },
        { label: "Price", render: (o) => money(cfg, o.amount, o.token), num: true },
        { label: "Status", render: (o) => [pill(o.status), o.review_reason ? [" ", pill(o.review_reason)] : null] },
        { label: "Paid", render: (o) => o.tx_hash ? [money(cfg, o.paid_amount, o.paid_token), " ", explorerTx(cfg.chainId, o.tx_hash)] : "" },
        { label: "Order ID", render: (o) => mono(short(o.order_id), o.order_id) },
        { label: "Expires", render: (o) => when(o.expires_at) },
        { label: "", render: (o) => h("div", { class: "row" },
          o.status === "open" ? h("button", { class: "secondary", onclick: () => { if (window.confirm("Cancel this order?")) act("Cancel order", () => api("POST", `/v1/admin/orders/${o.id}/cancel`, {})); } }, "Cancel") : null,
          o.status === "review" && o.review_reason !== "wrong_treasury" ? h("button", { onclick: () => resolve(o, "accept") }, "Accept") : null,
          o.status === "review" || o.status === "paid" ? h("button", { class: "secondary", onclick: () => resolve(o, "refunded") }, "Record refund") : null) },
      ], orders, "No orders with this status.")));
}

async function viewPayments() {
  const cfg = await paymentConfig();
  if (!cfg.enabled) return h("section", { class: "card" }, h("h2", {}, "Payments"), h("p", { class: "empty" }, "Payments are not configured on this server."));
  const outcome = filter("payments", "all");
  const q = outcome === "all" ? "" : `?outcome=${encodeURIComponent(outcome)}`;
  const { payments } = await api("GET", `/v1/admin/payments${q}`);
  return h("section", { class: "card" },
    h("div", { class: "row" }, h("h2", {}, "Payments seen on chain"),
      select("outcome", ["all", "activated", "underpaid", "wrong_token", "late", "unknown_order", "not_open", "wrong_treasury"], outcome, setFilter("payments"))),
    table([
      { label: "Block time", render: (p) => when(p.block_time) },
      { label: "Outcome", render: (p) => pill(p.outcome) },
      { label: "Amount", render: (p) => money(cfg, p.amount, p.token), num: true },
      { label: "Payer", render: (p) => mono(short(p.payer), p.payer) },
      { label: "Transaction", render: (p) => explorerTx(cfg.chainId, p.tx_hash) },
      { label: "Order ID", render: (p) => mono(short(p.order_id), p.order_id) },
      { label: "Refund", render: (p) => p.refund_tx ? [explorerTx(cfg.chainId, p.refund_tx), ` by ${p.refunded_by}`]
        : (p.outcome === "unknown_order" || p.outcome === "not_open") ? h("button", { class: "secondary", onclick: () => {
          const tx = ask("Refund transaction hash (sent by the treasury multisig):", { pattern: TX, hint: "That is not a transaction hash." });
          if (tx) act("Record refund", () => api("POST", `/v1/admin/payments/${p.id}/refunded`, { refundTx: tx }));
        } }, "Record refund") : "" },
    ], payments, "No payments with this outcome."));
}

async function viewUser() {
  const { user: u, flags, appeals, walletChanges } = await api("GET", `/v1/admin/users/${encodeURIComponent(state.userId)}`);
  const field = (label, value) => h("div", {}, h("div", { class: "muted" }, label), h("div", {}, value));
  return h("div", {},
    h("section", { class: "card" },
      h("div", { class: "row" }, h("h2", {}, u.handle), u.banned ? pill("banned") : null,
        h("button", { class: "secondary", onclick: () => { state.tab = "flags"; render(); } }, "Back"),
        u.banned ? null : h("button", { class: "danger", onclick: () => requestBan(u.id, u.handle) }, "Request ban")),
      h("div", { class: "form" },
        field("Account ID", mono(u.id)), field("Tier", `T${u.tier}`), field("Country", u.country ?? "unknown"),
        field("Joined", when(u.created_at)), field("Mining days", u.mining_days), field("Last mined day", u.last_mined_day ?? "never"),
        field("Devices", u.devices), field("Wallet", mono(u.wallet ?? "none")))),
    h("section", { class: "card" }, h("h2", {}, "Flags"), table([
      { label: "Raised", render: (f) => when(f.created_at) }, { label: "Rule", render: (f) => f.kind },
      { label: "Severity", render: (f) => pill(f.severity) }, { label: "Status", render: (f) => pill(f.status) },
      { label: "Detail", render: (f) => h("pre", { class: "mono" }, JSON.stringify(f.detail ?? {})) },
    ], flags, "No flags.")),
    h("section", { class: "card" }, h("h2", {}, "Wallet changes"), table([
      { label: "When", render: (w) => when(w.created_at) }, { label: "From", render: (w) => mono(w.from_address) },
      { label: "To", render: (w) => mono(w.to_address) }, { label: "From day", render: (w) => w.effective_day, num: true },
    ], walletChanges, "No wallet changes.")),
    h("section", { class: "card" }, h("h2", {}, "Appeals"), table([
      { label: "Sent", render: (a) => when(a.created_at) }, { label: "Message", render: (a) => h("pre", {}, a.message) },
      { label: "Status", render: (a) => pill(a.status) }, { label: "Response", render: (a) => a.response ?? "" },
    ], appeals, "No appeals.")));
}

async function viewHealth() {
  const res = await fetch("/v1/admin/health", { headers: { "x-admin-key": state.key }, credentials: "omit", cache: "no-store" });
  if (res.status === 401) {
    signOut("Your admin key was not accepted.");
    throw new ApiError("unauthorized");
  }
  const health = await res.json(); // 503 still carries the report
  const order = { critical: 0, warn: 1, ok: 2 };
  const checks = [...(health.checks ?? [])].sort((a, b) => order[a.status] - order[b.status]);
  return h("section", { class: "card" },
    h("div", { class: "row" }, h("h2", {}, "Health"), pill(health.status), h("span", { class: "muted" }, `checked ${when(health.checkedAt)} UTC`),
      h("button", { class: "secondary", onclick: () => render() }, "Refresh")),
    table([
      { label: "Check", render: (c) => c.name },
      { label: "Status", render: (c) => pill(c.status) },
      { label: "Detail", render: (c) => c.detail },
    ], checks, "No checks."));
}

const VIEWS = { health: viewHealth, flags: viewFlags, bans: viewBans, appeals: viewAppeals, settlements: viewSettlements, orders: viewOrders, payments: viewPayments, user: viewUser };

// ------------------------------------------------------------- app shell

function signOut(message) {
  state.key = "";
  state.admin = "";
  state.payCfg = null;
  try {
    sessionStorage.removeItem(KEY_STORE);
  } catch {
    // ignore
  }
  renderLogin(message);
}

function renderLogin(message) {
  $("who").textContent = "";
  $("signout").hidden = true;
  setStatus(message ?? "", message ? "error" : "");
  const input = h("input", { type: "password", autocomplete: "off", "aria-label": "Admin key", placeholder: "Admin key" });
  $("app").replaceChildren(h("section", { class: "card login" },
    h("h2", {}, "Sign in"),
    h("p", { class: "muted" }, "Your key stays in this tab only and is cleared when the tab closes."),
    h("form", { class: "row", onsubmit: async (e) => {
      e.preventDefault();
      state.key = input.value.trim();
      input.value = "";
      try {
        await signIn();
      } catch (err) {
        if (!(err instanceof ApiError && err.message === "unauthorized")) setStatus(`Sign-in failed: ${err.message}`, "error");
      }
    } }, input, h("button", { type: "submit" }, "Sign in"))));
  input.focus();
}

async function signIn() {
  const { admin } = await api("GET", "/v1/admin/me");
  state.admin = admin;
  try {
    sessionStorage.setItem(KEY_STORE, state.key);
  } catch {
    // ignore
  }
  $("who").textContent = `signed in as ${admin}`;
  $("signout").hidden = false;
  setStatus("");
  await render();
}

async function render() {
  const nav = h("nav", { class: "tabs" }, TABS.map(([id, label]) =>
    h("button", { type: "button", "aria-current": state.tab === id ? "page" : null, onclick: () => { state.tab = id; render(); } }, label)));
  const body = h("div", {}, h("p", { class: "muted" }, "Loading…"));
  $("app").replaceChildren(nav, body);
  try {
    body.replaceChildren(await VIEWS[state.tab]());
  } catch (e) {
    if (e instanceof ApiError && e.message === "unauthorized") return;
    body.replaceChildren(h("p", { class: "status error show" }, `Could not load: ${e.message}`));
  }
}

$("signout").addEventListener("click", () => signOut());
if (state.key) signIn().catch(() => signOut("Please sign in again."));
else renderLogin();
