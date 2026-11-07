import { useEffect, useState } from "react";
import { CONFIG } from "../config";
import { bip21, outputValue, reverseHex, scriptToAddress } from "../lib/bitcoin";
import { addressTxs, txHex, txStatus } from "../lib/esplora";
import { fmtBtc, fmtSats, fmtToken } from "../lib/format";
import { ProofNotReady, getProof, type Proof } from "../lib/proof";
import {
  claimTrade,
  dryRunClaim,
  expireTrade,
  getFeeBps,
  getOffer,
  getTrade,
  verifyWithWritz,
  type Offer,
  type SpvVerification,
  type Trade,
} from "../lib/stellar";
import {
  AccountLink,
  ActionButton,
  CopyButton,
  Countdown,
  ExtLink,
  Notice,
  QrCode,
  Row,
  Spinner,
  Step,
  errorText,
  type StepState,
} from "./components";
import { GuestPay } from "./Guest";
import { TradeStatusBadge } from "./Market";
import { useChain, useLang, useNow, usePoll, useWallet } from "./state";

/** A Bitcoin transaction that pays the offer's script enough for this trade. */
interface Payment {
  txid: string;
  sats: number;
  height: number | null;
}

/**
 * The newest transaction paying the offer's script at least `satsDue` that
 * is unconfirmed or mined above the trade's height floor: the only payments
 * the escrow will accept for this trade.
 */
async function findPayment(address: string, script: string, trade: Trade): Promise<Payment | null> {
  const txs = await addressTxs(address);
  for (const tx of txs) {
    const height = tx.status.confirmed ? (tx.status.block_height ?? null) : null;
    if (height != null && height <= trade.btcHeightFloor) continue;
    const out = tx.vout.find((o) => o.scriptpubkey === script && o.value >= trade.satsDue);
    if (out) return { txid: tx.txid, sats: out.value, height };
  }
  return null;
}

/** A payment the user names by txid, checked the same way. */
async function paymentFromTxid(txid: string, script: string): Promise<Payment> {
  const [status, hex] = await Promise.all([txStatus(txid), txHex(txid)]);
  const sats = outputValue(hex, script);
  if (sats == null) throw new Error("OutputNotFound");
  return { txid, sats, height: status.confirmed ? (status.block_height ?? null) : null };
}

export function TradePage({ id }: { id: bigint }) {
  const { t, lang } = useLang();
  const trade = usePoll(() => getTrade(id), 10_000, [String(id)]);
  const offer = usePoll(async () => (trade.data ? getOffer(trade.data.offerId) : null), 0, [String(trade.data?.offerId)]);

  if (trade.error) return <Notice kind="error">{errorText(trade.error, lang)}</Notice>;
  if (!trade.data || !offer.data) return <Spinner />;
  const tr = trade.data;
  const o = offer.data;

  return (
    <div className="page-grid">
      <section className="panel">
        <div className="panel-head">
          <h1>Trade #{String(tr.id)}</h1>
          <TradeStatusBadge trade={tr} now={Math.floor(Date.now() / 1000)} />
        </div>
        <dl className="facts">
          <Row label={t("Oferta", "Offer")}>
            <a href={`#/offer/${o.id}`}>#{String(o.id)}</a>
          </Row>
          <Row label="USDC">{fmtToken(tr.amount)}</Row>
          <Row label={t("BTC a pagar", "BTC to pay")}>
            {fmtSats(tr.satsDue)} sats ({fmtBtc(tr.satsDue)} BTC)
          </Row>
          <Row label={t("Comprador", "Buyer")}>
            <AccountLink address={tr.taker} />
          </Row>
          <Row label={t("Vendedor", "Seller")}>
            <AccountLink address={o.maker} />
          </Row>
          <Row label={t("Bono", "Bond")}>{fmtToken(tr.bond)} USDC</Row>
          <Row label={t("Piso de altura BTC", "BTC height floor")}>
            <span title={t("Solo cuentan pagos minados por encima", "Only payments mined above it count")}>
              #{tr.btcHeightFloor.toLocaleString("en-US")}
            </span>
          </Row>
          {tr.status === "Pending" && (
            <Row label={t("Tiempo restante", "Time left")}>
              <Countdown deadline={tr.deadline} />
            </Row>
          )}
        </dl>
        <p className="muted small">
          {t(
            "El piso de altura es el tip del light client de Writz cuando se abrió el trade: un pago viejo a la misma dirección no puede reutilizarse.",
            "The height floor is the Writz light client tip when the trade opened: an older payment to the same address cannot be reused.",
          )}
        </p>
      </section>

      <section className="panel">
        {tr.status === "Settled" && <Settled trade={tr} offer={o} />}
        {tr.status === "Expired" && (
          <Notice kind="warn">
            {t(
              "La ventana venció sin pago probado. El USDC volvió a la oferta y el bono al vendedor.",
              "The window ended without a proven payment. The USDC went back to the offer and the bond to the seller.",
            )}
          </Notice>
        )}
        {tr.status === "Pending" && <Tracker trade={tr} offer={o} onChange={trade.reload} />}
      </section>
    </div>
  );
}

