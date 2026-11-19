/**
 * The human check in a browser: Cloudflare Turnstile in a small dialog drawn straight into the
 * page. Only the web build's files import this (it needs a document); the app shows the same check
 * in a WebView (components/PulseCheck.tsx).
 */
import { colors, fonts, radius, space } from "../design/tokens";

const SCRIPT = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
const WIDGET_WIDTH = 300;

interface Turnstile {
  render(container: HTMLElement, options: Record<string, unknown>): string;
  remove(widgetId: string): void;
}

let loading: Promise<Turnstile> | null = null;

/** Loads Cloudflare's script once. A failed load is forgotten, so the next check tries again. */
function loadTurnstile(): Promise<Turnstile> {
  loading ??= new Promise<Turnstile>((resolve, reject) => {
    const el = document.createElement("script");
    const fail = () => {
      el.remove();
      loading = null;
      reject(new Error("the human check could not load"));
    };
    el.src = SCRIPT;
    el.async = true;
    el.onload = () => {
      const turnstile = (window as unknown as { turnstile?: Turnstile }).turnstile;
      if (turnstile) resolve(turnstile);
      else fail();
    };
    el.onerror = fail;
    document.head.appendChild(el);
  });
  return loading;
}

export interface HumanCheckText {
  title: string;
  cancel: string;
  note: string;
  /** Shown in the dialog when the check cannot load or reports an error. */
  failed: string;
}

export interface HumanCheck {
  /** The token to send to the API. Rejects when the person cancels or the dialog is closed first. */
  token: Promise<string>;
  /** Takes the dialog away. Safe to call more than once, and after the token has arrived. */
  close: () => void;
}

function make<K extends keyof HTMLElementTagNameMap>(tag: K, style: Partial<CSSStyleDeclaration>, text?: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  Object.assign(el.style, style);
  if (text !== undefined) el.textContent = text;
  return el;
}

/** Opens the dialog and starts the check. */
export function openHumanCheck(siteKey: string, text: HumanCheckText): HumanCheck {
  let settled = false;
  let closed = false;
  let widget: { turnstile: Turnstile; id: string } | null = null;
  let resolve!: (token: string) => void;
  let reject!: (reason: Error) => void;
  const token = new Promise<string>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // The caller may only ever look at `close`; an unread rejection must not surface as an error.
  token.catch(() => undefined);

  // Cloudflare's widget is 300 wide, which the dialog has room for on a screen of 360 and up; a
  // narrower one gets the compact widget (150 by 140).
  const compact = window.innerWidth < WIDGET_WIDTH + 2 * (space.md + space.lg + 1);
  const scrim = make("div", {
    position: "fixed", inset: "0", zIndex: "2147483000", display: "flex", alignItems: "center", justifyContent: "center",
    padding: `${space.md}px`, backgroundColor: colors.scrim, boxSizing: "border-box",
  });
  const card = make("div", {
    width: "100%", maxWidth: "360px", boxSizing: "border-box", display: "flex", flexDirection: "column", gap: `${space.lg}px`,
    padding: `${space.lg}px`, borderRadius: `${radius.lg}px`, border: `1px solid ${colors.lineStrong}`, backgroundColor: colors.bgRaised,
  });
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-modal", "true");
  card.setAttribute("aria-label", text.title);
  const title = make("div", { fontFamily: fonts.strong, fontSize: "17px", lineHeight: "22px", color: colors.text }, text.title);
  const slot = make("div", { minHeight: compact ? "140px" : "65px", display: "flex", alignItems: "center", justifyContent: "center" });
  const problem = make("div", { display: "none", fontFamily: fonts.body, fontSize: "13px", lineHeight: "18px", color: colors.danger }, text.failed);
  problem.setAttribute("role", "alert");
  const cancel = make("button", {
    height: "48px", border: "0", borderRadius: `${radius.md}px`, cursor: "pointer", backgroundColor: colors.surfaceHigh, color: colors.text,
    fontFamily: fonts.strong, fontSize: "15px",
  }, text.cancel);
  cancel.type = "button";
  const note = make("div", { fontFamily: fonts.body, fontSize: "12px", lineHeight: "16px", color: colors.textFaint, textAlign: "center" }, text.note);
  card.append(title, slot, problem, cancel, note);
  scrim.append(card);

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") close();
  };

  function close(): void {
    if (closed) return;
    closed = true;
    document.removeEventListener("keydown", onKey);
    if (widget) {
      try {
        widget.turnstile.remove(widget.id);
      } catch {
        // The widget is gone with the dialog either way.
      }
    }
    scrim.remove();
    if (!settled) {
      settled = true;
      reject(new Error("the human check was not completed"));
    }
  }

  cancel.onclick = close;
  scrim.onclick = (e) => {
    if (e.target === scrim) close();
  };
  document.addEventListener("keydown", onKey);
  document.body.appendChild(scrim);
  cancel.focus();

  const showProblem = () => {
    problem.style.display = "block";
  };
  loadTurnstile().then(
    (turnstile) => {
      if (closed) return;
      try {
        const id = turnstile.render(slot, {
          sitekey: siteKey,
          theme: "light",
          size: compact ? "compact" : "normal",
          callback: (value: string) => {
            if (settled) return;
            settled = true;
            resolve(value);
            close();
          },
          "error-callback": () => {
            showProblem();
            return true;
          },
        });
        widget = { turnstile, id };
      } catch {
        showProblem();
      }
    },
    showProblem,
  );

  return { token, close };
}
