import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { audit, engagement, median, swipeFile } from '../../skills/instagram/scripts/analytics.ts';
import { IgClient, IgError, classifyBody, extractRuntimeConfig } from '../../skills/instagram/scripts/client.ts';
import { instagramOrigin, pkToShortcode, shortcodeFromUrl, shortcodeToPk } from '../../skills/instagram/scripts/constants.ts';
import { applySetCookie, formatCookieHeader, missingCookies, parseCookieInput, redact } from '../../skills/instagram/scripts/cookie-store.ts';
import { extractDocIds, extractPageTokens, extractScriptUrls } from '../../skills/instagram/scripts/graphql.ts';
import { parseArgs } from '../../skills/instagram/scripts/main.ts';
import { jpegSize, mp4Info, pngSize, webpSize } from '../../skills/instagram/scripts/media.ts';
import { hashtagsOf, normalizePost, normalizeProfile } from '../../skills/instagram/scripts/normalize.ts';
import { CONTRACTS, addComment, checkCaption, describePlan, executePlan, planCarousel, planPhoto, planReel } from '../../skills/instagram/scripts/publish.ts';
import { beginPending, clearPending, listPending } from '../../skills/instagram/scripts/pending.ts';
import { parseIcaclsPrincipals } from '../../skills/instagram/scripts/secure.ts';
import type { Post, Profile } from '../../skills/instagram/scripts/types.ts';

const ROOT = path.resolve(import.meta.dir, '../..');
const MAIN = path.join(ROOT, 'skills/instagram/scripts/main.ts');
const TRAP = path.join(import.meta.dir, 'fetch-trap.ts');
const FAKE = { sessionid: 'S1', csrftoken: 'C1', ds_user_id: '42' };

// ---------------------------------------------------------------- fixtures (built in memory)

function png(w: number, h: number): Uint8Array {
    const b = new Uint8Array(33);
    b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
    new DataView(b.buffer).setUint32(16, w);
    new DataView(b.buffer).setUint32(20, h);
    return b;
}

function jpeg(w: number, h: number): Uint8Array {
    // SOI, APP0 (minimal), SOF0 with height/width, EOI
    const app0 = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0];
    const sof = [0xff, 0xc0, 0x00, 0x11, 8, h >> 8, h & 255, w >> 8, w & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
    return new Uint8Array([0xff, 0xd8, ...app0, ...sof, 0xff, 0xd9]);
}

