import { useState, type ReactNode } from "react";
import { View } from "react-native";
import { Redirect, router } from "expo-router";
import { signOut } from "@/lib/core";
import { useApp } from "@/lib/app-state";
import { colors, space } from "@/design/tokens";
import { PearlMark } from "./Pearl";
import { Button, Screen, T } from "./ui";

/**
 * The screens behind sign-in sit inside this. In a browser any screen's address can be opened
 * directly, and on a phone a session can end while a screen is open: it waits for the stored
 * session to load, sends a signed-out visitor to sign-in, and offers another try while the account
 * has not loaded.
 */
export function SignedIn({ children, setUp = false }: {
  children: ReactNode;
  /** Also send an account that still needs its device check or wallet to account setup. */
  setUp?: boolean;
}) {
  const { ready, signedIn, me } = useApp();
  if (!ready) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.bg }}>
        <PearlMark size={56} />
      </View>
    );
  }
  if (!signedIn) return <Redirect href="/sign-in" />;
  if (!me) return <LoadRetry />;
  if (setUp && (!me.deviceAttested || !me.wallet)) return <Redirect href="/setup" />;
  return children;
}

/** Signed in, but the account did not load (no connection, or the API is down): try again, or leave. */
export function LoadRetry() {
  const { t, refreshMe, setSignedIn } = useApp();
  const [busy, setBusy] = useState(false);
  const retry = async () => {
    setBusy(true);
    await refreshMe();
    setBusy(false);
  };
  const leave = async () => {
    await signOut();
    setSignedIn(false);
    router.replace("/sign-in");
  };
  return (
    <Screen width="column" center>
      <View style={{ alignItems: "center", gap: space.xl }}>
        <PearlMark size={56} />
        <T color={colors.textSoft} center>{t("loadFailed")}</T>
      </View>
      <View style={{ gap: space.md }}>
        <Button title={t("retry")} onPress={() => void retry()} busy={busy} />
        <Button title={t("signOut")} kind="ghost" size="sm" onPress={() => void leave()} disabled={busy} />
      </View>
    </Screen>
  );
}
