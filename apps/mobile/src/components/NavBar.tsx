/**
 * The app's navigation: a bar along the bottom of a phone, a side rail in a wide window. The rail
 * also carries what a phone shows elsewhere: the wordmark, the network and the account.
 */
import type { ComponentProps } from "react";
import { Platform, Pressable, StyleSheet, Text, View } from "react-native";
import type { Tabs } from "expo-router";
import { useApp } from "@/lib/app-state";
import { tierKey } from "@/lib/format";
import type { StringKey } from "@/lib/i18n";
import { colors, fonts, layout, radius, space } from "@/design/tokens";
import { useWide } from "@/design/layout";
import { select } from "@/design/haptics";
import { Icon, type IconName } from "./Icon";
import { Avatar, Brand, T } from "./ui";

type TabBarProps = Parameters<NonNullable<ComponentProps<typeof Tabs>["tabBar"]>>[0];

const TABS: { name: string; icon: IconName; label: StringKey }[] = [
  { name: "mine", icon: "pearl", label: "tabMine" },
  { name: "wallet", icon: "wallet", label: "tabWallet" },
  { name: "network", icon: "globe", label: "tabNetwork" },
  { name: "profile", icon: "user", label: "tabProfile" },
];

/** Screens that are opened from a tab and keep it lit. */
const UNDER: Record<string, string> = { boost: "mine" };

const hoveredIn = (state: { pressed: boolean }) => Boolean((state as { hovered?: boolean }).hovered);

export function NavBar({ state, emitter, navigateToTab, insets }: TabBarProps) {
  const wide = useWide();
  const { t, me, network } = useApp();
  const focused = state.routes[state.index]?.name ?? "";
  const active = UNDER[focused] ?? focused;

  const go = (name: string) => {
    const route = state.routes.find((r) => r.name === name);
    if (!route) return;
    select();
    const event = emitter.emit({ type: "tabPress", target: route.key, canPreventDefault: true });
    if (focused !== name && !event.defaultPrevented) navigateToTab(route.key);
  };

  if (!wide) {
    return (
      <View style={[styles.bar, { paddingBottom: insets.bottom }]}>
        <View accessibilityRole="tablist" style={styles.barRow}>
          {TABS.map((tab) => {
            const on = tab.name === active;
            return (
              <Pressable
                key={tab.name}
                accessibilityRole="tab"
                accessibilityState={{ selected: on }}
                accessibilityLabel={t(tab.label)}
                onPress={() => go(tab.name)}
                style={styles.barItem}
              >
                <View style={[styles.barMark, on && { backgroundColor: colors.primary }]} />
                <Icon name={tab.icon} size={22} color={on ? colors.primary : colors.textFaint} strokeWidth={on ? 2 : 1.7} />
                <Text numberOfLines={1} style={[styles.barLabel, { color: on ? colors.text : colors.textFaint }]}>{t(tab.label)}</Text>
              </Pressable>
            );
          })}
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.rail, { paddingTop: insets.top + 28, paddingBottom: insets.bottom + space.lg }]}>
      <View style={{ paddingHorizontal: space.md }}>
        <Brand size={16} />
      </View>

      <View accessibilityRole="tablist" style={{ gap: 2, marginTop: 36 }}>
        {TABS.map((tab) => {
          const on = tab.name === active;
          return (
            <Pressable
              key={tab.name}
              accessibilityRole="tab"
              accessibilityState={{ selected: on }}
              accessibilityLabel={t(tab.label)}
              onPress={() => go(tab.name)}
              style={(s) => [styles.railItem, on ? { backgroundColor: colors.surfaceHigh } : hoveredIn(s) ? { backgroundColor: "rgba(10, 31, 61, 0.04)" } : null]}
            >
              <Icon name={tab.icon} size={18} color={on ? colors.primary : colors.textSoft} strokeWidth={on ? 2 : 1.8} />
              <Text numberOfLines={1} style={[styles.railLabel, { color: on ? colors.text : colors.textSoft }]}>{t(tab.label)}</Text>
            </Pressable>
          );
        })}
      </View>

      <View style={{ flex: 1 }} />

      {Platform.OS === "web" ? (
        // The site that serves this page also holds the app (apps/mobile/site/server.mjs).
        <Pressable
          accessibilityRole="link"
          onPress={() => window.location.assign("/download/android")}
          style={(s) => [styles.railItem, hoveredIn(s) && { backgroundColor: "rgba(10, 31, 61, 0.04)" }]}
        >
          <Icon name="download" size={18} color={colors.textSoft} />
          <Text numberOfLines={1} style={[styles.railLabel, { color: colors.textSoft }]}>{t("getAndroidApp")}</Text>
        </Pressable>
      ) : null}
      {network ? (
        <View style={[styles.railItem, { height: 36 }]}>
          <View style={{ width: 18, alignItems: "center" }}>
            <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: colors.positive }} />
          </View>
          <Text numberOfLines={1} style={[styles.railLabel, { color: colors.textSoft }]}>{network.chainName}</Text>
        </View>
      ) : null}

      {me ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("tabProfile")}
          onPress={() => go("profile")}
          style={(s) => [styles.account, hoveredIn(s) && { backgroundColor: "rgba(10, 31, 61, 0.04)" }]}
        >
          <Avatar name={me.handle} uri={me.avatarUrl} size={36} />
          <View style={{ flex: 1, minWidth: 0 }}>
            <T variant="bodyStrong" numberOfLines={1} style={{ fontSize: 14, lineHeight: 19 }}>{me.handle}</T>
            <T variant="small" color={me.tier >= 2 ? colors.positive : colors.textSoft} numberOfLines={1}>{t(tierKey(me.tier))}</T>
          </View>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { backgroundColor: colors.bgRaised, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.lineStrong },
  barRow: { flexDirection: "row", width: "100%", maxWidth: layout.column, alignSelf: "center" },
  barItem: { flex: 1, height: 58, alignItems: "center", justifyContent: "center", gap: 4 },
  barMark: { position: "absolute", top: 0, width: 22, height: 2, borderBottomLeftRadius: 2, borderBottomRightRadius: 2 },
  barLabel: { fontFamily: fonts.medium, fontSize: 11, lineHeight: 14 },
  rail: {
    width: layout.rail, paddingHorizontal: space.md, backgroundColor: colors.bgRaised,
    borderRightWidth: StyleSheet.hairlineWidth, borderRightColor: colors.lineStrong,
  },
  railItem: { flexDirection: "row", alignItems: "center", gap: space.md, height: 42, paddingHorizontal: space.md, borderRadius: radius.md },
  railLabel: { flex: 1, fontFamily: fonts.medium, fontSize: 14, lineHeight: 19 },
  account: {
    flexDirection: "row", alignItems: "center", gap: space.md, marginTop: space.md, paddingTop: space.md + 2, paddingBottom: space.sm, paddingHorizontal: space.md,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.lineStrong,
  },
});
