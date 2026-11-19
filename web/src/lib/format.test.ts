import { describe, expect, it } from "vitest";
import {
  fmtBtc,
  fmtDuration,
  fmtPct,
  atMarket,
  fmtPremium,
  fmtToken,
  parseToken,
  satsPerTokenFor,
  shortAddr,
  usdPerBtc,
} from "./format";

describe("token amounts", () => {
  it("formats base units", () => {
    expect(fmtToken(100_000_000n)).toBe("10.00");
    expect(fmtToken(5_000_000n)).toBe("0.50");
    expect(fmtToken(1n)).toBe("0.0000001");
    expect(fmtToken(12_345_678_900_000n)).toBe("1,234,567.89");
    expect(fmtToken(0n)).toBe("0.00");
  });

  it("parses decimal input", () => {
    expect(parseToken("10")).toBe(100_000_000n);
    expect(parseToken(" 0.5 ")).toBe(5_000_000n);
    expect(parseToken("1,000.25")).toBe(10_002_500_000n);
    expect(parseToken("1.")).toBe(10_000_000n);
    expect(parseToken("0.0000001")).toBe(1n);
    expect(parseToken("0.00000001")).toBeNull();
    expect(parseToken("-1")).toBeNull();
    expect(parseToken("abc")).toBeNull();
    expect(parseToken("")).toBeNull();
  });

  it("round-trips", () => {
    for (const v of [1n, 10_000_000n, 123_456_789n]) {
      expect(parseToken(fmtToken(v).replace(/,/g, ""))).toBe(v);
    }
  });
});

describe("prices", () => {
  it("converts between sats per USDC and USD per BTC", () => {
    expect(Math.round(usdPerBtc(1_667n))).toBe(59_988);
    expect(satsPerTokenFor(60_000)).toBe(1_667n);
    expect(satsPerTokenFor(80_474)).toBe(1_243n);
  });

  it("shows premium against a reference", () => {
    expect(fmtPremium(82_000, 80_000)).toBe("+2.5%");
    expect(fmtPremium(60_000, 80_000)).toBe("-25.0%");
  });

  it("treats a premium that rounds to 0.0% as at market", () => {
    expect(atMarket(73_910, 73_917)).toBe(true);
    expect(atMarket(74_000, 73_917)).toBe(false);
  });

  it("formats BTC and percentages", () => {
    expect(fmtBtc(16_670)).toBe("0.0001667");
    expect(fmtBtc(100_000_000)).toBe("1");
    expect(fmtPct(200)).toBe("2%");
    expect(fmtPct(30)).toBe("0.30%");
  });
});

describe("misc", () => {
  it("shortens addresses", () => {
    expect(shortAddr("GCBEQ6B5N7PSGBOZY3EOG2Z4A3K4KAGSI2GHPV67DAL7R4FEOGLP3KIG")).toBe("GCBE…3KIG");
  });

  it("formats durations", () => {
    expect(fmtDuration(7_200)).toBe("2h 0m");
    expect(fmtDuration(125)).toBe("2m 5s");
    expect(fmtDuration(9)).toBe("9s");
    expect(fmtDuration(-5)).toBe("0s");
    expect(fmtDuration(3 * 86_400 + 3_600)).toBe("3d 1h");
  });
});
