import { useState } from "react";
import { fmtSats, fmtToken, fmtUsd, usdPerBtc } from "../lib/format";
import { GUEST_FEE_ESTIMATE, guestBtcAddress, guestBtcBalance, payFromGuest } from "../lib/guest";
import type { Offer } from "../lib/stellar";
import { ActionButton, CopyButton, ExtLink } from "./components";
import { useLang, usePoll, useWallet } from "./state";

/** Where testers ask for signet sats when the public faucets are down. */
const SATS_HELP = "https://t.me/jafetchv";
const FAUCETS = ["https://signetfaucet.com", "https://alt.signetfaucet.com"];

/** One click: a testnet account in this browser, funded and ready to trade. */
export function GuestButton({ small = false }: { small?: boolean }) {
  const { t } = useLang();
  const { connectGuest, connecting, setupStep } = useWallet();
  const label =
    setupStep === "friendbot"
      ? t("Creando tu cuenta…", "Creating your account…")
      : setupStep === "trustline"
        ? t("Activando USDC…", "Enabling USDC…")
        : setupStep === "usdc"
          ? t("Cargando 10 USDC de prueba…", "Loading 10 test USDC…")
          : t("Probar sin wallet", "Try without a wallet");
  return (
    <button className={`btn btn-primary ${small ? "btn-sm" : ""}`} onClick={connectGuest} disabled={connecting}>
      {label}
    </button>
  );
}

/**
 * Pays a trade from the guest signet wallet in this browser, or shows how to
 * fund it. `onPaid` gets the broadcast txid.
 */
export function GuestPay({ to, sats, onPaid }: { to: string; sats: number; onPaid: (txid: string) => void }) {
  const { t } = useLang();
  const address = guestBtcAddress();
  const balance = usePoll(guestBtcBalance, 15_000, [address]);
  const need = sats + GUEST_FEE_ESTIMATE;
  const enough = balance.data != null && balance.data >= need;

  return (
    <div className="guest-pay">
      <div className="guest-pay-head">
        <strong>{t("Paga desde tu wallet signet de BitGate", "Pay from your BitGate signet wallet")}</strong>
        <span className="muted small">
          {t("Saldo", "Balance")}: {balance.data == null ? "…" : fmtSats(balance.data)} sats
        </span>
      </div>
      {enough ? (
        <ActionButton onRun={async () => onPaid(await payFromGuest(to, sats))}>
          {t(`Pagar ${fmtSats(sats)} sats ahora`, `Pay ${fmtSats(sats)} sats now`)}
        </ActionButton>
      ) : (
        <>
          <p className="small">
            {t(
              `Necesitas al menos ${fmtSats(need)} sats de prueba (signet, sin valor). Recíbelos en tu dirección:`,
              `You need at least ${fmtSats(need)} test sats (signet, no value). Receive them at your address:`,
            )}
          </p>
          <div className="mono break small">{address}</div>
          <CopyButton value={address} label={t("Copiar dirección", "Copy address")} />
          <p className="muted small">
            {t("Faucets:", "Faucets:")}{" "}
            {FAUCETS.map((f, i) => (
              <span key={f}>
                {i > 0 && " · "}
                <ExtLink href={f}>{f.replace("https://", "")}</ExtLink>
              </span>
            ))}{" "}
            · <ExtLink href={SATS_HELP}>{t("o pídelos por Telegram", "or ask on Telegram")}</ExtLink>
          </p>
        </>
      )}
      <p className="muted small">
        {t(
          "Esta wallet y tu cuenta de Stellar viven solo en este navegador, en redes de prueba.",
          "This wallet and your Stellar account live only in this browser, on test networks.",
        )}
      </p>
    </div>
  );
}

/** Share an open offer where P2P trading already happens: WhatsApp and Telegram groups. */
export function ShareOffer({ offer }: { offer: Offer }) {
  const { t } = useLang();
  const [copied, setCopied] = useState(false);
  const url = `${location.origin}${location.pathname}#/offer/${offer.id}`;
  const text = t(
    `Vendo ${fmtToken(offer.remaining)} USDC por BTC a ${fmtUsd(usdPerBtc(offer.satsPerToken))}/BTC en BitGate. Escrow en Stellar: el USDC se libera solo cuando Bitcoin prueba tu pago. Sin custodio. Resérvalo aquí:`,
    `Selling ${fmtToken(offer.remaining)} USDC for BTC at ${fmtUsd(usdPerBtc(offer.satsPerToken))}/BTC on BitGate. Escrow on Stellar: the USDC is released only when Bitcoin proves your payment. No custodian. Reserve it here:`,
  );
  const wa = `https://wa.me/?text=${encodeURIComponent(`${text} ${url}`)}`;
  const tg = `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`;
  return (
    <div className="share-row">
      <span className="muted small">{t("Compartir oferta:", "Share offer:")}</span>
      <a className="btn btn-ghost btn-sm" href={wa} target="_blank" rel="noreferrer">
        WhatsApp
      </a>
      <a className="btn btn-ghost btn-sm" href={tg} target="_blank" rel="noreferrer">
        Telegram
      </a>
      <button
        className="btn btn-ghost btn-sm"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(url);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          } catch {
            // Clipboard can be blocked; the link stays visible in the address bar.
          }
        }}
      >
        {copied ? t("¡Copiado!", "Copied!") : t("Copiar link", "Copy link")}
      </button>
    </div>
  );
}
