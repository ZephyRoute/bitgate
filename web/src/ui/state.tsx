import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { tipHeight } from "../lib/esplora";
import { ensureGuestStellar, guestSigner, savedWalletMode, saveWalletMode } from "../lib/guest";
import {
  accountState,
  addUsdcTrustline,
  bestTip,
  buyTestUsdc,
  connectWallet,
  fundWithFriendbot,
  knownWalletAddress,
  reflectorBtcPrice,
  type AccountState,
  type OraclePrice,
} from "../lib/stellar";

/** Test USDC a new guest account starts with: enough to sell, or to bond a buy. */
const GUEST_STARTING_USDC = 10;

// ── Language ────────────────────────────────────────────────────────────────

export type Lang = "es" | "en";

interface LangState {
  lang: Lang;
  setLang: (l: Lang) => void;
  /** Picks the Spanish or English string. */
  t: (es: string, en: string) => string;
}

const LangCtx = createContext<LangState>(null!);

function storedLang(): Lang {
  try {
    const v = localStorage.getItem("bitgate.lang");
    if (v === "es" || v === "en") return v;
  } catch {
    // storage blocked: fall through to the browser language
  }
  return navigator.language.toLowerCase().startsWith("es") ? "es" : "en";
}

export function LangProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(storedLang);
  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    try {
      localStorage.setItem("bitgate.lang", l);
    } catch {
      // not persisted, still applied
    }
  }, []);
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);
  const t = useCallback((es: string, en: string) => (lang === "es" ? es : en), [lang]);
  return <LangCtx.Provider value={{ lang, setLang, t }}>{children}</LangCtx.Provider>;
}

export const useLang = () => useContext(LangCtx);

// ── Polling ─────────────────────────────────────────────────────────────────

export interface Polled<T> {
  data: T | undefined;
  error: unknown;
  loading: boolean;
  reload: () => void;
}

/** Runs `fn` now and every `intervalMs` (0 = once) while `deps` stay the same. */
export function usePoll<T>(fn: () => Promise<T>, intervalMs: number, deps: unknown[]): Polled<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<unknown>();
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = async () => {
      try {
        const v = await fnRef.current();
        if (!alive) return;
        setData(v);
        setError(undefined);
      } catch (e) {
        if (alive) setError(e);
      } finally {
        if (alive) {
          setLoading(false);
          if (intervalMs > 0) timer = setTimeout(run, intervalMs);
        }
      }
    };
    setLoading(true);
    run();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce, intervalMs]);

  return { data, error, loading, reload: useCallback(() => setNonce((n) => n + 1), []) };
}

/** Current Unix time in seconds, ticking once a second. */
export function useNow(): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

// ── Wallet ──────────────────────────────────────────────────────────────────

interface WalletState {
  address: string | null;
  account: AccountState | null;
  connecting: boolean;
  /** Guest setup step in progress, for the button label. */
  setupStep: string | null;
  error: string | null;
  /** True when the connected account is the in-browser guest account. */
  isGuest: boolean;
  connect: () => Promise<void>;
  /** Creates (or restores) the guest account and makes it ready to trade. */
  connectGuest: () => Promise<void>;
  disconnect: () => void;
  refreshAccount: () => Promise<void>;
}

const WalletCtx = createContext<WalletState>(null!);

export function WalletProvider({ children }: { children: ReactNode }) {
  const [address, setAddress] = useState<string | null>(null);
  const [account, setAccount] = useState<AccountState | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshAccount = useCallback(async () => {
    if (!address) return setAccount(null);
    setAccount(await accountState(address));
  }, [address]);

  const [setupStep, setSetupStep] = useState<string | null>(null);

  useEffect(() => {
    if (savedWalletMode() === "guest") setAddress(ensureGuestStellar());
    else knownWalletAddress().then((a) => a && setAddress(a));
  }, []);

  useEffect(() => {
    refreshAccount();
    if (!address) return;
    const id = setInterval(refreshAccount, 20_000);
    return () => clearInterval(id);
  }, [address, refreshAccount]);

  const connect = useCallback(async () => {
    setConnecting(true);
    setError(null);
    try {
      setAddress(await connectWallet());
      saveWalletMode("freighter");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setConnecting(false);
    }
  }, []);

  const connectGuest = useCallback(async () => {
    setConnecting(true);
    setError(null);
    try {
      const guest = ensureGuestStellar();
      saveWalletMode("guest");
      let state = await accountState(guest);
      if (!state.exists) {
        setSetupStep("friendbot");
        await fundWithFriendbot(guest);
        state = await accountState(guest);
      }
      if (state.usdc === null) {
        setSetupStep("trustline");
        await addUsdcTrustline(guest);
        state = await accountState(guest);
      }
      if ((state.usdc ?? 0n) < BigInt(GUEST_STARTING_USDC) * 10_000_000n) {
        setSetupStep("usdc");
        // Best effort: the DEX can lack liquidity; the ready gate offers it again.
        await buyTestUsdc(guest, GUEST_STARTING_USDC).catch(() => undefined);
      }
      setAddress(guest);
      setAccount(await accountState(guest));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSetupStep(null);
      setConnecting(false);
    }
  }, []);

  const disconnect = useCallback(() => {
    saveWalletMode(null);
    setAddress(null);
    setAccount(null);
  }, []);

  const isGuest = address != null && guestSigner(address) != null;

  return (
    <WalletCtx.Provider
      value={{ address, account, connecting, setupStep, error, isGuest, connect, connectGuest, disconnect, refreshAccount }}
    >
      {children}
    </WalletCtx.Provider>
  );
}

export const useWallet = () => useContext(WalletCtx);

// ── Chain: both Bitcoin tips and the oracle price ───────────────────────────

interface ChainState {
  /** Tip of the Writz bitcoin-spv light client on Stellar. */
  lightClientTip: number | null;
  /** Tip of Bitcoin signet, from Esplora. */
  signetTip: number | null;
  oracle: OraclePrice | null;
}

const ChainCtx = createContext<ChainState>(null!);

export function ChainProvider({ children }: { children: ReactNode }) {
  const lc = usePoll(bestTip, 30_000, []);
  const signet = usePoll(tipHeight, 60_000, []);
  const oracle = usePoll(reflectorBtcPrice, 300_000, []);
  return (
    <ChainCtx.Provider
      value={{
        lightClientTip: lc.data?.height ?? null,
        signetTip: signet.data ?? null,
        oracle: oracle.data ?? null,
      }}
    >
      {children}
    </ChainCtx.Provider>
  );
}

export const useChain = () => useContext(ChainCtx);

// ── Routing ─────────────────────────────────────────────────────────────────

export type Route =
  | { name: "market" }
  | { name: "new" }
  | { name: "how" }
  | { name: "offer"; id: bigint }
  | { name: "trade"; id: bigint };

function parseHash(hash: string): Route {
  const [, page, id] = hash.replace(/^#/, "").split("/");
  if (page === "new") return { name: "new" };
  if (page === "how") return { name: "how" };
  if ((page === "offer" || page === "trade") && /^\d+$/.test(id ?? "")) {
    return { name: page, id: BigInt(id) };
  }
  return { name: "market" };
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseHash(location.hash));
  useEffect(() => {
    const on = () => {
      setRoute(parseHash(location.hash));
      window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}

export const go = (path: string) => {
  location.hash = path;
};
