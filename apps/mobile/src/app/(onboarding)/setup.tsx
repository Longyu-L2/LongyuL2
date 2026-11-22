import { useEffect, useRef, useState } from "react";
import { Platform, View } from "react-native";
import { router } from "expo-router";
import type { PrivateKeyAccount } from "viem/accounts";
import { attestDevice, createWallet, importWallet, linkWallet, loadWallet, signInWithX, walletChangeReturned } from "@/lib/core";
import { useApp, type Me } from "@/lib/app-state";
import { errorKey, errorKeyOf } from "@/lib/errors";
import { checkKey, isWalletOf } from "@/lib/wallet-key";
import { colors, space } from "@/design/tokens";
import { Brand, Button, ErrorText, Input, List, Notice, Row, Screen, T } from "@/components/ui";
import { SignedIn } from "@/components/SignedIn";

/**
 * Account setup and repair: check the device (again every 30 days), then make sure this phone
 * holds the key of the account's wallet. A new phone can import the old key, or replace the wallet
 * after signing in with X again; rewards then follow to the new wallet within about two days.
 *
 * A browser has no device to check: it passes a human check instead, here and before every
 * session, unless the API has the check switched off (me.humanCheck false). It may also mine for a wallet whose key it does not hold (the key stays in the app),
 * since rewards are paid to the linked address and claiming needs no key.
 */
const web = Platform.OS === "web";

export default function SetupScreen() {
  const { me } = useApp();
  return <SignedIn>{me ? <Setup me={me} /> : null}</SignedIn>;
}

