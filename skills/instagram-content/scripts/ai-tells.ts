#!/usr/bin/env bun
// Ported from instagram-agent-skill (MIT, (c) 2026 Jake Schincariol), examples/instagram-agent-skill/skills/ig-human/detect.py and humanize.py
//
// ai-tells - a five-check panel that scores how machine-written a draft looks
// (`detect`, the default) and a cleaner that strips the machine fingerprint out
// of a draft (`humanize`).
//
// detect: five local heuristics - sentence-length variation, concreteness,
// stock vocabulary, typographic fingerprint, and voice. Computed on this
// machine from the text alone. It is NOT GPTZero/Originality/etc and cannot
// promise their verdict. Each check returns a HUMAN score 0-100, higher is better.
//
// humanize: three passes (invisible characters, typography, lexical slop from
// slop.json). Structural tells (rule-of-three, "not just X, it's Y", hashtag
// walls) are REPORTED, never auto-rewritten.
//
// Usage
//   npx -y bun ai-tells.ts draft.txt                      # same as: detect draft.txt
//   npx -y bun ai-tells.ts detect draft.txt --json
//   pbpaste | npx -y bun ai-tells.ts -
//   npx -y bun ai-tells.ts detect before.txt after.txt    # compare two drafts
//   npx -y bun ai-tells.ts humanize draft.txt [--report] [--json] [-o clean.txt]
//
// Exit codes (detect): 0 if the last draft is PASS (or --json), else 1.
// humanize exits 0. Bad usage exits 2.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Python-compat helpers
// ---------------------------------------------------------------------------

const PY_WS = "\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const PY_W = "\\p{L}\\p{N}_";
const PY_B = `(?:(?<=[${PY_W}])(?![${PY_W}])|(?<![${PY_W}])(?=[${PY_W}]))`;

/**
 * Translate a Python `re` pattern (str, Unicode semantics) to a JS RegExp:
 * unicode \b \w \d \s, `.` without newline, `^`/`$` with Python semantics,
 * leading (?i)/(?m) inline flags (or `multiline` forced, like re.MULTILINE),
 * and \UXXXXXXXX escapes.
 */
export function pyre(src: string, extraFlags = "", forceMultiline = false): RegExp {
  let ignoreCase = false;
  let multi = forceMultiline;
  const head = /^\(\?([a-z]+)\)/.exec(src);
  if (head) {
    ignoreCase = head[1].includes("i");
    multi = multi || head[1].includes("m");
    src = src.slice(head[0].length);
  }
  let out = "";
  let inClass = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "\\") {
      const n = src[++i];
      if (n === "b") out += inClass ? "\\x08" : PY_B;
      else if (n === "w") out += inClass ? PY_W : `[${PY_W}]`;
      else if (n === "W") out += `[^${PY_W}]`;
      else if (n === "s") out += inClass ? PY_WS : `[${PY_WS}]`;
      else if (n === "S") out += `[^${PY_WS}]`;
      else if (n === "d") out += "\\p{Nd}";
      else if (n === "D") out += "\\P{Nd}";
      else if (n === "U") {
        out += `\\u{${src.slice(i + 1, i + 9)}}`;
        i += 8;
      } else out += "\\" + n;
    } else if (inClass) {
      if (c === "]") inClass = false;
      out += c;
    } else if (c === "[") {
      inClass = true;
      out += c;
    } else if (c === ".") out += "[^\\n]";
    else if (c === "^") out += multi ? "(?<![^\\n])" : "^";
    else if (c === "$") out += multi ? "(?=\\n|(?![\\s\\S]))" : "(?=\\n?(?![\\s\\S]))";
    else out += c;
  }
  return new RegExp(out, "u" + (ignoreCase ? "i" : "") + extraFlags);
}

const WS_RE = new RegExp(`^[${PY_WS}]+|[${PY_WS}]+$`, "gu");
/** Python str.strip(). */
export function pyStrip(s: string): string {
  return s.replace(WS_RE, "");
}
const WS_SPLIT = new RegExp(`[${PY_WS}]+`, "u");
/** Python str.split() (no args). */
export function pySplit(s: string): string[] {
  return pyStrip(s).split(WS_SPLIT).filter((x) => x !== "");
}
const cpLen = (s: string): number => [...s].length;
const padEnd = (s: string, n: number): string => s + " ".repeat(Math.max(0, n - cpLen(s)));
const padStart = (s: string, n: number): string => " ".repeat(Math.max(0, n - cpLen(s))) + s;

