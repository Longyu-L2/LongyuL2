/**
 * The pages of contract verification: the form, the state of a request, and the Contract tab of an
 * address. A source is someone's text: like every other value it reaches a page through `html`,
 * which escapes it.
 */
import type { VerifiedRow } from "../queries.ts";
import { COMPILERS } from "../verify/compilers.ts";
import { EVM_VERSIONS } from "../verify/input.ts";
import type { Job } from "../verify/service.ts";
import { formatNumber, utc } from "./format.ts";
import { addressPath, html, SafeHtml } from "./html.ts";

/** The form's fields, named as Etherscan's API names them: the page posts what Foundry posts. */
export type VerifyForm = Partial<Record<"contractaddress" | "compilerversion" | "codeformat" | "contractname" | "optimizationUsed" | "runs" | "evmversion" | "viaIR" | "sourceCode", string>>;

/** A file's text is shown up to this length; the API gives all of it. */
export const SOURCE_SHOWN = 256 * 1024;
/** The largest file the page's file button reads into the form. */
const FILE_BYTES = 2 * 1024 * 1024;

const SELECTED = new SafeHtml(" selected");
const CHECKED = new SafeHtml(" checked");
const option = (value: string, label: string, chosen: boolean) => html`<option value="${value}"${chosen ? SELECTED : ""}>${label}</option>`;

export function verifyPage(form: VerifyForm, error?: string): SafeHtml {
  const compiler = form.compilerversion?.replace(/^v/, "") ?? "";
  const json = form.codeformat === "solidity-standard-json-input";
  const evm = form.evmversion ?? "";
  // A form that comes back with an error keeps its choices; a new one starts with the optimizer on, as the compiler's tools do.
  const optimizer = form.optimizationUsed === undefined ? form.sourceCode === undefined : form.optimizationUsed === "1";
  return html`<h1>Verify contract</h1>
  ${error ? html`<p class="form-error" role="alert">${error}</p>` : ""}
  <form class="card form" action="/verify" method="post" id="verify-form" data-file-bytes="${FILE_BYTES}">
    <label>Contract address<input name="contractaddress" value="${form.contractaddress ?? ""}" placeholder="0x" required pattern="0x[0-9a-fA-F]{40}" maxlength="42" autocomplete="off" spellcheck="false" class="mono"></label>
    <div class="form-row">
      <label>Compiler<select name="compilerversion">${COMPILERS.map((c) => option(`v${c.long}`, `v${c.long}`, c.long === compiler || c.version === compiler))}</select></label>
      <label>Format<select name="codeformat" id="verify-format">
        ${option("solidity-single-file", "Single file", !json)}
        ${option("solidity-standard-json-input", "Standard JSON input", json)}
      </select></label>
    </div>
    <label>Contract name<input name="contractname" value="${form.contractname ?? ""}" placeholder="src/Token.sol:Token" required maxlength="640" autocomplete="off" spellcheck="false"></label>
    <fieldset id="verify-single"${json ? new SafeHtml(" hidden") : ""}>
      <legend>Single file settings</legend>
      <div class="form-row four">
        <label>Optimizer<select name="optimizationUsed">${option("1", "On", optimizer)}${option("0", "Off", !optimizer)}</select></label>
        <label>Runs<input name="runs" value="${form.runs ?? "200"}" inputmode="numeric" pattern="[0-9]{1,10}" maxlength="10" autocomplete="off"></label>
        <label>EVM version<select name="evmversion">${option("default", "Compiler default", evm === "" || evm === "default")}${[...EVM_VERSIONS].reverse().map((v) => option(v, v, v === evm))}</select></label>
        <label class="check"><input type="checkbox" name="viaIR" value="1"${form.viaIR === "1" ? CHECKED : ""}>Via IR</label>
      </div>
    </fieldset>
    <label>Source<textarea name="sourceCode" id="verify-source" rows="14" required spellcheck="false" autocomplete="off" class="mono">${form.sourceCode ?? ""}</textarea></label>
    <div class="form-end">
      <button class="button" type="submit">Verify</button>
      <button class="button line" type="button" id="verify-file" hidden>Choose file</button>
      <input type="file" id="verify-file-input" accept=".sol,.json,text/plain,application/json" hidden>
      <span class="muted" id="verify-note" role="status"></span>
    </div>
  </form>`;
}

