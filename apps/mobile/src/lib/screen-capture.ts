/**
 * Keeps the app's window out of screenshots, screen recordings and the recent-apps preview while a
 * screen shows a secret. A system that cannot do it still shows the screen: failures are ignored.
 */
import * as ScreenCapture from "expo-screen-capture";

const quiet = () => undefined;

/** Resolves once the window is hidden from capture. `key` names who asked, so two askers do not undo each other. */
export function hideFromCapture(key: string): Promise<void> {
  return ScreenCapture.preventScreenCaptureAsync(key).catch(quiet);
}

export function showToCapture(key: string): void {
  ScreenCapture.allowScreenCaptureAsync(key).catch(quiet);
}
