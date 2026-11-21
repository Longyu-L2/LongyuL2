import { useCallback, useState } from "react";
import { Linking, Pressable, StyleSheet, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { router, useFocusEffect } from "expo-router";
import { api, loadWallet, recall } from "@/lib/core";
import { useApp, useSymbol } from "@/lib/app-state";
import { errorKeyOf } from "@/lib/errors";
import { followClaim, useResource } from "@/lib/resources";
import { openClaim, type Claim } from "@/lib/rewards";
import { isWalletOf } from "@/lib/wallet-key";
import { shortAddress } from "@/lib/format";
import { colors, radius, space } from "@/design/tokens";
import { useRoomy, useWide } from "@/design/layout";
import { success } from "@/design/haptics";
import { Button, Card, Col, Columns, Empty, ErrorText, Header, List, Notice, Panel, Row, Screen, Section, Skeleton, T } from "@/components/ui";
import { Icon } from "@/components/Icon";
import { LiveAmount, LiveFigure, RewardBar, RewardLine, TgeLock, UnlockNote, partColor } from "@/components/Rewards";

interface Rewards {
  address: string;
  claimable: string;
  claims: Claim[];
}

export default function WalletScreen() {
  const { t, network, me } = useApp();
  const symbol = useSymbol();
  const wide = useWide();
  const roomy = useRoomy();
  const rewards = useResource<Rewards>("/v1/rewards");
  const r = rewards.data;
  const address = me?.wallet ?? r?.address ?? null;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // The claim this screen asked for, until the next one: how it ended is said under the button.
  const [asked, setAsked] = useState<string | null>(null);
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
    setAsked(null);
    try {
      const { claimId } = await api<{ claimId: string }>("POST", "/v1/rewards/claim");
      success();
      setAsked(claimId);
      await followClaim();
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
  const claimTitle = (s: Claim["status"]) =>
    ({ queued: t("claimStatusQueued"), sent: t("claimStatusSent"), confirmed: t("claimStatusConfirmed"), skipped: t("claimStatusSkipped"), failed: t("claimStatusFailed") })[s];
  const date = (s: string, year?: boolean) => new Date(Number(s) * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric", ...(year ? { year: "numeric" } : null) });
  // A claim on its way holds the button until it has landed: the rewards are read again by themselves.
  const claiming = openClaim(r?.claims) !== null;
  const msg = claiming ? t("claimQueued") : "";
  const failed = asked !== null && r?.claims.find((c) => c.id === asked)?.status === "failed";
  const shown = error || (failed ? t("claimStatusFailed") : !r && rewards.error ? t(errorKeyOf(rewards.error)) : "");
  const canClaim = Boolean(r && r.claimable !== "0");

  const links = [
    address && network ? <Row key="explorer" icon="external" title={t("viewOnExplorer")} onPress={() => void explorer(`address/${address}`)} chevron /> : null,
    keyHere ? (
      <Row
        key="key"
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
    ) : null,
  ];

  if (wide) {
    const balance = (
      <Card padding={0} style={{ gap: 0 }}>
        <View style={{ gap: space.xl, paddingHorizontal: space.xxl, paddingTop: space.xxl, paddingBottom: 28 }}>
          <View style={{ gap: 2 }}>
            <T variant="label" color={colors.textSoft}>{t("mined")}</T>
            <LiveFigure part="earned" unit={symbol} size="figure" />
            <TgeLock />
          </View>
          <RewardBar />
        </View>
        <View style={[styles.rule, { flexDirection: "row" }]}>
          {([["claimable", t("available")], ["pending", t("pending")], ["claimed", t("claimed")]] as const).map(([key, label], i) => (
            <View key={key} style={[styles.part, i > 0 && styles.partLeft]}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
                <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: partColor[key] }} />
                <T variant="label" color={colors.textSoft} numberOfLines={1}>{label}</T>
              </View>
              <LiveAmount part={key} variant="number" />
            </View>
          ))}
        </View>
        <View style={[styles.rule, styles.claim]}>
          <View style={{ flex: 1, minWidth: 0 }}>
            {msg ? <Notice tone="success">{msg}</Notice> : shown ? <ErrorText>{shown}</ErrorText> : <UnlockNote center={false} />}
          </View>
          <Button title={t("claim")} onPress={() => void claim()} busy={busy || claiming} disabled={!canClaim} />
        </View>
      </Card>
    );
    const activity = (
      <Panel title={t("activity")}>
        {!r && !rewards.error ? (
          <View style={{ padding: space.xl, gap: space.md }}>
            <Skeleton height={18} />
            <Skeleton height={18} width="70%" />
          </View>
        ) : !r || r.claims.length === 0 ? (
          <View style={styles.none}>
            <Icon name="activity" size={22} color={colors.textFaint} strokeWidth={1.6} />
            <T variant="label" color={colors.textSoft} center>{t("noActivity")}</T>
          </View>
        ) : (
          <>
            <View style={[styles.line, { minHeight: 38 }]}>
              <T variant="small" color={colors.textFaint} style={styles.status}>{t("status")}</T>
              <T variant="small" color={colors.textFaint} style={styles.tx}>{t("transaction")}</T>
              <T variant="small" color={colors.textFaint} style={styles.date}>{t("date")}</T>
              <View style={{ width: 16 }} />
            </View>
            {r.claims.map((c) => {
              const open = c.tx_hash && network ? () => void explorer(`tx/${c.tx_hash}`) : undefined;
              return (
                <Pressable
                  key={c.id}
                  accessibilityRole={open ? "link" : undefined}
                  disabled={!open}
                  onPress={open}
                  style={(s) => [styles.line, styles.entry, open && (s as { hovered?: boolean }).hovered ? { backgroundColor: "rgba(10, 31, 61, 0.03)" } : null]}
                >
                  <T variant="bodyStrong" color={c.status === "failed" ? colors.danger : colors.text} style={styles.status} numberOfLines={1}>{claimTitle(c.status)}</T>
                  <T variant="mono" color={colors.textSoft} style={styles.tx} numberOfLines={1}>{c.tx_hash ? shortAddress(c.tx_hash) : "–"}</T>
                  <T variant="label" color={colors.textSoft} style={styles.date} numberOfLines={1}>{date(c.created_at, true)}</T>
                  <View style={{ width: 16 }}>{open ? <Icon name="external" size={15} color={colors.textFaint} /> : null}</View>
                </Pressable>
              );
            })}
          </>
        )}
      </Panel>
    );
    // The address is set in two even lines, so it never breaks a few characters from its end.
    const where = (
      <Panel
        title={t("address")}
        action={address ? <Button size="sm" kind="ghost" icon={copied ? "check" : "copy"} title={copied ? t("copied") : t("copy")} onPress={() => void copy()} /> : undefined}
      >
        <View style={{ padding: space.xl }}>
          {address ? (
            <View accessible accessibilityLabel={address}>
              <T variant="mono" color={colors.text} selectable style={{ lineHeight: 22 }}>{address.slice(0, 21)}</T>
              <T variant="mono" color={colors.text} selectable style={{ lineHeight: 22 }}>{address.slice(21)}</T>
            </View>
          ) : <Skeleton height={44} />}
        </View>
        <List bare>{links}</List>
      </Panel>
    );

    return (
      <Screen onRefresh={rewards.refresh}>
        <Header title={t("tabWallet")} />

        {roomy ? (
          <Columns>
            <Col flex={1.75}>
              {balance}
              {activity}
            </Col>
            <Col>{where}</Col>
          </Columns>
        ) : (
          <>
            {balance}
            <Columns>
              <Col flex={1.35}>{activity}</Col>
              <Col>{where}</Col>
            </Columns>
          </>
        )}
      </Screen>
    );
  }

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
              <TgeLock />
            </View>
            <View style={{ gap: space.md }}>
              <RewardBar />
              <View style={{ gap: space.sm }}>
                <RewardLine part="claimable" label={t("available")} />
                <RewardLine part="pending" label={t("pending")} />
                <RewardLine part="claimed" label={t("claimed")} />
              </View>
            </View>
            <View style={{ gap: space.md }}>
              <Button title={t("claim")} onPress={() => void claim()} busy={busy || claiming} disabled={!canClaim} />
              <Notice tone="success">{msg}</Notice>
              <ErrorText>{msg ? "" : shown}</ErrorText>
              {!msg && !shown ? <UnlockNote /> : null}
            </View>
          </Card>

          <List>{links}</List>
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

// The wide window's balance card and activity table.
const styles = StyleSheet.create({
  rule: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.lineStrong },
  part: { flex: 1, minWidth: 0, gap: 6, paddingHorizontal: space.xxl, paddingVertical: space.lg },
  partLeft: { borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: colors.lineStrong },
  claim: { flexDirection: "row", alignItems: "center", gap: space.lg, paddingHorizontal: space.xxl, paddingVertical: space.lg },
  none: { alignItems: "center", justifyContent: "center", gap: space.sm, paddingVertical: space.xxxl, paddingHorizontal: space.xl },
  line: { flexDirection: "row", alignItems: "center", gap: space.md, paddingHorizontal: space.xl },
  entry: { minHeight: 52, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.lineStrong },
  status: { flex: 1, minWidth: 0 },
  tx: { flex: 1, minWidth: 0 },
  date: { width: 104, textAlign: "right" },
});