/** Python format(x, f".{d}f"): exact decimal expansion, ties to even. */
export function fixed(x: number, d: number): string {
  const neg = x < 0 || Object.is(x, -0);
  const s = Math.abs(x).toFixed(d + 30);
  const [ip, fp] = s.split(".");
  const keep = fp.slice(0, d);
  const rest = fp.slice(d);
  let digits = BigInt(ip + keep);
  const first = rest.charCodeAt(0) - 48;
  const tail = /[1-9]/.test(rest.slice(1));
  if (first > 5 || (first === 5 && tail) || (first === 5 && !tail && digits % 2n === 1n)) digits += 1n;
  let t = digits.toString().padStart(d + 1, "0");
  if (d > 0) t = t.slice(0, t.length - d) + "." + t.slice(t.length - d);
  return (neg ? "-" : "") + t;
}
/** Python round(x, 1) for a float. */
export const round1 = (x: number): number => Number(fixed(x, 1));
/** Python round(x) for a float (banker's rounding). */
export function roundInt(x: number): number {
  const f = Math.floor(x);
  const diff = x - f;
  if (diff < 0.5) return f;
  if (diff > 0.5) return f + 1;
  return f % 2 === 0 ? f : f + 1;
}

/** json.dumps(value, indent=2, ensure_ascii=...). Keys in `floatKeys` print as Python floats (1.0, not 1). */
export function pyJson(value: unknown, ensureAscii: boolean, floatKeys: Set<string>, key = "", ind = ""): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (floatKeys.has(key) && Number.isInteger(value)) return `${value}.0`;
    return String(value);
  }
  if (typeof value === "string") {
    let s = JSON.stringify(value);
    if (ensureAscii) s = s.replace(/[\u0080-\uffff]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
    return s;
  }
  const inner = ind + "  ";
  if (Array.isArray(value)) {
    if (!value.length) return "[]";
    return "[\n" + value.map((v) => inner + pyJson(v, ensureAscii, floatKeys, key, inner)).join(",\n") + "\n" + ind + "]";
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (!entries.length) return "{}";
  return (
    "{\n" +
    entries
      .map(([k, v]) => inner + pyJson(k, ensureAscii, floatKeys) + ": " + pyJson(v, ensureAscii, floatKeys, k, inner))
      .join(",\n") +
    "\n" + ind + "}"
  );
}

// --- exact statistics.mean / statistics.pstdev -----------------------------

const bitLen = (b: bigint): number => (b === 0n ? 0 : b.toString(2).length);

function decompose(x: number): [bigint, number] {
  if (x === 0) return [0n, 0];
  const dv = new DataView(new ArrayBuffer(8));
  dv.setFloat64(0, x);
  const bits = dv.getBigUint64(0);
  const sign = bits >> 63n ? -1n : 1n;
  const exp = Number((bits >> 52n) & 0x7ffn);
  const frac = bits & ((1n << 52n) - 1n);
  return exp === 0 ? [sign * frac, -1074] : [sign * (frac | (1n << 52n)), exp - 1075];
}

function ldexp(x: number, k: number): number {
  while (k > 500) { x *= 2 ** 500; k -= 500; }
  while (k < -500) { x *= 2 ** -500; k += 500; }
  return x * 2 ** k;
}

/** Correctly rounded (num / den) * 2**pow2. */
function ratioToNumber(num: bigint, den: bigint, pow2: number): number {
  if (num === 0n) return 0;
  const neg = num < 0n;
  if (neg) num = -num;
  const s = Math.max(0, 66 - (bitLen(num) - bitLen(den)));
  let q = (num << BigInt(s)) / den;
  if ((num << BigInt(s)) % den !== 0n) q |= 1n;
  const r = ldexp(Number(q), pow2 - s);
  return neg ? -r : r;
}

/** statistics.mean for floats: exact sum, one rounding. */
export function exactMean(vals: number[]): number {
  const parts = vals.map(decompose);
  const minE = Math.min(...parts.map((p) => p[1]));
  let sum = 0n;
  for (const [m, e] of parts) sum += m << BigInt(e - minE);
  return ratioToNumber(sum, BigInt(vals.length), minE);
}

function isqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = 1n << BigInt((bitLen(n) + 1) >> 1);
  for (;;) {
    const y = (x + n / x) >> 1n;
    if (y >= x) return x;
    x = y;
  }
}
const gcd = (a: bigint, b: bigint): bigint => (b === 0n ? a : gcd(b, a % b));

