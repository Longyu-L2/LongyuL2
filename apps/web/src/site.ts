/** What the landing page and the developer page share: the bar, its phone menu, the copy buttons and the wallet button. */
import { walletChain, type LandingConfig } from "./landing-core.ts";

export const $ = (id: string) => document.getElementById(id)!;

export function topBar(): void {
  // The bar takes a ground of its own once the page moves under it.
  const top = $("top");
  const moved = () => top.classList.toggle("moved", window.scrollY > 8);
  window.addEventListener("scroll", moved, { passive: true });
  moved();

  // On a phone the bar's links open as a sheet under it. The button shows only once this script runs.
  const menuButton = $("menu-button");
  const setMenu = (open: boolean) => {
    top.classList.toggle("open", open);
    document.documentElement.classList.toggle("menu-open", open);
    menuButton.setAttribute("aria-expanded", String(open));
    menuButton.setAttribute("aria-label", open ? "Close the menu" : "Open the menu");
  };
  menuButton.hidden = false;
  menuButton.addEventListener("click", () => setMenu(!top.classList.contains("open")));
  $("menu").addEventListener("click", (e) => {
    if ((e.target as Element).closest("a")) setMenu(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !top.classList.contains("open")) return;
    setMenu(false);
    menuButton.focus();
  });
  window.matchMedia("(min-width: 981px)").addEventListener("change", (e) => e.matches && setMenu(false));
}

/** A button copies the text it carries (data-copy), or the text of the element it names (data-copy-from). */
export function copyButtons(): void {
  document.querySelectorAll<HTMLButtonElement>("button[data-copy], button[data-copy-from]").forEach((button) => {
    button.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(button.dataset.copy ?? document.getElementById(button.dataset.copyFrom ?? "")?.textContent ?? "");
        button.textContent = "Copied";
      } catch {
        button.textContent = "Not copied";
      }
      setTimeout(() => (button.textContent = "Copy"), 1500);
    });
  });
}

interface Wallet {
  request(call: { method: string; params?: unknown[] }): Promise<unknown>;
}

export function walletButton(config: LandingConfig | null): void {
  $("add-network").addEventListener("click", async () => {
    const note = $("add-note");
    const wallet = (window as { ethereum?: Wallet }).ethereum;
    if (!config) return void (note.textContent = "The network details are not available.");
    if (!wallet) return void (note.textContent = "No wallet found in this browser.");
    note.textContent = "Confirm in your wallet.";
    try {
      await wallet.request({ method: "wallet_addEthereumChain", params: [walletChain(config)] });
      note.textContent = `${config.chainName} is in your wallet.`;
    } catch (e) {
      note.textContent = (e as { code?: number }).code === 4001 ? "Cancelled in the wallet." : "The wallet did not add the network.";
    }
  });
}
