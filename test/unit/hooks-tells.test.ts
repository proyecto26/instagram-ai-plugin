// Parity tests for hook-score.ts and ai-tells.ts.
// Fixtures: inputs and expected outputs were produced by running the Python originals
// (instagram-agent-skill hookscore.py, detect.py, humanize.py; MIT, (c) 2026 Jake Schincariol).
import { describe, expect, test } from "bun:test";
import {
  fixed, renderOne, renderTable, roundInt, run as runHook, scoreHook, pyJson,
} from "../../skills/instagram-content/scripts/hook-score.ts";
import {
  detect, humanize, loadLexicon, renderDetect, renderReport, scoreDraft, pstdevInts, exactMean,
} from "../../skills/instagram-content/scripts/ai-tells.ts";

const lex = loadLexicon();

type CheckMap = Record<string, { score: number; detail: string }>;
const HOOKS: { hook: string; checks: CheckMap; weakest: ReturnType<typeof scoreHook>["weakest"]; flags: string[]; score: number; verdict: string }[] = [
 {
  "hook": "I lost $18,000 on one missing contract.",
  "checks": {
   "LENGTH": {
    "score": 100.0,
    "detail": "7 words, 39 chars, ~2.5s spoken (want 5-12 words)"
   },
   "SPECIFICITY": {
    "score": 75,
    "detail": "1 concrete marker(s): $18,000"
   },
   "STAKES": {
    "score": 100.0,
    "detail": "2 tension marker(s): lost, a price"
   },
   "FRONTLOAD": {
    "score": 100.0,
    "detail": "payload at word 2"
   },
   "ADDRESS": {
    "score": 70.0,
    "detail": "first person, no viewer named"
   }
  },
  "weakest": "ADDRESS",
  "flags": [],
  "score": 81.4,
  "verdict": "STRONG"
 },
 {
  "hook": "Hey guys, welcome back to my channel, today we are going to talk about something",
  "checks": {
   "LENGTH": {
    "score": 55,
    "detail": "15 words, 80 chars, ~5.5s spoken (want 5-12 words)"
   },
   "SPECIFICITY": {
    "score": 15.0,
    "detail": "0 concrete marker(s) - no number, no name, nothing checkable"
   },
   "STAKES": {
    "score": 20.0,
    "detail": "0 tension marker(s) - nothing is at stake in this line"
   },
   "FRONTLOAD": {
    "score": 0.0,
    "detail": "no payload word anywhere in the line; weak opener \"hey\""
   },
   "ADDRESS": {
    "score": 70.0,
    "detail": "first person, no viewer named"
   }
  },
  "weakest": "FRONTLOAD",
  "flags": [
   "Greeting. Nobody came to the feed to be greeted."
  ],
  "score": 4.2,
  "verdict": "WEAK"
 },
 {
  "hook": "Stop scrolling! This changes everything \ud83d\ude80",
  "checks": {
   "LENGTH": {
    "score": 100.0,
    "detail": "5 words, 41 chars, ~1.8s spoken (want 5-12 words)"
   },
   "SPECIFICITY": {
    "score": 75,
    "detail": "1 concrete marker(s): This"
   },
   "STAKES": {
    "score": 70.0,
    "detail": "1 tension marker(s): stop"
   },
   "FRONTLOAD": {
    "score": 100.0,
    "detail": "payload at word 1"
   },
   "ADDRESS": {
    "score": 90.0,
    "detail": "imperative opener (\"stop\")"
   }
  },
  "weakest": "STAKES",
  "flags": [
   "Opens with \"stop scrolling\". Asking for attention proves you have not earned it.",
   "Emoji in the hook. On-screen text at hook size has room for words or for an emoji, not both."
  ],
  "score": 50.2,
  "verdict": "OK"
 },
 {
  "hook": "Nobody tells you this about Instagram reach in 2025",
  "checks": {
   "LENGTH": {
    "score": 100.0,
    "detail": "9 words, 51 chars, ~3.3s spoken (want 5-12 words)"
   },
   "SPECIFICITY": {
    "score": 100.0,
    "detail": "2 concrete marker(s): 2025, Instagram"
   },
   "STAKES": {
    "score": 70.0,
    "detail": "1 tension marker(s): nobody"
   },
   "FRONTLOAD": {
    "score": 100.0,
    "detail": "payload at word 1"
   },
   "ADDRESS": {
    "score": 100.0,
    "detail": "speaks to the viewer"
   }
  },
  "weakest": "STAKES",
  "flags": [],
  "score": 84.4,
  "verdict": "STRONG"
 },
 {
  "hook": "You're paying $49 a month for a tool that you never use",
  "checks": {
   "LENGTH": {
    "score": 100.0,
    "detail": "12 words, 55 chars, ~4.4s spoken (want 5-12 words)"
   },
   "SPECIFICITY": {
    "score": 75,
    "detail": "1 concrete marker(s): $49"
   },
   "STAKES": {
    "score": 100.0,
    "detail": "2 tension marker(s): never, a price"
   },
   "FRONTLOAD": {
    "score": 70.0,
    "detail": "payload at word 3; weak opener \"yo\""
   },
   "ADDRESS": {
    "score": 100.0,
    "detail": "speaks to the viewer"
   }
  },
  "weakest": "FRONTLOAD",
  "flags": [],
  "score": 81.4,
  "verdict": "STRONG"
 },
 {
  "hook": "In this video I'm going to show you how to grow",
  "checks": {
   "LENGTH": {
    "score": 100.0,
    "detail": "11 words, 47 chars, ~4.0s spoken (want 5-12 words)"
   },
   "SPECIFICITY": {
    "score": 15.0,
    "detail": "0 concrete marker(s) - no number, no name, nothing checkable"
   },
   "STAKES": {
    "score": 20.0,
    "detail": "0 tension marker(s) - nothing is at stake in this line"
   },
   "FRONTLOAD": {
    "score": 0.0,
    "detail": "no payload word anywhere in the line; weak opener \"in this\""
   },
   "ADDRESS": {
    "score": 100.0,
    "detail": "speaks to the viewer"
   }
  },
  "weakest": "FRONTLOAD",
  "flags": [
   "Video preamble. Delete it and open on the payoff."
  ],
  "score": 13.2,
  "verdict": "WEAK"
 },
 {
  "hook": "Why do 90% of founders quit before month 12?",
  "checks": {
   "LENGTH": {
    "score": 100.0,
    "detail": "9 words, 44 chars, ~3.3s spoken (want 5-12 words)"
   },
   "SPECIFICITY": {
    "score": 100.0,
    "detail": "2 concrete marker(s): 90%, 12"
   },
   "STAKES": {
    "score": 100.0,
    "detail": "2 tension marker(s): before, quit"
   },
   "FRONTLOAD": {
    "score": 100.0,
    "detail": "payload at word 3"
   },
   "ADDRESS": {
    "score": 35.0,
    "detail": "third person, nobody in the room"
   }
  },
  "weakest": "ADDRESS",
  "flags": [],
  "score": 66.2,
  "verdict": "OK"
 },
 {
  "hook": "Quit your job. Don't wait for permission.",
  "checks": {
   "LENGTH": {
    "score": 100.0,
    "detail": "7 words, 41 chars, ~2.5s spoken (want 5-12 words)"
   },
   "SPECIFICITY": {
    "score": 75,
    "detail": "1 concrete marker(s): Don"
   },
   "STAKES": {
    "score": 100.0,
    "detail": "2 tension marker(s): don't, quit"
   },
   "FRONTLOAD": {
    "score": 100.0,
    "detail": "payload at word 1"
   },
   "ADDRESS": {
    "score": 100.0,
    "detail": "speaks to the viewer"
   }
  },
  "weakest": "SPECIFICITY",
  "flags": [],
  "score": 87.0,
  "verdict": "STRONG"
 },
 {
  "hook": "la verdad es que nunca pierdes dinero cuando inviertes en tu negocio y aprendes cada d\u00eda",
  "checks": {
   "LENGTH": {
    "score": 33,
    "detail": "17 words, 88 chars, ~6.2s spoken (want 5-12 words)"
   },
   "SPECIFICITY": {
    "score": 15.0,
    "detail": "0 concrete marker(s) - no number, no name, nothing checkable"
   },
   "STAKES": {
    "score": 20.0,
    "detail": "0 tension marker(s) - nothing is at stake in this line"
   },
   "FRONTLOAD": {
    "score": 30.0,
    "detail": "no payload word anywhere in the line"
   },
   "ADDRESS": {
    "score": 35.0,
    "detail": "third person, nobody in the room"
   }
  },
  "weakest": "SPECIFICITY",
  "flags": [],
  "score": 22.0,
  "verdict": "WEAK"
 },
 {
  "hook": "#fyp this is a hook",
  "checks": {
   "LENGTH": {
    "score": 100.0,
    "detail": "5 words, 19 chars, ~1.8s spoken (want 5-12 words)"
   },
   "SPECIFICITY": {
    "score": 15.0,
    "detail": "0 concrete marker(s) - no number, no name, nothing checkable"
   },
   "STAKES": {
    "score": 20.0,
    "detail": "0 tension marker(s) - nothing is at stake in this line"
   },
   "FRONTLOAD": {
    "score": 30.0,
    "detail": "no payload word anywhere in the line"
   },
   "ADDRESS": {
    "score": 35.0,
    "detail": "third person, nobody in the room"
   }
  },
  "weakest": "SPECIFICITY",
  "flags": [
   "Hashtag in the hook. Hashtags belong at the bottom of the caption, if anywhere."
  ],
  "score": 15.0,
  "verdict": "WEAK"
 },
 {
  "hook": "Steal this 3-step hook, free",
  "checks": {
   "LENGTH": {
    "score": 100.0,
    "detail": "5 words, 28 chars, ~1.8s spoken (want 5-12 words)"
   },
   "SPECIFICITY": {
    "score": 75,
    "detail": "1 concrete marker(s): 3"
   },
   "STAKES": {
    "score": 70.0,
    "detail": "1 tension marker(s): free"
   },
   "FRONTLOAD": {
    "score": 100.0,
    "detail": "payload at word 3"
   },
   "ADDRESS": {
    "score": 90.0,
    "detail": "imperative opener (\"steal\")"
   }
  },
  "weakest": "STAKES",
  "flags": [],
  "score": 80.2,
  "verdict": "STRONG"
 },
 {
  "hook": "Ok so basically I wanted to say that sometimes things are hard and it takes a lot of time to figure out",
  "checks": {
   "LENGTH": {
    "score": 0.0,
    "detail": "22 words, 103 chars, ~8.0s spoken (want 5-12 words)"
   },
   "SPECIFICITY": {
    "score": 15.0,
    "detail": "0 concrete marker(s) - no number, no name, nothing checkable"
   },
   "STAKES": {
    "score": 20.0,
    "detail": "0 tension marker(s) - nothing is at stake in this line"
   },
   "FRONTLOAD": {
    "score": 0.0,
    "detail": "no payload word anywhere in the line; weak opener \"ok\""
   },
   "ADDRESS": {
    "score": 70.0,
    "detail": "first person, no viewer named"
   }
  },
  "weakest": "LENGTH",
  "flags": [],
  "score": 12.6,
  "verdict": "WEAK"
 },
 {
  "hook": "Apple fired 12 people in 4 minutes",
  "checks": {
   "LENGTH": {
    "score": 100.0,
    "detail": "7 words, 34 chars, ~2.5s spoken (want 5-12 words)"
   },
   "SPECIFICITY": {
    "score": 100.0,
    "detail": "2 concrete marker(s): 12, 4 minutes"
   },
   "STAKES": {
    "score": 70.0,
    "detail": "1 tension marker(s): fired"
   },
   "FRONTLOAD": {
    "score": 100.0,
    "detail": "payload at word 2"
   },
   "ADDRESS": {
    "score": 35.0,
    "detail": "third person, nobody in the room"
   }
  },
  "weakest": "ADDRESS",
  "flags": [],
  "score": 62.6,
  "verdict": "OK"
 },
 {
  "hook": "Nuestro cliente perdi\u00f3 20 mil euros en una semana y nadie se lo dijo",
  "checks": {
   "LENGTH": {
    "score": 66,
    "detail": "14 words, 68 chars, ~5.1s spoken (want 5-12 words)"
   },
   "SPECIFICITY": {
    "score": 75,
    "detail": "1 concrete marker(s): 20"
   },
   "STAKES": {
    "score": 20.0,
    "detail": "0 tension marker(s) - nothing is at stake in this line"
   },
   "FRONTLOAD": {
    "score": 100.0,
    "detail": "payload at word 4"
   },
   "ADDRESS": {
    "score": 35.0,
    "detail": "third person, nobody in the room"
   }
  },
  "weakest": "STAKES",
  "flags": [],
  "score": 43.5,
  "verdict": "WEAK"
 },
 {
  "hook": "I lost $18,000 on one missing contract.",
  "checks": {
   "LENGTH": {
    "score": 100.0,
    "detail": "7 words, 39 chars, ~2.5s spoken (want 5-12 words)"
   },
   "SPECIFICITY": {
    "score": 75,
    "detail": "1 concrete marker(s): $18,000"
   },
   "STAKES": {
    "score": 100.0,
    "detail": "2 tension marker(s): lost, a price"
   },
   "FRONTLOAD": {
    "score": 100.0,
    "detail": "payload at word 2"
   },
   "ADDRESS": {
    "score": 70.0,
    "detail": "first person, no viewer named"
   }
  },
  "weakest": "ADDRESS",
  "flags": [],
  "score": 81.4,
  "verdict": "STRONG"
 },
 {
  "hook": "Hey guys welcome back, today we talk about stuff",
  "checks": {
   "LENGTH": {
    "score": 100.0,
    "detail": "9 words, 48 chars, ~3.3s spoken (want 5-12 words)"
   },
   "SPECIFICITY": {
    "score": 15.0,
    "detail": "0 concrete marker(s) - no number, no name, nothing checkable"
   },
   "STAKES": {
    "score": 20.0,
    "detail": "0 tension marker(s) - nothing is at stake in this line"
   },
   "FRONTLOAD": {
    "score": 0.0,
    "detail": "no payload word anywhere in the line; weak opener \"hey\""
   },
   "ADDRESS": {
    "score": 70.0,
    "detail": "first person, no viewer named"
   }
  },
  "weakest": "FRONTLOAD",
  "flags": [
   "Greeting. Nobody came to the feed to be greeted."
  ],
  "score": 9.6,
  "verdict": "WEAK"
 },
 {
  "hook": "Dej\u00e9 mi trabajo y gan\u00e9 5k al mes sin jefe ni horarios.",
  "checks": {
   "LENGTH": {
    "score": 100.0,
    "detail": "12 words, 54 chars, ~4.4s spoken (want 5-12 words)"
   },
   "SPECIFICITY": {
    "score": 75,
    "detail": "1 concrete marker(s): 5k"
   },
   "STAKES": {
    "score": 20.0,
    "detail": "0 tension marker(s) - nothing is at stake in this line"
   },
   "FRONTLOAD": {
    "score": 70.0,
    "detail": "payload at word 6, could move forward"
   },
   "ADDRESS": {
    "score": 35.0,
    "detail": "third person, nobody in the room"
   }
  },
  "weakest": "STAKES",
  "flags": [],
  "score": 44.0,
  "verdict": "WEAK"
 },
 {
  "hook": "Stop scrolling \u2014 this \u201cfree\u201d trick saves Maria 3 hours a week \ud83d\udd25",
  "checks": {
   "LENGTH": {
    "score": 88.0,
    "detail": "11 words, 63 chars, ~4.0s spoken (want 5-12 words)"
   },
   "SPECIFICITY": {
    "score": 100.0,
    "detail": "2 concrete marker(s): 3 hours, Maria"
   },
   "STAKES": {
    "score": 100.0,
    "detail": "2 tension marker(s): free, stop"
   },
   "FRONTLOAD": {
    "score": 100.0,
    "detail": "payload at word 1"
   },
   "ADDRESS": {
    "score": 90.0,
    "detail": "imperative opener (\"stop\")"
   }
  },
  "weakest": "LENGTH",
  "flags": [
   "Opens with \"stop scrolling\". Asking for attention proves you have not earned it.",
   "Emoji in the hook. On-screen text at hook size has room for words or for an emoji, not both."
  ],
  "score": 62.6,
  "verdict": "OK"
 },
 {
  "hook": "Don't scroll. You're wrong about hooks, and it's costing you 40% of your reach in 3 days.",
  "checks": {
   "LENGTH": {
    "score": 33,
    "detail": "17 words, 89 chars, ~6.2s spoken (want 5-12 words)"
   },
   "SPECIFICITY": {
    "score": 100.0,
    "detail": "3 concrete marker(s): 40%, 3 days, You"
   },
   "STAKES": {
    "score": 100.0,
    "detail": "2 tension marker(s): don't, wrong"
   },
   "FRONTLOAD": {
    "score": 100.0,
    "detail": "payload at word 1"
   },
   "ADDRESS": {
    "score": 100.0,
    "detail": "speaks to the viewer"
   }
  },
  "weakest": "LENGTH",
  "flags": [
   "Opens with \"stop scrolling\". Asking for attention proves you have not earned it."
  ],
  "score": 50.2,
  "verdict": "OK"
 },
 {
  "hook": "Look, I just think that maybe you should try something different with your content",
  "checks": {
   "LENGTH": {
    "score": 66,
    "detail": "14 words, 82 chars, ~5.1s spoken (want 5-12 words)"
   },
   "SPECIFICITY": {
    "score": 15.0,
    "detail": "0 concrete marker(s) - no number, no name, nothing checkable"
   },
   "STAKES": {
    "score": 70.0,
    "detail": "1 tension marker(s): should"
   },
   "FRONTLOAD": {
    "score": 10.0,
    "detail": "payload at word 8, too late; weak opener \"look\""
   },
   "ADDRESS": {
    "score": 100.0,
    "detail": "speaks to the viewer"
   }
  },
  "weakest": "FRONTLOAD",
  "flags": [],
  "score": 35.3,
  "verdict": "WEAK"
 },
 {
  "hook": "a b",
  "checks": {
   "LENGTH": {
    "score": 40,
    "detail": "2 words, 3 chars, ~0.7s spoken (want 5-12 words)"
   },
   "SPECIFICITY": {
    "score": 15.0,
    "detail": "0 concrete marker(s) - no number, no name, nothing checkable"
   },
   "STAKES": {
    "score": 20.0,
    "detail": "0 tension marker(s) - nothing is at stake in this line"
   },
   "FRONTLOAD": {
    "score": 30.0,
    "detail": "no payload word anywhere in the line"
   },
   "ADDRESS": {
    "score": 35.0,
    "detail": "third person, nobody in the room"
   }
  },
  "weakest": "SPECIFICITY",
  "flags": [],
  "score": 22.8,
  "verdict": "WEAK"
 },
 {
  "hook": "Zero dollars, twenty grand: the Netflix rent story nobody saw coming in 2 weeks",
  "checks": {
   "LENGTH": {
    "score": 66,
    "detail": "14 words, 79 chars, ~5.1s spoken (want 5-12 words)"
   },
   "SPECIFICITY": {
    "score": 100.0,
    "detail": "7 concrete marker(s): 2 weeks, Netflix, zero, dollars"
   },
   "STAKES": {
    "score": 70.0,
    "detail": "1 tension marker(s): nobody"
   },
   "FRONTLOAD": {
    "score": 100.0,
    "detail": "payload at word 1"
   },
   "ADDRESS": {
    "score": 35.0,
    "detail": "third person, nobody in the room"
   }
  },
  "weakest": "ADDRESS",
  "flags": [],
  "score": 58.5,
  "verdict": "OK"
 }
];
const DETECT: { name: string; text: string; expected: { source: string; checks: CheckMap; human_score: number; verdict: string } }[] = [
 {
  "name": "sloppy",
  "text": "In today's fast-paced world, it's no secret that creators must leverage a robust and comprehensive strategy to unlock their potential. Let's delve into the transformative landscape of social media \u2014 a vibrant tapestry of ideas. It's not just about content, it's about connection. Furthermore, it is crucial to foster a seamless journey for your audience. Our innovative, holistic, game-changing approach will elevate your brand. Here's what I learned: consistency matters. Not only does it build trust but also it empowers your community. Whether you are new, experienced, or curious. In conclusion, the future is here, and it's time to embark on a pivotal adventure. Let that sink in. Agree?\n",
  "expected": {
   "source": "X",
   "checks": {
    "BURSTINESS": {
     "score": 44.2,
     "detail": "variation 0.43 across 10 sentences (want 0.55+)"
    },
    "SPECIFICITY": {
     "score": 0.0,
     "detail": "0 concrete markers, 0.0 per 100 words (want 4+)"
    },
    "SLOP DENSITY": {
     "score": 0.0,
     "detail": "25 stock terms, 22.7 per 100 words (comprehensive, crucial, delve, delve into, ...)"
    },
    "FINGERPRINT": {
     "score": 75.9,
     "detail": "0 invisible, 1 em dash, 0 curly quote, 0 ellipsis, 0 hard space"
    },
    "VOICE": {
     "score": 60.9,
     "detail": "6.4 contractions, 5.5 personal pronouns per 100 words, 4 structural tell(s) [not-just, not-only, heres-what, engagement-bait]"
    }
   },
   "human_score": 21.7,
   "verdict": "FLAGGED"
  }
 },
 {
  "name": "human",
  "text": "I quit my agency job in March 2023 and I'm not gonna lie, it scared me. Rent was $2,400 and I had maybe six weeks of savings. My buddy Dan told me to just post every day. So I did. Day 3, nothing. Day 19, one DM from a bakery in Austin. They paid me $300 to shoot a reel. That's it. That was the whole thing.\n\nHonestly? I didn't have a plan. I still don't. But I've learned a few things since then, and they aren't what the gurus say. Don't buy the course. Call the bakery. I did that 40 times in April and eleven said yes, which blew my mind, because I expected two.\n\nWe're at $9k a month now. My mom still asks when I'll get a real job. I tell her I already did.\n",
  "expected": {
   "source": "X",
   "checks": {
    "BURSTINESS": {
     "score": 79.5,
     "detail": "variation 0.60 across 17 sentences (want 0.55+)"
    },
    "SPECIFICITY": {
     "score": 100.0,
     "detail": "12 concrete markers, 9.0 per 100 words (want 4+)"
    },
    "SLOP DENSITY": {
     "score": 100.0,
     "detail": "0 stock terms, 0.0 per 100 words"
    },
    "FINGERPRINT": {
     "score": 100.0,
     "detail": "0 invisible, 0 em dash, 0 curly quote, 0 ellipsis, 0 hard space"
    },
    "VOICE": {
     "score": 100.0,
     "detail": "6.8 contractions, 15.0 personal pronouns per 100 words, 0 structural tell(s)"
    }
   },
   "human_score": 89.4,
   "verdict": "PASS"
  }
 },
 {
  "name": "invisible",
  "text": "Hello\u200b world\u200d this\u2060 is\ufeff a\u00ad test\u00a0with\u202fnarrow and\u2009thin spaces\u200e and a tag\udb40\udc41\udb40\udc42 char\u2063 too. Another line about the Barcelona trip we took in 2022 with Carlos and Ana.\n",
  "expected": {
   "source": "X",
   "checks": {
    "BURSTINESS": {
     "score": 50.0,
     "detail": "too short to judge"
    },
    "SPECIFICITY": {
     "score": 100.0,
     "detail": "4 concrete markers, 13.8 per 100 words (want 4+)"
    },
    "SLOP DENSITY": {
     "score": 100.0,
     "detail": "0 stock terms, 0.0 per 100 words"
    },
    "FINGERPRINT": {
     "score": 0.0,
     "detail": "9 invisible, 0 em dash, 0 curly quote, 0 ellipsis, 3 hard space"
    },
    "VOICE": {
     "score": 42.2,
     "detail": "0.0 contractions, 3.4 personal pronouns per 100 words, 0 structural tell(s)"
    }
   },
   "human_score": 35.1,
   "verdict": "FLAGGED"
  }
 },
 {
  "name": "typo",
  "text": "\u201cWe\u2019re live \u2014 finally\u201d, she said\u2026 It cost 5\u201310 dollars \u2013 maybe more \u2013 for the \u2018best\u2019 tools. \u2022 first \u2022 second \u2192 third. Visit https://example.com/a\u2014b?x=1 or mail me\u2014jane@ex\u2014ample.com now \u2014 or later.\n\nThe result? It\u2019s fine \u2014 really. \u2014 Another.\n",
  "expected": {
   "source": "X",
   "checks": {
    "BURSTINESS": {
     "score": 100.0,
     "detail": "variation 0.72 across 5 sentences (want 0.55+)"
    },
    "SPECIFICITY": {
     "score": 100.0,
     "detail": "4 concrete markers, 9.5 per 100 words (want 4+)"
    },
    "SLOP DENSITY": {
     "score": 100.0,
     "detail": "0 stock terms, 0.0 per 100 words"
    },
    "FINGERPRINT": {
     "score": 0.0,
     "detail": "0 invisible, 7 em dash, 6 curly quote, 1 ellipsis, 0 hard space"
    },
    "VOICE": {
     "score": 48.8,
     "detail": "0.0 contractions, 4.8 personal pronouns per 100 words, 0 structural tell(s)"
    }
   },
   "human_score": 41.9,
   "verdict": "FLAGGED"
  }
 },
 {
  "name": "spanish",
  "text": "Hoy quiero hablarte de algo que me cambi\u00f3 la vida: levantarme a las 5 de la ma\u00f1ana. No es magia, es disciplina. Mi amiga Carmen lo hace desde 2019 y ahora gana 4.000 euros al mes en Madrid. \u00bfPor qu\u00e9 nadie habla de esto? Porque da pereza. Pero si lo pruebas durante 30 d\u00edas vas a ver la diferencia. \u00c1nimo, t\u00fa puedes. Es m\u00e1s f\u00e1cil de lo que piensas, \u00bfno crees? En fin, \u00a1vamos all\u00e1! Aqu\u00ed va mi consejo n\u00famero uno: duerme temprano.\n",
  "expected": {
   "source": "X",
   "checks": {
    "BURSTINESS": {
     "score": 67.1,
     "detail": "variation 0.54 across 11 sentences (want 0.55+)"
    },
    "SPECIFICITY": {
     "score": 100.0,
     "detail": "7 concrete markers, 8.3 per 100 words (want 4+)"
    },
    "SLOP DENSITY": {
     "score": 100.0,
     "detail": "0 stock terms, 0.0 per 100 words"
    },
    "FINGERPRINT": {
     "score": 100.0,
     "detail": "0 invisible, 0 em dash, 0 curly quote, 0 ellipsis, 0 hard space"
    },
    "VOICE": {
     "score": 31.0,
     "detail": "0.0 contractions, 1.2 personal pronouns per 100 words, 0 structural tell(s)"
    }
   },
   "human_score": 60.1,
   "verdict": "REVIEW"
  }
 },
 {
  "name": "wall",
  "text": "\ud83d\ude80 Big news for creators!\n\u2705 Save time on editing\n\u2705 Grow your audience faster\n\u2705 Monetize your passion today\n\nSTOP DOING THIS WRONG TODAY NOW\n\n- Fast reliable content tools\n- Easy simple workflow steps\n- Great clean design always\n- Smart quick results daily\n\nFollow for more tips. Tag someone who needs this. Thoughts?\n#reels #growth #creator #viral #fyp #instagram #tips\n",
  "expected": {
   "source": "X",
   "checks": {
    "BURSTINESS": {
     "score": 0.0,
     "detail": "variation 0.13 across 12 sentences (want 0.55+)"
    },
    "SPECIFICITY": {
     "score": 100.0,
     "detail": "8 concrete markers, 14.5 per 100 words (want 4+)"
    },
    "SLOP DENSITY": {
     "score": 9.1,
     "detail": "2 stock terms, 3.6 per 100 words (follow for more, tag someone who needs this)"
    },
    "FINGERPRINT": {
     "score": 100.0,
     "detail": "0 invisible, 0 em dash, 0 curly quote, 0 ellipsis, 0 hard space"
    },
    "VOICE": {
     "score": 1.2,
     "detail": "0.0 contractions, 3.6 personal pronouns per 100 words, 10 structural tell(s) [rocket, hashtag-wall, engagement-bait, emoji-bullets]"
    }
   },
   "human_score": 25.2,
   "verdict": "FLAGGED"
  }
 },
 {
  "name": "lower",
  "text": "here's the thing. i delve into leverage every day and it's honestly pivotal. so yeah. the harsh truth is nobody cares, and that's okay. buckle up. we shipped it in 3 days with Sam and it worked.\n",
  "expected": {
   "source": "X",
   "checks": {
    "BURSTINESS": {
     "score": 32.8,
     "detail": "variation 0.38 across 4 sentences (want 0.55+)"
    },
    "SPECIFICITY": {
     "score": 91.9,
     "detail": "2 concrete markers, 5.6 per 100 words (want 4+)"
    },
    "SLOP DENSITY": {
     "score": 0.0,
     "detail": "7 stock terms, 19.4 per 100 words (buckle up, delve, delve into, here's the thing, ...)"
    },
    "FINGERPRINT": {
     "score": 100.0,
     "detail": "0 invisible, 0 em dash, 0 curly quote, 0 ellipsis, 0 hard space"
    },
    "VOICE": {
     "score": 87.8,
     "detail": "8.3 contractions, 5.6 personal pronouns per 100 words, 0 structural tell(s)"
    }
   },
   "human_score": 37.5,
   "verdict": "FLAGGED"
  }
 },
 {
  "name": "short",
  "text": "Just a short note.\n",
  "expected": {
   "source": "X",
   "checks": {
    "BURSTINESS": {
     "score": 50.0,
     "detail": "too short to judge"
    },
    "SPECIFICITY": {
     "score": 50.0,
     "detail": "too short to judge"
    },
    "SLOP DENSITY": {
     "score": 100.0,
     "detail": "0 stock terms, 0.0 per 100 words"
    },
    "FINGERPRINT": {
     "score": 100.0,
     "detail": "0 invisible, 0 em dash, 0 curly quote, 0 ellipsis, 0 hard space"
    },
    "VOICE": {
     "score": 50.0,
     "detail": "too short to judge"
    }
   },
   "human_score": 62.0,
   "verdict": "REVIEW"
  }
 },
 {
  "name": "crlf",
  "text": "First sentence is here today.\nSecond sentence goes on a bit longer than the first one.\nThird. Fourth sentence is short too, honestly.\nFifth one wraps the whole thing up nicely for you.\n",
  "expected": {
   "source": "X",
   "checks": {
    "BURSTINESS": {
     "score": 20.6,
     "detail": "variation 0.32 across 4 sentences (want 0.55+)"
    },
    "SPECIFICITY": {
     "score": 0.0,
     "detail": "0 concrete markers, 0.0 per 100 words (want 4+)"
    },
    "SLOP DENSITY": {
     "score": 100.0,
     "detail": "0 stock terms, 0.0 per 100 words"
    },
    "FINGERPRINT": {
     "score": 100.0,
     "detail": "0 invisible, 0 em dash, 0 curly quote, 0 ellipsis, 0 hard space"
    },
    "VOICE": {
     "score": 40.2,
     "detail": "0.0 contractions, 3.0 personal pronouns per 100 words, 0 structural tell(s)"
    }
   },
   "human_score": 31.3,
   "verdict": "FLAGGED"
  }
 },
 {
  "name": "bullets",
  "text": "Here are my notes on the trip for the team and for anyone who cares about them.\n- one two three four\n- five six seven eight\n- nine ten eleven twelve\n\u2022 alpha beta gamma delta\nWe went to Lisbon in May and spent 900 euros, which is not bad for a week.\n",
  "expected": {
   "source": "X",
   "checks": {
    "BURSTINESS": {
     "score": 85.1,
     "detail": "variation 0.63 across 6 sentences (want 0.55+)"
    },
    "SPECIFICITY": {
     "score": 100.0,
     "detail": "3 concrete markers, 6.1 per 100 words (want 4+)"
    },
    "SLOP DENSITY": {
     "score": 100.0,
     "detail": "0 stock terms, 0.0 per 100 words"
    },
    "FINGERPRINT": {
     "score": 100.0,
     "detail": "0 invisible, 0 em dash, 0 curly quote, 0 ellipsis, 0 hard space"
    },
    "VOICE": {
     "score": 33.4,
     "detail": "0.0 contractions, 4.1 personal pronouns per 100 words, 0 structural tell(s) [uniform-bullets]"
    }
   },
   "human_score": 63.6,
   "verdict": "REVIEW"
  }
 },
 {
  "name": "after",
  "text": "I wrote this one myself in about ten minutes. We left Lisbon at 6am on Friday, and it rained the whole way. Sam drove. I ate cold pizza. It was great, honestly, and I'd do it again tomorrow if my knees let me.\n",
  "expected": {
   "source": "X",
   "checks": {
    "BURSTINESS": {
     "score": 39.6,
     "detail": "variation 0.41 across 4 sentences (want 0.55+)"
    },
    "SPECIFICITY": {
     "score": 75.5,
     "detail": "2 concrete markers, 4.7 per 100 words (want 4+)"
    },
    "SLOP DENSITY": {
     "score": 100.0,
     "detail": "0 stock terms, 0.0 per 100 words"
    },
    "FINGERPRINT": {
     "score": 100.0,
     "detail": "0 invisible, 0 em dash, 0 curly quote, 0 ellipsis, 0 hard space"
    },
    "VOICE": {
     "score": 92.1,
     "detail": "2.3 contractions, 14.0 personal pronouns per 100 words, 0 structural tell(s)"
    }
   },
   "human_score": 64.7,
   "verdict": "REVIEW"
  }
 },
 {
  "name": "empty2",
  "text": "",
  "expected": {
   "source": "X",
   "checks": {
    "BURSTINESS": {
     "score": 50.0,
     "detail": "too short to judge"
    },
    "SPECIFICITY": {
     "score": 50.0,
     "detail": "too short to judge"
    },
    "SLOP DENSITY": {
     "score": 50.0,
     "detail": "empty"
    },
    "FINGERPRINT": {
     "score": 100.0,
     "detail": "0 invisible, 0 em dash, 0 curly quote, 0 ellipsis, 0 hard space"
    },
    "VOICE": {
     "score": 50.0,
     "detail": "too short to judge"
    }
   },
   "human_score": 56.0,
   "verdict": "REVIEW"
  }
 }
];
const HUMANIZE: { name: string; text: string; expected: { text: string; report: ReturnType<typeof humanize>["report"] } }[] = [
 {
  "name": "sloppy",
  "text": "In today's fast-paced world, it's no secret that creators must leverage a robust and comprehensive strategy to unlock their potential. Let's delve into the transformative landscape of social media \u2014 a vibrant tapestry of ideas. It's not just about content, it's about connection. Furthermore, it is crucial to foster a seamless journey for your audience. Our innovative, holistic, game-changing approach will elevate your brand. Here's what I learned: consistency matters. Not only does it build trust but also it empowers your community. Whether you are new, experienced, or curious. In conclusion, the future is here, and it's time to embark on a pivotal adventure. Let that sink in. Agree?\n",
  "expected": {
   "text": "Right now, creators must use a solid and complete strategy to get their potential. Let's look at the big market of social media, a vibrant mix of ideas. It's not just about content, it's about connection. Also, it is important to build a clean process for your audience. Our new, whole, big approach will improve your brand. Here's what I learned: consistency matters. Not only does it build trust but also it empowers your community. Whether you are new, experienced, or curious. So, and it's time to start a key adventure. Agree?\n",
   "report": {
    "invisible": [],
    "typographic": [
     {
      "name": "\u2014 EM DASH",
      "count": 1,
      "to": ","
     }
    ],
    "lexical": [
     {
      "find": "in today's fast-paced world",
      "replace": "right now",
      "count": 1,
      "family": "openers"
     },
     {
      "find": "it's no secret that",
      "replace": "(deleted)",
      "count": 1,
      "family": "openers"
     },
     {
      "find": "the future is here",
      "replace": "(deleted)",
      "count": 1,
      "family": "closers"
     },
     {
      "find": "let that sink in",
      "replace": "(deleted)",
      "count": 1,
      "family": "closers"
     },
     {
      "find": "transformative",
      "replace": "big",
      "count": 1,
      "family": "adjectives"
     },
     {
      "find": "comprehensive",
      "replace": "complete",
      "count": 1,
      "family": "adjectives"
     },
     {
      "find": "game-changing",
      "replace": "big",
      "count": 1,
      "family": "adjectives"
     },
     {
      "find": "in conclusion",
      "replace": "so",
      "count": 1,
      "family": "connectives"
     },
     {
      "find": "furthermore",
      "replace": "also",
      "count": 1,
      "family": "connectives"
     },
     {
      "find": "delve into",
      "replace": "look at",
      "count": 1,
      "family": "verbs"
     },
     {
      "find": "innovative",
      "replace": "new",
      "count": 1,
      "family": "adjectives"
     },
     {
      "find": "embark on",
      "replace": "start",
      "count": 1,
      "family": "verbs"
     },
     {
      "find": "landscape",
      "replace": "market",
      "count": 1,
      "family": "nouns"
     },
     {
      "find": "leverage",
      "replace": "use",
      "count": 1,
      "family": "verbs"
     },
     {
      "find": "seamless",
      "replace": "clean",
      "count": 1,
      "family": "adjectives"
     },
     {
      "find": "holistic",
      "replace": "whole",
      "count": 1,
      "family": "adjectives"
     },
     {
      "find": "tapestry",
      "replace": "mix",
      "count": 1,
      "family": "nouns"
     },
     {
      "find": "elevate",
      "replace": "improve",
      "count": 1,
      "family": "verbs"
     },
     {
      "find": "pivotal",
      "replace": "key",
      "count": 1,
      "family": "adjectives"
     },
     {
      "find": "crucial",
      "replace": "important",
      "count": 1,
      "family": "adjectives"
     },
     {
      "find": "journey",
      "replace": "process",
      "count": 1,
      "family": "nouns"
     },
     {
      "find": "foster",
      "replace": "build",
      "count": 1,
      "family": "verbs"
     },
     {
      "find": "unlock",
      "replace": "get",
      "count": 1,
      "family": "verbs"
     },
     {
      "find": "robust",
      "replace": "solid",
      "count": 1,
      "family": "adjectives"
     }
    ],
    "structures": [
     {
      "name": "\"It's not just X, it's Y\"",
      "count": 1,
      "fix": "Say the one thing you actually mean. Delete the setup half."
     },
     {
      "name": "\"Not only X but also Y\"",
      "count": 1,
      "fix": "Split into two sentences, or drop the weaker half."
     },
     {
      "name": "\"Here's what I learned\"",
      "count": 1,
      "fix": "State the lesson. Skip the announcement."
     },
     {
      "name": "Reflex engagement bait",
      "count": 1,
      "fix": "Ask a question only you could ask, about the specific thing above it."
     },
     {
      "name": "Uniform sentence length (variation 0.28)",
      "count": 9,
      "fix": "Break one sentence in half. Let another run long. Machines write even."
     }
    ]
   }
  }
 },
 {
  "name": "human",
  "text": "I quit my agency job in March 2023 and I'm not gonna lie, it scared me. Rent was $2,400 and I had maybe six weeks of savings. My buddy Dan told me to just post every day. So I did. Day 3, nothing. Day 19, one DM from a bakery in Austin. They paid me $300 to shoot a reel. That's it. That was the whole thing.\n\nHonestly? I didn't have a plan. I still don't. But I've learned a few things since then, and they aren't what the gurus say. Don't buy the course. Call the bakery. I did that 40 times in April and eleven said yes, which blew my mind, because I expected two.\n\nWe're at $9k a month now. My mom still asks when I'll get a real job. I tell her I already did.\n",
  "expected": {
   "text": "I quit my agency job in March 2023 and I'm not gonna lie, it scared me. Rent was $2,400 and I had maybe six weeks of savings. My buddy Dan told me to just post every day. So I did. Day 3, nothing. Day 19, one DM from a bakery in Austin. They paid me $300 to shoot a reel. That's it. That was the whole thing.\n\nHonestly? I didn't have a plan. I still don't. But I've learned a few things since then, and they aren't what the gurus say. Don't buy the course. Call the bakery. I did that 40 times in April and eleven said yes, which blew my mind, because I expected two.\n\nWe're at $9k a month now. My mom still asks when I'll get a real job. I tell her I already did.\n",
   "report": {
    "invisible": [],
    "typographic": [],
    "lexical": [],
    "structures": []
   }
  }
 },
 {
  "name": "invisible",
  "text": "Hello\u200b world\u200d this\u2060 is\ufeff a\u00ad test\u00a0with\u202fnarrow and\u2009thin spaces\u200e and a tag\udb40\udc41\udb40\udc42 char\u2063 too. Another line about the Barcelona trip we took in 2022 with Carlos and Ana.\n",
  "expected": {
   "text": "Hello world this is a test with narrow and thin spaces and a tag char too. Another line about the Barcelona trip we took in 2022 with Carlos and Ana.\n",
   "report": {
    "invisible": [
     {
      "name": "U+200B ZERO WIDTH SPACE",
      "count": 1,
      "action": "delete"
     },
     {
      "name": "U+200D ZERO WIDTH JOINER",
      "count": 1,
      "action": "delete"
     },
     {
      "name": "U+2060 WORD JOINER",
      "count": 1,
      "action": "delete"
     },
     {
      "name": "U+FEFF ZERO WIDTH NO-BREAK SPACE / BOM",
      "count": 1,
      "action": "delete"
     },
     {
      "name": "U+00AD SOFT HYPHEN",
      "count": 1,
      "action": "delete"
     },
     {
      "name": "U+200E LEFT-TO-RIGHT MARK",
      "count": 1,
      "action": "delete"
     },
     {
      "name": "U+E0000-U+E007F TAG CHARACTERS (invisible ASCII smuggling)",
      "count": 2,
      "action": "delete"
     },
     {
      "name": "U+00A0 NO-BREAK SPACE",
      "count": 1,
      "action": "space"
     },
     {
      "name": "U+202F NARROW NO-BREAK SPACE",
      "count": 1,
      "action": "space"
     },
     {
      "name": "U+2009 THIN SPACE",
      "count": 1,
      "action": "space"
     },
     {
      "name": "U+2063 INVISIBLE SEPARATOR",
      "count": 1,
      "action": "delete"
     }
    ],
    "typographic": [],
    "lexical": [],
    "structures": []
   }
  }
 },
 {
  "name": "typo",
  "text": "\u201cWe\u2019re live \u2014 finally\u201d, she said\u2026 It cost 5\u201310 dollars \u2013 maybe more \u2013 for the \u2018best\u2019 tools. \u2022 first \u2022 second \u2192 third. Visit https://example.com/a\u2014b?x=1 or mail me\u2014jane@ex\u2014ample.com now \u2014 or later.\n\nThe result? It\u2019s fine \u2014 really. \u2014 Another.\n",
  "expected": {
   "text": "\"We're live, finally\", she said... It cost 5-10 dollars, maybe more, for the 'best' tools. - first - second -> third. Visit https://example.com/a\u2014b?x=1 or mail me\u2014jane@ex\u2014ample.com now, or later.\n\nThe result? It's fine, really., Another.\n",
   "report": {
    "invisible": [],
    "typographic": [
     {
      "name": "\u2014 EM DASH",
      "count": 4,
      "to": ","
     },
     {
      "name": "\u2013 EN DASH",
      "count": 3,
      "to": "-"
     },
     {
      "name": "\u2018 LEFT SINGLE QUOTE",
      "count": 1,
      "to": "'"
     },
     {
      "name": "\u2019 RIGHT SINGLE QUOTE",
      "count": 3,
      "to": "'"
     },
     {
      "name": "\u201c LEFT DOUBLE QUOTE",
      "count": 1,
      "to": "\""
     },
     {
      "name": "\u201d RIGHT DOUBLE QUOTE",
      "count": 1,
      "to": "\""
     },
     {
      "name": "\u2026 HORIZONTAL ELLIPSIS",
      "count": 1,
      "to": "..."
     },
     {
      "name": "\u2022 BULLET",
      "count": 2,
      "to": "-"
     },
     {
      "name": "\u2192 RIGHTWARDS ARROW",
      "count": 1,
      "to": "->"
     }
    ],
    "lexical": [],
    "structures": []
   }
  }
 },
 {
  "name": "spanish",
  "text": "Hoy quiero hablarte de algo que me cambi\u00f3 la vida: levantarme a las 5 de la ma\u00f1ana. No es magia, es disciplina. Mi amiga Carmen lo hace desde 2019 y ahora gana 4.000 euros al mes en Madrid. \u00bfPor qu\u00e9 nadie habla de esto? Porque da pereza. Pero si lo pruebas durante 30 d\u00edas vas a ver la diferencia. \u00c1nimo, t\u00fa puedes. Es m\u00e1s f\u00e1cil de lo que piensas, \u00bfno crees? En fin, \u00a1vamos all\u00e1! Aqu\u00ed va mi consejo n\u00famero uno: duerme temprano.\n",
  "expected": {
   "text": "Hoy quiero hablarte de algo que me cambi\u00f3 la vida: levantarme a las 5 de la ma\u00f1ana. No es magia, es disciplina. Mi amiga Carmen lo hace desde 2019 y ahora gana 4.000 euros al mes en Madrid. \u00bfPor qu\u00e9 nadie habla de esto? Porque da pereza. Pero si lo pruebas durante 30 d\u00edas vas a ver la diferencia. \u00c1nimo, t\u00fa puedes. Es m\u00e1s f\u00e1cil de lo que piensas, \u00bfno crees? En fin, \u00a1vamos all\u00e1! Aqu\u00ed va mi consejo n\u00famero uno: duerme temprano.\n",
   "report": {
    "invisible": [],
    "typographic": [],
    "lexical": [],
    "structures": []
   }
  }
 },
 {
  "name": "wall",
  "text": "\ud83d\ude80 Big news for creators!\n\u2705 Save time on editing\n\u2705 Grow your audience faster\n\u2705 Monetize your passion today\n\nSTOP DOING THIS WRONG TODAY NOW\n\n- Fast reliable content tools\n- Easy simple workflow steps\n- Great clean design always\n- Smart quick results daily\n\nFollow for more tips. Tag someone who needs this. Thoughts?\n#reels #growth #creator #viral #fyp #instagram #tips\n",
  "expected": {
   "text": "\ud83d\ude80 Big news for creators!\n\u2705 Save time on editing\n\u2705 Grow your audience faster\n\u2705 Monetize your passion today\n\nSTOP DOING THIS WRONG TODAY NOW\n\n- Fast reliable content tools\n- Easy simple workflow steps\n- Great clean design always\n- Smart quick results daily\n\nTips. Thoughts?\n#reels #growth #creator #viral #fyp #instagram #tips\n",
   "report": {
    "invisible": [],
    "typographic": [],
    "lexical": [
     {
      "find": "tag someone who needs this",
      "replace": "(deleted)",
      "count": 1,
      "family": "closers"
     },
     {
      "find": "follow for more",
      "replace": "(deleted)",
      "count": 1,
      "family": "closers"
     }
    ],
    "structures": [
     {
      "name": "Rocket / fire / bulb / sparkle / dart emoji",
      "count": 1,
      "fix": "One emoji max, and not one of these five."
     },
     {
      "name": "Hashtag wall (5+)",
      "count": 1,
      "fix": "Three hashtags. LinkedIn stopped rewarding the wall."
     },
     {
      "name": "Reflex engagement bait",
      "count": 1,
      "fix": "Ask a question only you could ask, about the specific thing above it."
     },
     {
      "name": "Emoji bullet list",
      "count": 4,
      "fix": "Use a hyphen or a line break. Emoji bullets are the single most template-looking thing in a caption."
     },
     {
      "name": "Three or more shouted words in a row",
      "count": 1,
      "fix": "Caps are a volume knob, not a highlighter. One word, at most."
     },
     {
      "name": "Uniform sentence length (variation 0.12)",
      "count": 10,
      "fix": "Break one sentence in half. Let another run long. Machines write even."
     }
    ]
   }
  }
 },
 {
  "name": "lower",
  "text": "here's the thing. i delve into leverage every day and it's honestly pivotal. so yeah. the harsh truth is nobody cares, and that's okay. buckle up. we shipped it in 3 days with Sam and it worked.\n",
  "expected": {
   "text": "i look at use every day and it's honestly key. so yeah. nobody cares, and that's okay. we shipped it in 3 days with Sam and it worked.\n",
   "report": {
    "invisible": [],
    "typographic": [],
    "lexical": [
     {
      "find": "the harsh truth is",
      "replace": "(deleted)",
      "count": 1,
      "family": "openers"
     },
     {
      "find": "here's the thing",
      "replace": "(deleted)",
      "count": 1,
      "family": "openers"
     },
     {
      "find": "delve into",
      "replace": "look at",
      "count": 1,
      "family": "verbs"
     },
     {
      "find": "buckle up",
      "replace": "(deleted)",
      "count": 1,
      "family": "openers"
     },
     {
      "find": "leverage",
      "replace": "use",
      "count": 1,
      "family": "verbs"
     },
     {
      "find": "pivotal",
      "replace": "key",
      "count": 1,
      "family": "adjectives"
     }
    ],
    "structures": []
   }
  }
 },
 {
  "name": "short",
  "text": "Just a short note.\n",
  "expected": {
   "text": "Just a short note.\n",
   "report": {
    "invisible": [],
    "typographic": [],
    "lexical": [],
    "structures": []
   }
  }
 },
 {
  "name": "crlf",
  "text": "First sentence is here today.\nSecond sentence goes on a bit longer than the first one.\nThird. Fourth sentence is short too, honestly.\nFifth one wraps the whole thing up nicely for you.\n",
  "expected": {
   "text": "First sentence is here today.\nSecond sentence goes on a bit longer than the first one.\nThird. Fourth sentence is short too, honestly.\nFifth one wraps the whole thing up nicely for you.\n",
   "report": {
    "invisible": [],
    "typographic": [],
    "lexical": [],
    "structures": [
     {
      "name": "Uniform sentence length (variation 0.32)",
      "count": 4,
      "fix": "Break one sentence in half. Let another run long. Machines write even."
     }
    ]
   }
  }
 },
 {
  "name": "bullets",
  "text": "Here are my notes on the trip for the team and for anyone who cares about them.\n- one two three four\n- five six seven eight\n- nine ten eleven twelve\n\u2022 alpha beta gamma delta\nWe went to Lisbon in May and spent 900 euros, which is not bad for a week.\n",
  "expected": {
   "text": "Here are my notes on the trip for the team and for anyone who cares about them.\n- one two three four\n- five six seven eight\n- nine ten eleven twelve\n- alpha beta gamma delta\nWe went to Lisbon in May and spent 900 euros, which is not bad for a week.\n",
   "report": {
    "invisible": [],
    "typographic": [
     {
      "name": "\u2022 BULLET",
      "count": 1,
      "to": "-"
     }
    ],
    "lexical": [],
    "structures": []
   }
  }
 },
 {
  "name": "after",
  "text": "I wrote this one myself in about ten minutes. We left Lisbon at 6am on Friday, and it rained the whole way. Sam drove. I ate cold pizza. It was great, honestly, and I'd do it again tomorrow if my knees let me.\n",
  "expected": {
   "text": "I wrote this one myself in about ten minutes. We left Lisbon at 6am on Friday, and it rained the whole way. Sam drove. I ate cold pizza. It was great, honestly, and I'd do it again tomorrow if my knees let me.\n",
   "report": {
    "invisible": [],
    "typographic": [],
    "lexical": [],
    "structures": []
   }
  }
 },
 {
  "name": "empty2",
  "text": "",
  "expected": {
   "text": "\n",
   "report": {
    "invisible": [],
    "typographic": [],
    "lexical": [],
    "structures": []
   }
  }
 }
];
const RENDER: Record<string, { out: string; text?: string; hook?: string; hooks?: string[] }> = {
 "hookOne": {
  "hook": "Don't scroll. You're wrong about hooks, and it's costing you 40% of your reach in 3 days.",
  "out": "\nHOOK SCORE\n==============================================================\n  \"Don't scroll. You're wrong about hooks, and it's costing you 40% of your reach in 3 days.\"\n\n  LENGTH        ########................  33.0\n                17 words, 89 chars, ~6.2s spoken (want 5-12 words)\n  SPECIFICITY   ######################## 100.0\n                3 concrete marker(s): 40%, 3 days, You\n  STAKES        ######################## 100.0\n                2 tension marker(s): don't, wrong\n  FRONTLOAD     ######################## 100.0\n                payload at word 1\n  ADDRESS       ######################## 100.0\n                speaks to the viewer\n--------------------------------------------------------------\n  HOOK SCORE    ############............  50.2   OK\n\n  DEALBREAKER  Opens with \"stop scrolling\". Asking for attention proves you have not earned it.\n\n  Weakest property: LENGTH. Fix that one and re-run.\n\n"
 },
 "hookTable": {
  "hooks": [
   "I lost $18,000 on one missing contract.",
   "Hey guys, welcome back to my channel, today we are going to talk about something",
   "Stop scrolling! This changes everything \ud83d\ude80",
   "Nobody tells you this about Instagram reach in 2025",
   "You're paying $49 a month for a tool that you never use",
   "In this video I'm going to show you how to grow",
   "Why do 90% of founders quit before month 12?",
   "Quit your job. Don't wait for permission.",
   "la verdad es que nunca pierdes dinero cuando inviertes en tu negocio y aprendes cada d\u00eda",
   "#fyp this is a hook",
   "Steal this 3-step hook, free",
   "Ok so basically I wanted to say that sometimes things are hard and it takes a lot of time to figure out",
   "Apple fired 12 people in 4 minutes",
   "Nuestro cliente perdi\u00f3 20 mil euros en una semana y nadie se lo dijo"
  ],
  "out": "\nHOOK RANKING\n==============================================================================\n->  87.0 STRONG  Quit your job. Don't wait for permission.\n        weakest: SPECIFICITY (75)\n    84.4 STRONG  Nobody tells you this about Instagram reach in 2025\n        weakest: STAKES (70)\n    81.4 STRONG  I lost $18,000 on one missing contract.\n        weakest: ADDRESS (70)\n    81.4 STRONG  You're paying $49 a month for a tool that you never use\n        weakest: FRONTLOAD (70)\n    80.2 STRONG  Steal this 3-step hook, free\n        weakest: STAKES (70)\n    66.2 OK      Why do 90% of founders quit before month 12?\n        weakest: ADDRESS (35)\n    62.6 OK      Apple fired 12 people in 4 minutes\n        weakest: ADDRESS (35)\n    50.2 OK      Stop scrolling! This changes everything \ud83d\ude80\n        weakest: STAKES (70)\n        dealbreaker: Opens with \"stop scrolling\". Asking for attention proves you have not earned it.\n        dealbreaker: Emoji in the hook. On-screen text at hook size has room for words or for an emoji, not both.\n    43.5 WEAK    Nuestro cliente perdi\u00f3 20 mil euros en una semana y nadie s...\n        weakest: STAKES (20)\n    22.0 WEAK    la verdad es que nunca pierdes dinero cuando inviertes en t...\n        weakest: SPECIFICITY (15)\n    15.0 WEAK    #fyp this is a hook\n        weakest: SPECIFICITY (15)\n        dealbreaker: Hashtag in the hook. Hashtags belong at the bottom of the caption, if anywhere.\n    13.2 WEAK    In this video I'm going to show you how to grow\n        weakest: FRONTLOAD (0)\n        dealbreaker: Video preamble. Delete it and open on the payoff.\n    12.6 WEAK    Ok so basically I wanted to say that sometimes things are h...\n        weakest: LENGTH (0)\n     4.2 WEAK    Hey guys, welcome back to my channel, today we are going to...\n        weakest: FRONTLOAD (0)\n        dealbreaker: Greeting. Nobody came to the feed to be greeted.\n\nShoot the top one. If the top one is under 50, none of these are the hook.\n\n"
 },
 "detectSloppy": {
  "text": "In today's fast-paced world, it's no secret that creators must leverage a robust and comprehensive strategy to unlock their potential. Let's delve into the transformative landscape of social media \u2014 a vibrant tapestry of ideas. It's not just about content, it's about connection. Furthermore, it is crucial to foster a seamless journey for your audience. Our innovative, holistic, game-changing approach will elevate your brand. Here's what I learned: consistency matters. Not only does it build trust but also it empowers your community. Whether you are new, experienced, or curious. In conclusion, the future is here, and it's time to embark on a pivotal adventure. Let that sink in. Agree?\n",
  "out": "\nAI DETECTION PANEL\n==============================================================\n  BURSTINESS    ###########.............  44.2\n                variation 0.43 across 10 sentences (want 0.55+)\n  SPECIFICITY   ........................   0.0\n                0 concrete markers, 0.0 per 100 words (want 4+)\n  SLOP DENSITY  ........................   0.0\n                25 stock terms, 22.7 per 100 words (comprehensive, crucial, delve, delve into, ...)\n  FINGERPRINT   ##################......  75.9\n                0 invisible, 1 em dash, 0 curly quote, 0 ellipsis, 0 hard space\n  VOICE         ###############.........  60.9\n                6.4 contractions, 5.5 personal pronouns per 100 words, 4 structural tell(s) [not-just, not-only, heres-what, engagement-bait]\n--------------------------------------------------------------\n  HUMAN SCORE   #####...................  21.7   FLAGGED\n\n  Weakest signal: SPECIFICITY. Fix that first.\n\n"
 },
 "detectHuman": {
  "text": "I quit my agency job in March 2023 and I'm not gonna lie, it scared me. Rent was $2,400 and I had maybe six weeks of savings. My buddy Dan told me to just post every day. So I did. Day 3, nothing. Day 19, one DM from a bakery in Austin. They paid me $300 to shoot a reel. That's it. That was the whole thing.\n\nHonestly? I didn't have a plan. I still don't. But I've learned a few things since then, and they aren't what the gurus say. Don't buy the course. Call the bakery. I did that 40 times in April and eleven said yes, which blew my mind, because I expected two.\n\nWe're at $9k a month now. My mom still asks when I'll get a real job. I tell her I already did.\n",
  "out": "\nAI DETECTION PANEL\n==============================================================\n  BURSTINESS    ###################.....  79.5\n                variation 0.60 across 17 sentences (want 0.55+)\n  SPECIFICITY   ######################## 100.0\n                12 concrete markers, 9.0 per 100 words (want 4+)\n  SLOP DENSITY  ######################## 100.0\n                0 stock terms, 0.0 per 100 words\n  FINGERPRINT   ######################## 100.0\n                0 invisible, 0 em dash, 0 curly quote, 0 ellipsis, 0 hard space\n  VOICE         ######################## 100.0\n                6.8 contractions, 15.0 personal pronouns per 100 words, 0 structural tell(s)\n--------------------------------------------------------------\n  HUMAN SCORE   #####################...  89.4   PASS\n\n"
 },
 "reportTypo": {
  "text": "\u201cWe\u2019re live \u2014 finally\u201d, she said\u2026 It cost 5\u201310 dollars \u2013 maybe more \u2013 for the \u2018best\u2019 tools. \u2022 first \u2022 second \u2192 third. Visit https://example.com/a\u2014b?x=1 or mail me\u2014jane@ex\u2014ample.com now \u2014 or later.\n\nThe result? It\u2019s fine \u2014 really. \u2014 Another.\n",
  "out": "\nHUMANIZE REPORT\n---------------\n17 machine artefacts removed, 0 structural tells flagged for rewrite\n\n2. TYPOGRAPHY\n-------------\n    4x  \u2014 EM DASH  -> ,\n    3x  \u2013 EN DASH  -> -\n    1x  \u2018 LEFT SINGLE QUOTE  -> '\n    3x  \u2019 RIGHT SINGLE QUOTE  -> '\n    1x  \u201c LEFT DOUBLE QUOTE  -> \"\n    1x  \u201d RIGHT DOUBLE QUOTE  -> \"\n    1x  \u2026 HORIZONTAL ELLIPSIS  -> ...\n    2x  \u2022 BULLET  -> -\n    1x  \u2192 RIGHTWARDS ARROW  -> ->\n\n"
 },
 "reportSloppy": {
  "text": "In today's fast-paced world, it's no secret that creators must leverage a robust and comprehensive strategy to unlock their potential. Let's delve into the transformative landscape of social media \u2014 a vibrant tapestry of ideas. It's not just about content, it's about connection. Furthermore, it is crucial to foster a seamless journey for your audience. Our innovative, holistic, game-changing approach will elevate your brand. Here's what I learned: consistency matters. Not only does it build trust but also it empowers your community. Whether you are new, experienced, or curious. In conclusion, the future is here, and it's time to embark on a pivotal adventure. Let that sink in. Agree?\n",
  "out": "\nHUMANIZE REPORT\n---------------\n25 machine artefacts removed, 5 structural tells flagged for rewrite\n\n2. TYPOGRAPHY\n-------------\n    1x  \u2014 EM DASH  -> ,\n\n3. SLOP LEXICON\n---------------\n    1x  in today's fast-paced world  -> right now   [openers]\n    1x  it's no secret that  -> (deleted)   [openers]\n    1x  the future is here  -> (deleted)   [closers]\n    1x  let that sink in  -> (deleted)   [closers]\n    1x  transformative  -> big   [adjectives]\n    1x  comprehensive  -> complete   [adjectives]\n    1x  game-changing  -> big   [adjectives]\n    1x  in conclusion  -> so   [connectives]\n    1x  furthermore  -> also   [connectives]\n    1x  delve into  -> look at   [verbs]\n    1x  innovative  -> new   [adjectives]\n    1x  embark on  -> start   [verbs]\n    1x  landscape  -> market   [nouns]\n    1x  leverage  -> use   [verbs]\n    1x  seamless  -> clean   [adjectives]\n    1x  holistic  -> whole   [adjectives]\n    1x  tapestry  -> mix   [nouns]\n    1x  elevate  -> improve   [verbs]\n    1x  pivotal  -> key   [adjectives]\n    1x  crucial  -> important   [adjectives]\n    1x  journey  -> process   [nouns]\n    1x  foster  -> build   [verbs]\n    1x  unlock  -> get   [verbs]\n    1x  robust  -> solid   [adjectives]\n\n4. STRUCTURAL TELLS  (not auto-fixed - rewrite these yourself)\n--------------------------------------------------------------\n    1x  \"It's not just X, it's Y\"\n        Say the one thing you actually mean. Delete the setup half.\n    1x  \"Not only X but also Y\"\n        Split into two sentences, or drop the weaker half.\n    1x  \"Here's what I learned\"\n        State the lesson. Skip the announcement.\n    1x  Reflex engagement bait\n        Ask a question only you could ask, about the specific thing above it.\n    9x  Uniform sentence length (variation 0.28)\n        Break one sentence in half. Let another run long. Machines write even.\n\n"
 },
 "reportClean": {
  "text": "I wrote this one myself in about ten minutes. We left Lisbon at 6am on Friday, and it rained the whole way. Sam drove. I ate cold pizza. It was great, honestly, and I'd do it again tomorrow if my knees let me.\n",
  "out": "\nHUMANIZE REPORT\n---------------\n0 machine artefacts removed, 0 structural tells flagged for rewrite\n\nCLEAN\n-----\n  Nothing to strip.\n\n"
 }
};

