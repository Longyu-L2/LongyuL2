import { useCallback, useEffect, useRef, useState } from "react";
import { useWindowDimensions, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { router } from "expo-router";
import { api, ApiError, attestDevice, proveSession } from "@/lib/core";
import { useApp, useSymbol } from "@/lib/app-state";
import { errorKeyOf } from "@/lib/errors";
import { refresh, useClockOffset, useResource } from "@/lib/resources";
import { nextCheck } from "@/lib/server-clock";
import { boostPercent, capacityClass, fill, formatDuration, formatToken, formatTokenFixed, multiplier, sessionProgress } from "@/lib/format";
import { inviteLinkFor } from "@/lib/invite-link";
import { colors, space, tabular } from "@/design/tokens";
import { useRoomy, useWide } from "@/design/layout";
import { failure, success } from "@/design/haptics";
import { Brand, Button, Callout, Card, Col, Columns, ErrorText, Figure, Header, List, Metrics, Panel, Pill, Progress, Row, Screen, Section, Skeleton, T } from "@/components/ui";
import { Pearl, type PearlState } from "@/components/Pearl";
import { PulseCheck } from "@/components/PulseCheck";
import { LiveAmount, LiveFigure, RewardBar, RewardLine } from "@/components/Rewards";
import { checkChain, solvePuzzle, type RootParts } from "@/lib/chain-work";

interface Status {
  day: string;
  tier: number;
  streakDays: number;
  session: { startedAt: string; endsAt: string; chainChecks?: number; lastCheckedOutput?: string | null } | null;
  canStart: boolean;
  nextAllowedAt: string | null;
  estimatedPerHour: string;
  boostBps: number;
  /** What today's counted invites add, in bps. Absent from an API without the invite bonus. */
  invites?: { active: number; bps: number; bpsEach: number; capBps: number };
  /** Null until the account has a wallet. */
  balances?: object | null;
}
interface Capacity {
  today: string;
  plans: { id: string; boostBps: number }[];
  current: { boost_bps: number; start_day: string; end_day: string } | null;
}

/** The work the API asks for at the start of a session. */
interface Work {
  bits: number;
  output: { index: string; l2Block: string } | null;
}
/** While a session runs, the newest state root on BSC is checked this often, when the screen is open. */
const CHECK_EVERY = 15 * 60_000;

// In a wide window: the inside of a panel, and a panel that fills its column.
const panelBody = { padding: space.xl, gap: space.lg } as const;
const grow = { flexGrow: 1 } as const;

export default function MineScreen() {
  const { t, me, network } = useApp();
  const symbol = useSymbol();
  const wide = useWide();
  const roomy = useRoomy();
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
  const pending = useRef<{ challengeId: string; nonce: string; work?: { counter?: string; parts?: RootParts } } | null>(null);
  const [working, setWorking] = useState(false);
  // The newest state root this phone rebuilt, and whether it matched the one on BSC.
  const [lastCheck, setLastCheck] = useState<{ index: bigint; match: boolean } | null>(null);
  const checkedAt = useRef(0);
  const [copied, setCopied] = useState(false);

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
      await api("POST", "/v1/mining/start", { challengeId: ch.challengeId, attestationToken, captchaToken, work: ch.work });
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

  // The puzzle on the challenge's nonce, and the state root the API picked, rebuilt here.
  const doWork = async (nonce: string, work: Work) => {
    setWorking(true);
    try {
      const counter = work.bits > 0 ? await solvePuzzle(nonce, work.bits) : undefined;
      const check = work.output ? await checkChain(BigInt(work.output.index)).catch(() => null) : null;
      if (check) {
        setLastCheck({ index: check.index, match: check.match });
        checkedAt.current = Date.now();
      }
      return { counter, parts: check?.parts };
    } finally {
      setWorking(false);
    }
  };

  const begin = async (retried = false): Promise<void> => {
    setBusy(true);
    setError("");
    try {
      let ch: { challengeId: string; nonce: string; pulseRequired: boolean; work?: Work };
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
      pending.current = { challengeId: ch.challengeId, nonce: ch.nonce, work: ch.work ? await doWork(ch.nonce, ch.work) : undefined };
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
  // While a session runs and the screen is open, the newest state root on BSC is rebuilt and reported.
  useEffect(() => {
    if (!mining) return;
    const run = async () => {
      if (Date.now() - checkedAt.current < CHECK_EVERY) return;
      checkedAt.current = Date.now();
      try {
        const check = await checkChain();
        setLastCheck({ index: check.index, match: check.match });
        await api("POST", "/v1/mining/check", { index: String(check.index), parts: check.parts });
        void refresh("/v1/mining/status");
      } catch {
        // A missed check is tried again at the next turn.
      }
    };
    void run();
    const id = setInterval(() => void run(), 60_000);
    return () => clearInterval(id);
  }, [mining]);
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
  const dial = wide ? (roomy ? 272 : 232) : Math.min(256, width - 104);
  const rated = Boolean(status && status.estimatedPerHour !== "0");

  const readout = !status ? (
    <Skeleton width={wide ? 220 : 150} height={wide ? 56 : 40} />
  ) : mining && rated ? (
    <SessionAmount perHour={status.estimatedPerHour} startedAt={Number(session!.startedAt)} endsAt={Number(session!.endsAt)} offset={offset} wide={wide} />
  ) : (
    <>
      <T variant={wide ? "hero" : "display"} style={tabular}>
        {mining ? formatDuration(Number(session!.endsAt) - now) : state === "ready" ? t("readyTitle") : status.nextAllowedAt ? formatDuration(Number(status.nextAllowedAt) - now) : "–"}
      </T>
      <T variant="label" color={colors.textSoft}>{mining ? t("sessionEnds") : state === "ready" ? t("tapPearl") : t("nextSession")}</T>
    </>
  );

  // How many state roots this session has checked, and the newest one's outcome.
  const checks = mining ? session?.chainChecks ?? 0 : 0;
  const newest = lastCheck ?? (mining && session?.lastCheckedOutput ? { index: BigInt(session.lastCheckedOutput), match: true } : null);
  const chainLine = mining && (checks > 0 || newest) ? (
    <T variant="label" color={newest && !newest.match ? colors.danger : colors.textSoft} center={!wide} style={tabular}>
      {[`${t("chainChecks")} ${checks}`, newest ? fill(t(newest.match ? "chainMatches" : "chainMismatch"), { n: `#${newest.index}` }) : ""].filter(Boolean).join(" · ")}
    </T>
  ) : null;

  const hero = (
    <View style={{ alignItems: "center", gap: space.xl }}>
      <Pearl state={state} progress={progress} size={dial} onPress={canTap ? () => void begin() : undefined} label={t(state === "ready" ? "startMining" : state)} />
      <View style={{ alignItems: "center", gap: 4, minHeight: 68, justifyContent: "center" }}>{readout}</View>
      {chainLine}
      {state === "ready" ? (
        <View style={{ alignSelf: "stretch" }}>
          <Button title={working ? t("checkingChain") : t("startMining")} onPress={() => void begin()} busy={busy} disabled={!canTap} />
        </View>
      ) : null}
      {shown ? <View style={{ alignSelf: "stretch" }}><ErrorText>{shown}</ErrorText></View> : null}
    </View>
  );

  const metrics = [
    { label: t("rate"), hint: `${symbol}/h`, value: status ? formatToken(status.estimatedPerHour, 3) : "–" },
    { label: t("power"), value: multiplier(status?.boostBps ?? 0), color: status?.boostBps ? colors.primary : colors.text },
    { label: t("streak"), value: status ? String(status.streakDays) : "–", unit: t("daysShort") },
    { label: t("miningDay"), value: status?.day ?? "–" },
  ];
  // Mining needs no identity check. It is asked for before mainnet conversion, once checks are open.
  const verify = network?.verificationOpen && me && me.tier < 2 ? <Callout icon="shield" title={t("verifyIdentity")} body={t("verifyBody")} onPress={() => router.push("/profile")} /> : null;
  const pulseCheck = (
    <PulseCheck
      visible={pulse}
      title={t("humanCheck")}
      onToken={(token) => { setPulse(false); void start(token); }}
      onCancel={() => { setPulse(false); setBusy(false); pending.current = null; }}
    />
  );

  if (wide) {
    // Shown while the invite bonus is running.
    const invites = status?.invites && status.invites.bpsEach > 0 ? status.invites : null;
    // In a browser an invite is a link to this site; the app shares the code.
    const link = me ? inviteLinkFor(me.referralCode) : "";
    const copyInvite = async () => {
      if (!me) return;
      await Clipboard.setStringAsync(link || me.referralCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    };

    const rewards = status?.balances ? (
      <Panel title={t("rewards")} action={<Button size="sm" kind="ghost" title={t("tabWallet")} onPress={() => router.push("/wallet")} />} style={grow}>
        <View style={panelBody}>
          <View style={{ gap: 2 }}>
            <T variant="label" color={colors.textSoft}>{t("mined")}</T>
            <LiveFigure part="earned" unit={symbol} size="display" />
          </View>
          <RewardBar />
          <View style={{ gap: space.sm }}>
            <RewardLine part="claimable" label={t("available")} />
            <RewardLine part="pending" label={t("pending")} />
            <RewardLine part="claimed" label={t("claimed")} />
          </View>
        </View>
      </Panel>
    ) : null;

    const plans = (
      <Panel title={t("capacityTitle")} action={<Button size="sm" kind="ghost" title={t("manage")} onPress={() => router.push("/boost")} />} style={grow}>
        <View style={panelBody}>
          <View style={{ gap: 2 }}>
            <T variant="label" color={colors.textSoft}>{plan ?? t("capacityStandard")}</T>
            <T variant="display" color={current ? colors.primary : colors.text} style={tabular}>{multiplier(current?.boost_bps ?? 0)}</T>
          </View>
          {current ? (
            <View style={{ gap: space.sm }}>
              <Progress value={(Number(capacity!.today) - Number(current.start_day)) / Math.max(1, Number(current.end_day) - Number(current.start_day))} />
              <T variant="label" color={colors.textSoft}>{fill(t("epochEndsIn"), { n: daysLeft })}</T>
            </View>
          ) : (
            <T variant="label" color={colors.textSoft}>{t("noActivePlan")}</T>
          )}
        </View>
      </Panel>
    );

    const invite = me ? (
      <Panel
        title={t("invites")}
        action={<Button size="sm" kind="ghost" icon={copied ? "check" : link ? "link" : "copy"} title={copied ? t("copied") : t(link ? "copyLink" : "copyCode")} onPress={() => void copyInvite()} />}
        style={grow}
      >
        <View style={panelBody}>
          {invites ? (
            <View style={{ gap: 2 }}>
              <T variant="label" color={colors.textSoft}>{t("inviteBonus")}</T>
              <T variant="display" style={tabular}>{invites.bps > 0 ? boostPercent(invites.bps) : "–"}</T>
            </View>
          ) : null}
          <View style={{ gap: space.sm }}>
            {invites ? <Line label={t("activeToday")} value={String(invites.active)} /> : null}
            <Line label={t("inviteCode")} value={me.referralCode} mono />
          </View>
        </View>
      </Panel>
    ) : null;

    return (
      <Screen onRefresh={load}>
        <Header title={t("tabMine")} />

        <Card padding={0} style={{ gap: 0 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: roomy ? 56 : 36, paddingHorizontal: roomy ? 48 : space.xxxl, paddingVertical: space.xxxl }}>
            <Pearl state={state} progress={progress} size={dial} onPress={canTap ? () => void begin() : undefined} label={t(state === "ready" ? "startMining" : state)} />
            <View style={{ flex: 1, minWidth: 0, gap: space.xl }}>
              <View style={{ gap: 4 }}>{readout}</View>
              {chainLine}
              {state === "ready" ? (
                <View style={{ alignSelf: "flex-start", minWidth: 220 }}>
                  <Button title={working ? t("checkingChain") : t("startMining")} onPress={() => void begin()} busy={busy} disabled={!canTap} />
                </View>
              ) : null}
              {shown ? <ErrorText>{shown}</ErrorText> : null}
            </View>
          </View>
          <Metrics bare columns={4} items={metrics} />
        </Card>

        {verify}

        {roomy ? (
          <Columns stretch>
            <Col>{rewards}</Col>
            <Col>{plans}</Col>
            <Col>{invite}</Col>
          </Columns>
        ) : (
          <Columns stretch>
            <Col flex={1.15}>{rewards}</Col>
            <Col>
              {plans}
              {invite}
            </Col>
          </Columns>
        )}

        {pulseCheck}
      </Screen>
    );
  }

  return (
    <Screen onRefresh={load}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", minHeight: 44 }}>
        <Brand />
        <Pill text={t("testnet")} />
      </View>

      <Columns>
        <Col>{hero}</Col>

        <Col>
          <Metrics items={metrics} />

          {status?.balances ? (
            <Section title={t("rewards")}>
              <List>
                <Row title={t("mined")} right={<LiveAmount part="earned" unit={symbol} />} />
                <Row title={t("available")} right={<LiveAmount part="claimable" unit={symbol} />} onPress={() => router.push("/wallet")} chevron />
                <Row title={t("pending")} right={<LiveAmount part="pending" unit={symbol} color={colors.textSoft} />} />
              </List>
            </Section>
          ) : null}

          {verify}

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

      {pulseCheck}
    </Screen>
  );
}

/** A name and its value on one line of a panel. */
function Line({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.md, minHeight: 24 }}>
      <T variant="body" color={colors.textSoft} numberOfLines={1}>{label}</T>
      <T variant={mono ? "mono" : "bodyStrong"} selectable={mono} style={[tabular, { flexShrink: 1 }]} numberOfLines={1}>{value}</T>
    </View>
  );
}

/**
 * What the running session has earned so far, at the estimated rate. It counts on the device, a
 * second at a time; the amount paid is set by the day's settlement.
 */
function SessionAmount({ perHour, startedAt, endsAt, offset, wide }: { perHour: string; startedAt: number; endsAt: number; offset: number; wide: boolean }) {
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
  if (wide) {
    return (
      <View style={{ gap: space.xl }}>
        <View style={{ gap: 2 }}>
          <T variant="label" color={colors.textSoft}>{t("sessionEstimate")}</T>
          <Figure value={formatTokenFixed(amount, 4)} unit={symbol} size="figure" />
        </View>
        <View style={{ gap: space.sm }}>
          <Progress value={elapsed / Math.max(1, (endsAt - startedAt) * 1000)} />
          <T variant="label" color={colors.textSoft} style={tabular}>{fill(t("sessionLeft"), { time: formatDuration(endsAt - ms / 1000) })}</T>
        </View>
      </View>
    );
  }
  return (
    <>
      <Figure value={formatTokenFixed(amount, 4)} unit={symbol} size="hero" />
      <T variant="label" color={colors.textSoft} center>
        {`${t("sessionEstimate")} · ${fill(t("sessionLeft"), { time: formatDuration(endsAt - ms / 1000) })}`}
      </T>
    </>
  );
}
