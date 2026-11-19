/**
 * LONGYU component kit. Screens are built only from these pieces and the tokens in design/tokens,
 * so spacing, type and colour stay consistent everywhere. Flat surfaces, solid controls, numbers
 * first; the dragon pearl is the only ornament in the app. Every piece works in a phone's column
 * and in a wide window (see `layout` in the tokens).
 */
import { memo, useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
  ActivityIndicator,
  Animated,
  Image,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import { SafeAreaView, type Edge } from "react-native-safe-area-context";
import Svg, { Defs, RadialGradient, Rect, Stop } from "react-native-svg";
import { colors, fonts, layout, radius, space, tones, type, type Tone, type TypeVariant } from "@/design/tokens";
import { LOCKUP_GAP, LOCKUP_MARK, WORDMARK_CAP } from "@/design/brand";
import { useWide } from "@/design/layout";
import { tap } from "@/design/haptics";
import { Icon, type IconName } from "./Icon";
import { Mark, Wordmark } from "./Logo";

const nativeDriver = Platform.OS !== "web";

/** A pointer resting on a control, which only a browser reports. */
const hoveredIn = (state: { pressed: boolean }) => Boolean((state as { hovered?: boolean }).hovered);
const HOVER = "rgba(10, 31, 61, 0.03)";
const PRESSED = "rgba(10, 31, 61, 0.06)";

// ------------------------------------------------------------------ layout

/** The screen backdrop: the pale ground with a little more sky at the top. It never changes, so it is drawn once. */
const Backdrop = memo(function Backdrop() {
  const id = `bd${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <Svg width="100%" height="100%">
        <Defs>
          <RadialGradient id={id} cx="50%" cy="0%" rx="80%" ry="35%">
            <Stop offset="0" stopColor={colors.azure} stopOpacity={0.22} />
            <Stop offset="1" stopColor={colors.azure} stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <Rect width="100%" height="100%" fill={colors.bg} />
        <Rect width="100%" height="100%" fill={`url(#${id})`} />
      </Svg>
    </View>
  );
});

export function Screen({ children, scroll = true, onRefresh, edges = ["top"], width = "page", center, footer }: {
  children: ReactNode;
  scroll?: boolean;
  /** Pull to refresh. */
  onRefresh?: () => Promise<unknown>;
  edges?: Edge[];
  /**
   * In a wide window: "page" fills the page beside the side rail; "column" stays a phone's width,
   * set in a panel in the middle (sign-in steps, a key, a form).
   */
  width?: "page" | "column";
  /** Sets the content in the middle of the window's height when it is shorter than the window. */
  center?: boolean;
  /** A quiet last line: at the foot of the window, or after the content when that is longer. */
  footer?: ReactNode;
}) {
  const wide = useWide();
  const [refreshing, setRefreshing] = useState(false);
  const refresh = onRefresh
    ? async () => {
        setRefreshing(true);
        try {
          await onRefresh();
        } finally {
          setRefreshing(false);
        }
      }
    : undefined;
  const panel = wide && width === "column";
  const body = (
    <View style={[styles.inner, wide && width === "page" && styles.innerPage, panel && styles.innerPanel, center && !panel && styles.innerCenter]}>
      {children}
    </View>
  );
  return (
    <SafeAreaView edges={edges} style={styles.screen}>
      <Backdrop />
      {scroll ? (
        <ScrollView
          contentContainerStyle={[styles.scroll, (panel || center) && styles.scrollCenter]}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          refreshControl={refresh ? <RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.primary} colors={[colors.primary]} progressBackgroundColor={colors.surface} /> : undefined}
        >
          {body}
          {footer ? <View style={styles.footer}>{footer}</View> : null}
        </ScrollView>
      ) : (
        body
      )}
    </SafeAreaView>
  );
}

/** Side by side in a wide window, one under the other on a phone. Holds `Col`s. */
export function Columns({ children }: { children: ReactNode }) {
  const wide = useWide();
  return <View style={wide ? styles.columnsWide : styles.columns}>{children}</View>;
}

export function Col({ children, flex = 1 }: { children: ReactNode; flex?: number }) {
  const wide = useWide();
  return <View style={[styles.columns, wide && { flex, minWidth: 0 }]}>{children}</View>;
}

