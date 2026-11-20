/**
 * The account's balances as figures that keep time with a running session. Each piece reads the
 * shared balances itself, so a number that moves every second redraws only itself.
 */
import { View } from "react-native";
import { useApp } from "@/lib/app-state";
import { useLiveBalances, useUnlock } from "@/lib/resources";
import { shares } from "@/lib/rewards";
import { fill, formatTokenFixed } from "@/lib/format";
import { colors, space, tabular } from "@/design/tokens";
import { Figure, Skeleton, T } from "./ui";

export type RewardPart = "earned" | "claimable" | "pending" | "claimed";

/** The colour of each part, in the bar and beside its name. */
export const partColor = { claimable: colors.primary, pending: colors.azure, claimed: "#C3D3E8" } as const;

export function LiveAmount({ part, unit, color = colors.text, variant = "bodyStrong" }: { part: RewardPart; unit?: string; color?: string; variant?: "bodyStrong" | "number" }) {
  const live = useLiveBalances();
  return (
    <T variant={variant} color={color} style={tabular} numberOfLines={1}>
      {live ? `${formatTokenFixed(live[part], 4)}${unit ? ` ${unit}` : ""}` : "–"}
    </T>
  );
}

/** The screen's one large number. */
export function LiveFigure({ part, unit, size = "hero" }: { part: RewardPart; unit: string; size?: "display" | "hero" | "figure" }) {
  const live = useLiveBalances();
  return live ? <Figure value={formatTokenFixed(live[part], 4)} unit={unit} size={size} /> : <Skeleton width={210} height={size === "display" ? 36 : size === "figure" ? 62 : 46} />;
}

/** One part of what was mined, by name, with the bar's colour for it. */
export function RewardLine({ part, label }: { part: Exclude<RewardPart, "earned">; label: string }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm + 2, minHeight: 24 }}>
      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: partColor[part] }} />
      <T variant="body" color={colors.textSoft} style={{ flex: 1 }} numberOfLines={1}>{label}</T>
      <LiveAmount part={part} />
    </View>
  );
}

/** Everything mined as one bar: what can be claimed, what is waiting for settlement, what was claimed. */
export function RewardBar() {
  const live = useLiveBalances();
  const part = live ? shares(live) : { claimable: 0, pending: 0, claimed: 0 };
  return (
    <View style={{ flexDirection: "row", gap: 2, height: 6, borderRadius: 3, overflow: "hidden", backgroundColor: colors.surfaceHigh }}>
      {(["claimable", "pending", "claimed"] as const).map((key) =>
        part[key] > 0 ? <View key={key} style={{ flexGrow: part[key], flexBasis: 0, minWidth: 3, backgroundColor: partColor[key] }} /> : null,
      )}
    </View>
  );
}

const UNLOCK_STRING = {
  today: ["claimableToday", "claimableTodayAbout"],
  tomorrow: ["claimableTomorrow", "claimableTomorrowAbout"],
  later: ["claimableOn", "claimableOnAbout"],
} as const;

/** Under the claim button while there is nothing to claim: when the pending rewards can be. */
export function UnlockNote({ center = true }: { center?: boolean }) {
  const { t } = useApp();
  const live = useLiveBalances();
  const unlock = useUnlock();
  if (!live || live.claimable > 0n || live.pending === 0n || unlock?.day === "due") return null;
  const line = unlock
    ? fill(t(UNLOCK_STRING[unlock.day][unlock.exact ? 0 : 1]), {
        time: unlock.at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }),
        date: unlock.at.toLocaleDateString(undefined, { month: "short", day: "numeric" }),
      })
    : t("pendingHint");
  return <T variant="small" color={colors.textSoft} center={center}>{line}</T>;
}
