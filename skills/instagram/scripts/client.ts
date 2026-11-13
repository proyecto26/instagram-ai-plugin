import { type WebContext, cometForm, cometHeaders, decodeComet, extractWebContext, hasCreationEvidence, newWebSessionId } from './comet.ts';
import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import path from 'node:path';

import {
    DEFAULT_ASBD_ID,
    DEFAULT_IG_APP_ID,
    IG_HOST,
    IG_ORIGIN,
    IG_URL,
    KNOWN_HOSTS,
    MIN_REQUEST_GAP_MS,
    USER_AGENT,
} from './constants.ts';
import {
    applySetCookie,
    formatCookieHeader,
    loadCookies,
    missingCookies,
    writeCookieMapToDisk,
} from './cookie-store.ts';
import { resolveActionLogPath, resolveDataDir, resolveRuntimeConfigPath } from './paths.ts';
import { ensurePrivateDir } from './secure.ts';
import type { LogFn, RuntimeConfig } from './types.ts';

/**
 * Error kinds. `fallthrough` kinds let an endpoint chain try its next candidate;
 * every other kind stops the chain, because retrying elsewhere would only add load
 * to an account Instagram is already suspicious of.
 */
export type IgErrorKind =
    | 'not_logged_in'
    | 'checkpoint'
    | 'rate_limited'
    | 'feedback_required'
    | 'not_found'
    | 'bad_request'
    | 'transcode_pending'
    | 'server_error'
    | 'unexpected_response'
    | 'validation';

const FALLTHROUGH: IgErrorKind[] = ['not_found', 'unexpected_response'];

const HINTS: Record<IgErrorKind, string> = {
    not_logged_in: 'Session expired or missing. Run: npx -y bun scripts/main.ts login --force (or import-cookies).',
    checkpoint: 'Instagram wants a security check. Open instagram.com in a browser, complete it, then run login --force.',
    rate_limited: 'Instagram answered HTTP 429 on this endpoint. Some endpoints always answer 429 to web sessions, so this does not by itself mean the account is limited. Stop here: make no further requests in this run and do not retry in a loop. Try again after 15-30 minutes.',
    feedback_required: 'Instagram blocked the action ("feedback_required"/"Try Again Later"). Stop writes for 24h and use the app manually.',
    not_found: 'Endpoint or object not found. If it is an endpoint, Instagram moved it: run `probe` and update scripts/endpoints.ts.',
    bad_request: 'Instagram rejected the request payload. The body shape may have changed; compare with the web client (see README).',
    transcode_pending: 'Video still processing on Instagram; the CLI retries automatically.',
    server_error: 'Instagram returned a server error. Wait a minute and retry once.',
    unexpected_response: 'Instagram answered with HTML or an unexpected shape. Run `probe`; the endpoint may have moved.',
    validation: 'Fix the input and re-run (nothing was sent).',
};

/** Markers of Instagram's security-check (challenge) pages and payloads. */
export const CHALLENGE_HTML = /\/challenge\/|checkpoint_required|challenge_required|"checkpoint_url"/i;
/** Markers of the logged-out login page. */
export const LOGIN_HTML = /loginForm/;
/** Restriction and wait signals in a non-JSON body. */
export const FEEDBACK_HTML = /feedback_required|action blocked|we restrict certain activity/i;
export const WAIT_HTML = /please wait a few minutes|rate_limit_error|too many requests/i;
/**
 * On a 2xx HTML page only strong markers count: a normal page can link to /challenge/ routes.
 * Heuristic, not verified against a live challenge page yet.
 */
export const CHALLENGE_PAGE_STRONG = /checkpoint_required|challenge_required|"challenge_context"/i;

export class IgError extends Error {
    readonly kind: IgErrorKind;
    readonly status?: number;
    readonly endpoint?: string;
    readonly hint: string;
    readonly body?: unknown;
    constructor(kind: IgErrorKind, message: string, extra?: { status?: number; endpoint?: string; body?: unknown; hint?: string }) {
        super(message);
        this.name = 'IgError';
        this.kind = kind;
        this.status = extra?.status;
        this.endpoint = extra?.endpoint;
        this.body = extra?.body;
        this.hint = extra?.hint ?? HINTS[kind];
    }
    get fallthrough(): boolean {
        return FALLTHROUGH.includes(this.kind);
    }
}

