import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  canonicalJsonBytes,
  canonicalJsonEquals,
  compareCodePoints,
  digestCanonicalJson,
  flagFloat,
  formatPythonFloat,
  parseCanonicalJson,
} from "../src/canonical-json.js";

describe("formatPythonFloat", () => {
  // Every expectation below is the text `json.dumps` produced on CPython 3.13.
  it.each([
    [1, "1.0"],
    [-1, "-1.0"],
    [0, "0.0"],
    [-0, "-0.0"],
    [0.5, "0.5"],
    [1e16, "1e+16"],
    [1e15, "1000000000000000.0"],
    [9999999999999998, "9999999999999998.0"],
    [1e22, "1e+22"],
    [1.2345678901234568e17, "1.2345678901234568e+17"],
    [0.0001, "0.0001"],
    [0.00001, "1e-05"],
    [5e-324, "5e-324"],
    [1.5e300, "1.5e+300"],
    [0.30000000000000004, "0.30000000000000004"],
    [123.456, "123.456"],
    [-2.5e-7, "-2.5e-07"],
    [1.7976931348623157e308, "1.7976931348623157e+308"],
  ])("formats %s as %s", (value, expected) => {
    expect(formatPythonFloat(value)).toBe(expected);
  });

  it("rejects non-finite values", () => {
    expect(() => formatPythonFloat(Number.NaN)).toThrow(/NaN/u);
    expect(() => formatPythonFloat(Number.POSITIVE_INFINITY)).toThrow(/Infinity/u);
  });
});

describe("compareCodePoints", () => {
  it("orders astral code points after every BMP code point", () => {
    const keys = ["\u{1F600}", "￿", "", "a", "퟿", ""];
    expect([...keys].sort(compareCodePoints)).toEqual([
      "",
      "a",
      "퟿",
      "",
      "￿",
      "\u{1F600}",
    ]);
    expect([...keys].sort()).not.toEqual([...keys].sort(compareCodePoints));
  });

  it("orders a prefix before its extension", () => {
    expect(compareCodePoints("ab", "abc")).toBeLessThan(0);
    expect(compareCodePoints("abc", "ab")).toBeGreaterThan(0);
    expect(compareCodePoints("abc", "abc")).toBe(0);
  });
});

describe("parseCanonicalJson", () => {
  it("remembers which integral numbers were written as floats", () => {
    const text = '{"a":1.0,"b":1,"c":[2.0,2,-0.0,1e3],"d":{"e":10.5}}';
    const { value, floats } = parseCanonicalJson(text);
    const record = value as { a: number; c: number[]; d: object };
    expect(record.a).toBe(1);
    expect(floats.get(record)?.has("a")).toBe(true);
    expect(floats.get(record)?.has("b")).toBeFalsy();
    expect([...(floats.get(record.c) ?? [])].sort()).toEqual(["0", "2", "3"]);
    expect(floats.get(record.d)).toBeUndefined();
    expect(canonicalJsonBytes(value, floats).toString("utf8")).toBe(
      '{"a":1.0,"b":1,"c":[2.0,2,-0.0,1000.0],"d":{"e":10.5}}',
    );
  });

  it("rejects integers JavaScript cannot hold exactly", () => {
    expect(() => parseCanonicalJson("[9007199254740993]")).toThrow(/not representable/u);
    expect(() => parseCanonicalJson("[123456789012345678901234567890]")).toThrow(
      /not representable/u,
    );
    expect(() => parseCanonicalJson("[9007199254740991]")).not.toThrow();
  });
});

describe("canonicalJsonBytes", () => {
  it("sorts keys by code point and uses compact separators", () => {
    const value = { "\u{1F600}": 1, "￿": 2, b: [true, null, "xé\n"], a: {} };
    expect(canonicalJsonBytes(value).toString("utf8")).toBe(
      '{"a":{},"b":[true,null,"xé\\n"],"￿":2,"\u{1F600}":1}',
    );
  });

  it("formats hand-flagged floats and refuses non-JSON values", () => {
    const value = { scale: 1, origin: [0, 0, 0], ratio: 0.25 };
    const floats = new WeakMap<object, Set<string>>();
    flagFloat(floats, value, "scale");
    flagFloat(floats, value.origin, "1");
    expect(canonicalJsonBytes(value, floats).toString("utf8")).toBe(
      '{"origin":[0,0.0,0],"ratio":0.25,"scale":1.0}',
    );
    expect(() => canonicalJsonBytes({ bytes: new Uint8Array(2) })).toThrow(/binary/u);
    expect(() => canonicalJsonBytes({ big: 2 ** 53 })).toThrow(/exact range/u);
    expect(() => canonicalJsonBytes({ f: () => 1 })).toThrow(/function/u);
    expect(() => canonicalJsonBytes([Number.NaN])).toThrow(/NaN/u);
  });

  it("streams a digest that matches the concatenated bytes plus the trailer", () => {
    const value = { rows: Array.from({ length: 50_000 }, (_, index) => ({ index, ok: true })) };
    const bytes = canonicalJsonBytes(value);
    const digest = digestCanonicalJson(value, undefined, "\n");
    expect(digest.byteLength).toBe(bytes.byteLength + 1);
    expect(digest.sha256).toBe(
      createHash("sha256").update(bytes).update("\n").digest("hex"),
    );
    expect(canonicalJsonEquals(value, undefined, bytes)).toBe(true);
    expect(canonicalJsonEquals(value, undefined, bytes.subarray(0, -1))).toBe(false);
    expect(canonicalJsonEquals(value, undefined, Buffer.concat([bytes, Buffer.from(" ")]))).toBe(
      false,
    );
  });
});

