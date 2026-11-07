import QRCode from "qrcode";
import { useEffect, useState, type ReactNode } from "react";
import { CONFIG } from "../config";
import { fmtDuration, shortAddr } from "../lib/format";
import { ContractError } from "../lib/stellar";
import { useLang, useNow, type Lang } from "./state";

// ── Error text ──────────────────────────────────────────────────────────────

const ERROR_TEXT: Record<string, [string, string]> = {
  OfferNotFound: ["Esa oferta no existe.", "That offer does not exist."],
  InsufficientSignet: [
    "No alcanzan los sats de tu wallet signet para este pago y su comisión.",
    "Your signet wallet does not have enough sats for this payment and its fee.",
  ],
  "Friendbot failed": [
    "Friendbot no respondió. Espera unos segundos y vuelve a intentar.",
    "Friendbot did not answer. Wait a few seconds and try again.",
  ],
  TradeNotFound: ["Ese trade no existe.", "That trade does not exist."],
  InvalidAmount: ["El monto está fuera de los límites de la oferta.", "The amount is outside the offer's limits."],
  InvalidPrice: ["El precio debe ser mayor que cero.", "The price must be above zero."],
  InvalidScript: ["La dirección Bitcoin no es válida.", "The Bitcoin address is not valid."],
  InvalidConfirmations: ["Las confirmaciones deben estar entre 1 y 144.", "Confirmations must be between 1 and 144."],
  InvalidWindow: ["La ventana debe durar entre 10 minutos y 3 días.", "The window must last 10 minutes to 3 days."],
  InvalidBond: ["El bono no puede pasar del 10%.", "The bond cannot exceed 10%."],
  BelowDust: [
    "El pago en BTC sería menor al límite de dust (546 sats). Sube el mínimo.",
    "The BTC payment would be below the dust limit (546 sats). Raise the minimum.",
  ],
  OfferClosed: ["La oferta está cerrada o agotada.", "The offer is closed or sold out."],
  OfferBusy: [
    "Otro comprador tiene esta oferta reservada. Se libera cuando venza su ventana.",
    "Another buyer holds this offer. It frees up when their window ends.",
  ],
  SelfTrade: ["No puedes tomar tu propia oferta.", "You cannot take your own offer."],
  TradeNotPending: ["Este trade ya se liquidó o venció.", "This trade already settled or expired."],
  TradeExpired: ["La ventana de este trade ya venció.", "This trade's window has ended."],
  TradeNotExpired: ["La ventana de este trade sigue abierta.", "This trade's window is still open."],
  LightClientUnavailable: ["El light client de Writz no responde.", "The Writz light client is not available."],
  ProofRejected: ["El light client de Writz rechazó la prueba.", "The Writz light client rejected the proof."],
  NotEnoughConfirmations: [
    "El bloque aún no tiene las confirmaciones que pide la oferta.",
    "The block does not have the confirmations the offer asks for yet.",
  ],
  BlockNotInLightClient: [
    "El bloque aún no llega al light client de Writz. Suele tardar un minuto.",
    "The block has not reached the Writz light client yet. It usually takes a minute.",
  ],
  PaymentPredatesTrade: [
    "Ese pago es anterior al trade, así que no puede pagarlo.",
    "That payment is older than the trade, so it cannot pay for it.",
  ],
  TxidAlreadyUsed: ["Esa transacción Bitcoin ya liquidó otro trade.", "That Bitcoin transaction already settled a trade."],
  OutputNotFound: [
    "La transacción no paga a la dirección del vendedor.",
    "The transaction does not pay the seller's address.",
  ],
  Underpaid: ["La transacción paga menos de lo acordado.", "The transaction pays less than agreed."],
  MissingTrustline: ["Tu cuenta no tiene trustline de USDC.", "Your account has no USDC trustline."],
  InsufficientBalance: ["No tienes suficiente USDC.", "You do not have enough USDC."],
  InsufficientConfirmations: ["Faltan confirmaciones.", "Not enough confirmations yet."],
  HeaderNotFound: ["El bloque no está en el light client.", "The block is not in the light client."],
  MerkleProofInvalid: ["La prueba Merkle no es válida.", "The Merkle proof is invalid."],
  NotOnBestChain: ["El bloque quedó huérfano.", "The block was orphaned."],
  FreighterMissing: [
    "Instala la extensión Freighter (freighter.app) y vuelve a intentar.",
    "Install the Freighter extension (freighter.app) and try again.",
  ],
  WrongNetwork: ["Cambia Freighter a Testnet.", "Switch Freighter to Testnet."],
};