function Setup({ me }: { me: Me }) {
  const { t, refreshMe } = useApp();
  const [local, setLocal] = useState<PrivateKeyAccount | null | undefined>(undefined);
  const [importing, setImporting] = useState(false);
  const [key, setKey] = useState("");
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [replacing, setReplacing] = useState(false);

  useEffect(() => {
    loadWallet(me).then(setLocal, () => setLocal(null));
  }, [me]);

  const hasLinked = Boolean(me.wallet);
  const mismatch = hasLinked && local !== undefined && (!local || !isWalletOf(me, local.address));

  /** Runs one step and moves on to the app; a step that returns false stays here without an error. */
  const run = async (fn: () => Promise<void | false>) => {
    setBusy(true);
    setError("");
    try {
      if (!me.deviceAttested) {
        setStatus(t("checkingDevice"));
        await attestDevice();
      }
      if ((await fn()) === false) return;
      await refreshMe();
      router.replace("/mine");
    } catch (e) {
      setError(t(errorKeyOf(e)));
    } finally {
      setStatus("");
      setBusy(false);
    }
  };

  /** The typed key, when this account may keep it. Otherwise says why not, and nothing is stored. */
  const typedKey = () => {
    const typed = checkKey(me, key);
    if ("error" in typed) {
      setError(t(errorKey(typed.error)));
      return null;
    }
    return typed;
  };

  /** First wallet for a new account: a new key, or the one this account made here before and could not link. */
  const createFirst = () =>
    run(async () => {
      const account = (await loadWallet(me)) ?? (await createWallet(me));
      setStatus(t("linkingWallet"));
      await linkWallet(account);
    });

  /** First wallet for a new account, from the typed key and no other. It is kept once the API has taken it. */
  const importFirst = async () => {
    const typed = typedKey();
    if (!typed) return;
    await run(async () => {
      setStatus(t("linkingWallet"));
      await linkWallet(typed.account);
      await importWallet({ id: me.id, wallet: typed.account.address }, typed.key);
    });
  };

  /** On a phone without the linked wallet's key: import it, or replace the wallet. */
  const importExisting = async () => {
    const typed = typedKey();
    if (!typed) return;
    await run(async () => {
      await importWallet(me, typed.key);
    });
  };

  /** Replaces the linked wallet with the key on this phone (or a new one), after a fresh sign-in with X. */
  const replace = async () => {
    setReplacing(true);
    await run(async () => {
      const proof = await signInWithX("wallet-change");
      if (!proof) return false;
      // Read again rather than trusted from the screen: a key already kept is never written over.
      const account = (await loadWallet(me)) ?? (await createWallet(me));
      setLocal(account);
      setStatus(t("linkingWallet"));
      await linkWallet(account, { reauthTicket: proof.ticket, appVerifier: proof.appVerifier });
    });
    setReplacing(false);
  };

  // In a browser the X sign-in of a wallet change comes back as a fresh page: carry on from there, once.
  const resumed = useRef(false);
  useEffect(() => {
    if (resumed.current || !mismatch || !walletChangeReturned()) return;
    resumed.current = true;
    void replace();
  });

  const keyInput = (
    <Input value={key} onChangeText={setKey} placeholder={t("importPlaceholder")} autoCapitalize="none" autoCorrect={false} secureTextEntry accessibilityLabel={t("importWallet")} />
  );

  if (!hasLinked || (!mismatch && local !== undefined)) {
    // New account, or this phone already holds the right key and only the device check is due.
    return (
      <Screen width="column">
        <Intro title={t("setupTitle")} body={t(web ? (me.humanCheck === false ? "setupBodyWebNoCheck" : "setupBodyWeb") : "setupBody")} />
        <List>
          {web && me.humanCheck === false ? null : web ? (
            <Row icon="shield" title={t("humanCheck")} subtitle={t("stepHumanBody")} />
          ) : (
            <Row icon="phone" title={t("stepDeviceTitle")} subtitle={t("stepDeviceBody")} />
          )}
          <Row icon="key" title={t("stepWalletTitle")} subtitle={t(web ? "stepWalletBodyWeb" : "stepWalletBody")} />
        </List>
        {web && !hasLinked ? <Notice tone="warning">{t("webKeyNotice")}</Notice> : null}
        {hasLinked ? (
          <Button title={t("verify")} onPress={() => run(async () => undefined)} busy={busy} />
        ) : (
          <View style={{ gap: space.md }}>
            <Button title={t("createWallet")} onPress={() => void createFirst()} busy={busy && !importing} disabled={busy} />
            {importing ? (
              <>
                {keyInput}
                <Button title={t("importWallet")} kind="secondary" onPress={() => void importFirst()} busy={busy} disabled={key.trim().length < 64} />
              </>
            ) : (
              <Button title={t("importWallet")} kind="ghost" onPress={() => setImporting(true)} disabled={busy} />
            )}
          </View>
        )}
        <Notice>{status}</Notice>
        <ErrorText>{error}</ErrorText>
      </Screen>
    );
  }

  return (
    <Screen width="column">
      <Intro title={t(web ? "walletLinkedTitle" : "keyMissingTitle")} body={t(web ? "walletLinkedBody" : "keyMissingBody")} />
      {web ? (
        <>
          <Button title={t("verify")} onPress={() => run(async () => undefined)} busy={busy && !replacing && !importing} disabled={busy} />
          <View style={{ gap: space.md, paddingTop: space.lg }}>
            <T variant="headline">{t("importOptionalTitle")}</T>
            {keyInput}
            <Button
              title={t("importWallet")}
              kind="secondary"
              onPress={async () => {
                setImporting(true);
                await importExisting();
                setImporting(false);
              }}
              busy={busy && importing}
              disabled={busy || key.trim().length < 64}
            />
          </View>
        </>
      ) : (
        <>
          {keyInput}
          <Button title={t("importWallet")} onPress={() => void importExisting()} busy={busy && !replacing} disabled={busy || key.trim().length < 64} />
        </>
      )}

      <View style={{ gap: space.md, paddingTop: space.lg }}>
        <T variant="headline">{t("replaceTitle")}</T>
        <T variant="label" color={colors.textSoft}>{t("replaceBody")}</T>
        <Button title={t("replaceWallet")} kind="secondary" onPress={() => void replace()} busy={busy && replacing} disabled={busy} />
      </View>
      <Notice>{status}</Notice>
      <ErrorText>{error}</ErrorText>
    </Screen>
  );
}

function Intro({ title, body }: { title: string; body: string }) {
  return (
    <View style={{ gap: space.xl, paddingTop: space.md }}>
      <Brand />
      <View style={{ gap: 6 }}>
        <T variant="title" accessibilityRole="header">{title}</T>
        <T color={colors.textSoft}>{body}</T>
      </View>
    </View>
  );
}
