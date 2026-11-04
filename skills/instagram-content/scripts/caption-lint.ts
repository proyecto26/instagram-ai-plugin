#!/usr/bin/env bun
// Ported from instagram-agent-skill (MIT, (c) 2026 Jake Schincariol), skills/ig-caption/caption.py
//
// caption-lint - lint an Instagram caption and show exactly what the feed shows
// before the "... more".
//
// Usage
//   npx -y bun caption-lint.ts caption.txt [--truncate 125] [--keywords "a,b"] [--json]
//   pbpaste | npx -y bun caption-lint.ts -
//
// Exit code: 0 when the verdict is READY, 1 otherwise (2 on usage errors).

import { readFileSync } from "node:fs";
import process from "node:process";

export const LIMIT = 2200; // Instagram's hard caption limit.
export const TRUNCATE = 125; // Roughly where the feed cuts to "... more".
export const HASHTAG_LIMIT = 5; // Instagram's cap per post or reel since 18 Dec 2025.

// ---------------------------------------------------------------------------
// Python-compat helpers
// ---------------------------------------------------------------------------

// Python str.isspace() set (differs from JS \s: no U+FEFF, adds U+001C-1F, U+0085).
const PYWS = "\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const WORD = "[\\p{L}\\p{N}_]"; // Python unicode \w
const BOUND = `(?:(?<=${WORD})(?!${WORD})|(?<!${WORD})(?=${WORD}))`; // Python unicode \b

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
const pyRstrip = (s: string): string => s.replace(new RegExp(`[${PYWS}]+$`, "u"), "");
const cps = (s: string): string[] => [...s];
const cpLen = (s: string): number => cps(s).length;
const padEndCp = (s: string, n: number): string => s + " ".repeat(Math.max(0, n - cpLen(s)));

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

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

const HASHTAG_RE = pyre("(?:^|\\s)(#[A-Za-z0-9_]+)", "g");
const MENTION_RE = pyre("(?:^|\\s)(@[A-Za-z0-9_.]+)", "g");
const LINK_RE = pyre(
  "https?://\\S+|\\bwww\\.\\S+|\\b[a-z0-9-]+\\.(?:com|co|io|net|org|ai|app)/\\S*",
  "gi",
);
const EMOJI_RE = new RegExp("[\\u{1F300}-\\u{1FAFF}\\u2600-\\u27BF\\u2190-\\u21FF\\uFE0F]", "gu");
// (?<!^) in Python MULTILINE == "has a previous char and it is not a newline".
const CONCRETE_SRC = "\\$\\s?\\d|\\b\\d[\\d,.]*\\b|(?<=[^\\n])\\b[A-Z][a-z]{2,}\\b";
const concreteRe = (): RegExp => pyre(CONCRETE_SRC, "g");

const ASKS: Array<[RegExp, string]> = [
  [pyre('\\bcomment (?:the word |")?[A-Z0-9]{2,}\\b', "i"), "comment a keyword"],
  [pyre("\\b(?:dm|message) me\\b", "i"), "DM me"],
  [pyre("\\bsave (?:this|it)\\b", "i"), "save this"],
  [pyre("\\bshare (?:this|it)\\b", "i"), "share this"],
  [pyre("\\bfollow (?:me|for)\\b", "i"), "follow"],
  [pyre("\\blink in (?:my )?bio\\b", "i"), "link in bio"],
  [pyre("\\b(?:swipe|tap) (?:through|left|right|for|to)\\b", "i"), "swipe or tap"],
  [pyre("\\btell me\\b|\\bwhat would you\\b|\\bwhich one\\b", "i"), "answer a question"],
];

const FILLER_TAGS = new Set([
  "#viral", "#fyp", "#explore", "#explorepage", "#foryou", "#foryoupage",
  "#trending", "#instagood", "#love", "#follow", "#like4like", "#reels",
  "#reelsinstagram", "#viralreels", "#instadaily",
]);

const findall = (re: RegExp, s: string, group = 0): string[] =>
  [...s.matchAll(re)].map((m) => m[group] as string);

const reEscape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");

