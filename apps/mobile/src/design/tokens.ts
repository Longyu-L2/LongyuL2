/**
 * LONGYU design tokens, from the brand kit (brand/tokens.json): a pale sky ground with white cards,
 * ink for text, and one blue for actions, the logo and mining. Green, amber and red only report
 * a state. Every screen takes its colours, type and spacing from here.
 */
import type { TextStyle } from "react-native";

export const colors = {
  bg: "#F4F9FE",
  bgRaised: "#FFFFFF",
  surface: "#FFFFFF",
  surfaceHigh: "#EAF2FC",
  line: "rgba(10, 31, 61, 0.09)",
  lineStrong: "rgba(10, 31, 61, 0.17)",
  text: "#0A1F3D",
  textSoft: "#4B5F7D",
  textFaint: "#5F718A",
  primary: "#0B6FDB",
  primaryDeep: "#0857AD",
  onPrimary: "#FFFFFF",
  azure: "#8CC6FA",
  sky: "#E6F4FE",
  positive: "#0B8058",
  danger: "#D92D20",
  warning: "#A8610B",
  scrim: "rgba(10, 31, 61, 0.42)",
} as const;

export type Tone = "neutral" | "positive" | "primary" | "warning" | "danger";

/** Foreground and tinted background for each tone (pills, icons, notices). */
export const tones: Record<Tone, { fg: string; bg: string; line: string }> = {
  neutral: { fg: colors.textSoft, bg: "rgba(10, 31, 61, 0.05)", line: colors.line },
  positive: { fg: colors.positive, bg: "rgba(11, 128, 88, 0.08)", line: "rgba(11, 128, 88, 0.26)" },
  primary: { fg: colors.primary, bg: "rgba(11, 111, 219, 0.08)", line: "rgba(11, 111, 219, 0.28)" },
  warning: { fg: colors.warning, bg: "rgba(168, 97, 11, 0.08)", line: "rgba(168, 97, 11, 0.28)" },
  danger: { fg: colors.danger, bg: "rgba(217, 45, 32, 0.07)", line: "rgba(217, 45, 32, 0.26)" },
};

/** Font faces embedded by the expo-font config plugin (app.json), named after their PostScript names. */
export const fonts = {
  display: "Sora-Bold",
  heading: "Sora-SemiBold",
  body: "Inter-Regular",
  medium: "Inter-Medium",
  strong: "Inter-SemiBold",
  mono: "JetBrainsMono-Medium",
} as const;

export const type = {
  // Sora for numbers and the wordmark only; Inter for everything people read.
  figure: { fontFamily: fonts.heading, fontSize: 56, lineHeight: 62, letterSpacing: -1.8 },
  hero: { fontFamily: fonts.heading, fontSize: 40, lineHeight: 46, letterSpacing: -1.2 },
  display: { fontFamily: fonts.heading, fontSize: 30, lineHeight: 36, letterSpacing: -0.6 },
  number: { fontFamily: fonts.heading, fontSize: 20, lineHeight: 26, letterSpacing: -0.3 },
  title: { fontFamily: fonts.strong, fontSize: 24, lineHeight: 30, letterSpacing: -0.5 },
  headline: { fontFamily: fonts.strong, fontSize: 17, lineHeight: 22, letterSpacing: -0.2 },
  body: { fontFamily: fonts.body, fontSize: 15, lineHeight: 21 },
  bodyStrong: { fontFamily: fonts.strong, fontSize: 15, lineHeight: 21 },
  label: { fontFamily: fonts.medium, fontSize: 13, lineHeight: 18 },
  small: { fontFamily: fonts.body, fontSize: 12, lineHeight: 16 },
  caption: { fontFamily: fonts.strong, fontSize: 13, lineHeight: 18 },
  mono: { fontFamily: fonts.mono, fontSize: 13, lineHeight: 18 },
} satisfies Record<string, TextStyle>;

export type TypeVariant = keyof typeof type;

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 20, xxl: 24, xxxl: 32 } as const;
export const radius = { sm: 8, md: 12, lg: 16, xl: 24, pill: 999 } as const;

/**
 * One layout for every size of window. From `wide` up (a computer, a tablet on its side) the tabs
 * become a side rail and a screen sets its content in columns; below it, one column the width of
 * a phone. From `roomy` up there is room for a third column.
 */
export const layout = { wide: 1024, roomy: 1280, column: 560, page: 1200, rail: 248 } as const;

/** Numbers that change in place (timers, balances) keep their width. */
export const tabular: TextStyle = { fontVariant: ["tabular-nums"] };
