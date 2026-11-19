import { Tabs } from "expo-router";
import { useApp } from "@/lib/app-state";
import { colors } from "@/design/tokens";
import { useWide } from "@/design/layout";
import { NavBar } from "@/components/NavBar";
import { SignedIn } from "@/components/SignedIn";

export default function TabsLayout() {
  const { t } = useApp();
  const wide = useWide();
  return (
    <SignedIn setUp>
      <Tabs
        tabBar={(props) => <NavBar {...props} />}
        screenOptions={{
          headerShown: false,
          sceneStyle: { backgroundColor: colors.bg },
          // A side rail in a wide window, a bar along the bottom of a phone.
          tabBarPosition: wide ? "left" : "bottom",
        }}
      >
        <Tabs.Screen name="mine" options={{ title: t("tabMine") }} />
        <Tabs.Screen name="wallet" options={{ title: t("tabWallet") }} />
        <Tabs.Screen name="network" options={{ title: t("tabNetwork") }} />
        <Tabs.Screen name="profile" options={{ title: t("tabProfile") }} />
        {/* Opened from Mine; the bar keeps Mine lit (see NavBar). */}
        <Tabs.Screen name="boost" options={{ title: t("capacityTitle") }} />
      </Tabs>
    </SignedIn>
  );
}