// ---------------------------------------------------------------------------
// textwrap.wrap port (CPython 3.12, default options)
// ---------------------------------------------------------------------------

const TW_WS = "[\\t\\n\\x0b\\x0c\\r ]";
const TW_NWS = "[^\\t\\n\\x0b\\x0c\\r ]";
const TW_WP = "[\\p{L}\\p{N}_!\"'&.,?]";
const TW_LT = "[\\p{L}\\p{Nl}\\p{No}_]";
const WORDSEP_RE = new RegExp(
  `(${TW_WS}+` +
    `|(?<=${TW_WP})-{2,}(?=${WORD})` +
    `|${TW_NWS}+?(?:` +
    `-(?:(?<=${TW_LT}{2}-)|(?<=${TW_LT}-${TW_LT}-))(?=${TW_LT}-?${TW_LT})` +
    `|(?=${TW_WS}|$)` +
    `|(?<=${TW_WP})(?=-{2,}${WORD})` +
    `))`,
  "u",
);

function expandTabs(text: string, tabsize = 8): string {
  let out = "";
  let col = 0;
  for (const ch of text) {
    if (ch === "\t") {
      const n = tabsize - (col % tabsize);
      out += " ".repeat(n);
      col += n;
    } else {
      out += ch;
      if (ch === "\n" || ch === "\r") col = 0;
      else col++;
    }
  }
  return out;
}

