import type { ReactNode } from "react";
import { fmtToken } from "../lib/format";
import { addUsdcTrustline, buyTestUsdc, fundWithFriendbot } from "../lib/stellar";
import { ActionButton, Notice, errorText } from "./components";
import { GuestButton } from "./Guest";
import { useLang, useWallet } from "./state";

/**
 * Renders `children` only once the connected account can hold and spend
 * `needUsdc` of test USDC, and offers the one-click fix for each missing
 * piece: wallet, testnet XLM, USDC trustline, USDC balance.
 */
export function ReadyGate({ needUsdc, children }: { needUsdc: bigint; children: ReactNode }) {
  const { t, lang } = useLang();
  const { address, account, connect, connecting, error, refreshAccount } = useWallet();

  if (!address) {
    return (
      <div className="gate">
        <p>
          {t(
            "Prueba sin instalar nada: creamos una cuenta de testnet en este navegador, con XLM y 10 USDC de prueba.",
            "Try it without installing anything: we create a testnet account in this browser, with XLM and 10 test USDC.",
          )}
        </p>
        <div className="gate-actions">
          <GuestButton />
          <button className="btn btn-ghost" onClick={connect} disabled={connecting}>
            {t("Usar Freighter", "Use Freighter")}
          </button>
        </div>
        {error && <Notice kind="error">{errorText(new Error(error), lang)}</Notice>}
      </div>
    );
  }
  if (!account) return <div className="gate muted">{t("Leyendo tu cuenta…", "Reading your account…")}</div>;

  if (!account.exists) {
    return (
      <div className="gate">
        <p>{t("Tu cuenta aún no existe en testnet.", "Your account does not exist on testnet yet.")}</p>
        <ActionButton onRun={async () => (await fundWithFriendbot(address), await refreshAccount())}>
          {t("Fondear con Friendbot", "Fund with Friendbot")}
        </ActionButton>
      </div>
    );
  }

  if (account.usdc === null) {
    return (
      <div className="gate">
        <p>{t("Agrega la trustline de USDC de Circle (testnet).", "Add the Circle USDC trustline (testnet).")}</p>
        <ActionButton onRun={async () => (await addUsdcTrustline(address), await refreshAccount())}>
          {t("Agregar trustline USDC", "Add USDC trustline")}
        </ActionButton>
      </div>
    );
  }

  if (account.usdc < needUsdc) {
    const missing = needUsdc - account.usdc;
    const buy = Math.max(10, Math.ceil(Number(missing) / 1e7) + 1);
    return (
      <div className="gate">
        <p>
          {t("Necesitas", "You need")} {fmtToken(needUsdc)} USDC, {t("tienes", "you have")} {fmtToken(account.usdc)}.
        </p>
        <ActionButton onRun={async () => (await buyTestUsdc(address, buy), await refreshAccount())}>
          {t(`Comprar ${buy} USDC de prueba con XLM`, `Buy ${buy} test USDC with XLM`)}
        </ActionButton>
        <p className="muted small">
          {t(
            "Swap en el DEX de Stellar testnet, firmado en tu wallet.",
            "A swap on the Stellar testnet DEX, signed in your wallet.",
          )}
        </p>
      </div>
    );
  }

  return <>{children}</>;
}