/** statistics.pstdev for a list of ints (CPython's correctly rounded algorithm). */
export function pstdevInts(data: number[]): number {
  const n = BigInt(data.length);
  let s = 0n;
  let s2 = 0n;
  for (const x of data) { s += BigInt(x); s2 += BigInt(x) * BigInt(x); }
  let N = n * s2 - s * s;
  let M = n * n;
  if (N === 0n) return 0;
  const g = gcd(N, M);
  N /= g; M /= g;
  // _float_sqrt_of_frac(N, M)
  const t = bitLen(N) - bitLen(M) - 109;
  const q = Math.floor(t / 2);
  const rto = (a: bigint, b: bigint): bigint => {
    const r = isqrt(a / b);
    return r * r * b !== a ? r | 1n : r;
  };
  if (q >= 0) return Number(rto(N, M << BigInt(2 * q)) << BigInt(q));
  const numerator = rto(N << BigInt(-2 * q), M);
  return ldexp(Number(numerator), q);
}

// ---------------------------------------------------------------------------
// Lexicon
// ---------------------------------------------------------------------------

export interface WordEntry { find: string; replace: string; family: string }
export interface Lexicon {
  invisible: { cp: string; name: string; action: string }[];
  typographic: { from: string; to: string; name: string }[];
  words: WordEntry[];
  phrases: WordEntry[];
  structures: { id: string; name: string; regex: string; fix: string }[];
}

export const DEFAULT_LEXICON = fileURLToPath(new URL("./slop.json", import.meta.url));

