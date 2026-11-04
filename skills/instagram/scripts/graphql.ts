import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { IG_ORIGIN, USER_AGENT } from './constants.ts';
import { IgClient, IgError } from './client.ts';
import { resolveDataDir } from './paths.ts';

/**
 * The web client reads most data through Relay persisted queries:
 *   POST /graphql/query  form: doc_id, variables, fb_dtsg, lsd, fb_api_req_friendly_name, ...
 * doc_ids rotate with every web deploy, so they are discovered, not hardcoded.
 * Verified 2026-11-03: each operation is registered in a CDN bundle as
 *   __d("<Name>_instagramRelayOperation",[],(function(a,b,c,d,e,f){e.exports="<doc_id>"}),null)
 * (188 operations on a profile page, all with 17-digit ids).
 *
 * Bundles are fetched from the CDN without cookies; only the page and the
 * /graphql/query call carry the session.
 */

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const OP_RE = /__d\("([A-Za-z0-9_]+)_instagramRelayOperation",\[\],\(function\([a-z,]+\)\{[a-z]\.exports="(\d{10,})"/g;

interface DocCache {
    updatedAt: string;
    docIds: Record<string, string>;
}

function cachePath(): string {
    return path.join(resolveDataDir(), 'graphql-docids.json');
}

/** Pulls `Name -> doc_id` pairs out of bundle source. Exported for tests. */
export function extractDocIds(source: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const m of source.matchAll(OP_RE)) out[m[1]] = m[2];
    return out;
}

/** Reads fb_dtsg / lsd tokens from page HTML. Exported for tests. */
export function extractPageTokens(html: string): { fbDtsg?: string; lsd?: string } {
    const fbDtsg =
        html.match(/"DTSGInitialData",\[\],\{"token":"([^"]+)"/)?.[1] ??
        html.match(/"dtsg":\{"token":"([^"]+)"/)?.[1] ??
        html.match(/name="fb_dtsg" value="([^"]+)"/)?.[1];
    const lsd = html.match(/"LSD",\[\],\{"token":"([^"]+)"/)?.[1] ?? html.match(/"lsd":"([^"]+)"/)?.[1];
    return { fbDtsg, lsd };
}

/** Script URLs referenced by a page (only Meta CDN hosts). Exported for tests. */
export function extractScriptUrls(html: string): string[] {
    const urls = new Set<string>();
    for (const m of html.matchAll(/<script[^>]+src="([^"]+)"/g)) {
        const raw = m[1].replace(/&amp;/g, '&');
        try {
            const u = new URL(raw, IG_ORIGIN);
            if (/(^|\.)cdninstagram\.com$|(^|\.)fbcdn\.net$|(^|\.)instagram\.com$/.test(u.hostname)) urls.add(u.toString());
        } catch {
            // ignore
        }
    }
    return [...urls];
}

export class GraphQL {
    private tokens: { fbDtsg?: string; lsd?: string } = {};
    private docIds: Record<string, string> = {};

    constructor(private readonly client: IgClient) {}

    /**
     * Loads a page (profile pages carry the post/feed operations), its tokens and doc ids.
     * `need` names operations that must be known: if the cache lacks one, this page's
     * bundles are scanned and merged into the cache (each page ships different operations).
     */
    async init(pagePath = '/', need: string[] = []): Promise<void> {
        const cache = await this.readCache();
        const cached = cache?.docIds ?? null;
        const html = await this.client.request<string>('GET', `${IG_ORIGIN}${pagePath}`, {
            expectJson: false,
            headers: { Accept: 'text/html,application/xhtml+xml', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' },
        });
        this.tokens = extractPageTokens(html);
        if (cached && need.every((n) => cached[n] || process.env[`INSTAGRAM_DOCID_${n}`])) {
            this.docIds = cached;
            return;
        }
        const found: Record<string, string> = { ...(cached ?? {}), ...extractDocIds(html) };
        for (const url of extractScriptUrls(html)) {
            try {
                const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
                if (res.ok) Object.assign(found, extractDocIds(await res.text()));
            } catch {
                // a missing bundle only means fewer operations
            }
        }
        this.docIds = found;
        // A partial rescan keeps the old timestamp, so ids carried over from the cache still expire on time.
        if (Object.keys(found).length) await this.writeCache(found, cached ? cache!.updatedAt : undefined);
    }

    docId(name: string): string | undefined {
        return process.env[`INSTAGRAM_DOCID_${name}`]?.trim() || this.docIds[name];
    }

    knownOperations(): string[] {
        return Object.keys(this.docIds).sort();
    }

    /** `path`: reads use /graphql/query; mutations go to /api/graphql, as the web client's Relay environment does. */
    async query<T = any>(name: string, variables: Record<string, unknown>, opts: { path?: '/graphql/query' | '/api/graphql' } = {}): Promise<T> {
        const docId = this.docId(name);
        if (!docId) {
            throw new IgError('not_found', `GraphQL operation ${name} not found in the web bundles.`, {
                hint: `Instagram renamed or stopped loading ${name}. Delete ${cachePath()} and retry, or set INSTAGRAM_DOCID_${name}.`,
            });
        }
        if (!this.tokens.fbDtsg && !this.tokens.lsd) {
            throw new IgError('unexpected_response', 'No fb_dtsg/lsd token on the instagram.com page; cannot call GraphQL.');
        }
        const data = await this.client.request<any>('POST', `${IG_ORIGIN}${opts.path ?? '/graphql/query'}`, {
            form: {
                av: this.client.userId,
                __user: '0',
                __a: '1',
                fb_dtsg: this.tokens.fbDtsg,
                lsd: this.tokens.lsd,
                fb_api_caller_class: 'RelayModern',
                fb_api_req_friendly_name: name,
                server_timestamps: 'true',
                doc_id: docId,
                variables: JSON.stringify(variables),
            },
            headers: {
                'X-FB-Friendly-Name': name,
                ...(this.tokens.lsd ? { 'X-FB-LSD': this.tokens.lsd } : {}),
            },
        });
        if (Array.isArray(data?.errors) && data.errors.length) {
            const msg = data.errors.map((e: any) => `${e?.message ?? ''} ${e?.summary ?? ''} ${e?.description ?? ''}`).join('; ');
            const kind = /checkpoint|challenge/i.test(msg)
                ? 'checkpoint'
                : /login|not logged|unauthori[sz]ed/i.test(msg)
                  ? 'not_logged_in'
                  : /feedback_required|action blocked/i.test(msg)
                    ? 'feedback_required'
                    : /rate[ -]?limit|too many requests|please wait|try again later/i.test(msg)
                      ? 'rate_limited'
                      : 'bad_request';
            // Account signals stop the operation even when partial data came back.
            if (kind !== 'bad_request' || !data.data) throw new IgError(kind, `${name}: ${msg.trim()}`, { body: data });
        }
        return data as T;
    }

    private async readCache(): Promise<DocCache | null> {
        try {
            const c = JSON.parse(await readFile(cachePath(), 'utf8')) as DocCache;
            if (Date.now() - Date.parse(c.updatedAt) < CACHE_TTL_MS && Object.keys(c.docIds ?? {}).length) return c;
        } catch {
            // no cache
        }
        return null;
    }

    private async writeCache(docIds: Record<string, string>, updatedAt = new Date().toISOString()): Promise<void> {
        await mkdir(path.dirname(cachePath()), { recursive: true });
        const c: DocCache = { updatedAt, docIds };
        await writeFile(cachePath(), `${JSON.stringify(c, null, 2)}\n`);
    }
}

/**
 * EXPERIMENTAL variable shapes for the operations the read commands use.
 * They mirror what the web client sent in 2025-2026; if Instagram changes them the
 * call fails with a typed error rather than returning wrong data.
 */
export const GQL = {
    profilePosts: {
        name: 'PolarisProfilePostsQuery',
        variables: (username: string, count: number, after?: string) => ({
            data: {
                count,
                include_reel_media_seen_timestamp: true,
                include_relationship_info: true,
                latest_besties_reel_media: true,
                latest_reel_media: true,
            },
            username,
            ...(after ? { after, before: null, first: count, last: null } : {}),
            __relay_internal__pv__PolarisIsLoggedInrelayprovider: true,
        }),
        /** Returns the timeline connection, whatever the root field is called this week. */
        connection: (data: any) => {
            const d = data?.data ?? {};
            const key = Object.keys(d).find((k) => /timeline.*connection|feed__user_timeline/.test(k));
            return key ? d[key] : null;
        },
    },
    topsearch: {
        name: 'PolarisAPITopsearchQuery',
        variables: (query: string) => ({
            data: { context: 'blended', include_reel: 'true', query, rank_token: '', search_surface: 'web_top_search' },
            hasQuery: true,
        }),
        result: (data: any) => {
            const d = data?.data ?? {};
            const key = Object.keys(d).find((k) => /topsearch/.test(k));
            return key ? d[key] : null;
        },
    },
} as const;
