// Ported from instagram-agent-skill (MIT, (c) 2026 Jake Schincariol), skills/ig-caption/caption.py and skills/ig-reel/beats.py
// Fixtures: expected values are the output of the original Python tools (python caption.py / beats.py --json and text mode).
import { describe, expect, test } from 'bun:test';
import { analyseCaption, renderCaption, pyFixed, textwrap } from '../../skills/instagram-content/scripts/caption-lint.ts';
import { analyseBeats, beatsJson, renderBeats, tc, words, pretty } from '../../skills/instagram-content/scripts/beats.ts';

const CAPTIONS: Array<{ name: string; input: string; cut: number; keywords: string[]; exit: number; expected: unknown; text: string }> = [
  { name: "c1_good", input: "We closed 3 clients in 14 days with one proposal template.\n\nHere is the exact structure Maria used at Acme Co.\n\nSave this for your next pitch.\n\n#proposals #freelance", cut: 125, keywords: [""], exit: 0,
    expected: {
  "characters": 165,
  "limit": 2200,
  "truncate_at": 125,
  "visible": "We closed 3 clients in 14 days with one proposal template.\n\nHere is the exact structure Maria used at Acme Co.\n\nSave this for",
  "truncated": true,
  "first_line_chars": 58,
  "hashtags": [
    "#proposals",
    "#freelance"
  ],
  "mentions": [],
  "links": [],
  "emoji": 0,
  "asks": [
    "save this"
  ],
  "checks": [
    {
      "check": "LENGTH",
      "status": "PASS",
      "detail": "165 / 2200 characters"
    },
    {
      "check": "FIRST LINE",
      "status": "PASS",
      "detail": "58 characters, lands whole"
    },
    {
      "check": "HOOK IS CONCRETE",
      "status": "PASS",
      "detail": "4 number(s) or name(s) in the visible window"
    },
    {
      "check": "HASHTAGS",
      "status": "PASS",
      "detail": "2 tag(s): #proposals #freelance"
    },
    {
      "check": "TAG PLACEMENT",
      "status": "PASS",
      "detail": "tags are below the fold"
    },
    {
      "check": "LINKS",
      "status": "PASS",
      "detail": "no dead links in the body"
    },
    {
      "check": "ONE ASK",
      "status": "PASS",
      "detail": "one call to action: save this"
    },
    {
      "check": "EMOJI",
      "status": "PASS",
      "detail": "0 emoji, 0.0 per 100 characters"
    }
  ],
  "verdict": "READY"
},
    text: "\nCAPTION LINT  \u00b7  165 / 2200 chars  \u00b7  2 hashtags  \u00b7  1 ask(s)\n==============================================================\n\n  WHAT THE FEED SHOWS\n  +------------------------------------------------------+\n  | We closed 3 clients in 14 days with one proposal     |\n  | template.                                            |\n  |                                                      |\n  | Here is the exact structure Maria used at Acme Co.   |\n  |                                                      |\n  | Save this for                                        |\n  +-------------------------------------------- ... more +\n\n  PASS  LENGTH            165 / 2200 characters\n  PASS  FIRST LINE        58 characters, lands whole\n  PASS  HOOK IS CONCRETE  4 number(s) or name(s) in the visible window\n  PASS  HASHTAGS          2 tag(s): #proposals #freelance\n  PASS  TAG PLACEMENT     tags are below the fold\n  PASS  LINKS             no dead links in the body\n  PASS  ONE ASK           one call to action: save this\n  PASS  EMOJI             0 emoji, 0.0 per 100 characters\n--------------------------------------------------------------\n  VERDICT  READY\n\n" },
  { name: "c2_emoji", input: "\ud83d\udd25\ud83d\udd25\ud83d\udd25 Big news \u2764\ufe0f \u2728 \ud83d\ude80 you will love this \ud83d\ude0d\ud83d\ude0d\nTell me which one you want", cut: 125, keywords: [""], exit: 1,
    expected: {
  "characters": 68,
  "limit": 2200,
  "truncate_at": 125,
  "visible": "🔥🔥🔥 Big news ❤️ ✨ 🚀 you will love this 😍😍\nTell me which one you want",
  "truncated": false,
  "first_line_chars": 41,
  "hashtags": [],
  "mentions": [],
  "links": [],
  "emoji": 9,
  "asks": [
    "answer a question"
  ],
  "checks": [
    {
      "check": "LENGTH",
      "status": "PASS",
      "detail": "68 / 2200 characters"
    },
    {
      "check": "FIRST LINE",
      "status": "PASS",
      "detail": "41 characters, lands whole"
    },
    {
      "check": "HOOK IS CONCRETE",
      "status": "PASS",
      "detail": "1 number(s) or name(s) in the visible window"
    },
    {
      "check": "HASHTAGS",
      "status": "PASS",
      "detail": "0 tag(s)"
    },
    {
      "check": "TAG PLACEMENT",
      "status": "PASS",
      "detail": "no tags to place"
    },
    {
      "check": "LINKS",
      "status": "PASS",
      "detail": "no dead links in the body"
    },
    {
      "check": "ONE ASK",
      "status": "PASS",
      "detail": "one call to action: answer a question"
    },
    {
      "check": "EMOJI",
      "status": "WARN",
      "detail": "9 emoji, 13.2 per 100 characters - reads as decoration"
    }
  ],
  "verdict": "REVIEW"
},
    text: "\nCAPTION LINT  \u00b7  68 / 2200 chars  \u00b7  0 hashtags  \u00b7  1 ask(s)\n==============================================================\n\n  WHAT THE FEED SHOWS\n  +------------------------------------------------------+\n  | \ud83d\udd25\ud83d\udd25\ud83d\udd25 Big news \u2764\ufe0f \u2728 \ud83d\ude80 you will love this \ud83d\ude0d\ud83d\ude0d            |\n  | Tell me which one you want                           |\n  +-------------------------------- (whole caption fits) +\n\n  PASS  LENGTH            68 / 2200 characters\n  PASS  FIRST LINE        41 characters, lands whole\n  PASS  HOOK IS CONCRETE  1 number(s) or name(s) in the visible window\n  PASS  HASHTAGS          0 tag(s)\n  PASS  TAG PLACEMENT     no tags to place\n  PASS  LINKS             no dead links in the body\n  PASS  ONE ASK           one call to action: answer a question\n  WARN  EMOJI             9 emoji, 13.2 per 100 characters - reads as decoration\n--------------------------------------------------------------\n  VERDICT  REVIEW\n\n" },
  { name: "c3_over", input: "Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word ", cut: 125, keywords: [""], exit: 1,
    expected: {
  "characters": 2499,
  "limit": 2200,
  "truncate_at": 125,
  "visible": "Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word Word ",
  "truncated": true,
  "first_line_chars": 2499,
  "hashtags": [],
  "mentions": [],
  "links": [],
  "emoji": 0,
  "asks": [],
  "checks": [
    {
      "check": "LENGTH",
      "status": "FAIL",
      "detail": "2499 / 2200 characters, 299 over the limit"
    },
    {
      "check": "FIRST LINE",
      "status": "WARN",
      "detail": "2499 characters, so it gets cut at 125 mid-thought. Fine if the cut is a cliffhanger, bad if it is a subordinate clause"
    },
    {
      "check": "HOOK IS CONCRETE",
      "status": "PASS",
      "detail": "24 number(s) or name(s) in the visible window"
    },
    {
      "check": "HASHTAGS",
      "status": "PASS",
      "detail": "0 tag(s)"
    },
    {
      "check": "TAG PLACEMENT",
      "status": "PASS",
      "detail": "no tags to place"
    },
    {
      "check": "LINKS",
      "status": "PASS",
      "detail": "no dead links in the body"
    },
    {
      "check": "ONE ASK",
      "status": "WARN",
      "detail": "no call to action. Decide what this post is for"
    },
    {
      "check": "EMOJI",
      "status": "PASS",
      "detail": "0 emoji, 0.0 per 100 characters"
    }
  ],
  "verdict": "FIX"
},
    text: "\nCAPTION LINT  \u00b7  2499 / 2200 chars  \u00b7  0 hashtags  \u00b7  0 ask(s)\n==============================================================\n\n  WHAT THE FEED SHOWS\n  +------------------------------------------------------+\n  | Word Word Word Word Word Word Word Word Word Word    |\n  | Word Word Word Word Word Word Word Word Word Word    |\n  | Word Word Word Word Word                             |\n  +-------------------------------------------- ... more +\n\n  FAIL  LENGTH            2499 / 2200 characters, 299 over the limit\n  WARN  FIRST LINE        2499 characters, so it gets cut at 125 mid-thought. Fine if the cut is a cliffhanger, bad if it is a subordinate clause\n  PASS  HOOK IS CONCRETE  24 number(s) or name(s) in the visible window\n  PASS  HASHTAGS          0 tag(s)\n  PASS  TAG PLACEMENT     no tags to place\n  PASS  LINKS             no dead links in the body\n  WARN  ONE ASK           no call to action. Decide what this post is for\n  PASS  EMOJI             0 emoji, 0.0 per 100 characters\n--------------------------------------------------------------\n  VERDICT  FIX\n\n" },
  { name: "c4_hash_first", input: "#viral #fyp #explore #love #follow #trending\nWhat a day in Paris with 12 friends", cut: 125, keywords: [""], exit: 1,
    expected: {
  "characters": 80,
  "limit": 2200,
  "truncate_at": 125,
  "visible": "#viral #fyp #explore #love #follow #trending\nWhat a day in Paris with 12 friends",
  "truncated": false,
  "first_line_chars": 44,
  "hashtags": [
    "#viral",
    "#fyp",
    "#explore",
    "#love",
    "#follow",
    "#trending"
  ],
  "mentions": [],
  "links": [],
  "emoji": 0,
  "asks": [],
  "checks": [
    {
      "check": "LENGTH",
      "status": "PASS",
      "detail": "80 / 2200 characters"
    },
    {
      "check": "FIRST LINE",
      "status": "FAIL",
      "detail": "opens on a hashtag or a mention, which is the one position worth a sentence"
    },
    {
      "check": "HOOK IS CONCRETE",
      "status": "PASS",
      "detail": "2 number(s) or name(s) in the visible window"
    },
    {
      "check": "HASHTAGS",
      "status": "FAIL",
      "detail": "6 tags, over Instagram's cap of 5. Tags past the fifth do not count and the block reads as old"
    },
    {
      "check": "TAG PLACEMENT",
      "status": "WARN",
      "detail": "a hashtag is inside the visible window, spending feed space on a label"
    },
    {
      "check": "LINKS",
      "status": "PASS",
      "detail": "no dead links in the body"
    },
    {
      "check": "ONE ASK",
      "status": "WARN",
      "detail": "no call to action. Decide what this post is for"
    },
    {
      "check": "EMOJI",
      "status": "PASS",
      "detail": "0 emoji, 0.0 per 100 characters"
    }
  ],
  "verdict": "FIX"
},
    text: "\nCAPTION LINT  \u00b7  80 / 2200 chars  \u00b7  6 hashtags  \u00b7  0 ask(s)\n==============================================================\n\n  WHAT THE FEED SHOWS\n  +------------------------------------------------------+\n  | #viral #fyp #explore #love #follow #trending         |\n  | What a day in Paris with 12 friends                  |\n  +-------------------------------- (whole caption fits) +\n\n  PASS  LENGTH            80 / 2200 characters\n  FAIL  FIRST LINE        opens on a hashtag or a mention, which is the one position worth a sentence\n  PASS  HOOK IS CONCRETE  2 number(s) or name(s) in the visible window\n  FAIL  HASHTAGS          6 tags, over Instagram's cap of 5. Tags past the fifth do not count and the block reads as old\n  WARN  TAG PLACEMENT     a hashtag is inside the visible window, spending feed space on a label\n  PASS  LINKS             no dead links in the body\n  WARN  ONE ASK           no call to action. Decide what this post is for\n  PASS  EMOJI             0 emoji, 0.0 per 100 characters\n--------------------------------------------------------------\n  VERDICT  FIX\n\n" },
  { name: "c5_links", input: "Grab the guide at https://example.com/guide or www.example.org/x or acme.io/deal now.\nDM me the word GUIDE and save this post. Follow me for more. Link in bio.\n@jake_s @other.user", cut: 125, keywords: [""], exit: 1,
    expected: {
  "characters": 179,
  "limit": 2200,
  "truncate_at": 125,
  "visible": "Grab the guide at https://example.com/guide or www.example.org/x or acme.io/deal now.\nDM me the word GUIDE and save this post",
  "truncated": true,
  "first_line_chars": 85,
  "hashtags": [],
  "mentions": [
    "@jake_s",
    "@other.user"
  ],
  "links": [
    "https://example.com/guide",
    "www.example.org/x",
    "acme.io/deal"
  ],
  "emoji": 0,
  "asks": [
    "DM me",
    "save this",
    "follow",
    "link in bio"
  ],
  "checks": [
    {
      "check": "LENGTH",
      "status": "PASS",
      "detail": "179 / 2200 characters"
    },
    {
      "check": "FIRST LINE",
      "status": "PASS",
      "detail": "85 characters, lands whole"
    },
    {
      "check": "HOOK IS CONCRETE",
      "status": "WARN",
      "detail": "0 number(s) or name(s) in the visible window - nothing checkable before the tap"
    },
    {
      "check": "HASHTAGS",
      "status": "PASS",
      "detail": "0 tag(s)"
    },
    {
      "check": "TAG PLACEMENT",
      "status": "PASS",
      "detail": "no tags to place"
    },
    {
      "check": "LINKS",
      "status": "WARN",
      "detail": "3 link(s) in the caption, and captions are not clickable. Move it to the bio or the DM"
    },
    {
      "check": "ONE ASK",
      "status": "WARN",
      "detail": "4 asks (DM me, save this, follow, link in bio). Two asks is the same as none"
    },
    {
      "check": "EMOJI",
      "status": "PASS",
      "detail": "0 emoji, 0.0 per 100 characters"
    }
  ],
  "verdict": "REVIEW"
},
    text: "\nCAPTION LINT  \u00b7  179 / 2200 chars  \u00b7  0 hashtags  \u00b7  4 ask(s)\n==============================================================\n\n  WHAT THE FEED SHOWS\n  +------------------------------------------------------+\n  | Grab the guide at https://example.com/guide or       |\n  | www.example.org/x or acme.io/deal now.               |\n  | DM me the word GUIDE and save this post              |\n  +-------------------------------------------- ... more +\n\n  PASS  LENGTH            179 / 2200 characters\n  PASS  FIRST LINE        85 characters, lands whole\n  WARN  HOOK IS CONCRETE  0 number(s) or name(s) in the visible window - nothing checkable before the tap\n  PASS  HASHTAGS          0 tag(s)\n  PASS  TAG PLACEMENT     no tags to place\n  WARN  LINKS             3 link(s) in the caption, and captions are not clickable. Move it to the bio or the DM\n  WARN  ONE ASK           4 asks (DM me, save this, follow, link in bio). Two asks is the same as none\n  PASS  EMOJI             0 emoji, 0.0 per 100 characters\n--------------------------------------------------------------\n  VERDICT  REVIEW\n\n" },
  { name: "c6_es", input: "C\u00f3mo gan\u00e9 $18,000 en Madrid con 3 clientes. Cami\u00f3n Ni\u00f1o Ni\u00f1a Ni\u00f1os\u00e9 Caf\u00e9 Mu\u00f1oz\n\n\u00bfCu\u00e1l prefieres? Cu\u00e9ntame (tell me)\n\n#caf\u00e9 #marketing #ventas", cut: 125, keywords: [""], exit: 0,
    expected: {
  "characters": 141,
  "limit": 2200,
  "truncate_at": 125,
  "visible": "Cómo gané $18,000 en Madrid con 3 clientes. Camión Niño Niña Niñosé Café Muñoz\n\n¿Cuál prefieres? Cuéntame (tell me)\n\n#café #m",
  "truncated": true,
  "first_line_chars": 78,
  "hashtags": [
    "#caf",
    "#marketing",
    "#ventas"
  ],
  "mentions": [],
  "links": [],
  "emoji": 0,
  "asks": [
    "answer a question"
  ],
  "checks": [
    {
      "check": "LENGTH",
      "status": "PASS",
      "detail": "141 / 2200 characters"
    },
    {
      "check": "FIRST LINE",
      "status": "PASS",
      "detail": "78 characters, lands whole"
    },
    {
      "check": "HOOK IS CONCRETE",
      "status": "PASS",
      "detail": "4 number(s) or name(s) in the visible window"
    },
    {
      "check": "HASHTAGS",
      "status": "PASS",
      "detail": "3 tag(s): #caf #marketing #ventas"
    },
    {
      "check": "TAG PLACEMENT",
      "status": "PASS",
      "detail": "tags are below the fold"
    },
    {
      "check": "LINKS",
      "status": "PASS",
      "detail": "no dead links in the body"
    },
    {
      "check": "ONE ASK",
      "status": "PASS",
      "detail": "one call to action: answer a question"
    },
    {
      "check": "EMOJI",
      "status": "PASS",
      "detail": "0 emoji, 0.0 per 100 characters"
    }
  ],
  "verdict": "READY"
},
    text: "\nCAPTION LINT  \u00b7  141 / 2200 chars  \u00b7  3 hashtags  \u00b7  1 ask(s)\n==============================================================\n\n  WHAT THE FEED SHOWS\n  +------------------------------------------------------+\n  | C\u00f3mo gan\u00e9 $18,000 en Madrid con 3 clientes. Cami\u00f3n   |\n  | Ni\u00f1o Ni\u00f1a Ni\u00f1os\u00e9 Caf\u00e9 Mu\u00f1oz                          |\n  |                                                      |\n  | \u00bfCu\u00e1l prefieres? Cu\u00e9ntame (tell me)                  |\n  |                                                      |\n  | #caf\u00e9 #m                                             |\n  +-------------------------------------------- ... more +\n\n  PASS  LENGTH            141 / 2200 characters\n  PASS  FIRST LINE        78 characters, lands whole\n  PASS  HOOK IS CONCRETE  4 number(s) or name(s) in the visible window\n  PASS  HASHTAGS          3 tag(s): #caf #marketing #ventas\n  PASS  TAG PLACEMENT     tags are below the fold\n  PASS  LINKS             no dead links in the body\n  PASS  ONE ASK           one call to action: answer a question\n  PASS  EMOJI             0 emoji, 0.0 per 100 characters\n--------------------------------------------------------------\n  VERDICT  READY\n\n" },
  { name: "c7_empty", input: "", cut: 125, keywords: [""], exit: 1,
    expected: {
  "characters": 0,
  "limit": 2200,
  "truncate_at": 125,
  "visible": "",
  "truncated": false,
  "first_line_chars": 0,
  "hashtags": [],
  "mentions": [],
  "links": [],
  "emoji": 0,
  "asks": [],
  "checks": [
    {
      "check": "LENGTH",
      "status": "PASS",
      "detail": "0 / 2200 characters"
    },
    {
      "check": "FIRST LINE",
      "status": "FAIL",
      "detail": "the caption opens on a blank line"
    },
    {
      "check": "HOOK IS CONCRETE",
      "status": "WARN",
      "detail": "0 number(s) or name(s) in the visible window - nothing checkable before the tap"
    },
    {
      "check": "HASHTAGS",
      "status": "PASS",
      "detail": "0 tag(s)"
    },
    {
      "check": "TAG PLACEMENT",
      "status": "PASS",
      "detail": "no tags to place"
    },
    {
      "check": "LINKS",
      "status": "PASS",
      "detail": "no dead links in the body"
    },
    {
      "check": "ONE ASK",
      "status": "WARN",
      "detail": "no call to action. Decide what this post is for"
    },
    {
      "check": "EMOJI",
      "status": "PASS",
      "detail": "0 emoji, 0.0 per 100 characters"
    }
  ],
  "verdict": "FIX"
},
    text: "\nCAPTION LINT  \u00b7  0 / 2200 chars  \u00b7  0 hashtags  \u00b7  0 ask(s)\n==============================================================\n\n  WHAT THE FEED SHOWS\n  +------------------------------------------------------+\n  |                                                      |\n  +-------------------------------- (whole caption fits) +\n\n  PASS  LENGTH            0 / 2200 characters\n  FAIL  FIRST LINE        the caption opens on a blank line\n  WARN  HOOK IS CONCRETE  0 number(s) or name(s) in the visible window - nothing checkable before the tap\n  PASS  HASHTAGS          0 tag(s)\n  PASS  TAG PLACEMENT     no tags to place\n  PASS  LINKS             no dead links in the body\n  WARN  ONE ASK           no call to action. Decide what this post is for\n  PASS  EMOJI             0 emoji, 0.0 per 100 characters\n--------------------------------------------------------------\n  VERDICT  FIX\n\n" },
  { name: "c8_blank_first", input: "\n\n   \nHello there Stranger, number 5\n", cut: 125, keywords: [""], exit: 1,
    expected: {
  "characters": 30,
  "limit": 2200,
  "truncate_at": 125,
  "visible": "Hello there Stranger, number 5",
  "truncated": false,
  "first_line_chars": 30,
  "hashtags": [],
  "mentions": [],
  "links": [],
  "emoji": 0,
  "asks": [],
  "checks": [
    {
      "check": "LENGTH",
      "status": "PASS",
      "detail": "30 / 2200 characters"
    },
    {
      "check": "FIRST LINE",
      "status": "PASS",
      "detail": "30 characters, lands whole"
    },
    {
      "check": "HOOK IS CONCRETE",
      "status": "PASS",
      "detail": "2 number(s) or name(s) in the visible window"
    },
    {
      "check": "HASHTAGS",
      "status": "PASS",
      "detail": "0 tag(s)"
    },
    {
      "check": "TAG PLACEMENT",
      "status": "PASS",
      "detail": "no tags to place"
    },
    {
      "check": "LINKS",
      "status": "PASS",
      "detail": "no dead links in the body"
    },
    {
      "check": "ONE ASK",
      "status": "WARN",
      "detail": "no call to action. Decide what this post is for"
    },
    {
      "check": "EMOJI",
      "status": "PASS",
      "detail": "0 emoji, 0.0 per 100 characters"
    }
  ],
  "verdict": "REVIEW"
},
    text: "\nCAPTION LINT  \u00b7  30 / 2200 chars  \u00b7  0 hashtags  \u00b7  0 ask(s)\n==============================================================\n\n  WHAT THE FEED SHOWS\n  +------------------------------------------------------+\n  | Hello there Stranger, number 5                       |\n  +-------------------------------- (whole caption fits) +\n\n  PASS  LENGTH            30 / 2200 characters\n  PASS  FIRST LINE        30 characters, lands whole\n  PASS  HOOK IS CONCRETE  2 number(s) or name(s) in the visible window\n  PASS  HASHTAGS          0 tag(s)\n  PASS  TAG PLACEMENT     no tags to place\n  PASS  LINKS             no dead links in the body\n  WARN  ONE ASK           no call to action. Decide what this post is for\n  PASS  EMOJI             0 emoji, 0.0 per 100 characters\n--------------------------------------------------------------\n  VERDICT  REVIEW\n\n" },
  { name: "c9_tab_long", input: "A\tstrange\ttabbed line with a-very-long-hyphenated-word-that-goes-on-and-on-and-on-forever-and-ever-and-ever-amen and Supercalifragilisticexpialidocious_Supercalifragilisticexpialidocious_Supercalifragilistic\nsecond -- line --- with dashes\nthird\nfourth", cut: 125, keywords: [""], exit: 1,
    expected: {
  "characters": 251,
  "limit": 2200,
  "truncate_at": 125,
  "visible": "A\tstrange\ttabbed line with a-very-long-hyphenated-word-that-goes-on-and-on-and-on-forever-and-ever-and-ever-amen and Supercal",
  "truncated": true,
  "first_line_chars": 207,
  "hashtags": [],
  "mentions": [],
  "links": [],
  "emoji": 0,
  "asks": [],
  "checks": [
    {
      "check": "LENGTH",
      "status": "PASS",
      "detail": "251 / 2200 characters"
    },
    {
      "check": "FIRST LINE",
      "status": "WARN",
      "detail": "207 characters, so it gets cut at 125 mid-thought. Fine if the cut is a cliffhanger, bad if it is a subordinate clause"
    },
    {
      "check": "HOOK IS CONCRETE",
      "status": "PASS",
      "detail": "1 number(s) or name(s) in the visible window"
    },
    {
      "check": "HASHTAGS",
      "status": "PASS",
      "detail": "0 tag(s)"
    },
    {
      "check": "TAG PLACEMENT",
      "status": "PASS",
      "detail": "no tags to place"
    },
    {
      "check": "LINKS",
      "status": "PASS",
      "detail": "no dead links in the body"
    },
    {
      "check": "ONE ASK",
      "status": "WARN",
      "detail": "no call to action. Decide what this post is for"
    },
    {
      "check": "EMOJI",
      "status": "PASS",
      "detail": "0 emoji, 0.0 per 100 characters"
    }
  ],
  "verdict": "REVIEW"
},
    text: "\nCAPTION LINT  \u00b7  251 / 2200 chars  \u00b7  0 hashtags  \u00b7  0 ask(s)\n==============================================================\n\n  WHAT THE FEED SHOWS\n  +------------------------------------------------------+\n  | A       strange tabbed line with a-very-long-        |\n  | hyphenated-word-that-goes-on-and-on-and-on-forever-  |\n  | and-ever-and-ever-amen and Supercal                  |\n  +-------------------------------------------- ... more +\n\n  PASS  LENGTH            251 / 2200 characters\n  WARN  FIRST LINE        207 characters, so it gets cut at 125 mid-thought. Fine if the cut is a cliffhanger, bad if it is a subordinate clause\n  PASS  HOOK IS CONCRETE  1 number(s) or name(s) in the visible window\n  PASS  HASHTAGS          0 tag(s)\n  PASS  TAG PLACEMENT     no tags to place\n  PASS  LINKS             no dead links in the body\n  WARN  ONE ASK           no call to action. Decide what this post is for\n  PASS  EMOJI             0 emoji, 0.0 per 100 characters\n--------------------------------------------------------------\n  VERDICT  REVIEW\n\n" },
  { name: "c10_five_filler", input: "Quick tip: 10 min a day. Comment GROW below.\n#viral #seo #love #pricing #ads", cut: 125, keywords: [""], exit: 1,
    expected: {
  "characters": 76,
  "limit": 2200,
  "truncate_at": 125,
  "visible": "Quick tip: 10 min a day. Comment GROW below.\n#viral #seo #love #pricing #ads",
  "truncated": false,
  "first_line_chars": 44,
  "hashtags": [
    "#viral",
    "#seo",
    "#love",
    "#pricing",
    "#ads"
  ],
  "mentions": [],
  "links": [],
  "emoji": 0,
  "asks": [
    "comment a keyword"
  ],
  "checks": [
    {
      "check": "LENGTH",
      "status": "PASS",
      "detail": "76 / 2200 characters"
    },
    {
      "check": "FIRST LINE",
      "status": "PASS",
      "detail": "44 characters, lands whole"
    },
    {
      "check": "HOOK IS CONCRETE",
      "status": "PASS",
      "detail": "2 number(s) or name(s) in the visible window"
    },
    {
      "check": "HASHTAGS",
      "status": "WARN",
      "detail": "5 tags, at the cap, and 2 of them generic. Spend the five on topics"
    },
    {
      "check": "TAG PLACEMENT",
      "status": "WARN",
      "detail": "a hashtag is inside the visible window, spending feed space on a label"
    },
    {
      "check": "LINKS",
      "status": "PASS",
      "detail": "no dead links in the body"
    },
    {
      "check": "ONE ASK",
      "status": "PASS",
      "detail": "one call to action: comment a keyword"
    },
    {
      "check": "EMOJI",
      "status": "PASS",
      "detail": "0 emoji, 0.0 per 100 characters"
    }
  ],
  "verdict": "REVIEW"
},
    text: "\nCAPTION LINT  \u00b7  76 / 2200 chars  \u00b7  5 hashtags  \u00b7  1 ask(s)\n==============================================================\n\n  WHAT THE FEED SHOWS\n  +------------------------------------------------------+\n  | Quick tip: 10 min a day. Comment GROW below.         |\n  | #viral #seo #love #pricing #ads                      |\n  +-------------------------------- (whole caption fits) +\n\n  PASS  LENGTH            76 / 2200 characters\n  PASS  FIRST LINE        44 characters, lands whole\n  PASS  HOOK IS CONCRETE  2 number(s) or name(s) in the visible window\n  WARN  HASHTAGS          5 tags, at the cap, and 2 of them generic. Spend the five on topics\n  WARN  TAG PLACEMENT     a hashtag is inside the visible window, spending feed space on a label\n  PASS  LINKS             no dead links in the body\n  PASS  ONE ASK           one call to action: comment a keyword\n  PASS  EMOJI             0 emoji, 0.0 per 100 characters\n--------------------------------------------------------------\n  VERDICT  REVIEW\n\n" },
  { name: "c11_bom", input: "\ufeffBOM caption about Chicago 2024 pricing. Share this!", cut: 125, keywords: [""], exit: 0,
    expected: {
  "characters": 52,
  "limit": 2200,
  "truncate_at": 125,
  "visible": "﻿BOM caption about Chicago 2024 pricing. Share this!",
  "truncated": false,
  "first_line_chars": 52,
  "hashtags": [],
  "mentions": [],
  "links": [],
  "emoji": 0,
  "asks": [
    "share this"
  ],
  "checks": [
    {
      "check": "LENGTH",
      "status": "PASS",
      "detail": "52 / 2200 characters"
    },
    {
      "check": "FIRST LINE",
      "status": "PASS",
      "detail": "52 characters, lands whole"
    },
    {
      "check": "HOOK IS CONCRETE",
      "status": "PASS",
      "detail": "3 number(s) or name(s) in the visible window"
    },
    {
      "check": "HASHTAGS",
      "status": "PASS",
      "detail": "0 tag(s)"
    },
    {
      "check": "TAG PLACEMENT",
      "status": "PASS",
      "detail": "no tags to place"
    },
    {
      "check": "LINKS",
      "status": "PASS",
      "detail": "no dead links in the body"
    },
    {
      "check": "ONE ASK",
      "status": "PASS",
      "detail": "one call to action: share this"
    },
    {
      "check": "EMOJI",
      "status": "PASS",
      "detail": "0 emoji, 0.0 per 100 characters"
    }
  ],
  "verdict": "READY"
},
    text: "\nCAPTION LINT  \u00b7  52 / 2200 chars  \u00b7  0 hashtags  \u00b7  1 ask(s)\n==============================================================\n\n  WHAT THE FEED SHOWS\n  +------------------------------------------------------+\n  | \ufeffBOM caption about Chicago 2024 pricing. Share this! |\n  +-------------------------------- (whole caption fits) +\n\n  PASS  LENGTH            52 / 2200 characters\n  PASS  FIRST LINE        52 characters, lands whole\n  PASS  HOOK IS CONCRETE  3 number(s) or name(s) in the visible window\n  PASS  HASHTAGS          0 tag(s)\n  PASS  TAG PLACEMENT     no tags to place\n  PASS  LINKS             no dead links in the body\n  PASS  ONE ASK           one call to action: share this\n  PASS  EMOJI             0 emoji, 0.0 per 100 characters\n--------------------------------------------------------------\n  VERDICT  READY\n\n" },
  { name: "c12_emoji_tie", input: "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\ud83d\udd25 !", cut: 125, keywords: [""], exit: 1,
    expected: {
  "characters": 399,
  "limit": 2200,
  "truncate_at": 125,
  "visible": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "truncated": true,
  "first_line_chars": 399,
  "hashtags": [],
  "mentions": [],
  "links": [],
  "emoji": 1,
  "asks": [],
  "checks": [
    {
      "check": "LENGTH",
      "status": "PASS",
      "detail": "399 / 2200 characters"
    },
    {
      "check": "FIRST LINE",
      "status": "WARN",
      "detail": "399 characters, so it gets cut at 125 mid-thought. Fine if the cut is a cliffhanger, bad if it is a subordinate clause"
    },
    {
      "check": "HOOK IS CONCRETE",
      "status": "WARN",
      "detail": "0 number(s) or name(s) in the visible window - nothing checkable before the tap"
    },
    {
      "check": "HASHTAGS",
      "status": "PASS",
      "detail": "0 tag(s)"
    },
    {
      "check": "TAG PLACEMENT",
      "status": "PASS",
      "detail": "no tags to place"
    },
    {
      "check": "LINKS",
      "status": "PASS",
      "detail": "no dead links in the body"
    },
    {
      "check": "ONE ASK",
      "status": "WARN",
      "detail": "no call to action. Decide what this post is for"
    },
    {
      "check": "EMOJI",
      "status": "PASS",
      "detail": "1 emoji, 0.3 per 100 characters"
    }
  ],
  "verdict": "REVIEW"
},
    text: "\nCAPTION LINT  \u00b7  399 / 2200 chars  \u00b7  0 hashtags  \u00b7  0 ask(s)\n==============================================================\n\n  WHAT THE FEED SHOWS\n  +------------------------------------------------------+\n  | xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx |\n  | xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx |\n  | xxxxxxxxxxxxxxxxxxxxx                                |\n  +-------------------------------------------- ... more +\n\n  PASS  LENGTH            399 / 2200 characters\n  WARN  FIRST LINE        399 characters, so it gets cut at 125 mid-thought. Fine if the cut is a cliffhanger, bad if it is a subordinate clause\n  WARN  HOOK IS CONCRETE  0 number(s) or name(s) in the visible window - nothing checkable before the tap\n  PASS  HASHTAGS          0 tag(s)\n  PASS  TAG PLACEMENT     no tags to place\n  PASS  LINKS             no dead links in the body\n  WARN  ONE ASK           no call to action. Decide what this post is for\n  PASS  EMOJI             1 emoji, 0.3 per 100 characters\n--------------------------------------------------------------\n  VERDICT  REVIEW\n\n" },
  { name: "c13_tag_window", input: "Great #pricing tips from Bob in #marketing. Link in bio. zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz #tail #ends", cut: 125, keywords: [""], exit: 1,
    expected: {
  "characters": 269,
  "limit": 2200,
  "truncate_at": 125,
  "visible": "Great #pricing tips from Bob in #marketing. Link in bio. zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz",
  "truncated": true,
  "first_line_chars": 269,
  "hashtags": [
    "#pricing",
    "#marketing",
    "#tail",
    "#ends"
  ],
  "mentions": [],
  "links": [],
  "emoji": 0,
  "asks": [
    "link in bio"
  ],
  "checks": [
    {
      "check": "LENGTH",
      "status": "PASS",
      "detail": "269 / 2200 characters"
    },
    {
      "check": "FIRST LINE",
      "status": "WARN",
      "detail": "269 characters, so it gets cut at 125 mid-thought. Fine if the cut is a cliffhanger, bad if it is a subordinate clause"
    },
    {
      "check": "HOOK IS CONCRETE",
      "status": "PASS",
      "detail": "2 number(s) or name(s) in the visible window"
    },
    {
      "check": "HASHTAGS",
      "status": "PASS",
      "detail": "4 tag(s): #pricing #marketing #tail #ends"
    },
    {
      "check": "TAG PLACEMENT",
      "status": "WARN",
      "detail": "a hashtag is inside the visible window, spending feed space on a label"
    },
    {
      "check": "LINKS",
      "status": "PASS",
      "detail": "no dead links in the body"
    },
    {
      "check": "ONE ASK",
      "status": "PASS",
      "detail": "one call to action: link in bio"
    },
    {
      "check": "EMOJI",
      "status": "PASS",
      "detail": "0 emoji, 0.0 per 100 characters"
    }
  ],
  "verdict": "REVIEW"
},
    text: "\nCAPTION LINT  \u00b7  269 / 2200 chars  \u00b7  4 hashtags  \u00b7  1 ask(s)\n==============================================================\n\n  WHAT THE FEED SHOWS\n  +------------------------------------------------------+\n  | Great #pricing tips from Bob in #marketing. Link in  |\n  | bio. zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz |\n  | zzzzzzzzzzzzzzzzzzzzz                                |\n  +-------------------------------------------- ... more +\n\n  PASS  LENGTH            269 / 2200 characters\n  WARN  FIRST LINE        269 characters, so it gets cut at 125 mid-thought. Fine if the cut is a cliffhanger, bad if it is a subordinate clause\n  PASS  HOOK IS CONCRETE  2 number(s) or name(s) in the visible window\n  PASS  HASHTAGS          4 tag(s): #pricing #marketing #tail #ends\n  WARN  TAG PLACEMENT     a hashtag is inside the visible window, spending feed space on a label\n  PASS  LINKS             no dead links in the body\n  PASS  ONE ASK           one call to action: link in bio\n  PASS  EMOJI             0 emoji, 0.0 per 100 characters\n--------------------------------------------------------------\n  VERDICT  REVIEW\n\n" },
  { name: "c1_good --keywords proposal template, client contract,Acme", input: "We closed 3 clients in 14 days with one proposal template.\n\nHere is the exact structure Maria used at Acme Co.\n\nSave this for your next pitch.\n\n#proposals #freelance", cut: 125, keywords: ["proposal template", " client contract", "Acme"], exit: 1,
    expected: {
  "characters": 165,
  "limit": 2200,
  "truncate_at": 125,
  "visible": "We closed 3 clients in 14 days with one proposal template.\n\nHere is the exact structure Maria used at Acme Co.\n\nSave this for",
  "truncated": true,
  "first_line_chars": 58,
  "hashtags": [
    "#proposals",
    "#freelance"
  ],
  "mentions": [],
  "links": [],
  "emoji": 0,
  "asks": [
    "save this"
  ],
  "checks": [
    {
      "check": "LENGTH",
      "status": "PASS",
      "detail": "165 / 2200 characters"
    },
    {
      "check": "FIRST LINE",
      "status": "PASS",
      "detail": "58 characters, lands whole"
    },
    {
      "check": "HOOK IS CONCRETE",
      "status": "PASS",
      "detail": "4 number(s) or name(s) in the visible window"
    },
    {
      "check": "HASHTAGS",
      "status": "PASS",
      "detail": "2 tag(s): #proposals #freelance"
    },
    {
      "check": "TAG PLACEMENT",
      "status": "PASS",
      "detail": "tags are below the fold"
    },
    {
      "check": "LINKS",
      "status": "PASS",
      "detail": "no dead links in the body"
    },
    {
      "check": "ONE ASK",
      "status": "PASS",
      "detail": "one call to action: save this"
    },
    {
      "check": "EMOJI",
      "status": "PASS",
      "detail": "0 emoji, 0.0 per 100 characters"
    },
    {
      "check": "SEARCH TERMS",
      "status": "WARN",
      "detail": "2/3 present, 2 in the visible window. Missing: client contract"
    }
  ],
  "verdict": "REVIEW"
},
    text: "\nCAPTION LINT  \u00b7  165 / 2200 chars  \u00b7  2 hashtags  \u00b7  1 ask(s)\n==============================================================\n\n  WHAT THE FEED SHOWS\n  +------------------------------------------------------+\n  | We closed 3 clients in 14 days with one proposal     |\n  | template.                                            |\n  |                                                      |\n  | Here is the exact structure Maria used at Acme Co.   |\n  |                                                      |\n  | Save this for                                        |\n  +-------------------------------------------- ... more +\n\n  PASS  LENGTH            165 / 2200 characters\n  PASS  FIRST LINE        58 characters, lands whole\n  PASS  HOOK IS CONCRETE  4 number(s) or name(s) in the visible window\n  PASS  HASHTAGS          2 tag(s): #proposals #freelance\n  PASS  TAG PLACEMENT     tags are below the fold\n  PASS  LINKS             no dead links in the body\n  PASS  ONE ASK           one call to action: save this\n  PASS  EMOJI             0 emoji, 0.0 per 100 characters\n  WARN  SEARCH TERMS      2/3 present, 2 in the visible window. Missing: client contract\n--------------------------------------------------------------\n  VERDICT  REVIEW\n\n" },
  { name: "c6_es --truncate 60 --keywords marketing,Ventas, nada", input: "C\u00f3mo gan\u00e9 $18,000 en Madrid con 3 clientes. Cami\u00f3n Ni\u00f1o Ni\u00f1a Ni\u00f1os\u00e9 Caf\u00e9 Mu\u00f1oz\n\n\u00bfCu\u00e1l prefieres? Cu\u00e9ntame (tell me)\n\n#caf\u00e9 #marketing #ventas", cut: 60, keywords: ["marketing", "Ventas", " nada"], exit: 1,
    expected: {
  "characters": 141,
  "limit": 2200,
  "truncate_at": 60,
  "visible": "Cómo gané $18,000 en Madrid con 3 clientes. Camión Niño Niña",
  "truncated": true,
  "first_line_chars": 78,
  "hashtags": [
    "#caf",
    "#marketing",
    "#ventas"
  ],
  "mentions": [],
  "links": [],
  "emoji": 0,
  "asks": [
    "answer a question"
  ],
  "checks": [
    {
      "check": "LENGTH",
      "status": "PASS",
      "detail": "141 / 2200 characters"
    },
    {
      "check": "FIRST LINE",
      "status": "WARN",
      "detail": "78 characters, so it gets cut at 60 mid-thought. Fine if the cut is a cliffhanger, bad if it is a subordinate clause"
    },
    {
      "check": "HOOK IS CONCRETE",
      "status": "PASS",
      "detail": "4 number(s) or name(s) in the visible window"
    },
    {
      "check": "HASHTAGS",
      "status": "PASS",
      "detail": "3 tag(s): #caf #marketing #ventas"
    },
    {
      "check": "TAG PLACEMENT",
      "status": "PASS",
      "detail": "tags are below the fold"
    },
    {
      "check": "LINKS",
      "status": "PASS",
      "detail": "no dead links in the body"
    },
    {
      "check": "ONE ASK",
      "status": "PASS",
      "detail": "one call to action: answer a question"
    },
    {
      "check": "EMOJI",
      "status": "PASS",
      "detail": "0 emoji, 0.0 per 100 characters"
    },
    {
      "check": "SEARCH TERMS",
      "status": "WARN",
      "detail": "2/3 present, 0 in the visible window. Missing: nada"
    }
  ],
  "verdict": "REVIEW"
},
    text: "\nCAPTION LINT  \u00b7  141 / 2200 chars  \u00b7  3 hashtags  \u00b7  1 ask(s)\n==============================================================\n\n  WHAT THE FEED SHOWS\n  +------------------------------------------------------+\n  | C\u00f3mo gan\u00e9 $18,000 en Madrid con 3 clientes. Cami\u00f3n   |\n  | Ni\u00f1o Ni\u00f1a                                            |\n  +-------------------------------------------- ... more +\n\n  PASS  LENGTH            141 / 2200 characters\n  WARN  FIRST LINE        78 characters, so it gets cut at 60 mid-thought. Fine if the cut is a cliffhanger, bad if it is a subordinate clause\n  PASS  HOOK IS CONCRETE  4 number(s) or name(s) in the visible window\n  PASS  HASHTAGS          3 tag(s): #caf #marketing #ventas\n  PASS  TAG PLACEMENT     tags are below the fold\n  PASS  LINKS             no dead links in the body\n  PASS  ONE ASK           one call to action: answer a question\n  PASS  EMOJI             0 emoji, 0.0 per 100 characters\n  WARN  SEARCH TERMS      2/3 present, 0 in the visible window. Missing: nada\n--------------------------------------------------------------\n  VERDICT  REVIEW\n\n" },
  { name: "c13_tag_window --truncate=80", input: "Great #pricing tips from Bob in #marketing. Link in bio. zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz #tail #ends", cut: 80, keywords: [""], exit: 1,
    expected: {
  "characters": 269,
  "limit": 2200,
  "truncate_at": 80,
  "visible": "Great #pricing tips from Bob in #marketing. Link in bio. zzzzzzzzzzzzzzzzzzzzzzz",
  "truncated": true,
  "first_line_chars": 269,
  "hashtags": [
    "#pricing",
    "#marketing",
    "#tail",
    "#ends"
  ],
  "mentions": [],
  "links": [],
  "emoji": 0,
  "asks": [
    "link in bio"
  ],
  "checks": [
    {
      "check": "LENGTH",
      "status": "PASS",
      "detail": "269 / 2200 characters"
    },
    {
      "check": "FIRST LINE",
      "status": "WARN",
      "detail": "269 characters, so it gets cut at 80 mid-thought. Fine if the cut is a cliffhanger, bad if it is a subordinate clause"
    },
    {
      "check": "HOOK IS CONCRETE",
      "status": "PASS",
      "detail": "2 number(s) or name(s) in the visible window"
    },
    {
      "check": "HASHTAGS",
      "status": "PASS",
      "detail": "4 tag(s): #pricing #marketing #tail #ends"
    },
    {
      "check": "TAG PLACEMENT",
      "status": "WARN",
      "detail": "a hashtag is inside the visible window, spending feed space on a label"
    },
    {
      "check": "LINKS",
      "status": "PASS",
      "detail": "no dead links in the body"
    },
    {
      "check": "ONE ASK",
      "status": "PASS",
      "detail": "one call to action: link in bio"
    },
    {
      "check": "EMOJI",
      "status": "PASS",
      "detail": "0 emoji, 0.0 per 100 characters"
    }
  ],
  "verdict": "REVIEW"
},
    text: "\nCAPTION LINT  \u00b7  269 / 2200 chars  \u00b7  4 hashtags  \u00b7  1 ask(s)\n==============================================================\n\n  WHAT THE FEED SHOWS\n  +------------------------------------------------------+\n  | Great #pricing tips from Bob in #marketing. Link in  |\n  | bio. zzzzzzzzzzzzzzzzzzzzzzz                         |\n  +-------------------------------------------- ... more +\n\n  PASS  LENGTH            269 / 2200 characters\n  WARN  FIRST LINE        269 characters, so it gets cut at 80 mid-thought. Fine if the cut is a cliffhanger, bad if it is a subordinate clause\n  PASS  HOOK IS CONCRETE  2 number(s) or name(s) in the visible window\n  PASS  HASHTAGS          4 tag(s): #pricing #marketing #tail #ends\n  WARN  TAG PLACEMENT     a hashtag is inside the visible window, spending feed space on a label\n  PASS  LINKS             no dead links in the body\n  PASS  ONE ASK           one call to action: link in bio\n  PASS  EMOJI             0 emoji, 0.0 per 100 characters\n--------------------------------------------------------------\n  VERDICT  REVIEW\n\n" },
  { name: "c9_tab_long --truncate 200", input: "A\tstrange\ttabbed line with a-very-long-hyphenated-word-that-goes-on-and-on-and-on-forever-and-ever-and-ever-amen and Supercalifragilisticexpialidocious_Supercalifragilisticexpialidocious_Supercalifragilistic\nsecond -- line --- with dashes\nthird\nfourth", cut: 200, keywords: [""], exit: 1,
    expected: {
  "characters": 251,
  "limit": 2200,
  "truncate_at": 200,
  "visible": "A\tstrange\ttabbed line with a-very-long-hyphenated-word-that-goes-on-and-on-and-on-forever-and-ever-and-ever-amen and Supercalifragilisticexpialidocious_Supercalifragilisticexpialidocious_Supercalifrag",
  "truncated": true,
  "first_line_chars": 207,
  "hashtags": [],
  "mentions": [],
  "links": [],
  "emoji": 0,
  "asks": [],
  "checks": [
    {
      "check": "LENGTH",
      "status": "PASS",
      "detail": "251 / 2200 characters"
    },
    {
      "check": "FIRST LINE",
      "status": "WARN",
      "detail": "207 characters, so it gets cut at 200 mid-thought. Fine if the cut is a cliffhanger, bad if it is a subordinate clause"
    },
    {
      "check": "HOOK IS CONCRETE",
      "status": "WARN",
      "detail": "0 number(s) or name(s) in the visible window - nothing checkable before the tap"
    },
    {
      "check": "HASHTAGS",
      "status": "PASS",
      "detail": "0 tag(s)"
    },
    {
      "check": "TAG PLACEMENT",
      "status": "PASS",
      "detail": "no tags to place"
    },
    {
      "check": "LINKS",
      "status": "PASS",
      "detail": "no dead links in the body"
    },
    {
      "check": "ONE ASK",
      "status": "WARN",
      "detail": "no call to action. Decide what this post is for"
    },
    {
      "check": "EMOJI",
      "status": "PASS",
      "detail": "0 emoji, 0.0 per 100 characters"
    }
  ],
  "verdict": "REVIEW"
},
    text: "\nCAPTION LINT  \u00b7  251 / 2200 chars  \u00b7  0 hashtags  \u00b7  0 ask(s)\n==============================================================\n\n  WHAT THE FEED SHOWS\n  +------------------------------------------------------+\n  | A       strange tabbed line with a-very-long-        |\n  | hyphenated-word-that-goes-on-and-on-and-on-forever-  |\n  | and-ever-and-ever-amen and Supercalifragilisticexpia |\n  | lidocious_Supercalifragilisticexpialidocious_Superca |\n  | lifrag                                               |\n  +-------------------------------------------- ... more +\n\n  PASS  LENGTH            251 / 2200 characters\n  WARN  FIRST LINE        207 characters, so it gets cut at 200 mid-thought. Fine if the cut is a cliffhanger, bad if it is a subordinate clause\n  WARN  HOOK IS CONCRETE  0 number(s) or name(s) in the visible window - nothing checkable before the tap\n  PASS  HASHTAGS          0 tag(s)\n  PASS  TAG PLACEMENT     no tags to place\n  PASS  LINKS             no dead links in the body\n  WARN  ONE ASK           no call to action. Decide what this post is for\n  PASS  EMOJI             0 emoji, 0.0 per 100 characters\n--------------------------------------------------------------\n  VERDICT  REVIEW\n\n" },
  { name: "c12_emoji_tie --keywords", input: "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\ud83d\udd25 !", cut: 125, keywords: [""], exit: 1,
    expected: {
  "characters": 399,
  "limit": 2200,
  "truncate_at": 125,
  "visible": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "truncated": true,
  "first_line_chars": 399,
  "hashtags": [],
  "mentions": [],
  "links": [],
  "emoji": 1,
  "asks": [],
  "checks": [
    {
      "check": "LENGTH",
      "status": "PASS",
      "detail": "399 / 2200 characters"
    },
    {
      "check": "FIRST LINE",
      "status": "WARN",
      "detail": "399 characters, so it gets cut at 125 mid-thought. Fine if the cut is a cliffhanger, bad if it is a subordinate clause"
    },
    {
      "check": "HOOK IS CONCRETE",
      "status": "WARN",
      "detail": "0 number(s) or name(s) in the visible window - nothing checkable before the tap"
    },
    {
      "check": "HASHTAGS",
      "status": "PASS",
      "detail": "0 tag(s)"
    },
    {
      "check": "TAG PLACEMENT",
      "status": "PASS",
      "detail": "no tags to place"
    },
    {
      "check": "LINKS",
      "status": "PASS",
      "detail": "no dead links in the body"
    },
    {
      "check": "ONE ASK",
      "status": "WARN",
      "detail": "no call to action. Decide what this post is for"
    },
    {
      "check": "EMOJI",
      "status": "PASS",
      "detail": "1 emoji, 0.3 per 100 characters"
    }
  ],
  "verdict": "REVIEW"
},
    text: "\nCAPTION LINT  \u00b7  399 / 2200 chars  \u00b7  0 hashtags  \u00b7  0 ask(s)\n==============================================================\n\n  WHAT THE FEED SHOWS\n  +------------------------------------------------------+\n  | xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx |\n  | xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx |\n  | xxxxxxxxxxxxxxxxxxxxx                                |\n  +-------------------------------------------- ... more +\n\n  PASS  LENGTH            399 / 2200 characters\n  WARN  FIRST LINE        399 characters, so it gets cut at 125 mid-thought. Fine if the cut is a cliffhanger, bad if it is a subordinate clause\n  WARN  HOOK IS CONCRETE  0 number(s) or name(s) in the visible window - nothing checkable before the tap\n  PASS  HASHTAGS          0 tag(s)\n  PASS  TAG PLACEMENT     no tags to place\n  PASS  LINKS             no dead links in the body\n  WARN  ONE ASK           no call to action. Decide what this post is for\n  PASS  EMOJI             1 emoji, 0.3 per 100 characters\n--------------------------------------------------------------\n  VERDICT  REVIEW\n\n" },
];

