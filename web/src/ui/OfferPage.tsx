import { useState } from "react";
import { CONFIG } from "../config";
import { scriptToAddress } from "../lib/bitcoin";
import { fmtBtc, fmtDuration, fmtPct, fmtPremium, fmtSats, fmtToken, fmtUsd, parseToken, usdPerBtc } from "../lib/format";
import { cancelOffer, getFeeBps, getOffer, getReputation, getTrade, takeOffer, type Offer } from "../lib/stellar";
import { AccountLink, ActionButton, Badge, Countdown, ExtLink, Notice, Row, Spinner, errorText } from "./components";
import { ShareOffer } from "./Guest";
import { offerState } from "./Market";
import { ReadyGate } from "./Onboarding";
import { go, useChain, useLang, usePoll, useWallet } from "./state";

/** Satoshis owed for `amount`, rounded up exactly as the contract does. */
function satsFor(offer: Offer, amount: bigint): number {
  return Number((amount * offer.satsPerToken + offer.unit - 1n) / offer.unit);
}

export function OfferPage({ id }: { id: bigint }) {
  const { t, lang } = useLang();
  const { address } = useWallet();
  const { oracle } = useChain();
  const offer = usePoll(() => getOffer(id), 15_000, [String(id)]);
  const reputation = usePoll(async () => (offer.data ? getReputation(offer.data.maker) : null), 0, [offer.data?.maker]);
  const active = usePoll(
    async () => (offer.data?.activeTrade != null ? getTrade(offer.data.activeTrade) : null),
    15_000,
    [String(offer.data?.activeTrade)],
  );

  if (offer.error) return <Notice kind="error">{errorText(offer.error, lang)}</Notice>;
  if (!offer.data) return <Spinner />;
  const o = offer.data;
  const state = offerState(o);
  const btcAddress = scriptToAddress(o.btcScript);
  const price = usdPerBtc(o.satsPerToken);
  const isMaker = address === o.maker;
  const rep = reputation.data;

  return (
    <div className="page-grid">
      <section className="panel">
        <div className="panel-head">
          <h1>
            {t("Oferta", "Offer")} #{String(o.id)}
          </h1>
          {state === "open" && <Badge kind="open">{t("Abierta", "Open")}</Badge>}
          {state === "busy" && <Badge kind="busy">{t("Reservada", "Reserved")}</Badge>}
          {state === "closed" && <Badge kind="closed">{o.cancelled ? t("Cancelada", "Cancelled") : t("Agotada", "Sold out")}</Badge>}
        </div>

        <div className="big-price">
          {fmtUsd(price)} <span className="unit">/ BTC</span>
        </div>
        <p className="muted">
          {String(o.satsPerToken)} sats {t("por cada USDC", "per USDC")}
          {oracle && (
            <>
              {" "}
              · {fmtPremium(price, oracle.usdPerBtc)} {t("frente a Reflector", "vs. Reflector")} ({fmtUsd(oracle.usdPerBtc)})
            </>
          )}
        </p>

        {state === "open" && <ShareOffer offer={o} />}

        <dl className="facts">
          <Row label={t("Disponible", "Available")}>{fmtToken(o.remaining)} USDC</Row>
          <Row label={t("Vendido", "Sold")}>{fmtToken(o.filled)} USDC</Row>
          <Row label={t("Compra mínima", "Minimum fill")}>{fmtToken(o.minFill)} USDC</Row>
          <Row label={t("Confirmaciones BTC", "BTC confirmations")}>{o.minConfirmations}</Row>
          <Row label={t("Ventana para pagar", "Time to pay")}>{fmtDuration(o.windowSecs)}</Row>
          <Row label={t("Bono del comprador", "Buyer bond")}>{fmtPct(o.bondBps)}</Row>
          <Row label={t("Vendedor", "Seller")}>
            <AccountLink address={o.maker} />
          </Row>
          <Row label={t("Cobra en", "Gets paid at")}>
            {btcAddress ? (
              <ExtLink href={CONFIG.explorer.btcAddress(btcAddress)}>
                <span className="mono break">{btcAddress}</span>
              </ExtLink>
            ) : (
              <span className="mono break">{o.btcScript}</span>
            )}
          </Row>
          {rep && (
            <Row label={t("Reputación on-chain", "On-chain reputation")}>
              {rep.settledAsMaker} {rep.settledAsMaker === 1 ? t("venta", "sale") : t("ventas", "sales")} · {rep.settledAsTaker}{" "}
              {rep.settledAsTaker === 1 ? t("compra", "buy") : t("compras", "buys")} · {fmtToken(rep.volume)} USDC
              {rep.expiredAsTaker > 0 && (
                <>
                  {" "}
                  · {rep.expiredAsTaker} {t("reservas vencidas", "lapsed reservations")}
                </>
              )}
            </Row>
          )}
        </dl>

        {isMaker && !o.cancelled && (
          <div className="maker-tools">
            <ActionButton kind="danger" onRun={() => cancelOffer(address!, o.id).then(offer.reload)}>
              {t("Cancelar oferta y retirar", "Cancel offer and withdraw")} {fmtToken(o.remaining)} USDC
            </ActionButton>
            <p className="muted small">
              {t(
                "Una reserva abierta sigue siendo válida: su comprador aún puede liquidar.",
                "An open reservation stays valid: its buyer can still settle.",
              )}
            </p>
          </div>
        )}
      </section>

      <section className="panel">
        {state === "busy" && active.data && (
          <>
            <h2>{t("Reservada por otro comprador", "Reserved by another buyer")}</h2>
            <p>
              {t("Trade", "Trade")} <a href={`#/trade/${active.data.id}`}>#{String(active.data.id)}</a>{" "}
              {t("tiene la oferta por", "holds the offer for")} <Countdown deadline={active.data.deadline} />.
            </p>
            <p className="muted small">
              {t(
                "Un pago en Bitcoin solo puede ser para el trade que tiene la reserva. Cuando vence, cualquiera puede reservar de nuevo y el bono del comprador va al vendedor.",
                "A Bitcoin payment can only be for the trade holding the reservation. When it lapses anyone can reserve again, and the buyer's bond goes to the seller.",
              )}
            </p>
          </>
        )}
        {state === "closed" && <Notice>{t("Esta oferta ya no acepta compras.", "This offer no longer accepts buys.")}</Notice>}
        {state === "open" && !isMaker && <TakePanel offer={o} />}
        {state === "open" && isMaker && (
          <Notice>{t("Esta es tu oferta. Compártela con compradores.", "This is your offer. Share it with buyers.")}</Notice>
        )}
      </section>
    </div>
  );
}

