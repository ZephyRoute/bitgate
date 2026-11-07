import { CONFIG } from "../config";
import { fmtPct, fmtPremium, fmtToken, fmtUsd, usdPerBtc } from "../lib/format";
import { allOffers, allTrades, type Offer, type Trade } from "../lib/stellar";
import { AccountLink, Badge, ExtLink, Notice, Spinner, Stat, errorText } from "./components";
import { GuestButton } from "./Guest";
import { useChain, useLang, usePoll, useWallet } from "./state";

export function offerState(o: Offer): "open" | "busy" | "closed" {
  if (o.activeTrade != null) return "busy";
  if (o.cancelled || o.remaining === 0n) return "closed";
  return "open";
}

export function TradeStatusBadge({ trade, now }: { trade: Trade; now: number }) {
  const { t } = useLang();
  if (trade.status === "Settled") return <Badge kind="ok">{t("Liquidado", "Settled")}</Badge>;
  if (trade.status === "Expired") return <Badge kind="fail">{t("Vencido", "Expired")}</Badge>;
  if (now > trade.deadline) return <Badge kind="fail">{t("Por vencer", "Lapsed")}</Badge>;
  return <Badge kind="busy">{t("Esperando BTC", "Awaiting BTC")}</Badge>;
}

export function Market() {
  const { t, lang } = useLang();
  const { address } = useWallet();
  const { oracle } = useChain();
  const offers = usePoll(allOffers, 20_000, []);
  const trades = usePoll(allTrades, 20_000, []);
  const now = Math.floor(Date.now() / 1000);

  const list = offers.data ?? [];
  const tradeList = trades.data ?? [];
  const open = list.filter((o) => offerState(o) !== "closed");
  const locked = list.reduce((sum, o) => sum + o.remaining, 0n);
  const settled = tradeList.filter((tr) => tr.status === "Settled");
  const volume = settled.reduce((sum, tr) => sum + tr.amount, 0n);
  const makerOf = new Map(list.map((o) => [o.id, o.maker]));
  const mine = address
    ? tradeList.filter((tr) => tr.taker === address || makerOf.get(tr.offerId) === address)
    : [];

  return (
    <>
      <section className="hero">
        <h1>
          {t("Cambia Bitcoin por USDC,", "Trade Bitcoin for USDC,")}{" "}
          <em>{t("sin confiar en nadie.", "without trusting anyone.")}</em>
        </h1>
        <p className="lede">
          {t(
            "El vendedor bloquea USDC en un contrato de Soroban. Tú pagas BTC en Bitcoin. El USDC se libera solo cuando el light client de Writz demuestra en Stellar que tu pago llegó, con las confirmaciones pactadas. Sin bridge, sin custodio, sin BTC envuelto.",
            "The seller locks USDC in a Soroban contract. You pay BTC on Bitcoin. The USDC is released only when the Writz light client proves on Stellar that your payment arrived, with the agreed confirmations. No bridge, no custodian, no wrapped BTC.",
          )}
        </p>
        {!address && (
          <p className="muted small">
            {t(
              "Pruébalo en 3 minutos sin instalar nada: creamos una cuenta de Stellar testnet y una wallet de Bitcoin signet en tu navegador.",
              "Try it in 3 minutes without installing anything: we create a Stellar testnet account and a Bitcoin signet wallet in your browser.",
            )}
          </p>
        )}
        <div className="hero-actions">
          {!address && <GuestButton />}
          <a className={`btn ${address ? "btn-primary" : "btn-secondary"}`} href="#/new">
            {t("Vender USDC por BTC", "Sell USDC for BTC")}
          </a>
          <a className="btn btn-secondary" href="#/how">
            {t("Cómo funciona", "How it works")}
          </a>
        </div>
      </section>

      <section className="stats">
        <Stat label={t("Ofertas activas", "Active offers")} value={offers.data ? open.length : "…"} />
        <Stat label={t("USDC disponible", "USDC available")} value={offers.data ? fmtToken(locked) : "…"} />
        <Stat
          label={t("Trades liquidados", "Trades settled")}
          value={trades.data ? settled.length : "…"}
          hint={trades.data ? `${fmtToken(volume)} USDC` : undefined}
        />
        <Stat
          label={t("BTC/USD (Reflector)", "BTC/USD (Reflector)")}
          value={oracle ? fmtUsd(oracle.usdPerBtc) : "…"}
          hint={t("el oráculo que usa Writz Lend", "the oracle Writz Lend reads")}
        />
      </section>

      {mine.length > 0 && (
        <section>
          <h2>{t("Tu actividad", "Your activity")}</h2>
          <TradeTable trades={mine} now={now} />
        </section>
      )}

      <section>
        <div className="section-head">
          <h2>{t("Ofertas", "Offers")}</h2>
          {offers.loading && !offers.data && <Spinner />}
        </div>
        {offers.error != null && <Notice kind="error">{errorText(offers.error, lang)}</Notice>}
        {offers.data && list.length === 0 && (
          <Notice>{t("Aún no hay ofertas. Crea la primera.", "No offers yet. Create the first one.")}</Notice>
        )}
        <div className="offer-grid">
          {list.map((o) => (
            <OfferCard key={String(o.id)} offer={o} oracleUsd={oracle?.usdPerBtc ?? null} />
          ))}
        </div>
      </section>

      {tradeList.length > 0 && (
        <section>
          <h2>{t("Trades recientes", "Recent trades")}</h2>
          <TradeTable trades={tradeList.slice(0, 12)} now={now} />
        </section>
      )}

      <section className="proof-strip">
        <div>
          <strong>{t("Contrato verificable", "Verifiable contract")}</strong>
          <ExtLink href={CONFIG.explorer.stellarContract(CONFIG.escrowId)}>
            <span className="mono">{CONFIG.escrowId.slice(0, 10)}…</span>
          </ExtLink>
        </div>
        <div>
          <strong>Writz bitcoin-spv</strong>
          <ExtLink href={CONFIG.explorer.stellarContract(CONFIG.spvId)}>
            <span className="mono">{CONFIG.spvId.slice(0, 10)}…</span>
          </ExtLink>
        </div>
        <div>
          <strong>{t("Código abierto", "Open source")}</strong>
          <ExtLink href={CONFIG.repo}>GitHub</ExtLink>
        </div>
      </section>
    </>
  );
}