export function Header({ title, right }: { title: string; right?: ReactNode }) {
  const wide = useWide();
  return (
    <View style={styles.header}>
      <T variant="title" style={[{ flex: 1 }, wide && { fontSize: 28, lineHeight: 34 }]} accessibilityRole="header" numberOfLines={1}>{title}</T>
      {right}
    </View>
  );
}

/** Top bar for screens reached from another screen: a back button and the title. */
export function TopBar({ title, onBack, backLabel = "Back", right }: { title: string; onBack: () => void; backLabel?: string; right?: ReactNode }) {
  const wide = useWide();
  if (wide) {
    return (
      <View style={styles.header}>
        <IconButton icon="chevronLeft" label={backLabel} onPress={onBack} />
        <T variant="title" style={{ flex: 1, fontSize: 28, lineHeight: 34 }} accessibilityRole="header" numberOfLines={1}>{title}</T>
        {right}
      </View>
    );
  }
  return (
    <View style={styles.topBar}>
      <IconButton icon="chevronLeft" label={backLabel} onPress={onBack} />
      <T variant="headline" center style={{ flex: 1 }} accessibilityRole="header" numberOfLines={1}>{title}</T>
      <View style={{ width: 40, alignItems: "flex-end" }}>{right}</View>
    </View>
  );
}

export function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <View style={{ gap: space.sm + 2 }}>
      <View style={styles.sectionHead}>
        <T variant="caption" color={colors.textSoft}>{title}</T>
        {action}
      </View>
      {children}
    </View>
  );
}

// -------------------------------------------------------------------- text

export function T({ variant = "body", color = colors.text, center, style, children, ...rest }: {
  variant?: TypeVariant;
  color?: string;
  center?: boolean;
  style?: StyleProp<TextStyle>;
  children: ReactNode;
  numberOfLines?: number;
  selectable?: boolean;
  accessibilityRole?: "header" | "text";
}) {
  return (
    <Text {...rest} style={[type[variant], { color }, center && { textAlign: "center" }, style]}>
      {children}
    </Text>
  );
}

/** The seal and the wordmark, side by side. `size` is the wordmark's type size; the seal is 1.6 of it. */
export function Brand({ size = 17 }: { size?: number }) {
  const cap = size * WORDMARK_CAP;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: Math.round(cap * LOCKUP_GAP) }}>
      <Mark height={Math.round(cap * LOCKUP_MARK)} />
      <Wordmark capHeight={cap} />
    </View>
  );
}

/**
 * The one large number of a screen, with its unit. A long number is set smaller so that it always
 * fits a phone's width.
 */
export function Figure({ value, unit, size = "hero", color = colors.text }: { value: string; unit?: string; size?: "hero" | "figure"; color?: string }) {
  const base = type[size];
  const fits = 9;
  const scale = value.length > fits ? Math.max(0.55, fits / value.length) : 1;
  return (
    <View style={styles.figure}>
      <Text numberOfLines={1} style={[base, styles.tabular, { color, flexShrink: 1 }, scale < 1 && { fontSize: Math.round(base.fontSize * scale), letterSpacing: base.letterSpacing * scale }]}>
        {value}
      </Text>
      {unit ? <T variant="headline" color={colors.textSoft}>{unit}</T> : null}
    </View>
  );
}

// --------------------------------------------------------------- surfaces

export function Card({ children, style, padding = space.lg, selected }: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  padding?: number;
  /** Outlined in gold: the chosen option. */
  selected?: boolean;
}) {
  return <View style={[styles.card, { padding }, selected && { borderColor: colors.primary }, style]}>{children}</View>;
}

export function Divider({ vertical }: { vertical?: boolean }) {
  return <View style={vertical ? { width: StyleSheet.hairlineWidth, alignSelf: "stretch", backgroundColor: colors.lineStrong } : { height: StyleSheet.hairlineWidth, backgroundColor: colors.lineStrong }} />;
}

