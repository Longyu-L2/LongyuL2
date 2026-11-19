import { useEffect } from "react";
import { View } from "react-native";
import { WebView } from "react-native-webview";
import { config } from "@/lib/core";
import { useApp } from "@/lib/app-state";
import { colors, radius } from "@/design/tokens";
import { Button, T } from "./ui";
import { Sheet } from "./Sheet";

/**
 * The occasional human check before a session starts: a Cloudflare Turnstile widget in a WebView.
 * Development builds without a site key pass automatically with the backend's "dev-pass" token.
 */
export function PulseCheck({ visible, title, onToken, onCancel }: {
  visible: boolean;
  title: string;
  onToken: (token: string) => void;
  onCancel: () => void;
}) {
  const { t } = useApp();
  useEffect(() => {
    if (visible && !config.turnstileSiteKey) onToken("dev-pass");
  }, [visible, onToken]);
  if (!config.turnstileSiteKey) return null;

  const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script></head>
<body style="margin:0;display:flex;align-items:center;justify-content:center;height:100vh;background:transparent">
<div class="cf-turnstile" data-sitekey="${config.turnstileSiteKey}" data-theme="light" data-callback="done"></div>
<script>function done(t){window.ReactNativeWebView.postMessage(t)}</script></body></html>`;

  return (
    <Sheet visible={visible} title={title} onClose={onCancel} closeLabel={t("cancel")}>
      <View style={{ height: 80, borderRadius: radius.md, overflow: "hidden", backgroundColor: colors.surface }}>
        <WebView
          originWhitelist={["https://*"]}
          source={{ html, baseUrl: "https://longyu.network" }}
          onMessage={(e) => onToken(e.nativeEvent.data)}
          style={{ backgroundColor: "transparent" }}
        />
      </View>
      <Button title={t("cancel")} kind="secondary" onPress={onCancel} />
      <T variant="small" color={colors.textFaint} center>{t("turnstileNote")}</T>
    </Sheet>
  );
}
