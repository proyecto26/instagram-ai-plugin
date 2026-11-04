---
name: instagram
description: Drives the user's own Instagram account from the terminal through the same private endpoints instagram.com's web client uses, authenticated with the user's browser session cookies (no Graph API app, no Apify). Signs in via Chrome or imported cookies, reads profiles, posts, reels, comments, hashtags and search, computes account metrics, and publishes photos, carousels, reels and stories, edits captions and replies to comments (it never deletes), always as a dry run until the user approves. This skill should be used when the user says "post this to Instagram", "upload a reel", "publish a carousel", "log in to Instagram", "import my Instagram cookies", "post a story", "edit the caption on", "am I logged in to Instagram", "show my recent posts", "get stats for this post", "get this profile's posts", "reply to that comment", or mentions an instagram.com URL, even without saying "Instagram skill".
---

# Instagram (web session)

Run every command from this skill directory:

```bash
cd <skill-dir>        # the folder containing this SKILL.md
npx -y bun scripts/main.ts <command> [options]     # add --json for a machine envelope
```

No install step: Bun runs the TypeScript directly and the scripts have zero npm dependencies.
`ffmpeg` is optional (PNG/WebP to JPEG conversion and reel cover frames).

## Ground rules (follow every time)

1. **Writes are dry runs by default.** `post`, `edit-caption`, `comment` and `reply`
   print the exact requests and validation result and send nothing. Show the user the media,
   caption and warnings, get an explicit yes for *that* post, then re-run the same command with
   `--confirm --account <username>`. Approval for one post never covers the next one.
   The dry run shows `signedInAs`: say which account the post will go to, and if it is not the
   account the user means, stop and have them `login --force` as the right one. `--account` is
   required with `--confirm`, and the write refuses if the session is another account.
2. **Unverified writes need a second opt-in.** A write runs with `--confirm` alone only once its
   contract is `verified-live` (`status` lists them). Photos, carousels, reels, stories, comments and replies are verified;
   only edit-caption still needs `--experimental`. Tell the user the endpoint has not been proven on a real
   account and may fail, and suggest a test account for the first try.
3. **Stop on account signals.** On `rate_limited` (HTTP 429), `checkpoint`, `feedback_required`
   or `not_logged_in`, stop all Instagram calls and report the error's `hint`. Never retry in a
   loop, never switch endpoints to get around it.
4. **Never retry an unclear publish.** If a publish ends without a clear answer, the CLI records
   it as pending and refuses new posts. Run `pending check <id>`, ask the user to look at the
   profile, and resolve with `pending resolve <id> --posted|--not-posted`.
   Only one publish runs at a time; a second one is refused while the first is running. A
   crashed run's lock is ignored automatically. `pending unlock` only tidies up those files.
5. **No engagement automation.** There are no follow, like or DM commands, by design. Comments
   and replies are one at a time, with the user approving each text. Instagram restricts accounts
   that automate engagement.
6. **Never print or paste cookie values.** `status` shows redacted lengths only.

## Authentication

```bash
npx -y bun scripts/main.ts login                 # opens Chrome (dedicated profile); sign in, 2FA is fine
npx -y bun scripts/main.ts login --force         # always re-open Chrome (--timeout <sec>, default 300)
npx -y bun scripts/main.ts import-cookies cookies.json   # Cookie-Editor JSON, cookies.txt, or "Cookie:" header
npx -y bun scripts/main.ts whoami                # confirms the session against Instagram
npx -y bun scripts/main.ts status                # offline: saved cookies (redacted), pending publishes
npx -y bun scripts/main.ts logout                # deletes cookies, caches and the Chrome profile (--keep-profile keeps it)
```

The session needs `sessionid`, `csrftoken` and `ds_user_id` for `.instagram.com`. `sessionid`
is HttpOnly, so `login` reads cookies over the Chrome DevTools protocol. The data directory
(`%APPDATA%\instagram-ai`, `~/Library/Application Support/instagram-ai`, or
`$XDG_DATA_HOME/instagram-ai`) is locked to the current user before anything is written
(icacls on Windows, 0700/0600 elsewhere). If that fails, nothing is saved. `INSTAGRAM_COOKIES`
can carry a session for one process without touching disk.

## Reading

```bash
npx -y bun scripts/main.ts profile [username]                 # default: own account
npx -y bun scripts/main.ts posts [username] --limit 30     # default: own account; newest first
npx -y bun scripts/main.ts media <url|shortcode|id>
npx -y bun scripts/main.ts comments <url|shortcode|id> --limit 50
npx -y bun scripts/main.ts hashtag <tag> --limit 24
npx -y bun scripts/main.ts search <query>
npx -y bun scripts/main.ts audit [username] --limit 30 --tz America/Bogota
npx -y bun scripts/main.ts swipe user1,user2,user3 --limit 24 --min 3
```

Every read reports `via`, meaning which endpoint answered. Reads try the REST endpoints first,
then a GraphQL persisted query whose `doc_id` is discovered from the live web bundles. The last
resort is the 12 posts embedded in the profile response. When `via` says "embedded, max 12",
tell the user the sample is small. Counters can be `null` when the owner hid like counts.
Reach, saves, shares and profile visits are Insights-only and never available here.

