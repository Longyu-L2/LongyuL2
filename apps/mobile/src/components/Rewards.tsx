/**
 * The account's balances as figures that keep time with a running session. Each piece reads the
 * shared balances itself, so a number that moves every second redraws only itself.
 */
import { View } from "react-native";
import { useLiveBalances } from "@/lib/resources";
import { shares, type Live } from "@/lib/rewards";
import { formatTokenFixed } from "@/lib/format";
import { colors, tabular } from "@/design/tokens";
import { Figure, Skeleton, T } from "./ui";

export type RewardPart = "earned" | "claimable" | "pending" | "claimed";

/** The colour of each part, in the bar and beside its name. */
export const partColor = { claimable: colors.primary, pending: colors.azure, claimed: "#C3D3E8" } as const;

export function LiveAmount({ part, unit, color = colors.text }: { part: RewardPart; unit?: string; color?: string }) {
  const live = useLiveBalances();
  return (
    <T variant="bodyStrong" color={color} style={tabular} numberOfLines={1}>
      {live ? `${formatTokenFixed(live[part], 4)}${unit ? ` ${unit}` : ""}` : "–"}
    </T>
  );
}

/** The screen's one large number. */
export function LiveFigure({ part, unit }: { part: RewardPart; unit: string }) {
  const live = useLiveBalances();
  return live ? <Figure value={formatTokenFixed(live[part], 4)} unit={unit} /> : <Skeleton width={210} height={46} />;
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

/** What `children` gets: the balances now, for a line that depends on them. */
export function WithBalances({ children }: { children: (live: Live | null) => React.ReactNode }) {
  return <>{children(useLiveBalances())}</>;
}
