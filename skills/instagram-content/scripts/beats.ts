#!/usr/bin/env bun
// Ported from instagram-agent-skill (MIT, (c) 2026 Jake Schincariol), skills/ig-reel/beats.py
//
// beats - turn a Reel script into a timed beat sheet before you record it.
//
// Estimates how long each line takes to say, stacks them into timecodes, and
// flags the four things that kill a Reel in the edit: a hook that runs past the
// three-second mark, a beat long enough for the viewer to leave, a run of lines
// with nothing concrete in them, and a total length that does not match what you
// said you were making.
//
// Usage
//   npx -y bun beats.ts script.txt [--wpm 165] [--target 30] [--json]
//   pbpaste | npx -y bun beats.ts -
//
// Exit code: 0 on success, 2 on an empty script or usage error.

import { readFileSync } from "node:fs";
import process from "node:process";

// ---------------------------------------------------------------------------
// Python-compat helpers
// ---------------------------------------------------------------------------

const PYWS = "\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const WORD = "[\\p{L}\\p{N}_]";
const BOUND = `(?:(?<=${WORD})(?!${WORD})|(?<!${WORD})(?=${WORD}))`;

/** Translate a Python-flavoured pattern (\b \d \s \S with unicode semantics) to a JS `u` regex. */
function pyre(src: string, flags = ""): RegExp {
  let out = "";
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (c === "\\" && i + 1 < src.length) {
      const n = src[i + 1]!;
      i++;
      if (n === "b") out += BOUND;
      else if (n === "d") out += "\\p{Nd}";
      else if (n === "s") out += `[${PYWS}]`;
      else if (n === "S") out += `[^${PYWS}]`;
      else out += "\\" + n;
    } else out += c;
  }
  return new RegExp(out, flags + "u");
}

const WS_EDGE = new RegExp(`^[${PYWS}]+|[${PYWS}]+$`, "gu");
const pyStrip = (s: string): string => s.replace(WS_EDGE, "");
const cpLen = (s: string): number => [...s].length;

/** Python str.splitlines() */
const splitlines = (s: string): string[] => {
  const parts = s.split(/\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/);
  if (parts.length && parts[parts.length - 1] === "") parts.pop();
  return parts;
};

/** Python f"{x:.{d}f}" (round-half-even on the exact binary value). */
export function pyFixed(x: number, d: number): string {
  const m = 2 ** (d + 1);
  const y = x * m;
  if (Number.isInteger(y) && Math.abs(y) % 2 === 1) {
    const scaled = x * 10 ** d;
    const lo = Math.floor(scaled);
    const n = lo % 2 === 0 ? lo : lo + 1;
    return (n / 10 ** d).toFixed(d);
  }
  return x.toFixed(d);
}

/** Python round(x, 2) for floats. */
export function pyRound2(x: number): number {
  return Number(pyFixed(x, 2));
}

/** Python repr(float) */
export function pyFloat(x: number): string {
  if (Number.isNaN(x)) return "NaN";
  if (!Number.isFinite(x)) return x > 0 ? "Infinity" : "-Infinity";
  if (Object.is(x, -0)) return "-0.0";
  const a = Math.abs(x);
  if (a !== 0 && (a < 1e-4 || a >= 1e16)) {
    const [m, e] = x.toExponential().split("e") as [string, string];
    const ex = parseInt(e, 10);
    return `${m}e${ex < 0 ? "-" : "+"}${String(Math.abs(ex)).padStart(2, "0")}`;
  }
  const s = String(x);
  return /[.e]/.test(s) ? s : s + ".0";
}

/** Python ZeroDivisionError-compatible float division. */
function div(a: number, b: number): number {
  if (b === 0) throw new Error("ZeroDivisionError: float division by zero");
  return a / b;
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

const WORD_RE = pyre("[A-Za-z0-9$%'’-]+", "g");
const SENT_RE = pyre("[^.!?]+[.!?]*", "g");
const CONCRETE_SRC = "\\$\\s?\\d|\\b\\d[\\d,.]*\\b|(?<=[^\\n])\\b[A-Z][a-z]{2,}\\b"; // (?<!^) in MULTILINE
const concreteCount = (s: string): number => [...s.matchAll(pyre(CONCRETE_SRC, "g"))].length;
const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "if", "of", "to", "in", "on", "for",
  "with", "that", "this", "it", "is", "are", "was", "were", "be", "been",
  "you", "your", "i", "my", "me", "we", "our", "they", "them", "he", "she",
  "so", "just", "not", "no", "do", "did", "does", "have", "has", "had",
  "will", "can", "at", "as", "by", "from", "out", "up", "off", "one", "all",
]);

