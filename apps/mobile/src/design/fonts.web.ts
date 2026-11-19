/**
 * Web: declares the same faces as the native builds, under the same
 * family names, so screens render with identical typography.
 *
 * A browser gets Latin subsets in WOFF2 (assets/fonts/web), a sixth of the size of the full
 * files. Other scripts fall through to the system's fonts, as they do in the native builds.
 */
import { useEffect, useState } from "react";
import { fonts } from "./tokens";

const files: Record<string, number> = {
  [fonts.display]: require("../../assets/fonts/web/Sora-Bold.woff2"),
  [fonts.heading]: require("../../assets/fonts/web/Sora-SemiBold.woff2"),
  [fonts.body]: require("../../assets/fonts/web/Inter-Regular.woff2"),
  [fonts.medium]: require("../../assets/fonts/web/Inter-Medium.woff2"),
  [fonts.strong]: require("../../assets/fonts/web/Inter-SemiBold.woff2"),
  [fonts.mono]: require("../../assets/fonts/web/JetBrainsMono-Medium.woff2"),
};

const uri = (asset: unknown): string =>
  typeof asset === "string" ? asset : (asset as { uri?: string; default?: string }).uri ?? (asset as { default: string }).default;

/** How long the first screen waits for its fonts. On a slow line it shows in the system's, then changes. */
const WAIT_MS = 1500;

export function useAppFonts(): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const done = () => setReady(true);
    const timer = setTimeout(done, WAIT_MS);
    const faces = Object.entries(files).map(([family, asset]) => new FontFace(family, `url(${uri(asset)}) format("woff2")`, { display: "swap" }));
    // Each face is put to use as it arrives, also after the wait is over.
    void Promise.all(faces.map((f) => f.load().then((face) => document.fonts.add(face), () => undefined))).then(() => {
      clearTimeout(timer);
      done();
    });
    return () => clearTimeout(timer);
  }, []);
  return ready;
}