const BEATS: Array<{ name: string; input: string; wpm: number; wpmGiven: boolean; target: number | null; exit: number; json: string; text: string }> = [
  { name: "b1_basic", input: "Stop losing $18,000 a year to bad proposals.\nHere is what Maria changed at Acme.\nShe sent one page instead of twelve.\nClients said yes in 3 days.\nStop losing proposals today.", wpm: 165, wpmGiven: false, target: null, exit: 0,
    json: "{\n  \"wpm\": 165,\n  \"target\": null,\n  \"total_seconds\": 11.64,\n  \"total_words\": 32,\n  \"beats\": [\n    {\n      \"n\": 1,\n      \"start\": 0.0,\n      \"dur\": 2.91,\n      \"words\": 8,\n      \"text\": \"Stop losing $18,000 a year to bad proposals.\",\n      \"concrete\": 2,\n      \"label\": \"HOOK\",\n      \"flags\": []\n    },\n    {\n      \"n\": 2,\n      \"start\": 2.91,\n      \"dur\": 2.55,\n      \"words\": 7,\n      \"text\": \"Here is what Maria changed at Acme.\",\n      \"concrete\": 2,\n      \"label\": \"\",\n      \"flags\": []\n    },\n    {\n      \"n\": 3,\n      \"start\": 5.45,\n      \"dur\": 2.55,\n      \"words\": 7,\n      \"text\": \"She sent one page instead of twelve.\",\n      \"concrete\": 0,\n      \"label\": \"MID\",\n      \"flags\": []\n    },\n    {\n      \"n\": 4,\n      \"start\": 8.0,\n      \"dur\": 2.18,\n      \"words\": 6,\n      \"text\": \"Clients said yes in 3 days.\",\n      \"concrete\": 1,\n      \"label\": \"\",\n      \"flags\": []\n    },\n    {\n      \"n\": 5,\n      \"start\": 10.18,\n      \"dur\": 1.45,\n      \"words\": 4,\n      \"text\": \"Stop losing proposals today.\",\n      \"concrete\": 0,\n      \"label\": \"CTA\",\n      \"flags\": []\n    }\n  ],\n  \"notes\": [\n    \"Loops: the last beat repeats \\\"losing, proposals, stop\\\" from the hook. Second watches are free reach.\"\n  ]\n}\n",
    text: "\nBEAT SHEET  \u00b7  32 words  \u00b7  ~11.6s at 165 wpm\n========================================================================\n  0:00.0   2.9s  HOOK    Stop losing $18,000 a year to bad proposals.\n  0:02.9   2.5s          Here is what Maria changed at Acme.\n  0:05.5   2.5s  MID     She sent one page instead of twelve.\n  0:08.0   2.2s          Clients said yes in 3 days.\n  0:10.2   1.4s  CTA     Stop losing proposals today.\n------------------------------------------------------------------------\n  - Loops: the last beat repeats \"losing, proposals, stop\" from the hook. Second watches are free reach.\n\n" },
  { name: "b2_long_hook", input: "This is a very long opening line that rambles on and on without any number or name until the viewer has long since left the building for good\nsecond\nthird line abstract\nfourth line abstract\nfifth line abstract", wpm: 165, wpmGiven: false, target: null, exit: 0,
    json: "{\n  \"wpm\": 165,\n  \"target\": null,\n  \"total_seconds\": 13.82,\n  \"total_words\": 38,\n  \"beats\": [\n    {\n      \"n\": 1,\n      \"start\": 0.0,\n      \"dur\": 10.18,\n      \"words\": 28,\n      \"text\": \"This is a very long opening line that rambles on and on without any number or name until the viewer has long since left the building for good\",\n      \"concrete\": 0,\n      \"label\": \"HOOK\",\n      \"flags\": [\n        \"hook runs 10.2s, past the 3s mark\",\n        \"10.2s on one beat\"\n      ]\n    },\n    {\n      \"n\": 2,\n      \"start\": 10.18,\n      \"dur\": 0.36,\n      \"words\": 1,\n      \"text\": \"second\",\n      \"concrete\": 0,\n      \"label\": \"\",\n      \"flags\": []\n    },\n    {\n      \"n\": 3,\n      \"start\": 10.55,\n      \"dur\": 1.09,\n      \"words\": 3,\n      \"text\": \"third line abstract\",\n      \"concrete\": 0,\n      \"label\": \"\",\n      \"flags\": []\n    },\n    {\n      \"n\": 4,\n      \"start\": 11.64,\n      \"dur\": 1.09,\n      \"words\": 3,\n      \"text\": \"fourth line abstract\",\n      \"concrete\": 0,\n      \"label\": \"\",\n      \"flags\": []\n    },\n    {\n      \"n\": 5,\n      \"start\": 12.73,\n      \"dur\": 1.09,\n      \"words\": 3,\n      \"text\": \"fifth line abstract\",\n      \"concrete\": 0,\n      \"label\": \"CTA\",\n      \"flags\": []\n    }\n  ],\n  \"notes\": [\n    \"Beat 1 takes 10.2s to say. Cut it to 8 words or fewer, or the hook lands after the decision has been made.\",\n    \"Beat 1 has no number and no name in it. Hooks without something checkable are the ones that get scrolled.\",\n    \"Beat(s) 1 run past 4s. Either split the line or change what is on screen inside it. A static frame is where people leave.\",\n    \"Beats 1-3 have nothing concrete in them. Put a number, a name or a price in one of them.\",\n    \"Loops: the last beat repeats \\\"line\\\" from the hook. Second watches are free reach.\"\n  ]\n}\n",
    text: "\nBEAT SHEET  \u00b7  38 words  \u00b7  ~13.8s at 165 wpm\n========================================================================\n  0:00.0  10.2s  HOOK    This is a very long opening line that rambles on and on without any number or name until the viewer has long since left the building for good\n                         ^ hook runs 10.2s, past the 3s mark\n                         ^ 10.2s on one beat\n  0:10.2   0.4s          second\n  0:10.6   1.1s          third line abstract\n  0:11.6   1.1s          fourth line abstract\n  0:12.7   1.1s  CTA     fifth line abstract\n------------------------------------------------------------------------\n  - Beat 1 takes 10.2s to say. Cut it to 8 words or fewer, or the hook lands after the decision has been made.\n  - Beat 1 has no number and no name in it. Hooks without something checkable are the ones that get scrolled.\n  - Beat(s) 1 run past 4s. Either split the line or change what is on screen inside it. A static frame is where people leave.\n  - Beats 1-3 have nothing concrete in them. Put a number, a name or a price in one of them.\n  - Loops: the last beat repeats \"line\" from the hook. Second watches are free reach.\n\n" },
  { name: "b3_paragraph", input: "Most freelancers lose deals before they even start. They send a long deck. They wait a week. They chase. The client moves on to somebody else who answered faster than they did on Monday. Here is the fix that Maria used with Acme in 2024, and it takes about ten minutes to set up. First you write one page. Then you send it the same day. Then you follow up in 48 hours with a short note and a price.", wpm: 165, wpmGiven: false, target: null, exit: 0,
    json: "{\n  \"wpm\": 165,\n  \"target\": null,\n  \"total_seconds\": 29.09,\n  \"total_words\": 80,\n  \"beats\": [\n    {\n      \"n\": 1,\n      \"start\": 0.0,\n      \"dur\": 2.91,\n      \"words\": 8,\n      \"text\": \"Most freelancers lose deals before they even start.\",\n      \"concrete\": 0,\n      \"label\": \"HOOK\",\n      \"flags\": []\n    },\n    {\n      \"n\": 2,\n      \"start\": 2.91,\n      \"dur\": 4.0,\n      \"words\": 11,\n      \"text\": \"They send a long deck. They wait a week. They chase.\",\n      \"concrete\": 2,\n      \"label\": \"\",\n      \"flags\": []\n    },\n    {\n      \"n\": 3,\n      \"start\": 6.91,\n      \"dur\": 5.45,\n      \"words\": 15,\n      \"text\": \"The client moves on to somebody else who answered faster than they did on Monday.\",\n      \"concrete\": 1,\n      \"label\": \"\",\n      \"flags\": [\n        \"5.5s on one beat\"\n      ]\n    },\n    {\n      \"n\": 4,\n      \"start\": 12.36,\n      \"dur\": 7.27,\n      \"words\": 20,\n      \"text\": \"Here is the fix that Maria used with Acme in 2024, and it takes about ten minutes to set up.\",\n      \"concrete\": 3,\n      \"label\": \"MID\",\n      \"flags\": [\n        \"7.3s on one beat\"\n      ]\n    },\n    {\n      \"n\": 5,\n      \"start\": 19.64,\n      \"dur\": 1.82,\n      \"words\": 5,\n      \"text\": \"First you write one page.\",\n      \"concrete\": 0,\n      \"label\": \"\",\n      \"flags\": []\n    },\n    {\n      \"n\": 6,\n      \"start\": 21.45,\n      \"dur\": 2.55,\n      \"words\": 7,\n      \"text\": \"Then you send it the same day.\",\n      \"concrete\": 0,\n      \"label\": \"\",\n      \"flags\": []\n    },\n    {\n      \"n\": 7,\n      \"start\": 24.0,\n      \"dur\": 5.09,\n      \"words\": 14,\n      \"text\": \"Then you follow up in 48 hours with a short note and a price.\",\n      \"concrete\": 1,\n      \"label\": \"CTA\",\n      \"flags\": [\n        \"5.1s on one beat\"\n      ]\n    }\n  ],\n  \"notes\": [\n    \"Beat 1 has no number and no name in it. Hooks without something checkable are the ones that get scrolled.\",\n    \"Beat(s) 3, 4, 7 run past 4s. Either split the line or change what is on screen inside it. A static frame is where people leave.\",\n    \"No loop. The last beat shares no word with the hook, so the video ends flat. Echoing one word from beat 1 is the cheapest replay you get.\"\n  ]\n}\n",
    text: "\nBEAT SHEET  \u00b7  80 words  \u00b7  ~29.1s at 165 wpm\n========================================================================\n  0:00.0   2.9s  HOOK    Most freelancers lose deals before they even start.\n  0:02.9   4.0s          They send a long deck. They wait a week. They chase.\n  0:06.9   5.5s          The client moves on to somebody else who answered faster than they did on Monday.\n                         ^ 5.5s on one beat\n  0:12.4   7.3s  MID     Here is the fix that Maria used with Acme in 2024, and it takes about ten minutes to set up.\n                         ^ 7.3s on one beat\n  0:19.6   1.8s          First you write one page.\n  0:21.4   2.5s          Then you send it the same day.\n  0:24.0   5.1s  CTA     Then you follow up in 48 hours with a short note and a price.\n                         ^ 5.1s on one beat\n------------------------------------------------------------------------\n  - Beat 1 has no number and no name in it. Hooks without something checkable are the ones that get scrolled.\n  - Beat(s) 3, 4, 7 run past 4s. Either split the line or change what is on screen inside it. A static frame is where people leave.\n  - No loop. The last beat shares no word with the hook, so the video ends flat. Echoing one word from beat 1 is the cheapest replay you get.\n\n" },
  { name: "b4_es", input: "C\u00f3mo gan\u00e9 $18,000 en Madrid.\nNi\u00f1o Ni\u00f1a canci\u00f3n\ndecisi\u00f3n r\u00e1pida\nM\u00e9xico y Caf\u00e9 con 3 amigos\nGracias por ver", wpm: 165, wpmGiven: false, target: null, exit: 0,
    json: "{\n  \"wpm\": 165,\n  \"target\": null,\n  \"total_seconds\": 9.45,\n  \"total_words\": 26,\n  \"beats\": [\n    {\n      \"n\": 1,\n      \"start\": 0.0,\n      \"dur\": 2.18,\n      \"words\": 6,\n      \"text\": \"C\u00f3mo gan\u00e9 $18,000 en Madrid.\",\n      \"concrete\": 3,\n      \"label\": \"HOOK\",\n      \"flags\": []\n    },\n    {\n      \"n\": 2,\n      \"start\": 2.18,\n      \"dur\": 2.18,\n      \"words\": 6,\n      \"text\": \"Ni\u00f1o Ni\u00f1a canci\u00f3n\",\n      \"concrete\": 0,\n      \"label\": \"\",\n      \"flags\": []\n    },\n    {\n      \"n\": 3,\n      \"start\": 4.36,\n      \"dur\": 1.45,\n      \"words\": 4,\n      \"text\": \"decisi\u00f3n r\u00e1pida\",\n      \"concrete\": 0,\n      \"label\": \"MID\",\n      \"flags\": []\n    },\n    {\n      \"n\": 4,\n      \"start\": 5.82,\n      \"dur\": 2.55,\n      \"words\": 7,\n      \"text\": \"M\u00e9xico y Caf\u00e9 con 3 amigos\",\n      \"concrete\": 1,\n      \"label\": \"\",\n      \"flags\": []\n    },\n    {\n      \"n\": 5,\n      \"start\": 8.36,\n      \"dur\": 1.09,\n      \"words\": 3,\n      \"text\": \"Gracias por ver\",\n      \"concrete\": 0,\n      \"label\": \"CTA\",\n      \"flags\": []\n    }\n  ],\n  \"notes\": [\n    \"No loop. The last beat shares no word with the hook, so the video ends flat. Echoing one word from beat 1 is the cheapest replay you get.\"\n  ]\n}\n",
    text: "\nBEAT SHEET  \u00b7  26 words  \u00b7  ~9.4s at 165 wpm\n========================================================================\n  0:00.0   2.2s  HOOK    C\u00f3mo gan\u00e9 $18,000 en Madrid.\n  0:02.2   2.2s          Ni\u00f1o Ni\u00f1a canci\u00f3n\n  0:04.4   1.4s  MID     decisi\u00f3n r\u00e1pida\n  0:05.8   2.5s          M\u00e9xico y Caf\u00e9 con 3 amigos\n  0:08.4   1.1s  CTA     Gracias por ver\n------------------------------------------------------------------------\n  - No loop. The last beat shares no word with the hook, so the video ends flat. Echoing one word from beat 1 is the cheapest replay you get.\n\n" },
  { name: "b5_empty", input: "", wpm: 165, wpmGiven: false, target: null, exit: 2,
    json: "",
    text: "" },
  { name: "b6_blank", input: "\n   \n\n", wpm: 165, wpmGiven: false, target: null, exit: 2,
    json: "",
    text: "" },
  { name: "b7_short", input: "Hi\nBye Hi", wpm: 165, wpmGiven: false, target: null, exit: 0,
    json: "{\n  \"wpm\": 165,\n  \"target\": null,\n  \"total_seconds\": 1.09,\n  \"total_words\": 3,\n  \"beats\": [\n    {\n      \"n\": 1,\n      \"start\": 0.0,\n      \"dur\": 0.36,\n      \"words\": 1,\n      \"text\": \"Hi\",\n      \"concrete\": 0,\n      \"label\": \"HOOK\",\n      \"flags\": []\n    },\n    {\n      \"n\": 2,\n      \"start\": 0.36,\n      \"dur\": 0.73,\n      \"words\": 2,\n      \"text\": \"Bye Hi\",\n      \"concrete\": 0,\n      \"label\": \"HOOK/CTA\",\n      \"flags\": []\n    }\n  ],\n  \"notes\": [\n    \"Beat 1 has no number and no name in it. Hooks without something checkable are the ones that get scrolled.\",\n    \"Loops: the last beat repeats \\\"hi\\\" from the hook. Second watches are free reach.\"\n  ]\n}\n",
    text: "\nBEAT SHEET  \u00b7  3 words  \u00b7  ~1.1s at 165 wpm\n========================================================================\n  0:00.0   0.4s  HOOK    Hi\n  0:00.4   0.7s  HOOK/CTABye Hi\n------------------------------------------------------------------------\n  - Beat 1 has no number and no name in it. Hooks without something checkable are the ones that get scrolled.\n  - Loops: the last beat repeats \"hi\" from the hook. Second watches are free reach.\n\n" },
  { name: "b8_commas", input: "It cost 1,234,567 dollars and 12,000,000 more, 5,000 now.\nYes 5,000 again and 1,234,567.", wpm: 165, wpmGiven: false, target: null, exit: 0,
    json: "{\n  \"wpm\": 165,\n  \"target\": null,\n  \"total_seconds\": 5.09,\n  \"total_words\": 14,\n  \"beats\": [\n    {\n      \"n\": 1,\n      \"start\": 0.0,\n      \"dur\": 3.27,\n      \"words\": 9,\n      \"text\": \"It cost 1,234,567 dollars and 12,000,000 more, 5,000 now.\",\n      \"concrete\": 3,\n      \"label\": \"HOOK\",\n      \"flags\": [\n        \"hook runs 3.3s, past the 3s mark\"\n      ]\n    },\n    {\n      \"n\": 2,\n      \"start\": 3.27,\n      \"dur\": 1.82,\n      \"words\": 5,\n      \"text\": \"Yes 5,000 again and 1,234,567.\",\n      \"concrete\": 2,\n      \"label\": \"CTA\",\n      \"flags\": []\n    }\n  ],\n  \"notes\": [\n    \"Beat 1 takes 3.3s to say. Cut it to 8 words or fewer, or the hook lands after the decision has been made.\",\n    \"Loops: the last beat repeats \\\"1,234,567, 5,000\\\" from the hook. Second watches are free reach.\"\n  ]\n}\n",
    text: "\nBEAT SHEET  \u00b7  14 words  \u00b7  ~5.1s at 165 wpm\n========================================================================\n  0:00.0   3.3s  HOOK    It cost 1,234,567 dollars and 12,000,000 more, 5,000 now.\n                         ^ hook runs 3.3s, past the 3s mark\n  0:03.3   1.8s  CTA     Yes 5,000 again and 1,234,567.\n------------------------------------------------------------------------\n  - Beat 1 takes 3.3s to say. Cut it to 8 words or fewer, or the hook lands after the decision has been made.\n  - Loops: the last beat repeats \"1,234,567, 5,000\" from the hook. Second watches are free reach.\n\n" },
  { name: "b9_crlf", input: "One two three four five six seven eight nine ten.\nEleven twelve thirteen.\nOne two.\n", wpm: 165, wpmGiven: false, target: null, exit: 0,
    json: "{\n  \"wpm\": 165,\n  \"target\": null,\n  \"total_seconds\": 5.45,\n  \"total_words\": 15,\n  \"beats\": [\n    {\n      \"n\": 1,\n      \"start\": 0.0,\n      \"dur\": 3.64,\n      \"words\": 10,\n      \"text\": \"One two three four five six seven eight nine ten.\",\n      \"concrete\": 0,\n      \"label\": \"HOOK\",\n      \"flags\": [\n        \"hook runs 3.6s, past the 3s mark\"\n      ]\n    },\n    {\n      \"n\": 2,\n      \"start\": 3.64,\n      \"dur\": 1.09,\n      \"words\": 3,\n      \"text\": \"Eleven twelve thirteen.\",\n      \"concrete\": 0,\n      \"label\": \"\",\n      \"flags\": []\n    },\n    {\n      \"n\": 3,\n      \"start\": 4.73,\n      \"dur\": 0.73,\n      \"words\": 2,\n      \"text\": \"One two.\",\n      \"concrete\": 0,\n      \"label\": \"CTA\",\n      \"flags\": []\n    }\n  ],\n  \"notes\": [\n    \"Beat 1 takes 3.6s to say. Cut it to 8 words or fewer, or the hook lands after the decision has been made.\",\n    \"Beat 1 has no number and no name in it. Hooks without something checkable are the ones that get scrolled.\",\n    \"Beats 1-3 have nothing concrete in them. Put a number, a name or a price in one of them.\",\n    \"Loops: the last beat repeats \\\"two\\\" from the hook. Second watches are free reach.\"\n  ]\n}\n",
    text: "\nBEAT SHEET  \u00b7  15 words  \u00b7  ~5.5s at 165 wpm\n========================================================================\n  0:00.0   3.6s  HOOK    One two three four five six seven eight nine ten.\n                         ^ hook runs 3.6s, past the 3s mark\n  0:03.6   1.1s          Eleven twelve thirteen.\n  0:04.7   0.7s  CTA     One two.\n------------------------------------------------------------------------\n  - Beat 1 takes 3.6s to say. Cut it to 8 words or fewer, or the hook lands after the decision has been made.\n  - Beat 1 has no number and no name in it. Hooks without something checkable are the ones that get scrolled.\n  - Beats 1-3 have nothing concrete in them. Put a number, a name or a price in one of them.\n  - Loops: the last beat repeats \"two\" from the hook. Second watches are free reach.\n\n" },
  { name: "b10_ties", input: "one two three four five\nsix seven eight nine ten eleven twelve\nthirteen fourteen", wpm: 165, wpmGiven: false, target: null, exit: 0,
    json: "{\n  \"wpm\": 165,\n  \"target\": null,\n  \"total_seconds\": 5.09,\n  \"total_words\": 14,\n  \"beats\": [\n    {\n      \"n\": 1,\n      \"start\": 0.0,\n      \"dur\": 1.82,\n      \"words\": 5,\n      \"text\": \"one two three four five\",\n      \"concrete\": 0,\n      \"label\": \"HOOK\",\n      \"flags\": []\n    },\n    {\n      \"n\": 2,\n      \"start\": 1.82,\n      \"dur\": 2.55,\n      \"words\": 7,\n      \"text\": \"six seven eight nine ten eleven twelve\",\n      \"concrete\": 0,\n      \"label\": \"MID\",\n      \"flags\": []\n    },\n    {\n      \"n\": 3,\n      \"start\": 4.36,\n      \"dur\": 0.73,\n      \"words\": 2,\n      \"text\": \"thirteen fourteen\",\n      \"concrete\": 0,\n      \"label\": \"CTA\",\n      \"flags\": []\n    }\n  ],\n  \"notes\": [\n    \"Beat 1 has no number and no name in it. Hooks without something checkable are the ones that get scrolled.\",\n    \"Beats 1-3 have nothing concrete in them. Put a number, a name or a price in one of them.\",\n    \"No loop. The last beat shares no word with the hook, so the video ends flat. Echoing one word from beat 1 is the cheapest replay you get.\"\n  ]\n}\n",
    text: "\nBEAT SHEET  \u00b7  14 words  \u00b7  ~5.1s at 165 wpm\n========================================================================\n  0:00.0   1.8s  HOOK    one two three four five\n  0:01.8   2.5s  MID     six seven eight nine ten eleven twelve\n  0:04.4   0.7s  CTA     thirteen fourteen\n------------------------------------------------------------------------\n  - Beat 1 has no number and no name in it. Hooks without something checkable are the ones that get scrolled.\n  - Beats 1-3 have nothing concrete in them. Put a number, a name or a price in one of them.\n  - No loop. The last beat shares no word with the hook, so the video ends flat. Echoing one word from beat 1 is the cheapest replay you get.\n\n" },
  { name: "b1_basic --target 30", input: "Stop losing $18,000 a year to bad proposals.\nHere is what Maria changed at Acme.\nShe sent one page instead of twelve.\nClients said yes in 3 days.\nStop losing proposals today.", wpm: 165, wpmGiven: false, target: 30.0, exit: 0,
    json: "{\n  \"wpm\": 165,\n  \"target\": 30.0,\n  \"total_seconds\": 11.64,\n  \"total_words\": 32,\n  \"beats\": [\n    {\n      \"n\": 1,\n      \"start\": 0.0,\n      \"dur\": 2.91,\n      \"words\": 8,\n      \"text\": \"Stop losing $18,000 a year to bad proposals.\",\n      \"concrete\": 2,\n      \"label\": \"HOOK\",\n      \"flags\": []\n    },\n    {\n      \"n\": 2,\n      \"start\": 2.91,\n      \"dur\": 2.55,\n      \"words\": 7,\n      \"text\": \"Here is what Maria changed at Acme.\",\n      \"concrete\": 2,\n      \"label\": \"\",\n      \"flags\": []\n    },\n    {\n      \"n\": 3,\n      \"start\": 5.45,\n      \"dur\": 2.55,\n      \"words\": 7,\n      \"text\": \"She sent one page instead of twelve.\",\n      \"concrete\": 0,\n      \"label\": \"MID\",\n      \"flags\": []\n    },\n    {\n      \"n\": 4,\n      \"start\": 8.0,\n      \"dur\": 2.18,\n      \"words\": 6,\n      \"text\": \"Clients said yes in 3 days.\",\n      \"concrete\": 1,\n      \"label\": \"\",\n      \"flags\": []\n    },\n    {\n      \"n\": 5,\n      \"start\": 10.18,\n      \"dur\": 1.45,\n      \"words\": 4,\n      \"text\": \"Stop losing proposals today.\",\n      \"concrete\": 0,\n      \"label\": \"CTA\",\n      \"flags\": []\n    }\n  ],\n  \"notes\": [\n    \"Loops: the last beat repeats \\\"losing, proposals, stop\\\" from the hook. Second watches are free reach.\",\n    \"18.4s under target. Either add 50 words or shoot it short. Short is usually right.\"\n  ]\n}\n",
    text: "\nBEAT SHEET  \u00b7  32 words  \u00b7  ~11.6s at 165 wpm  \u00b7  target 30.0s\n========================================================================\n  0:00.0   2.9s  HOOK    Stop losing $18,000 a year to bad proposals.\n  0:02.9   2.5s          Here is what Maria changed at Acme.\n  0:05.5   2.5s  MID     She sent one page instead of twelve.\n  0:08.0   2.2s          Clients said yes in 3 days.\n  0:10.2   1.4s  CTA     Stop losing proposals today.\n------------------------------------------------------------------------\n  - Loops: the last beat repeats \"losing, proposals, stop\" from the hook. Second watches are free reach.\n  - 18.4s under target. Either add 50 words or shoot it short. Short is usually right.\n\n" },
  { name: "b1_basic --wpm 185 --target 45", input: "Stop losing $18,000 a year to bad proposals.\nHere is what Maria changed at Acme.\nShe sent one page instead of twelve.\nClients said yes in 3 days.\nStop losing proposals today.", wpm: 185, wpmGiven: true, target: 45.0, exit: 0,
    json: "{\n  \"wpm\": 185.0,\n  \"target\": 45.0,\n  \"total_seconds\": 10.38,\n  \"total_words\": 32,\n  \"beats\": [\n    {\n      \"n\": 1,\n      \"start\": 0.0,\n      \"dur\": 2.59,\n      \"words\": 8,\n      \"text\": \"Stop losing $18,000 a year to bad proposals.\",\n      \"concrete\": 2,\n      \"label\": \"HOOK\",\n      \"flags\": []\n    },\n    {\n      \"n\": 2,\n      \"start\": 2.59,\n      \"dur\": 2.27,\n      \"words\": 7,\n      \"text\": \"Here is what Maria changed at Acme.\",\n      \"concrete\": 2,\n      \"label\": \"\",\n      \"flags\": []\n    },\n    {\n      \"n\": 3,\n      \"start\": 4.86,\n      \"dur\": 2.27,\n      \"words\": 7,\n      \"text\": \"She sent one page instead of twelve.\",\n      \"concrete\": 0,\n      \"label\": \"MID\",\n      \"flags\": []\n    },\n    {\n      \"n\": 4,\n      \"start\": 7.14,\n      \"dur\": 1.95,\n      \"words\": 6,\n      \"text\": \"Clients said yes in 3 days.\",\n      \"concrete\": 1,\n      \"label\": \"\",\n      \"flags\": []\n    },\n    {\n      \"n\": 5,\n      \"start\": 9.08,\n      \"dur\": 1.3,\n      \"words\": 4,\n      \"text\": \"Stop losing proposals today.\",\n      \"concrete\": 0,\n      \"label\": \"CTA\",\n      \"flags\": []\n    }\n  ],\n  \"notes\": [\n    \"Loops: the last beat repeats \\\"losing, proposals, stop\\\" from the hook. Second watches are free reach.\",\n    \"34.6s under target. Either add 106 words or shoot it short. Short is usually right.\"\n  ]\n}\n",
    text: "\nBEAT SHEET  \u00b7  32 words  \u00b7  ~10.4s at 185.0 wpm  \u00b7  target 45.0s\n========================================================================\n  0:00.0   2.6s  HOOK    Stop losing $18,000 a year to bad proposals.\n  0:02.6   2.3s          Here is what Maria changed at Acme.\n  0:04.9   2.3s  MID     She sent one page instead of twelve.\n  0:07.1   1.9s          Clients said yes in 3 days.\n  0:09.1   1.3s  CTA     Stop losing proposals today.\n------------------------------------------------------------------------\n  - Loops: the last beat repeats \"losing, proposals, stop\" from the hook. Second watches are free reach.\n  - 34.6s under target. Either add 106 words or shoot it short. Short is usually right.\n\n" },
  { name: "b3_paragraph --wpm 120 --target 20", input: "Most freelancers lose deals before they even start. They send a long deck. They wait a week. They chase. The client moves on to somebody else who answered faster than they did on Monday. Here is the fix that Maria used with Acme in 2024, and it takes about ten minutes to set up. First you write one page. Then you send it the same day. Then you follow up in 48 hours with a short note and a price.", wpm: 120, wpmGiven: true, target: 20.0, exit: 0,
    json: "{\n  \"wpm\": 120.0,\n  \"target\": 20.0,\n  \"total_seconds\": 40.0,\n  \"total_words\": 80,\n  \"beats\": [\n    {\n      \"n\": 1,\n      \"start\": 0.0,\n      \"dur\": 4.0,\n      \"words\": 8,\n      \"text\": \"Most freelancers lose deals before they even start.\",\n      \"concrete\": 0,\n      \"label\": \"HOOK\",\n      \"flags\": [\n        \"hook runs 4.0s, past the 3s mark\"\n      ]\n    },\n    {\n      \"n\": 2,\n      \"start\": 4.0,\n      \"dur\": 2.5,\n      \"words\": 5,\n      \"text\": \"They send a long deck.\",\n      \"concrete\": 0,\n      \"label\": \"\",\n      \"flags\": []\n    },\n    {\n      \"n\": 3,\n      \"start\": 6.5,\n      \"dur\": 3.0,\n      \"words\": 6,\n      \"text\": \"They wait a week. They chase.\",\n      \"concrete\": 1,\n      \"label\": \"\",\n      \"flags\": []\n    },\n    {\n      \"n\": 4,\n      \"start\": 9.5,\n      \"dur\": 7.5,\n      \"words\": 15,\n      \"text\": \"The client moves on to somebody else who answered faster than they did on Monday.\",\n      \"concrete\": 1,\n      \"label\": \"\",\n      \"flags\": [\n        \"7.5s on one beat\"\n      ]\n    },\n    {\n      \"n\": 5,\n      \"start\": 17.0,\n      \"dur\": 10.0,\n      \"words\": 20,\n      \"text\": \"Here is the fix that Maria used with Acme in 2024, and it takes about ten minutes to set up.\",\n      \"concrete\": 3,\n      \"label\": \"MID\",\n      \"flags\": [\n        \"10.0s on one beat\"\n      ]\n    },\n    {\n      \"n\": 6,\n      \"start\": 27.0,\n      \"dur\": 2.5,\n      \"words\": 5,\n      \"text\": \"First you write one page.\",\n      \"concrete\": 0,\n      \"label\": \"\",\n      \"flags\": []\n    },\n    {\n      \"n\": 7,\n      \"start\": 29.5,\n      \"dur\": 3.5,\n      \"words\": 7,\n      \"text\": \"Then you send it the same day.\",\n      \"concrete\": 0,\n      \"label\": \"\",\n      \"flags\": []\n    },\n    {\n      \"n\": 8,\n      \"start\": 33.0,\n      \"dur\": 7.0,\n      \"words\": 14,\n      \"text\": \"Then you follow up in 48 hours with a short note and a price.\",\n      \"concrete\": 1,\n      \"label\": \"CTA\",\n      \"flags\": [\n        \"7.0s on one beat\"\n      ]\n    }\n  ],\n  \"notes\": [\n    \"Beat 1 takes 4.0s to say. Cut it to 6 words or fewer, or the hook lands after the decision has been made.\",\n    \"Beat 1 has no number and no name in it. Hooks without something checkable are the ones that get scrolled.\",\n    \"Beat(s) 4, 5, 8 run past 4s. Either split the line or change what is on screen inside it. A static frame is where people leave.\",\n    \"No loop. The last beat shares no word with the hook, so the video ends flat. Echoing one word from beat 1 is the cheapest replay you get.\",\n    \"20.0s over target. Cut about 40 words.\"\n  ]\n}\n",
    text: "\nBEAT SHEET  \u00b7  80 words  \u00b7  ~40.0s at 120.0 wpm  \u00b7  target 20.0s\n========================================================================\n  0:00.0   4.0s  HOOK    Most freelancers lose deals before they even start.\n                         ^ hook runs 4.0s, past the 3s mark\n  0:04.0   2.5s          They send a long deck.\n  0:06.5   3.0s          They wait a week. They chase.\n  0:09.5   7.5s          The client moves on to somebody else who answered faster than they did on Monday.\n                         ^ 7.5s on one beat\n  0:17.0  10.0s  MID     Here is the fix that Maria used with Acme in 2024, and it takes about ten minutes to set up.\n                         ^ 10.0s on one beat\n  0:27.0   2.5s          First you write one page.\n  0:29.5   3.5s          Then you send it the same day.\n  0:33.0   7.0s  CTA     Then you follow up in 48 hours with a short note and a price.\n                         ^ 7.0s on one beat\n------------------------------------------------------------------------\n  - Beat 1 takes 4.0s to say. Cut it to 6 words or fewer, or the hook lands after the decision has been made.\n  - Beat 1 has no number and no name in it. Hooks without something checkable are the ones that get scrolled.\n  - Beat(s) 4, 5, 8 run past 4s. Either split the line or change what is on screen inside it. A static frame is where people leave.\n  - No loop. The last beat shares no word with the hook, so the video ends flat. Echoing one word from beat 1 is the cheapest replay you get.\n  - 20.0s over target. Cut about 40 words.\n\n" },
  { name: "b10_ties --wpm 480", input: "one two three four five\nsix seven eight nine ten eleven twelve\nthirteen fourteen", wpm: 480, wpmGiven: true, target: null, exit: 0,
    json: "{\n  \"wpm\": 480.0,\n  \"target\": null,\n  \"total_seconds\": 1.75,\n  \"total_words\": 14,\n  \"beats\": [\n    {\n      \"n\": 1,\n      \"start\": 0.0,\n      \"dur\": 0.62,\n      \"words\": 5,\n      \"text\": \"one two three four five\",\n      \"concrete\": 0,\n      \"label\": \"HOOK\",\n      \"flags\": []\n    },\n    {\n      \"n\": 2,\n      \"start\": 0.62,\n      \"dur\": 0.88,\n      \"words\": 7,\n      \"text\": \"six seven eight nine ten eleven twelve\",\n      \"concrete\": 0,\n      \"label\": \"HOOK\",\n      \"flags\": []\n    },\n    {\n      \"n\": 3,\n      \"start\": 1.5,\n      \"dur\": 0.25,\n      \"words\": 2,\n      \"text\": \"thirteen fourteen\",\n      \"concrete\": 0,\n      \"label\": \"HOOK/CTA\",\n      \"flags\": []\n    }\n  ],\n  \"notes\": [\n    \"Beat 1 has no number and no name in it. Hooks without something checkable are the ones that get scrolled.\",\n    \"Beats 1-3 have nothing concrete in them. Put a number, a name or a price in one of them.\",\n    \"No loop. The last beat shares no word with the hook, so the video ends flat. Echoing one word from beat 1 is the cheapest replay you get.\"\n  ]\n}\n",
    text: "\nBEAT SHEET  \u00b7  14 words  \u00b7  ~1.8s at 480.0 wpm\n========================================================================\n  0:00.0   0.6s  HOOK    one two three four five\n  0:00.6   0.9s  HOOK    six seven eight nine ten eleven twelve\n  0:01.5   0.2s  HOOK/CTAthirteen fourteen\n------------------------------------------------------------------------\n  - Beat 1 has no number and no name in it. Hooks without something checkable are the ones that get scrolled.\n  - Beats 1-3 have nothing concrete in them. Put a number, a name or a price in one of them.\n  - No loop. The last beat shares no word with the hook, so the video ends flat. Echoing one word from beat 1 is the cheapest replay you get.\n\n" },
  { name: "b10_ties --wpm 240 --target 10", input: "one two three four five\nsix seven eight nine ten eleven twelve\nthirteen fourteen", wpm: 240, wpmGiven: true, target: 10.0, exit: 0,
    json: "{\n  \"wpm\": 240.0,\n  \"target\": 10.0,\n  \"total_seconds\": 3.5,\n  \"total_words\": 14,\n  \"beats\": [\n    {\n      \"n\": 1,\n      \"start\": 0.0,\n      \"dur\": 1.25,\n      \"words\": 5,\n      \"text\": \"one two three four five\",\n      \"concrete\": 0,\n      \"label\": \"HOOK\",\n      \"flags\": []\n    },\n    {\n      \"n\": 2,\n      \"start\": 1.25,\n      \"dur\": 1.75,\n      \"words\": 7,\n      \"text\": \"six seven eight nine ten eleven twelve\",\n      \"concrete\": 0,\n      \"label\": \"HOOK\",\n      \"flags\": []\n    },\n    {\n      \"n\": 3,\n      \"start\": 3.0,\n      \"dur\": 0.5,\n      \"words\": 2,\n      \"text\": \"thirteen fourteen\",\n      \"concrete\": 0,\n      \"label\": \"CTA\",\n      \"flags\": []\n    }\n  ],\n  \"notes\": [\n    \"Beat 1 has no number and no name in it. Hooks without something checkable are the ones that get scrolled.\",\n    \"Beats 1-3 have nothing concrete in them. Put a number, a name or a price in one of them.\",\n    \"No loop. The last beat shares no word with the hook, so the video ends flat. Echoing one word from beat 1 is the cheapest replay you get.\",\n    \"6.5s under target. Either add 26 words or shoot it short. Short is usually right.\"\n  ]\n}\n",
    text: "\nBEAT SHEET  \u00b7  14 words  \u00b7  ~3.5s at 240.0 wpm  \u00b7  target 10.0s\n========================================================================\n  0:00.0   1.2s  HOOK    one two three four five\n  0:01.2   1.8s  HOOK    six seven eight nine ten eleven twelve\n  0:03.0   0.5s  CTA     thirteen fourteen\n------------------------------------------------------------------------\n  - Beat 1 has no number and no name in it. Hooks without something checkable are the ones that get scrolled.\n  - Beats 1-3 have nothing concrete in them. Put a number, a name or a price in one of them.\n  - No loop. The last beat shares no word with the hook, so the video ends flat. Echoing one word from beat 1 is the cheapest replay you get.\n  - 6.5s under target. Either add 26 words or shoot it short. Short is usually right.\n\n" },
  { name: "b4_es --wpm 150", input: "C\u00f3mo gan\u00e9 $18,000 en Madrid.\nNi\u00f1o Ni\u00f1a canci\u00f3n\ndecisi\u00f3n r\u00e1pida\nM\u00e9xico y Caf\u00e9 con 3 amigos\nGracias por ver", wpm: 150, wpmGiven: true, target: null, exit: 0,
    json: "{\n  \"wpm\": 150.0,\n  \"target\": null,\n  \"total_seconds\": 10.4,\n  \"total_words\": 26,\n  \"beats\": [\n    {\n      \"n\": 1,\n      \"start\": 0.0,\n      \"dur\": 2.4,\n      \"words\": 6,\n      \"text\": \"C\u00f3mo gan\u00e9 $18,000 en Madrid.\",\n      \"concrete\": 3,\n      \"label\": \"HOOK\",\n      \"flags\": []\n    },\n    {\n      \"n\": 2,\n      \"start\": 2.4,\n      \"dur\": 2.4,\n      \"words\": 6,\n      \"text\": \"Ni\u00f1o Ni\u00f1a canci\u00f3n\",\n      \"concrete\": 0,\n      \"label\": \"\",\n      \"flags\": []\n    },\n    {\n      \"n\": 3,\n      \"start\": 4.8,\n      \"dur\": 1.6,\n      \"words\": 4,\n      \"text\": \"decisi\u00f3n r\u00e1pida\",\n      \"concrete\": 0,\n      \"label\": \"MID\",\n      \"flags\": []\n    },\n    {\n      \"n\": 4,\n      \"start\": 6.4,\n      \"dur\": 2.8,\n      \"words\": 7,\n      \"text\": \"M\u00e9xico y Caf\u00e9 con 3 amigos\",\n      \"concrete\": 1,\n      \"label\": \"\",\n      \"flags\": []\n    },\n    {\n      \"n\": 5,\n      \"start\": 9.2,\n      \"dur\": 1.2,\n      \"words\": 3,\n      \"text\": \"Gracias por ver\",\n      \"concrete\": 0,\n      \"label\": \"CTA\",\n      \"flags\": []\n    }\n  ],\n  \"notes\": [\n    \"No loop. The last beat shares no word with the hook, so the video ends flat. Echoing one word from beat 1 is the cheapest replay you get.\"\n  ]\n}\n",
    text: "\nBEAT SHEET  \u00b7  26 words  \u00b7  ~10.4s at 150.0 wpm\n========================================================================\n  0:00.0   2.4s  HOOK    C\u00f3mo gan\u00e9 $18,000 en Madrid.\n  0:02.4   2.4s          Ni\u00f1o Ni\u00f1a canci\u00f3n\n  0:04.8   1.6s  MID     decisi\u00f3n r\u00e1pida\n  0:06.4   2.8s          M\u00e9xico y Caf\u00e9 con 3 amigos\n  0:09.2   1.2s  CTA     Gracias por ver\n------------------------------------------------------------------------\n  - No loop. The last beat shares no word with the hook, so the video ends flat. Echoing one word from beat 1 is the cheapest replay you get.\n\n" },
  { name: "b2_long_hook --wpm 90.5 --target 12.25", input: "This is a very long opening line that rambles on and on without any number or name until the viewer has long since left the building for good\nsecond\nthird line abstract\nfourth line abstract\nfifth line abstract", wpm: 90.5, wpmGiven: true, target: 12.25, exit: 0,
    json: "{\n  \"wpm\": 90.5,\n  \"target\": 12.25,\n  \"total_seconds\": 25.19,\n  \"total_words\": 38,\n  \"beats\": [\n    {\n      \"n\": 1,\n      \"start\": 0.0,\n      \"dur\": 18.56,\n      \"words\": 28,\n      \"text\": \"This is a very long opening line that rambles on and on without any number or name until the viewer has long since left the building for good\",\n      \"concrete\": 0,\n      \"label\": \"HOOK\",\n      \"flags\": [\n        \"hook runs 18.6s, past the 3s mark\",\n        \"18.6s on one beat\"\n      ]\n    },\n    {\n      \"n\": 2,\n      \"start\": 18.56,\n      \"dur\": 0.66,\n      \"words\": 1,\n      \"text\": \"second\",\n      \"concrete\": 0,\n      \"label\": \"\",\n      \"flags\": []\n    },\n    {\n      \"n\": 3,\n      \"start\": 19.23,\n      \"dur\": 1.99,\n      \"words\": 3,\n      \"text\": \"third line abstract\",\n      \"concrete\": 0,\n      \"label\": \"\",\n      \"flags\": []\n    },\n    {\n      \"n\": 4,\n      \"start\": 21.22,\n      \"dur\": 1.99,\n      \"words\": 3,\n      \"text\": \"fourth line abstract\",\n      \"concrete\": 0,\n      \"label\": \"\",\n      \"flags\": []\n    },\n    {\n      \"n\": 5,\n      \"start\": 23.2,\n      \"dur\": 1.99,\n      \"words\": 3,\n      \"text\": \"fifth line abstract\",\n      \"concrete\": 0,\n      \"label\": \"CTA\",\n      \"flags\": []\n    }\n  ],\n  \"notes\": [\n    \"Beat 1 takes 18.6s to say. Cut it to 4 words or fewer, or the hook lands after the decision has been made.\",\n    \"Beat 1 has no number and no name in it. Hooks without something checkable are the ones that get scrolled.\",\n    \"Beat(s) 1 run past 4s. Either split the line or change what is on screen inside it. A static frame is where people leave.\",\n    \"Beats 1-3 have nothing concrete in them. Put a number, a name or a price in one of them.\",\n    \"Loops: the last beat repeats \\\"line\\\" from the hook. Second watches are free reach.\",\n    \"12.9s over target. Cut about 19 words.\"\n  ]\n}\n",
    text: "\nBEAT SHEET  \u00b7  38 words  \u00b7  ~25.2s at 90.5 wpm  \u00b7  target 12.25s\n========================================================================\n  0:00.0  18.6s  HOOK    This is a very long opening line that rambles on and on without any number or name until the viewer has long since left the building for good\n                         ^ hook runs 18.6s, past the 3s mark\n                         ^ 18.6s on one beat\n  0:18.6   0.7s          second\n  0:19.2   2.0s          third line abstract\n  0:21.2   2.0s          fourth line abstract\n  0:23.2   2.0s  CTA     fifth line abstract\n------------------------------------------------------------------------\n  - Beat 1 takes 18.6s to say. Cut it to 4 words or fewer, or the hook lands after the decision has been made.\n  - Beat 1 has no number and no name in it. Hooks without something checkable are the ones that get scrolled.\n  - Beat(s) 1 run past 4s. Either split the line or change what is on screen inside it. A static frame is where people leave.\n  - Beats 1-3 have nothing concrete in them. Put a number, a name or a price in one of them.\n  - Loops: the last beat repeats \"line\" from the hook. Second watches are free reach.\n  - 12.9s over target. Cut about 19 words.\n\n" },
  { name: "b1_basic --wpm 0", input: "Stop losing $18,000 a year to bad proposals.\nHere is what Maria changed at Acme.\nShe sent one page instead of twelve.\nClients said yes in 3 days.\nStop losing proposals today.", wpm: 0, wpmGiven: true, target: null, exit: 1,
    json: "",
    text: "" },
  { name: "b5_empty --wpm 0", input: "", wpm: 0, wpmGiven: true, target: null, exit: 2,
    json: "",
    text: "" },
];