describe("python-compat helpers", () => {
  test("fixed() rounds half to even like Python", () => {
    expect(fixed(12.25, 1)).toBe("12.2");
    expect(fixed(0.125, 2)).toBe("0.12");
    expect(fixed(62.5, 0)).toBe("62");
    expect(fixed(63.5, 0)).toBe("64");
    expect(fixed(-0.04, 1)).toBe("-0.0");
    expect(fixed(100, 1)).toBe("100.0");
  });
  test("roundInt() is banker's rounding", () => {
    expect([0.5, 1.5, 2.5, 3.5, 2.4, 2.6].map(roundInt)).toEqual([0, 2, 2, 4, 2, 3]);
  });
  test("pyJson prints floats with .0 and escapes like json.dumps", () => {
    expect(pyJson({ score: 100, n: 2, s: "\u00e9" }, true, new Set(["score"]))).toBe(
      '{\n  "score": 100.0,\n  "n": 2,\n  "s": "\\u00e9"\n}',
    );
    expect(pyJson({ a: [], b: {} }, false, new Set())).toBe('{\n  "a": [],\n  "b": {}\n}');
  });
  test("exact statistics match CPython", () => {
    expect(pstdevInts([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toBe(2.8722813232690143);
    expect(pstdevInts([3, 9, 4, 15, 2])).toBe(4.841487374764082);
    expect(pstdevInts([5, 5, 5, 5])).toBe(0);
    expect(exactMean([0.1, 0.2, 0.3])).toBe(0.2);
    expect(exactMean([44.2, 39.6, 75.5, 100.0, 92.1])).toBe(70.28);
  });
});

describe("hook-score parity with hookscore.py", () => {
  test.each(HOOKS.map((h, i) => [i, h.hook, h] as const))("hook %d: %s", (_i, _name, expected) => {
    expect(scoreHook(expected.hook)).toEqual(expected);
  });
  test("integer-valued scores print like Python (75 not 75.0)", () => {
    const strong = pyJson(scoreHook("I lost $18,000 on one missing contract."), false, new Set(["score"]));
    expect(strong).toContain('"score": 100.0');
    const one = pyJson(scoreHook("Dej\u00e9 mi trabajo y gan\u00e9 5k al mes sin jefe ni horarios."), false, new Set(["score"]));
    expect(one).toContain('"score": 75,');
  });
  test("verdicts vary across the fixtures", () => {
    const v = new Set(HOOKS.map((h) => h.verdict));
    expect(v.has("WEAK")).toBe(true);
    expect(v.size).toBeGreaterThanOrEqual(2);
  });
  test("text rendering: single hook", () => {
    const r = RENDER.hookOne;
    expect(renderOne(r.hook!, runHook(r.hook!))).toBe(r.out);
  });
  test("text rendering: ranked table", () => {
    const r = RENDER.hookTable;
    const rows = r.hooks!.map(scoreHook).sort((a, b) => b.score - a.score);
    expect(renderTable(rows)).toBe(r.out);
  });
});

describe("ai-tells detect parity with detect.py", () => {
  test.each(DETECT.map((d) => [d.name, d] as const))("detect %s", (_n, d) => {
    expect(scoreDraft(d.text, lex, "X")).toEqual(d.expected);
  });
  test("text rendering", () => {
    for (const k of ["detectSloppy", "detectHuman"]) {
      const r = RENDER[k];
      expect(renderDetect(detect(r.text!, lex))).toBe(r.out);
    }
  });
  test("verdicts vary across the fixtures", () => {
    const v = new Set(DETECT.map((d) => d.expected.verdict));
    expect(v.has("FLAGGED")).toBe(true);
    expect(v.size).toBeGreaterThanOrEqual(2);
  });
});

describe("ai-tells humanize parity with humanize.py", () => {
  test.each(HUMANIZE.map((d) => [d.name, d] as const))("humanize %s", (_n, d) => {
    expect(humanize(d.text, lex)).toEqual(d.expected);
  });
  test("report rendering", () => {
    for (const k of ["reportTypo", "reportSloppy", "reportClean"]) {
      const r = RENDER[k];
      expect(renderReport(humanize(r.text!, lex).report)).toBe(r.out);
    }
  });
  test("invisible characters are deleted and spaces normalised", () => {
    expect(humanize("a\u200bb\u00a0c\ufeffd", lex).text).toBe("ab cd\n");
  });
});