export function loadLexicon(p: string = DEFAULT_LEXICON): Lexicon {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

/** Python: r"\b" + re.escape(find).replace(r"\ ", r"\s+") + r"\b", IGNORECASE. */
function termRe(find: string, flags = "g"): RegExp {
  const esc = find.replace(/[.^$*+?{}[\]\\|()]/g, "\\$&").replace(/ /g, "\\s+");
  return pyre("(?i)\\b" + esc + "\\b", flags);
}

function structureRe(regex: string): RegExp | null {
  try {
    return pyre(regex, "g", true);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// detect
// ---------------------------------------------------------------------------

const SENT_RE = pyre("[^.!?\\n]+[.!?]*", "g");
const WORD_RE = /[A-Za-z']+/gu;
const CONTRACTIONS = pyre("(?i)\\b\\w+'(?:s|t|re|ve|ll|d|m)\\b", "g");
const PRONOUNS = pyre("(?i)\\b(i|me|my|mine|we|us|our|you|your)\\b", "g");
const NUMBERS = pyre("\\b\\d[\\d,.]*%?\\b|\\$\\d", "g");
const PROPER = pyre("(?<![.!?]\\s)(?<!^)\\b[A-Z][a-z]{2,}\\b", "g", true);
const BULLET_RE = pyre("(?m)^\\s*[-*\\u2022]\\s+(.+)$", "g");
const CF_RE = /^\p{Cf}$/u;

export const clamp = (n: number): number => Math.max(0.0, Math.min(100.0, n));

/** Map value onto 0-100 where `human` -> 100 and `machine` -> 0. */
export function scale(value: number, human: number, machine: number): number {
  if (human === machine) return 50.0;
  return clamp(((value - machine) / (human - machine)) * 100);
}

export function sentences(text: string): string[] {
  return (text.match(SENT_RE) ?? []).map(pyStrip).filter((s) => pySplit(s).length > 2);
}
export function words(text: string): string[] {
  return text.match(WORD_RE) ?? [];
}

export type Check = [score: number, detail: string];

export function checkBurstiness(text: string): Check {
  const lens = sentences(text).map((s) => pySplit(s).length);
  if (lens.length < 4) return [50.0, "too short to judge"];
  const mean = lens.reduce((a, b) => a + b, 0) / lens.length;
  const cv = mean ? pstdevInts(lens) / mean : 0;
  const score = scale(cv, 0.7, 0.22);
  return [score, `variation ${fixed(cv, 2)} across ${lens.length} sentences (want 0.55+)`];
}

export function checkSpecificity(text: string): Check {
  const w = words(text);
  if (w.length < 25) return [50.0, "too short to judge"];
  const per100 = 100 / w.length;
  const hits = (text.match(NUMBERS) ?? []).length + new Set(text.match(PROPER) ?? []).size;
  const density = hits * per100;
  const score = scale(density, 6.0, 0.5);
  return [score, `${hits} concrete markers, ${fixed(density, 1)} per 100 words (want 4+)`];
}

export function checkSlop(text: string, lex: Lexicon): Check {
  const w = words(text);
  if (!w.length) return [50.0, "empty"];
  let hits = 0;
  const found: string[] = [];
  for (const entry of [...lex.words, ...lex.phrases]) {
    const n = (text.match(termRe(entry.find)) ?? []).length;
    if (n) {
      hits += n;
      found.push(entry.find);
    }
  }
  const density = (hits * 100) / w.length;
  const score = scale(density, 0.0, 4.0);
  let detail = `${hits} stock terms, ${fixed(density, 1)} per 100 words`;
  if (found.length) detail += " (" + [...found].sort().slice(0, 4).join(", ") + (found.length > 4 ? ", ..." : "") + ")";
  return [score, detail];
}

const countOf = (text: string, ch: string): number => text.split(ch).length - 1;

export function checkFingerprint(text: string): Check {
  let invisible = 0;
  for (const c of text) if (CF_RE.test(c)) invisible++;
  const em = countOf(text, "\u2014");
  const curly = [..."\u2018\u2019\u201c\u201d"].reduce((a, c) => a + countOf(text, c), 0);
  const ellip = countOf(text, "\u2026");
  const nbsp = [..."\xa0\u202f\u2009"].reduce((a, c) => a + countOf(text, c), 0);
  const total = invisible * 4 + em * 2 + curly + ellip + nbsp;
  const per1k = (total * 1000) / Math.max(cpLen(text), 1);
  const score = scale(per1k, 0.0, 12.0);
  return [score, `${invisible} invisible, ${em} em dash, ${curly} curly quote, ${ellip} ellipsis, ${nbsp} hard space`];
}

export function checkVoice(text: string, lex: Lexicon): Check {
  const w = words(text);
  if (w.length < 25) return [50.0, "too short to judge"];
  const per100 = 100 / w.length;
  const contractions = (text.match(CONTRACTIONS) ?? []).length * per100;
  const person = (text.match(PRONOUNS) ?? []).length * per100;
  let tells = 0;
  const names: string[] = [];
  for (const s of lex.structures) {
    const re = structureRe(s.regex);
    if (!re) continue;
    const n = (text.match(re) ?? []).length;
    if (n) {
      tells += n;
      names.push(s.id);
    }
  }
  const bullets = [...text.matchAll(BULLET_RE)].map((m) => pySplit(m[1]).length);
  const uniform = bullets.length >= 3 && pstdevInts(bullets) < 1.6;
  let score =
    scale(contractions, 3.0, 0.0) * 0.35 + scale(person, 8.0, 1.0) * 0.35 + clamp(100 - tells * 22) * 0.3;
  if (uniform) {
    score -= 12;
    names.push("uniform-bullets");
  }
  let detail =
    `${fixed(contractions, 1)} contractions, ${fixed(person, 1)} personal pronouns ` +
    `per 100 words, ${tells} structural tell(s)`;
  if (names.length) detail += " [" + names.slice(0, 4).join(", ") + "]";
  return [clamp(score), detail];
}

export const CHECKS = ["BURSTINESS", "SPECIFICITY", "SLOP DENSITY", "FINGERPRINT", "VOICE"] as const;
export type CheckName = (typeof CHECKS)[number];

export interface DetectResult {
  results: Record<CheckName, Check>;
  overall: number;
  verdict: "PASS" | "REVIEW" | "FLAGGED";
}

export function detect(text: string, lex: Lexicon): DetectResult {
  const results: Record<CheckName, Check> = {
    BURSTINESS: checkBurstiness(text),
    SPECIFICITY: checkSpecificity(text),
    "SLOP DENSITY": checkSlop(text, lex),
    FINGERPRINT: checkFingerprint(text),
    VOICE: checkVoice(text, lex),
  };
  const scores = CHECKS.map((c) => results[c][0]);
  const lo = Math.min(...scores);
  const overall = exactMean(scores) * 0.6 + lo * 0.4;
  const verdict = overall >= 70 && lo >= 55 ? "PASS" : overall >= 50 ? "REVIEW" : "FLAGGED";
  return { results, overall, verdict };
}

export interface DetectPayload {
  source: string;
  checks: Record<string, { score: number; detail: string }>;
  human_score: number;
  verdict: string;
}

/** The per-draft JSON object (scores rounded to 1 decimal, like the original). */
export function scoreDraft(text: string, lex: Lexicon, source = "-"): DetectPayload {
  const { results, overall, verdict } = detect(text, lex);
  const checks: DetectPayload["checks"] = {};
  for (const k of CHECKS) checks[k] = { score: round1(results[k][0]), detail: results[k][1] };
  return { source, checks, human_score: round1(overall), verdict };
}

export function weakestOf(results: Record<CheckName, Check>): CheckName {
  let best: CheckName = CHECKS[0];
  for (const c of CHECKS) if (results[c][0] < results[best][0]) best = c;
  return best;
}

export function bar(score: number, width = 24): string {
  const filled = roundInt((score / 100) * width);
  return "#".repeat(filled) + ".".repeat(width - filled);
}

export function renderDetect(r: DetectResult, label?: string): string {
  let o = "";
  const print = (s = "") => { o += s + "\n"; };
  const title = "AI DETECTION PANEL" + (label ? `  -  ${label}` : "");
  print("\n" + title);
  print("=".repeat(Math.max(cpLen(title), 62)));
  for (const name of CHECKS) {
    const [score, detail] = r.results[name];
    print(`  ${padEnd(name, 13)} ${bar(score)} ${padStart(fixed(score, 1), 5)}`);
    print(`  ${padEnd("", 13)} ${detail}`);
  }
  print("-".repeat(62));
  print(`  ${padEnd("HUMAN SCORE", 13)} ${bar(r.overall)} ${padStart(fixed(r.overall, 1), 5)}   ${r.verdict}`);
  if (r.verdict !== "PASS") print(`\n  Weakest signal: ${weakestOf(r.results)}. Fix that first.`);
  print("");
  return o;
}

// ---------------------------------------------------------------------------
// humanize
// ---------------------------------------------------------------------------

const URL_RE = pyre("https?://\\S+|www\\.\\S+|\\S+@\\S+\\.\\S+", "g");

export function protectUrls(text: string): [string, string[]] {
  const found: string[] = [];
  const out = text.replace(URL_RE, (m) => {
    found.push(m);
    return `\x00URL${found.length - 1}\x00`;
  });
  return [out, found];
}

export function restoreUrls(text: string, found: string[]): string {
  found.forEach((url, i) => {
    text = text.split(`\x00URL${i}\x00`).join(url);
  });
  return text;
}

/** Python regex sub with a literal replacement (no group references). */
const sub = (text: string, src: string, repl: string): string => text.replace(pyre(src, "g"), () => repl);

const cpHex = (n: number): string => n.toString(16);

export interface InvisibleHit { name: string; count: number; action: string }

export function passInvisible(text: string, lex: Lexicon): [string, InvisibleHit[]] {
  const hits: InvisibleHit[] = [];
  for (const entry of lex.invisible) {
    const spec = entry.cp;
    let pattern: RegExp;
    if (spec.includes("-")) {
      const [a, b] = spec.split("-");
      pattern = new RegExp(`[\\u{${cpHex(parseInt(a.slice(2), 16))}}-\\u{${cpHex(parseInt(b.slice(2), 16))}}]`, "gu");
    } else {
      pattern = new RegExp(`\\u{${cpHex(parseInt(spec.slice(2), 16))}}`, "gu");
    }
    const n = (text.match(pattern) ?? []).length;
    if (n) {
      hits.push({ name: entry.cp + " " + entry.name, count: n, action: entry.action });
      text = text.replace(pattern, entry.action === "delete" ? "" : " ");
    }
  }
  const chars = [...text];
  const stray = chars.filter((c) => CF_RE.test(c));
  if (stray.length) {
    hits.push({ name: "other invisible format chars", count: stray.length, action: "delete" });
    text = chars.filter((c) => !CF_RE.test(c)).join("");
  }
  return [text, hits];
}

export interface TypoHit { name: string; count: number; to: string }

export function passTypographic(text: string, lex: Lexicon): [string, TypoHit[]] {
  const hits: TypoHit[] = [];
  for (const entry of lex.typographic) {
    const ch = entry.from;
    const n = countOf(text, ch);
    if (!n) continue;
    hits.push({ name: `${ch} ${entry.name}`, count: n, to: pyStrip(entry.to) || "(space)" });
    if (ch === "\u2014") {
      text = sub(text, "\\s*\u2014\\s*", ", ");
    } else if (ch === "\u2013") {
      text = sub(text, "\\s*\u2013\\s*(?=\\d)", "-");
      text = sub(text, "\\s+\u2013\\s+", ", ");
      text = text.split("\u2013").join("-");
    } else {
      text = text.split(ch).join(entry.to);
    }
  }
  text = text.replace(pyre(",\\s*([,.;:!?])", "g"), (_m, p1: string) => p1);
  text = sub(text, ",\\s*\\n", "\n");
  return [text, hits];
}

const isUpperStr = (s: string): boolean => s === s.toUpperCase() && s !== s.toLowerCase();

export function matchCase(src: string, repl: string): string {
  if (!repl) return repl;
  if (isUpperStr(src) && cpLen(src) > 1) return repl.toUpperCase();
  const first = [...src][0];
  if (first !== first.toLowerCase()) {
    const r = [...repl];
    return r[0].toUpperCase() + r.slice(1).join("");
  }
  return repl;
}

export interface LexHit { find: string; replace: string; count: number; family: string }

export function passLexical(text: string, lex: Lexicon): [string, LexHit[]] {
  const hits: LexHit[] = [];
  const entries = [...lex.phrases, ...lex.words].sort((a, b) => cpLen(b.find) - cpLen(a.find));
  for (const entry of entries) {
    const pattern = termRe(entry.find);
    const count = (text.match(pattern) ?? []).length;
    if (!count) continue;
    hits.push({ find: entry.find, replace: entry.replace || "(deleted)", count, family: entry.family });
    text = text.replace(pattern, (m) => matchCase(m, entry.replace));
  }
  text = sub(text, "[ \\t]{2,}", " ");
  text = sub(text, "(?m)^[ \\t]*(?:[,.;:]+[ \\t]*)+", "");
  text = sub(text, "(?m)^[ \\t](?=\\S)", "");
  text = text.replace(pyre("\\s+([,.;:!?])", "g"), (_m, p1: string) => p1);
  text = text.replace(pyre(",\\s*([,.;:!?])", "g"), (_m, p1: string) => p1);
  text = text.split("...").join("\x00ELL\x00");
  text = sub(text, "\\.\\s*\\.+", ".");
  text = text.replace(pyre("([!?])\\s*\\.", "g"), (_m, p1: string) => p1);
  text = text.split("\x00ELL\x00").join("...");
  text = sub(text, "(?m)^[ \\t]+$", "");
  text = sub(text, "\\n{3,}", "\n\n");
  text = text.replace(
    pyre(",\\s*(also|so|still|basically|in the end)\\s*,\\s*", "g"),
    (_m, p1: string) => ". " + p1[0].toUpperCase() + p1.slice(1) + ", ",
  );
  return [text, hits];
}

export interface StructHit { name: string; count: number; fix: string }

export function scanStructures(text: string, lex: Lexicon): StructHit[] {
  const flags: StructHit[] = [];
  for (const s of lex.structures) {
    const re = structureRe(s.regex);
    if (!re) continue;
    const count = (text.match(re) ?? []).length;
    if (count) flags.push({ name: s.name, count, fix: s.fix });
  }
  const lens = (text.match(SENT_RE) ?? []).map((s) => pySplit(s).length).filter((n) => n > 2);
  if (lens.length >= 4) {
    const mean = lens.reduce((a, b) => a + b, 0) / lens.length;
    const variance = lens.reduce((a, n) => a + (n - mean) ** 2, 0) / lens.length;
    const cv = mean ? variance ** 0.5 / mean : 0;
    if (cv < 0.35) {
      flags.push({
        name: `Uniform sentence length (variation ${fixed(cv, 2)})`,
        count: lens.length,
        fix: "Break one sentence in half. Let another run long. Machines write even.",
      });
    }
  }
  return flags;
}

/** Deleting an opener leaves the next word lower case; fix only for writers who capitalise. */
export function restoreCapitals(original: string, text: string): string {
  const starts = [...original.matchAll(pyre("(?:^|[.!?]\\s+|\\n)\\s*([A-Za-z])", "g"))].map((m) => m[1]);
  const upper = starts.filter((c) => c !== c.toLowerCase()).length;
  if (!starts.length || upper * 2 < starts.length) return text;
  return text.replace(
    pyre("(?:^|(?<=[.!?] )|(?<=[.!?]\\n)|(?<=\\n))\\s*([a-z])", "g"),
    (m, p1: string) => m.slice(0, -1) + p1.toUpperCase(),
  );
}

export interface HumanizeReport {
  invisible: InvisibleHit[];
  typographic: TypoHit[];
  lexical: LexHit[];
  structures: StructHit[];
}

export function humanize(raw: string, lex: Lexicon): { text: string; report: HumanizeReport } {
  const rawForCase = raw;
  let [text, urls] = protectUrls(raw);
  let inv: InvisibleHit[];
  let typo: TypoHit[];
  let lexi: LexHit[];
  [text, inv] = passInvisible(text, lex);
  [text, typo] = passTypographic(text, lex);
  [text, lexi] = passLexical(text, lex);
  text = restoreCapitals(rawForCase, text);
  text = restoreUrls(text, urls);
  return {
    text: pyStrip(text) + "\n",
    report: { invisible: inv, typographic: typo, lexical: lexi, structures: scanStructures(text, lex) },
  };
}

export function renderReport(report: HumanizeReport): string {
  let o = "";
  const print = (s = "") => { o += s + "\n"; };
  const head = (title: string) => print(`\n${title}\n` + "-".repeat(cpLen(title)));
  const sum = (a: { count: number }[]) => a.reduce((n, h) => n + h.count, 0);
  const total = sum(report.invisible) + sum(report.typographic) + sum(report.lexical);
  head("HUMANIZE REPORT");
  print(`${total} machine artefacts removed, ${report.structures.length} structural tells flagged for rewrite`);
  if (report.invisible.length) {
    head("1. INVISIBLE CHARACTERS");
    for (const h of report.invisible) print(`  ${padStart(String(h.count), 3)}x  ${h.name}  -> ${h.action}`);
  }
  if (report.typographic.length) {
    head("2. TYPOGRAPHY");
    for (const h of report.typographic) print(`  ${padStart(String(h.count), 3)}x  ${h.name}  -> ${h.to}`);
  }
  if (report.lexical.length) {
    head("3. SLOP LEXICON");
    for (const h of report.lexical) print(`  ${padStart(String(h.count), 3)}x  ${h.find}  -> ${h.replace}   [${h.family}]`);
  }
  if (report.structures.length) {
    head("4. STRUCTURAL TELLS  (not auto-fixed - rewrite these yourself)");
    for (const h of report.structures) print(`  ${padStart(String(h.count), 3)}x  ${h.name}\n        ${h.fix}`);
  }
  if (!Object.values(report).some((v) => v.length)) {
    head("CLEAN");
    print("  Nothing to strip.");
  }
  print("");
  return o;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

let stdinUsed = false;
function readInput(p: string): string {
  if (p === "-") {
    if (stdinUsed) return "";
    stdinUsed = true;
    try {
      return fs.readFileSync(0, "utf8").replace(/\r\n?/g, "\n");
    } catch {
      return "";
    }
  }
  return fs.readFileSync(p, "utf8").replace(/\r\n?/g, "\n");
}

interface OptSpec { [name: string]: { takesValue: boolean; key: string } }
interface Parsed { opts: Record<string, string | boolean>; pos: string[] }

function parseArgs(argv: string[], spec: OptSpec, maxPos: number, usage: string, prog: string): Parsed | number {
  const opts: Record<string, string | boolean> = {};
  const pos: string[] = [];
  const fail = (msg: string): number => {
    process.stderr.write(`${usage}\n${prog}: error: ${msg}\n`);
    return 2;
  };
  const looksOption = (a: string) => a.startsWith("-") && a !== "-" && !/\s/.test(a) && !/^-\d/.test(a);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") { pos.push(...argv.slice(i + 1)); break; }
    if (!looksOption(a)) { pos.push(a); continue; }
    const eqAt = a.startsWith("--") ? a.indexOf("=") : -1;
    const name = eqAt >= 0 ? a.slice(0, eqAt) : a;
    const eq = eqAt >= 0 ? a.slice(eqAt + 1) : undefined;
    let key = Object.keys(spec).find((k) => k === name);
    if (!key && name.startsWith("--")) {
      const c = Object.keys(spec).filter((k) => k.startsWith("--") && k.startsWith(name));
      if (c.length === 1) key = c[0];
    }
    if (!key) return fail(`unrecognized arguments: ${a}`);
    const o = spec[key];
    if (o.key === "help") {
      process.stdout.write(`${usage}\n`);
      return 0 - 1; // sentinel handled by caller
    }
    if (o.takesValue) {
      const v = eq ?? argv[++i];
      if (v === undefined || (eq === undefined && looksOption(v))) return fail(`argument ${key}: expected one argument`);
      opts[o.key] = v;
    } else opts[o.key] = true;
  }
  if (pos.length > maxPos) return fail(`unrecognized arguments: ${pos.slice(maxPos).join(" ")}`);
  return { opts, pos };
}

const DETECT_USAGE = "usage: ai-tells.ts detect [-h] [--json] [--lexicon LEXICON] [input] [compare]";
const HUMANIZE_USAGE = "usage: ai-tells.ts humanize [-h] [-o OUT] [--report] [--json] [--lexicon LEXICON] [input]";

function mainDetect(argv: string[]): number {
  const p = parseArgs(
    argv,
    {
      "--json": { takesValue: false, key: "json" },
      "--lexicon": { takesValue: true, key: "lexicon" },
      "-h": { takesValue: false, key: "help" },
      "--help": { takesValue: false, key: "help" },
    },
    2, DETECT_USAGE, "ai-tells.ts detect",
  );
  if (typeof p === "number") return p < 0 ? 0 : p;
  const input = p.pos[0] ?? "-";
  const compare = p.pos[1];
  const lex = loadLexicon((p.opts.lexicon as string | undefined) ?? DEFAULT_LEXICON);
  const targets: [string, string][] = [[input, readInput(input)]];
  if (compare) targets.push([compare, readInput(compare)]);

  const payload = targets.map(([name, text]) => scoreDraft(text, lex, name));
  if (p.opts.json) {
    process.stdout.write(pyJson(compare ? payload : payload[0], true, new Set(["score", "human_score"])) + "\n");
    return 0;
  }
  let out = "";
  targets.forEach(([name, text]) => {
    out += renderDetect(detect(text, lex), compare ? path.basename(name) : undefined);
  });
  if (compare) {
    const [a, b] = payload;
    const delta = b.human_score - a.human_score;
    out += `  ${fixed(a.human_score, 1)} ${a.verdict}  ->  ${fixed(b.human_score, 1)} ${b.verdict}   (${delta < 0 ? "" : "+"}${fixed(delta, 1)})\n\n`;
  }
  process.stdout.write(out);
  return payload[payload.length - 1].verdict === "PASS" ? 0 : 1;
}

function mainHumanize(argv: string[]): number {
  const p = parseArgs(
    argv,
    {
      "-o": { takesValue: true, key: "out" },
      "--out": { takesValue: true, key: "out" },
      "--report": { takesValue: false, key: "report" },
      "--json": { takesValue: false, key: "json" },
      "--lexicon": { takesValue: true, key: "lexicon" },
      "-h": { takesValue: false, key: "help" },
      "--help": { takesValue: false, key: "help" },
    },
    1, HUMANIZE_USAGE, "ai-tells.ts humanize",
  );
  if (typeof p === "number") return p < 0 ? 0 : p;
  const raw = readInput(p.pos[0] ?? "-");
  const lex = loadLexicon((p.opts.lexicon as string | undefined) ?? DEFAULT_LEXICON);
  const { text: clean, report } = humanize(raw, lex);
  if (p.opts.json) {
    process.stdout.write(pyJson({ text: clean, report }, false, new Set()) + "\n");
    return 0;
  }
  if (p.opts.out) {
    fs.writeFileSync(p.opts.out as string, clean, "utf8");
    process.stderr.write(`wrote ${p.opts.out}\n`);
  } else process.stdout.write(clean);
  if (p.opts.report) process.stderr.write(renderReport(report));
  return 0;
}

/** Runs the CLI; returns the exit code. */
export function main(argv: string[]): number {
  if (argv[0] === "humanize") return mainHumanize(argv.slice(1));
  if (argv[0] === "detect") return mainDetect(argv.slice(1));
  return mainDetect(argv);
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2));
}
