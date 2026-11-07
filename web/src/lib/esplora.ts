import { CONFIG } from "../config";

/** Read-only signet data from public Esplora APIs, with failover between them. */

export interface EsploraStatus {
  confirmed: boolean;
  block_height?: number;
  block_hash?: string;
  block_time?: number;
}

export interface EsploraTx {
  txid: string;
  status: EsploraStatus;
  vout: { scriptpubkey: string; value: number }[];
}

export interface EsploraMerkleProof {
  block_height: number;
  merkle: string[];
  pos: number;
}

async function get(path: string, as: "json" | "text"): Promise<unknown> {
  let lastError: unknown;
  for (const base of CONFIG.esplora) {
    try {
      const res = await fetch(base + path, { signal: AbortSignal.timeout(15_000) });
      if (res.status === 404) throw new Error(`not found: ${path}`);
      if (!res.ok) throw new Error(`${res.status} from ${base}`);
      return as === "json" ? await res.json() : await res.text();
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function tipHeight(): Promise<number> {
  return Number(await get("/blocks/tip/height", "text"));
}

/** Most recent transactions touching an address, mempool first. */
export async function addressTxs(address: string): Promise<EsploraTx[]> {
  return (await get(`/address/${address}/txs`, "json")) as EsploraTx[];
}

export async function txHex(txid: string): Promise<string> {
  return ((await get(`/tx/${txid}/hex`, "text")) as string).trim();
}

export async function txStatus(txid: string): Promise<EsploraStatus> {
  return (await get(`/tx/${txid}/status`, "json")) as EsploraStatus;
}

export async function merkleProof(txid: string): Promise<EsploraMerkleProof> {
  return (await get(`/tx/${txid}/merkle-proof`, "json")) as EsploraMerkleProof;
}

export interface EsploraUtxo {
  txid: string;
  vout: number;
  value: number;
  status: EsploraStatus;
}

/** Unspent outputs of an address, confirmed and in the mempool. */
export async function addressUtxos(address: string): Promise<EsploraUtxo[]> {
  return (await get(`/address/${address}/utxo`, "json")) as EsploraUtxo[];
}

/** Broadcasts a raw transaction and returns its txid. Tries each API in turn. */
export async function broadcastTx(rawHex: string): Promise<string> {
  let lastError: unknown;
  for (const base of CONFIG.esplora) {
    try {
      const res = await fetch(base + "/tx", { method: "POST", body: rawHex, signal: AbortSignal.timeout(20_000) });
      const text = (await res.text()).trim();
      if (!res.ok) throw new Error(`Broadcast rejected: ${text.slice(0, 160)}`);
      return text;
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
