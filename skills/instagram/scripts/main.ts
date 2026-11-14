#!/usr/bin/env -S npx -y bun
import { readFile, rm } from 'node:fs/promises';
import process from 'node:process';

import { audit, swipeFile } from './analytics.ts';
import { getInstagramCookiesViaChrome } from './auth.ts';
import { IgClient, IgError } from './client.ts';
import { deleteCookieFile, hasRequiredCookies, missingCookies, parseCookieInput, readCookieMapFromDisk, redact, writeCookieMapToDisk } from './cookie-store.ts';
import { probeTargets } from './endpoints.ts';
import { GraphQL } from './graphql.ts';
import { clearPending, listPending, unlockStale } from './pending.ts';
import { resolveChromeProfileDir, resolveCookiePath, resolveDataDir, resolveRuntimeConfigPath } from './paths.ts';
import {
    CONTRACTS,
    addComment,
    candidatesFor,
    describePlan,
    editCaption,
    executePlan,
    planCarousel,
    planPhoto,
    planReel,
    planStory,
    type ContractName,
    type PostOptions,
    type PublishPlan,
    type StoryMention,
    mentionReadBack,
    parseHandleList,
    parseMentionList,
    reelExtrasReadBack,
    approvalKey,
    planDigest,
    aiLabelReadBack,
    isAccountSignal,
    unsupportedFlags,
    REEL_COLLABORATORS_MAX,
    REEL_TAGS_MAX,
    type UserRef,
} from './publish.ts';
import { getComments, getHashtag, getMedia, getPosts, getProfile, search, whoami } from './read.ts';

const HELP = `Instagram (web session) CLI

Usage: npx -y bun scripts/main.ts <command> [options]

Session
  login [--force] [--timeout <sec>]     Sign in through Chrome and save the session cookies
  import-cookies <file|->                Import cookies (Cookie-Editor JSON, cookies.txt, or a Cookie header)
  logout [--keep-profile]                Delete saved cookies, caches and the Chrome profile
  status                                 Offline: what is saved (redacted), pending publishes
  whoami                                 The signed-in account
  probe [--refresh-config] [--graphql]   Check which endpoints answer (stops at the first 429)

Read
  profile [username]                     Default: your account
  posts [username] [--limit N]           Newest first (default: your account, 24)
  media <url|shortcode|id>
  comments <url|shortcode|id> [--limit N]
  hashtag <tag> [--limit N]
  search <query>
  audit [username] [--limit N] [--tz Area/City]   Metrics for the instagram-audit skill
  swipe <user1,user2,...> [--limit N] [--min X]   Outlier posts across accounts (max 12)

Write (dry run unless --confirm)
  post photo <image> [--caption <text> | --caption-file <f>] [--alt <text>]
  post carousel <file1> <file2> ... [same caption options]
  post reel <video> [--cover <jpg> | --cover-at <sec>] [--no-feed]
            [--tag user1,user2] [--collab user] [--ai-label]   Tag people, invite collaborators, mark as AI-generated
            [--user-id name=123,...]    Numeric ids you already know for those handles (skips the lookup; shown as unverified)
            [--approve name=123,...]    Required with --confirm: the exact recipients printed by the dry run
            (--tag and --ai-label are verified live; --collab has never been sent live and needs --experimental)
  post story <image|video> [--cover <jpg> | --cover-at <sec>]   (video up to 60 s)
             [--mention user1,user2]     NOT WORKING: tried live, Instagram did not keep the mention. Add mentions in the app.
                                         (kept for testing; needs --experimental)
  edit-caption <ref> --caption <text> | --caption-file <f>
  comment <ref> --text <text>
  reply <ref> <commentId> --text <text>
  Common: --disable-comments --hide-likes --max-hashtags N --confirm --account <username>
          (--account is required with --confirm; the write refuses if the session is another account)
          --experimental (required for any write not yet verified live; see "status") --ignore-pending

Recovery
  pending                                List publishes that ended without a clear answer
  pending check <id>                     Show posts that could be that publish (never auto-resolves)
  pending resolve <id> --posted|--not-posted
  pending unlock                         Delete lock files left by runs that have exited

Global: --json (machine-readable envelope)
`;