export const HOOK_WINDOW = 3.0; // seconds. Past this, the thumb has already decided.
export const MAX_BEAT = 4.0; // seconds on one idea with no change on screen.
export const ABSTRACT_RUN = 3; // beats in a row with nothing checkable in them.

const COMMA_BETWEEN_DIGITS = pyre("(?<=\\d),(?=\\d)", "g");
const THOUSANDS = pyre("(\\d)(?=(\\d{3})+$)", "g");

/** "$18,000" is one word when it is spoken, so it is one word here too. */
export function words(text: string): string[] {
  return [...text.replace(COMMA_BETWEEN_DIGITS, "").matchAll(WORD_RE)].map((m) => m[0]);
}

/** Put the thousands separator back for display. */
export function pretty(token: string): string {
  return token.replace(THOUSANDS, "$1,");
}

/** m:ss.s timecode */
export function tc(seconds: number): string {
  const s = seconds % 60;
  const m = Math.round((seconds - s) / 60);
  return `${Math.trunc(m)}:${pyFixed(s, 1).padStart(4, "0")}`;
}

/** One line is one beat, unless a line is too long to be one. */
export function splitBeats(raw: string, wps: number): string[] {
  const beats: string[] = [];
  for (const line of splitlines(raw).map(pyStrip)) {
    if (!line) continue;
    if (div(words(line).length, wps) <= MAX_BEAT * 1.5) {
      beats.push(line);
      continue;
    }
    // Long paragraph: break it at sentence ends so the timings mean something.
    const parts = [...line.matchAll(SENT_RE)].map((m) => pyStrip(m[0])).filter((p) => p);
    let buf = "";
    for (const part of parts) {
      const candidate = pyStrip(buf + " " + part);
      if (buf && div(words(candidate).length, wps) > MAX_BEAT) {
        beats.push(buf);
        buf = part;
      } else buf = candidate;
    }
    if (buf) beats.push(buf);
  }
  return beats;
}

export interface BeatRow {
  n: number;
  start: number;
  dur: number;
  words: number;
  text: string;
  concrete: number;
  label: string;
  flags: string[];
}

export interface BeatAnalysis {
  wpm: number;
  target: number | null;
  total_seconds: number;
  total_words: number;
  beats: BeatRow[];
  notes: string[];
}