function Settled({ trade, offer }: { trade: Trade; offer: Offer }) {
  const { t } = useLang();
  const txid = trade.btcTxid ? reverseHex(trade.btcTxid) : null;
  return (
    <>
      <h2 className="ok-title">✓ {t("Liquidado", "Settled")}</h2>
      <p>
        {t(
          "El light client de Writz probó el pago en Bitcoin y el escrow liberó el USDC al comprador. Nadie tuvo que confiar en nadie.",
          "The Writz light client proved the Bitcoin payment and the escrow released the USDC to the buyer. Nobody had to trust anybody.",
        )}
      </p>
      <dl className="facts">
        {txid && (
          <Row label={t("Pago Bitcoin", "Bitcoin payment")}>
            <ExtLink href={CONFIG.explorer.btcTx(txid)}>
              <span className="mono break">{txid}</span>
            </ExtLink>
          </Row>
        )}
        {trade.btcBlockHeight != null && (
          <Row label={t("Bloque", "Block")}>
            <ExtLink href={CONFIG.explorer.btcBlock(trade.btcBlockHeight)}>#{trade.btcBlockHeight.toLocaleString("en-US")}</ExtLink>
          </Row>
        )}
        {trade.satsPaid != null && <Row label={t("Sats pagados", "Sats paid")}>{fmtSats(trade.satsPaid)}</Row>}
        <Row label={t("USDC al comprador", "USDC to the buyer")}>{fmtToken(trade.amount - trade.fee + trade.bond)}</Row>
        <Row label={t("Comisión", "Fee")}>{fmtToken(trade.fee)} USDC</Row>
        <Row label={t("Escrow", "Escrow")}>
          <ExtLink href={CONFIG.explorer.stellarContract(CONFIG.escrowId)}>{t("eventos en stellar.expert", "events on stellar.expert")}</ExtLink>
        </Row>
      </dl>
      <p className="muted small">
        {t("Oferta", "Offer")} #{String(offer.id)} · {t("busca el evento", "look for the")} <span className="mono">trade_settled</span>{" "}
        {t("con este txid en el explorador.", "event with this txid in the explorer.")}
      </p>
    </>
  );
}