function TakePanel({ offer }: { offer: Offer }) {
  const { t } = useLang();
  const { address, refreshAccount } = useWallet();
  const fee = usePoll(getFeeBps, 0, []);
  // Start at 10 USDC, kept within the offer's limits.
  const clamp = (v: bigint) => (v < offer.minFill ? offer.minFill : v > offer.remaining ? offer.remaining : v);
  const [input, setInput] = useState(() => fmtToken(clamp(10n * offer.unit)).replace(/,/g, ""));

  const amount = parseToken(input);
  const tooSmall = amount != null && amount < offer.minFill && amount !== offer.remaining;
  const tooBig = amount != null && amount > offer.remaining;
  const valid = amount != null && amount > 0n && !tooSmall && !tooBig;
  const sats = valid ? satsFor(offer, amount) : 0;
  const bond = valid ? (amount * BigInt(offer.bondBps)) / 10_000n : 0n;
  const feeBps = fee.data ?? 0;
  const feeAmount = valid ? (amount * BigInt(feeBps)) / 10_000n : 0n;

  return (
    <>
      <h2>{t("Comprar USDC con BTC", "Buy USDC with BTC")}</h2>
      <label className="field">
        <span>{t("USDC que quieres", "USDC you want")}</span>
        <div className="input-unit">
          <input inputMode="decimal" value={input} onChange={(e) => setInput(e.target.value)} />
          <span>USDC</span>
        </div>
        <span className="field-hint">
          {t("Entre", "Between")} {fmtToken(offer.minFill)} {t("y", "and")} {fmtToken(offer.remaining)}
          <button type="button" className="link" onClick={() => setInput(fmtToken(offer.remaining).replace(/,/g, ""))}>
            {t("máximo", "max")}
          </button>
        </span>
      </label>

      {tooSmall && <Notice kind="warn">{t("Por debajo del mínimo de la oferta.", "Below the offer's minimum.")}</Notice>}
      {tooBig && <Notice kind="warn">{t("Más de lo disponible.", "More than available.")}</Notice>}

      {valid && (
        <dl className="facts summary">
          <Row label={t("Pagas en Bitcoin", "You pay on Bitcoin")}>
            <strong>{fmtSats(sats)} sats</strong> <span className="muted">({fmtBtc(sats)} BTC)</span>
          </Row>
          <Row label={t("Bono ahora (se devuelve)", "Bond now (returned)")}>{fmtToken(bond)} USDC</Row>
          <Row label={t("Comisión del protocolo", "Protocol fee")}>
            {fmtToken(feeAmount)} USDC <span className="muted">({fmtPct(feeBps)})</span>
          </Row>
          <Row label={t("Recibes al liquidar", "You receive on settlement")}>
            <strong>{fmtToken(amount - feeAmount + bond)} USDC</strong>
          </Row>
        </dl>
      )}

      <ReadyGate needUsdc={bond}>
        <ActionButton
          disabled={!valid}
          onRun={async () => {
            const { tradeId } = await takeOffer(address!, offer.id, amount!);
            await refreshAccount();
            go(`/trade/${tradeId}`);
          }}
        >
          {t("Reservar y obtener instrucciones de pago", "Reserve and get payment instructions")}
        </ActionButton>
      </ReadyGate>

      <ol className="mini-steps">
        <li>
          {t(
            `Reservas ${valid ? fmtToken(amount) : "el monto"} USDC y bloqueas el bono. Tienes ${fmtDuration(offer.windowSecs)} para pagar.`,
            `You reserve ${valid ? fmtToken(amount) : "the amount"} USDC and lock the bond. You have ${fmtDuration(offer.windowSecs)} to pay.`,
          )}
        </li>
        <li>
          {t(
            `Pagas los sats a la dirección del vendedor desde cualquier wallet de signet.`,
            `You pay the sats to the seller's address from any signet wallet.`,
          )}
        </li>
        <li>
          {t(
            `Con ${offer.minConfirmations} confirmación(es), el light client de Writz lo prueba en Stellar y el escrow te libera el USDC y el bono.`,
            `After ${offer.minConfirmations} confirmation(s), the Writz light client proves it on Stellar and the escrow releases the USDC and your bond.`,
          )}
        </li>
      </ol>
    </>
  );
}