export function Pill({ text, tone = "neutral", icon, center, dot }: { text: string; tone?: Tone; icon?: IconName; center?: boolean; dot?: boolean }) {
  const t = tones[tone];
  return (
    <View style={[styles.pill, { backgroundColor: t.bg }, center && { alignSelf: "center" }]}>
      {dot ? <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: t.fg }} /> : null}
      {icon ? <Icon name={icon} size={12} color={t.fg} strokeWidth={2.2} /> : null}
      <T variant="label" color={t.fg} style={{ fontSize: 12, lineHeight: 16 }}>{text}</T>
    </View>
  );
}

// Pictures are taken from X's image host and nowhere else.
const PICTURE = /^https:\/\/pbs\.twimg\.com\/[\w\-./%]+$/;

/**
 * The account's picture: the one of its X account, over the first letter of its name in a ring,
 * which shows while the picture loads and stays when there is none.
 */
export function Avatar({ name, uri, size = 44 }: { name: string; uri?: string | null; size?: number }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [uri]);
  const picture = uri && PICTURE.test(uri) && !failed ? uri : null;
  return (
    <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: colors.surfaceHigh, borderWidth: 1, borderColor: colors.lineStrong, alignItems: "center", justifyContent: "center", overflow: "hidden" }}>
      <Text style={{ fontFamily: fonts.heading, color: colors.primary, fontSize: Math.round(size * 0.4), lineHeight: Math.round(size * 0.52) }}>{(name[0] ?? "").toUpperCase()}</Text>
      {picture ? <Image source={{ uri: picture }} onError={() => setFailed(true)} accessibilityIgnoresInvertColors style={StyleSheet.absoluteFill} /> : null}
    </View>
  );
}

/** One thing that needs the person's attention, with one way to act on it. */
export function Callout({ icon, tone = "primary", title, body, action, onPress }: {
  icon: IconName;
  tone?: Tone;
  title: string;
  body?: string;
  /** A control on the right, in place of the arrow. */
  action?: ReactNode;
  onPress?: () => void;
}) {
  const t = tones[tone];
  const content = (
    <>
      <View style={{ paddingTop: 1 }}>
        <Icon name={icon} size={18} color={t.fg} />
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <T variant="bodyStrong">{title}</T>
        {body ? <T variant="label" color={colors.textSoft} style={{ fontFamily: fonts.body }}>{body}</T> : null}
      </View>
      {action ? <View style={{ alignSelf: "center" }}>{action}</View> : onPress ? <View style={{ alignSelf: "center" }}><Icon name="chevronRight" size={16} color={colors.textFaint} /></View> : null}
    </>
  );
  const box = [styles.callout, { backgroundColor: t.bg, borderColor: t.line }];
  if (!onPress) return <View style={box}>{content}</View>;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      onPress={() => {
        tap();
        onPress();
      }}
      style={(s) => [box, (s.pressed || hoveredIn(s)) && { borderColor: t.fg }]}
    >
      {content}
    </Pressable>
  );
}

/** What a list shows while it has nothing to list. */
export function Empty({ icon, text }: { icon?: IconName; text: string }) {
  return (
    <View style={[styles.card, styles.empty]}>
      {icon ? <Icon name={icon} size={22} color={colors.textFaint} strokeWidth={1.6} /> : null}
      <T variant="label" color={colors.textSoft} center>{text}</T>
    </View>
  );
}

// ---------------------------------------------------------------- actions

/** Shrinks slightly while pressed, for every tappable surface. */
function usePressScale() {
  const scale = useRef(new Animated.Value(1)).current;
  const to = (v: number) => Animated.spring(scale, { toValue: v, useNativeDriver: nativeDriver, speed: 40, bounciness: 0 }).start();
  return { scale, onPressIn: () => to(0.98), onPressOut: () => to(1) };
}

type ButtonKind = "primary" | "secondary" | "ghost" | "danger";

const buttonColors: Record<ButtonKind, { bg: string; hover: string; fg: string; border?: string }> = {
  primary: { bg: colors.primary, hover: colors.primaryDeep, fg: colors.onPrimary },
  secondary: { bg: colors.surfaceHigh, hover: "#DDE9F8", fg: colors.text, border: colors.line },
  ghost: { bg: "transparent", hover: tones.primary.bg, fg: colors.primary },
  danger: { bg: "transparent", hover: tones.danger.bg, fg: colors.danger, border: tones.danger.line },
};

