import { CONFIG } from "./config";
import { shortAddr } from "./lib/format";
import { CreateOffer } from "./ui/CreateOffer";
import { ExtLink, errorText } from "./ui/components";
import { GuestButton } from "./ui/Guest";
import { HowItWorks } from "./ui/HowItWorks";
import { Market } from "./ui/Market";
import { OfferPage } from "./ui/OfferPage";
import { TradePage } from "./ui/TradePage";
import { useChain, useLang, useRoute, useWallet } from "./ui/state";

export function App() {
  const route = useRoute();
  const { t } = useLang();
  return (
    <>
      <Header />
      <main>
        {route.name === "market" && <Market />}
        {route.name === "new" && <CreateOffer />}
        {route.name === "how" && <HowItWorks />}
        {route.name === "offer" && <OfferPage key={String(route.id)} id={route.id} />}
        {route.name === "trade" && <TradePage key={String(route.id)} id={route.id} />}
      </main>
      <footer>
        <span>{t("Solo testnet y signet · no auditado", "Testnet and signet only · not audited")}</span>
        <ExtLink href={CONFIG.repo}>GitHub</ExtLink>
        <ExtLink href={CONFIG.explorer.stellarContract(CONFIG.escrowId)}>{t("Contrato", "Contract")}</ExtLink>
        <ExtLink href="https://docs.writz.xyz">Writz</ExtLink>
        <span>{t("Hecho para el Pura Vida Ideathon", "Built for the Pura Vida Ideathon")}</span>
      </footer>
    </>
  );
}

function Logo() {
  return (
    <svg width="28" height="28" viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="8" fill="#E8891C" />
      <g fill="#15181D">
        <rect x="8.5" y="7" width="4" height="18" rx="1.2" />
        <path d="M14.5 7h4a4.25 4.25 0 0 1 0 8.5h-4z" />
        <path d="M14.5 17h4.75a4 4 0 0 1 0 8H14.5z" />
      </g>
    </svg>
  );
}

function Header() {
  const { t, lang, setLang } = useLang();
  const { address, connect, connecting, disconnect, error, isGuest } = useWallet();
  const { lightClientTip, signetTip } = useChain();
  const behind = lightClientTip != null && signetTip != null ? signetTip - lightClientTip : null;

  return (
    <header className="topbar">
      <a className="brand" href="#/">
        <Logo />
        <span>BitGate</span>
      </a>
      <nav>
        <a href="#/">{t("Mercado", "Market")}</a>
        <a href="#/new">{t("Vender", "Sell")}</a>
        <a href="#/how">{t("Cómo funciona", "How it works")}</a>
      </nav>
      <div className="topbar-right">
        <span
          className={`lc-badge ${behind == null ? "" : behind <= 1 ? "lc-ok" : "lc-behind"}`}
          title={t(
            "Tip del light client bitcoin-spv de Writz en Stellar, comparado con el tip de signet",
            "Tip of the Writz bitcoin-spv light client on Stellar, compared with the signet tip",
          )}
        >
          <span className="dot" />
          Writz SPV #{lightClientTip?.toLocaleString("en-US") ?? "…"}
          {behind != null && behind > 1 && (
            <span className="muted">
              {" "}
              ({behind} {t("atrás", "behind")})
            </span>
          )}
        </span>
        <button className="btn btn-ghost btn-sm" onClick={() => setLang(lang === "es" ? "en" : "es")}>
          {lang === "es" ? "EN" : "ES"}
        </button>
        {address ? (
          <button className="btn btn-secondary btn-sm mono" onClick={disconnect} title={t("Desconectar", "Disconnect")}>
            {isGuest && <span className="guest-tag">{t("Invitado", "Guest")}</span>}
            {shortAddr(address)}
          </button>
        ) : (
          <>
            <GuestButton small />
            <button className="btn btn-ghost btn-sm" onClick={connect} disabled={connecting}>
              Freighter
            </button>
          </>
        )}
      </div>
      {error && <div className="topbar-error">{errorText(new Error(error), lang)}</div>}
    </header>
  );
}
