/**
 * A sheet for confirmations and short forms: it rises from the bottom of a phone, and is a dialog
 * in the middle of a wide window. Tapping outside or the back button closes it.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Animated, Easing, KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { colors, radius, space } from "@/design/tokens";
import { useWide } from "@/design/layout";
import { IconButton, T } from "./ui";

const nativeDriver = Platform.OS !== "web";

export function Sheet({ visible, title, onClose, children, closeLabel = "Close" }: {
  visible: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  closeLabel?: string;
}) {
  const insets = useSafeAreaInsets();
  const wide = useWide();
  const progress = useRef(new Animated.Value(0)).current;
  const [mounted, setMounted] = useState(visible);

  useEffect(() => {
    if (visible) setMounted(true);
    Animated.timing(progress, {
      toValue: visible ? 1 : 0,
      duration: visible ? 280 : 200,
      easing: visible ? Easing.out(Easing.cubic) : Easing.in(Easing.cubic),
      useNativeDriver: nativeDriver,
    }).start(({ finished }) => {
      if (finished && !visible) setMounted(false);
    });
  }, [visible, progress]);

  if (!mounted) return null;
  const translateY = progress.interpolate({ inputRange: [0, 1], outputRange: [wide ? 16 : 480, 0] });
  return (
    <Modal visible transparent animationType="none" onRequestClose={onClose} statusBarTranslucent>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1, justifyContent: wide ? "center" : "flex-end", padding: wide ? space.xxl : 0 }}>
        <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: colors.scrim, opacity: progress }]}>
          <Pressable style={{ flex: 1 }} onPress={onClose} accessibilityLabel={closeLabel} />
        </Animated.View>
        <Animated.View
          style={[styles.sheet, wide ? [styles.dialog, { opacity: progress }] : { paddingBottom: insets.bottom + space.xl }, { transform: [{ translateY }] }]}
          accessibilityViewIsModal
        >
          {wide ? null : <View style={styles.handle} />}
          <View style={styles.head}>
            <T variant="headline" style={{ flex: 1 }} accessibilityRole="header">{title}</T>
            <IconButton icon="close" label={closeLabel} onPress={onClose} />
          </View>
          {children}
        </Animated.View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  sheet: {
    width: "100%",
    maxWidth: 560,
    alignSelf: "center",
    backgroundColor: colors.bgRaised,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    borderWidth: 1,
    borderBottomWidth: 0,
    borderColor: colors.lineStrong,
    paddingHorizontal: space.xl,
    paddingTop: space.md,
    gap: space.lg,
  },
  dialog: { maxWidth: 480, borderRadius: radius.xl, borderBottomWidth: 1, paddingHorizontal: space.xxl, paddingTop: space.xl, paddingBottom: space.xxl },
  handle: { alignSelf: "center", width: 40, height: 4, borderRadius: 2, backgroundColor: colors.lineStrong },
  head: { flexDirection: "row", alignItems: "center", gap: space.md },
});
