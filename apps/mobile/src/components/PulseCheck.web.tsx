import { useEffect, useRef } from "react";
import { config } from "@/lib/core";
import { useApp } from "@/lib/app-state";
import { openHumanCheck } from "@/lib/human-check-dom";

/**
 * The human check before a session, in a browser: Cloudflare Turnstile in a dialog on the page
 * itself (the app needs a WebView for it). Builds without a site key pass with "dev-pass".
 */
export function PulseCheck({ visible, title, onToken, onCancel }: {
  visible: boolean;
  title: string;
  onToken: (token: string) => void;
  onCancel: () => void;
}) {
  const { t } = useApp();
  // The dialog outlives renders: it always reports to the handlers of the latest one.
  const handlers = useRef({ onToken, onCancel });
  handlers.current = { onToken, onCancel };

  useEffect(() => {
    if (!visible) return;
    if (!config.turnstileSiteKey) {
      handlers.current.onToken("dev-pass");
      return;
    }
    let current = true;
    const check = openHumanCheck(config.turnstileSiteKey, { title, cancel: t("cancel"), note: t("turnstileNote"), failed: t("humanCheckFailed") });
    check.token.then(
      (token) => current && handlers.current.onToken(token),
      () => current && handlers.current.onCancel(),
    );
    return () => {
      current = false;
      check.close();
    };
  }, [visible, title, t]);

  return null;
}
