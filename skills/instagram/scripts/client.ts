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
    rate_limited: 'Instagram answered HTTP 429 on this endpoint. Some endpoints always answer 429 to web sessions, so this does not by itself mean the account is limited. Do not retry in a loop; check `whoami`, and if the whole session is limited, wait 15-30 minutes.',
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
            if (/accounts\/login/.test(loc)) throw new IgError('not_logged_in', `Redirected to login from ${u.pathname}.`, { status: res.status, endpoint: u.pathname });
            if (/challenge|checkpoint/.test(loc)) throw new IgError('checkpoint', `Redirected to a checkpoint from ${u.pathname}.`, { status: res.status, endpoint: u.pathname });
            throw new IgError('unexpected_response', `Unexpected redirect (${res.status}) from ${u.pathname} to ${loc}.`, { status: res.status, endpoint: u.pathname });
        }

        const text = await res.text();
        if (options.expectJson === false) {
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

        const kind = classifyBody(res.status, data);
        if (kind) {
            const message = data?.message || data?.error_title || `HTTP ${res.status}`;
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
