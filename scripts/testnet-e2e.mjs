// End-to-end run of the BitGate escrow on Stellar testnet with the Stellar SDK.
//
//   node testnet-e2e.mjs [btc_wallet] [maker_btc_wallet]
//
// Creates fresh accounts with Friendbot, buys test USDC on the testnet DEX and
// drives every flow of the escrow against the live Writz light client:
//
//   A. settle:  offer, take, a real signet payment, Writz relayer proof, claim
//   B. replay:  a second trade cannot reuse A's Bitcoin txid; then cancel_offer
//   C. expire:  a reservation that never pays lapses and its bond goes to the maker
//   +  rejected calls that must fail with the escrow's own error codes
//
// btc_wallet pays the BTC (default demo-taker); maker_btc_wallet receives it and
// must be fresh (default e2e-maker-20261107). Both live in .secrets/wallets.
// Secrets go to .secrets/e2e-<stamp>.json; the public report (hashes, links)
// to .secrets/e2e-report-<stamp>.json.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as bitcoin from "bitcoinjs-lib";
import {
  Address,
  Asset,
  BASE_FEE,
  Contract,
  Horizon,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";

const HERE = dirname(fileURLToPath(import.meta.url));
const SECRETS = join(HERE, "..", ".secrets");
const ESCROW = process.env.BITGATE_ESCROW ?? "CDKVJOISYM4BWV2UQKNPBZJBPK7DX3GMK2RPZNYW2LUG7GMPNEH42TVT";
const USDC_ID = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const USDC = new Asset("USDC", "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5");
const RELAYER = "https://api.testnet.writz.xyz";
const PASSPHRASE = Networks.TESTNET;

const server = new rpc.Server("https://soroban-testnet.stellar.org");
const horizon = new Horizon.Server("https://horizon-testnet.stellar.org");
const escrow = new Contract(ESCROW);

const [BTC_WALLET = "demo-taker", MAKER_BTC_WALLET = "e2e-maker-20261107"] = process.argv.slice(2);
const STAMP = new Date().toISOString().replace(/[:.]/g, "-");
const UNIT = 10_000_000n; // USDC has 7 decimals
const SATS_PER_USDC = 1250n; // $80,000 per BTC

const ERRORS = {
  3: "InvalidAmount", 7: "InvalidWindow", 10: "BelowDust", 11: "OfferClosed", 12: "OfferBusy",
  13: "SelfTrade", 14: "TradeNotPending", 15: "TradeExpired", 16: "TradeNotExpired",
  19: "NotEnoughConfirmations", 20: "BlockNotInLightClient", 21: "PaymentPredatesTrade",
  22: "TxidAlreadyUsed", 23: "OutputNotFound", 24: "Underpaid",
};

const report = { escrow: ESCROW, network: "testnet", startedAt: new Date().toISOString(), accounts: {}, steps: [], rejections: [] };
const secrets = {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const txLink = (h) => `https://stellar.expert/explorer/testnet/tx/${h}`;
const usdc = (stroops) => Number(stroops) / Number(UNIT);

function save() {
  writeFileSync(join(SECRETS, `e2e-${STAMP}.json`), JSON.stringify(secrets, null, 2), { mode: 0o600 });
  writeFileSync(join(SECRETS, `e2e-report-${STAMP}.json`), JSON.stringify(report, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
}

function step(flow, name, hash, extra = {}) {
  report.steps.push({ flow, name, hash, link: txLink(hash), ...extra });
  save();
  log(`[${flow}] ${name}`, hash);
}

// ── Arguments ───────────────────────────────────────────────────────────────

const u32 = (v) => nativeToScVal(v, { type: "u32" });
const u64 = (v) => nativeToScVal(BigInt(v), { type: "u64" });
const i128 = (v) => nativeToScVal(BigInt(v), { type: "i128" });
const addr = (v) => new Address(v).toScVal();
const bytes = (hex) => xdr.ScVal.scvBytes(Buffer.from(hex, "hex"));

function proofArgs(a) {
  return [bytes(a.block_hash), xdr.ScVal.scvVec(a.merkle_proof.map(bytes)), u32(a.tx_index), bytes(a.raw_tx)];
}

// ── Stellar ─────────────────────────────────────────────────────────────────

async function account(name) {
  const kp = Keypair.random();
  const res = await fetch(`https://friendbot.stellar.org?addr=${kp.publicKey()}`);
  if (!res.ok) throw new Error(`Friendbot failed for ${name}: ${res.status}`);
  secrets[name] = kp.secret();
  report.accounts[name] = kp.publicKey();
  step("setup", `${name}: account created and funded by Friendbot`, (await res.json()).hash);
  return kp;
}

async function classic(kp, ...ops) {
  const acct = await horizon.loadAccount(kp.publicKey());
  const tx = new TransactionBuilder(acct, { fee: BASE_FEE, networkPassphrase: PASSPHRASE }).setTimeout(60);
  ops.forEach((op) => tx.addOperation(op));
  const built = tx.build();
  built.sign(kp);
  return (await horizon.submitTransaction(built)).hash;
}

async function fundUsdc(kp, name, amount) {
  const paths = await horizon.strictReceivePaths([Asset.native()], USDC, amount).call();
  const best = paths.records[0];
  if (!best) throw new Error("No DEX path from XLM to USDC");
  const hash = await classic(
    kp,
    Operation.changeTrust({ asset: USDC }),
    Operation.pathPaymentStrictReceive({
      sendAsset: Asset.native(),
      sendMax: (Number(best.source_amount) * 1.05).toFixed(7),
      destination: kp.publicKey(),
      destAsset: USDC,
      destAmount: amount,
      path: best.path.map((p) => (p.asset_type === "native" ? Asset.native() : new Asset(p.asset_code, p.asset_issuer))),
    }),
  );
  step("setup", `${name}: USDC trustline and ${amount} USDC bought with XLM on the DEX`, hash);
}

function contractError(raw) {
  const m = String(raw).match(/Error\(Contract, #(\d+)\)/);
  return m ? (ERRORS[Number(m[1])] ?? `#${m[1]}`) : String(raw).slice(0, 200);
}

function build(source, fn, args) {
  return new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase: PASSPHRASE })
    .addOperation(escrow.call(fn, ...args))
    .setTimeout(60)
    .build();
}

/** Simulates, signs and sends a contract call; returns the hash and the decoded result. */
async function invoke(kp, fn, ...args) {
  const tx = build(await server.getAccount(kp.publicKey()), fn, args);
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(`${fn}: ${contractError(sim.error)}`);
  const prepared = rpc.assembleTransaction(tx, sim).build();
  prepared.sign(kp);
  const sent = await server.sendTransaction(prepared);
  if (sent.status === "ERROR") throw new Error(`send ${fn}: ${JSON.stringify(sent.errorResult)}`);
  for (let i = 0; i < 30; i++) {
    const got = await server.getTransaction(sent.hash);
    if (got.status === "SUCCESS") return { hash: sent.hash, value: got.returnValue ? scValToNative(got.returnValue) : null };
    if (got.status === "FAILED") throw new Error(`${fn} failed on chain: ${sent.hash}`);
    await sleep(2000);
  }
  throw new Error(`${fn} not confirmed: ${sent.hash}`);
}

/** Simulation only: reads, and calls that must be rejected (never sent, so they cost nothing). */
async function simulate(kp, fn, ...args) {
  const sim = await server.simulateTransaction(build(await server.getAccount(kp.publicKey()), fn, args));
  if (rpc.Api.isSimulationError(sim)) return { error: contractError(sim.error) };
  return { value: scValToNative(sim.result.retval) };
}

async function read(kp, fn, ...args) {
  const r = await simulate(kp, fn, ...args);
  if (r.error) throw new Error(`${fn}: ${r.error}`);
  return r.value;
}

async function expectReject(flow, what, expected, kp, fn, ...args) {
  const r = await simulate(kp, fn, ...args);
  const got = r.error ?? "accepted";
  report.rejections.push({ flow, what, expected, got, ok: got === expected });
  save();
  log(`[${flow}] rejected? ${what}: expected ${expected}, got ${got}`);
}

async function usdcBalance(address) {
  const acct = await horizon.loadAccount(address);
  const b = acct.balances.find((x) => x.asset_code === "USDC" && x.asset_issuer === USDC.issuer);
  return b ? b.balance : "0";
}

// ── Bitcoin ─────────────────────────────────────────────────────────────────

function wallet(cmd, ...args) {
  return execFileSync("node", [join(HERE, "signet-wallet.mjs"), cmd, ...args], { encoding: "utf8" }).trim();
}

async function waitForProof(txid, confirmations, maxMinutes = 90) {
  for (let i = 0; i < maxMinutes * 2; i++) {
    const res = await fetch(`${RELAYER}/spv-proof/${txid}?confirmations=${confirmations}`).catch(() => null);
    if (res?.ok) return (await res.json()).sorobanArgs;
    if (i % 4 === 0) log(`waiting for the Writz proof of ${txid.slice(0, 12)}... (${res ? res.status : "no answer"})`);
    await sleep(30_000);
  }
  throw new Error(`No proof for ${txid} after ${maxMinutes} min`);
}

// ── Flows ───────────────────────────────────────────────────────────────────

async function createOffer(flow, maker, script, amount, windowSecs) {
  const { hash, value } = await invoke(
    maker, "create_offer",
    addr(maker.publicKey()), addr(USDC_ID), i128(amount * UNIT), bytes(script),
    u64(SATS_PER_USDC), i128(UNIT), u32(1), u64(windowSecs), u32(500),
  );
  step(flow, `create_offer #${value}: ${amount} USDC locked at ${SATS_PER_USDC} sats/USDC, ${windowSecs / 60} min window, 5% bond`, hash, { offerId: Number(value) });
  return value;
}

async function take(flow, kp, offerId, amount) {
  const { hash, value } = await invoke(kp, "take", u64(offerId), addr(kp.publicKey()), i128(amount * UNIT));
  const trade = await read(kp, "get_trade", u64(value));
  step(flow, `take trade #${value} on offer #${offerId}: ${amount} USDC reserved, ${trade.sats_due} sats due, bond ${usdc(trade.bond)} USDC, height floor ${trade.btc_height_floor}`, hash, {
    tradeId: Number(value), satsDue: Number(trade.sats_due), heightFloor: Number(trade.btc_height_floor),
  });
  return { id: value, trade };
}

async function main() {
  const makerBtc = wallet("address", MAKER_BTC_WALLET);
  const script = Buffer.from(bitcoin.address.toOutputScript(makerBtc, bitcoin.networks.testnet)).toString("hex");
  report.makerBtcAddress = makerBtc;

  const maker = await account("maker");
  const taker = await account("taker");
  const taker2 = await account("taker2");
  await fundUsdc(maker, "maker", "15");
  await fundUsdc(taker, "taker", "1");
  await fundUsdc(taker2, "taker2", "1");
  report.config = await read(maker, "get_config");

  // Inputs the escrow must refuse before any funds move.
  await expectReject("guards", "offer whose minimum fill pays less than Bitcoin dust", "BelowDust", maker, "create_offer",
    addr(maker.publicKey()), addr(USDC_ID), i128(5n * UNIT), bytes(script), u64(100n), i128(UNIT), u32(1), u64(3600n), u32(500));
  await expectReject("guards", "offer with a 1 minute payment window", "InvalidWindow", maker, "create_offer",
    addr(maker.publicKey()), addr(USDC_ID), i128(5n * UNIT), bytes(script), u64(SATS_PER_USDC), i128(UNIT), u32(1), u64(60n), u32(500));

  // Two hours: signet blocks are irregular and the proof must land inside the window.
  const offerA = await createOffer("A settle", maker, script, 5n, 7200);
  const offerB = await createOffer("B replay", maker, script, 5n, 7200);
  const offerC = await createOffer("C expire", maker, script, 3n, 600);

  await expectReject("A settle", "maker takes their own offer", "SelfTrade", maker, "take",
    u64(offerA), addr(maker.publicKey()), i128(UNIT));
  const a = await take("A settle", taker, offerA, 2n);
  await expectReject("A settle", "second reservation while the offer is reserved", "OfferBusy", taker2, "take",
    u64(offerA), addr(taker2.publicKey()), i128(UNIT));
  // B's reservation opens before the payment exists, so only the replay guard can stop it.
  const b = await take("B replay", taker2, offerB, 1n);
  const c = await take("C expire", taker2, offerC, 1n);

  // A real Writz proof from the ideathon cannot settle a new trade.
  const old = JSON.parse(readFileSync(join(SECRETS, "proof1.json"), "utf8")).sorobanArgs;
  await expectReject("A settle", "ideathon proof, from before the light client checkpoint", "BlockNotInLightClient", taker, "claim",
    u64(a.id), ...proofArgs(old));
  await expectReject("C expire", "expire before the deadline", "TradeNotExpired", taker2, "expire", u64(c.id));

  // The real Bitcoin payment: the taker's signet wallet pays the maker's fresh address.
  const btcTxid = wallet("send", BTC_WALLET, makerBtc, String(a.trade.sats_due)).split("\n")[0];
  report.btcPayment = { txid: btcTxid, sats: Number(a.trade.sats_due), to: makerBtc, link: `https://blockstream.info/signet/tx/${btcTxid}` };
  save();
  log("[A settle] BTC paid on signet", btcTxid);

  const proof = await waitForProof(btcTxid, 1);
  const before = await usdcBalance(taker.publicKey());
  // Submitted by taker2: settlement is permissionless and still pays the trade's taker.
  const settled = await invoke(taker2, "claim", u64(a.id), ...proofArgs(proof));
  const t = await read(taker, "get_trade", u64(a.id));
  step("A settle", `claim trade #${a.id} (sent by a third party): Writz verified signet block ${t.btc_block_height}, ${t.sats_paid} sats paid, ${usdc(t.amount - t.fee + t.bond)} USDC released to the taker`, settled.hash, {
    btcBlock: Number(t.btc_block_height), fee: usdc(t.fee), takerUsdcBefore: before, takerUsdcAfter: await usdcBalance(taker.publicKey()),
  });

  await expectReject("A settle", "same trade claimed twice", "TradeNotPending", taker, "claim", u64(a.id), ...proofArgs(proof));
  await expectReject("B replay", "another open trade reuses the settled Bitcoin txid", "TxidAlreadyUsed", taker2, "claim", u64(b.id), ...proofArgs(proof));

  const cancelB = await invoke(maker, "cancel_offer", u64(offerB));
  step("B replay", `cancel_offer #${offerB}: ${usdc(cancelB.value)} USDC not reserved returned to the maker`, cancelB.hash);

  const wait = Number(c.trade.deadline) * 1000 - Date.now() + 20_000;
  if (wait > 0) {
    log(`[C expire] waiting ${Math.ceil(wait / 1000)} s for the window to lapse`);
    await sleep(wait);
  }
  const makerBefore = await usdcBalance(maker.publicKey());
  const expired = await invoke(taker, "expire", u64(c.id));
  step("C expire", `expire trade #${c.id} (sent by a third party): 1 USDC back to the offer, ${usdc(c.trade.bond)} USDC bond paid to the maker`, expired.hash, {
    makerUsdcBefore: makerBefore, makerUsdcAfter: await usdcBalance(maker.publicKey()),
  });
  const cancelC = await invoke(maker, "cancel_offer", u64(offerC));
  step("C expire", `cancel_offer #${offerC}: ${usdc(cancelC.value)} USDC returned to the maker`, cancelC.hash);
  // Leave no test offer on the public market.
  const cancelA = await invoke(maker, "cancel_offer", u64(offerA));
  step("A settle", `cancel_offer #${offerA}: ${usdc(cancelA.value)} USDC left after the partial fill returned to the maker`, cancelA.hash);

  report.reputation = {
    maker: await read(maker, "get_reputation", addr(maker.publicKey())),
    taker: await read(maker, "get_reputation", addr(taker.publicKey())),
    taker2: await read(maker, "get_reputation", addr(taker2.publicKey())),
  };
  report.finishedAt = new Date().toISOString();
  report.allRejectionsAsExpected = report.rejections.every((r) => r.ok);
  save();
  log("done:", report.allRejectionsAsExpected ? "every rejection as expected" : "SOME REJECTIONS DIFFER");
}

main().catch((e) => {
  report.error = String(e.stack ?? e);
  save();
  console.error(e);
  process.exit(1);
});