export function textwrap(text: string, width: number): string[] {
  if (width <= 0) throw new Error(`invalid width ${width} (must be > 0)`);
  text = expandTabs(text).replace(/[\t\n\v\f\r]/g, " ");
  const chunks = text.split(WORDSEP_RE).filter((c) => c);
  const lines: string[] = [];
  chunks.reverse();
  while (chunks.length) {
    const curLine: string[] = [];
    let curLen = 0;
    if (lines.length && pyStrip(chunks[chunks.length - 1]!) === "") chunks.pop();
    while (chunks.length) {
      const l = cpLen(chunks[chunks.length - 1]!);
      if (curLen + l <= width) {
        curLine.push(chunks.pop()!);
        curLen += l;
      } else break;
    }
    if (chunks.length && cpLen(chunks[chunks.length - 1]!) > width) {
      // _handle_long_word
      const spaceLeft = width < 1 ? 1 : width - curLen;
      let end = spaceLeft;
      const chunk = cps(chunks[chunks.length - 1]!);
      if (chunk.length > spaceLeft) {
        const hyphen = chunk.slice(0, spaceLeft).lastIndexOf("-");
        if (hyphen > 0 && chunk.slice(0, hyphen).some((c) => c !== "-")) end = hyphen + 1;
      }
      curLine.push(chunk.slice(0, end).join(""));
      chunks[chunks.length - 1] = chunk.slice(end).join("");
      curLen = curLine.reduce((a, c) => a + cpLen(c), 0);
    }
    if (curLine.length && pyStrip(curLine[curLine.length - 1]!) === "") {
      curLen -= cpLen(curLine[curLine.length - 1]!);
      curLine.pop();
    }
    if (curLine.length) lines.push(curLine.join(""));
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

/** What the feed shows. Instagram cuts mid-word, so this does too. */
export function visibleWindow(text: string, cut: number): string {
  const flat = pyStrip(text);
  const c = cps(flat);
  return c.length <= cut ? flat : c.slice(0, cut).join("");
}

export interface Check {
  check: string;
  status: "PASS" | "WARN" | "FAIL";
  detail: string;
}

export interface CaptionAnalysis {
  characters: number;
  limit: number;
  truncate_at: number;
  visible: string;
  truncated: boolean;
  first_line_chars: number;
  hashtags: string[];
  mentions: string[];
  links: string[];
  emoji: number;
  asks: string[];
  checks: Check[];
  verdict: "FIX" | "REVIEW" | "READY";
}

export function analyseCaption(
  input: string,
  cut: number = TRUNCATE,
  keywordsIn: string[] | null = null,
): CaptionAnalysis {
  const text = pyRstrip(input);
  const stripped = pyStrip(text);
  const chars = cpLen(stripped);
  const lines = stripped.split("\n");
  const firstLine = lines.length ? pyStrip(lines[0]!) : "";
  const tags = findall(HASHTAG_RE, stripped, 1);
  const mentions = findall(MENTION_RE, stripped, 1);
  const links = findall(LINK_RE, stripped);
  const emoji = findall(EMOJI_RE, stripped);
  const window = visibleWindow(stripped, cut);
  const truncated = chars > cut;
  const asks = ASKS.filter(([p]) => p.test(stripped)).map(([, name]) => name);
  const filler = tags.filter((t) => FILLER_TAGS.has(t.toLowerCase()));
  const keywords = (keywordsIn ?? []).map(pyStrip).filter((k) => k);

  const checks: Check[] = [];
  const add = (name: string, status: Check["status"], detail: string) =>
    checks.push({ check: name, status, detail });

  add(
    "LENGTH",
    chars > LIMIT ? "FAIL" : "PASS",
    `${chars} / ${LIMIT} characters` + (chars > LIMIT ? `, ${chars - LIMIT} over the limit` : ""),
  );

  const flen = cpLen(firstLine);
  if (!firstLine) add("FIRST LINE", "FAIL", "the caption opens on a blank line");
  else if (firstLine.startsWith("#") || firstLine.startsWith("@"))
    add("FIRST LINE", "FAIL", "opens on a hashtag or a mention, which is the one position worth a sentence");
  else if (flen > cut)
    add(
      "FIRST LINE",
      "WARN",
      `${flen} characters, so it gets cut at ${cut} mid-thought. ` +
        "Fine if the cut is a cliffhanger, bad if it is a subordinate clause",
    );
  else add("FIRST LINE", "PASS", `${flen} characters, lands whole`);

  const concreteHits = findall(concreteRe(), window).length;
  add(
    "HOOK IS CONCRETE",
    concreteHits > 0 ? "PASS" : "WARN",
    `${concreteHits} number(s) or name(s) in the visible window` +
      (concreteHits > 0 ? "" : " - nothing checkable before the tap"),
  );

  if (tags.length > HASHTAG_LIMIT)
    add(
      "HASHTAGS",
      "FAIL",
      `${tags.length} tags, over Instagram's cap of ${HASHTAG_LIMIT}. ` +
        "Tags past the fifth do not count and the block reads as old",
    );
  else if (tags.length === HASHTAG_LIMIT && filler.length)
    add(
      "HASHTAGS",
      "WARN",
      `${tags.length} tags, at the cap, and ${filler.length} of them generic. Spend the five on topics`,
    );
  else if (filler.length)
    add(
      "HASHTAGS",
      "WARN",
      `${tags.length} tags, ${filler.length} of them generic (${filler.slice(0, 3).join(", ")}). Those describe nothing`,
    );
  else add("HASHTAGS", "PASS", `${tags.length} tag(s)` + (tags.length ? `: ${tags.join(" ")}` : ""));

  if (!tags.length) add("TAG PLACEMENT", "PASS", "no tags to place");
  else if (tags.some((t) => pyre("(?:^|\\s)" + reEscape(t) + "\\b").test(window)))
    add("TAG PLACEMENT", "WARN", "a hashtag is inside the visible window, spending feed space on a label");
  else add("TAG PLACEMENT", "PASS", "tags are below the fold");

  add(
    "LINKS",
    links.length ? "WARN" : "PASS",
    links.length
      ? `${links.length} link(s) in the caption, and captions are not clickable. Move it to the bio or the DM`
      : "no dead links in the body",
  );

  if (asks.length === 1) add("ONE ASK", "PASS", `one call to action: ${asks[0]}`);
  else if (!asks.length) add("ONE ASK", "WARN", "no call to action. Decide what this post is for");
  else add("ONE ASK", "WARN", `${asks.length} asks (${asks.join(", ")}). Two asks is the same as none`);

  const density = (emoji.length * 100) / Math.max(chars, 1);
  add(
    "EMOJI",
    density > 4 ? "WARN" : "PASS",
    `${emoji.length} emoji, ${pyFixed(density, 1)} per 100 characters` +
      (density > 4 ? " - reads as decoration" : ""),
  );

  if (keywords.length) {
    const low = stripped.toLowerCase();
    const lowWin = window.toLowerCase();
    const found = keywords.filter((k) => low.includes(k.toLowerCase()));
    const missing = keywords.filter((k) => !low.includes(k.toLowerCase()));
    const inWindow = found.filter((k) => lowWin.includes(k.toLowerCase()));
    const status = !missing.length ? "PASS" : found.length ? "WARN" : "FAIL";
    add(
      "SEARCH TERMS",
      status,
      `${found.length}/${keywords.length} present` +
        (found.length ? `, ${inWindow.length} in the visible window` : "") +
        (missing.length ? `. Missing: ${missing.join(", ")}` : ""),
    );
  }

  const fails = checks.filter((c) => c.status === "FAIL").length;
  const warns = checks.filter((c) => c.status === "WARN").length;
  const verdict = fails ? "FIX" : warns ? "REVIEW" : "READY";

  return {
    characters: chars,
    limit: LIMIT,
    truncate_at: cut,
    visible: window,
    truncated,
    first_line_chars: flen,
    hashtags: tags,
    mentions,
    links,
    emoji: emoji.length,
    asks,
    checks,
    verdict,
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export function renderBox(windowText: string, truncated: boolean, width = 52): string[] {
  const out: string[] = ["", "  WHAT THE FEED SHOWS", "  +" + "-".repeat(width + 2) + "+"];
  const lines: string[] = [];
  for (const raw of windowText.split("\n")) {
    const w = textwrap(raw, width);
    lines.push(...(w.length ? w : [""]));
  }
  for (const line of lines.slice(0, 8)) out.push(`  | ${padEndCp(line, width)} |`);
  const tail = truncated ? "... more" : "(whole caption fits)";
  out.push("  +" + "-".repeat(width + 2 - tail.length - 2) + ` ${tail} ` + "+");
  return out;
}

export function renderCaption(a: CaptionAnalysis): string {
  const head =
    `CAPTION LINT  ·  ${a.characters} / ${a.limit} chars  ·  ` +
    `${a.hashtags.length} hashtags  ·  ${a.asks.length} ask(s)`;
  const rule = Math.max(cpLen(head), 62);
  const out: string[] = ["", head, "=".repeat(rule)];
  out.push(...renderBox(a.visible, a.truncated));
  out.push("");
  for (const c of a.checks) out.push(`  ${c.status.padEnd(5)} ${c.check.padEnd(17)} ${c.detail}`);
  out.push("-".repeat(rule));
  out.push(`  VERDICT  ${a.verdict}`, "");
  return out.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = "usage: caption-lint.ts [-h] [--truncate TRUNCATE] [--keywords KEYWORDS] [--json] [input]";

function fail(msg: string): void {
  process.stderr.write(`${USAGE}\ncaption-lint.ts: error: ${msg}\n`);
  process.exitCode = 2;
}

export function main(argv: string[]): void {
  const longs = ["--help", "--truncate", "--keywords", "--json"];
  let input: string | null = null;
  let truncate = TRUNCATE;
  let keywords = "";
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
          `${USAGE}\n\nLint an Instagram caption.\n\npositional arguments:\n  input                caption file, or - for stdin\n\noptions:\n  -h, --help           show this help message and exit\n  --truncate TRUNCATE  characters shown before '... more' (default ${TRUNCATE})\n  --keywords KEYWORDS  comma-separated terms you want to be found for\n  --json\n`,
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
      if (opt === "--truncate") {
        if (!/^\s*[+-]?\d+(_\d+)*\s*$/.test(val)) return fail(`argument --truncate: invalid int value: '${val}'`);
        truncate = parseInt(val.replace(/_/g, ""), 10);
      } else keywords = val;
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
  const a = analyseCaption(raw, truncate, keywords.split(","));
  process.stdout.write(json ? JSON.stringify(a, null, 2) + "\n" : renderCaption(a));
  process.exitCode = a.verdict === "READY" ? 0 : 1;
}

if (import.meta.main) main(process.argv.slice(2));