interface Args {
    _: string[];
    flags: Record<string, string | boolean>;
}

const BOOL_FLAGS = new Set(['json', 'force', 'confirm', 'experimental', 'no-feed', 'disable-comments', 'hide-likes', 'keep-profile', 'ai-label', 'refresh-config', 'graphql', 'posted', 'not-posted', 'ignore-pending', 'help']);

export function parseArgs(argv: string[]): Args {
    const out: Args = { _: [], flags: {} };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '-h') out.flags.help = true;
        else if (a.startsWith('--')) {
            const eq = a.indexOf('=');
            const key = eq > 0 ? a.slice(2, eq) : a.slice(2);
            if (eq > 0 && BOOL_FLAGS.has(key)) {
                // --confirm=false must never mean "confirm". Only true/false are accepted.
                const v = a.slice(eq + 1).toLowerCase();
                if (v === 'true' || v === '1') out.flags[key] = true;
                else if (v === 'false' || v === '0') delete out.flags[key];
                else throw new IgError('validation', `--${key} is a switch; use --${key} or omit it (got "${a.slice(eq + 1)}").`);
            } else if (eq > 0) out.flags[key] = a.slice(eq + 1);
            else if (BOOL_FLAGS.has(key)) out.flags[key] = true;
            else if (i + 1 < argv.length) out.flags[key] = argv[++i];
            else out.flags[key] = true;
        } else out._.push(a);
    }
    return out;
}

const str = (v: string | boolean | undefined): string | undefined => (typeof v === 'string' ? v : undefined);
const int = (v: string | boolean | undefined, d: number): number => {
    const n = Number(str(v));
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : d;
};

let JSON_MODE = false;
const log = (m: string) => process.stderr.write(`${m}\n`);

function emit(command: string, data: unknown): void {
    if (JSON_MODE) process.stdout.write(`${JSON.stringify({ ok: true, command, data })}\n`);
    else process.stdout.write(`${typeof data === 'string' ? data : JSON.stringify(data, null, 2)}\n`);
}

async function readStdin(): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString('utf8');
}

async function captionFrom(flags: Args['flags']): Promise<string> {
    const file = str(flags['caption-file']);
    if (file) return (await readFile(file, 'utf8')).replace(/\s+$/, '');
    return str(flags.caption) ?? '';
}

function requireGate(contract: ContractName, flags: Args['flags']): void {
    if (CONTRACTS[contract] !== 'verified-live' && !flags.experimental) {
        throw new IgError('validation', `"${contract}" (${CONTRACTS[contract]}) has not been verified by a live test yet, so it needs --experimental.`, {
            hint: 'Re-run with --experimental (and --confirm) only if the user accepts that it may fail or behave differently.',
        });
    }
}

const normUser = (u: string) => u.trim().replace(/^@/, '').toLowerCase();

/**
 * Every live write names the account it is meant for (--account), and the session
 * must be signed in as that account. Without this a post can land on whatever
 * account the Chrome profile happened to be signed in to.
 */
async function assertAccount(client: IgClient, flags: Args['flags']): Promise<string> {
    const want = str(flags.account);
    if (!want) {
        throw new IgError('validation', 'A live write needs --account <username>, so it cannot land on the wrong account.', {
            hint: 'Run `whoami` to see the signed-in account, then re-run with --account <that username>.',
        });
    }
    const me = (await whoami(client)).profile.username;
    if (normUser(me) !== normUser(want)) {
        throw new IgError('validation', `The session is signed in as @${me}, not @${normUser(want)}. Nothing was sent.`, {
            hint: `Sign in as @${normUser(want)}: run \`login --force\` and, in the Chrome window, log out of @${me} first.`,
        });
    }
    return me;
}

