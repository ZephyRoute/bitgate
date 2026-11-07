import { Networks } from "@stellar/stellar-sdk";

/** Every network constant the app uses, in one place. Testnet and signet only. */
export const CONFIG = {
  networkPassphrase: Networks.TESTNET,
  rpcUrl: "https://soroban-testnet.stellar.org",
  horizonUrl: "https://horizon-testnet.stellar.org",

  /** BitGate escrow, deployed from contracts/bitgate-escrow. */
  escrowId: "CDKVJOISYM4BWV2UQKNPBZJBPK7DX3GMK2RPZNYW2LUG7GMPNEH42TVT",
  /** Writz bitcoin-spv light client, tracking Bitcoin signet. */
  spvId: "CBX23YKCCJMAMBMSCNP6YVKEXUIYK2CTKSR4TQ3RVBPAFYZFVCW7W4EO",
  /** Circle testnet USDC (Stellar Asset Contract), the asset Writz Lend uses. */
  usdcId: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
  usdcIssuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
  usdcDecimals: 7,
  /** Reflector BTC/USD oracle, the one Writz Lend reads (14 decimals). */
  oracleId: "CCYOZJCOPG34LLQQ7N24YXBM7LL62R7ONMZ3G6WZAAYPB5OYKOMJRN63",
  oracleDecimals: 14,

  /** Writz relayer: ready-made SPV proofs for signet transactions. */
  writzRelayer: "https://api.testnet.writz.xyz",
  /** Public signet Esplora APIs: payment detection and the proof fallback. */
  esplora: ["https://mempool.space/signet/api", "https://blockstream.info/signet/api"],

  explorer: {
    stellarTx: (hash: string) => `https://stellar.expert/explorer/testnet/tx/${hash}`,
    stellarContract: (id: string) => `https://stellar.expert/explorer/testnet/contract/${id}`,
    stellarAccount: (id: string) => `https://stellar.expert/explorer/testnet/account/${id}`,
    btcTx: (txid: string) => `https://mempool.space/signet/tx/${txid}`,
    btcAddress: (address: string) => `https://mempool.space/signet/address/${address}`,
    btcBlock: (height: number) => `https://mempool.space/signet/block/${height}`,
  },

  repo: "https://github.com/ZephyRoute/bitgate",
} as const;
