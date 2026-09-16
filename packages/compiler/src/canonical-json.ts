import { createHash } from "node:crypto";

/**
 * Python-compatible canonical JSON.
 *
 * The IFC adapter writes every structure it publishes with
 * `json.dumps(value, ensure_ascii=False, separators=(",", ":"),
 * sort_keys=True, allow_nan=False)`. Assembling a federation in the compiler
 * (ADR-0019 slice 3b) has to reproduce those bytes exactly, so this module
 * reimplements the three places where JavaScript's own JSON differs:
 *
 * - floats: Python prints the shortest round-trip digits like JavaScript
 *   does, but switches to exponent form at different thresholds, always
 *   writes a signed two-digit exponent, and keeps `.0` on integral values;
 * - keys: Python sorts by code point where `Array.prototype.sort` compares
 *   UTF-16 code units, which disagree above U+FFFF;
 * - integral floats: `JSON.parse` collapses `1.0` into `1`, so a parse has to
 *   remember which integral numbers came from float source text.
 *
 * String escaping under `ensure_ascii=False` equals `JSON.stringify`.
 */

/** Integral numbers, by holder and key, whose source text was a float. */
export type FloatSourceTable = WeakMap<object, Set<string>>;

export class CanonicalJsonError extends Error {
  override readonly name = "CanonicalJsonError";
}

export interface ParsedCanonicalJson {
  readonly value: unknown;
  readonly floats: FloatSourceTable;
}

type SourceReviver = (
  this: unknown,
  key: string,
  value: unknown,
  context?: { readonly source?: string },
) => unknown;

// ES2022 typings predate the reviver's source-text context (V8 11.4+).
const parseWithSource = JSON.parse as (text: string, reviver: SourceReviver) => unknown;

/** Marks `key` of `holder` as an integral number that must serialize as a float. */
export function flagFloat(floats: FloatSourceTable, holder: object, key: string): void {
  let keys = floats.get(holder);
  if (keys === undefined) {
    keys = new Set();
    floats.set(holder, keys);
  }
  keys.add(key);
}

/**
 * Parses JSON while recording which integral numbers were written as floats,
 * and rejects integers JavaScript cannot hold exactly. A value this returns
 * serializes back to the parsed text through `serializeCanonicalJson`. Only
 * numbers inside an object or array are tracked; a top-level scalar has no
 * holder, and every adapter document is an object.
 */
export function parseCanonicalJson(
  text: string,
  floats: FloatSourceTable = new WeakMap(),
): ParsedCanonicalJson {
  const value = parseWithSource(text, function reviver(key, parsed, context) {
    if (typeof parsed !== "number") return parsed;
    const source = context?.source;
    if (source === undefined) {
      throw new CanonicalJsonError("JSON.parse did not expose number source text.");
    }
    if (/[.eE]/u.test(source)) {
      if (Number.isInteger(parsed) && typeof this === "object" && this !== null) {
        flagFloat(floats, this, key);
      }
    } else if (String(parsed) !== source) {
      throw new CanonicalJsonError(`Integer ${source} is not representable exactly.`);
    }
    return parsed;
  });
  return { value, floats };
}

/** Formats a finite double the way Python's `float.__repr__` does. */
export function formatPythonFloat(value: number): string {
  if (!Number.isFinite(value)) {
    throw new CanonicalJsonError("Canonical JSON cannot hold NaN or Infinity.");
  }
  if (value === 0) return Object.is(value, -0) ? "-0.0" : "0.0";
  const [mantissa = "", exponentText = "0"] = Math.abs(value).toExponential().split("e");
  const digits = mantissa.replace(".", "");
  const decimalPoint = Number(exponentText) + 1;
  let body: string;
  if (decimalPoint <= -4 || decimalPoint > 16) {
    const exponent = decimalPoint - 1;
    const magnitude = String(Math.abs(exponent)).padStart(2, "0");
    const head = digits.length === 1 ? digits : `${digits[0] ?? ""}.${digits.slice(1)}`;
    body = `${head}e${exponent < 0 ? "-" : "+"}${magnitude}`;
  } else if (decimalPoint <= 0) {
    body = `0.${"0".repeat(-decimalPoint)}${digits}`;
  } else if (decimalPoint >= digits.length) {
    body = `${digits}${"0".repeat(decimalPoint - digits.length)}.0`;
  } else {
    body = `${digits.slice(0, decimalPoint)}.${digits.slice(decimalPoint)}`;
  }
  return value < 0 ? `-${body}` : body;
}