/** Best-effort account line for a dry run: which account a --confirm would publish to. */
async function dryRunAccount(flags: Args['flags']): Promise<Record<string, unknown>> {
    const want = str(flags.account);
    try {
        const me = await withClient((c) => whoami(c));
        const signedInAs = '@' + me.profile.username;
        if (!want) return { signedInAs, accountCheck: 'add --account <username> to the --confirm run' };
        return normUser(me.profile.username) === normUser(want)
            ? { signedInAs, accountCheck: 'matches --account' }
            : { signedInAs, accountCheck: `MISMATCH: --account is @${normUser(want)}; a --confirm run will refuse` };
    } catch (e) {
        return { signedInAs: null, accountCheck: `could not confirm the account (${e instanceof IgError ? e.kind : 'error'})` };
    }
}

/**
 * Handles to numeric ids. `--user-id name=123` supplies ids the caller already knows (no lookup; reported as
 * unverified, because nothing here proves the id belongs to that handle); the rest are looked up (read-only).
 * A rate-limit or checkpoint answer from the lookup stops the command: do not re-run with ids to get past it.
 */
async function resolveUsers(names: string[], given?: string): Promise<{ refs: Map<string, UserRef>; manual: string[] }> {
    const refs = new Map<string, UserRef>();
    const manual: string[] = [];
    for (const pair of (given ?? '').split(',').map((p) => p.trim()).filter(Boolean)) {
        const [n, id] = pair.split('=').map((x) => x.trim().replace(/^@/, '').toLowerCase());
        if (!n || !/^\d+$/.test(id ?? '')) throw new IgError('validation', `--user-id expects name=123 pairs; got "${pair}".`);
        if (!names.includes(n)) throw new IgError('validation', `--user-id names @${n}, which is not among the requested accounts.`);
        refs.set(n, { username: n, userId: id });
        manual.push(n);
    }
    const missing = names.filter((n) => !refs.has(n));
    if (missing.length) {
        await withClient(async (c) => {
            for (const n of missing) {
                const { profile } = await getProfile(c, n);
                refs.set(n, { username: profile.username.toLowerCase(), userId: profile.pk });
            }
        });
    }
    return { refs, manual };
}

