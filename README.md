# BitGate

**Peer-to-peer Bitcoin-for-USDC escrow on Stellar, settled by a Writz `bitcoin-spv` proof.**
No bridge, no custodian, no wrapped BTC, and neither side has to send first.

[Live app](https://zephyroute.github.io/bitgate/) ·
[Escrow on stellar.expert](https://stellar.expert/explorer/testnet/contract/CDKVJOISYM4BWV2UQKNPBZJBPK7DX3GMK2RPZNYW2LUG7GMPNEH42TVT) ·
Built for the Pura Vida Ideathon 2026 (Genesis track, Writz integration bounty)

> **ES:** BitGate es un escrow P2P de Bitcoin por USDC en Stellar. El vendedor bloquea USDC en un contrato de Soroban, el comprador paga BTC en Bitcoin y el contrato libera el USDC solo cuando el light client de Writz demuestra en Stellar que el pago llegó. Sin bridge, sin custodio, sin BTC envuelto. Testnet y signet.

---

## The problem

Across Latin America people trade Bitcoin for dollars peer to peer, in chat groups and P2P marketplaces. One side always has to send first and trust the other, or both trust a platform that holds the funds. Scams and frozen accounts are the cost.

This is idea #1 on Writz's own [What to build on Writz](https://docs.writz.xyz/developers/request-for-startups) list, rated High on Stellar fit, weekend scope and business.

## How it works

```
Seller (maker)              Buyer (taker)                 Anyone
     |                           |                           |
 1. create_offer  ──USDC──►  BitGate escrow (Soroban)        |
     |                           |                           |
     |                   2. take (reserve + bond) ──►        |
     |                           |                           |
     | ◄──── 3. BTC on Bitcoin ──┘                           |
     |                                                       |
     |                         4. claim(proof) ◄─────────────┘
     |                                │
     |                                ├─► Writz bitcoin-spv.verify_transaction   (cross-contract call)
     |                                ├─► parse raw_tx: pays the seller's script >= sats due
     |                                ├─► block mined above the trade's height floor
     |                                ├─► txid never used before
     |                                └─► 5. USDC + bond ──► buyer
```

1. **The seller** locks USDC in an offer: amount, price in sats per USDC, their Bitcoin address, the confirmations they require, how long a buyer has to pay, and the bond a buyer must post.
2. **The buyer** reserves part of the offer with `take`. The escrow records the Writz light client tip as the trade's **height floor**, locks the buyer's bond, and starts the payment window.
3. **The buyer pays BTC** to the seller's address from any signet wallet (the app shows a BIP21 QR).
4. **Anyone submits the SPV proof** with `claim`: the app, the buyer, a bot. The proof comes from the Writz relayer, or is built in the browser from public Esplora data if the relayer is down.
5. **The escrow verifies and releases**: the USDC (minus a 0.3% protocol fee) and the bond go to the buyer.

If the buyer never pays, the window lapses: the USDC returns to the offer and the bond goes to the seller.

## What the contract guarantees

Every property below is enforced on chain in [`contracts/bitgate-escrow/src/lib.rs`](contracts/bitgate-escrow/src/lib.rs) and covered by a test.

| Property | How |
|---|---|
| **Inclusion and depth** | Cross-contract call to Writz `bitcoin-spv.verify_transaction` with the offer's `min_confirmations` |
| **Right recipient, right amount** | The escrow parses the proven `raw_tx` with Writz's on-chain parser (`find_output_value`) and requires an output to the seller's scriptPubKey worth at least the sats due |
| **Freshness** | `take` records `get_best_tip()` from the light client; only a payment mined above it can settle the trade, so an old payment to the same address cannot be replayed |
| **No replay** | A Bitcoin txid settles at most one trade, across all offers |
| **No free griefing** | One reservation per offer at a time, backed by a bond that goes to the seller if the buyer lets it lapse; a lapsed reservation is expired automatically by the next `take` |
| **Permissionless settlement** | `claim` needs no signature: the USDC always goes to the trade's buyer, so there is nothing to front-run |
| **Liveness** | Fees accrue in the escrow and are withdrawn separately, so a misconfigured treasury can never block a buyer's settlement (found during the live testnet run, see below) |
| **Precise errors** | Writz light client errors are mapped to BitGate's own codes (`NotEnoughConfirmations`, `BlockNotInLightClient`, `ProofRejected`), so the app tells the user exactly what to wait for |

Partial fills and on-chain reputation per address (sales, buys, lapsed reservations, volume) are built in.

## Writz integration

BitGate is built around the Writz light client; without the cross-contract call there is no product.

- **`bitcoin-spv` on testnet** (`CBX23YKCCJMAMBMSCNP6YVKEXUIYK2CTKSR4TQ3RVBPAFYZFVCW7W4EO`): `verify_transaction` on every claim, `get_best_tip` on every reservation.
- **`writz-spv-client`**: the official Soroban client crate (typed `BitcoinSpvClient`, `SPVError`, `find_output_value`), depended on from the Writz repository pinned to commit `67692a5` until it is published on crates.io.
- **Tests run against the real Writz WASM.** [`fixtures/bitcoin_spv_testnet.wasm`](contracts/bitgate-escrow/fixtures/bitcoin_spv_testnet.wasm) was fetched with `stellar contract fetch` from the original testnet contract (sha256 `bbc23a81...ba01`). Writz redeployed the light client on 2026-10-25 as `CBX23YKCCJMAMBMSCNP6YVKEXUIYK2CTKSR4TQ3RVBPAFYZFVCW7W4EO`; the escrow was repointed to it with `set_spv` on 2026-11-07 ([tx](https://stellar.expert/explorer/testnet/tx/e569de370898bf8558aac6c041469dc06b101e971a0aedd5fa2e2b26c65d03c9)), and the fixture moves to the new WASM next. The test suite seeds it with a real signet checkpoint (block 327,599), submits the real headers of blocks 327,600 and 327,601, and proves a real signet transaction. Nothing on the Bitcoin side is mocked.
- **Writz relayer** (`GET /spv-proof/:txid`) for proofs, with an **in-browser fallback** that builds the same arguments from Esplora (`web/src/lib/proof.ts`). A unit test checks the fallback produces byte-for-byte the relayer's `sorobanArgs`. This is the "manual proof submission" mode the Writz relayer design document asks frontends for.
- **Reflector oracle** (the one Writz Lend reads) shows each offer's premium or discount against the market.

## Live on testnet

| | |
|---|---|
| BitGate escrow | [`CDKVJOISYM4BWV2UQKNPBZJBPK7DX3GMK2RPZNYW2LUG7GMPNEH42TVT`](https://stellar.expert/explorer/testnet/contract/CDKVJOISYM4BWV2UQKNPBZJBPK7DX3GMK2RPZNYW2LUG7GMPNEH42TVT) |
| Writz `bitcoin-spv` | [`CBX23YKCCJMAMBMSCNP6YVKEXUIYK2CTKSR4TQ3RVBPAFYZFVCW7W4EO`](https://stellar.expert/explorer/testnet/contract/CBX23YKCCJMAMBMSCNP6YVKEXUIYK2CTKSR4TQ3RVBPAFYZFVCW7W4EO) |
| Token | Circle testnet USDC, [`CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA`](https://stellar.expert/explorer/testnet/contract/CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA) |
| Bitcoin network | Signet |

### Settlements against the real light client

Each run: a maker locks USDC, a taker reserves part of it (`take` records the light client tip as the height floor), the next signet block's coinbase pays the offer's script, and `claim` submits the Writz relayer's proof for it. The escrow's cross-contract call to `bitcoin-spv` verifies inclusion and depth, the escrow checks script, amount, freshness and replay, and releases the USDC and the bond to the taker. To exercise the full pipeline on demand, these runs point the offer at the signet miner's payout script (`00141ebf...e6de`), which every new block pays; the Bitcoin data is real and nothing is simulated.

| Run | Signet block | Bitcoin tx | Stellar settlement |
|---|---|---|---|
| Escrow v2, trade 1 | [327,813](https://mempool.space/signet/block/327813) | [`3e9e0b01...a32580`](https://mempool.space/signet/tx/3e9e0b014ba78c76917353459e673a8aec563c53254bba81b6dec2a756a32580) | [`14ac161a...f7a925`](https://stellar.expert/explorer/testnet/tx/14ac161a5651cc023346801b6d4c12e6a6ec86aa0ab02a2d3c3015e7a5f7a925) |
| Escrow v1, trade 1 | [327,811](https://mempool.space/signet/block/327811) | [`4aa22256...7505ea`](https://mempool.space/signet/tx/4aa222568eb09ba2082654144fc0ea1a541d974980195577a283206b517505ea) | [`5ed751f7...fef21f`](https://stellar.expert/explorer/testnet/tx/5ed751f79157db577045cd53b93991c221478093958892bb9b1a8c4a6dfef21f) |

The v1 run is why v2 exists: its first claim attempt failed because the fee was paid straight to a treasury account with no USDC trustline, which blocked the taker's settlement. v2 accrues fees in the escrow and pays them out with `withdraw_fees`, and the v1 trade settled once the treasury had a trustline.

A demo offer with a real seller address is open on v2 (offer #2): pay it from any signet wallet, or with `scripts/signet-wallet.mjs pay-trade <wallet> <trade_id>`.

## Repository

```
contracts/bitgate-escrow/   Soroban contract (Rust, soroban-sdk 26)
  src/lib.rs                escrow: offers, reservations, claim, expiry, fees
  src/test.rs               tests against the deployed Writz WASM and real signet data
  fixtures/                 bitcoin_spv_testnet.wasm and the recorded proof
web/                        React + Vite app (Freighter, @stellar/stellar-sdk)
  src/lib/proof.ts          Writz relayer client and the Esplora fallback
  src/lib/bitcoin.ts        signet addresses, witness stripping, txid, BIP21
  src/ui/TradePage.tsx      live trade tracker: pay, confirm, prove, release
scripts/claim.sh            settle a trade from the command line
```

## Run it

Contract:

```bash
cargo test -p bitgate-escrow
cargo build --release --target wasm32v1-none -p bitgate-escrow
```

Web app (Freighter on Testnet):

```bash
cd web
npm ci
npm test
npm run dev
```

Settle a trade from the command line with the Writz relayer's proof:

```bash
scripts/claim.sh <trade_id> <btc_txid> <stellar_identity>
```

Deploy your own:

```bash
stellar contract deploy --wasm target/wasm32v1-none/release/bitgate_escrow.wasm \
  --source-account me --network testnet -- \
  --admin $(stellar keys address me) \
  --spv CBX23YKCCJMAMBMSCNP6YVKEXUIYK2CTKSR4TQ3RVBPAFYZFVCW7W4EO \
  --treasury $(stellar keys address me) --fee_bps 30
```

## Business model

A 0.3% protocol fee on each settled trade (capped at 1% by the contract), paid in USDC. Customers: P2P traders and OTC desks who today rely on chat-group trust or a custodial platform, and P2P marketplaces that want settlement without holding customer funds.

## Limits

- Testnet and signet only, not audited. The Writz light client tracks signet and is testnet only.
- Sellers should use a fresh Bitcoin address per offer: any payment to it above a reservation's height floor counts for that reservation.
- The payment must be a single output to the seller's script; split payments are not summed.

## Next

- Reverse direction: BTC sellers paid in USDC.
- Cash-out to local currency through a SEP-24 anchor.
- Validating demand for Writz's planned Dark Swap with real trades.
- Mainnet once the Writz light client is on mainnet.

## License

Apache-2.0. Uses `writz-spv-client` (Apache-2.0) from the [Writz repository](https://github.com/WritzProtocol/writz).