function Tracker({ trade, offer, onChange }: { trade: Trade; offer: Offer; onChange: () => void }) {
  const { t, lang } = useLang();
  const { address } = useWallet();
  const { lightClientTip, signetTip } = useChain();
  const now = useNow();
  const feeBps = usePoll(getFeeBps, 0, []);
  const btcAddress = scriptToAddress(offer.btcScript);
  const expired = now > trade.deadline;

  const [manualTxid, setManualTxid] = useState("");
  const [manual, setManual] = useState<Payment | null>(null);
  const [manualError, setManualError] = useState<string | null>(null);

  const detected = usePoll(
    async () => (btcAddress ? findPayment(btcAddress, offer.btcScript, trade) : null),
    20_000,
    [btcAddress, String(trade.id)],
  );
  const payment = manual ?? detected.data ?? null;

  // Confirmations as the Writz light client counts them, not the explorer.
  const confirmations =
    payment?.height != null && lightClientTip != null && lightClientTip >= payment.height
      ? lightClientTip - payment.height + 1
      : 0;
  const deepEnough = confirmations >= offer.minConfirmations;

  const [proof, setProof] = useState<Proof | null>(null);
  const [verified, setVerified] = useState<SpvVerification | null>(null);
  const [proofError, setProofError] = useState<string | null>(null);
  const [claimHash, setClaimHash] = useState<string | null>(null);

  useEffect(() => {
    if (!payment || !deepEnough || verified) return;
    let alive = true;
    (async () => {
      try {
        setProofError(null);
        const p = await getProof(payment.txid, Math.min(offer.minConfirmations, 20));
        if (!alive) return;
        setProof(p);
        const v = await verifyWithWritz(p.args, offer.minConfirmations);
        await dryRunClaim(trade.id, p.args);
        if (alive) setVerified(v);
      } catch (e) {
        if (!alive) return;
        setProofError(
          e instanceof ProofNotReady
            ? t(`El relayer aún no tiene la prueba (${e.reason}). Reintentando…`, `The relayer does not have the proof yet (${e.reason}). Retrying…`)
            : errorText(e, lang),
        );
      }
    })();
    return () => {
      alive = false;
    };
    // Retried on every light client tip change until it verifies.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payment?.txid, deepEnough, lightClientTip, verified]);

  const stepPay: StepState = payment ? "done" : expired ? "fail" : "active";
  const stepConfirm: StepState = !payment ? "todo" : deepEnough ? "done" : "active";
  const stepProof: StepState = !deepEnough ? "todo" : verified ? "done" : proofError ? "fail" : "active";
  const stepClaim: StepState = !verified ? "todo" : claimHash ? "done" : "active";

  return (
    <>
      <h2>{t("Sigue tu trade", "Follow your trade")}</h2>
      {expired && !verified && (
        <Notice kind="warn">
          {t(
            "La ventana venció. Cualquiera puede cerrar el trade: el USDC vuelve a la oferta y el bono al vendedor.",
            "The window has ended. Anyone can close the trade: the USDC returns to the offer and the bond to the seller.",
          )}
          {address && (
            <div className="notice-action">
              <ActionButton kind="secondary" onRun={() => expireTrade(address, trade.id).then(onChange)}>
                {t("Cerrar trade vencido", "Close lapsed trade")}
              </ActionButton>
            </div>
          )}
        </Notice>
      )}

      <ol className="steps">
        <Step state="done" index={1} title={t("Reservado en Stellar", "Reserved on Stellar")}>
          {t("El USDC quedó apartado para ti en el escrow.", "The USDC is set aside for you in the escrow.")}
        </Step>

        <Step state={stepPay} index={2} title={t("Paga en Bitcoin (signet)", "Pay on Bitcoin (signet)")}>
          {!payment && btcAddress && (
            <div className="pay-box">
              <QrCode text={bip21(btcAddress, trade.satsDue, `BitGate trade ${trade.id}`)} />
              <div className="pay-details">
                <div className="pay-amount">
                  {fmtSats(trade.satsDue)} <span className="unit">sats</span>
                  <CopyButton value={fmtBtc(trade.satsDue)} label={t("Copiar BTC", "Copy BTC")} />
                </div>
                <div className="mono break small">{btcAddress}</div>
                <CopyButton value={btcAddress} label={t("Copiar dirección", "Copy address")} />
                <p className="muted small">
                  {t("Envía al menos este monto en una sola salida. Vence en", "Send at least this amount in one output. Due in")}{" "}
                  <Countdown deadline={trade.deadline} />.
                </p>
              </div>
            </div>
          )}
          {!payment && btcAddress && !expired && address === trade.taker && (
            <GuestPay
              to={btcAddress}
              sats={trade.satsDue}
              onPaid={(txid) => setManual({ txid, sats: trade.satsDue, height: null })}
            />
          )}
          {!payment && (
            <form
              className="inline-form"
              onSubmit={async (e) => {
                e.preventDefault();
                setManualError(null);
                try {
                  setManual(await paymentFromTxid(manualTxid.trim(), offer.btcScript));
                } catch (err) {
                  setManualError(errorText(err, lang));
                }
              }}
            >
              <input
                placeholder={t("¿Ya pagaste? Pega el txid", "Already paid? Paste the txid")}
                value={manualTxid}
                onChange={(e) => setManualTxid(e.target.value)}
                pattern="[0-9a-fA-F]{64}"
              />
              <button className="btn btn-ghost btn-sm" type="submit">
                {t("Usar", "Use")}
              </button>
              {manualError && <span className="action-error">{manualError}</span>}
            </form>
          )}
          {payment && (
            <p>
              {t("Pago detectado:", "Payment detected:")}{" "}
              <ExtLink href={CONFIG.explorer.btcTx(payment.txid)}>
                <span className="mono">{payment.txid.slice(0, 16)}…</span>
              </ExtLink>{" "}
              · {fmtSats(payment.sats)} sats
            </p>
          )}
        </Step>

        <Step
          state={stepConfirm}
          index={3}
          title={t(
            `Confirmaciones en el light client de Writz: ${confirmations} / ${offer.minConfirmations}`,
            `Confirmations in the Writz light client: ${confirmations} / ${offer.minConfirmations}`,
          )}
        >
          {payment && (
            <p className="muted small">
              {payment.height == null
                ? t("En el mempool, esperando bloque (~10 min en signet).", "In the mempool, waiting for a block (~10 min on signet).")
                : t(`Minado en el bloque #${payment.height}.`, `Mined in block #${payment.height}.`)}{" "}
              {t("Tip de signet", "Signet tip")} #{signetTip ?? "…"} · {t("tip del light client", "light client tip")} #{lightClientTip ?? "…"}
            </p>
          )}
        </Step>

        <Step state={stepProof} index={4} title={t("Prueba SPV verificada por Writz", "SPV proof verified by Writz")}>
          {proof && (
            <p className="muted small">
              {t("Fuente de la prueba:", "Proof source:")}{" "}
              <strong>{proof.source === "writz-relayer" ? t("relayer de Writz", "Writz relayer") : t("Esplora (respaldo, sin relayer)", "Esplora (fallback, no relayer)")}</strong>
            </p>
          )}
          {verified && (
            <div className="verdict">
              <div className="verdict-head">bitcoin-spv.verify_transaction ✓</div>
              <dl className="facts compact">
                <Row label="txid">
                  <span className="mono">{reverseHex(verified.txid).slice(0, 24)}…</span>
                </Row>
                <Row label={t("bloque", "block")}>#{verified.blockHeight}</Row>
                <Row label={t("confirmaciones", "confirmations")}>{verified.confirmations}</Row>
              </dl>
              <p className="muted small">
                {t(
                  "Simulado contra el contrato de Writz en testnet, y la simulación de claim del escrow pasa: el pago es al script correcto, por el monto correcto, posterior al trade y nunca usado.",
                  "Simulated against the Writz contract on testnet, and the escrow's claim simulation passes: the payment is to the right script, for the right amount, newer than the trade and never used before.",
                )}
              </p>
            </div>
          )}
          {proofError && <p className="action-error">{proofError}</p>}
        </Step>

        <Step state={stepClaim} index={5} title={t("Liberar USDC", "Release USDC")}>
          {verified && !claimHash && (
            <>
              {address ? (
                <ActionButton
                  onRun={async () => {
                    setClaimHash(await claimTrade(address, trade.id, proof!.args));
                    onChange();
                  }}
                >
                  {t("Enviar prueba y liberar", "Submit proof and release")}{" "}
                  {fmtToken(trade.amount - (trade.amount * BigInt(feeBps.data ?? 0)) / 10_000n + trade.bond)} USDC
                </ActionButton>
              ) : (
                <p className="muted small">{t("Conecta una wallet para enviar la prueba.", "Connect a wallet to submit the proof.")}</p>
              )}
              <p className="muted small">
                {t(
                  "Cualquiera puede enviar la prueba (sin firma del comprador): el USDC siempre va al comprador del trade.",
                  "Anyone can submit the proof (no buyer signature needed): the USDC always goes to the trade's buyer.",
                )}
              </p>
            </>
          )}
          {claimHash && (
            <p>
              <ExtLink href={CONFIG.explorer.stellarTx(claimHash)}>{t("Ver transacción en Stellar", "View Stellar transaction")}</ExtLink>
            </p>
          )}
        </Step>
      </ol>
    </>
  );
}
