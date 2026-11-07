// Tidies the testnet escrow after an interrupted end-to-end run.
//
//   node e2e-cleanup.mjs <keys.json>
//
// Expires every pending trade whose window has lapsed (anyone may call expire)
// and cancels every open offer made by the run's maker. <keys.json> is the
// .secrets/e2e-<stamp>.json file that testnet-e2e.mjs writes. Prints only
// public data: trade and offer ids with their transaction hashes.

import { readFileSync } from "node:fs";
import {
  Account, Contract, Keypair, Networks, TransactionBuilder, nativeToScVal, rpc, scValToNative,
} from "@stellar/stellar-sdk";

const ESCROW = process.env.BITGATE_ESCROW ?? "CDKVJOISYM4BWV2UQKNPBZJBPK7DX3GMK2RPZNYW2LUG7GMPNEH42TVT";
const server = new rpc.Server("https://soroban-testnet.stellar.org");
const escrow = new Contract(ESCROW);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const u64 = (v) => nativeToScVal(BigInt(v), { type: "u64" });

const keysFile = process.argv[2];
if (!keysFile) {
  console.error("usage: node e2e-cleanup.mjs <keys.json>");
  process.exit(1);
}
const maker = Keypair.fromSecret(JSON.parse(readFileSync(keysFile, "utf8")).maker);

function build(source, fn, args) {
  return new TransactionBuilder(source, { fee: "1000000", networkPassphrase: Networks.TESTNET })
    .addOperation(escrow.call(fn, ...args))
    .setTimeout(60)
    .build();
}

async function read(fn, ...args) {
  const sim = await server.simulateTransaction(build(new Account(maker.publicKey(), "0"), fn, args));
  if (rpc.Api.isSimulationError(sim)) throw new Error(`${fn}: ${sim.error}`);
  return scValToNative(sim.result.retval);
}

async function invoke(fn, ...args) {
  const tx = build(await server.getAccount(maker.publicKey()), fn, args);
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(`${fn}: ${sim.error}`);
  const prepared = rpc.assembleTransaction(tx, sim).build();
  prepared.sign(maker);
  const sent = await server.sendTransaction(prepared);
  if (sent.status === "ERROR") throw new Error(`send ${fn}: ${JSON.stringify(sent.errorResult)}`);
  for (let i = 0; i < 30; i++) {
    const got = await server.getTransaction(sent.hash);
    if (got.status === "SUCCESS") return sent.hash;
    if (got.status === "FAILED") throw new Error(`${fn} failed on chain: ${sent.hash}`);
    await sleep(2000);
  }
  throw new Error(`${fn} not confirmed: ${sent.hash}`);
}

const now = BigInt(Math.floor(Date.now() / 1000));
const trades = Number(await read("trade_count"));
for (let id = 1; id <= trades; id++) {
  const t = await read("get_trade", u64(id));
  if (t.status[0] === "Pending" && t.deadline < now) {
    console.log(`expire trade #${id} (offer #${t.offer_id}):`, await invoke("expire", u64(id)));
  }
}

const offers = Number(await read("offer_count"));
for (let id = 1; id <= offers; id++) {
  const o = await read("get_offer", u64(id));
  if (o.maker === maker.publicKey() && !o.cancelled) {
    console.log(`cancel_offer #${id}:`, await invoke("cancel_offer", u64(id)));
  }
}
console.log("done");
