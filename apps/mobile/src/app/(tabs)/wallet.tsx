import { useCallback, useState } from "react";
import { Linking, Pressable, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { router, useFocusEffect } from "expo-router";
import { api, loadWallet, recall } from "@/lib/core";
import { useApp, useSymbol } from "@/lib/app-state";
import { errorKeyOf } from "@/lib/errors";
import { useResource } from "@/lib/resources";
import { isWalletOf } from "@/lib/wallet-key";
import { shortAddress } from "@/lib/format";
import { colors, radius, space } from "@/design/tokens";
import { success } from "@/design/haptics";
import { Button, Card, Col, Columns, Empty, ErrorText, Header, List, Notice, Row, Screen, Section, Skeleton, T } from "@/components/ui";
import { Icon } from "@/components/Icon";
import { LiveAmount, LiveFigure, RewardBar, UnlockNote, partColor, type RewardPart } from "@/components/Rewards";

interface Rewards {
  address: string;
  claimable: string;
  claims: { id: string; status: "queued" | "sent" | "confirmed" | "skipped" | "failed"; tx_hash: string | null; created_at: string }[];
}

export default function WalletScreen() {
  const { t, network, me } = useApp();
  const symbol = useSymbol();
  const rewards = useResource<Rewards>("/v1/rewards");
  const r = rewards.data;
  const address = me?.wallet ?? r?.address ?? null;
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  // Whether this device holds the key of the linked wallet. A browser may mine for a wallet whose key is
  // kept elsewhere, and a wallet replaced on another device leaves only the old one's key here.
  const [keyHere, setKeyHere] = useState(false);
  // Until the person says the key is saved somewhere else, its row carries a warning.
  const [backedUp, setBackedUp] = useState(true);

  useFocusEffect(useCallback(() => {
    if (!me) return;
    void loadWallet(me).then((w) => setKeyHere(w !== null && isWalletOf(me, w.address)), () => setKeyHere(false));
    if (me.wallet) void recall(`backup.${me.wallet.toLowerCase()}`).then((v) => setBackedUp(v === "1"));
  }, [me]));

  const claim = async () => {
    setBusy(true);
    setError("");
    setMsg("");
    try {
      await api("POST", "/v1/rewards/claim");
      success();
      setMsg(t("claimQueued"));
      await rewards.refresh();
    } catch (e) {
      setError(t(errorKeyOf(e)));
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!address) return;
    await Clipboard.setStringAsync(address);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  const explorer = (path: string) => network && Linking.openURL(`${network.explorerUrl}/${path}`);
  const claimTitle = (s: Rewards["claims"][number]["status"]) =>
    ({ queued: t("claimStatusQueued"), sent: t("claimStatusSent"), confirmed: t("claimStatusConfirmed"), skipped: t("claimStatusSkipped"), failed: t("claimStatusFailed") })[s];
  const date = (s: string) => new Date(Number(s) * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const part = (key: Exclude<RewardPart, "earned">, label: string) => (
    <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm + 2, minHeight: 24 }}>
      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: partColor[key] }} />
      <T variant="body" color={colors.textSoft} style={{ flex: 1 }} numberOfLines={1}>{label}</T>
      <LiveAmount part={key} />
    </View>
  );

  return (
    <Screen onRefresh={rewards.refresh}>
      <Header
        title={t("tabWallet")}
        right={address ? (
          <Pressable accessibilityRole="button" accessibilityLabel={t("copy")} onPress={() => void copy()} style={{ flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: colors.surfaceHigh, borderRadius: radius.pill, paddingHorizontal: 12, paddingVertical: 7 }}>
            <T variant="mono" color={colors.textSoft} style={{ fontSize: 12 }}>{copied ? t("copied") : shortAddress(address)}</T>
            <Icon name={copied ? "check" : "copy"} size={13} color={copied ? colors.positive : colors.textSoft} />
          </Pressable>
        ) : null}
      />

      <Columns>
        <Col>
          <Card padding={space.xl} style={{ gap: space.xl }}>
            <View style={{ gap: 2 }}>
              <T variant="label" color={colors.textSoft}>{t("mined")}</T>
              <LiveFigure part="earned" unit={symbol} />
            </View>
            <View style={{ gap: space.md }}>
              <RewardBar />
              <View style={{ gap: space.sm }}>
                {part("claimable", t("available"))}
                {part("pending", t("pending"))}
                {part("claimed", t("claimed"))}
              </View>
            </View>
            <View style={{ gap: space.md }}>
              <Button title={t("claim")} onPress={() => void claim()} busy={busy} disabled={!r || r.claimable === "0"} />
              <Notice tone="success">{msg}</Notice>
              <ErrorText>{error || (!r && rewards.error ? t(errorKeyOf(rewards.error)) : "")}</ErrorText>
              {!msg && !error ? <UnlockNote /> : null}
            </View>
          </Card>

          <List>
            {address && network ? <Row icon="external" title={t("viewOnExplorer")} onPress={() => void explorer(`address/${address}`)} chevron /> : null}
            {keyHere ? (
              <Row
                icon="key"
                title={t("exportKey")}
                right={backedUp ? undefined : (
                  <View accessible accessibilityLabel={t("notBackedUp")}>
                    <Icon name="alert" size={18} color={colors.warning} strokeWidth={2} />
                  </View>
                )}
                onPress={() => router.push("/export-key")}
                chevron
              />
            ) : null}
          </List>
        </Col>

        <Col>
          <Section title={t("activity")}>
            {!r ? (
              rewards.error ? <Empty icon="activity" text={t("noActivity")} /> : <Skeleton height={150} rounded={radius.lg} />
            ) : r.claims.length === 0 ? (
              <Empty icon="activity" text={t("noActivity")} />
            ) : (
              <List>
                {r.claims.map((c) => (
                  <Row
                    key={c.id}
                    title={claimTitle(c.status)}
                    subtitle={c.tx_hash ? shortAddress(c.tx_hash) : undefined}
                    right={<T variant="label" color={colors.textSoft}>{date(c.created_at)}</T>}
                    onPress={c.tx_hash && network ? () => void explorer(`tx/${c.tx_hash}`) : undefined}
                    chevron={Boolean(c.tx_hash && network)}
                    danger={c.status === "failed"}
                  />
                ))}
              </List>
            )}
          </Section>
        </Col>
      </Columns>
    </Screen>
  );
}
