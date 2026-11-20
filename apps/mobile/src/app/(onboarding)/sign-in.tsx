import { useState } from "react";
import { Platform, StyleSheet, View } from "react-native";
import { router } from "expo-router";
import { signIn, signInFailure } from "@/lib/core";
import { useApp } from "@/lib/app-state";
import { errorKeyOf } from "@/lib/errors";
import { invitedWith } from "@/lib/invite-link";
import { embeddedBrowser } from "@/lib/x-auth";
import { colors, radius, space } from "@/design/tokens";
import { useWide } from "@/design/layout";
import { Brand, Button, ErrorText, Input, Notice, Screen, T } from "@/components/ui";
import { Pearl } from "@/components/Pearl";

export default function SignInScreen() {
  const { t, setSignedIn, refreshMe } = useApp();
  const wide = useWide();
  // Someone who came by an invite link finds its code filled in.
  const [invite, setInvite] = useState(() => invitedWith());
  const [busy, setBusy] = useState(false);
  // In a browser the page comes back from X as a fresh load: a sign-in that failed there is reported here.
  const [error, setError] = useState(() => {
    const back = signInFailure();
    return back ? t(errorKeyOf(back)) : "";
  });
  // A browser inside another app can pass the visit to X to a different browser, which comes back
  // without this one's secret. A page added to the home screen is not one of those.
  const embedded = Platform.OS === "web" && embeddedBrowser(navigator.userAgent) && !(navigator as { standalone?: boolean }).standalone;

  const start = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      // False when the person closed the X page: nothing to report.
      if (!(await signIn(invite.trim() || undefined))) return;
      setSignedIn(true);
      await refreshMe();
      router.replace("/setup");
    } catch (e) {
      setError(t(errorKeyOf(e)));
    } finally {
      setBusy(false);
    }
  };

  const form = (
    <View style={{ gap: space.md }}>
      <Input
        value={invite}
        onChangeText={setInvite}
        placeholder={t("inviteLabel")}
        autoCapitalize="characters"
        autoCorrect={false}
        maxLength={16}
        editable={!busy}
        accessibilityLabel={t("inviteLabel")}
      />
      <Button title={t("continueWithX")} onPress={() => void start()} busy={busy} />
      <ErrorText>{error}</ErrorText>
      {embedded && !error ? <Notice tone="warning">{t("openInBrowser")}</Notice> : null}
      {Platform.OS === "web" ? (
        // The site that serves this page also holds the app (apps/mobile/site/server.mjs).
        <Button title={t("getAndroidApp")} kind="ghost" size="sm" icon="download" onPress={() => window.location.assign("/download/android")} />
      ) : null}
    </View>
  );

  if (wide) {
    return (
      <Screen center>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 72 }}>
          <View style={{ flex: 1, alignItems: "center", gap: space.xxxl }}>
            <Pearl state="ready" progress={0} size={320} label="LONGYU" />
            <View style={{ alignItems: "center", gap: space.md }}>
              <Brand size={30} />
              <T color={colors.textSoft} center>{t("tagline")}</T>
            </View>
          </View>
          <View style={styles.panel}>
            <T variant="title" accessibilityRole="header">{t("signInTitle")}</T>
            {form}
            <T variant="small" color={colors.textFaint}>{t("testnetNotice")}</T>
          </View>
        </View>
      </Screen>
    );
  }

  return (
    <Screen center>
      <View style={{ alignItems: "center", gap: space.xxl }}>
        <Pearl state="ready" progress={0} size={176} label="LONGYU" />
        <View style={{ alignItems: "center", gap: space.md }}>
          <Brand size={24} />
          <T color={colors.textSoft} center>{t("tagline")}</T>
        </View>
      </View>
      {form}
      <T variant="small" color={colors.textFaint} center>{t("testnetNotice")}</T>
    </Screen>
  );
}

const styles = StyleSheet.create({
  panel: {
    width: 400, gap: space.xl, padding: space.xxxl,
    backgroundColor: colors.bgRaised, borderRadius: radius.xl, borderWidth: 1, borderColor: colors.line,
  },
});
