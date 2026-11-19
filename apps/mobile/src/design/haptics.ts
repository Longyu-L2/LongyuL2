/**
 * Light touch feedback. Android uses its system haptics (no vibration permission needed); iOS its
 * haptic engine; the web preview stays silent. Failures are ignored: feedback is never essential.
 */
import { Platform } from "react-native";
import * as Haptics from "expo-haptics";

const quiet = () => undefined;

export function tap(): void {
  if (Platform.OS === "android") Haptics.performAndroidHapticsAsync(Haptics.AndroidHaptics.Virtual_Key).catch(quiet);
  else if (Platform.OS === "ios") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(quiet);
}

export function select(): void {
  if (Platform.OS === "android") Haptics.performAndroidHapticsAsync(Haptics.AndroidHaptics.Segment_Tick).catch(quiet);
  else if (Platform.OS === "ios") Haptics.selectionAsync().catch(quiet);
}

export function success(): void {
  if (Platform.OS === "android") Haptics.performAndroidHapticsAsync(Haptics.AndroidHaptics.Confirm).catch(quiet);
  else if (Platform.OS === "ios") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(quiet);
}

export function failure(): void {
  if (Platform.OS === "android") Haptics.performAndroidHapticsAsync(Haptics.AndroidHaptics.Reject).catch(quiet);
  else if (Platform.OS === "ios") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(quiet);
}