/** Orders strings by Unicode code point, as Python's `str` comparison does. */
export function compareCodePoints(left: string, right: string): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const a = left.charCodeAt(index);
    const b = right.charCodeAt(index);
    if (a !== b) return codePointRank(a) - codePointRank(b);
  }
  return left.length - right.length;
}

// Surrogates (D800-DFFF) encode code points above every BMP unit, so they
// move above E000-FFFF; ordering within either range is unchanged.
function codePointRank(unit: number): number {
  if (unit >= 0xd800 && unit <= 0xdfff) return unit + 0x2000;
  if (unit >= 0xe000) return unit - 0x800;
  return unit;
}

const FLUSH_CHARACTERS = 1 << 20;

/**
 * Serializes `value` as Python canonical JSON, handing bounded text chunks to
 * `emit` so a real-large structure never exists as one string. Numbers are
 * integers unless flagged in `floats`; typed arrays and other non-JSON values
 * throw.
 */
export function serializeCanonicalJson(
  value: unknown,
  floats: FloatSourceTable | undefined,
  emit: (chunk: string) => void,
): void {
  const pending: string[] = [];
  let pendingLength = 0;
  const write = (text: string): void => {
    pending.push(text);
    pendingLength += text.length;
    if (pendingLength >= FLUSH_CHARACTERS) {
      emit(pending.join(""));
      pending.length = 0;
      pendingLength = 0;
    }
  };
  const visit = (node: unknown, holder: object | undefined, key: string): void => {
    switch (typeof node) {
      case "string":
        write(JSON.stringify(node));
        return;
      case "boolean":
        write(node ? "true" : "false");
        return;
      case "number":
        if (holder !== undefined && floats?.get(holder)?.has(key)) {
          write(formatPythonFloat(node));
        } else if (Number.isInteger(node)) {
          if (!Number.isSafeInteger(node)) {
            throw new CanonicalJsonError(`Integer ${String(node)} exceeds the exact range.`);
          }
          write(Object.is(node, -0) ? "0" : String(node));
        } else {
          write(formatPythonFloat(node));
        }
        return;
      case "object":
        break;
      default:
        throw new CanonicalJsonError(`Canonical JSON cannot hold a ${typeof node}.`);
    }
    if (node === null) {
      write("null");
      return;
    }
    if (ArrayBuffer.isView(node)) {
      throw new CanonicalJsonError("Canonical JSON cannot hold binary data.");
    }
    if (Array.isArray(node)) {
      write("[");
      node.forEach((item, index) => {
        if (index > 0) write(",");
        visit(item, node, String(index));
      });
      write("]");
      return;
    }
    const record = node as Record<string, unknown>;
    const keys = Object.keys(record).sort(compareCodePoints);
    write("{");
    keys.forEach((name, index) => {
      if (index > 0) write(",");
      write(`${JSON.stringify(name)}:`);
      visit(record[name], record, name);
    });
    write("}");
  };
  visit(value, undefined, "");
  if (pending.length > 0) emit(pending.join(""));
}

/** Canonical bytes of a small value; use the streaming forms for scene-sized ones. */
export function canonicalJsonBytes(value: unknown, floats?: FloatSourceTable): Buffer {
  const chunks: Buffer[] = [];
  serializeCanonicalJson(value, floats, (chunk) => chunks.push(Buffer.from(chunk, "utf8")));
  return Buffer.concat(chunks);
}

export interface CanonicalJsonDigest {
  readonly byteLength: number;
  readonly sha256: string;
}

/** Digest of the canonical bytes plus `trailer`, streamed without a full string. */
export function digestCanonicalJson(
  value: unknown,
  floats: FloatSourceTable | undefined,
  trailer = "",
): CanonicalJsonDigest {
  const hash = createHash("sha256");
  let byteLength = 0;
  const consume = (chunk: string): void => {
    const bytes = Buffer.from(chunk, "utf8");
    hash.update(bytes);
    byteLength += bytes.byteLength;
  };
  serializeCanonicalJson(value, floats, consume);
  if (trailer !== "") consume(trailer);
  return { byteLength, sha256: hash.digest("hex") };
}

/** Whether the canonical bytes of `value` are exactly `expected`. */
export function canonicalJsonEquals(
  value: unknown,
  floats: FloatSourceTable | undefined,
  expected: Uint8Array,
): boolean {
  let offset = 0;
  let matches = true;
  serializeCanonicalJson(value, floats, (chunk) => {
    if (!matches) return;
    const bytes = Buffer.from(chunk, "utf8");
    const end = offset + bytes.byteLength;
    if (end > expected.byteLength || !bytes.equals(expected.subarray(offset, end))) {
      matches = false;
      return;
    }
    offset = end;
  });
  return matches && offset === expected.byteLength;
}
