import { useMemo, useState } from "react";
import { addressToScript } from "../lib/bitcoin";
import { fmtPremium, fmtSats, fmtToken, fmtUsd, parseToken, satsPerTokenFor, usdPerBtc } from "../lib/format";
import { commitGuestReceive, guestReceiveAddress } from "../lib/guest";
import { createOffer } from "../lib/stellar";
import { ActionButton, Notice } from "./components";
import { ReadyGate } from "./Onboarding";
import { go, useChain, useLang, useWallet } from "./state";

const DUST_SATS = 546;
const WINDOWS = [
  { secs: 3_600, label: "1h" },
  { secs: 7_200, label: "2h" },
  { secs: 21_600, label: "6h" },
  { secs: 86_400, label: "24h" },
];

export function CreateOffer() {
  const { t } = useLang();
  const { address, refreshAccount } = useWallet();
  const { oracle } = useChain();

  // Prefilled with a fresh signet address held in this browser, so nobody
  // needs a Bitcoin wallet to sell. Anyone with their own can paste it instead.
  const [suggested] = useState(guestReceiveAddress);
  const [btcAddress, setBtcAddress] = useState(suggested);
  const [amountIn, setAmountIn] = useState("100");
  const [priceIn, setPriceIn] = useState("");
  const [minFillIn, setMinFillIn] = useState("5");
  const [confirmations, setConfirmations] = useState(1);
  const [windowSecs, setWindowSecs] = useState(7_200);
  const [bondBps, setBondBps] = useState(200);

  const price = Number(priceIn || (oracle ? Math.round(oracle.usdPerBtc) : NaN));
  const amount = parseToken(amountIn);
  const minFill = parseToken(minFillIn);

  const script = useMemo(() => {
    try {
      return btcAddress ? addressToScript(btcAddress) : null;
    } catch {
      return null;
    }
  }, [btcAddress]);

  const satsPerToken = Number.isFinite(price) && price > 0 ? satsPerTokenFor(price) : null;
  const minFillSats = satsPerToken && minFill ? Number((minFill * satsPerToken + 9_999_999n) / 10_000_000n) : 0;
  const problems: string[] = [];
  if (btcAddress && !script) problems.push(t("Dirección inválida: usa una de signet (tb1q… o tb1p…).", "Invalid address: use a signet one (tb1q… or tb1p…)."));
  if (amount == null || amount <= 0n) problems.push(t("Monto inválido.", "Invalid amount."));
  if (minFill == null || minFill <= 0n) problems.push(t("Mínimo inválido.", "Invalid minimum."));
  if (amount && minFill && minFill > amount) problems.push(t("El mínimo no puede superar el monto.", "The minimum cannot exceed the amount."));
  if (!satsPerToken) problems.push(t("Precio inválido.", "Invalid price."));
  if (satsPerToken && minFill && minFillSats < DUST_SATS) {
    problems.push(
      t(
        `El mínimo pagaría ${minFillSats} sats, bajo el límite de dust (546). Súbelo.`,
        `The minimum would pay ${minFillSats} sats, below the dust limit (546). Raise it.`,
      ),
    );
  }
  const ready = script && problems.length === 0;

  return (
    <div className="page-narrow">
      <h1>{t("Vender USDC por Bitcoin", "Sell USDC for Bitcoin")}</h1>
      <p className="lede">
        {t(
          "Bloqueas USDC en el escrow. Los compradores te pagan BTC directo a tu dirección y el contrato les libera el USDC solo cuando Writz prueba que el pago llegó.",
          "You lock USDC in the escrow. Buyers pay BTC straight to your address and the contract releases the USDC to them only once Writz proves the payment arrived.",
        )}
      </p>

      <div className="panel form">
        <label className="field">
          <span>{t("Tu dirección Bitcoin signet", "Your Bitcoin signet address")}</span>
          <input
            className="mono"
            placeholder="tb1q…"
            value={btcAddress}
            onChange={(e) => setBtcAddress(e.target.value.trim())}
            spellCheck={false}
          />
          <span className="field-hint">
            {btcAddress === suggested ? (
              t(
                "Ya está lista: es una dirección de prueba nueva que BitGate creó en este navegador solo para esta oferta. Los sats que te paguen quedan en tu wallet de invitado y te sirven para comprar. Si tienes tu propia wallet signet, puedes pegar tu dirección.",
                "Ready to go: a fresh test address BitGate created in this browser just for this offer. Sats you receive stay in your guest wallet and you can use them to buy. If you have your own signet wallet, you can paste your address.",
              )
            ) : (
              <>
                {t(
                  "Usa una dirección nueva solo para esta oferta: cualquier pago a ella después de una reserva cuenta para esa reserva. ",
                  "Use a fresh address only for this offer: any payment to it after a reservation counts for that reservation. ",
                )}
                <button type="button" className="link-btn" onClick={() => setBtcAddress(suggested)}>
                  {t("Usar la dirección de BitGate", "Use the BitGate address")}
                </button>
              </>
            )}
          </span>
        </label>

        <div className="field-row">
          <label className="field">
            <span>{t("USDC a vender", "USDC to sell")}</span>
            <div className="input-unit">
              <input inputMode="decimal" value={amountIn} onChange={(e) => setAmountIn(e.target.value)} />
              <span>USDC</span>
            </div>
          </label>
          <label className="field">
            <span>{t("Compra mínima", "Minimum buy")}</span>
            <div className="input-unit">
              <input inputMode="decimal" value={minFillIn} onChange={(e) => setMinFillIn(e.target.value)} />
              <span>USDC</span>
            </div>
          </label>
        </div>

        <label className="field">
          <span>{t("Precio de BTC", "BTC price")}</span>
          <div className="input-unit">
            <input
              inputMode="decimal"
              placeholder={oracle ? String(Math.round(oracle.usdPerBtc)) : "80000"}
              value={priceIn}
              onChange={(e) => setPriceIn(e.target.value.replace(/[^0-9.]/g, ""))}
            />
            <span>USD / BTC</span>
          </div>
          <span className="field-hint">
            {satsPerToken && (
              <>
                = {String(satsPerToken)} sats {t("por USDC", "per USDC")} ({fmtUsd(usdPerBtc(satsPerToken))})
              </>
            )}
            {oracle && satsPerToken && (
              <>
                {" "}
                · {fmtPremium(usdPerBtc(satsPerToken), oracle.usdPerBtc)} {t("vs. Reflector", "vs. Reflector")} ({fmtUsd(oracle.usdPerBtc)})
              </>
            )}
          </span>
        </label>

        <div className="field-row three">
          <label className="field">
            <span>{t("Confirmaciones", "Confirmations")}</span>
            <select value={confirmations} onChange={(e) => setConfirmations(Number(e.target.value))}>
              <option value={1}>1 ({t("demo", "demo")})</option>
              <option value={3}>3</option>
              <option value={6}>6 ({t("recomendado", "recommended")})</option>
            </select>
          </label>
          <label className="field">
            <span>{t("Ventana para pagar", "Time to pay")}</span>
            <select value={windowSecs} onChange={(e) => setWindowSecs(Number(e.target.value))}>
              {WINDOWS.map((w) => (
                <option key={w.secs} value={w.secs}>
                  {w.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>{t("Bono del comprador", "Buyer bond")}</span>
            <select value={bondBps} onChange={(e) => setBondBps(Number(e.target.value))}>
              <option value={0}>0%</option>
              <option value={100}>1%</option>
              <option value={200}>2%</option>
              <option value={500}>5%</option>
            </select>
          </label>
        </div>
        <p className="field-hint">
          {t(
            "Si un comprador reserva y no paga a tiempo, su bono es tuyo. Así nadie bloquea tu oferta gratis.",
            "If a buyer reserves and does not pay in time, their bond is yours. Nobody can block your offer for free.",
          )}
        </p>

        {problems.length > 0 && (btcAddress || amountIn) && (
          <Notice kind="warn">
            {problems.map((p) => (
              <div key={p}>{p}</div>
            ))}
          </Notice>
        )}

        {ready && amount && (
          <Notice kind="ok">
            {t("Un comprador de", "A buyer of")} {fmtToken(minFill!)} USDC {t("te paga", "pays you")} {fmtSats(minFillSats)} sats;{" "}
            {t("toda la oferta vale", "the whole offer is worth")} {fmtSats(Number((amount * satsPerToken! + 9_999_999n) / 10_000_000n))} sats.
          </Notice>
        )}

        <ReadyGate needUsdc={amount ?? 0n}>
          <ActionButton
            disabled={!ready}
            onRun={async () => {
              const { offerId } = await createOffer({
                maker: address!,
                amount: amount!,
                btcScript: script!,
                satsPerToken: satsPerToken!,
                minFill: minFill!,
                minConfirmations: confirmations,
                windowSecs,
                bondBps,
              });
              commitGuestReceive(btcAddress);
              await refreshAccount();
              go(`/offer/${offerId}`);
            }}
          >
            {t("Bloquear", "Lock")} {amount ? fmtToken(amount) : ""} USDC {t("y publicar", "and publish")}
          </ActionButton>
        </ReadyGate>
      </div>
    </div>
  );
}
