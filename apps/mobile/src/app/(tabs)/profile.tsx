import { useState } from "react";
import { Platform, Share, View } from "react-native";
import Constants from "expo-constants";
import * as Clipboard from "expo-clipboard";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import { router } from "expo-router";
import { api, ApiError, signOut } from "@/lib/core";
import { useApp } from "@/lib/app-state";
import { errorKeyOf } from "@/lib/errors";
import { useResource } from "@/lib/resources";
import { boostPercent, fill, shortAddress, tierKey } from "@/lib/format";
import { inviteLinkFor } from "@/lib/invite-link";
import { colors, space } from "@/design/tokens";
import { Avatar, Button, Callout, Card, Col, Columns, Divider, ErrorText, Header, Input, List, Metrics, Notice, Pill, Row, Screen, Section, T } from "@/components/ui";
import { Sheet } from "@/components/Sheet";

// Reminders are delivered through Expo's push service, which needs the project ID that `eas init`
// writes into app.json. A build without one cannot register a phone, so it shows no reminders row.
const pushProjectId = (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas?.projectId;

// A browser shares through its own share sheet, where it has one (phones, Safari); the code can always be copied.
const canShare = Platform.OS !== "web" || (typeof navigator !== "undefined" && typeof navigator.share === "function");

/** What today's counted invites add to the account's mining, in bps. Absent from an API without the invite bonus. */
type InviteBonus = { active: number; bps: number; bpsEach: number; capBps: number };

const inviteRow = { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: space.sm, paddingHorizontal: space.lg, paddingVertical: 14 } as const;

/** A count from the API, or a dash while it is not known. */
const count = (v: string | number | undefined) => (v !== undefined && Number.isFinite(Number(v)) ? Number(v).toLocaleString("en-US") : "–");

export default function ProfileScreen() {
  const { t, me, network, refreshMe, setSignedIn } = useApp();
  const status = useResource<{ streakDays: number; invites?: InviteBonus }>("/v1/mining/status").data;
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");
  const [appeal, setAppeal] = useState("");
  const [appealOpen, setAppealOpen] = useState(false);
  const [appealError, setAppealError] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<"" | "code" | "link">("");

  /** Runs one action. Its error shows on the page, or through `show` where the action sits in a sheet. */
  const run = (fn: () => Promise<void>, show: (text: string) => void = setError) => async () => {
    setBusy(true);
    setError("");
    setMsg("");
    show("");
    try {
      await fn();
    } catch (e) {
      show(t(errorKeyOf(e)));
    } finally {
      setBusy(false);
    }
  };

  const verify = run(async () => {
    const s = await api<{ provider?: string; status?: string }>("POST", "/v1/verification/session");
    // Development backend only: approve immediately with this install as the identity.
    if (s.provider === "dev") await api("POST", "/v1/verification/dev/approve", { uniqueKey: me?.id ?? "dev" });
    else if (s.status !== "already_verified") throw new ApiError(403, "verification_unavailable");
    await refreshMe();
  });

  const enableReminders = run(async () => {
    if (!Device.isDevice) throw new ApiError(400, "device_required");
    if (Platform.OS === "android") {
      await Notifications.setNotificationChannelAsync("default", { name: t("notifications"), importance: Notifications.AndroidImportance.DEFAULT });
    }
    const perm = await Notifications.requestPermissionsAsync();
    if (!perm.granted) return;
    const { data } = await Notifications.getExpoPushTokenAsync({ projectId: pushProjectId });
    await api("POST", "/v1/push/register", { token: data });
    setMsg(t("remindersOn"));
  });

  const sendAppeal = run(async () => {
    await api("POST", "/v1/appeals", { message: appeal });
    setAppeal("");
    setAppealOpen(false);
    setMsg(t("appealSent"));
  }, setAppealError);

  const copy = async (what: "code" | "link", text: string) => {
    await Clipboard.setStringAsync(text);
    setCopied(what);
    setTimeout(() => setCopied(""), 1600);
  };
  // Closing the share sheet without sharing is not an error.
  const share = (message: string) => void Share.share({ message }).catch(() => undefined);

  // In a browser an invite is a link to this site; the app shares the code.
  const link = me ? inviteLinkFor(me.referralCode) : "";
  // Shown while the invite bonus is running.
  const bonus = status?.invites && status.invites.bpsEach > 0 ? status.invites : null;

  const verified = Boolean(me && me.tier >= 2);
  const since = me && Number(me.createdAt) > 0 ? new Date(Number(me.createdAt) * 1000).toLocaleDateString(undefined, { month: "short", year: "numeric" }) : "";
  const byline = [me?.xUsername ? `@${me.xUsername}` : "", since ? fill(t("joined"), { date: since }) : ""].filter(Boolean).join(" · ");

  return (
    <Screen footer={<T variant="small" color={colors.textFaint}>{`LONGYU MINE ${Constants.expoConfig?.version ?? ""}`}</T>}>
      <Header title={t("tabProfile")} />

      <Columns>
        <Col>
          <Card padding={0} style={{ gap: 0 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: space.lg, paddingHorizontal: space.lg, paddingVertical: space.xl }}>
              <Avatar name={me?.handle ?? ""} uri={me?.avatarUrl} size={68} />
              <View style={{ flex: 1, minWidth: 0, gap: 6 }}>
                <View style={{ gap: 2 }}>
                  <T variant="headline" numberOfLines={1} style={{ fontSize: 19, lineHeight: 25 }}>{me?.handle ?? " "}</T>
                  <T variant="label" color={colors.textSoft} numberOfLines={1}>{byline || " "}</T>
                </View>
                {me ? <Pill tone={verified ? "positive" : "primary"} text={t(tierKey(me.tier))} /> : null}
              </View>
            </View>
            <Metrics
              bare
              columns={3}
              items={[
                { label: t("streak"), value: status ? String(status.streakDays) : "–", unit: t("daysShort") },
                { label: t("daysMined"), value: count(me?.miningDays) },
                { label: t("invites"), value: count(me?.invites) },
              ]}
            />
            {me?.wallet ? (
              <List bare>
                <Row title={t("tabWallet")} right={<T variant="mono" color={colors.textSoft}>{shortAddress(me.wallet)}</T>} onPress={() => router.push("/wallet")} chevron />
              </List>
            ) : null}
          </Card>

          {/* Mining needs no identity check. It is asked for before mainnet conversion, once checks are open. */}
          {me && !verified && network?.verificationOpen ? (
            <Callout icon="shield" title={t("verifyIdentity")} body={t("verifyBody")} action={<Button size="sm" title={t("verifyNow")} onPress={verify} busy={busy} />} />
          ) : null}

          <Notice tone="success">{msg}</Notice>
          <ErrorText>{error}</ErrorText>
        </Col>

        <Col>
          <Section title={t("inviteCode")}>
            <Card padding={0} style={{ gap: 0 }}>
              <View style={inviteRow}>
                <T variant="mono" selectable numberOfLines={1} style={{ flexGrow: 1, fontSize: 18, lineHeight: 24, letterSpacing: 3 }}>{me?.referralCode ?? "–"}</T>
                <Button size="sm" kind="secondary" icon={copied === "code" ? "check" : "copy"} title={copied === "code" ? t("copied") : t("copy")} onPress={() => me && void copy("code", me.referralCode)} />
                {canShare && !link ? (
                  <Button size="sm" kind="secondary" icon="share" title={t("shareInvite")} onPress={() => me && share(`${t("inviteMessage")} ${me.referralCode}`)} />
                ) : null}
              </View>
              {link ? (
                <>
                  <Divider />
                  <View style={inviteRow}>
                    <T variant="label" color={colors.textSoft} selectable numberOfLines={1} style={{ flexGrow: 1, flexShrink: 1, flexBasis: 200 }}>{link.replace(/^https?:\/\//, "")}</T>
                    <Button size="sm" kind="secondary" icon={copied === "link" ? "check" : "link"} title={copied === "link" ? t("copied") : t("copyLink")} onPress={() => void copy("link", link)} />
                    {canShare ? <Button size="sm" kind="secondary" icon="share" title={t("shareInvite")} onPress={() => share(`${t("inviteLinkMessage")} ${link}`)} /> : null}
                  </View>
                </>
              ) : null}
              {bonus ? (
                <Metrics
                  bare
                  items={[
                    { label: t("activeToday"), value: count(bonus.active) },
                    { label: t("inviteBonus"), value: bonus.bps > 0 ? boostPercent(bonus.bps) : "–" },
                  ]}
                />
              ) : null}
            </Card>
            {bonus ? (
              <T variant="small" color={colors.textFaint}>{fill(t("inviteRule"), { each: boostPercent(bonus.bpsEach), cap: boostPercent(bonus.capBps) })}</T>
            ) : null}
          </Section>

          <List>
            {pushProjectId ? <Row icon="bell" title={t("notifications")} onPress={() => void enableReminders()} chevron /> : null}
            <Row icon="message" title={t("appeal")} onPress={() => { setAppealError(""); setAppealOpen(true); }} chevron />
          </List>

          <List>
            <Row
              icon="logout"
              danger
              title={t("signOut")}
              onPress={async () => {
                await signOut();
                setSignedIn(false);
                router.replace("/sign-in");
              }}
            />
          </List>
        </Col>
      </Columns>

      <Sheet visible={appealOpen} title={t("appeal")} onClose={() => setAppealOpen(false)} closeLabel={t("close")}>
        <Input value={appeal} onChangeText={setAppeal} placeholder={t("appealPlaceholder")} multiline style={{ minHeight: 120, textAlignVertical: "top" }} />
        <ErrorText>{appealError}</ErrorText>
        <Button title={t("submit")} onPress={sendAppeal} busy={busy} disabled={appeal.trim().length < 10} />
      </Sheet>
    </Screen>
  );
}
