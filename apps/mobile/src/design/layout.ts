import { useWindowDimensions } from "react-native";
import { layout } from "./tokens";

/** True in a window wide enough for the side rail and columns (see `layout` in tokens). */
export function useWide(): boolean {
  return useWindowDimensions().width >= layout.wide;
}

/** True in a window with room for three columns beside the rail. */
export function useRoomy(): boolean {
  return useWindowDimensions().width >= layout.roomy;
}
