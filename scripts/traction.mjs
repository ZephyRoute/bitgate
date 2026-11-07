// Counts real use of the testnet escrow since a date, straight from the contract.
//
//   node traction.mjs [since=2026-11-06T00:00:00Z]
//
// Every trade opened since `since` is listed with its buyer and seller. Accounts
// the team controls (end-to-end test accounts found in ../.secrets, plus the
// INTERNAL list below) are labelled so they never count as outside users.
// Prints only public addresses and counts.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Account, Contract, Keypair, Networks, TransactionBuilder, nativeToScVal, rpc, scValToNative } from "@stellar/stellar-sdk";

const ESCROW = process.env.BITGATE_ESCROW ?? "CDKVJOISYM4BWV2UQKNPBZJBPK7DX3GMK2RPZNYW2LUG7GMPNEH42TVT";
const SECRETS = join(dirname(fileURLToPath(import.meta.url)), "..", ".secrets");
const since = Math.floor(new Date(process.argv[2] ?? "2026-11-06T00:00:00Z").getTime() / 1000);

// Team accounts outside .secrets: the escrow admin, the ideathon demo seller,
// and the guest account used to test guest mode on 2026-11-07.
const INTERNAL = new Map([
  ["GA6ESNWRL75LR3WXVJMBZ5UT7PRO6PZOCXEAYWXZLXG7E6IXRY3EHCEE", "admin"],
  ["GD45EESY5H3I42UD67ONPFISTUTJGNS3TRFVC7WJCEALQIEO46FFQR5A", "demo seller"],
  ["GAJN5DN7GMI4AGAIVXIYXMGVUOIZX4MTEW4PTJQYHFPK7AU3D6LF22G3", "guest-mode test"],
]);
for (const f of readdirSync(SECRETS).filter((n) => /^e2e-\d.*\.json$/.test(n))) {
  for (const [role, secret] of Object.entries(JSON.parse(readFileSync(join(SECRETS, f), "utf8")))) {
    INTERNAL.set(Keypair.fromSecret(secret).publicKey(), `e2e ${role}`);
  }
}

const server = new rpc.Server("https://soroban-testnet.stellar.org");
const escrow = new Contract(ESCROW);
const reader = new Account(Keypair.random().publicKey(), "0");
async function read(fn, ...args) {
  const tx = new TransactionBuilder(reader, { fee: "100", networkPassphrase: Networks.TESTNET })
    .addOperation(escrow.call(fn, ...args)).setTimeout(30).build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(`${fn}: ${sim.error}`);
  return scValToNative(sim.result.retval);
}
const u64 = (v) => nativeToScVal(BigInt(v), { type: "u64" });

const makers = new Map();
const tradeCount = Number(await read("trade_count"));
const rows = [];
for (let id = 1; id <= tradeCount; id++) {
  const t = await read("get_trade", u64(id));
  if (Number(t.opened_at) < since) continue;
  if (!makers.has(t.offer_id)) makers.set(t.offer_id, (await read("get_offer", u64(t.offer_id))).maker);
  rows.push({ id, status: t.status[0], usdc: Number(t.amount) / 1e7, buyer: t.taker, seller: makers.get(t.offer_id) });
}

const tag = (a) => (INTERNAL.has(a) ? `${a.slice(0, 6)}… (${INTERNAL.get(a)})` : `${a.slice(0, 6)}…`);
for (const r of rows) console.log(`trade #${r.id} ${r.status.padEnd(8)} ${r.usdc} USDC  buyer ${tag(r.buyer)}  seller ${tag(r.seller)}`);

const outside = new Set(rows.flatMap((r) => [r.buyer, r.seller]).filter((a) => !INTERNAL.has(a)));
const outsideTrades = rows.filter((r) => !INTERNAL.has(r.buyer) || !INTERNAL.has(r.seller));
const settled = (list) => list.filter((r) => r.status === "Settled");
console.log(`\nsince ${new Date(since * 1000).toISOString()}`);
console.log(`all trades: ${rows.length} (${settled(rows).length} settled)`);
console.log(`trades with an outside user: ${outsideTrades.length} (${settled(outsideTrades).length} settled)`);
console.log(`unique outside users: ${outside.size}`);