export function Button({ title, onPress, busy, disabled, kind = "primary", icon, size = "lg" }: {
  title: string;
  onPress: () => void;
  busy?: boolean;
  disabled?: boolean;
  kind?: ButtonKind;
  icon?: IconName;
  size?: "lg" | "sm";
}) {
  const { scale, onPressIn, onPressOut } = usePressScale();
  const c = buttonColors[kind];
  const off = disabled || busy;
  const small = size === "sm";
  // A button that cannot be used yet is a quiet outline, not a dimmed copy of the real one.
  const idle = Boolean(disabled) && !busy;
  const fg = idle ? colors.textFaint : c.fg;
  return (
    <Animated.View style={{ transform: [{ scale }] }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled: Boolean(off), busy: Boolean(busy) }}
        accessibilityLabel={title}
        onPress={() => {
          tap();
          onPress();
        }}
        onPressIn={onPressIn}
        onPressOut={onPressOut}
        disabled={off}
        style={(s) => [
          styles.button,
          { height: small ? 34 : 50, borderRadius: small ? radius.sm : radius.md, paddingHorizontal: small ? space.md + 2 : space.xl },
          idle
            ? { backgroundColor: kind === "primary" || kind === "secondary" ? "rgba(10, 31, 61, 0.04)" : "transparent", borderWidth: 1, borderColor: colors.line }
            : [{ backgroundColor: hoveredIn(s) && !off ? c.hover : c.bg }, c.border ? { borderWidth: 1, borderColor: c.border } : null],
        ]}
      >
        {busy ? (
          <ActivityIndicator color={c.fg} />
        ) : (
          <View style={styles.buttonInner}>
            {icon ? <Icon name={icon} size={small ? 14 : 18} color={fg} strokeWidth={2} /> : null}
            <T variant="bodyStrong" color={fg} numberOfLines={1} style={small ? { fontSize: 13, lineHeight: 18 } : { fontSize: 15.5 }}>{title}</T>
          </View>
        )}
      </Pressable>
    </Animated.View>
  );
}

