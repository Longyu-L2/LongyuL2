import { useCallback, useEffect, useRef, useState } from "react";
import { useWindowDimensions, View } from "react-native";
import { router } from "expo-router";
import { api, ApiError, attestDevice, proveSession } from "@/lib/core";
import { useApp, useSymbol } from "@/lib/app-state";
import { errorKeyOf } from "@/lib/errors";
import { refresh, useClockOffset, useResource } from "@/lib/resources";
import { nextCheck } from "@/lib/server-clock";
import { capacityClass, fill, formatDuration, formatToken, formatTokenFixed, multiplier, sessionProgress } from "@/lib/format";
import { colors, space, tabular } from "@/design/tokens";
import { useWide } from "@/design/layout";
import { failure, success } from "@/design/haptics";
import { Brand, Button, Callout, Card, Col, Columns, ErrorText, Figure, Header, List, Metrics, Pill, Row, Screen, Section, Skeleton, T } from "@/components/ui";
import { Pearl, type PearlState } from "@/components/Pearl";
import { PulseCheck } from "@/components/PulseCheck";
import { LiveAmount } from "@/components/Rewards";

interface Status {
  day: string;
  tier: number;
  streakDays: number;
  session: { startedAt: string; endsAt: string } | null;
  canStart: boolean;
  nextAllowedAt: string | null;
  estimatedPerHour: string;
  boostBps: number;
  /** Null until the account has a wallet. */
  balances?: object | null;
}
interface Capacity {
  today: string;
  plans: { id: string; boostBps: number }[];
  current: { boost_bps: number; end_day: string } | null;
}