`audit` returns the metric set used by the `instagram-audit` skill. `swipe` scores each post
against its own account's median, and is used by `instagram-research`. Keep research small: at
most 12 accounts per run, and the CLI spaces requests at least 1.5 s apart.

## Publishing

```bash
# 1. Dry run: show this output to the user
npx -y bun scripts/main.ts post photo ./img.jpg --caption-file caption.txt --alt "Alt text"
npx -y bun scripts/main.ts post carousel ./1.jpg ./2.jpg ./3.mp4 --caption "..."
npx -y bun scripts/main.ts post reel ./reel.mp4 --caption "..." --cover ./cover.jpg   # or --cover-at 1.5
npx -y bun scripts/main.ts post story ./story.jpg

# 2. After explicit approval of that exact post
npx -y bun scripts/main.ts post photo ./img.jpg --caption-file caption.txt --alt "Alt text" --confirm --account <username>
```

`--experimental` stays required until that write type is marked `verified-live`.

Options: `--disable-comments`, `--hide-likes`, `--no-feed` (reel only on the Reels tab),
`--max-hashtags N` (default 5, Instagram's current cap), `--ignore-pending` (only after the user
resolved pending publishes by looking at the profile).

Validation before anything is uploaded:

| Rule | Limit |
|---|---|
| Caption | 2,200 chars; 5 hashtags; 20 mentions; warning when the first line is over ~125 chars |
| Feed images | aspect 4:5 to 1.91:1; 8 MB; JPEG (other formats converted with ffmpeg) |
| Carousel | 2 to 20 items; mixed aspect ratios are cropped to the first (warning) |
| Reel | 3 s to 15 min; H.264/HEVC; 9:16 recommended (warning otherwise) |
| Story | photo only in v0.1; 9:16 recommended |

Prefer a caption file (`--caption-file`) for anything with line breaks or quotes, to avoid shell
quoting problems on Windows. Lint captions first with the `instagram-content` skill's
`caption-lint.ts`.

## Managing

```bash
npx -y bun scripts/main.ts edit-caption <ref> --caption-file new.txt [--confirm --account <username> --experimental]
npx -y bun scripts/main.ts comment <ref> --text "..." [--confirm --account <username>]
npx -y bun scripts/main.ts reply <ref> <commentId> --text "..." [--confirm --account <username>]
```

Every confirmed write appends a line (ids, urls, never cookies) to `actions.jsonl` in the data
directory. Use it to find what the CLI posted, or to finish a failed cleanup by hand.

## Errors

| Kind | Meaning / action |
|---|---|
| `not_logged_in` | Session expired: `login --force` or `import-cookies` |
| `checkpoint` | Instagram wants a security check: user completes it in a browser, then `login --force` |
| `rate_limited` | 429: stop for 15 to 30 min; do not retry |
| `feedback_required` | Action blocked: stop writes for 24 h |
| `not_found` / `unexpected_response` | Endpoint moved: run `probe`, then update `scripts/endpoints.ts` |
| `bad_request` | Payload rejected: compare with the web client (see references) |
| `validation` | Input problem; nothing was sent |

`probe [--refresh-config] [--graphql]` checks the main endpoints with a handful of GETs and
stops at the first 429. Run it only when diagnosing, not routinely.

## Additional resources

- **`references/endpoints.md`**: every endpoint, request contract and evidence status, how to
  re-verify them from the live web client, and what to edit when Instagram changes something.
- `scripts/endpoints.ts` (the endpoint table), `scripts/publish.ts` (write contracts and
  `CONTRACTS` status), `scripts/graphql.ts` (doc_id discovery).

## Environment variables

| Variable | Purpose |
|---|---|
| `INSTAGRAM_DATA_DIR`, `INSTAGRAM_COOKIE_PATH`, `INSTAGRAM_CHROME_PROFILE_DIR`, `INSTAGRAM_CHROME_PATH` | Storage and browser locations |
| `INSTAGRAM_COOKIES` | Session for one process, any supported format, never written to disk |
| `INSTAGRAM_APP_ID`, `INSTAGRAM_ASBD_ID`, `INSTAGRAM_USER_AGENT` | Header overrides when Instagram rotates them |
| `INSTAGRAM_DOCID_<OperationName>` | Pin a GraphQL doc_id |
| `INSTAGRAM_MIN_GAP_MS` | Minimum gap between requests (default 1500) |
| `INSTAGRAM_MAX_HASHTAGS` | Default hashtag cap (5) |
| `INSTAGRAM_FFMPEG_PATH` | ffmpeg location |
| `INSTAGRAM_ALLOW_INSECURE_STORAGE=1` | Store the session even if the folder cannot be locked (not recommended) |

Bun auto-loads a `.env` file from the working directory, which could set any of these. Always run
from this skill directory (it ships no `.env`), or add `--no-env-file` after `bun`. Origin
overrides (`INSTAGRAM_BASE_URL` and friends) are ignored unless they are https on instagram.com.