export function IconButton({ icon, onPress, label }: { icon: IconName; onPress: () => void; label: string }) {
  const { scale, onPressIn, onPressOut } = usePressScale();
  return (
    <Animated.View style={{ transform: [{ scale }] }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        hitSlop={8}
        onPress={() => {
          tap();
          onPress();
        }}
        onPressIn={onPressIn}
        onPressOut={onPressOut}
        style={(s) => [styles.iconButton, hoveredIn(s) && { backgroundColor: "#DDE9F8" }]}
      >
        <Icon name={icon} size={18} color={colors.text} />
      </Pressable>
    </Animated.View>
  );
}

// ------------------------------------------------------------------- data

export interface Metric {
  label: string;
  value: string;
  /** Follows the number in small type: "d", "×". */
  unit?: string;
  /** Follows the label in faint type: what the number is counted in. */
  hint?: string;
  color?: string;
}

/**
 * Figures in a grid, split by hairlines. On its own surface, or `bare` at the foot of a card that
 * has no padding of its own.
 */
export function Metrics({ items, columns = 2, bare }: { items: Metric[]; columns?: 2 | 3 | 4; bare?: boolean }) {
  const rows: Metric[][] = [];
  for (let i = 0; i < items.length; i += columns) rows.push(items.slice(i, i + columns));
  return (
    <View style={bare ? null : [styles.card, { gap: 0 }]}>
      {rows.map((row, r) => (
        <View key={r} style={[{ flexDirection: "row" }, (r > 0 || bare) && styles.cellTop]}>
          {row.map((it, i) => (
            <View key={it.label} style={[styles.cell, i > 0 && styles.cellLeft]}>
              <View style={{ flexDirection: "row", alignItems: "baseline", gap: 6 }}>
                <T variant="small" color={colors.textSoft} numberOfLines={1} style={{ flexShrink: 1 }}>{it.label}</T>
                {it.hint ? <T variant="small" color={colors.textFaint} numberOfLines={1}>{it.hint}</T> : null}
              </View>
              <View style={styles.valueRow}>
                <T variant="number" color={it.color ?? colors.text} style={[styles.tabular, { flexShrink: 1 }]} numberOfLines={1}>{it.value}</T>
                {it.unit ? <T variant="small" color={colors.textSoft}>{it.unit}</T> : null}
              </View>
            </View>
          ))}
          {/* An odd figure out keeps its column's width. */}
          {row.length < columns ? Array.from({ length: columns - row.length }, (_, i) => <View key={`pad${i}`} style={{ flex: 1 }} />) : null}
        </View>
      ))}
    </View>
  );
}

/** A grouped list on one surface; rows are separated by hairlines. */
export function List({ children, bare }: { children: ReactNode; bare?: boolean }) {
  const rows = (Array.isArray(children) ? children : [children]).flat().filter(Boolean);
  if (rows.length === 0) return null;
  return (
    <View style={bare ? null : [styles.card, { padding: 0, gap: 0 }]}>
      {rows.map((row, i) => (
        <View key={i}>
          {i > 0 || bare ? <View style={[styles.rowDivider, bare && { marginLeft: 0 }]} /> : null}
          {row}
        </View>
      ))}
    </View>
  );
}

export function Row({ icon, title, subtitle, value, valueColor, right, onPress, chevron, danger }: {
  icon?: IconName;
  title: string;
  subtitle?: string;
  value?: string;
  valueColor?: string;
  right?: ReactNode;
  onPress?: () => void;
  chevron?: boolean;
  danger?: boolean;
}) {
  const content = (
    <View style={styles.row}>
      {icon ? <Icon name={icon} size={18} color={danger ? colors.danger : colors.textSoft} /> : null}
      <View style={{ flex: 1, gap: 1 }}>
        <T variant="body" color={danger ? colors.danger : colors.text} numberOfLines={1}>{title}</T>
        {subtitle ? <T variant="small" color={colors.textSoft} numberOfLines={1}>{subtitle}</T> : null}
      </View>
      {value ? <T variant="bodyStrong" color={valueColor ?? colors.text} style={styles.tabular} numberOfLines={1}>{value}</T> : null}
      {right}
      {chevron ? <Icon name="chevronRight" size={16} color={colors.textFaint} /> : null}
    </View>
  );
  if (!onPress) return content;
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => {
        tap();
        onPress();
      }}
      style={(s) => (s.pressed ? { backgroundColor: PRESSED } : hoveredIn(s) ? { backgroundColor: HOVER } : null)}
    >
      {content}
    </Pressable>
  );
}

export function Input({ style, ...props }: TextInputProps) {
  const [focused, setFocused] = useState(false);
  return (
    <TextInput
      placeholderTextColor={colors.textFaint}
      selectionColor={colors.primary}
      {...props}
      onFocus={(e) => {
        setFocused(true);
        props.onFocus?.(e);
      }}
      onBlur={(e) => {
        setFocused(false);
        props.onBlur?.(e);
      }}
      style={[styles.input, { borderColor: focused ? colors.primary : colors.lineStrong }, webNoOutline, style]}
    />
  );
}

export function Progress({ value, tone = "primary" }: { value: number; tone?: "positive" | "primary" }) {
  const pct = Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
    <View style={styles.track} accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: 100, now: pct }}>
      <View style={{ width: `${pct}%`, height: "100%", borderRadius: 2, backgroundColor: tone === "positive" ? colors.positive : colors.primary }} />
    </View>
  );
}

// --------------------------------------------------------------- feedback

const noticeTone: Record<"info" | "success" | "warning" | "error", Tone> = { info: "neutral", success: "positive", warning: "warning", error: "danger" };

/** One line of feedback. Renders nothing when empty. */
export function Notice({ tone = "info", children }: { tone?: "info" | "success" | "warning" | "error"; children: ReactNode }) {
  if (!children) return null;
  const t = tones[noticeTone[tone]];
  return (
    <View accessibilityLiveRegion="polite" style={[styles.notice, { backgroundColor: t.bg }]}>
      <T variant="label" color={tone === "info" ? colors.textSoft : t.fg}>{children}</T>
    </View>
  );
}

