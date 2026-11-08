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

// Sellers get their own receive address per offer, kept apart from the spending
// key so change from a guest's own payments can never land on an offer address.
// `pending` is offered by the sell form until an offer is published with it.
const RECEIVE_KEY = "bitgate.guest.receive.v1";
interface ReceiveKeys {
  pending: string | null;
  used: string[];
}
let memoryReceive: ReceiveKeys = { pending: null, used: [] };

function receiveKeys(): ReceiveKeys {
  try {
    const raw = load(RECEIVE_KEY);
    if (raw) memoryReceive = JSON.parse(raw) as ReceiveKeys;
  } catch {
    // corrupt entry: keep what memory has
  }
  return memoryReceive;
}

function saveReceiveKeys(keys: ReceiveKeys): void {
  memoryReceive = keys;
  store(RECEIVE_KEY, JSON.stringify(keys));
}

const addressOf = (keyHex: string) => p2wpkh(pubECDSA(hexToBytes(keyHex), true), TEST_NETWORK).address!;

/** A fresh signet address held in this browser, for the seller to receive BTC at. */
export function guestReceiveAddress(): string {
  const keys = receiveKeys();
  if (!keys.pending) saveReceiveKeys({ ...keys, pending: bytesToHex(randomPrivateKeyBytes()) });
  return addressOf(memoryReceive.pending!);
}

/** Marks the pending receive address as taken by a published offer. */
export function commitGuestReceive(address: string): void {
  const keys = receiveKeys();
  if (keys.pending && addressOf(keys.pending) === address) {
    saveReceiveKeys({ pending: null, used: [...keys.used, keys.pending] });
  }
}

/** Every signet key this browser holds: the spending key first, then receive keys. */
function allSignetKeys() {
  const keys = receiveKeys();
  const extra = [...keys.used, ...(keys.pending ? [keys.pending] : [])].map((hex) => {
    const key = hexToBytes(hex);
    const pay = p2wpkh(pubECDSA(key, true), TEST_NETWORK);
    return { key, address: pay.address!, script: pay.script };
  });
  return [signetPayment(), ...extra];
}

/** Spendable sats across all guest addresses, including unconfirmed ones. */
export async function guestBtcBalance(): Promise<number> {
  const lists = await Promise.all(allSignetKeys().map((k) => addressUtxos(k.address)));
  return lists.flat().reduce((sum, u) => sum + u.value, 0);
}

/** Rough fee for a one-input, two-output P2WPKH payment, for display. */
export const GUEST_FEE_ESTIMATE = 141 * Number(FEE_RATE);

/** Pays `sats` to `to` from the guest wallet and returns the txid. */
export async function payFromGuest(to: string, sats: number): Promise<string> {
  const wallets = allSignetKeys();
  const address = wallets[0].address;
  const lists = await Promise.all(wallets.map((w) => addressUtxos(w.address)));
  const inputs = lists.flatMap((utxos, i) =>
    utxos.map((u) => ({
      txid: u.txid,
      index: u.vout,
      witnessUtxo: { script: wallets[i].script, amount: BigInt(u.value) },
    })),
  );
  const selected = selectUTXO(inputs, [{ address: to, amount: BigInt(sats) }], "default", {
    changeAddress: address,
    feePerByte: FEE_RATE,
    bip69: true,
    createTx: true,
    network: TEST_NETWORK,
  });
  if (!selected || !selected.tx) throw new Error("InsufficientSignet");
  for (const w of wallets) {
    try {
      selected.tx.sign(w.key);
    } catch {
      // this key owns none of the selected inputs
    }
  }
  selected.tx.finalize();
  return broadcastTx(selected.tx.hex);
}