export default function MineScreen() {
  const { t, me, network } = useApp();
  const symbol = useSymbol();
  const wide = useWide();
  const { width } = useWindowDimensions();
  const loaded = useResource<Status>("/v1/mining/status");
  const status = loaded.data ?? null;
  const capacity = useResource<Capacity>("/v1/boosts").data ?? null;
  const [clock, setClock] = useState(Date.now() / 1000);
  // A session's times are the server's, so they are compared with the server's clock, not the device's.
  const offset = useClockOffset();
  const now = clock + offset / 1000;
  const rechecks = useRef(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [pulse, setPulse] = useState(false);
  const pending = useRef<{ challengeId: string; nonce: string } | null>(null);

  const load = useCallback(() => Promise.all([refresh("/v1/mining/status"), refresh("/v1/boosts")]), []);

  // The end of the session and the opening of the next are when the state changes: ask the server once at each.
  // An answer that came before the next session opened is asked for again a little later, a few times at most.
  useEffect(() => {
    if (!status) return;
    setClock(Date.now() / 1000);
    const { wait, overdue } = nextCheck(status, Date.now() + offset, rechecks.current);
    if (!overdue) rechecks.current = 0;
    if (wait === null) return;
    const id = setTimeout(() => {
      if (overdue) rechecks.current++;
      void refresh("/v1/mining/status");
    }, wait);
    return () => clearTimeout(id);
  }, [status, offset]);
  // The countdown runs on the phone; the server is not polled for it.
  useEffect(() => {
    const id = setInterval(() => setClock(Date.now() / 1000), 15_000);
    return () => clearInterval(id);
  }, []);

  const start = async (captchaToken?: string) => {
    const ch = pending.current;
    if (!ch) return;
    try {
      const attestationToken = await proveSession(ch.nonce);
      await api("POST", "/v1/mining/start", { challengeId: ch.challengeId, attestationToken, captchaToken });
      pending.current = null;
      success();
      await refresh("/v1/mining/status");
    } catch (e) {
      failure();
      setError(t(errorKeyOf(e)));
    } finally {
      setBusy(false);
    }
  };

  const begin = async (retried = false): Promise<void> => {
    setBusy(true);
    setError("");
    try {
      let ch: { challengeId: string; nonce: string; pulseRequired: boolean };
      try {
        ch = await api("POST", "/v1/mining/challenge");
      } catch (e) {
        // Device checks expire after 30 days: renew once, then try again.
        if (!retried && e instanceof ApiError && e.code === "device_not_attested") {
          await attestDevice();
          return begin(true);
        }
        throw e;
      }
      pending.current = ch;
      if (ch.pulseRequired) setPulse(true);
      else await start();
    } catch (e) {
      failure();
      setError(t(errorKeyOf(e)));
      setBusy(false);
    }
  };

  const session = status?.session;
  const mining = Boolean(session && now < Number(session.endsAt));
  // The server says when a session may start, which is before the running one ends.
  const state: PearlState = status?.canStart ? "ready" : mining ? "mining" : "resting";
  const progress = session && mining ? sessionProgress(Number(session.startedAt), now) : 0;
  const canTap = Boolean(status?.canStart) && !busy;
  const current = capacity?.current;
  const match = current ? capacity?.plans.find((p) => p.boostBps === current.boost_bps) : undefined;
  const plan = current ? (match ? capacityClass(match.id) : multiplier(current.boost_bps)) : undefined;
  const daysLeft = current ? Number(current.end_day) - Number(capacity!.today) : 0;
  // An answer that never came is said once; what is on the screen stays when a later one fails.
  const shown = error || (!status && loaded.error ? t(errorKeyOf(loaded.error)) : "");
  // The dial fills a phone's width, and grows with the window beside the rail.
  const dial = wide ? (width >= 1240 ? 320 : 264) : Math.min(256, width - 104);
  const rated = Boolean(status && status.estimatedPerHour !== "0");

  const readout = !status ? (
    <Skeleton width={150} height={40} />
  ) : mining && rated ? (
    <SessionAmount perHour={status.estimatedPerHour} startedAt={Number(session!.startedAt)} endsAt={Number(session!.endsAt)} offset={offset} large={wide && width >= 1240} />
  ) : (
    <>
      <T variant="display" style={tabular}>
        {mining ? formatDuration(Number(session!.endsAt) - now) : state === "ready" ? t("readyTitle") : status.nextAllowedAt ? formatDuration(Number(status.nextAllowedAt) - now) : "–"}
      </T>
      <T variant="label" color={colors.textSoft}>{mining ? t("sessionEnds") : state === "ready" ? t("tapPearl") : t("nextSession")}</T>
    </>
  );

  const hero = (
    <View style={{ alignItems: "center", gap: space.xl }}>
      <Pearl state={state} progress={progress} size={dial} onPress={canTap ? () => void begin() : undefined} label={t(state === "ready" ? "startMining" : state)} />
      <View style={{ alignItems: "center", gap: 4, minHeight: 68, justifyContent: "center" }}>{readout}</View>
      {state === "ready" ? (
        <View style={{ alignSelf: "stretch" }}>
          <Button title={t("startMining")} onPress={() => void begin()} busy={busy} disabled={!canTap} />
        </View>
      ) : null}
      {shown ? <View style={{ alignSelf: "stretch" }}><ErrorText>{shown}</ErrorText></View> : null}
    </View>
  );

  return (
    <Screen onRefresh={load}>
      {wide ? (
        <Header title={t("tabMine")} right={<Pill text={t("testnet")} />} />
      ) : (
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", minHeight: 44 }}>
          <Brand />
          <Pill text={t("testnet")} />
        </View>
      )}

      <Columns>
        <Col flex={1.05}>{wide ? <Card padding={space.xxxl}>{hero}</Card> : hero}</Col>

        <Col>
          <Metrics
            items={[
              { label: t("rate"), hint: `${symbol}/h`, value: status ? formatToken(status.estimatedPerHour, 3) : "–" },
              { label: t("power"), value: multiplier(status?.boostBps ?? 0), color: status?.boostBps ? colors.primary : colors.text },
              { label: t("streak"), value: status ? String(status.streakDays) : "–", unit: t("daysShort") },
              { label: t("miningDay"), value: status?.day ?? "–" },
            ]}
          />

          {status?.balances ? (
            <Section title={t("rewards")}>
              <List>
                <Row title={t("mined")} right={<LiveAmount part="earned" unit={symbol} />} />
                <Row title={t("available")} right={<LiveAmount part="claimable" unit={symbol} />} onPress={() => router.push("/wallet")} chevron />
                <Row title={t("pending")} right={<LiveAmount part="pending" unit={symbol} color={colors.textSoft} />} />
              </List>
            </Section>
          ) : null}

          {/* Mining needs no identity check. It is asked for before mainnet conversion, once checks are open. */}
          {network?.verificationOpen && me && me.tier < 2 ? <Callout icon="shield" title={t("verifyIdentity")} body={t("verifyBody")} onPress={() => router.push("/profile")} /> : null}

          <List>
            <Row
              title={t("capacityTitle")}
              value={plan ? `${plan} · ${daysLeft}${t("daysShort")}` : t("capacityStandard")}
              valueColor={plan ? colors.primary : colors.textSoft}
              onPress={() => router.push("/boost")}
              chevron
            />
          </List>
        </Col>
      </Columns>

      <PulseCheck
        visible={pulse}
        title={t("humanCheck")}
        onToken={(token) => { setPulse(false); void start(token); }}
        onCancel={() => { setPulse(false); setBusy(false); pending.current = null; }}
      />
    </Screen>
  );
}

/**
 * What the running session has earned so far, at the estimated rate. It counts on the device, a
 * second at a time; the amount paid is set by the day's settlement.
 */
function SessionAmount({ perHour, startedAt, endsAt, offset, large }: { perHour: string; startedAt: number; endsAt: number; offset: number; large: boolean }) {
  const { t } = useApp();
  const symbol = useSymbol();
  const [device, setDevice] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setDevice(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  // The session started and ends at the server's times.
  const ms = device + offset;
  const elapsed = Math.max(0, Math.min(ms, endsAt * 1000) - startedAt * 1000);
  const amount = (BigInt(perHour) * BigInt(Math.floor(elapsed))) / 3_600_000n;
  return (
    <>
      <Figure value={formatTokenFixed(amount, 4)} unit={symbol} size={large ? "figure" : "hero"} />
      <T variant="label" color={colors.textSoft} center>
        {`${t("sessionEstimate")} · ${fill(t("sessionLeft"), { time: formatDuration(endsAt - ms / 1000) })}`}
      </T>
    </>
  );
}
