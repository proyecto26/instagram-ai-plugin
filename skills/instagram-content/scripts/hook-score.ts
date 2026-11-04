#!/usr/bin/env bun
// Ported from instagram-agent-skill (MIT, (c) 2026 Jake Schincariol), examples/instagram-agent-skill/skills/ig-reel/hookscore.py
//
// hook-score - score the first line of a Reel on the five things strong hooks
// have in common, and rank a batch of them against each other.
//
// Five local heuristics computed from the text alone: a length you can say in
// under three seconds, a concrete marker, something at stake, the payload at
// the front, and a viewer to aim it at. It is NOT a view predictor: it catches
// greetings, preambles and vague hooks, it cannot tell which of two decent
// hooks will travel. Trust the retention graph over this script.
//
// Each check returns 0 to 100. Higher is better.
//
// Usage
//   npx -y bun hook-score.ts hooks.txt              # one hook per line, ranked
//   npx -y bun hook-score.ts --hook "I lost $18,000 on one missing contract."
//   pbpaste | npx -y bun hook-score.ts -
//   npx -y bun hook-score.ts hooks.txt --json
//
// Exit codes: 0 if the best hook scores >= 70 (text mode) or --json was used,
// 1 otherwise, 2 for bad usage / nothing to score.

import * as fs from "node:fs";

// ---------------------------------------------------------------------------
// Python-compat helpers (duplicated in ai-tells.ts so each script stands alone)
// ---------------------------------------------------------------------------

/** Python's str.isspace() set, as regex class body. */
const PY_WS = "\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const PY_W = "\\p{L}\\p{N}_";
const PY_B = `(?:(?<=[${PY_W}])(?![${PY_W}])|(?<![${PY_W}])(?=[${PY_W}]))`;

/**
 * Translate a Python `re` pattern (str, Unicode semantics) to a JS RegExp:
 * unicode \b \w \d \s, `.` without newline, `^`/`$` with Python semantics,
 * leading (?i)/(?m) inline flags, and \UXXXXXXXX escapes.
 */
