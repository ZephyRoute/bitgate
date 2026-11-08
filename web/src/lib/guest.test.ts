import { Address, OutScript, TEST_NETWORK, Transaction } from "@scure/btc-signer";
import { Keypair } from "@stellar/stellar-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { hexToBytes } from "./bitcoin";

const broadcast = vi.fn<(hex: string) => Promise<string>>();
const utxos = vi.fn();
vi.mock("./esplora", () => ({
  addressUtxos: (a: string) => utxos(a),
  broadcastTx: (hex: string) => broadcast(hex),
}));

const { commitGuestReceive, ensureGuestStellar, guestBtcAddress, guestBtcBalance, guestReceiveAddress, guestSigner, payFromGuest } =
  await import("./guest");

// A signet address that is not the guest's, to pay to.
const MAKER = "tb1qxs8qnv50kswwe76nlmvq4rshpq6uxuyqkh9nqz";
const FUNDING_TXID = "aa".repeat(32);

beforeEach(() => {
  broadcast.mockReset().mockResolvedValue("bb".repeat(32));
  utxos.mockReset();
});

describe("guest Stellar account", () => {
  it("is created once and signs only for itself", () => {
    const a = ensureGuestStellar();
    expect(ensureGuestStellar()).toBe(a);
    expect(guestSigner(a)?.publicKey()).toBe(a);
    expect(guestSigner(Keypair.random().publicKey())).toBeNull();
  });
});

describe("guest signet wallet", () => {
  it("derives a stable native segwit signet address", () => {
    const a = guestBtcAddress();
    expect(a).toMatch(/^tb1q[0-9a-z]{38}$/);
    expect(guestBtcAddress()).toBe(a);
  });

  it("pays the exact amount, returns the change and signs", async () => {
    const own = guestBtcAddress();
    utxos.mockResolvedValue([{ txid: FUNDING_TXID, vout: 0, value: 10_000, status: { confirmed: true } }]);

    const txid = await payFromGuest(MAKER, 2_500);
    expect(txid).toBe("bb".repeat(32));

    const tx = Transaction.fromRaw(hexToBytes(broadcast.mock.calls[0][0]));
    const outs = Array.from({ length: tx.outputsLength }, (_, i) => tx.getOutput(i));
    const to = (addr: string) => OutScript.encode(Address(TEST_NETWORK).decode(addr));
    const pay = outs.find((o) => Buffer.from(o.script!).equals(Buffer.from(to(MAKER))));
    const change = outs.find((o) => Buffer.from(o.script!).equals(Buffer.from(to(own))));

    expect(pay?.amount).toBe(2_500n);
    expect(change).toBeDefined();
    const fee = 10_000n - outs.reduce((s, o) => s + o.amount!, 0n);
    expect(fee).toBeGreaterThan(100n);
    expect(fee).toBeLessThan(1_000n);
    expect(tx.getInput(0).finalScriptWitness?.length).toBe(2);
  });

  it("gives sellers a separate receive address and spends what it receives", async () => {
    const recv = guestReceiveAddress();
    expect(recv).toMatch(/^tb1q[0-9a-z]{38}$/);
    expect(recv).not.toBe(guestBtcAddress());
    expect(guestReceiveAddress()).toBe(recv);
    commitGuestReceive(recv);
    expect(guestReceiveAddress()).not.toBe(recv);

    // Only the receive address holds sats: they are counted and spendable.
    utxos.mockImplementation(async (a: string) =>
      a === recv ? [{ txid: FUNDING_TXID, vout: 1, value: 8_000, status: { confirmed: true } }] : [],
    );
    expect(await guestBtcBalance()).toBe(8_000);
    await payFromGuest(MAKER, 3_000);
    const tx = Transaction.fromRaw(hexToBytes(broadcast.mock.calls[0][0]));
    expect(tx.getInput(0).finalScriptWitness?.length).toBe(2);
  });

  it("refuses to pay more than it holds", async () => {
    const own = guestBtcAddress();
    utxos.mockImplementation(async (a: string) =>
      a === own ? [{ txid: FUNDING_TXID, vout: 0, value: 2_000, status: { confirmed: true } }] : [],
    );
    await expect(payFromGuest(MAKER, 2_500)).rejects.toThrow("InsufficientSignet");
    expect(broadcast).not.toHaveBeenCalled();
  });
});
