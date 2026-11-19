/**
 * HTML built from tagged templates that escape every interpolated value by default. Chain data
 * (token names, symbols, calldata, revert strings) is written by anyone, so nothing reaches a page
 * unescaped; only markup produced by `html` itself is trusted. Links are built from validated hex
 * by the helpers below, never from free text.
 */
export class SafeHtml {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;", "`": "&#96;" };

export function esc(s: string): string {
  return s.replace(/[&<>"'`]/g, (c) => ESCAPES[c]!);
}

function render(v: unknown): string {
  if (v instanceof SafeHtml) return v.value;
  if (Array.isArray(v)) return v.map(render).join("");
  if (v === null || v === undefined || v === false) return "";
  return esc(String(v));
}

export function html(strings: TemplateStringsArray, ...values: unknown[]): SafeHtml {
  let out = strings[0]!;
  values.forEach((v, i) => {
    out += render(v) + strings[i + 1]!;
  });
  return new SafeHtml(out);
}

const ADDRESS = /^0x[0-9a-f]{40}$/;
const HASH = /^0x[0-9a-f]{64}$/;

export const isAddress = (s: string) => ADDRESS.test(s);
export const isHash = (s: string) => HASH.test(s);

export const addressPath = (a: string) => (ADDRESS.test(a) ? `/address/${a}` : "/");
export const tokenPath = (a: string) => (ADDRESS.test(a) ? `/token/${a}` : "/");
export const txPath = (h: string) => (HASH.test(h) ? `/tx/${h}` : "/");
export const blockPath = (n: bigint | number | string) => (/^\d+$/.test(String(n)) ? `/block/${n}` : "/");