export function pyre(src: string, extraFlags = ""): RegExp {
  let ignoreCase = false;
  let multi = false;
  const head = /^\(\?([a-z]+)\)/.exec(src);
  if (head) {
    ignoreCase = head[1].includes("i");
    multi = head[1].includes("m");
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
/** Python str.strip() (no args). */
export function pyStrip(s: string): string {
  return s.replace(WS_RE, "");
}
/** Python str.strip(chars). */
function stripChars(s: string, chars: string): string {
  const a = [...s];
  let lo = 0;
  let hi = a.length;
  while (lo < hi && chars.includes(a[lo])) lo++;
  while (hi > lo && chars.includes(a[hi - 1])) hi--;
  return a.slice(lo, hi).join("");
}
/** Python str.splitlines(). */
export function pySplitlines(s: string): string[] {
  const parts = s.split(/\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/);
  if (parts[parts.length - 1] === "") parts.pop();
  return parts;
}
const cpLen = (s: string): number => [...s].length;

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

/**
 * An object tagged with [PY_INT] = true prints its "score" as a Python int (75, not 75.0).
 * json.dumps(value, indent=2, ensure_ascii=...). Keys in `floatKeys` print as Python floats (1.0, not 1). */
export const PY_INT = Symbol.for("pyint");

export function pyJson(value: unknown, ensureAscii: boolean, floatKeys: Set<string>, key = "", ind = "", asInt = false): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (floatKeys.has(key) && !asInt && Number.isInteger(value)) return `${value}.0`;
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
      .map(([k, v]) => inner + pyJson(k, ensureAscii, floatKeys) + ": " + pyJson(v, ensureAscii, floatKeys, k, inner, k === "score" && Boolean((value as Record<symbol, unknown>)[PY_INT])))
      .join(",\n") +
    "\n" + ind + "}"
  );
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

const WORD_RE = /[A-Za-z0-9$%'\u2019-]+/gu;
const NUMBER_SRC =
  String.raw`\$\s?\d[\d,]*(?:\.\d+)?` +
  String.raw`|\b\d[\d,]*(?:\.\d+)?\s?` +
  String.raw`(?:%|k\b|x\b|hrs?\b|hours?\b|mins?\b|minutes?\b` +
  String.raw`|days?\b|weeks?\b|months?\b|years?\b)?`;
const PROPER_SRC = String.raw`(?<!^)\b[A-Z][a-z]{2,}\b`;
const NUMBER_ALL = pyre("(?i)" + NUMBER_SRC, "g");
const NUMBER_HEAD = pyre("(?i)" + NUMBER_SRC, "y");
const PROPER_ALL = pyre(PROPER_SRC, "g");
const PROPER_HEAD = pyre(PROPER_SRC, "y");
const HASHTAG_RE = pyre(String.raw`(?:^|\s)#\w+`);
const EMOJI_RE = pyre(String.raw`[\U0001F300-\U0001FAFF\u2600-\u27bf]`);

const SPOKEN_NUMBERS = new Set([
  "zero", "two", "three", "four", "five", "six", "seven", "eight", "nine",
  "ten", "eleven", "twelve", "fifteen", "twenty", "thirty", "forty", "fifty",
  "sixty", "seventy", "eighty", "ninety", "hundred", "thousand", "million",
  "billion", "dozen", "half", "twice", "triple",
]);
const MONEY_WORDS = new Set([
  "dollars", "dollar", "bucks", "grand", "percent", "cents",
  "millionaire", "billionaire", "revenue", "profit", "salary", "rent",
]);
const STAKES = new Set([
  "stop", "never", "wrong", "mistake", "mistakes", "lost", "lose", "losing",
  "cost", "costs", "broke", "broken", "failed", "failure", "fail", "nobody",
  "no", "not", "don't", "dont", "doesn't", "didn't", "can't", "won't",
  "quit", "quitting", "fired", "deleted", "delete", "killed", "kills", "kill",
  "replaced", "replaces", "cut", "beat", "free", "paid", "charged", "hired",
  "saved", "first",
  "banned", "illegal", "worst", "hate", "hated", "wasted", "waste", "scam",
  "lie", "lied", "lying", "truth", "secret", "hidden", "stole", "stolen",
  "before", "until", "instead", "but", "except", "unless", "problem",
  "risk", "danger", "warning", "regret", "wish", "should", "shouldn't",
  "still", "already", "only", "without", "versus", "vs", "actually",
]);
const WEAK_OPENERS = [
  "so", "ok", "okay", "hey", "hi", "hello", "guys", "yo", "alright",
  "welcome", "today", "basically", "honestly", "look", "listen", "um",
  "just", "let", "lets", "let's", "i wanted", "i want", "one of",
  "have you", "did you", "do you", "are you", "in this", "in today",
  "the thing", "a lot", "there is", "there are", "this is", "it is",
  "as a", "when it", "if you've", "you know",
];
const IMPERATIVES = new Set([
  "stop", "steal", "copy", "delete", "try", "watch", "read", "save",
  "use", "build", "make", "write", "send", "take", "start", "quit",
  "never", "always", "don't", "dont", "do", "put", "run", "check",
]);
const DEALBREAKERS: [RegExp, string][] = [
  [pyre(String.raw`(?i)^\s*(?:stop scrolling|don'?t scroll)`),
    'Opens with "stop scrolling". Asking for attention proves you have not earned it.'],
  [pyre(String.raw`(?i)\b(?:in (?:this|today'?s) (?:video|reel)|i'?m going to show you|i'?ll show you how)\b`),
    "Video preamble. Delete it and open on the payoff."],
  [pyre(String.raw`(?i)^\s*(?:hey |hi |what'?s up |welcome )`),
    "Greeting. Nobody came to the feed to be greeted."],
  [HASHTAG_RE, "Hashtag in the hook. Hashtags belong at the bottom of the caption, if anywhere."],
  [EMOJI_RE, "Emoji in the hook. On-screen text at hook size has room for words or for an emoji, not both."],
];

/** [score, detail, isInt]: Python clamp() keeps an int an int when strictly between 0 and 100. */
export type Check = [score: number, detail: string, isInt?: boolean];
export const CHECKS = ["LENGTH", "SPECIFICITY", "STAKES", "FRONTLOAD", "ADDRESS"] as const;
export type CheckName = (typeof CHECKS)[number];

export const clamp = (n: number): number => Math.max(0.0, Math.min(100.0, n));

const lowerStrip = (x: string): string => stripChars(x.toLowerCase(), "'\u2019");
const COMMA_DIGIT = pyre(String.raw`(?<=\d),(?=\d)`, "g");

export function words(text: string): string[] {
  return text.replace(COMMA_DIGIT, "").match(WORD_RE) ?? [];
}

function testFresh(re: RegExp, s: string): boolean {
  re.lastIndex = 0;
  return re.test(s);
}

export function checkLength(text: string): Check {
  const n = words(text).length;
  const secs = n / 2.75;
  const chars = cpLen(pyStrip(text));
  let score: number;
  let isInt = false;
  if (n >= 5 && n <= 12) score = 100.0;
  else {
    score = n < 5 ? clamp(100 - (5 - n) * 20) : clamp(100 - (n - 12) * 11);
    isInt = score > 0 && score < 100;
  }
  if (chars > 60) score -= 12;
  const final = clamp(score);
  return [final, `${n} words, ${chars} chars, ~${fixed(secs, 1)}s spoken (want 5-12 words)`, isInt && final > 0 && final < 100];
}

export function checkSpecificity(text: string): Check {
  const nums = (text.match(NUMBER_ALL) ?? []).map(pyStrip).filter((n) => n);
  const propers = [...new Set(text.match(PROPER_ALL) ?? [])];
  const low = words(text).map(lowerStrip);
  const spoken = low.filter((w) => SPOKEN_NUMBERS.has(w) || MONEY_WORDS.has(w));
  const hits = nums.length + propers.length + spoken.length;
  const score = hits === 0 ? 15.0 : clamp(45 + hits * 30);
  const found = [...nums.slice(0, 2), ...propers.sort().slice(0, 2), ...spoken.slice(0, 2)].join(", ");
  return [score, `${hits} concrete marker(s)` + (found ? `: ${found}` : " - no number, no name, nothing checkable"), hits === 1];
}

export function checkStakes(text: string): Check {
  const hits = words(text).map(lowerStrip).filter((x) => STAKES.has(x));
  const markers = [...new Set(hits)].sort();
  if (pyre(String.raw`\$\s?\d`).test(text)) markers.push("a price");
  const n = markers.length;
  const score = n === 0 ? 20.0 : n === 1 ? 70.0 : 100.0;
  const detail =
    `${n} tension marker(s)` + (markers.length ? `: ${markers.slice(0, 4).join(", ")}` : " - nothing is at stake in this line");
  return [clamp(score), detail];
}

export function checkFrontload(text: string): Check {
  const w = words(text);
  if (!w.length) return [0.0, "empty"];
  const low = w.map(lowerStrip);
  const opener = low.slice(0, 2).join(" ");
  let penalty = 0;
  let hitOpener: string | null = null;
  for (const weak of WEAK_OPENERS) {
    if (opener.startsWith(weak) || low[0] === weak) {
      penalty = 30;
      hitOpener = weak;
      break;
    }
  }
  let payload: number | null = null;
  for (let i = 0; i < low.length; i++) {
    const token = low[i];
    if (STAKES.has(token) || SPOKEN_NUMBERS.has(token) || MONEY_WORDS.has(token) ||
        testFresh(NUMBER_HEAD, w[i]) || (i && testFresh(PROPER_HEAD, w[i]))) {
      payload = i;
      break;
    }
  }
  let base: number;
  let where: string;
  if (payload === null) {
    base = 30.0;
    where = "no payload word anywhere in the line";
  } else if (payload <= 3) {
    base = 100.0;
    where = `payload at word ${payload + 1}`;
  } else if (payload <= 6) {
    base = 70.0;
    where = `payload at word ${payload + 1}, could move forward`;
  } else {
    base = 40.0;
    where = `payload at word ${payload + 1}, too late`;
  }
  return [clamp(base - penalty), where + (hitOpener ? `; weak opener "${hitOpener}"` : "")];
}

export function checkAddress(text: string): Check {
  const low = text.toLowerCase();
  const w = words(text).map(lowerStrip);
  if (pyre(String.raw`\b(you|your|you're|youre|yourself)\b`).test(low)) return [100.0, "speaks to the viewer"];
  if (w.length && IMPERATIVES.has(w[0])) return [90.0, `imperative opener ("${w[0]}")`];
  if (pyre(String.raw`\b(i|my|me|we|our)\b`).test(low)) return [70.0, "first person, no viewer named"];
  return [35.0, "third person, nobody in the room"];
}

export interface RunResult {
  results: Record<CheckName, Check>;
  overall: number;
  verdict: "STRONG" | "OK" | "WEAK";
  flags: string[];
}

export function run(text: string): RunResult {
  const results: Record<CheckName, Check> = {
    LENGTH: checkLength(text),
    SPECIFICITY: checkSpecificity(text),
    STAKES: checkStakes(text),
    FRONTLOAD: checkFrontload(text),
    ADDRESS: checkAddress(text),
  };
  const flags = DEALBREAKERS.filter(([re]) => testFresh(re, text)).map(([, msg]) => msg);
  const scores = CHECKS.map((c) => results[c][0]);
  const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
  const lo = Math.min(...scores);
  const overall = clamp(mean * 0.6 + lo * 0.4 - flags.length * 15);
  const verdict = overall >= 70 && lo >= 55 && !flags.length ? "STRONG" : overall >= 50 ? "OK" : "WEAK";
  return { results, overall, verdict, flags };
}

export function weakestOf(results: Record<CheckName, Check>): CheckName {
  let best: CheckName = CHECKS[0];
  for (const c of CHECKS) if (results[c][0] < results[best][0]) best = c;
  return best;
}

export interface HookPayload {
  hook: string;
  checks: Record<string, { score: number; detail: string }>;
  weakest: CheckName;
  flags: string[];
  score: number;
  verdict: string;
}

/** The per-hook JSON object (scores rounded to 1 decimal, like the original). */
export function scoreHook(text: string): HookPayload {
  const { results, overall, verdict, flags } = run(text);
  const checks: HookPayload["checks"] = {};
  for (const k of CHECKS) {
    const entry = { score: round1(results[k][0]), detail: results[k][1] };
    if (results[k][2]) Object.defineProperty(entry, PY_INT, { value: true, enumerable: false });
    checks[k] = entry;
  }
  return { hook: text, checks, weakest: weakestOf(results), flags, score: round1(overall), verdict };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export function bar(score: number, width = 24): string {
  const filled = roundInt((score / 100) * width);
  return "#".repeat(filled) + ".".repeat(width - filled);
}

const padEnd = (s: string, n: number): string => s + " ".repeat(Math.max(0, n - cpLen(s)));
const padStart = (s: string, n: number): string => " ".repeat(Math.max(0, n - cpLen(s))) + s;

export function renderOne(text: string, r: RunResult): string {
  let o = "";
  const print = (s = "") => { o += s + "\n"; };
  print("\nHOOK SCORE");
  print("=".repeat(62));
  print(`  "${pyStrip(text)}"\n`);
  for (const name of CHECKS) {
    const [score, detail] = r.results[name];
    print(`  ${padEnd(name, 13)} ${bar(score)} ${padStart(fixed(score, 1), 5)}`);
    print(`  ${padEnd("", 13)} ${detail}`);
  }
  print("-".repeat(62));
  print(`  ${padEnd("HOOK SCORE", 13)} ${bar(r.overall)} ${padStart(fixed(r.overall, 1), 5)}   ${r.verdict}`);
  for (const f of r.flags) print(`\n  DEALBREAKER  ${f}`);
  if (r.verdict !== "STRONG") print(`\n  Weakest property: ${weakestOf(r.results)}. Fix that one and re-run.`);
  print("");
  return o;
}

export function renderTable(rows: HookPayload[]): string {
  let o = "";
  const print = (s = "") => { o += s + "\n"; };
  print("\nHOOK RANKING\n" + "=".repeat(78));
  rows.forEach((r, idx) => {
    const mark = idx === 0 ? "->" : "  ";
    const hook = cpLen(r.hook) <= 62 ? r.hook : [...r.hook].slice(0, 59).join("") + "...";
    print(`${mark} ${padStart(fixed(r.score, 1), 5)} ${padEnd(r.verdict, 7)} ${hook}`);
    print(`        weakest: ${r.weakest} (${fixed(r.checks[r.weakest].score, 0)})`);
    for (const f of r.flags) print(`        dealbreaker: ${f}`);
  });
  print("\nShoot the top one. If the top one is under 50, none of these are the hook.\n");
  return o;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = "usage: hook-score.ts [-h] [--hook HOOK] [--json] [input]";

function readStdin(): string {
  try {
    return fs.readFileSync(0, "utf8").replace(/\r\n?/g, "\n");
  } catch {
    return "";
  }
}

/** Runs the CLI; returns the exit code. */
export function main(argv: string[]): number {
  let input = "-";
  let hook: string | undefined;
  let json = false;
  let sawPositional = false;
  const fail = (msg: string): number => {
    process.stderr.write(`${USAGE}\nhook-score.ts: error: ${msg}\n`);
    return 2;
  };
  const looksOption = (a: string) => a.startsWith("-") && a !== "-" && !/\s/.test(a) && !/^-\d/.test(a);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      const rest = argv.slice(i + 1);
      if (rest.length) { input = rest[0]; sawPositional = true; }
      break;
    }
    if (!looksOption(a)) {
      if (sawPositional) return fail(`unrecognized arguments: ${a}`);
      input = a;
      sawPositional = true;
      continue;
    }
    const eqAt = a.startsWith("--") ? a.indexOf("=") : -1;
    const name = eqAt >= 0 ? a.slice(0, eqAt) : a;
    const eq = eqAt >= 0 ? a.slice(eqAt + 1) : undefined;
    const opts = ["--hook", "--json", "--help"];
    const cands = name.startsWith("--") ? opts.filter((o) => o === name || o.startsWith(name)) : [];
    const exact = opts.includes(name) ? name : cands.length === 1 ? cands[0] : name === "-h" ? "--help" : "";
    if (exact === "--help") {
      process.stdout.write(
        `${USAGE}\n\nScore a Reel hook on five properties.\n\npositional arguments:\n  input         file with one hook per line, or -\n\noptions:\n  -h, --help    show this help message and exit\n  --hook HOOK   score a single hook given on the command line\n  --json\n`,
      );
      return 0;
    }
    if (exact === "--json") json = true;
    else if (exact === "--hook") {
      const v = eq ?? argv[++i];
      if (v === undefined || (eq === undefined && looksOption(v))) return fail("argument --hook: expected one argument");
      hook = v;
    } else return fail(`unrecognized arguments: ${a}`);
  }

  let lines: string[];
  if (hook) lines = [hook];
  else {
    const raw = input === "-" ? readStdin() : fs.readFileSync(input, "utf8").replace(/\r\n?/g, "\n");
    lines = pySplitlines(raw).map(pyStrip).filter((l) => l);
  }
  if (!lines.length) {
    process.stderr.write("nothing to score\n");
    return 2;
  }

  const payload = lines.map(scoreHook);
  if (json) {
    const v = payload.length > 1 ? payload : payload[0];
    process.stdout.write(pyJson(v, false, new Set(["score"])) + "\n");
    return 0;
  }
  if (payload.length === 1) process.stdout.write(renderOne(lines[0], run(lines[0])));
  else process.stdout.write(renderTable([...payload].sort((a, b) => b.score - a.score)));
  return Math.max(...payload.map((p) => p.score)) >= 70 ? 0 : 1;
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2));
}