export function errorText(e: unknown, lang: Lang): string {
  const name = e instanceof ContractError ? e.name : e instanceof Error ? e.message : String(e);
  const known = ERROR_TEXT[name];
  if (known) return known[lang === "es" ? 0 : 1];
  if (e instanceof ContractError && e.code != null) return `${name} (#${e.code})`;
  return name.length > 220 ? name.slice(0, 220) + "…" : name;
}

// ── Small building blocks ───────────────────────────────────────────────────

export function ExtLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  );
}

export function AccountLink({ address }: { address: string }) {
  return (
    <ExtLink href={CONFIG.explorer.stellarAccount(address)}>
      <span className="mono">{shortAddr(address)}</span>
    </ExtLink>
  );
}

export function Notice({ kind = "info", children }: { kind?: "info" | "warn" | "error" | "ok"; children: ReactNode }) {
  return <div className={`notice notice-${kind}`}>{children}</div>;
}

export function Badge({ kind, children }: { kind: "open" | "busy" | "closed" | "ok" | "fail" | "neutral"; children: ReactNode }) {
  return <span className={`badge badge-${kind}`}>{children}</span>;
}

export function Spinner() {
  return <span className="spinner" aria-hidden="true" />;
}

export function Countdown({ deadline }: { deadline: number }) {
  const now = useNow();
  const { t } = useLang();
  const left = deadline - now;
  if (left <= 0) return <span className="countdown expired">{t("vencido", "expired")}</span>;
  return <span className={`countdown ${left < 600 ? "soon" : ""}`}>{fmtDuration(left)}</span>;
}

export function CopyButton({ value, label }: { value: string; label?: string }) {
  const { t } = useLang();
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="btn btn-ghost btn-sm"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          // clipboard blocked; the value is visible to copy by hand
        }
      }}
    >
      {done ? t("Copiado", "Copied") : (label ?? t("Copiar", "Copy"))}
    </button>
  );
}

export function QrCode({ text, size = 196 }: { text: string; size?: number }) {
  const [src, setSrc] = useState<string>();
  useEffect(() => {
    QRCode.toDataURL(text, { margin: 1, width: size, errorCorrectionLevel: "M" }).then(setSrc, () => setSrc(undefined));
  }, [text, size]);
  return src ? <img className="qr" src={src} width={size} height={size} alt="" /> : null;
}

/** A button that runs an async action, shows progress and reports errors. */
export function ActionButton({
  onRun,
  children,
  kind = "primary",
  disabled,
  onError,
}: {
  onRun: () => Promise<unknown>;
  children: ReactNode;
  kind?: "primary" | "secondary" | "ghost" | "danger";
  disabled?: boolean;
  onError?: (message: string) => void;
}) {
  const { lang } = useLang();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="action">
      <button
        type="button"
        className={`btn btn-${kind}`}
        disabled={disabled || busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            await onRun();
          } catch (e) {
            const msg = errorText(e, lang);
            setError(msg);
            onError?.(msg);
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy && <Spinner />}
        {children}
      </button>
      {error && !onError && <span className="action-error">{error}</span>}
    </span>
  );
}

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {hint && <div className="stat-hint">{hint}</div>}
    </div>
  );
}

export function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

export type StepState = "done" | "active" | "todo" | "fail";

export function Step({
  state,
  index,
  title,
  children,
}: {
  state: StepState;
  index: number;
  title: string;
  children?: ReactNode;
}) {
  return (
    <li className={`step step-${state}`}>
      <span className="step-dot">{state === "done" ? "✓" : state === "fail" ? "!" : index}</span>
      <div className="step-body">
        <div className="step-title">{title}</div>
        {children && <div className="step-content">{children}</div>}
      </div>
    </li>
  );
}
