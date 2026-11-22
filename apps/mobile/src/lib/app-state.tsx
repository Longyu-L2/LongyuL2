import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AppState as Foreground } from "react-native";
import { getLocales } from "expo-localization";
import { accountTurn, untilLoaded } from "./answers";
import { api, loadTokens, recall, remember, setSignedOutHandler } from "./core";
import { pickLanguage, translator, type StringKey } from "./i18n";
import { clearResources, prefetch } from "./resources";

export interface Me {
  id: string;
  /** The X account the person signs in with. */
  xUsername: string | null;
  /** The X account's picture, as it was at the last sign-in. */
  avatarUrl: string | null;
  handle: string;
  tier: number;
  referralCode: string;
  banned: boolean;
  /** When the account was made, in seconds. */
  createdAt: string;
  /** Sessions started so far. */
  miningDays: string;
  /** Accounts that joined with this one's invite code. */
  invites: string;
  wallet: string | null;
  deviceAttested: boolean;
  /** False when the API has the human check switched off; older APIs leave it out (on). */
  humanCheck?: boolean;
}

export interface Network {
  chainId: string;
  chainName: string;
  explorerUrl: string;
  /** BNB on LONGYU: what gas is paid in. */
  nativeCurrency: { name: string; symbol: string; decimals: number };
  /** The token mining pays: null when rewards are native, absent while the API cannot read the chain. */
  rewardToken?: { address: string; name: string; symbol: string; decimals: number } | null;
  /** Identity checks can be taken now. They are asked for before mainnet conversion, not for mining. */
  verificationOpen?: boolean;
}

interface AppState {
  ready: boolean;
  signedIn: boolean;
  me: Me | null;
  network: Network | null;
  t: (key: StringKey) => string;
  refreshMe: () => Promise<Me | null>;
  setSignedIn: (v: boolean) => void;
}

const Ctx = createContext<AppState | null>(null);

/** What the first screens show: asked for as soon as the session is known, not when each screen opens. */
const FIRST = ["/v1/mining/status", "/v1/rewards", "/v1/boosts", "/v1/stats", "/v1/leaderboard"];

/** A value kept from the last launch, or null when it is missing or no longer reads as one. */
function kept<T extends object>(text: string | null, has: keyof T & string): T | null {
  try {
    const v: unknown = JSON.parse(text ?? "null");
    return typeof v === "object" && v !== null && has in v ? (v as T) : null;
  } catch {
    return null;
  }
}

export function AppStateProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [signedIn, setSigned] = useState(false);
  const [me, setMe] = useState<Me | null>(null);
  const [network, setNetwork] = useState<Network | null>(null);
  const t = useMemo(() => translator(pickLanguage(getLocales().map((l) => l.languageTag))), []);
  // Whether a session is open now, for an answer that arrives after the person signed out.
  const session = useRef(false);
  // And which account it is, for an answer that arrives after another person signed in.
  const [turn] = useState(accountTurn);

  // The network is asked for until it has answered once: at launch, and after a try that failed,
  // whenever the account is loaded or the app comes back to the front.
  const [loadNetwork] = useState(() =>
    untilLoaded(async () => {
      const n = await api<Network>("GET", "/v1/network");
      setNetwork(n);
      void remember("network", JSON.stringify(n));
    }),
  );

  // A try that fails (no connection, the API restarting) keeps the account as it was last seen.
  const refreshMe = useCallback(async () => {
    loadNetwork();
    const same = turn.holds();
    try {
      const m = await api<Me>("GET", "/v1/me");
      if (!session.current || !same()) return null;
      setMe(m);
      void remember("me", JSON.stringify(m));
      return m;
    } catch {
      return null;
    }
  }, [loadNetwork, turn]);

  // Signing out also forgets the account, so the next one to sign in never meets it.
  const setSignedIn = useCallback((v: boolean) => {
    turn.next();
    session.current = v;
    setSigned(v);
    if (!v) {
      setMe(null);
      clearResources();
      void remember("me", null);
    }
  }, [turn]);

  useEffect(() => {
    setSignedOutHandler(() => setSignedIn(false));
    (async () => {
      loadNetwork();
      try {
        const [open, lastMe, lastNetwork] = await Promise.all([loadTokens(), recall("me"), recall("network")]);
        const chain = kept<Network>(lastNetwork, "chainId");
        if (chain) setNetwork((now) => now ?? chain);
        if (open) {
          setSignedIn(true);
          prefetch(FIRST);
          // The account as it was at the last launch shows at once; the API's answer replaces it.
          const last = kept<Me>(lastMe, "handle");
          if (last) {
            setMe(last);
            void refreshMe();
          } else {
            await refreshMe();
          }
        }
      } catch {
        // A session that cannot be read starts signed out.
      } finally {
        setReady(true);
      }
    })();
  }, [loadNetwork, refreshMe, setSignedIn]);

  useEffect(() => {
    const sub = Foreground.addEventListener("change", (s) => {
      if (s === "active") loadNetwork();
    });
    return () => sub.remove();
  }, [loadNetwork]);

  const value = useMemo(
    () => ({ ready, signedIn, me, network, t, refreshMe, setSignedIn }),
    [ready, signedIn, me, network, t, refreshMe, setSignedIn],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp(): AppState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useApp outside AppStateProvider");
  return v;
}

/** Symbol of the mining reward token, as the API gives it; until then, the build's network's. */
export function useSymbol(): string {
  const n = useApp().network;
  return n?.rewardToken === null ? n.nativeCurrency.symbol : n?.rewardToken?.symbol ?? (process.env.EXPO_PUBLIC_APP_VARIANT === "production" ? "LONG" : "tLONG");
}
