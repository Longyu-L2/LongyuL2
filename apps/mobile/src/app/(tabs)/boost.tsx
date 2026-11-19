/**
 * Mining capacity: the active class and its epoch, and a configurator for the next allocation:
 * capacity class (C1 to C5) and epoch (7, 30 or 90 days), with the projected rate. Allocating
 * creates an order and opens LONGYU's payment page, where the user pays in BNB on BNB Smart Chain
 * from their own wallet; the payment transaction is the on-chain receipt, and the epoch starts once
 * it is final. Every amount and condition is shown before the user leaves the app.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { AppState, Linking, Platform, Pressable, View } from "react-native";
import { router, useFocusEffect } from "expo-router";
import { api, ApiError } from "@/lib/core";
import { useApp, useSymbol } from "@/lib/app-state";
import { errorKeyOf } from "@/lib/errors";
import { capacityClass, fill, formatToken, multiplier } from "@/lib/format";
import { colors, radius, space, tabular, tones } from "@/design/tokens";
import { select } from "@/design/haptics";
import { Button, Card, Col, Columns, Divider, ErrorText, List, Notice, Pill, Progress, Row, Screen, Section, Skeleton, T, TopBar } from "@/components/ui";
import { Icon } from "@/components/Icon";
import { Sheet } from "@/components/Sheet";

interface Plan { id: string; boostBps: number; days: number; token: string; price: string }
interface Epoch { boost_bps: number; start_day: string; end_day: string }
interface Order { orderId: string; plan: string; boostBps: number; days: number; token: string; amountDisplay: string; status: string; payUrl: string | null }
interface CapacityView {
  available: boolean;
  eligible: boolean;
  reason: "device_not_attested" | "verify_first" | "account_restricted" | null;
  today: string;
  plans: Plan[];
  current: Epoch | null;
  upcoming: Epoch[];
  orders: Order[];
}
interface Status { estimatedPerHour: string; boostBps: number }

const web = Platform.OS === "web";
/** The only addresses a tab this page opened is sent to. */
const PAGE = /^https?:\/\//i;

