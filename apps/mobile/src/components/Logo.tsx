/**
 * LONGYU's logo: the mark (an L with the dragon pearl in its arm) and the wordmark. Both are drawn
 * from the brand kit's numbers (brand/), so they look the same on every device.
 */
import { useId } from "react";
import { View } from "react-native";
import Svg, { Circle, Defs, LinearGradient, Path, Stop } from "react-native-svg";
import { MARK_HEIGHT, MARK_LETTER, MARK_PEARL, MARK_WIDTH, WORDMARK, WORDMARK_HEIGHT, WORDMARK_PAD, WORDMARK_WIDTH } from "@/design/brand";
import { colors } from "@/design/tokens";

/** The mark, `height` tall: blue running to azure at its foot, or one flat `color`. */
export function Mark({ height = 24, color }: { height?: number; color?: string }) {
  const id = `mk${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  return (
    <Svg width={(height * MARK_WIDTH) / MARK_HEIGHT} height={height} viewBox={`0 0 ${MARK_WIDTH} ${MARK_HEIGHT}`} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {color ? null : (
        <Defs>
          <LinearGradient id={id} gradientUnits="userSpaceOnUse" x1={0} y1={0} x2={0} y2={MARK_HEIGHT}>
            <Stop offset="0" stopColor={colors.primary} />
            <Stop offset="1" stopColor={colors.azure} />
          </LinearGradient>
        </Defs>
      )}
      <Path d={MARK_LETTER} fill={color ?? `url(#${id})`} />
      <Circle cx={MARK_PEARL.cx} cy={MARK_PEARL.cy} r={MARK_PEARL.r} fill={color ?? colors.primary} />
    </Svg>
  );
}

/** LONGYU, with capitals `capHeight` tall. */
export function Wordmark({ capHeight, color = colors.text }: { capHeight: number; color?: string }) {
  const box = WORDMARK_HEIGHT + 2 * WORDMARK_PAD;
  const height = (capHeight * box) / WORDMARK_HEIGHT;
  return (
    <View accessible accessibilityRole="image" accessibilityLabel="LONGYU">
      <Svg width={(height * WORDMARK_WIDTH) / box} height={height} viewBox={`0 0 ${WORDMARK_WIDTH} ${box}`}>
        <Path d={WORDMARK} fill={color} />
      </Svg>
    </View>
  );
}