export function verifyStatusPage(job: Job): SafeHtml {
  const where = html`<p class="mono break lead"><a href="${addressPath(job.address)}">${job.address}</a></p>`;
  if (job.state === "pending") return html`<h1>Verification</h1>${where}<section class="card"><p class="waiting">In the queue</p></section>`;
  return html`<h1>Verification failed</h1>${where}
  <section class="card"><p class="form-error flat">${job.reason ?? "The contract could not be verified"}</p></section>
  <p><a class="button" href="${`/verify?address=${job.address}`}">Try again</a></p>`;
}

export interface ContractTab {
  /** The code at the address. */
  code: string;
  verified: VerifiedRow | null;
  /** Which of the source files to show; null for the one that defines the contract. */
  file: number | null;
  /** Whether the explorer is taking verifications. */
  canVerify: boolean;
}

const bytecode = (code: string) =>
  html`<details class="card raw"><summary>Deployed bytecode <span class="muted">${formatNumber((code.length - 2) / 2)} bytes</span></summary><pre class="mono break">${code}</pre></details>`;

/** The files of a stored standard JSON input, in its order. */
function sources(input: string): [string, string][] {
  try {
    const parsed = JSON.parse(input) as { sources?: Record<string, { content?: unknown }> };
    return Object.entries(parsed.sources ?? {}).map(([path, s]) => [path, typeof s?.content === "string" ? s.content : ""]);
  } catch {
    return [];
  }
}

export function contractTab(address: string, c: ContractTab): SafeHtml {
  const v = c.verified;
  if (!v) {
    return html`<section class="card unverified"><span>Source not verified</span>${c.canVerify ? html`<a class="button" href="${`/verify?address=${address}`}">Verify</a>` : ""}</section>
    ${bytecode(c.code)}`;
  }
  const files = sources(v.input);
  const own = Math.max(0, files.findIndex(([path]) => path === v.file));
  const at = c.file !== null && c.file < files.length ? c.file : own;
  const [path, text] = files[at] ?? ["", ""];
  const rows: [string, unknown][] = [
    ["Name", html`<strong class="verified">${v.name}</strong>`],
    ["Compiler", html`<span class="mono">v${v.compiler}</span>`],
    ["Optimizer", v.optimizer ? `${v.runs === null ? "On" : `${formatNumber(v.runs)} runs`}` : "Off"],
    ["EVM version", v.evm_version ?? "Compiler default"],
    ["Match", v.match_kind === "full" ? "Full" : "Partial"],
    ["Checked against", v.creation_checked ? "Deployed code and creation transaction" : "Deployed code"],
    ["Constructor arguments", v.constructor_args ? html`<span class="mono break">${v.constructor_args}</span>` : null],
    ["Verified", utc(v.verified_at)],
  ];
  return html`<section class="card"><dl class="kv">${rows.filter(([, value]) => value !== null).map(([k, value]) => html`<dt>${k}</dt><dd>${value}</dd>`)}</dl></section>
  <section class="card source">
    <header class="card-h"><h2 class="mono break">${path}</h2><button class="copy" type="button" data-copy-from="source-text" aria-label="Copy source"></button></header>
    ${files.length > 1 ? html`<nav class="files" aria-label="Source files">${files.map(([p], i) => html`<a href="${`${addressPath(address)}?tab=contract&file=${i}`}" class="${i === at ? "on" : ""}">${p}</a>`)}</nav>` : ""}
    ${text.length > SOURCE_SHOWN ? html`<p class="muted">The first ${formatNumber(SOURCE_SHOWN)} of ${formatNumber(text.length)} characters.</p>` : ""}
    <pre class="mono code" id="source-text">${text.slice(0, SOURCE_SHOWN)}</pre>
  </section>
  <details class="card raw"><summary>ABI<button class="copy" type="button" data-copy-from="abi-text" aria-label="Copy ABI"></button></summary><pre class="mono break" id="abi-text">${v.abi.slice(0, SOURCE_SHOWN)}</pre></details>
  ${bytecode(c.code)}`;
}