async function runPublish(plan: PublishPlan, flags: Args['flags'], contract: ContractName, mentions: StoryMention[] = [], extras?: { tags: UserRef[]; collaborators: UserRef[]; aiLabel: boolean }, info?: { aiLabel?: boolean; manual?: string[] }): Promise<void> {
    const description = describePlan(plan);
    const recipients = [...mentions, ...(extras?.tags ?? []), ...(extras?.collaborators ?? [])];
    const digest = await planDigest(plan);
    const subject = (account: string) =>
        approvalKey({
            digest,
            account,
            kind: plan.kind,
            files: plan.items.map((it) => ({ name: it.label, bytes: it.facts.bytes })),
            caption: plan.caption,
            aiLabel: Boolean(info?.aiLabel || extras?.aiLabel),
            roles: { mention: mentions, tag: extras?.tags ?? [], collab: extras?.collaborators ?? [] },
        });
    const needsApproval = recipients.length > 0;
    const provenance = (u: UserRef) => ((info?.manual ?? []).includes(u.username.toLowerCase()) ? 'id supplied with --user-id, NOT verified to belong to this handle' : 'id read from the profile lookup');
    if (!flags.confirm) {
        const acct = await dryRunAccount(flags);
        const who = String(str(flags.account) ?? acct.signedInAs ?? '');
        emit('post', {
            dryRun: true,
            note: 'Nothing was sent. Re-run with --confirm --account <username> after the user approves this exact post.',
            ...acct,
            ...(recipients.length
                ? {
                      recipients: recipients.map((x) => ({ username: '@' + x.username, userId: x.userId, role: mentions.includes(x) ? 'story mention' : (extras?.collaborators ?? []).includes(x) ? 'collaborator invite' : 'tag', provenance: provenance(x) })),
                      recipientsNote: 'These accounts are expected to be notified. Open instagram.com/<username> for each one and check it is the person meant.',
                      approveWith: who ? `--approve "${subject(who)}"` : 'sign in first: the approval string includes the account',
                      approveNote: 'The approval string covers the recipients and their roles, the account, the exact bytes of the media and cover, and every publish field (caption, AI label, feed placement...). Change any of them and it no longer matches. Reels are sent with one more field, signed_body = "SIGNATURE." + the JSON of the fields shown.',
                  }
                : {}),
            ...(info?.aiLabel || extras?.aiLabel ? { aiLabel: true } : {}),
            ...description,
        });
        if (plan.check.errors.length) process.exitCode = 1;
        return;
    }
    requireGate(contract, flags);
    if (needsApproval) {
        const expected = subject(String(str(flags.account) ?? ''));
        if (str(flags.approve) !== expected) {
            throw new IgError('validation', `This post was not approved as it now stands (recipients, roles, account, files, caption or AI label differ, or --approve is missing). Run it without --confirm, review, and pass the --approve string it prints. Nothing was sent.`);
        }
    }
    if (plan.check.warnings.length) for (const w of plan.check.warnings) log(`[instagram] warning: ${w}`);
    const client = await IgClient.create({ log });
    try {
        const account = await assertAccount(client, flags);
        const result = await executePlan(client, plan, log, { ignorePending: Boolean(flags['ignore-pending']) });
        // An unverified field can be accepted and silently dropped: read the story back and say what Instagram kept.
        // One metadata read serves every check. After an account signal (429, checkpoint, action block, logged out)
        // nothing else is requested: the post stays reported as posted and the checks as not performed.
        let mentionCheck: Record<string, unknown> = {};
        const wantsAi = Boolean(info?.aiLabel || extras?.aiLabel);
        if (mentions.length || extras || wantsAi) {
            try {
                const { raw } = await getMedia(client, String((result as { pk?: string }).pk ?? ''));
                if (mentions.length) mentionCheck.mentions = mentionReadBack(mentions, raw);
                if (extras) mentionCheck.readBack = reelExtrasReadBack(extras, raw);
                else if (wantsAi) mentionCheck.aiLabel = { ...aiLabelReadBack(raw), note: 'One metadata read after posting; check how the label shows in the app.' };
            } catch (e) {
                mentionCheck.readBack = {
                    outcome: 'not_checked',
                    stopped: isAccountSignal(e),
                    note: `The post is live, but it could not be read back (${(e as Error).message}). No further request was made. Check mentions, tags and the AI label in the app; do not post again.`,
                };
            }
        }
        emit('post', { posted: true, account: '@' + account, ...result, ...mentionCheck });
    } finally {
        await client.flush();
    }
}

