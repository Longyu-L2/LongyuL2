import { useCallback } from "react";
import { Linking, StyleSheet, View } from "react-native";
import { useApp, useSymbol } from "@/lib/app-state";
import { refresh, useResource } from "@/lib/resources";
import { compactNumber, formatToken } from "@/lib/format";
import { colors, radius, space, tabular, tones } from "@/design/tokens";
import { useWide } from "@/design/layout";
import { Card, Col, Columns, Empty, Figure, Header, List, Metrics, Panel, Row, Screen, Section, Skeleton, T } from "@/components/ui";
import { Icon } from "@/components/Icon";

interface Stats {
  day: string;
  /** Accounts that have mined. */
  miners: string;
  totalClaimed: string;
}
interface Board {
  entries: { rank: number; handle: string; streakDays: number; miningDays30: string }[];
}

// Gold, silver and bronze.
const medal = ["#C58A0A", "#8593A6", "#B0703A"];

export default function NetworkScreen() {
  const { t, network, me } = useApp();
  const symbol = useSymbol();
  const wide = useWide();
  const stats = useResource<Stats>("/v1/stats").data ?? null;
  const board = useResource<Board>("/v1/leaderboard").data ?? null;
  const load = useCallback(() => Promise.all([refresh("/v1/stats"), refresh("/v1/leaderboard")]), []);

  const miners = stats ? (Number(stats.miners) || 0).toLocaleString("en-US") : null;
  const claimed = { label: t("totalClaimed"), hint: symbol, value: stats ? compactNumber(formatToken(stats.totalClaimed, 0)) : "–" };
  const day = { label: t("miningDay"), value: stats?.day ?? "–" };

  const table = board && board.entries.length > 0 ? (
    <>
      <View style={[styles.line, wide ? { minHeight: 38 } : { paddingVertical: 10 }, wide && styles.lineWide]}>
        <T variant="small" color={colors.textFaint} style={styles.rank}>#</T>
        <T variant="small" color={colors.textFaint} style={{ flex: 1 }}>{t("miner")}</T>
        <T variant="small" color={colors.textFaint} style={[styles.days, wide && styles.daysWide]} numberOfLines={1}>{t("last30")}</T>
        <T variant="small" color={colors.textFaint} style={[styles.streak, wide && styles.streakWide]} numberOfLines={1}>{t("streak")}</T>
      </View>
      {board.entries.slice(0, 50).map((e) => {
        const mine = e.handle === me?.handle;
        return (
          <View key={e.handle} style={[styles.line, styles.entry, wide && styles.lineWide, mine && { backgroundColor: tones.primary.bg }]}>
            <T variant="bodyStrong" color={medal[e.rank - 1] ?? colors.textFaint} style={[styles.rank, tabular]}>{e.rank}</T>
            <T style={{ flex: 1 }} numberOfLines={1}>
              {e.handle}
              {mine ? <T variant="small" color={colors.primary}>{`  ${t("you")}`}</T> : null}
            </T>
            <T variant="label" color={colors.textSoft} style={[styles.days, wide && styles.daysWide, tabular]}>{`${e.miningDays30}/30`}</T>
            <T variant="bodyStrong" style={[styles.streak, wide && styles.streakWide, tabular]}>
              {e.streakDays}
              <T variant="small" color={colors.textSoft}>{` ${t("daysShort")}`}</T>
            </T>
          </View>
        );
      })}
    </>
  ) : null;

  if (wide) {
    return (
      <Screen onRefresh={load}>
        <Header title={t("tabNetwork")} />

        <Metrics size="lg" columns={3} items={[{ label: t("miners"), value: miners ?? "–" }, claimed, day]} />

        <Columns>
          <Col flex={1.75}>
            <Panel title={t("leaderboard")}>
              {!board ? (
                <View style={{ padding: space.xl, gap: space.md }}>
                  <Skeleton height={18} />
                  <Skeleton height={18} width="70%" />
                  <Skeleton height={18} width="85%" />
                </View>
              ) : table ?? (
                <View style={styles.none}>
                  <Icon name="award" size={22} color={colors.textFaint} strokeWidth={1.6} />
                  <T variant="label" color={colors.textSoft} center>{t("noMiners")}</T>
                </View>
              )}
            </Panel>
          </Col>

          {network ? (
            <Col>
              <Panel title={network.chainName}>
                <List flush>
                  <Row title={t("chain")} value={network.chainId} />
                  <Row title={t("gasToken")} value={network.nativeCurrency.symbol} />
                  <Row title={t("rewardToken")} value={symbol} />
                  <Row icon="external" title={t("openExplorer")} onPress={() => void Linking.openURL(network.explorerUrl)} chevron />
                </List>
              </Panel>
            </Col>
          ) : null}
        </Columns>
      </Screen>
    );
  }

  return (
    <Screen onRefresh={load}>
      <Header title={t("tabNetwork")} />

      <Columns>
        <Col>
          <Card padding={0} style={{ gap: 0 }}>
            <View style={{ gap: 2, paddingHorizontal: space.lg, paddingVertical: space.xl }}>
              <T variant="label" color={colors.textSoft}>{t("miners")}</T>
              {miners ? <Figure value={miners} /> : <Skeleton width={170} height={46} />}
            </View>
            <Metrics bare items={[claimed, day]} />
          </Card>

          {network ? (
            <List>
              <Row title={t("chain")} value={network.chainId} />
              <Row icon="external" title={t("openExplorer")} onPress={() => void Linking.openURL(network.explorerUrl)} chevron />
            </List>
          ) : null}
        </Col>

        <Col>
          <Section title={t("leaderboard")}>
            {!board ? (
              <Skeleton height={220} rounded={radius.lg} />
            ) : table ? (
              <Card padding={0} style={{ gap: 0 }}>{table}</Card>
            ) : (
              <Empty icon="award" text={t("noMiners")} />
            )}
          </Section>
        </Col>
      </Columns>
    </Screen>
  );
}

const styles = StyleSheet.create({
  line: { flexDirection: "row", alignItems: "center", gap: space.sm, paddingHorizontal: space.lg },
  entry: { minHeight: 46, paddingVertical: 11, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.lineStrong },
  rank: { width: 24 },
  days: { width: 64, textAlign: "right" },
  streak: { width: 52, textAlign: "right" },
  // In a wide window the table has a panel's margins and wider columns.
  lineWide: { gap: space.md, paddingHorizontal: space.xl },
  daysWide: { width: 96 },
  streakWide: { width: 80 },
  none: { alignItems: "center", justifyContent: "center", gap: space.sm, paddingVertical: space.xxxl, paddingHorizontal: space.xl },
});