describe('caption-lint parity with caption.py', () => {
  for (const c of CAPTIONS) {
    test(`json: ${c.name}`, () => {
      const a = analyseCaption(c.input, c.cut, c.keywords);
      expect(a).toEqual(c.expected as typeof a);
      expect(a.verdict === 'READY' ? 0 : 1).toBe(c.exit);
    });
    test(`text: ${c.name}`, () => {
      expect(renderCaption(analyseCaption(c.input, c.cut, c.keywords))).toBe(c.text);
    });
  }

  test('specific verdicts and checks', () => {
    const good = analyseCaption('We closed 3 clients in 14 days.\n\nSave this.\n\n#proposals');
    expect(good.verdict).toBe('REVIEW'); // tag sits inside the visible window
    const bad = analyseCaption('#a #b #c #d #e #f');
    expect(bad.verdict).toBe('FIX');
    expect(bad.checks.find((c) => c.check === 'HASHTAGS')?.status).toBe('FAIL');
    expect(analyseCaption('').checks[1]).toEqual({ check: 'FIRST LINE', status: 'FAIL', detail: 'the caption opens on a blank line' });
  });

  test('python rounding helpers', () => {
    expect(pyFixed(0.25, 1)).toBe('0.2');
    expect(pyFixed(0.75, 1)).toBe('0.8');
    expect(pyFixed(2.5, 0)).toBe('2');
    expect(pyFixed(3.14159, 2)).toBe('3.14');
  });

  test('textwrap matches python', () => {
    expect(textwrap('', 10)).toEqual([]);
    expect(textwrap('hello world foo', 10)).toEqual(['hello', 'world foo']);
    expect(textwrap('a-very-long-hyphenated-word here', 10)).toEqual(['a-very-', 'long-hyphe', 'nated-word', 'here']);
  });
});