async function withClient<T>(fn: (c: IgClient) => Promise<T>): Promise<T> {
    const client = await IgClient.create({ log });
    try {
        return await fn(client);
    } finally {
        await client.flush();
    }
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    JSON_MODE = Boolean(args.flags.json);
    const [cmd, ...rest] = args._;
    const f = args.flags;
    if (!cmd || f.help || cmd === 'help') {
        process.stdout.write(HELP);
        return;
    }

    switch (cmd) {
        case 'login': {
            if (!f.force) {
                const existing = await readCookieMapFromDisk();
                if (hasRequiredCookies(existing)) {
                    try {
                        const me = await withClient((c) => whoami(c));
                        emit('login', { loggedIn: true, reused: true, username: me.profile.username });
                        return;
                    } catch (e) {
                        if (!(e instanceof IgError) || e.kind !== 'not_logged_in') throw e;
                        log('[instagram] Saved session is no longer valid; opening Chrome.');
                    }
                }
            }
            const cookies = await getInstagramCookiesViaChrome({ log, timeoutMs: int(f.timeout, 300) * 1000 });
            const p = await writeCookieMapToDisk(cookies, { log });
            let username: string | null = null;
            try {
                username = (await withClient((c) => whoami(c))).profile.username;
            } catch {
                log('[instagram] Signed in, but could not read the account name yet; run `whoami`.');
            }
            emit('login', { loggedIn: true, cookieFile: p, userId: cookies.ds_user_id, username });
            return;
        }
        case 'import-cookies': {
            const src = rest[0];
            if (!src) throw new IgError('validation', 'Usage: import-cookies <file|->');
            const text = src === '-' ? await readStdin() : await readFile(src, 'utf8');
            const map = parseCookieInput(text);
            const missing = missingCookies(map);
            if (missing.length) throw new IgError('validation', `The input has no ${missing.join(', ')} cookie(s). Export cookies for instagram.com while signed in.`);
            const p = await writeCookieMapToDisk(map, { log });
            emit('import-cookies', { saved: p, cookies: Object.keys(map).sort(), userId: map.ds_user_id });
            return;
        }
        case 'logout': {
            await deleteCookieFile();
            await rm(resolveRuntimeConfigPath(), { force: true });
            await rm(`${resolveDataDir()}/graphql-docids.json`, { force: true });
            if (!f['keep-profile']) await rm(resolveChromeProfileDir(), { recursive: true, force: true });
            emit('logout', { removed: [resolveCookiePath(), resolveRuntimeConfigPath(), ...(f['keep-profile'] ? [] : [resolveChromeProfileDir()])] });
            return;
        }
        case 'status': {
            const map = await readCookieMapFromDisk();
            emit('status', {
                dataDir: resolveDataDir(),
                cookieFile: resolveCookiePath(),
                hasSession: hasRequiredCookies(map),
                missing: missingCookies(map),
                cookies: redact(map),
                fromEnv: Boolean(process.env.INSTAGRAM_COOKIES),
                pending: await listPending(),
                contracts: CONTRACTS,
            });
            return;
        }
        case 'whoami': {
            const me = await withClient((c) => whoami(c));
            emit('whoami', { ...me.profile, via: me.via });
            return;
        }
        case 'probe': {
            const report = await withClient(async (c) => {
                const out: Record<string, unknown> = {};
                if (f['refresh-config']) out.config = await c.refreshRuntimeConfig();
                let username: string | null = null;
                for (const t of probeTargets(c.userId, null)) {
                    try {
                        const d = await c.request<any>('GET', t.url);
                        username ??= d?.user?.username ?? null;
                        out[t.name] = 'ok';
                    } catch (e) {
                        if (!(e instanceof IgError)) throw e;
                        out[t.name] = `${e.kind}${e.status ? ` (${e.status})` : ''}`;
                        if (['rate_limited', 'checkpoint', 'not_logged_in', 'feedback_required'].includes(e.kind)) {
                            out.stopped = `Stopped at ${t.name}: ${e.hint}`;
                            break;
                        }
                    }
                }
                if (f.graphql && !out.stopped) {
                    const g = new GraphQL(c);
                    await g.init('/');
                    const ops = g.knownOperations();
                    out.graphql = { operations: ops.length, used: ['PolarisProfilePostsQuery', 'PolarisAPITopsearchQuery'].map((n) => `${n}: ${g.docId(n) ? 'found' : 'missing'}`) };
                }
                return out;
            });
            emit('probe', report);
            return;
        }
        case 'profile': {
            emit('profile', await withClient(async (c) => getProfile(c, rest[0] ?? (await whoami(c)).profile.username)));
            return;
        }
        case 'posts': {
            emit('posts', await withClient((c) => getPosts(c, rest[0] ?? null, int(f.limit, 24))));
            return;
        }
        case 'media': {
            if (!rest[0]) throw new IgError('validation', 'Usage: media <url|shortcode|id>');
            const m = await withClient((c) => getMedia(c, rest[0]));
            emit('media', { ...m.post, via: m.via });
            return;
        }
        case 'comments': {
            if (!rest[0]) throw new IgError('validation', 'Usage: comments <url|shortcode|id>');
            emit('comments', await withClient((c) => getComments(c, rest[0], int(f.limit, 50))));
            return;
        }
        case 'hashtag': {
            if (!rest[0]) throw new IgError('validation', 'Usage: hashtag <tag>');
            const h = await withClient((c) => getHashtag(c, rest[0]));
            const n = int(f.limit, 24);
            emit('hashtag', { ...h, top: h.top.slice(0, n), recent: h.recent.slice(0, n) });
            return;
        }
        case 'search': {
            if (!rest.length) throw new IgError('validation', 'Usage: search <query>');
            emit('search', await withClient((c) => search(c, rest.join(' '))));
            return;
        }
        case 'audit': {
            const result = await withClient(async (c) => {
                const username = rest[0] ?? (await whoami(c)).profile.username;
                const { profile } = await getProfile(c, username);
                const { posts, via } = await getPosts(c, username, int(f.limit, 30));
                return audit(profile, posts, { source: via, timeZone: str(f.tz) });
            });
            emit('audit', result);
            return;
        }
        case 'swipe': {
            const users = (rest[0] ?? '').split(',').map((u) => u.trim().replace(/^@/, '')).filter(Boolean);
            if (!users.length) throw new IgError('validation', 'Usage: swipe <user1,user2,...>');
            if (users.length > 12) throw new IgError('validation', 'At most 12 accounts per run (each account is several requests).');
            const result = await withClient(async (c) => {
                const accounts: { username: string; posts: any[] }[] = [];
                const skipped: Record<string, string> = {};
                for (const u of users) {
                    try {
                        const { posts } = await getPosts(c, u, Math.min(int(f.limit, 24), 50));
                        accounts.push({ username: u, posts });
                    } catch (e) {
                        if (e instanceof IgError && ['rate_limited', 'checkpoint', 'not_logged_in', 'feedback_required'].includes(e.kind)) throw e;
                        skipped[u] = (e as Error).message;
                    }
                }
                return { outliers: swipeFile(accounts, Number(str(f.min) ?? 3)), accounts: accounts.map((a) => ({ username: a.username, posts: a.posts.length })), skipped };
            });
            emit('swipe', result);
            return;
        }
        case 'post': {
            const [kind, ...files] = rest;
            const o: PostOptions = {
                caption: await captionFrom(f),
                altText: str(f.alt),
                disableComments: Boolean(f['disable-comments']),
                hideLikes: Boolean(f['hide-likes']),
                maxHashtags: str(f['max-hashtags']) ? Number(f['max-hashtags']) : undefined,
                shareToFeed: !f['no-feed'],
                cover: str(f.cover),
                coverAt: str(f['cover-at']) ? Number(f['cover-at']) : undefined,
                aiLabel: Boolean(f['ai-label']),
            };
            if (!files.length) throw new IgError('validation', `Usage: post ${kind ?? '<photo|carousel|reel|story>'} <file...>`);
            const bad = unsupportedFlags(String(kind), f as Record<string, unknown>);
            if (bad.length) throw new IgError('validation', `${bad.map((b) => '--' + b).join(', ')} ${bad.length > 1 ? 'are' : 'is'} not supported for "post ${kind}". Nothing was sent.`);
            if (kind === 'photo') return runPublish(await planPhoto(files[0], o), f, 'photo');
            if (kind === 'carousel') return runPublish(await planCarousel(files, o), f, 'carousel');
            if (kind === 'reel') {
                let tagNames: string[];
                let collabNames: string[];
                try {
                    tagNames = parseHandleList('tag', f.tag as string | true | undefined, REEL_TAGS_MAX);
                    collabNames = parseHandleList('collab', f.collab as string | true | undefined, REEL_COLLABORATORS_MAX);
                } catch (e) {
                    throw new IgError('validation', (e as Error).message);
                }
                const aiLabel = Boolean(f['ai-label']);
                if (!tagNames.length && !collabNames.length && !aiLabel) return runPublish(await planReel(files[0], o), f, 'reel');
                const { refs, manual } = await resolveUsers([...new Set([...tagNames, ...collabNames])], str(f['user-id']));
                const extras = { tags: tagNames.map((n) => refs.get(n)!), collaborators: collabNames.map((n) => refs.get(n)!), aiLabel };
                return runPublish(await planReel(files[0], { ...o, ...extras }), f, collabNames.length ? 'reelCollab' : 'reelExtras', [], extras, { aiLabel, manual });
            }
            if (kind === 'story') {
                let manualIds: string[] = [];
                let names: string[];
                try {
                    names = parseMentionList(f.mention as string | true | undefined);
                } catch (e) {
                    throw new IgError('validation', (e as Error).message);
                }
                if (!names.length) return runPublish(await planStory(files[0], o), f, o.aiLabel ? 'storyAiLabel' : 'story', [], undefined, o.aiLabel ? { aiLabel: true } : undefined);
                // Mentions are sent by numeric id: ids come from --user-id or one read-only lookup per handle.
                const resolved = await resolveUsers(names, str(f['user-id']));
                const mentions: StoryMention[] = names.map((n) => resolved.refs.get(n)!);
                manualIds = resolved.manual;
                return runPublish(await planStory(files[0], { ...o, mentions }), f, 'storyMention', mentions, undefined, { aiLabel: Boolean(o.aiLabel), manual: manualIds });
            }
            throw new IgError('validation', 'post needs one of: photo, carousel, reel, story');
        }
        case 'edit-caption':
        case 'comment':
        case 'reply': {
            const ref = rest[0];
            if (!ref) throw new IgError('validation', `Usage: ${cmd} <url|shortcode|id> ...`);
            const contract: ContractName = cmd === 'edit-caption' ? 'editCaption' : 'comment';
            const text = cmd === 'edit-caption' ? await captionFrom(f) : str(f.text) ?? '';
            if (!text) throw new IgError('validation', `${cmd} needs ${cmd === 'edit-caption' ? '--caption' : '--text'}.`);
            if (cmd === 'reply' && !rest[1]) throw new IgError('validation', 'Usage: reply <ref> <commentId> --text <text>');
            if (!f.confirm) {
                emit(cmd, { dryRun: true, contract: CONTRACTS[contract], action: cmd, ref, ...(text ? { text } : {}), ...(cmd === 'reply' ? { replyTo: rest[1] } : {}), ...(await dryRunAccount(f)), note: 'Nothing was sent. Re-run with --confirm --account <username> after the user approves.' });
                return;
            }
            requireGate(contract, f);
            let account = '';
            const result = await withClient(async (c) => {
                account = await assertAccount(c, f);
                return cmd === 'edit-caption' ? editCaption(c, ref, text, str(f['max-hashtags']) ? Number(f['max-hashtags']) : undefined) : addComment(c, ref, text, cmd === 'reply' ? rest[1] : undefined);
            });
            emit(cmd, { done: true, account: '@' + account, ...result });
            return;
        }
        case 'pending': {
            const [sub, id] = rest;
            const ops = await listPending();
            if (!sub || sub === 'list') {
                emit('pending', ops);
                return;
            }
            if (sub === 'unlock') {
                try {
                    emit('pending unlock', await unlockStale());
                } catch (e) {
                    throw new IgError('validation', (e as Error).message);
                }
                return;
            }
            const op = ops.find((o) => o.id === id);
            if (!op) throw new IgError('validation', `No pending publish with id ${id}. Run: pending`);
            if (sub === 'check') {
                const cands = await withClient((c) => candidatesFor(c, op));
                emit('pending check', { op, candidates: cands, note: 'Compare with the profile in the app. Then: pending resolve <id> --posted|--not-posted' });
                return;
            }
            if (sub === 'resolve') {
                if (!f.posted && !f['not-posted']) throw new IgError('validation', 'pending resolve needs --posted or --not-posted');
                await clearPending(op.id);
                emit('pending resolve', { id: op.id, resolution: f.posted ? 'posted' : 'not-posted' });
                return;
            }
            throw new IgError('validation', 'pending [list|check <id>|resolve <id> --posted|--not-posted|unlock]');
        }
        default:
            throw new IgError('validation', `Unknown command "${cmd}". Run with --help.`);
    }
}

if (import.meta.main) main().catch((error) => {
    const e = error instanceof IgError ? error : null;
    if (JSON_MODE) {
        process.stdout.write(
            `${JSON.stringify({ ok: false, error: { kind: e?.kind ?? 'error', message: (error as Error)?.message ?? String(error), hint: e?.hint, status: e?.status, endpoint: e?.endpoint } })}\n`,
        );
    } else {
        process.stderr.write(`Error: ${(error as Error)?.message ?? String(error)}\n`);
        if (e?.hint) process.stderr.write(`Fix: ${e.hint}\n`);
    }
    process.exitCode = 1;
});
