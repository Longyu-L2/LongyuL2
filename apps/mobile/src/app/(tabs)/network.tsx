import { useCallback } from "react";
import { Linking, StyleSheet, View } from "react-native";
import { useApp, useSymbol } from "@/lib/app-state";
import { refresh, useResource } from "@/lib/resources";
import { compactNumber, formatToken } from "@/lib/format";
import { colors, radius, space, tabular, tones } from "@/design/tokens";
import { Card, Col, Columns, Empty, Figure, Header, List, Metrics, Pill, Row, Screen, Section, Skeleton, T } from "@/components/ui";

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
  const stats = useResource<Stats>("/v1/stats").data ?? null;
  const board = useResource<Board>("/v1/leaderboard").data ?? null;
  const load = useCallback(() => Promise.all([refresh("/v1/stats"), refresh("/v1/leaderboard")]), []);

  return (
    <Screen onRefresh={load}>
      <Header title={t("tabNetwork")} right={<Pill tone="positive" dot text={t("live")} />} />

      <Columns>
        <Col>
          <Card padding={0} style={{ gap: 0 }}>
            <View style={{ gap: 2, paddingHorizontal: space.lg, paddingVertical: space.xl }}>
              <T variant="label" color={colors.textSoft}>{t("miners")}</T>
              {stats ? <Figure value={(Number(stats.miners) || 0).toLocaleString("en-US")} /> : <Skeleton width={170} height={46} />}
            </View>
            <Metrics
              bare
              items={[
                { label: t("totalClaimed"), hint: symbol, value: stats ? compactNumber(formatToken(stats.totalClaimed, 0)) : "–" },
                { label: t("miningDay"), value: stats?.day ?? "–" },
              ]}
            />
          </Card>

          {network ? (
            <List>
              <Row title={t("chain")} value={network.chainId} />
              <Row icon="external" title={t("openExplorer")} onPress={() => void Linking.openURL(network.explorerUrl)} chevron />
            </List>
          ) : null}
        </Col>

        <Col flex={1.25}>
          <Section title={t("leaderboard")}>
            {!board ? (
              <Skeleton height={220} rounded={radius.lg} />
            ) : board.entries.length === 0 ? (
              <Empty icon="award" text={t("noMiners")} />
            ) : (
              <Card padding={0} style={{ gap: 0 }}>
                <View style={[styles.line, { paddingVertical: 10 }]}>
                  <T variant="small" color={colors.textFaint} style={styles.rank}>#</T>
                  <T variant="small" color={colors.textFaint} style={{ flex: 1 }}>{t("miner")}</T>
                  <T variant="small" color={colors.textFaint} style={styles.days} numberOfLines={1}>{t("last30")}</T>
                  <T variant="small" color={colors.textFaint} style={styles.streak} numberOfLines={1}>{t("streak")}</T>
                </View>
                {board.entries.slice(0, 50).map((e) => {
                  const mine = e.handle === me?.handle;
                  return (
                    <View key={e.handle} style={[styles.line, styles.entry, mine && { backgroundColor: tones.primary.bg }]}>
                      <T variant="bodyStrong" color={medal[e.rank - 1] ?? colors.textFaint} style={[styles.rank, tabular]}>{e.rank}</T>
                      <T style={{ flex: 1 }} numberOfLines={1}>
                        {e.handle}
                        {mine ? <T variant="small" color={colors.primary}>{`  ${t("you")}`}</T> : null}
                      </T>
                      <T variant="label" color={colors.textSoft} style={[styles.days, tabular]}>{`${e.miningDays30}/30`}</T>
                      <T variant="bodyStrong" style={[styles.streak, tabular]}>
                        {e.streakDays}
                        <T variant="small" color={colors.textSoft}>{` ${t("daysShort")}`}</T>
                      </T>
                    </View>
                  );
                })}
              </Card>
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
});