function OfferCard({ offer, oracleUsd }: { offer: Offer; oracleUsd: number | null }) {
  const { t } = useLang();
  const state = offerState(offer);
  const price = usdPerBtc(offer.satsPerToken);
  return (
    <a className={`offer-card offer-${state}`} href={`#/offer/${offer.id}`}>
      <div className="offer-top">
        <span className="offer-id">#{String(offer.id)}</span>
        {state === "open" && <Badge kind="open">{t("Abierta", "Open")}</Badge>}
        {state === "busy" && <Badge kind="busy">{t("Reservada", "Reserved")}</Badge>}
        {state === "closed" && <Badge kind="closed">{offer.cancelled ? t("Cancelada", "Cancelled") : t("Agotada", "Sold out")}</Badge>}
      </div>
      <div className="offer-price">
        {fmtUsd(price)}
        <span className="unit">/ BTC</span>
      </div>
      <div className="offer-sub">
        {String(offer.satsPerToken)} sats {t("por USDC", "per USDC")}
        {oracleUsd && <span className="premium"> · {fmtPremium(price, oracleUsd)} {t("vs. mercado", "vs. market")}</span>}
      </div>
      <dl className="offer-facts">
        <div>
          <dt>{t("Disponible", "Available")}</dt>
          <dd>{fmtToken(offer.remaining)} USDC</dd>
        </div>
        <div>
          <dt>{t("Mínimo", "Minimum")}</dt>
          <dd>{fmtToken(offer.minFill)} USDC</dd>
        </div>
        <div>
          <dt>{t("Confirmaciones", "Confirmations")}</dt>
          <dd>{offer.minConfirmations}</dd>
        </div>
        <div>
          <dt>{t("Bono", "Bond")}</dt>
          <dd>{fmtPct(offer.bondBps)}</dd>
        </div>
      </dl>
      <div className="offer-maker">
        {t("Vendedor", "Seller")} <span className="mono">{offer.maker.slice(0, 4)}…{offer.maker.slice(-4)}</span>
      </div>
    </a>
  );
}

function TradeTable({ trades, now }: { trades: Trade[]; now: number }) {
  const { t } = useLang();
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Trade</th>
            <th>{t("Oferta", "Offer")}</th>
            <th>USDC</th>
            <th>BTC</th>
            <th>{t("Comprador", "Buyer")}</th>
            <th>{t("Estado", "Status")}</th>
          </tr>
        </thead>
        <tbody>
          {trades.map((tr) => (
            <tr key={String(tr.id)} onClick={() => (location.hash = `#/trade/${tr.id}`)} className="clickable">
              <td>
                <a href={`#/trade/${tr.id}`}>#{String(tr.id)}</a>
              </td>
              <td>#{String(tr.offerId)}</td>
              <td className="num">{fmtToken(tr.amount)}</td>
              <td className="num">{(tr.satsPaid ?? tr.satsDue).toLocaleString("en-US")} sats</td>
              <td>
                <AccountLink address={tr.taker} />
              </td>
              <td>
                <TradeStatusBadge trade={tr} now={now} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