const tmp = mkdtempSync(path.join(os.tmpdir(), 'ig-media-'));
const file = (name: string, bytes: Uint8Array) => {
    const p = path.join(tmp, name);
    writeFileSync(p, bytes);
    return p;
};
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
function ffmpegVideo(name: string, size: string, seconds: number): string {
    const p = path.join(tmp, name);
    spawnSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `testsrc=s=${size}:d=${seconds}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', p]);
    return p;
}

function post(over: Partial<Post>): Post {
    return { id: '1', pk: '1', shortcode: 'A', url: 'u', format: 'photo', takenAt: '2026-10-01T15:00:00.000Z', caption: 'Hook line\nbody', likes: 100, comments: 10, plays: null, views: null, durationSec: null, owner: 'me', hashtags: [], ...over };
}

// ---------------------------------------------------------------- cookies

describe('cookie input formats', () => {
    test('Cookie header', () => {
        expect(parseCookieInput('Cookie: sessionid=S1; csrftoken=C1; ds_user_id=42')).toEqual(FAKE);
    });
    test('Cookie-Editor JSON array, other domains ignored', () => {
        const arr = [
            { domain: '.instagram.com', name: 'sessionid', value: 'S1' },
            { domain: '.instagram.com', name: 'csrftoken', value: 'C1' },
            { domain: '.instagram.com', name: 'ds_user_id', value: '42' },
            { domain: '.facebook.com', name: 'sessionid', value: 'EVIL' },
        ];
        expect(parseCookieInput(JSON.stringify(arr))).toMatchObject(FAKE);
    });
    test('Netscape cookies.txt including #HttpOnly_ lines', () => {
        const txt = ['# Netscape HTTP Cookie File', '#HttpOnly_.instagram.com\tTRUE\t/\tTRUE\t0\tsessionid\tS1', '.instagram.com\tTRUE\t/\tTRUE\t0\tcsrftoken\tC1', '.instagram.com\tTRUE\t/\tTRUE\t0\tds_user_id\t42'].join('\n');
        expect(parseCookieInput(txt)).toMatchObject(FAKE);
    });
    test('missing cookies are reported', () => {
        expect(missingCookies({ sessionid: 'x' })).toEqual(['csrftoken', 'ds_user_id']);
    });
    test('set-cookie rotation updates csrftoken and redact hides values', () => {
        const m = { ...FAKE };
        expect(applySetCookie(m, ['csrftoken=NEW; Path=/; Secure'])).toBe(true);
        expect(m.csrftoken).toBe('NEW');
        expect(formatCookieHeader(m)).toContain('csrftoken=NEW');
        expect(JSON.stringify(redact(m))).not.toContain('S1');
    });
});

// ---------------------------------------------------------------- ids, args, html parsing

describe('ids and parsing', () => {
    test('shortcode <-> pk round trip and URL parsing', () => {
        const pk = shortcodeToPk('DAbc123xyz0');
        expect(pkToShortcode(pk)).toBe('DAbc123xyz0');
        expect(shortcodeFromUrl('https://www.instagram.com/reel/DAbc123xyz0/?igsh=x')).toBe('DAbc123xyz0');
        expect(shortcodeFromUrl('https://www.instagram.com/p/DAbc123xyz0/')).toBe('DAbc123xyz0');
    });
    test('parseArgs keeps booleans boolean and values as strings', () => {
        const a = parseArgs(['post', 'photo', 'a.jpg', '--caption', 'hi', '--confirm', '--limit=3']);
        expect(a._).toEqual(['post', 'photo', 'a.jpg']);
        expect(a.flags).toEqual({ caption: 'hi', confirm: true, limit: '3' });
    });
    test('doc ids, page tokens, script urls', () => {
        const bundle = '__d("PolarisProfilePostsQuery_instagramRelayOperation",[],(function(a,b,c,d,e,f){e.exports="12345678901234567"}),null);';
        expect(extractDocIds(bundle)).toEqual({ PolarisProfilePostsQuery: '12345678901234567' });
        const html = '["DTSGInitialData",[],{"token":"DT"}],["LSD",[],{"token":"LS"}] <script src="https://static.cdninstagram.com/rsrc.php/a.js"></script><script src="https://evil.example/x.js"></script>';
        expect(extractPageTokens(html)).toEqual({ fbDtsg: 'DT', lsd: 'LS' });
        expect(extractScriptUrls(html)).toEqual(['https://static.cdninstagram.com/rsrc.php/a.js']);
    });
    test('runtime config from page html', () => {
        expect(extractRuntimeConfig('"X-IG-App-ID":"936619743392459","ASBD_ID":"359341"')).toEqual({ appId: '936619743392459', asbdId: '359341' });
    });
    test('icacls output parsing', () => {
        const out = 'C:\\x\\cookies.json DANTE\\jdnic:(F)\r\n                    BUILTIN\\Administrators:(I)(F)\r\n\r\nSuccessfully processed 1 files';
        expect(parseIcaclsPrincipals(out, 'C:\\x\\cookies.json')).toEqual(['DANTE\\jdnic', 'BUILTIN\\Administrators']);
    });
});

// ---------------------------------------------------------------- error classification

describe('classifyBody', () => {
    test.each([
        [429, {}, 'rate_limited'],
        [400, { message: 'Please wait a few minutes before you try again.' }, 'rate_limited'],
        [403, { message: 'login_required' }, 'not_logged_in'],
        [400, { message: 'checkpoint_required' }, 'checkpoint'],
        [400, { message: 'feedback_required', spam: true }, 'feedback_required'],
        [202, { message: 'Transcode not finished yet.' }, 'transcode_pending'],
        [202, {}, null],
        [200, { status: 'in_progress' }, 'transcode_pending'],
        [404, {}, 'not_found'],
        [500, {}, 'server_error'],
        [200, { status: 'ok' }, null],
    ])('%i %j -> %s', (status, body, kind) => {
        expect(classifyBody(status as number, body)).toBe(kind as any);
    });
});

// ---------------------------------------------------------------- client safety

describe('IgClient safety', () => {
    const realFetch = globalThis.fetch;
    afterEach(() => {
        globalThis.fetch = realFetch;
    });

    test('origin overrides cannot leave instagram.com (Bun auto-loads .env)', () => {
        process.env.IG_T1 = 'https://evil.example';
        process.env.IG_T2 = 'http://www.instagram.com';
        process.env.IG_T3 = 'https://www.instagram.com.evil.example';
        process.env.IG_T4 = 'https://graph.instagram.com/';
        expect(instagramOrigin('IG_T1', 'https://www.instagram.com')).toBe('https://www.instagram.com');
        expect(instagramOrigin('IG_T2', 'https://www.instagram.com')).toBe('https://www.instagram.com');
        expect(instagramOrigin('IG_T3', 'https://www.instagram.com')).toBe('https://www.instagram.com');
        expect(instagramOrigin('IG_T4', 'https://www.instagram.com')).toBe('https://graph.instagram.com');
    });

    test('refuses to send the session to a non-Instagram host', async () => {
        let called = 0;
        globalThis.fetch = (async () => {
            called++;
            return new Response('{}');
        }) as unknown as typeof fetch;
        const c = await IgClient.create({ cookies: { ...FAKE } });
        await expect(c.request('GET', 'https://evil.example/api')).rejects.toMatchObject({ kind: 'validation' });
        await expect(c.request('GET', 'http://www.instagram.com/api')).rejects.toMatchObject({ kind: 'validation' });
        expect(called).toBe(0);
    });

    test('stops at the first 429 and never tries the next endpoint', async () => {
        const urls: string[] = [];
        globalThis.fetch = (async (u: URL) => {
            urls.push(String(u));
            return new Response('{"message":"rate limited","status":"fail"}', { status: 429 });
        }) as unknown as typeof fetch;
        const c = await IgClient.create({ cookies: { ...FAKE } });
        const candidates = [
            { name: 'a', method: 'GET' as const, url: 'https://www.instagram.com/api/v1/a/', parse: (d: any) => d },
            { name: 'b', method: 'GET' as const, url: 'https://www.instagram.com/api/v1/b/', parse: (d: any) => d },
        ];
        await expect(c.tryEach('op', candidates)).rejects.toMatchObject({ kind: 'rate_limited' });
        expect(urls).toHaveLength(1);
    });

    test('falls through only on not_found', async () => {
        const urls: string[] = [];
        globalThis.fetch = (async (u: URL) => {
            urls.push(String(u));
            return urls.length === 1 ? new Response('not here', { status: 404 }) : new Response('{"ok":1}');
        }) as unknown as typeof fetch;
        const c = await IgClient.create({ cookies: { ...FAKE } });
        const r = await c.tryEach('op', [
            { name: 'a', method: 'GET', url: 'https://www.instagram.com/api/v1/a/', parse: (d: any) => d },
            { name: 'b', method: 'GET', url: 'https://www.instagram.com/api/v1/b/', parse: (d: any) => d },
        ]);
        expect(r.via).toBe('b');
    });

    test('a mutation never falls through after an unclear answer (no duplicate comment)', async () => {
        const urls: string[] = [];
        globalThis.fetch = (async (u: URL) => {
            if (String(u).includes('/p/')) return new Response('<html></html>'); // post page read: no doc_ids, so REST is used
            urls.push(String(u));
            return new Response('{"status":"ok"}'); // committed, but no comment id in the body
        }) as unknown as typeof fetch;
        const c = await IgClient.create({ cookies: { ...FAKE } });
        await expect(addComment(c, 'DAbc123xyz0', 'hi')).rejects.toMatchObject({ kind: 'unexpected_response' });
        expect(urls).toHaveLength(1);
    });

    test('a mutation falls through only on a plain 404', async () => {
        const urls: string[] = [];
        globalThis.fetch = (async (u: URL) => {
            if (String(u).includes('/p/')) return new Response('<html></html>'); // post page read: no doc_ids, so REST is used
            urls.push(String(u));
            return urls.length === 1 ? new Response('nope', { status: 404 }) : new Response('{"id":"777"}');
        }) as unknown as typeof fetch;
        const c = await IgClient.create({ cookies: { ...FAKE } });
        const r = await addComment(c, 'DAbc123xyz0', 'hi');
        expect(r.commentId).toBe('777');
        expect(urls).toHaveLength(2);
    });

    test('an HTML challenge page is a checkpoint, not a fallthrough', async () => {
        const urls: string[] = [];
        globalThis.fetch = (async (u: URL) => {
            urls.push(String(u));
            return new Response('<html><a href="/challenge/123/">verify</a></html>', { status: 200 });
        }) as unknown as typeof fetch;
        const c = await IgClient.create({ cookies: { ...FAKE } });
        await expect(
            c.tryEach('op', [
                { name: 'a', method: 'GET', url: 'https://www.instagram.com/api/v1/a/', parse: (d: any) => d },
                { name: 'b', method: 'GET', url: 'https://www.instagram.com/api/v1/b/', parse: (d: any) => d },
            ]),
        ).rejects.toMatchObject({ kind: 'checkpoint' });
        expect(urls).toHaveLength(1);
    });

    test('a login redirect is not_logged_in and is not followed', async () => {
        globalThis.fetch = (async (_u: URL, init: RequestInit) => {
            expect(init.redirect).toBe('manual');
            return new Response('', { status: 302, headers: { location: 'https://www.instagram.com/accounts/login/' } });
        }) as unknown as typeof fetch;
        const c = await IgClient.create({ cookies: { ...FAKE } });
        await expect(c.request('GET', 'https://www.instagram.com/api/v1/x/')).rejects.toMatchObject({ kind: 'not_logged_in' });
    });
});

// ---------------------------------------------------------------- media

describe('media header parsers', () => {
    test('png / jpeg', () => {
        expect(pngSize(png(1080, 1350))).toEqual({ width: 1080, height: 1350 });
        expect(jpegSize(jpeg(1080, 1350))).toMatchObject({ width: 1080, height: 1350 });
    });
    test('garbage is null', () => {
        expect(pngSize(new Uint8Array(10))).toBeNull();
        expect(jpegSize(new Uint8Array(10))).toBeNull();
        expect(webpSize(new Uint8Array(10))).toBeNull();
        expect(mp4Info(new Uint8Array(10))).toBeNull();
    });
    test.skipIf(!hasFfmpeg)('mp4 duration, size and codec (ffmpeg fixture)', () => {
        const p = ffmpegVideo('v.mp4', '1080x1920', 4);
        const info = mp4Info(new Uint8Array(require('node:fs').readFileSync(p)));
        expect(info).toMatchObject({ width: 1080, height: 1920, codec: 'avc1' });
        expect(Math.round((info!.durationMs ?? 0) / 1000)).toBe(4);
    });
});

// ---------------------------------------------------------------- validation and plans

describe('publish validation and plans', () => {
    test('caption limits', () => {
        expect(checkCaption('a #1 #2 #3 #4 #5').errors).toEqual([]);
        expect(checkCaption('a #1 #2 #3 #4 #5 #6').errors[0]).toContain('6 hashtags');
        expect(checkCaption('x'.repeat(2201)).errors[0]).toContain('2201');
        expect(checkCaption('see https://x.com').warnings.join()).toContain('not clickable');
        expect(hashtagsOf('one #Two and #three_3')).toEqual(['two', 'three_3']);
    });

    test('photo plan: valid 4:5, configure body, cookies redacted', async () => {
        const plan = await planPhoto(file('a.jpg', jpeg(1080, 1350)), { caption: 'Hi #a', altText: 'alt' });
        expect(plan.check.errors).toEqual([]);
        const d = JSON.stringify(describePlan(plan));
        expect(d).toContain('/api/v1/media/configure/');
        expect(d).toContain('custom_accessibility_caption');
        expect(d).toContain('"Cookie":"<redacted>"'); // not a raw 'S1' check: mkdtemp path suffixes may contain it
        expect(d).toContain('"X-CSRFToken":"<redacted>"');
    });

    test('photo plan rejects an out-of-range aspect', async () => {
        const plan = await planPhoto(file('wide.jpg', jpeg(2000, 500)), { caption: '' });
        expect(plan.check.errors.join()).toContain('aspect');
    });

    test('carousel needs 2..20 items and keeps order', async () => {
        const one = await planCarousel([file('c1.jpg', jpeg(1080, 1350))], { caption: '' });
        expect(one.check.errors.join()).toMatch(/2/);
        const plan = await planCarousel([file('c1.jpg', jpeg(1080, 1350)), file('c2.jpg', jpeg(1080, 1350))], { caption: 'x' });
        const d = describePlan(plan) as any;
        const configure = d.requests.find((r: any) => String(r.url).includes('configure_sidecar'));
        const ids = configure.body.children_metadata.map((c: any) => c.upload_id);
        expect(ids).toHaveLength(2);
        expect(Number(ids[1])).toBeGreaterThan(Number(ids[0]));
    });

    test.skipIf(!hasFfmpeg)('reel plan rejects a 2 s clip and accepts 4 s', async () => {
        const short = await planReel(ffmpegVideo('short.mp4', '1080x1920', 2), { caption: '' });
        expect(short.check.errors.join()).toContain('outside 3s');
        const ok = await planReel(ffmpegVideo('ok.mp4', '1080x1920', 4), { caption: '' });
        expect(ok.check.errors).toEqual([]);
    });

    test('only writes proven on a real account skip --experimental', () => {
        expect(CONTRACTS.editCaption).not.toBe('verified-live');
        expect('delete' in CONTRACTS).toBe(false);
        expect(Object.entries(CONTRACTS).filter(([, v]) => v === 'verified-live').map(([k]) => k).sort()).toEqual(['carousel', 'comment', 'photo', 'reel', 'story']);
    });
});

// ---------------------------------------------------------------- pending ledger

describe('pending ledger', () => {
    const realFetch = globalThis.fetch;
    afterEach(() => {
        globalThis.fetch = realFetch;
    });

    test('an unresolved publish blocks the next one without any request', async () => {
        const op = await beginPending({ id: 'u1', kind: 'photo', caption: 'x', uploadIds: ['u1'] });
        expect((await listPending()).map((o) => o.id)).toContain(op.id);
        let called = 0;
        globalThis.fetch = (async () => {
            called++;
            return new Response('{}');
        }) as unknown as typeof fetch;
        const c = await IgClient.create({ cookies: { ...FAKE } });
        const plan = await planPhoto(file('p.jpg', jpeg(1080, 1350)), { caption: 'x' });
        await expect(executePlan(c, plan)).rejects.toThrow(/without a clear answer/);
        expect(called).toBe(0);
        expect(await clearPending('u1')).toBe(true);
        expect(await listPending()).toEqual([]);
    });

    test('the publish lock is exclusive, ignores exited owners, and unlock spares live claims', async () => {
        const { acquirePublishLock, unlockStale } = await import('../../skills/instagram/scripts/pending.ts');
        const { writeFileSync: w, readdirSync } = await import('node:fs');
        const d = path.join(process.env.INSTAGRAM_DATA_DIR!, 'pending');
        const release = await acquirePublishLock();
        await expect(acquirePublishLock()).rejects.toThrow(/in progress/);
        // A failed attempt withdraws its own claim: only the holder's file is left.
        expect(readdirSync(d).filter((n) => n.endsWith('.lock'))).toHaveLength(1);
        expect((await unlockStale()).removed).toEqual([]);
        await release();
        w(path.join(d, 'publish-dead.lock'), JSON.stringify({ pid: 999999, startedAt: 'x' }));
        const r2 = await acquirePublishLock(); // exited owner does not block
        await r2();
        w(path.join(d, 'publish-live.lock'), JSON.stringify({ pid: process.pid, startedAt: 'x' }));
        w(path.join(d, 'publish-unreadable.lock'), '{');
        const u = await unlockStale();
        expect(u.removed).toEqual(['publish-dead.lock']);
        expect(u.live).toBe(2);
        await expect(acquirePublishLock()).rejects.toThrow(/in progress/);
        const { rmSync } = await import('node:fs');
        rmSync(path.join(d, 'publish-live.lock'));
        rmSync(path.join(d, 'publish-unreadable.lock'));
    });

    test('--confirm=false is not a confirmation, and junk values are refused', () => {
        expect(parseArgs(['comment', '1', '--confirm=false', '--experimental=0']).flags).toEqual({});
        expect(parseArgs(['--confirm=true']).flags.confirm).toBe(true);
        expect(() => parseArgs(['--confirm=yes please'])).toThrow(/switch/);
    });

    test('a 404 challenge page stops instead of falling through', async () => {
        const urls: string[] = [];
        globalThis.fetch = (async (u: URL) => {
            urls.push(String(u));
            return new Response('<a href="/challenge/9/">x</a>', { status: 404 });
        }) as unknown as typeof fetch;
        const c = await IgClient.create({ cookies: { ...FAKE } });
        await expect(
            c.tryEach('op', [
                { name: 'a', method: 'GET', url: 'https://www.instagram.com/api/v1/a/', parse: (d: any) => d },
                { name: 'b', method: 'GET', url: 'https://www.instagram.com/api/v1/b/', parse: (d: any) => d },
            ]),
        ).rejects.toMatchObject({ kind: 'checkpoint' });
        expect(urls).toHaveLength(1);
    });

    test('a 403 challenge page and a 200 login page stop HTML fetches', async () => {
        const c = await IgClient.create({ cookies: { ...FAKE } });
        globalThis.fetch = (async () => new Response('<a href="/challenge/1/">x</a>', { status: 403 })) as unknown as typeof fetch;
        await expect(c.request('GET', 'https://www.instagram.com/x/', { expectJson: false })).rejects.toMatchObject({ kind: 'checkpoint' });
        globalThis.fetch = (async () => new Response('<form id="loginForm"></form>')) as unknown as typeof fetch;
        await expect(c.request('GET', 'https://www.instagram.com/x/', { expectJson: false })).rejects.toMatchObject({ kind: 'not_logged_in' });
        globalThis.fetch = (async () => new Response('<html>ok, see /challenge/ route list</html>')) as unknown as typeof fetch;
        expect(await c.request('GET', 'https://www.instagram.com/x/', { expectJson: false })).toContain('ok');
    });

    test('descendantsOnlyInherit flags an explicit grant on a child', async () => {
        const { descendantsOnlyInherit } = await import('../../skills/instagram/scripts/secure.ts');
        const ok = ['C:\p D\me:(OI)(CI)(F)', '', 'C:\p\a D\me:(I)(F)', '', 'Successfully processed 2 files'].join('\n');
        const bad = ['C:\p D\me:(OI)(CI)(F)', '', 'C:\p\a D\me:(I)(F)', '             Everyone:(R)', ''].join('\n');
        expect(descendantsOnlyInherit(ok)).toBe(true);
        expect(descendantsOnlyInherit(bad)).toBe(false);
    });

    test('a GraphQL challenge stops pagination even with partial data', async () => {
        const { GraphQL } = await import('../../skills/instagram/scripts/graphql.ts');
        let calls = 0;
        globalThis.fetch = (async () => {
            calls++;
            return new Response(JSON.stringify({ data: { x: 1 }, errors: [{ message: 'challenge_required' }] }));
        }) as unknown as typeof fetch;
        const c = await IgClient.create({ cookies: { ...FAKE } });
        const g = new GraphQL(c) as any;
        g.docIds = { Q: '1' };
        g.tokens = { fbDtsg: 'D', lsd: 'L' };
        await expect(g.query('Q', {})).rejects.toMatchObject({ kind: 'checkpoint' });
        expect(calls).toBe(1);
    });

    test('an HTML page fetch that is a challenge page is a checkpoint', async () => {
        globalThis.fetch = (async () => new Response('<html>"challenge_required"</html>')) as unknown as typeof fetch;
        const c = await IgClient.create({ cookies: { ...FAKE } });
        await expect(c.request('GET', 'https://www.instagram.com/x/', { expectJson: false })).rejects.toMatchObject({ kind: 'checkpoint' });
    });

    test('a corrupt pending record still blocks publishing', async () => {
        const { mkdirSync, writeFileSync: w, rmSync } = await import('node:fs');
        const d = path.join(process.env.INSTAGRAM_DATA_DIR!, 'pending');
        mkdirSync(d, { recursive: true });
        w(path.join(d, 'broken.json'), '{not json');
        const pend = await listPending();
        expect(pend.map((p) => p.id)).toContain('broken');
        rmSync(path.join(d, 'broken.json'));
    });

    test('an ambiguous configure failure is recorded and not retried', async () => {
        const calls: string[] = [];
        globalThis.fetch = (async (u: URL) => {
            calls.push(new URL(String(u)).pathname);
            if (String(u).includes('rupload')) return new Response('{"status":"ok","upload_id":"1"}');
            return new Response('<html>oops</html>', { status: 502 });
        }) as unknown as typeof fetch;
        const c = await IgClient.create({ cookies: { ...FAKE } });
        const plan = await planPhoto(file('q.jpg', jpeg(1080, 1350)), { caption: 'amb' });
        const err = await executePlan(c, plan).catch((e) => e);
        expect(String(err?.message)).toContain('without a clear answer');
        expect(calls.filter((p) => p.includes('configure'))).toHaveLength(1);
        const pend = await listPending();
        expect(pend).toHaveLength(1);
        expect(pend[0].state).toBe('unresolved');
        await clearPending(pend[0].id);
    });

    test('an HTML challenge page (200/403/404) during configure stays pending', async () => {
        for (const status of [200, 403, 404]) {
            globalThis.fetch = (async (u: URL) => {
                if (String(u).includes('rupload')) return new Response('{"status":"ok","upload_id":"1"}');
                return new Response('<html>challenge_required</html>', { status });
            }) as unknown as typeof fetch;
            const c = await IgClient.create({ cookies: { ...FAKE } });
            const plan = await planPhoto(file(`h${status}.jpg`, jpeg(1080, 1350)), { caption: `h${status}` });
            await expect(executePlan(c, plan)).rejects.toThrow(/without a clear answer/);
            const pend = await listPending();
            expect(pend).toHaveLength(1);
            await clearPending(pend[0].id);
        }
    });

    test.skipIf(!hasFfmpeg)('a 5xx "in progress" answer is not retried and stays pending', async () => {
        let configures = 0;
        globalThis.fetch = (async (u: URL) => {
            if (String(u).includes('rupload')) return new Response('{"status":"ok","upload_id":"1"}');
            configures++;
            return configures === 1 ? new Response('{"status":"in_progress"}', { status: 502 }) : new Response('{"media":{"pk":"1","code":"C"}}');
        }) as unknown as typeof fetch;
        const c = await IgClient.create({ cookies: { ...FAKE } });
        const plan = await planReel(ffmpegVideo('t5.mp4', '1080x1920', 4), { caption: 't5', noCover: true } as any);
        await expect(executePlan(c, plan)).rejects.toThrow(/without a clear answer/);
        expect(configures).toBe(1);
        const pend = await listPending();
        expect(pend).toHaveLength(1);
        await clearPending(pend[0].id);
    });

    test('an HTML feedback or wait page stops instead of falling through', async () => {
        for (const [html, kind] of [['<html>feedback_required</html>', 'feedback_required'], ['<html>Please wait a few minutes before you try again.</html>', 'rate_limited']] as const) {
            const urls: string[] = [];
            globalThis.fetch = (async (u: URL) => {
                urls.push(String(u));
                return new Response(html);
            }) as unknown as typeof fetch;
            const c = await IgClient.create({ cookies: { ...FAKE } });
            await expect(
                c.tryEach('op', [
                    { name: 'a', method: 'GET', url: 'https://www.instagram.com/api/v1/a/', parse: (d: any) => d },
                    { name: 'b', method: 'GET', url: 'https://www.instagram.com/api/v1/b/', parse: (d: any) => d },
                ]),
            ).rejects.toMatchObject({ kind });
            expect(urls).toHaveLength(1);
        }
    });

    test('a 502 challenge page during configure stays pending', async () => {
        globalThis.fetch = (async (u: URL) => {
            if (String(u).includes('rupload')) return new Response('{"status":"ok","upload_id":"1"}');
            return new Response('<html>challenge_required</html>', { status: 502 });
        }) as unknown as typeof fetch;
        const c = await IgClient.create({ cookies: { ...FAKE } });
        const plan = await planPhoto(file('r.jpg', jpeg(1080, 1350)), { caption: 'amb2' });
        await expect(executePlan(c, plan)).rejects.toThrow(/without a clear answer/);
        const pend = await listPending();
        expect(pend).toHaveLength(1);
        await clearPending(pend[0].id);
    });
});

// ---------------------------------------------------------------- normalize + analytics

describe('pagination bounds', () => {
    test('an empty page or a repeated cursor stops paging', async () => {
        const { getPosts } = await import('../../skills/instagram/scripts/read.ts');
        let calls = 0;
        globalThis.fetch = (async () => {
            calls++;
            return new Response(JSON.stringify({ items: calls === 1 ? [{ pk: '1', code: 'A', taken_at: 1, media_type: 1 }] : [], more_available: true, next_max_id: 'same' }));
        }) as unknown as typeof fetch;
        const c = await IgClient.create({ cookies: { ...FAKE } });
        await getPosts(c, null, 6).catch(() => undefined);
        expect(calls).toBeLessThanOrEqual(3);
    });

    test('Pager caps pages and rejects repeated cursors', async () => {
        const { Pager } = await import('../../skills/instagram/scripts/read.ts');
        const p = new Pager(24, 12);
        expect(p.next(12, 'a')).toBe(true);
        expect(p.next(12, 'a')).toBe(false);
        const q = new Pager(12, 12);
        expect(q.next(12, 'a')).toBe(true);
        expect(q.next(12, 'b')).toBe(true);
        expect(q.next(12, 'c')).toBe(false); // ceil(12/12)+2 = 3 pages max
        expect(new Pager(50, 12).next(0, 'x')).toBe(false);
    });
});

describe('normalize and analytics', () => {
    test('v1 reel item and hidden likes', () => {
        const p = normalizePost({ pk: '3456', code: 'DAbc123xyz0', media_type: 2, product_type: 'clips', taken_at: 1790000000, like_count: 0, like_and_view_counts_disabled: true, comment_count: 4, play_count: 900, caption: { text: 'Hi #x' }, user: { username: 'me' } });
        expect(p).toMatchObject({ format: 'reel', likes: null, comments: 4, plays: 900, owner: 'me', hashtags: ['x'] });
        expect(p.url).toContain('/reel/');
        expect(engagement(p)).toBeNull(); // hidden likes are excluded, not counted as comments only
    });
    test('legacy GraphQL node', () => {
        const p = normalizePost({ node: { __typename: 'GraphSidecar', id: '9', shortcode: 'B', edge_liked_by: { count: 5 }, edge_media_to_comment: { count: 1 }, edge_media_to_caption: { edges: [{ node: { text: 'c' } }] }, taken_at_timestamp: 1790000000 } });
        expect(p).toMatchObject({ format: 'carousel', likes: 5, comments: 1, caption: 'c' });
    });
    test('profile from web_profile_info shape', () => {
        const pr = normalizeProfile({ data: { user: { username: 'me', full_name: 'Me', biography: 'bio', edge_followed_by: { count: 1000 }, edge_follow: { count: 10 }, edge_owner_to_timeline_media: { count: 3, edges: [] } } } });
        expect(pr).toMatchObject({ username: 'me', followers: 1000 });
    });
    test('median, buckets with n, outliers', () => {
        expect(median([3, 1, 2])).toBe(2);
        expect(median([])).toBeNull();
        const profile = { username: 'me', followers: 1000, following: 1, mediaCount: 5, biography: '', externalUrl: null, bioLinks: [], isBusiness: true, category: null } as unknown as Profile;
        const posts = [post({ shortcode: 'a', likes: 100 }), post({ shortcode: 'b', likes: 110 }), post({ shortcode: 'c', likes: 90 }), post({ shortcode: 'd', likes: 1000, format: 'reel' }), post({ shortcode: 'e', likes: 10, likes2: 0 } as any)];
        const a = audit(profile, posts, { source: 'test', timeZone: 'UTC' });
        expect(a.sample.posts).toBe(5);
        expect(a.outliers.map((p) => p.shortcode)).toContain('d');
        expect(a.underperformers.map((p) => p.shortcode)).toContain('e');
        const reel = a.byFormat.find((b) => b.key === 'reel')!;
        expect(reel.n).toBe(1);
        expect(reel.note).toContain('insufficient data');
        expect(a.missing.length).toBeGreaterThan(0);
        const s = swipeFile([{ username: 'me', posts }], 3);
        expect(s.map((x) => x.shortcode)).toEqual(['d']);
    });
});

// ---------------------------------------------------------------- CLI end to end, no network

describe('CLI (subprocess, network trapped)', () => {
    const run = (args: string[], env: Record<string, string> = {}) =>
        spawnSync(process.execPath, ['--preload', TRAP, MAIN, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });

    test('dry run makes zero network requests', () => {
        const r = run(['post', 'photo', file('dry.jpg', jpeg(1080, 1350)), '--caption', 'hello', '--json']);
        expect(r.stderr).not.toContain('FETCH_TRAP');
        expect(r.status).toBe(0);
        expect(JSON.parse(r.stdout).data.dryRun).toBe(true);
    });

    test('invalid dry run exits 1, still with zero requests', () => {
        const r = run(['post', 'photo', file('bad.jpg', jpeg(2000, 500)), '--json']);
        expect(r.stderr).not.toContain('FETCH_TRAP');
        expect(r.status).toBe(1);
    });

    test('an unverified write (edit-caption) is refused without --experimental', () => {
        const r = run(['edit-caption', 'DAbc123xyz0', '--caption', 'hi', '--confirm', '--account', 'me', '--json'], { INSTAGRAM_COOKIES: 'sessionid=S1; csrftoken=C1; ds_user_id=42' });
        expect(r.stderr).not.toContain('FETCH_TRAP');
        expect(r.status).toBe(1);
        expect(JSON.parse(r.stdout).error.message).toContain('--experimental');
    });

    test('there is no delete command, and asking for one sends nothing', () => {
        const r = run(['delete', 'DAbc123xyz0', '--confirm', '--json'], { INSTAGRAM_COOKIES: 'sessionid=S1; csrftoken=C1; ds_user_id=42' });
        expect(r.stderr).not.toContain('FETCH_TRAP');
        expect(r.status).toBe(1);
        expect(JSON.parse(r.stdout).error.message).toContain('Unknown command');
    });

    test('status never prints cookie values', () => {
        const r = run(['status', '--json'], { INSTAGRAM_COOKIES: 'sessionid=SECRETVALUE123; csrftoken=C1; ds_user_id=42' });
        expect(r.stdout).not.toContain('SECRETVALUE123');
    });
});

test('IgError carries a hint for every kind', () => {
    for (const k of ['not_logged_in', 'checkpoint', 'rate_limited', 'feedback_required', 'not_found', 'server_error'] as const) {
        expect(new IgError(k, 'x').hint).toBeTruthy();
    }
});
