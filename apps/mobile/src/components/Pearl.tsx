/**
 * The dragon pearl (龙珠): LONGYU's mining control. A blue sphere set in an instrument dial: a
 * bezel of quarter-hour marks that light up as the session runs, and a fine ring whose head marks
 * the time. It breathes while mining, rests as pale stone between sessions, and pulses gently when
 * a new session can start. Tapping it starts the session.
 */
import { useEffect, useId, useRef, useState } from "react";
import { AccessibilityInfo, Animated, Easing, Platform, Pressable, View } from "react-native";
import Svg, { Circle, Defs, Ellipse, G, Path, RadialGradient, Stop } from "react-native-svg";
import { colors } from "@/design/tokens";

export type PearlState = "mining" | "ready" | "resting";

const nativeDriver = Platform.OS !== "web";

// The brand's blue, and a pale grey-blue stone for rest. From the lit side to the shaded edge.
const BLUE = ["#F2F9FF", "#A9D3FB", "#3E93EC", "#0B63C6", "#084894"];
const STONE = ["#FFFFFF", "#EEF3F9", "#D3DDEA", "#B3C0D2", "#97A6BB"];

/** Marks on the bezel: one per quarter hour, longer on the hour, longest every six hours. */
const MARKS = 96;
const UNLIT = ["rgba(10, 31, 61, 0.14)", "rgba(10, 31, 61, 0.24)", "rgba(10, 31, 61, 0.38)"];
const WEIGHT = [1, 1.2, 1.8];

function useReduceMotion(): boolean {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    void AccessibilityInfo.isReduceMotionEnabled().then(setReduce);
    const sub = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduce);
    return () => sub.remove();
  }, []);
  return reduce;
}

const svgId = (id: string) => id.replace(/[^a-zA-Z0-9]/g, "");

