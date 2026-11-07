import {
  Account,
  Address,
  Asset,
  BASE_FEE,
  Contract,
  Horizon,
  Keypair,
  Operation,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import * as freighter from "@stellar/freighter-api";
import { CONFIG } from "../config";
import { bytesToHex, hexToBytes } from "./bitcoin";
import { guestSigner } from "./guest";
import type { SorobanProofArgs } from "./proof";

const server = new rpc.Server(CONFIG.rpcUrl);
const horizon = new Horizon.Server(CONFIG.horizonUrl);
const USDC = new Asset("USDC", CONFIG.usdcIssuer);
/** Simulations need a syntactically valid source; it is never charged. */
const READER = Keypair.random().publicKey();

// ── Types returned by the BitGate escrow ────────────────────────────────────

export type TradeStatus = "Pending" | "Settled" | "Expired";

export interface Offer {
  id: bigint;
  maker: string;
  token: string;
  unit: bigint;
  btcScript: string;
  satsPerToken: bigint;
  remaining: bigint;
  minFill: bigint;
  minConfirmations: number;
  windowSecs: number;
  bondBps: number;
  activeTrade: bigint | null;
  filled: bigint;
  cancelled: boolean;
}

export interface Trade {
  id: bigint;
  offerId: bigint;
  taker: string;
  amount: bigint;
  satsDue: number;
  bond: bigint;
  btcHeightFloor: number;
  openedAt: number;
  deadline: number;
  status: TradeStatus;
  btcTxid: string | null;
  btcBlockHeight: number | null;
  satsPaid: number | null;
  fee: bigint;
}

export interface Reputation {
  settledAsMaker: number;
  settledAsTaker: number;
  expiredAsTaker: number;
  volume: bigint;
}

export interface BestTip {
  height: number;
  hash: string;
}

export interface SpvVerification {
  txid: string;
  blockHash: string;
  blockHeight: number;
  confirmations: number;
}

// ── Errors ──────────────────────────────────────────────────────────────────

/** BitGate error codes (contracts/bitgate-escrow/src/error.rs). */
export const ESCROW_ERRORS: Record<number, string> = {
  1: "OfferNotFound",
  2: "TradeNotFound",
  3: "InvalidAmount",
  4: "InvalidPrice",
  5: "InvalidScript",
  6: "InvalidConfirmations",
  7: "InvalidWindow",
  8: "InvalidBond",
  9: "InvalidFee",
  10: "BelowDust",
  11: "OfferClosed",
  12: "OfferBusy",
  13: "SelfTrade",
  14: "TradeNotPending",
  15: "TradeExpired",
  16: "TradeNotExpired",
  17: "LightClientUnavailable",
  18: "ProofRejected",
  19: "NotEnoughConfirmations",
  20: "BlockNotInLightClient",
  21: "PaymentPredatesTrade",
  22: "TxidAlreadyUsed",
  23: "OutputNotFound",
  24: "Underpaid",
  25: "Overflow",
};

/** Writz bitcoin-spv error codes a verify_transaction caller can hit. */
export const SPV_ERRORS: Record<number, string> = {
  2: "InsufficientConfirmations",
  3: "ZeroMinConfirmations",
  5: "MerkleProofInvalid",
  7: "EmptyTransaction",
  15: "AmbiguousTransactionLength",
  22: "HeaderNotFound",
  23: "NotOnBestChain",
  24: "BlockNotAfterCheckpoint",
};

/** An error with the contract's own name for it, when there is one. */
export class ContractError extends Error {
  constructor(
    readonly code: number | null,
    readonly name: string,
    readonly raw: string,
  ) {
    super(name);
  }
}

function toContractError(e: unknown, table: Record<number, string>): Error {
  const raw = e instanceof Error ? e.message : String(e);
  // A failing token transfer propagates the token contract's own error code,
  // which would collide with ours: recognise it by its diagnostic text first.
  if (/trustline entry is missing/i.test(raw)) {
    return new ContractError(null, "MissingTrustline", raw);
  }
  if (/balance is not sufficient/i.test(raw)) {
    return new ContractError(null, "InsufficientBalance", raw);
  }
  const m = raw.match(/Error\(Contract, #(\d+)\)/);
  if (m) {
    const code = Number(m[1]);
    return new ContractError(code, table[code] ?? `Error #${code}`, raw);
  }
  return e instanceof Error ? e : new Error(raw);
}

// ── Argument encoding ───────────────────────────────────────────────────────

const u32 = (v: number) => nativeToScVal(v, { type: "u32" });
const u64 = (v: bigint | number) => nativeToScVal(BigInt(v), { type: "u64" });
const i128 = (v: bigint) => nativeToScVal(v, { type: "i128" });
const addr = (v: string) => new Address(v).toScVal();
const bytes = (hex: string) => xdr.ScVal.scvBytes(hexToBytes(hex) as Buffer);

function proofArgs(p: SorobanProofArgs): xdr.ScVal[] {
  return [
    bytes(p.block_hash),
    xdr.ScVal.scvVec(p.merkle_proof.map(bytes)),
    u32(p.tx_index),
    bytes(p.raw_tx),
  ];
}

// ── Decoding ────────────────────────────────────────────────────────────────

const hex = (b: unknown): string => bytesToHex(new Uint8Array(b as ArrayBufferLike));
const tag = (v: unknown): string => (Array.isArray(v) ? String(v[0]) : String(v));

/* eslint-disable @typescript-eslint/no-explicit-any */
function toOffer(o: any): Offer {
  return {
    id: BigInt(o.id),
    maker: o.maker,
    token: o.token,
    unit: BigInt(o.unit),
    btcScript: hex(o.btc_script_pubkey),
    satsPerToken: BigInt(o.sats_per_token),
    remaining: BigInt(o.remaining),
    minFill: BigInt(o.min_fill),
    minConfirmations: Number(o.min_confirmations),
    windowSecs: Number(o.window_secs),
    bondBps: Number(o.bond_bps),
    activeTrade: o.active_trade == null ? null : BigInt(o.active_trade),
    filled: BigInt(o.filled),
    cancelled: Boolean(o.cancelled),
  };
}

function toTrade(t: any): Trade {
  return {
    id: BigInt(t.id),
    offerId: BigInt(t.offer_id),
    taker: t.taker,
    amount: BigInt(t.amount),
    satsDue: Number(t.sats_due),
    bond: BigInt(t.bond),
    btcHeightFloor: Number(t.btc_height_floor),
    openedAt: Number(t.opened_at),
    deadline: Number(t.deadline),
    status: tag(t.status) as TradeStatus,
    btcTxid: t.btc_txid == null ? null : hex(t.btc_txid),
    btcBlockHeight: t.btc_block_height == null ? null : Number(t.btc_block_height),
    satsPaid: t.sats_paid == null ? null : Number(t.sats_paid),
    fee: BigInt(t.fee),
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// ── Transport ───────────────────────────────────────────────────────────────

async function simulate(contractId: string, method: string, args: xdr.ScVal[]): Promise<unknown> {
  const tx = new TransactionBuilder(new Account(READER, "0"), {
    fee: BASE_FEE,
    networkPassphrase: CONFIG.networkPassphrase,
  })
    .addOperation(new Contract(contractId).call(method, ...args))
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(sim.error);
  return sim.result ? scValToNative(sim.result.retval) : undefined;
}

async function readEscrow(method: string, args: xdr.ScVal[] = []): Promise<unknown> {
  try {
    return await simulate(CONFIG.escrowId, method, args);
  } catch (e) {
    throw toContractError(e, ESCROW_ERRORS);
  }
}

export interface Sent {
  hash: string;
  result: unknown;
}

/**
 * Signs as `source` (in the browser for the guest account, with Freighter
 * otherwise), submits and waits for the result.
 */
async function submit(tx: ReturnType<TransactionBuilder["build"]>, source: string): Promise<Sent> {
  let final: ReturnType<TransactionBuilder["build"]> | ReturnType<typeof TransactionBuilder.fromXDR>;
  const guest = guestSigner(source);
  if (guest) {
    tx.sign(guest);
    final = tx;
  } else {
    const signed = await freighter.signTransaction(tx.toXDR(), {
      networkPassphrase: CONFIG.networkPassphrase,
      address: source,
    });
    if (signed.error) throw new Error(signed.error.message ?? "Freighter refused to sign");
    final = TransactionBuilder.fromXDR(signed.signedTxXdr, CONFIG.networkPassphrase);
  }
  const sent = await server.sendTransaction(final);
  if (sent.status === "ERROR" || sent.status === "TRY_AGAIN_LATER") {
    throw new Error(`Transaction ${sent.status.toLowerCase()}`);
  }
  const done = await server.pollTransaction(sent.hash, { attempts: 40 });
  if (done.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
    throw new Error(`Transaction failed: ${done.status}`);
  }
  return {
    hash: sent.hash,
    result: "returnValue" in done && done.returnValue ? scValToNative(done.returnValue) : undefined,
  };
}

async function invokeEscrow(source: string, method: string, args: xdr.ScVal[]): Promise<Sent> {
  try {
    const account = await server.getAccount(source);
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: CONFIG.networkPassphrase,
    })
      .addOperation(new Contract(CONFIG.escrowId).call(method, ...args))
      .setTimeout(180)
      .build();
    // Simulation first: a contract error surfaces here, before the wallet opens.
    const prepared = await server.prepareTransaction(tx);
    return await submit(prepared, source);
  } catch (e) {
    throw toContractError(e, ESCROW_ERRORS);
  }
}

// ── Escrow reads ────────────────────────────────────────────────────────────

export async function offerCount(): Promise<number> {
  return Number(await readEscrow("offer_count"));
}

export async function tradeCount(): Promise<number> {
  return Number(await readEscrow("trade_count"));
}

export async function getOffer(id: bigint | number): Promise<Offer> {
  return toOffer(await readEscrow("get_offer", [u64(id)]));
}

export async function getTrade(id: bigint | number): Promise<Trade> {
  return toTrade(await readEscrow("get_trade", [u64(id)]));
}

export async function getReputation(address: string): Promise<Reputation> {
  const r = (await readEscrow("get_reputation", [addr(address)])) as Record<string, unknown>;
  return {
    settledAsMaker: Number(r.settled_as_maker),
    settledAsTaker: Number(r.settled_as_taker),
    expiredAsTaker: Number(r.expired_as_taker),
    volume: BigInt(r.volume as bigint),
  };
}

export async function quote(offerId: bigint, amount: bigint): Promise<number> {
  return Number(await readEscrow("quote", [u64(offerId), i128(amount)]));
}

export async function getFeeBps(): Promise<number> {
  const c = (await readEscrow("get_config")) as Record<string, unknown>;
  return Number(c.fee_bps);
}

/** Every offer, newest first. Fine for a testnet market of a few hundred. */
export async function allOffers(): Promise<Offer[]> {
  const n = await offerCount();
  const ids = Array.from({ length: n }, (_, i) => n - i);
  return Promise.all(ids.map((id) => getOffer(id)));
}

export async function allTrades(): Promise<Trade[]> {
  const n = await tradeCount();
  const ids = Array.from({ length: n }, (_, i) => n - i);
  return Promise.all(ids.map((id) => getTrade(id)));
}

/** Simulates `claim`: what the escrow would answer to this proof right now. */
export async function dryRunClaim(tradeId: bigint, proof: SorobanProofArgs): Promise<void> {
  await readEscrow("claim", [u64(tradeId), ...proofArgs(proof)]);
}

// ── Escrow writes ───────────────────────────────────────────────────────────

export interface NewOffer {
  maker: string;
  amount: bigint;
  btcScript: string;
  satsPerToken: bigint;
  minFill: bigint;
  minConfirmations: number;
  windowSecs: number;
  bondBps: number;
}

export async function createOffer(o: NewOffer): Promise<{ hash: string; offerId: bigint }> {
  const sent = await invokeEscrow(o.maker, "create_offer", [
    addr(o.maker),
    addr(CONFIG.usdcId),
    i128(o.amount),
    bytes(o.btcScript),
    u64(o.satsPerToken),
    i128(o.minFill),
    u32(o.minConfirmations),
    u64(o.windowSecs),
    u32(o.bondBps),
  ]);
  return { hash: sent.hash, offerId: BigInt(sent.result as bigint) };
}

export async function takeOffer(
  taker: string,
  offerId: bigint,
  amount: bigint,
): Promise<{ hash: string; tradeId: bigint }> {
  const sent = await invokeEscrow(taker, "take", [u64(offerId), addr(taker), i128(amount)]);
  return { hash: sent.hash, tradeId: BigInt(sent.result as bigint) };
}

export async function claimTrade(source: string, tradeId: bigint, proof: SorobanProofArgs): Promise<string> {
  return (await invokeEscrow(source, "claim", [u64(tradeId), ...proofArgs(proof)])).hash;
}

export async function expireTrade(source: string, tradeId: bigint): Promise<string> {
  return (await invokeEscrow(source, "expire", [u64(tradeId)])).hash;
}

export async function cancelOffer(maker: string, offerId: bigint): Promise<string> {
  return (await invokeEscrow(maker, "cancel_offer", [u64(offerId)])).hash;
}

// ── Writz bitcoin-spv ───────────────────────────────────────────────────────

export async function bestTip(): Promise<BestTip | null> {
  const tip = (await simulate(CONFIG.spvId, "get_best_tip", [])) as
    | { height: number; hash: Uint8Array }
    | null
    | undefined;
  return tip ? { height: Number(tip.height), hash: hex(tip.hash) } : null;
}

/**
 * Asks the Writz light client itself whether a proof holds, exactly as the
 * escrow will during `claim`. Read-only.
 */
export async function verifyWithWritz(
  proof: SorobanProofArgs,
  minConfirmations: number,
): Promise<SpvVerification> {
  try {
    const r = (await simulate(CONFIG.spvId, "verify_transaction", [
      ...proofArgs(proof),
      u32(minConfirmations),
    ])) as Record<string, unknown>;
    return {
      txid: hex(r.txid),
      blockHash: hex(r.block_hash),
      blockHeight: Number(r.block_height),
      confirmations: Number(r.confirmations),
    };
  } catch (e) {
    throw toContractError(e, SPV_ERRORS);
  }
}

// ── Reflector oracle ────────────────────────────────────────────────────────

export interface OraclePrice {
  usdPerBtc: number;
  timestamp: number;
}

/**
 * BTC/USD from the Reflector oracle that Writz Lend prices collateral with.
 * BitGate does not use it on chain (makers set their own price); the app
 * shows it so a taker can see an offer's premium or discount.
 */
export async function reflectorBtcPrice(): Promise<OraclePrice | null> {
  const asset = xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Other"), xdr.ScVal.scvSymbol("BTC")]);
  const r = (await simulate(CONFIG.oracleId, "lastprice", [asset])) as
    | { price: bigint; timestamp: bigint }
    | null
    | undefined;
  if (!r) return null;
  return {
    usdPerBtc: Number(r.price / 10n ** BigInt(CONFIG.oracleDecimals - 2)) / 100,
    timestamp: Number(r.timestamp),
  };
}

// ── Wallet and USDC ─────────────────────────────────────────────────────────

export async function connectWallet(): Promise<string> {
  const connected = await freighter.isConnected();
  if (!connected.isConnected) throw new Error("FreighterMissing");
  const access = await freighter.requestAccess();
  if (access.error) throw new Error(access.error.message ?? "Access refused");
  const network = await freighter.getNetworkDetails();
  if (network.networkPassphrase !== CONFIG.networkPassphrase) throw new Error("WrongNetwork");
  return access.address;
}

export async function knownWalletAddress(): Promise<string | null> {
  try {
    const allowed = await freighter.isAllowed();
    if (!allowed.isAllowed) return null;
    const { address } = await freighter.getAddress();
    return address || null;
  } catch {
    return null;
  }
}

export interface AccountState {
  exists: boolean;
  xlm: number;
  usdc: bigint | null;
}

/** XLM balance and USDC balance, `usdc: null` when there is no trustline. */
export async function accountState(address: string): Promise<AccountState> {
  try {
    const acc = await horizon.loadAccount(address);
    let xlm = 0;
    let usdc: bigint | null = null;
    for (const b of acc.balances) {
      if (b.asset_type === "native") xlm = Number(b.balance);
      else if ("asset_code" in b && b.asset_code === "USDC" && b.asset_issuer === CONFIG.usdcIssuer) {
        usdc = BigInt(b.balance.replace(".", ""));
      }
    }
    return { exists: true, xlm, usdc };
  } catch {
    return { exists: false, xlm: 0, usdc: null };
  }
}

export async function addUsdcTrustline(address: string): Promise<string> {
  const account = await horizon.loadAccount(address);
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: CONFIG.networkPassphrase })
    .addOperation(Operation.changeTrust({ asset: USDC }))
    .setTimeout(180)
    .build();
  return (await submit(tx, address)).hash;
}

/** Buys `usdc` (whole units) with testnet XLM on the Stellar DEX. */
export async function buyTestUsdc(address: string, usdc: number): Promise<string> {
  const paths = await horizon.strictReceivePaths([Asset.native()], USDC, usdc.toFixed(7)).call();
  const best = paths.records[0];
  if (!best) throw new Error("No DEX path from XLM to USDC right now");
  const sendMax = (Number(best.source_amount) * 1.05).toFixed(7);
  const account = await horizon.loadAccount(address);
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: CONFIG.networkPassphrase })
    .addOperation(
      Operation.pathPaymentStrictReceive({
        sendAsset: Asset.native(),
        sendMax,
        destination: address,
        destAsset: USDC,
        destAmount: usdc.toFixed(7),
        path: best.path.map((p) =>
          p.asset_type === "native" ? Asset.native() : new Asset(p.asset_code, p.asset_issuer),
        ),
      }),
    )
    .setTimeout(180)
    .build();
  return (await submit(tx, address)).hash;
}

export async function fundWithFriendbot(address: string): Promise<void> {
  const res = await fetch(`https://friendbot.stellar.org/?addr=${address}`);
  if (!res.ok) throw new Error("Friendbot failed");
}