export function ErrorText({ children }: { children: ReactNode }) {
  return <Notice tone="error">{children}</Notice>;
}

/** A placeholder block that pulses while data loads. */
export function Skeleton({ width = "100%", height = 18, rounded = 6 }: { width?: number | `${number}%`; height?: number; rounded?: number }) {
  const opacity = useRef(new Animated.Value(0.5)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 1, duration: 700, useNativeDriver: nativeDriver }),
        Animated.timing(opacity, { toValue: 0.5, duration: 700, useNativeDriver: nativeDriver }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [opacity]);
  return <Animated.View style={{ width, height, borderRadius: rounded, backgroundColor: colors.surfaceHigh, opacity }} />;
}

// A browser draws its own ring around a focused field; the gold border already shows the focus.
const webNoOutline = Platform.OS === "web" ? ({ outlineStyle: "none" } as unknown as TextStyle) : null;

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  scroll: { flexGrow: 1, paddingBottom: space.xxxl },
  scrollCenter: { justifyContent: "center" },
  inner: { width: "100%", maxWidth: layout.column, alignSelf: "center", paddingHorizontal: space.xl, paddingTop: space.md, gap: space.xl },
  innerPage: { maxWidth: layout.page, paddingHorizontal: 40, paddingTop: space.xxxl, gap: space.xxl },
  innerPanel: {
    maxWidth: 480, marginVertical: space.xxxl, paddingHorizontal: space.xxxl, paddingTop: space.xxxl, paddingBottom: space.xxxl,
    backgroundColor: colors.bgRaised, borderRadius: radius.xl, borderWidth: 1, borderColor: colors.line,
  },
  innerCenter: { flexGrow: 1, justifyContent: "center" },
  footer: { marginTop: "auto", paddingTop: space.xxl, paddingHorizontal: space.xl, alignItems: "center" },
  columns: { gap: space.xl },
  columnsWide: { flexDirection: "row", alignItems: "flex-start", gap: space.xxl },
  header: { flexDirection: "row", alignItems: "center", gap: space.md, paddingTop: space.sm, minHeight: 44 },
  topBar: { flexDirection: "row", alignItems: "center", gap: space.md },
  sectionHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 2, minHeight: 20 },
  figure: { flexDirection: "row", alignItems: "baseline", gap: space.sm },
  card: { backgroundColor: colors.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line, gap: space.md, overflow: "hidden" },
  callout: { flexDirection: "row", gap: space.md, borderRadius: radius.lg, borderWidth: 1, paddingHorizontal: space.lg, paddingVertical: 14 },
  empty: { alignItems: "center", justifyContent: "center", gap: space.sm, paddingVertical: space.xxxl, paddingHorizontal: space.xl },
  pill: { flexDirection: "row", alignItems: "center", alignSelf: "flex-start", gap: 6, borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 5 },
  button: { alignItems: "center", justifyContent: "center" },
  buttonInner: { flexDirection: "row", alignItems: "center", gap: space.sm },
  iconButton: { width: 40, height: 40, borderRadius: radius.md, backgroundColor: colors.surfaceHigh, alignItems: "center", justifyContent: "center" },
  cell: { flex: 1, minWidth: 0, gap: 4, paddingHorizontal: space.lg, paddingVertical: 14 },
  cellLeft: { borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: colors.lineStrong },
  cellTop: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.lineStrong },
  valueRow: { flexDirection: "row", alignItems: "baseline", gap: 4 },
  tabular: { fontVariant: ["tabular-nums"] },
  row: { flexDirection: "row", alignItems: "center", gap: space.md, paddingHorizontal: space.lg, paddingVertical: 13, minHeight: 50 },
  rowDivider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.lineStrong, marginLeft: space.lg },
  input: { borderWidth: 1, borderRadius: radius.md, paddingHorizontal: space.lg, paddingVertical: 14, color: colors.text, backgroundColor: colors.surface, ...type.body, fontSize: 16 },
  track: { height: 4, borderRadius: 2, overflow: "hidden", backgroundColor: colors.surfaceHigh },
  notice: { borderRadius: radius.md, paddingHorizontal: space.md, paddingVertical: 10 },
});
