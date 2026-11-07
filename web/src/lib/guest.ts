import { Keypair } from "@stellar/stellar-sdk";
import { TEST_NETWORK, p2wpkh, selectUTXO } from "@scure/btc-signer";
import { pubECDSA, randomPrivateKeyBytes } from "@scure/btc-signer/utils.js";
import { bytesToHex, hexToBytes } from "./bitcoin";
import { addressUtxos, broadcastTx } from "./esplora";

/**
 * Guest mode: a Stellar testnet account and a Bitcoin signet wallet that live
 * only in this browser, so anyone can try BitGate from a link without
 * installing Freighter or a Bitcoin wallet. Test networks only: the keys sit
 * in localStorage and hold nothing of value.
 */

const STELLAR_KEY = "bitgate.guest.stellar.v1";
const SIGNET_KEY = "bitgate.guest.signet.v1";
const MODE_KEY = "bitgate.wallet.mode";

/** Fee rate for guest payments, in sat/vB. Signet blocks are rarely full. */
const FEE_RATE = 2n;

function load(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function store(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Private windows can refuse storage; guest mode then lasts one page load.
  }
}

let memoryStellar: string | null = null;
let memorySignet: string | null = null;

// ── Stellar ─────────────────────────────────────────────────────────────────

/** The guest Stellar account, creating it on first use. */
export function ensureGuestStellar(): string {
  let secret = load(STELLAR_KEY) ?? memoryStellar;
  if (!secret) {
    secret = Keypair.random().secret();
    store(STELLAR_KEY, secret);
  }
  memoryStellar = secret;
  return Keypair.fromSecret(secret).publicKey();
}

/** The guest keypair, only if `address` is the guest account. */
export function guestSigner(address: string): Keypair | null {
  const secret = load(STELLAR_KEY) ?? memoryStellar;
  if (!secret) return null;
  const kp = Keypair.fromSecret(secret);
  return kp.publicKey() === address ? kp : null;
}

export type WalletMode = "freighter" | "guest";

export function savedWalletMode(): WalletMode | null {
  const m = load(MODE_KEY);
  return m === "guest" || m === "freighter" ? m : null;
}

export function saveWalletMode(mode: WalletMode | null): void {
  store(MODE_KEY, mode);
}

// ── Bitcoin signet ──────────────────────────────────────────────────────────

function signetKey(): Uint8Array {
  let keyHex = load(SIGNET_KEY) ?? memorySignet;
  if (!keyHex) {
    keyHex = bytesToHex(randomPrivateKeyBytes());
    store(SIGNET_KEY, keyHex);
  }
  memorySignet = keyHex;
  return hexToBytes(keyHex);
}

function signetPayment() {
  const key = signetKey();
  const pay = p2wpkh(pubECDSA(key, true), TEST_NETWORK);
  return { key, address: pay.address!, script: pay.script };
}

/** The guest signet address (tb1q…), creating the key on first use. */
export function guestBtcAddress(): string {
  return signetPayment().address;
}

/** Spendable sats, including unconfirmed change and deposits. */
export async function guestBtcBalance(): Promise<number> {
  const utxos = await addressUtxos(guestBtcAddress());
  return utxos.reduce((sum, u) => sum + u.value, 0);
}

/** Rough fee for a one-input, two-output P2WPKH payment, for display. */
export const GUEST_FEE_ESTIMATE = 141 * Number(FEE_RATE);

/** Pays `sats` to `to` from the guest wallet and returns the txid. */
export async function payFromGuest(to: string, sats: number): Promise<string> {
  const { key, address, script } = signetPayment();
  const utxos = await addressUtxos(address);
  const inputs = utxos.map((u) => ({
    txid: u.txid,
    index: u.vout,
    witnessUtxo: { script, amount: BigInt(u.value) },
  }));
  const selected = selectUTXO(inputs, [{ address: to, amount: BigInt(sats) }], "default", {
    changeAddress: address,
    feePerByte: FEE_RATE,
    bip69: true,
    createTx: true,
    network: TEST_NETWORK,
  });
  if (!selected || !selected.tx) throw new Error("InsufficientSignet");
  selected.tx.sign(key);
  selected.tx.finalize();
  return broadcastTx(selected.tx.hex);
}
