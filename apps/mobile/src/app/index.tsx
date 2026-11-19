import { View } from "react-native";
import { Redirect } from "expo-router";
import { walletChangeReturned } from "@/lib/core";
import { useApp } from "@/lib/app-state";
import { colors } from "@/design/tokens";
import { PearlMark } from "@/components/Pearl";
import { LoadRetry } from "@/components/SignedIn";

/** Sends people to sign-in, account setup, or the app, depending on where they are. */
export default function Index() {
  const { ready, signedIn, me } = useApp();
  if (!ready) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.bg }}>
        <PearlMark size={56} />
      </View>
    );
  }
  if (!signedIn) return <Redirect href="/sign-in" />;
  // Without the account there is no telling whether it still needs setting up.
  if (!me) return <LoadRetry />;
  // In a browser, replacing a wallet goes by way of X and comes back here: carry on where it left.
  if (walletChangeReturned()) return <Redirect href="/setup" />;
  if (!me.deviceAttested || !me.wallet) return <Redirect href="/setup" />;
  return <Redirect href="/mine" />;
}
