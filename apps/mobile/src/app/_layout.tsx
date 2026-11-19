import { View } from "react-native";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { AppStateProvider } from "@/lib/app-state";
import { useAppFonts } from "@/design/fonts";
import { colors } from "@/design/tokens";

export default function RootLayout() {
  // The account starts loading at once, while the typefaces do.
  return (
    <AppStateProvider>
      <Shell />
    </AppStateProvider>
  );
}

function Shell() {
  const fontsReady = useAppFonts();
  if (!fontsReady) return <View style={{ flex: 1, backgroundColor: colors.bg }} />;
  return (
    <>
      <StatusBar style="dark" />
      {/* Every screen lays itself out for the window it is in: a phone's column, or a wide page. */}
      <Stack screenOptions={{ title: "LONGYU MINE", headerShown: false, contentStyle: { backgroundColor: colors.bg }, animation: "fade_from_bottom" }}>
        <Stack.Screen name="export-key" options={{ presentation: "modal", animation: "slide_from_bottom" }} />
      </Stack>
    </>
  );
}
