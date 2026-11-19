import { useWindowDimensions } from "react-native";
import { layout } from "./tokens";

/** True in a window wide enough for the side rail and columns (see `layout` in tokens). */
export function useWide(): boolean {
  return useWindowDimensions().width >= layout.wide;
}