export function analyseBeats(raw: string, wpm = 165, target: number | null = null): BeatAnalysis | null {
  const wps = wpm / 60.0;
  const beats = splitBeats(raw, wps);
  if (!beats.length) return null;

  const rows: BeatRow[] = [];
  let clock = 0.0;
  beats.forEach((text, i) => {
    const n = words(text).length;
    const dur = div(n, wps);
    rows.push({
      n: i + 1,
      start: pyRound2(clock),
      dur: pyRound2(dur),
      words: n,
      text,
      concrete: concreteCount(text),
      label: "",
      flags: [],
    });
    clock += dur;
  });
  const total = clock;

  // Label the structural positions a Reel is actually built around.
  for (const r of rows) if (r.n === 1 || r.start + r.dur <= HOOK_WINDOW) r.label = "HOOK";
  const last = rows[rows.length - 1]!;
  last.label = last.label !== "HOOK" ? "CTA" : "HOOK/CTA";
  const half = total / 2;
  for (const r of rows) if (!r.label && r.start <= half && half < r.start + r.dur) r.label = "MID";

  const notes: string[] = [];
  const first = rows[0]!;
  if (first.dur > HOOK_WINDOW) {
    first.flags.push(`hook runs ${pyFixed(first.dur, 1)}s, past the ${pyFixed(HOOK_WINDOW, 0)}s mark`);
    notes.push(
      `Beat 1 takes ${pyFixed(first.dur, 1)}s to say. Cut it to ` +
        `${Math.trunc(HOOK_WINDOW * wps)} words or fewer, or the hook lands after ` +
        "the decision has been made.",
    );
  }
  if (first.concrete === 0) {
    notes.push(
      "Beat 1 has no number and no name in it. Hooks without something " +
        "checkable are the ones that get scrolled.",
    );
  }

  for (const r of rows) if (r.dur > MAX_BEAT) r.flags.push(`${pyFixed(r.dur, 1)}s on one beat`);
  const longBeats = rows.filter((r) => r.dur > MAX_BEAT).map((r) => r.n);
  if (longBeats.length) {
    notes.push(
      `Beat(s) ${longBeats.join(", ")} run past ${pyFixed(MAX_BEAT, 0)}s. ` +
        "Either split the line or change what is on screen inside it. " +
        "A static frame is where people leave.",
    );
  }

  let run = 0;
  let start: number | null = null;
  for (const r of rows) {
    if (r.concrete === 0) {
      run += 1;
      start = start !== null ? start : r.n;
      if (run === ABSTRACT_RUN) {
        notes.push(
          `Beats ${start}-${r.n} have nothing concrete in them. ` +
            "Put a number, a name or a price in one of them.",
        );
      }
    } else {
      run = 0;
      start = null;
    }
  }

  // Does the last line hand you back to the first one?
  const keep = (t: string) =>
    new Set(words(t).map((w) => w.toLowerCase()).filter((w) => !STOPWORDS.has(w)));
  const firstSet = keep(first.text);
  const lastSet = keep(last.text);
  const loop = [...firstSet].filter((w) => lastSet.has(w)).map(pretty).sort();
  if (loop.length) {
    notes.push(
      `Loops: the last beat repeats "${loop.slice(0, 3).join(", ")}" from the hook. ` +
        "Second watches are free reach.",
    );
  } else {
    notes.push(
      "No loop. The last beat shares no word with the hook, so the video " +
        "ends flat. Echoing one word from beat 1 is the cheapest replay you get.",
    );
  }

  if (target) {
    const delta = total - target;
    if (Math.abs(delta) <= target * 0.1) {
      notes.push(`Length is on target (${pyFixed(total, 1)}s against ${pyFloat(target)}s).`);
    } else if (delta > 0) {
      notes.push(`${pyFixed(delta, 1)}s over target. Cut about ${Math.trunc(delta * wps)} words.`);
    } else {
      notes.push(
        `${pyFixed(-delta, 1)}s under target. Either add ${Math.trunc(-delta * wps)} words ` +
          "or shoot it short. Short is usually right.",
      );
    }
  }

  return {
    wpm,
    target,
    total_seconds: pyRound2(total),
    total_words: rows.reduce((a, r) => a + r.words, 0),
    beats: rows,
    notes,
  };
}

// ---------------------------------------------------------------------------
// Output (Python json.dumps(indent=2, ensure_ascii=False) + text rendering)
// ---------------------------------------------------------------------------

class PyFloat {
  constructor(public v: number) {}
}

function dumps(v: unknown, level = 0): string {
  const pad = "  ".repeat(level + 1);
  const end = "  ".repeat(level);
  if (v === null || v === undefined) return "null";
  if (v instanceof PyFloat) return pyFloat(v.v);
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean" || typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) {
    if (!v.length) return "[]";
    return "[\n" + v.map((x) => pad + dumps(x, level + 1)).join(",\n") + "\n" + end + "]";
  }
  const entries = Object.entries(v as Record<string, unknown>);
  if (!entries.length) return "{}";
  return (
    "{\n" + entries.map(([k, x]) => `${pad}${JSON.stringify(k)}: ${dumps(x, level + 1)}`).join(",\n") + "\n" + end + "}"
  );
}

/**
 * JSON exactly as the Python tool prints it. Python floats keep their ".0":
 * `wpmIsFloat` is true when --wpm was given on the command line (argparse type=float);
 * the default 165 is an int. `target` is always a float.
 */
export function beatsJson(a: BeatAnalysis, wpmIsFloat = false): string {
  return dumps({
    wpm: wpmIsFloat ? new PyFloat(a.wpm) : a.wpm,
    target: a.target === null ? null : new PyFloat(a.target),
    total_seconds: new PyFloat(a.total_seconds),
    total_words: a.total_words,
    beats: a.beats.map((r) => ({
      n: r.n,
      start: new PyFloat(r.start),
      dur: new PyFloat(r.dur),
      words: r.words,
      text: r.text,
      concrete: r.concrete,
      label: r.label,
      flags: r.flags,
    })),
    notes: a.notes,
  });
}