export function Pearl({ state, progress, size = 260, onPress, label }: {
  state: PearlState;
  /** Fraction of the 24-hour session elapsed, 0 to 1. */
  progress: number;
  size?: number;
  onPress?: () => void;
  /** Screen-reader description of the control. */
  label: string;
}) {
  const id = svgId(useId());
  const reduce = useReduceMotion();
  const breath = useRef(new Animated.Value(0)).current;
  const press = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    breath.setValue(0);
    if (reduce || state === "resting") return;
    const period = state === "mining" ? 2800 : 1900;
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(breath, { toValue: 1, duration: period, easing: Easing.inOut(Easing.sin), useNativeDriver: nativeDriver }),
      Animated.timing(breath, { toValue: 0, duration: period, easing: Easing.inOut(Easing.sin), useNativeDriver: nativeDriver }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [state, reduce, breath]);

  const c = size / 2;
  const bezelR = c - 2;
  const ringR = c - size * 0.105;
  const pearlR = ringR - size * 0.095;
  const p = Math.min(1, Math.max(0, progress));
  const mining = state === "mining";
  const resting = state === "resting";
  const stops = resting ? STONE : BLUE;
  const circumference = 2 * Math.PI * ringR;
  const angle = (-90 + 360 * p) * (Math.PI / 180);
  const head = { x: c + ringR * Math.cos(angle), y: c + ringR * Math.sin(angle) };

  // The bezel, drawn as a few paths: the marks of one kind and one state share a stroke.
  const lit = ["", "", ""];
  const unlit = ["", "", ""];
  for (let i = 0; i < MARKS; i++) {
    const kind = i % 24 === 0 ? 2 : i % 4 === 0 ? 1 : 0;
    const a = (i / MARKS) * 2 * Math.PI - Math.PI / 2;
    const r1 = bezelR - size * [0.022, 0.034, 0.05][kind]!;
    const seg = `M${(c + r1 * Math.cos(a)).toFixed(2)} ${(c + r1 * Math.sin(a)).toFixed(2)}L${(c + bezelR * Math.cos(a)).toFixed(2)} ${(c + bezelR * Math.sin(a)).toFixed(2)}`;
    if (mining && i / MARKS < p) lit[kind] += seg;
    else unlit[kind] += seg;
  }

  const glowOpacity = resting ? 0 : breath.interpolate({ inputRange: [0, 1], outputRange: mining ? [0.55, 1] : [0.3, 0.8] });
  const pearlScale = Animated.multiply(press, resting ? 1 : breath.interpolate({ inputRange: [0, 1], outputRange: [1, 1.018] }));

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !onPress }}
      disabled={!onPress}
      onPress={onPress}
      onPressIn={() => Animated.spring(press, { toValue: 0.965, useNativeDriver: nativeDriver, speed: 40, bounciness: 0 }).start()}
      onPressOut={() => Animated.spring(press, { toValue: 1, useNativeDriver: nativeDriver, speed: 18, bounciness: 6 }).start()}
      style={{ width: size, height: size, alignSelf: "center" }}
    >
      {/* The light the pearl throws on the dial */}
      <Animated.View pointerEvents="none" style={{ position: "absolute", width: size, height: size, opacity: glowOpacity }}>
        <Svg width={size} height={size}>
          <Defs>
            <RadialGradient id={`${id}glow`} cx="50%" cy="50%" r="50%">
              <Stop offset="0.5" stopColor={colors.azure} stopOpacity={0.55} />
              <Stop offset="0.78" stopColor={colors.azure} stopOpacity={0.14} />
              <Stop offset="1" stopColor={colors.azure} stopOpacity={0} />
            </RadialGradient>
          </Defs>
          <Circle cx={c} cy={c} r={ringR - 3} fill={`url(#${id}glow)`} />
        </Svg>
      </Animated.View>

      {/* Bezel and session ring */}
      <Svg width={size} height={size} style={{ position: "absolute" }} pointerEvents="none">
        {unlit.map((d, kind) => (d ? <Path key={`u${kind}`} d={d} stroke={UNLIT[kind]} strokeWidth={WEIGHT[kind]} strokeLinecap="round" fill="none" /> : null))}
        {lit.map((d, kind) => (d ? <Path key={`l${kind}`} d={d} stroke={kind === 0 ? colors.primary : colors.primaryDeep} strokeOpacity={kind === 0 ? 0.8 : 1} strokeWidth={WEIGHT[kind]} strokeLinecap="round" fill="none" /> : null))}
        <Circle cx={c} cy={c} r={ringR} stroke={colors.lineStrong} strokeWidth={1} fill="none" />
        {mining && p > 0 ? (
          <G>
            <Circle
              cx={c} cy={c} r={ringR} stroke={colors.primary} strokeWidth={2.5} fill="none" strokeLinecap="round"
              strokeDasharray={`${circumference} ${circumference}`} strokeDashoffset={circumference * (1 - p)}
              transform={`rotate(-90 ${c} ${c})`}
            />
            <Circle cx={head.x} cy={head.y} r={9} fill={colors.primary} opacity={0.18} />
            <Circle cx={head.x} cy={head.y} r={4.5} fill={colors.bg} />
            <Circle cx={head.x} cy={head.y} r={3} fill={colors.primary} />
          </G>
        ) : null}
      </Svg>

      {/* The pearl */}
      <Animated.View pointerEvents="none" style={{ position: "absolute", width: size, height: size, transform: [{ scale: pearlScale }] }}>
        <Svg width={size} height={size}>
          <Defs>
            <RadialGradient id={`${id}body`} cx="50%" cy="50%" r="50%" fx="37%" fy="29%">
              <Stop offset="0" stopColor={stops[0]} />
              <Stop offset="0.16" stopColor={stops[1]} />
              <Stop offset="0.5" stopColor={stops[2]} />
              <Stop offset="0.83" stopColor={stops[3]} />
              <Stop offset="1" stopColor={stops[4]} />
            </RadialGradient>
            <RadialGradient id={`${id}bounce`} cx="70%" cy="78%" r="42%">
              <Stop offset="0" stopColor={stops[1]} stopOpacity={resting ? 0.1 : 0.2} />
              <Stop offset="1" stopColor={stops[1]} stopOpacity={0} />
            </RadialGradient>
            <RadialGradient id={`${id}shine`} cx="50%" cy="50%" r="50%">
              <Stop offset="0" stopColor="#FFFFFF" stopOpacity={resting ? 0.7 : 0.62} />
              <Stop offset="1" stopColor="#FFFFFF" stopOpacity={0} />
            </RadialGradient>
          </Defs>
          <Circle cx={c} cy={c} r={pearlR} fill={`url(#${id}body)`} />
          <Circle cx={c} cy={c} r={pearlR} fill={`url(#${id}bounce)`} />
          <Circle cx={c} cy={c} r={pearlR - 0.5} fill="none" stroke={resting ? colors.lineStrong : colors.primaryDeep} strokeOpacity={resting ? 1 : 0.35} strokeWidth={1} />
          <Ellipse
            cx={c - pearlR * 0.34} cy={c - pearlR * 0.46} rx={pearlR * 0.27} ry={pearlR * 0.15} fill={`url(#${id}shine)`}
            transform={`rotate(-30 ${c - pearlR * 0.34} ${c - pearlR * 0.46})`}
          />
        </Svg>
      </Animated.View>
    </Pressable>
  );
}

/** A small static pearl for loading screens and empty states. */
export function PearlMark({ size = 28, dim = false }: { size?: number; dim?: boolean }) {
  const id = svgId(useId());
  const c = size / 2;
  const s = dim ? STONE : BLUE;
  return (
    <View style={{ width: size, height: size }}>
      <Svg width={size} height={size}>
        <Defs>
          <RadialGradient id={`${id}mark`} cx="50%" cy="50%" r="50%" fx="37%" fy="29%">
            <Stop offset="0" stopColor={s[0]} />
            <Stop offset="0.2" stopColor={s[1]} />
            <Stop offset="0.55" stopColor={s[2]} />
            <Stop offset="1" stopColor={s[4]} />
          </RadialGradient>
        </Defs>
        <Circle cx={c} cy={c} r={c - 1} fill={`url(#${id}mark)`} />
      </Svg>
    </View>
  );
}