/** Opened from Mine, inside the tabs (their layout checks the sign-in). */
export default function CapacityScreen() {
  const { t } = useApp();
  const symbol = useSymbol();
  const [view, setView] = useState<CapacityView | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [cls, setCls] = useState<string | null>(null);
  const [days, setDays] = useState<number | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // The payment page of an order the browser would not open a tab for.
  const [blocked, setBlocked] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setView(await api<CapacityView>("GET", "/v1/boosts"));
      setError("");
    } catch (e) {
      setError(t(errorKeyOf(e)));
    }
    api<Status>("GET", "/v1/mining/status").then(setStatus).catch(() => undefined);
  }, [t]);
  useFocusEffect(useCallback(() => void load(), [load]));
  // Back from the payment page in the browser: show the new state at once.
  useEffect(() => {
    const sub = AppState.addEventListener("change", (s) => s === "active" && void load());
    return () => sub.remove();
  }, [load]);

  // Plans grouped into classes (by power), each with the epochs it offers.
  const classes = useMemo(() => {
    const byClass = new Map<string, { id: string; bps: number; plans: Plan[] }>();
    for (const p of view?.plans ?? []) {
      const id = capacityClass(p.id);
      const c = byClass.get(id) ?? { id, bps: p.boostBps, plans: [] };
      c.plans.push(p);
      byClass.set(id, c);
    }
    return [...byClass.values()].sort((a, b) => a.bps - b.bps).map((c) => ({ ...c, plans: c.plans.sort((a, b) => a.days - b.days) }));
  }, [view]);
  const chosen = classes.find((c) => c.id === cls) ?? classes[Math.min(2, classes.length - 1)];
  const plan = chosen?.plans.find((p) => p.days === days) ?? chosen?.plans.find((p) => p.days === 30) ?? chosen?.plans[0] ?? null;
  const nameOf = (bps: number) => classes.find((c) => c.bps === bps)?.id ?? multiplier(bps);
  // What can be chosen now: shown only while plans are on offer.
  const offer = view?.available && chosen && plan ? { view, chosen, plan } : null;

  const today = Number(view?.today ?? 0);
  const current = view?.current ?? null;
  const queuedUntil = Math.max(today, ...[current, ...(view?.upcoming ?? [])].filter(Boolean).map((e) => Number(e!.end_day)));
  const startsIn = queuedUntil - today;
  const awaiting = (view?.orders ?? []).filter((o) => o.status === "open" || o.status === "review");
  const history = (view?.orders ?? []).filter((o) => o.status !== "open" && o.status !== "review");

  // Projection from today's estimate: the unboosted rate, scaled by the chosen class.
  const baseRate = status ? (BigInt(status.estimatedPerHour) * 10_000n) / BigInt(10_000 + status.boostBps) : null;
  const projected = baseRate !== null && plan ? (baseRate * BigInt(10_000 + plan.boostBps)) / 10_000n : null;
  const perEpoch = baseRate !== null && plan ? (baseRate * BigInt(plan.boostBps) * 24n * BigInt(plan.days)) / 10_000n : null;

  const closeReview = () => {
    setReviewing(false);
    setBlocked(null);
  };

  const allocate = async () => {
    if (!plan) return;
    if (blocked) {
      // The order is made already: this tap opens its payment page.
      closeReview();
      await Linking.openURL(blocked);
      return;
    }
    setBusy(true);
    setError("");
    // A browser opens a tab only from the tap itself, so it opens now and gets the payment page once the order is made.
    const tab = web ? window.open("", "_blank") : null;
    try {
      const order = await api<{ payUrl: string }>("POST", "/v1/boosts/orders", { plan: plan.id });
      if (web && !PAGE.test(order.payUrl)) throw new Error("payUrl");
      if (web && !tab) {
        setBlocked(order.payUrl);
      } else {
        setReviewing(false);
        if (tab) {
          tab.opener = null;
          tab.location.replace(order.payUrl);
        } else {
          await Linking.openURL(order.payUrl);
        }
      }
      await load();
    } catch (e) {
      tab?.close();
      setError(t(e instanceof ApiError && e.code === "account_restricted" ? "capacityRestricted" : errorKeyOf(e)));
    } finally {
      setBusy(false);
    }
  };

  const orderStatus = (o: Order) =>
    o.status === "review" ? { text: t("orderReview"), tone: "warning" as const }
      : o.status === "paid" ? { text: t("orderActive"), tone: "positive" as const }
      : o.status === "refunded" ? { text: t("orderRefunded"), tone: "neutral" as const }
      : o.status === "open" && !o.payUrl ? { text: t("orderExpired"), tone: "neutral" as const }
      : o.status === "open" ? { text: t("orderAwaiting"), tone: "primary" as const }
      : { text: t("orderCancelled"), tone: "neutral" as const };
  const starts = startsIn === 0 ? t("startsToday") : fill(t("startsInDays"), { n: startsIn });
  const label = (p: Plan) => `${capacityClass(p.id)} · ${p.days} ${t("daysShort")}`;
  const orderTitle = (o: Order) => `${o.plan ? capacityClass(o.plan) : nameOf(o.boostBps)} · ${o.days} ${t("daysShort")}`;

  return (
    <Screen onRefresh={load}>
      <TopBar title={t("capacityTitle")} onBack={() => router.navigate("/mine")} backLabel={t("back")} />

      <Columns>
        <Col>
          <Card>
            {!view ? (
              <Skeleton height={64} />
            ) : current ? (
              <>
                <View style={{ flexDirection: "row", alignItems: "flex-end", justifyContent: "space-between" }}>
                  <View style={{ gap: 6 }}>
                    <Pill tone="primary" text={nameOf(current.boost_bps)} />
                    <T variant="hero" style={tabular}>{multiplier(current.boost_bps)}</T>
                  </View>
                  <T variant="label" color={colors.textSoft}>{fill(t("epochEndsIn"), { n: Number(current.end_day) - today })}</T>
                </View>
                <Progress tone="primary" value={(today - Number(current.start_day)) / Math.max(1, Number(current.end_day) - Number(current.start_day))} />
                {view.upcoming.length ? (
                  <T variant="small" color={colors.textSoft}>{fill(t("nextPlan"), { plan: view.upcoming.map((e) => nameOf(e.boost_bps)).join(", ") })}</T>
                ) : null}
              </>
            ) : (
              <View style={{ flexDirection: "row", alignItems: "flex-end", justifyContent: "space-between" }}>
                <View style={{ gap: 2 }}>
                  <T variant="label" color={colors.textSoft}>{t("capacityStandard")}</T>
                  <T variant="hero" style={tabular}>{multiplier(0)}</T>
                </View>
                <T variant="label" color={colors.textSoft}>{t("noActivePlan")}</T>
              </View>
            )}
          </Card>

          {view && !view.available ? <Notice>{t("capacityUnavailable")}</Notice> : null}

          {offer ? (
            <>
              <Section title={t("capacityClass")}>
                <View style={{ flexDirection: "row", gap: 6 }}>
                  {classes.map((c) => {
                    const on = c.id === offer.chosen.id;
                    return (
                      <Pressable
                        key={c.id}
                        accessibilityRole="radio"
                        accessibilityState={{ checked: on }}
                        accessibilityLabel={`${c.id} ${multiplier(c.bps)}`}
                        onPress={() => { select(); setCls(c.id); }}
                        style={{
                          flex: 1, alignItems: "center", gap: 2, paddingVertical: space.md, borderRadius: radius.md, borderWidth: 1,
                          backgroundColor: on ? tones.primary.bg : colors.surface, borderColor: on ? colors.primary : colors.line,
                        }}
                      >
                        <T variant="label" color={on ? colors.primary : colors.text} style={{ letterSpacing: 0.5 }}>{c.id}</T>
                        <T variant="small" color={on ? colors.text : colors.textFaint} style={tabular}>{multiplier(c.bps)}</T>
                      </Pressable>
                    );
                  })}
                </View>
              </Section>

              <Section title={t("epoch")}>
                <View style={{ flexDirection: "row", backgroundColor: colors.surface, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, padding: 3 }}>
                  {offer.chosen.plans.map((p) => {
                    const on = p.id === offer.plan.id;
                    return (
                      <Pressable
                        key={p.id}
                        accessibilityRole="radio"
                        accessibilityState={{ checked: on }}
                        accessibilityLabel={`${p.days} ${t("daysShort")}`}
                        onPress={() => { select(); setDays(p.days); }}
                        style={{ flex: 1, alignItems: "center", paddingVertical: 10, borderRadius: radius.md - 3, backgroundColor: on ? colors.surfaceHigh : undefined }}
                      >
                        <T variant="bodyStrong" color={on ? colors.text : colors.textSoft}>{`${p.days} ${t("daysShort")}`}</T>
                      </Pressable>
                    );
                  })}
                </View>
              </Section>
            </>
          ) : null}
        </Col>

        <Col>
          {offer ? (
            <>
              <Card>
                <View style={{ gap: 4 }}>
                  <T variant="small" color={colors.textSoft}>{t("projectedRate")}</T>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, flexWrap: "wrap" }}>
                    <T variant="headline" color={colors.textFaint} style={tabular}>{baseRate !== null ? formatToken(baseRate, 3) : "–"}</T>
                    <Icon name="chevronRight" size={16} color={colors.textFaint} />
                    <T variant="display" style={tabular}>{projected !== null ? formatToken(projected, 3) : "–"}</T>
                    <T variant="label" color={colors.textSoft}>{`${symbol}/h`}</T>
                  </View>
                </View>
                <Divider />
                <Line label={t("perEpoch")} value={perEpoch !== null ? `+${formatToken(perEpoch, 0)} ${symbol}` : "–"} />
                <Line label={t("starts")} value={starts} />
                <Line label={t("cost")} value={`${offer.plan.price} ${offer.plan.token}`} strong />
                <T variant="small" color={colors.textFaint}>{t("estimateNote")}</T>
              </Card>

              {offer.view.eligible ? (
                <Button title={fill(t("allocate"), { plan: label(offer.plan) })} onPress={() => setReviewing(true)} />
              ) : (
                <Notice tone="warning">{t(offer.view.reason === "verify_first" ? "capacityVerifyFirst" : offer.view.reason === "device_not_attested" ? "deviceCheckFailed" : "capacityRestricted")}</Notice>
              )}
              <ErrorText>{error}</ErrorText>
            </>
          ) : null}

          {awaiting.length ? (
            <Section title={t("awaitingPayment")}>
              <List>
                {awaiting.map((o) => (
                  <Row
                    key={o.orderId}
                    title={orderTitle(o)}
                    subtitle={`${o.amountDisplay} ${o.token}`}
                    right={o.payUrl ? <Button size="sm" kind="secondary" title={t("pay")} onPress={() => void Linking.openURL(o.payUrl!)} /> : <Pill tone={orderStatus(o).tone} text={orderStatus(o).text} />}
                  />
                ))}
              </List>
            </Section>
          ) : null}

          {history.length ? (
            <Section title={t("history")}>
              <List>
                {history.map((o) => (
                  <Row key={o.orderId} title={orderTitle(o)} subtitle={`${o.amountDisplay} ${o.token}`} right={<Pill tone={orderStatus(o).tone} text={orderStatus(o).text} />} />
                ))}
              </List>
            </Section>
          ) : null}
        </Col>
      </Columns>

      <Sheet visible={reviewing && Boolean(plan)} title={plan ? fill(t("allocate"), { plan: label(plan) }) : ""} onClose={closeReview} closeLabel={t("close")}>
        {plan ? (
          <>
            <List>
              <Row title={t("capacityClass")} value={`${capacityClass(plan.id)} · ${multiplier(plan.boostBps)}`} />
              <Row title={t("epoch")} value={`${plan.days} ${t("daysShort")}`} />
              <Row title={t("starts")} value={starts} />
              <Row title={t("cost")} value={`${plan.price} ${plan.token}`} />
              <Row title={t("network")} value="BNB Smart Chain" />
            </List>
            <T variant="small" color={colors.textSoft}>{t("capacityDisclosure")}</T>
            <ErrorText>{error}</ErrorText>
            <Notice tone="warning">{blocked ? t("payBlocked") : ""}</Notice>
            <Button title={t("continueToPayment")} onPress={() => void allocate()} busy={busy} />
          </>
        ) : null}
      </Sheet>
    </Screen>
  );
}

function Line({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: space.md }}>
      <T variant="label" color={colors.textSoft}>{label}</T>
      <T variant={strong ? "bodyStrong" : "label"} color={strong ? colors.primary : colors.text} style={[tabular, { textAlign: "right", flexShrink: 1 }]}>{value}</T>
    </View>
  );
}
