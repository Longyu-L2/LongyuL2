import { useEffect } from "react";
import { View } from "react-native";
import { Redirect } from "expo-router";
import { walletChangeReturned } from "@/lib/core";
import { forgetInvite, invitedWith } from "@/lib/invite-link";
import { useApp } from "@/lib/app-state";
import { colors } from "@/design/tokens";
import { PearlMark } from "@/components/Pearl";
import { LoadRetry } from "@/components/SignedIn";

/** Sends people to sign-in, account setup, or the app, depending on where they are. */
export default function Index() {
  const { ready, signedIn, me } = useApp();
  useEffect(() => {
    if (signedIn) forgetInvite();
  }, [signedIn]);
  if (!ready) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.bg }}>
        <PearlMark size={56} />
      </View>
    );
  }
  if (!signedIn) {
    // An invite link lands here. Its code stays in the sign-in page's address, so a visitor who
    // moves from an app's built-in browser to their own takes it along.
    const invite = invitedWith();
    return <Redirect href={invite ? { pathname: "/sign-in", params: { invite } } : "/sign-in"} />;
  }
  // Without the account there is no telling whether it still needs setting up.
  if (!me) return <LoadRetry />;
  // In a browser, replacing a wallet goes by way of X and comes back here: carry on where it left.
  if (walletChangeReturned()) return <Redirect href="/setup" />;
  if (!me.deviceAttested || !me.wallet) return <Redirect href="/setup" />;
  return <Redirect href="/mine" />;
}