export interface RequestOptions {
    query?: Record<string, string | number | boolean | undefined>;
    form?: Record<string, string | number | boolean | undefined>;
    json?: unknown;
    body?: Uint8Array;
    headers?: Record<string, string>;
    /** Expect JSON (default true). */
    expectJson?: boolean;
    referer?: string;
    /** Treat HTTP 202 as "still processing" (configure_to_clips: the web client repeats the same request). */
    pendingOn202?: boolean;
    /** Filled in by request(): HTTP status and size of the answer. `text` is only ever a fixed label, never response text. */
    meta?: { status?: number; bytes?: number; text?: string };
}

/** A logical operation tried against an ordered list of candidate endpoints. */
export interface Candidate<T> {
    name: string;
    method: 'GET' | 'POST';
    url: string;
    options?: RequestOptions;
    parse: (data: any) => T;
}

let lastRequestAt = 0;
async function pace(): Promise<void> {
    const wait = lastRequestAt + MIN_REQUEST_GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastRequestAt = Date.now();
}

export async function loadRuntimeConfig(): Promise<RuntimeConfig> {
    const fallback: RuntimeConfig = {
        appId: process.env.INSTAGRAM_APP_ID?.trim() || DEFAULT_IG_APP_ID,
        asbdId: process.env.INSTAGRAM_ASBD_ID?.trim() || DEFAULT_ASBD_ID,
    };
    try {
        const saved = JSON.parse(await readFile(resolveRuntimeConfigPath(), 'utf8')) as Partial<RuntimeConfig>;
        return {
            appId: process.env.INSTAGRAM_APP_ID?.trim() || saved.appId || fallback.appId,
            asbdId: process.env.INSTAGRAM_ASBD_ID?.trim() || saved.asbdId || fallback.asbdId,
            wwwClaim: saved.wwwClaim,
            updatedAt: saved.updatedAt,
        };
    } catch {
        return fallback;
    }
}

async function saveRuntimeConfig(cfg: RuntimeConfig): Promise<void> {
    const p = resolveRuntimeConfigPath();
    await mkdir(path.dirname(p), { recursive: true });
    await writeFile(p, `${JSON.stringify({ ...cfg, updatedAt: new Date().toISOString() }, null, 2)}\n`);
}

