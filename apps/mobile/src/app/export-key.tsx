import { useCallback, useEffect, useRef, useState } from "react";
import { View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { router } from "expo-router";
import { exportWalletKey, remember } from "@/lib/core";
import { useApp } from "@/lib/app-state";
import { hideFromCapture, showToCapture } from "@/lib/screen-capture";
import { clearCopiedKey } from "@/lib/wallet-key";
import { colors, radius, space } from "@/design/tokens";
import { Button, Notice, Screen, T, TopBar } from "@/components/ui";
import { SignedIn } from "@/components/SignedIn";

/** How long a copied key stays in the clipboard. */
const CLIPBOARD_MS = 60_000;
const CAPTURE = "export-key";

/** Self-custody means the user can take their key anywhere. It is shown only on request. */
export default function ExportKeyScreen() {
  return (
    <SignedIn>
      <ExportKey />
    </SignedIn>
  );
}

function ExportKey() {
  const { t, me } = useApp();
  const [key, setKey] = useState<string | null>(null);
  // The key of the account's wallet may be kept elsewhere: in the app when this is a browser, or on another device.
  const [missing, setMissing] = useState(false);
  const [copied, setCopied] = useState(false);
  // The key this screen copied, until it is taken out of the clipboard again.
  const held = useRef<{ key: string; timer: ReturnType<typeof setTimeout> } | null>(null);
  const back = () => (router.canGoBack() ? router.back() : router.replace("/wallet"));

  // Anything the person copied since stays: the clipboard is emptied only while it still holds the key.
  const forget = useCallback(() => {
    const was = held.current;
    if (!was) return;
    held.current = null;
    clearTimeout(was.timer);
    setCopied(false);
    void clearCopiedKey(Clipboard, was.key);
  }, []);

  // Leaving the screen takes the key out of the clipboard and lets the screen be captured again.
  useEffect(() => () => {
    forget();
    showToCapture(CAPTURE);
  }, [forget]);

  const copy = async (k: string) => {
    if (held.current) clearTimeout(held.current.timer);
    held.current = { key: k, timer: setTimeout(forget, CLIPBOARD_MS) };
    await Clipboard.setStringAsync(k);
    setCopied(true);
  };

  return (
    <Screen edges={["top", "bottom"]} width="column">
      <TopBar title={t("exportKey")} onBack={back} backLabel={t("back")} />
      <Notice tone="warning">{t("exportWarning")}</Notice>
      {key ? (
        <>
          <View style={{ backgroundColor: colors.surface, borderRadius: radius.md, borderWidth: 1, borderColor: colors.lineStrong, padding: space.lg }}>
            <T variant="mono" selectable style={{ fontSize: 15, lineHeight: 24 }}>{key}</T>
          </View>
          <Button
            title={copied ? t("copied") : t("copy")}
            kind="secondary"
            icon={copied ? "check" : "copy"}
            onPress={() => copy(key)}
          />
          {/* The wallet screen marks the key as not backed up until the person says it is kept somewhere else. */}
          <Button
            title={t("savedKey")}
            icon="check"
            onPress={async () => {
              if (me?.wallet) await remember(`backup.${me.wallet.toLowerCase()}`, "1");
              back();
            }}
          />
        </>
      ) : missing ? (
        <Notice>{t("noKeyHere")}</Notice>
      ) : (
        <Button
          title={t("reveal")}
          kind="danger"
          onPress={async () => {
            // Hidden from capture before the key is on the screen, so a recording that is already running gets no frame of it.
            await hideFromCapture(CAPTURE);
            const k = me ? await exportWalletKey(me).catch(() => null) : null;
            setKey(k);
            setMissing(k === null);
            if (k === null) showToCapture(CAPTURE);
          }}
        />
      )}
    </Screen>
  );
}