function resolvePython(): string | undefined {
  const candidates = [process.env.NARU_IFC_PYTHON, "python3", "python"].filter(
    (candidate): candidate is string => typeof candidate === "string" && candidate !== "",
  );
  for (const candidate of candidates) {
    try {
      const version = execFileSync(candidate, ["--version"], { encoding: "utf8" });
      if (/^Python 3\./u.test(version.trim())) return candidate;
    } catch {
      // Not on this machine; try the next spelling.
    }
  }
  return undefined;
}

const python = resolvePython();

const pythonCanonicalizer = [
  "import json, sys",
  "for line in sys.stdin:",
  "    value = json.loads(line)",
  "    sys.stdout.write(json.dumps(value, ensure_ascii=False, separators=(',', ':'), sort_keys=True, allow_nan=False) + '\\n')",
].join("\n");

// A small deterministic generator so a failure reproduces from its seed.
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomDouble(random: () => number): number {
  const view = new DataView(new ArrayBuffer(8));
  for (;;) {
    view.setUint32(0, Math.floor(random() * 4294967296));
    view.setUint32(4, Math.floor(random() * 4294967296));
    const value = view.getFloat64(0);
    if (Number.isFinite(value)) return value;
  }
}

function randomNumberText(random: () => number): string {
  const choice = random();
  if (choice < 0.3) {
    const magnitude = Math.floor(random() * 2 ** 53);
    return String(random() < 0.5 ? -magnitude : magnitude);
  }
  let value: number;
  if (choice < 0.5) {
    value = randomDouble(random);
  } else if (choice < 0.7) {
    value = Math.floor(random() * 1e6) * 10 ** Math.floor(random() * 30 - 12);
  } else if (choice < 0.85) {
    value = Math.floor(random() * 1e18) / 10 ** Math.floor(random() * 6);
  } else {
    value = random() < 0.5 ? 0 : -0;
  }
  const text = Object.is(value, -0) ? "-0" : String(value);
  return /[.eE]/u.test(text) ? text : `${text}.0`;
}

const alphabet = ["a", "z", "A", "0", " ", "é", "퟿", "", "￿", "\u{1F600}", "\\", '"', "\n"];

function randomString(random: () => number): string {
  const length = Math.floor(random() * 6);
  let text = "";
  for (let index = 0; index < length; index += 1) {
    text += alphabet[Math.floor(random() * alphabet.length)] ?? "";
  }
  return text;
}

function randomJsonText(random: () => number, depth: number): string {
  const choice = random();
  if (depth === 0 || choice < 0.35) return randomNumberText(random);
  if (choice < 0.5) return JSON.stringify(randomString(random));
  if (choice < 0.6) return ["true", "false", "null"][Math.floor(random() * 3)] ?? "null";
  const size = Math.floor(random() * 5);
  if (choice < 0.8) {
    return `[${Array.from({ length: size }, () => randomJsonText(random, depth - 1)).join(",")}]`;
  }
  const entries = new Map<string, string>();
  for (let index = 0; index < size; index += 1) {
    entries.set(randomString(random), randomJsonText(random, depth - 1));
  }
  return `{${[...entries].map(([key, value]) => `${JSON.stringify(key)}:${value}`).join(",")}}`;
}

describe.skipIf(python === undefined)("canonical JSON versus CPython json.dumps", () => {
  it("serializes fuzzed documents to the bytes Python writes", () => {
    const random = mulberry32(0x3b2);
    // Every adapter document is an object, and a top-level scalar has no
    // holder for the float table, so each case is wrapped in an array.
    const inputs = Array.from({ length: 600 }, () => `[${randomJsonText(random, 4)}]`);
    const expected = execFileSync(python ?? "python", ["-c", pythonCanonicalizer], {
      input: `${inputs.join("\n")}\n`,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, PYTHONUTF8: "1" },
    }).split(/\r?\n/u);
    expected.pop();
    expect(expected).toHaveLength(inputs.length);
    inputs.forEach((input, index) => {
      const label = `case ${String(index)}: ${input}`;
      let actual: string;
      try {
        const { value, floats } = parseCanonicalJson(input);
        actual = canonicalJsonBytes(value, floats).toString("utf8");
      } catch (error) {
        throw new Error(`${label}: ${String(error)}`, { cause: error });
      }
      expect(actual, label).toBe(expected[index]);
    });
  });
});