/** Reads app id / ASBD id from instagram.com page HTML. Exported for tests. */
export function extractRuntimeConfig(html: string): Partial<RuntimeConfig> {
    const appId = html.match(/"X-IG-App-ID"\s*:\s*"?(\d{10,})/)?.[1] ?? html.match(/"APP_ID"\s*:\s*"(\d{10,})"/)?.[1] ?? html.match(/"appId"\s*:\s*"(\d{10,})"/)?.[1];
    const asbdId = html.match(/"ASBD_ID"\s*:\s*"?(\d{3,})/)?.[1];
    return { ...(appId ? { appId } : {}), ...(asbdId ? { asbdId } : {}) };
}

/** Maps an Instagram JSON body to an error kind (or null when it is a success). */
/**
 * Instagram's own error sentence, made safe to show and store: one line, at most 160 characters, with anything
 * that looks like a token, id or URL removed. The sentence is useful ("media not found"); a value inside it is not.
 */
export function safeServerText(v: unknown): string {
    if (typeof v !== 'string') return '';
    return v
        .replace(/[\r\n\t]+/g, ' ')
        .replace(/https?:\/\/\S+/gi, '<url>')
        .replace(/[A-Za-z0-9_\-:%.=+\/]{20,}/g, '<redacted>')
        .replace(/\d{9,}/g, '<number>')
        .trim()
        .slice(0, 160);
}

/** A redirect target described by a fixed label. Nothing from the Location header itself is ever repeated. */
export function safeLocation(loc: string): string {
    try {
        const u = new URL(loc, IG_ORIGIN);
        if (/^\/accounts\/login/.test(u.pathname)) return 'the login page';
        if (/^\/(challenge|checkpoint)(\/|$)/.test(u.pathname)) return 'a security check page';
        return u.origin === IG_ORIGIN ? 'another instagram.com page' : 'another site';
    } catch {
        return 'an unreadable location';
    }
}

const ACCOUNT_SIGNALS: IgErrorKind[] = ['rate_limited', 'checkpoint', 'feedback_required', 'not_logged_in'];

/**
 * Publish answers can carry per-item results in medias[] / posts[]. Every ERROR entry is inspected with its whole
 * error_info (so flags such as require_login or checkpoint_url are kept): an account signal in any of them wins;
 * otherwise an ERROR entry is a terminal bad request, never "still processing". Null when there is no ERROR entry.
 */
export function nestedErrorKind(status: number, data: any): IgErrorKind | null {
    let found: IgErrorKind | null = null;
    for (const list of [data?.medias, data?.posts]) {
        if (!Array.isArray(list)) continue;
        for (const e of list) {
            if (typeof e?.status !== 'string' || e.status.toLowerCase() !== 'error') continue;
            const info = e.error_info && typeof e.error_info === 'object' ? e.error_info : e;
            const k = classifyBody(status, { ...info, status: undefined, message: info.message ?? info.error_type });
            if (k && ACCOUNT_SIGNALS.includes(k)) return k;
            found = found ?? (k && k !== 'transcode_pending' ? k : 'bad_request');
        }
    }
    return found;
}

/**
 * How one JSON answer is classified. Order: an account signal anywhere (top level or nested) stops everything;
 * then any other top-level error; then a nested ERROR entry; and only when none of those apply may the answer
 * count as "still processing" (a top-level in-progress body, or a clean 202 where the caller asked for that).
 */
export function resolveKind(status: number, data: any, pendingOn202: boolean): IgErrorKind | null {
    const top = classifyBody(status, data);
    const nested = nestedErrorKind(status, data);
    if (top && ACCOUNT_SIGNALS.includes(top)) return top;
    if (nested && ACCOUNT_SIGNALS.includes(nested)) return nested;
    if (top && top !== 'transcode_pending') return top;
    if (nested) return nested;
    return top ?? (pendingOn202 && status === 202 ? 'transcode_pending' : null);
}

export function classifyBody(status: number, data: any): IgErrorKind | null {
    const msg = String(data?.message ?? '').toLowerCase();
    const errType = String(data?.error_type ?? '').toLowerCase();
    if (status === 429 || msg.includes('please wait a few minutes') || errType === 'rate_limit_error') return 'rate_limited';
    if (msg === 'login_required' || errType === 'login_required' || data?.require_login === true) return 'not_logged_in';
    if (msg.includes('checkpoint_required') || msg.includes('challenge_required') || data?.checkpoint_url || data?.challenge) return 'checkpoint';
    if (msg === 'feedback_required' || data?.feedback_required === true || data?.spam === true) return 'feedback_required';
    if (msg.includes('transcode not finished') || msg.includes('media not ready') || data?.status === 'in_progress') return 'transcode_pending';
    if (status === 404) return 'not_found';
    if (status >= 500) return 'server_error';
    if (status >= 400 || data?.status === 'fail') return 'bad_request';
    return null;
}

export class IgClient {
    readonly cookies: Record<string, string>;
    config: RuntimeConfig;
    readonly log?: LogFn;
    private cookiesDirty = false;

    private constructor(cookies: Record<string, string>, config: RuntimeConfig, log?: LogFn) {
        this.cookies = cookies;
        this.config = config;
        this.log = log;
    }

    /** Loads cookies + runtime config; throws not_logged_in when the session cookies are missing. */
    static async create(options?: { log?: LogFn; cookies?: Record<string, string> }): Promise<IgClient> {
        const cookies = options?.cookies ?? (await loadCookies(options?.log));
        const missing = missingCookies(cookies);
        if (missing.length) {
            throw new IgError('not_logged_in', `Missing Instagram cookies: ${missing.join(', ')}.`);
        }
        // Runtime config, doc-id cache, pending ops and the action log live next to the session.
        await ensurePrivateDir(resolveDataDir());
        return new IgClient(cookies, await loadRuntimeConfig(), options?.log);
    }

    get userId(): string {
        return this.cookies.ds_user_id;
    }

    headers(extra?: Record<string, string>, referer?: string): Record<string, string> {
        return {
            'User-Agent': USER_AGENT,
            Accept: '*/*',
            'Accept-Language': 'en-US,en;q=0.9',
            Cookie: formatCookieHeader(this.cookies),
            'X-CSRFToken': this.cookies.csrftoken ?? '',
            'X-IG-App-ID': this.config.appId,
            'X-ASBD-ID': this.config.asbdId,
            'X-IG-WWW-Claim': this.config.wwwClaim ?? '0',
            'X-Requested-With': 'XMLHttpRequest',
            Origin: IG_ORIGIN,
            Referer: referer ?? IG_URL,
            'Sec-Fetch-Site': 'same-origin',
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Dest': 'empty',
            ...extra,
        };
    }

    /** One HTTP request with pacing, cookie rotation, and typed errors. */
    async request<T = any>(method: 'GET' | 'POST', url: string, options: RequestOptions = {}): Promise<T> {
        const u = new URL(url);
        if (u.protocol !== 'https:' || !KNOWN_HOSTS.includes(u.hostname)) {
            throw new IgError('validation', `Refusing to send the Instagram session to ${u.protocol}//${u.hostname}.`);
        }
        for (const [k, v] of Object.entries(options.query ?? {})) if (v !== undefined) u.searchParams.set(k, String(v));

        let body: BodyInit | undefined;
        const extra: Record<string, string> = { ...(options.headers ?? {}) };
        if (options.form) {
            const fd = new URLSearchParams();
            for (const [k, v] of Object.entries(options.form)) if (v !== undefined) fd.set(k, String(v));
            body = fd.toString();
            extra['Content-Type'] = 'application/x-www-form-urlencoded';
        } else if (options.json !== undefined) {
            body = JSON.stringify(options.json);
            extra['Content-Type'] = 'application/json';
        } else if (options.body) {
            body = options.body as unknown as BodyInit;
        }

        await pace();
        let res: Response;
        try {
            res = await fetch(u, { method, headers: this.headers(extra, options.referer), body, redirect: 'manual' });
        } catch (error) {
            throw new IgError('server_error', `Network error calling ${u.pathname}: ${(error as Error).message}`, { endpoint: u.pathname });
        }

        const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
        if (applySetCookie(this.cookies, setCookies)) this.cookiesDirty = true;
        const claim = res.headers.get('x-ig-set-www-claim');
        if (claim && claim !== this.config.wwwClaim) {
            this.config = { ...this.config, wwwClaim: claim };
            await saveRuntimeConfig(this.config).catch(() => undefined);
        }

        if (res.status >= 300 && res.status < 400) {
            const loc = res.headers.get('location') ?? '';
            if (options.meta) {
                // A redirect is thrown before the body is parsed: keep its status, size and target as evidence.
                const redirectBody = await res.text().catch(() => '');
                options.meta.status = res.status;
                options.meta.bytes = Buffer.byteLength(redirectBody, 'utf8');
                options.meta.text = `redirect to ${safeLocation(loc)}`;
            }
            if (/accounts\/login/.test(loc)) throw new IgError('not_logged_in', `Redirected to login from ${u.pathname}.`, { status: res.status, endpoint: u.pathname });
            if (/challenge|checkpoint/.test(loc)) throw new IgError('checkpoint', `Redirected to a checkpoint from ${u.pathname}.`, { status: res.status, endpoint: u.pathname });
            throw new IgError('unexpected_response', `Unexpected redirect (${res.status}) from ${u.pathname} to ${safeLocation(loc)}.`, { status: res.status, endpoint: u.pathname });
        }

        const text = await res.text();
        // Diagnostics first, before any parsing can throw: status, UTF-8 size and the start of the body.
        if (options.meta) {
            options.meta.status = res.status;
            options.meta.bytes = Buffer.byteLength(text, 'utf8');
        }
        if (options.expectJson === false) {
            // The signed-in home page carries the request context some writes need; keep it in memory when it parses.
            if (method === 'GET' && res.ok && u.origin === IG_ORIGIN && u.pathname === '/') {
                try {
                    this.webCtx = extractWebContext(text);
                } catch {
                    this.webCtx = null;
                }
            }
            // Account signals first, whatever the status: a 403 challenge page is a checkpoint, not a bad request.
            if ((res.ok ? CHALLENGE_PAGE_STRONG : CHALLENGE_HTML).test(text)) throw new IgError('checkpoint', `${u.pathname} served a security-check page.`, { status: res.status, endpoint: u.pathname });
            if (LOGIN_HTML.test(text)) throw new IgError('not_logged_in', `${u.pathname} served the login page.`, { status: res.status, endpoint: u.pathname });
            if (FEEDBACK_HTML.test(text)) throw new IgError('feedback_required', `${u.pathname} reported an action block.`, { status: res.status, endpoint: u.pathname });
            if (WAIT_HTML.test(text)) throw new IgError('rate_limited', `${u.pathname} asked to wait.`, { status: res.status, endpoint: u.pathname });
            if (res.status === 429) throw new IgError('rate_limited', `HTTP 429 on ${u.pathname}.`, { status: 429, endpoint: u.pathname });
            if (!res.ok) throw new IgError(res.status === 404 ? 'not_found' : res.status >= 500 ? 'server_error' : 'bad_request', `HTTP ${res.status} on ${u.pathname}.`, { status: res.status, endpoint: u.pathname });
            return text as T;
        }

        let data: any;
        try {
            data = text ? JSON.parse(text) : {};
        } catch {
            if (res.status === 429) throw new IgError('rate_limited', `HTTP 429 on ${u.pathname}.`, { status: 429, endpoint: u.pathname });
            // Account signals before "not found": a 404 challenge page must stop, not fall through.
            const kind: IgErrorKind = CHALLENGE_HTML.test(text)
                ? 'checkpoint'
                : LOGIN_HTML.test(text) || /accounts\/login/.test(text)
                  ? 'not_logged_in'
                  : FEEDBACK_HTML.test(text)
                    ? 'feedback_required'
                    : WAIT_HTML.test(text)
                      ? 'rate_limited'
                      : res.status === 404
                    ? 'not_found'
                    : res.status >= 500
                    ? 'server_error'
                    : 'unexpected_response';
            throw new IgError(kind, `Non-JSON response (${res.status}) from ${u.pathname}.`, { status: res.status, endpoint: u.pathname });
        }

        const kind = resolveKind(res.status, data, Boolean(options.pendingOn202));
        if (kind) {
            const message = safeServerText(data?.message || data?.error_title) || `HTTP ${res.status}`;
            throw new IgError(kind, `${u.pathname}: ${message}`, { status: res.status, endpoint: u.pathname, body: data });
        }
        return data as T;
    }

    /**
     * Tries candidates in order. Moves on only when a candidate is missing or
     * answers in an unknown shape; any auth / rate-limit / payload error stops at once.
     */
    async tryEach<T>(op: string, candidates: Candidate<T>[], opts?: { mutation?: boolean }): Promise<{ value: T; via: string }> {
        const failures: string[] = [];
        for (const c of candidates) {
            try {
                const data = await this.request(c.method, c.url, c.options);
                let value: T;
                try {
                    value = c.parse(data);
                } catch (error) {
                    throw new IgError('unexpected_response', `${c.name}: ${(error as Error).message}`, { endpoint: c.url });
                }
                return { value, via: c.name };
            } catch (error) {
                // A write may already have been applied unless the endpoint plainly does not exist
                // (HTTP 404), so mutations fall through on nothing else: no duplicate comments/deletes.
                const canFallThrough = error instanceof IgError && (opts?.mutation ? error.kind === 'not_found' && error.status === 404 : error.fallthrough);
                if (canFallThrough) {
                    failures.push(`${c.name}: ${error.message}`);
                    this.log?.(`[instagram] ${op}: ${c.name} unavailable, trying next endpoint`);
                    continue;
                }
                throw error;
            }
        }
        throw new IgError('not_found', `${op}: no endpoint answered.\n  ${failures.join('\n  ')}`, {
            hint: 'Every known endpoint for this operation failed. Run `probe`, then update scripts/endpoints.ts.',
        });
    }

    /** In-memory only: never written to disk, never returned by a command. */
    private webCtx: WebContext | null = null;
    private readonly webSessionId = newWebSessionId();
    private cometReq = 0;

    /** Which transport the current web client uses for stories / carousels on this session (null = unknown). */
    webGates(): { storyComet: boolean | null; sidecarComet: boolean | null } | null {
        return this.webCtx ? this.webCtx.gates : null;
    }

    /**
     * Makes sure the page context for comet writes is loaded and fresh (15 minutes). One GET of the home page when
     * it is not. Throws before any upload when the page does not carry the expected context: nothing is guessed.
     */
    async ensureWebContext(): Promise<void> {
        if (this.webCtx && Date.now() - this.webCtx.fetchedAt < 15 * 60_000) return;
        const html = await this.request<string>('GET', IG_URL, {
            expectJson: false,
            headers: { Accept: 'text/html,application/xhtml+xml', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' },
        });
        if (!this.webCtx) {
            let why = 'unknown reason';
            try {
                extractWebContext(html);
            } catch (e) {
                why = (e as Error).message;
            }
            throw new IgError('unexpected_response', `Cannot prepare the publish request: ${why}`, {
                hint: 'Nothing was uploaded or sent. instagram.com may have changed its page; publish from the app and report this.',
            });
        }
    }

    /**
     * A comet async POST (see comet.ts). Returns the payload on success. Throws:
     *  - transcode_pending (status 202, body = payload) when payload.statusCode is 202: repeat the same request;
     *  - an account signal when one is anywhere in the answer;
     *  - unexpected_response for an empty body, a non-envelope answer or an envelope error. Those carry NO body,
     *    so the caller keeps the publish unresolved instead of assuming nothing was created.
     * `meta` receives the HTTP status, size and an allow-listed summary (never raw text: answers can carry tokens).
     */
    async cometPost(url: string, fields: Record<string, unknown>, meta: { status?: number; bytes?: number; text?: string } = {}): Promise<any> {
        await this.ensureWebContext();
        const ctx = this.webCtx!;
        const u = new URL(url);
        if (u.origin !== IG_ORIGIN) throw new IgError('validation', `Comet requests are only sent to ${IG_ORIGIN}.`);
        const form = cometForm(fields, ctx, ++this.cometReq, this.webSessionId);
        const raw: { status?: number; bytes?: number; text?: string } = {};
        const text = await this.request<string>('POST', url, { form, expectJson: false, headers: cometHeaders(ctx, this.webSessionId), meta: raw });
        const answer = decodeComet(typeof text === 'string' ? text : '');
        meta.status = raw.status;
        meta.bytes = raw.bytes;
        // Every error below has a fixed message and NO body: nothing the server wrote is repeated (an answer can
        // carry tokens), and without a body the publish is never treated as a definitive "not posted".
        const where = { status: raw.status, endpoint: u.pathname };
        const fail = (kind: IgErrorKind, text: string): never => {
            throw new IgError(kind, `${u.pathname}: ${text}`, where);
        };
        if (answer.kind === 'empty') {
            meta.text = 'empty body';
            return fail('unexpected_response', `HTTP ${raw.status} with an empty body: the request shape was probably not accepted.`);
        }
        meta.text = answer.summary;
        if (answer.kind === 'not_envelope') return fail('unexpected_response', `the answer was not the expected envelope (${answer.summary}).`);
        if (answer.signal) return fail(answer.signal, `the answer carried an account signal (${answer.signal}). No further request was made.`);
        if (answer.kind === 'error') return fail('unexpected_response', `the server reported ${answer.summary}.`);
        const p = answer.payload;
        const hasMedia = hasCreationEvidence(p);
        const errorEntry = [p.medias, p.posts].some((l) => Array.isArray(l) && l.some((e: any) => typeof e?.status === 'string' && e.status.toLowerCase() === 'error'));
        const failed = errorEntry || (typeof p.status === 'string' && p.status.toLowerCase() === 'fail') || (answer.statusCode !== null && answer.statusCode >= 400);
        if (failed) return fail('unexpected_response', `the server reported a failure (${answer.summary}).`);
        // "Still processing" is exactly payload.statusCode 202 with no media and no error; only that repeats.
        if (answer.statusCode === 202 && !hasMedia) {
            throw new IgError('transcode_pending', `${u.pathname}: still processing.`, { status: 202, endpoint: u.pathname, body: { statusCode: 202 } });
        }
        return p;
    }

    /** Fetches the instagram.com home page to refresh app id / ASBD id and confirm the session. */
    async refreshRuntimeConfig(): Promise<RuntimeConfig> {
        const html = await this.request<string>('GET', IG_URL, {
            expectJson: false,
            headers: { Accept: 'text/html,application/xhtml+xml', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' },
        });
        if (/"viewerId"\s*:\s*null|"is_logged_in"\s*:\s*false/.test(html)) {
            throw new IgError('not_logged_in', 'instagram.com served the logged-out page.');
        }
        const found = extractRuntimeConfig(html);
        this.config = { ...this.config, ...found };
        await saveRuntimeConfig(this.config);
        return this.config;
    }

    /** Persists rotated cookies (csrftoken / rur) back to the cookie file. */
    async flush(): Promise<void> {
        if (this.cookiesDirty && !process.env.INSTAGRAM_COOKIES) {
            await writeCookieMapToDisk(this.cookies);
            this.cookiesDirty = false;
        }
    }
}

/** Appends one line per write to the local action log (ids and urls, never cookies). */
export async function logAction(entry: Record<string, unknown>): Promise<void> {
    const p = resolveActionLogPath();
    await mkdir(path.dirname(p), { recursive: true });
    await appendFile(p, `${JSON.stringify({ at: new Date().toISOString(), host: IG_HOST, ...entry })}\n`);
}