describe('beats parity with beats.py', () => {
  for (const b of BEATS) {
    test(`json: ${b.name}`, () => {
      let a: ReturnType<typeof analyseBeats>;
      try {
        a = analyseBeats(b.input, b.wpm, b.target);
      } catch {
        expect(b.exit).toBe(1); // ZeroDivisionError in python
        return;
      }
      if (b.exit === 2) {
        expect(a).toBeNull();
        return;
      }
      expect(a).not.toBeNull();
      expect(beatsJson(a!, b.wpmGiven)).toBe(b.json.trimEnd());
      expect(JSON.parse(beatsJson(a!, b.wpmGiven))).toEqual(JSON.parse(b.json));
    });
    test(`text: ${b.name}`, () => {
      let a: ReturnType<typeof analyseBeats>;
      try {
        a = analyseBeats(b.input, b.wpm, b.target);
      } catch {
        return;
      }
      if (!a) return;
      expect(renderBeats(a, b.wpmGiven)).toBe(b.text);
    });
  }

  test('helpers', () => {
    expect(words('It cost $18,000 now')).toEqual(['It', 'cost', '$18000', 'now']);
    expect(pretty('18000')).toBe('18,000');
    expect(pretty('$1234567')).toBe('$1,234,567');
    expect(tc(65.25)).toBe('1:05.2');
    expect(tc(0)).toBe('0:00.0');
  });

  test('empty script yields null', () => {
    expect(analyseBeats('')).toBeNull();
    expect(analyseBeats('  \n \n')).toBeNull();
  });
});