export function renderBeats(a: BeatAnalysis, wpmIsFloat = false): string {
  const wpmTxt = wpmIsFloat ? pyFloat(a.wpm) : String(a.wpm);
  const head =
    `BEAT SHEET  ·  ${a.total_words} words  ·  ~${pyFixed(a.total_seconds, 1)}s ` +
    `at ${wpmTxt} wpm` +
    (a.target ? `  ·  target ${pyFloat(a.target)}s` : "");
  const rule = Math.max(cpLen(head), 72);
  const out: string[] = ["", head, "=".repeat(rule)];
  for (const r of a.beats) {
    const label = r.label ? r.label.padEnd(8) : " ".repeat(8);
    out.push(`  ${tc(r.start)}  ${pyFixed(r.dur, 1).padStart(4)}s  ${label}${r.text}`);
    for (const f of r.flags) out.push(`  ${" ".repeat(6)}  ${" ".repeat(5)}  ${" ".repeat(8)}^ ${f}`);
  }
  out.push("-".repeat(rule));
  for (const n of a.notes) out.push(`  - ${n}`);
  out.push("");
  return out.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = "usage: beats.ts [-h] [--wpm WPM] [--target TARGET] [--json] [input]";

function fail(msg: string): void {
  process.stderr.write(`${USAGE}\nbeats.ts: error: ${msg}\n`);
  process.exitCode = 2;
}

function parseFloatArg(s: string): number | null {
  const t = s.trim().replace(/_/g, "");
  if (/^[+-]?(inf|infinity)$/i.test(t)) return t.startsWith("-") ? -Infinity : Infinity;
  if (/^[+-]?nan$/i.test(t)) return NaN;
  if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(t)) return null;
  return Number(t);
}

export function main(argv: string[]): void {
  const longs = ["--help", "--wpm", "--target", "--json"];
  let input: string | null = null;
  let wpm = 165;
  let wpmGiven = false;
  let target: number | null = null;
  let json = false;
  const extra: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i]!;
    if (arg === "-h") arg = "--help";
    if (arg.startsWith("--") && arg.length > 2) {
      let val: string | null = null;
      const eq = arg.indexOf("=");
      if (eq > 0) {
        val = arg.slice(eq + 1);
        arg = arg.slice(0, eq);
      }
      const cands = longs.includes(arg) ? [arg] : longs.filter((l) => l.startsWith(arg));
      if (cands.length !== 1) return fail(`unrecognized arguments: ${argv[i]}`);
      const opt = cands[0]!;
      if (opt === "--help") {
        process.stdout.write(
          `${USAGE}\n\nTime a Reel script into a beat sheet.\n\npositional arguments:\n  input            script file, or - for stdin\n\noptions:\n  -h, --help       show this help message and exit\n  --wpm WPM        speaking rate (default 165)\n  --target TARGET  target length in seconds\n  --json\n`,
        );
        return;
      }
      if (opt === "--json") {
        if (val !== null) return fail("argument --json: ignored explicit argument");
        json = true;
        continue;
      }
      if (val === null) {
        if (i + 1 >= argv.length) return fail(`argument ${opt}: expected one argument`);
        val = argv[++i]!;
      }
      const f = parseFloatArg(val);
      if (f === null) return fail(`argument ${opt}: invalid float value: '${val}'`);
      if (opt === "--wpm") {
        wpm = f;
        wpmGiven = true;
      } else target = f;
    } else if (arg === "-" || !arg.startsWith("-")) {
      if (input !== null) extra.push(arg);
      else input = arg;
    } else if (/^-\d/.test(arg)) {
      extra.push(arg);
    } else return fail(`unrecognized arguments: ${arg}`);
  }
  if (extra.length) return fail(`unrecognized arguments: ${extra.join(" ")}`);
  if (input === null) input = "-";

  let raw: string;
  try {
    raw = input === "-" ? readFileSync(0, "utf8") : readFileSync(input, "utf8");
  } catch (e) {
    process.stderr.write(`FileNotFoundError: ${(e as Error).message}\n`);
    process.exitCode = 1;
    return;
  }
  raw = raw.replace(/\r\n?/g, "\n"); // Python text mode: universal newlines
  const a = analyseBeats(raw, wpm, target);
  if (!a) {
    process.stderr.write("empty script\n");
    process.exitCode = 2;
    return;
  }
  process.stdout.write(json ? beatsJson(a, wpmGiven) + "\n" : renderBeats(a, wpmGiven));
  process.exitCode = 0;
}

if (import.meta.main) main(process.argv.slice(2));
