// instagram skill: the comet async request shape (comet.ts). Pure functions and fake tokens only.
import { describe, expect, test } from 'bun:test';
import { cometForm, cometHeaders, cometParams, cometSignal, decodeComet, extractWebContext, newWebSessionId, numericToken, readDefine, redactComet } from '../../skills/instagram/scripts/comet.ts';
import { mediaPk, readConfigureAnswer, usesComet } from '../../skills/instagram/scripts/publish.ts';
import { safeLocation, safeServerText } from '../../skills/instagram/scripts/client.ts';

const def = (name: string, obj: unknown, id = 1) => `["${name}",[],${JSON.stringify(obj)},${id}]`;
const PAGE = (over: Record<string, unknown> = {}) => {
    const d: Record<string, unknown> = {
        DTSGInitialData: { token: 'FAKE_dtsg:1:2' },
        LSD: { token: 'FAKElsd' },
        SprinkleConfig: { param_name: 'jazoest', version: 2, should_randomize: false },
        CurrentUserInitialData: { USER_ID: '0', NAME: '' },
        SiteData: { client_revision: 1054385069, haste_session: '20000.HYP:x.2.1...0', hsi: '7707496000000000001', comet_env: 7, wbloks_env: false, spin: 4, __spin_r: 1054385069, __spin_b: 'trunk', __spin_t: 1794544555, pr: 1, nested: { a: '}"{' } },
        InstagramWebPushInfo: { rollout_hash: '1054385069' },
        ...over,
    };
    const parts = Object.entries(d).filter(([, v]) => v !== undefined).map(([k, v], i) => def(k, v, i + 10));
    return `<html><script>requireLazy([${parts.join(',')}]);{"gkxData":{"28588":{"result":false,"hash":null},"18382":{"result":true,"hash":null}}}</script></html>`;
};

describe('comet: page context', () => {
    test('reads server definitions by balanced braces, including braces inside strings', () => {
        const html = PAGE();
        expect(readDefine(html, 'LSD')).toEqual({ token: 'FAKElsd' });
        expect(readDefine(html, 'SiteData')!.nested).toEqual({ a: '}"{' });
        expect(readDefine(html, 'Nope')).toBeNull();
        expect(readDefine('["LSD",[],{"token":"x"', 'LSD')).toBeNull();
    });
    test('extracts every field and both gates', () => {
        const c = extractWebContext(PAGE(), 5);
        expect(c).toMatchObject({ fetchedAt: 5, fbDtsg: 'FAKE_dtsg:1:2', lsd: 'FAKElsd', sprinkleParam: 'jazoest', sprinkleVersion: 2, user: '0', cometEnv: 7, clientRevision: '1054385069', hsi: '7707496000000000001', rolloutHash: '1054385069' });
        expect(c.spin).toEqual({ r: '1054385069', b: 'trunk', t: '1794544555' });
        expect(c.gates).toEqual({ storyComet: false, sidecarComet: true });
    });
    test('fails closed and names what is missing', () => {
        expect(() => extractWebContext('<html></html>')).toThrow(/DTSGInitialData.token.*LSD.token.*SiteData/);
        expect(() => extractWebContext(PAGE({ LSD: { token: '' } }))).toThrow(/LSD.token/);
        expect(() => extractWebContext(PAGE({ InstagramWebPushInfo: undefined }))).toThrow(/rollout_hash/);
    });
    test('unknown gates are null, not false', () => {
        const c = extractWebContext(PAGE().replace(/"28588"/, '"99999"'));
        expect(c.gates.storyComet).toBeNull();
    });
});

describe('comet: request', () => {
    const ctx = extractWebContext(PAGE(), 0);
    test('numeric token: sum of code units, prefixed with the version unless randomized', () => {
        expect(numericToken('AB', 2, false)).toBe('2131');
        expect(numericToken('AB', 2, true)).toBe('131');
        expect(numericToken('', 2, false)).toBe('20');
    });
    test('session id has three six-character base36 parts', () => {
        expect(newWebSessionId()).toMatch(/^[0-9a-z]{6}:[0-9a-z]{6}:[0-9a-z]{6}$/);
        expect(newWebSessionId(() => 0)).toBe('000000:000000:000000');
    });
    test('parameters follow the web client and leave out browser-state fields', () => {
        const p = cometParams(ctx, 37, 'aaaaaa:bbbbbb:cccccc');
        expect(p).toMatchObject({ __d: 'www', __user: '0', __a: '1', __req: '11', __comet_req: '7', __rev: '1054385069', fb_dtsg: 'FAKE_dtsg:1:2', lsd: 'FAKElsd', __spin_b: 'trunk' });
        expect(p.jazoest).toBe(numericToken('FAKE_dtsg:1:2', 2, false));
        for (const k of ['__dyn', '__csr', '__hsdp', '__hblp', '__sjsp', 'dpr', '__ccg', '__crn', 'qpl_active_flow_ids']) expect(p[k]).toBeUndefined();
    });
    test('form: fields as strings, signed_body over exactly the publish fields, then the context', () => {
        const fields = { caption: 'hi', upload_id: '1', is_gen_ai_self_disclosure: true, skip: undefined };
        const f = cometForm(fields, ctx, 1, 's');
        expect(f.is_gen_ai_self_disclosure).toBe('true');
        expect('skip' in f).toBe(false);
        expect(f.signed_body).toBe('SIGNATURE.' + JSON.stringify({ caption: 'hi', upload_id: '1', is_gen_ai_self_disclosure: true }));
        expect(JSON.parse(f.signed_body.slice(10))).not.toHaveProperty('fb_dtsg');
        expect(f.__req).toBe('1');
        expect(cometHeaders(ctx, 's')).toEqual({ 'X-FB-LSD': 'FAKElsd', 'X-IG-D': 'www', 'X-Instagram-AJAX': '1054385069', 'X-Web-Session-ID': 's' });
    });
    test('redaction hides every secret value', () => {
        const shown = JSON.stringify(redactComet(cometForm({ caption: 'hi' }, ctx, 1, 'sess:id:x')));
        for (const secret of ['FAKE_dtsg', 'FAKElsd', '7707496000000000001', 'sess:id:x', '20000.HYP']) expect(shown).not.toContain(secret);
        expect(shown).toContain('"caption":"hi"');
    });
});

describe('comet: answers', () => {
    test('empty, garbage and plain JSON are never success', () => {
        expect(decodeComet('').kind).toBe('empty');
        expect(decodeComet('  \n').kind).toBe('empty');
        expect(decodeComet('<html>login</html>').kind).toBe('not_envelope');
        expect(decodeComet('{"media":{"pk":"1"}}').kind).toBe('not_envelope');
        expect(decodeComet('for (;;);{"__ar":1}').kind).toBe('not_envelope');
    });
    test('processing, success and error envelopes', () => {
        const pending = decodeComet('for (;;);{"__ar":1,"rid":"x","payload":{"statusCode":202},"lid":"1"}');
        expect(pending).toMatchObject({ kind: 'payload', statusCode: 202 });
        const done = decodeComet('for(;;);{"__ar":1,"payload":{"media":{"pk":"3900000000000000001","code":"Dfq"},"status":"ok"},"dtsgToken":"NEW_SECRET"}');
        expect(done.kind).toBe('payload');
        if (done.kind === 'payload') {
            expect(done.payload.media.pk).toBe('3900000000000000001');
            expect(done.summary).not.toContain('NEW_SECRET');
        }
        const err = decodeComet('for (;;);{"__ar":1,"error":1357001,"errorSummary":"Not Logged In SECRET_A","errorDescription":{"__html":"Please log in to continue."}}');
        expect(err).toMatchObject({ kind: 'error', code: '1357001', signal: 'not_logged_in', summary: 'envelope error 1357001' });
        expect(JSON.stringify(err)).not.toContain('SECRET_A');
    });
    test('nothing the server wrote is copied into a summary; only known field names and statuses', () => {
        const a = decodeComet('for (;;);{"__ar":1,"payload":{"statusCode":400,"status":"SECRET_B","message":"SECRET_C","SECRET_KEY":1}}');
        expect(JSON.stringify({ ...a, payload: undefined })).not.toMatch(/SECRET_/);
        if (a.kind === 'payload') expect(a.summary).toBe('payload fields: statusCode,status,message (+1 other); statusCode 400');
    });
    test('media ids above 2^53 survive parsing as strings', () => {
        const a = decodeComet('for (;;);{"__ar":1,"payload":{"media":{"pk":3900000000000000001,"id":"3900000000000000001_869"}}}');
        if (a.kind === 'payload') expect(a.payload.media.pk).toBe('3900000000000000001');
    });
    test('account signals: flags, redirects and words, at any depth', () => {
        expect(cometSignal({ require_login: true })).toBe('not_logged_in');
        expect(cometSignal({ checkpoint_url: '/challenge/x/' })).toBe('checkpoint');
        expect(cometSignal({ medias: [{ status: 'ERROR', error_info: { error_type: 'feedback_required' } }] })).toBe('feedback_required');
        expect(cometSignal('/accounts/login/?next=x')).toBe('not_logged_in');
        expect(cometSignal({ message: 'Please wait a few minutes before you try again.' })).toBe('rate_limited');
        expect(cometSignal({ statusCode: 202 }, { media: { pk: '1' } })).toBeNull();
    });
    test('media identity is validated', () => {
        expect(mediaPk({ pk: '3900000000000000001' })).toBe('3900000000000000001');
        expect(mediaPk({ id: '3900000000000000001_4242' })).toBe('3900000000000000001');
        for (const bad of [{ pk: '0' }, { pk: '0_1' }, { pk: ' 12345 ' }, { pk: '-12345' }, { pk: {} }, { pk: 3900000000000000001 }, { pk: 1.5 }, {}, null]) expect(mediaPk(bad)).toBe('');
        expect(mediaPk({ pk: 3900000000000000001, id: '3900000000000000001_869' })).toBe('3900000000000000001');
        expect(readConfigureAnswer({ media: { pk: '0_1' } }).state).toBe('empty');
        expect(readConfigureAnswer({ status: 'fail', media: { pk: '3900000000000000001' } }).state).toBe('error');
    });
    test('redirect targets become fixed labels; nothing from the header is repeated', () => {
        expect(safeLocation('https://user:pw@www.instagram.com/accounts/login/?next=%2F&t=SECRET#frag')).toBe('the login page');
        expect(safeLocation('/challenge/SECRET_SENTINEL/?x=1')).toBe('a security check page');
        expect(safeLocation('/redirect/SECRET_SENTINEL')).toBe('another instagram.com page');
        expect(safeLocation('https://evil.example/SECRET_SENTINEL')).toBe('another site');
    });
    test('a server sentence is kept, values inside it are not', () => {
        expect(safeServerText('Media not found or unavailable')).toBe('Media not found or unavailable');
        expect(safeServerText('bad token NAcO9zT3_SECRETSECRETSECRET:12:1794540000 for user 869070800123')).toBe('bad token <redacted> for user <number>');
        expect(safeServerText('see https://x.example/a?t=SECRET now\nline2')).toBe('see <url> now line2');
        expect(safeServerText({ a: 1 })).toBe('');
        expect(safeServerText('x'.repeat(10) + ' ' + 'word '.repeat(60)).length).toBeLessThanOrEqual(160);
    });
    test('flags beside the payload are signals; ordinary sentences are not', () => {
        const a = decodeComet('for (;;);{"__ar":1,"require_login":true,"payload":{"statusCode":202}}');
        expect(a).toMatchObject({ kind: 'payload', signal: 'not_logged_in' });
        expect(decodeComet('for (;;);{"__ar":1,"lock":true,"payload":{"media":{"pk":"12345"}}}')).toMatchObject({ signal: 'checkpoint' });
        expect(decodeComet('for (;;);{"__ar":1,"payload":{"feedback_required":true}}')).toMatchObject({ signal: 'feedback_required' });
        expect(cometSignal({ media: { pk: '1' }, message: 'checkpoint completed, try again later if needed; please log in elsewhere' })).toBeNull();
        expect(decodeComet('for (;;);{"__ar":1,"payload":{"statusCode":202,"challenge":{"url":"/challenge/123/"}}}')).toMatchObject({ signal: 'checkpoint' });
        expect(decodeComet('for (;;);{"__ar":1,"payload":{"media":{"pk":"12345"},"challenge":{"lock":false}}}')).toMatchObject({ signal: 'checkpoint' });
        expect(decodeComet('for (;;);{"__ar":1,"feedback_title":null,"payload":{"media":{"pk":"12345"}}}')).toMatchObject({ signal: null });
        expect(decodeComet('for (;;);{"__ar":1,"payload":{"checkpoint_url":"","challenge":null,"spam":false,"media":{"pk":"12345"}}}')).toMatchObject({ signal: null });
    });
    test('every account signal the plain-form classifier knows is also a comet signal', async () => {
        const { classifyBody } = await import('../../skills/instagram/scripts/client.ts');
        const bodies: any[] = [
            { message: 'Please wait a few minutes before you try again.' },
            { error_type: 'rate_limit_error' },
            { message: 'login_required' },
            { error_type: 'login_required' },
            { require_login: true },
            { message: 'checkpoint_required' },
            { message: 'challenge_required' },
            { checkpoint_url: '/x/' },
            { challenge: { url: '/challenge/1/' } },
            { message: 'feedback_required' },
            { feedback_required: true },
            { spam: true },
        ];
        for (const b of bodies) {
            const legacy = classifyBody(200, b);
            expect(['rate_limited', 'not_logged_in', 'checkpoint', 'feedback_required']).toContain(legacy as string);
            expect(cometSignal({ __ar: 1, payload: { statusCode: 202, ...b } })).toBe(legacy as any);
        }
    });
});

describe('comet: which publishes use it', () => {
    const gates = (g: { storyComet: boolean | null; sidecarComet: boolean | null } | null) => ({ webGates: () => g });
    test('reels always; stories and carousels only when the gate is on; photos never', () => {
        expect(usesComet({ kind: 'reel' }, gates(null))).toBe(true);
        expect(usesComet({ kind: 'story' }, gates({ storyComet: false, sidecarComet: false }))).toBe(false);
        expect(usesComet({ kind: 'story' }, gates({ storyComet: true, sidecarComet: false }))).toBe(true);
        expect(usesComet({ kind: 'story' }, gates({ storyComet: null, sidecarComet: null }))).toBe(false);
        // The carousel variant is not implemented: never selected here, and refused before upload when the gate is on.
        expect(usesComet({ kind: 'carousel' }, gates({ storyComet: false, sidecarComet: true }))).toBe(false);
        expect(usesComet({ kind: 'photo' }, gates({ storyComet: true, sidecarComet: true }))).toBe(false);
    });
});

// ---------------------------------------------------------------- the reel publish step against a fake server
import { afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DATA = mkdtempSync(path.join(os.tmpdir(), 'ig-comet-'));
process.env.INSTAGRAM_DATA_DIR = DATA;
const { IgClient } = await import('../../skills/instagram/scripts/client.ts');
const { executePlan } = await import('../../skills/instagram/scripts/publish.ts');
const { listPending, clearPending } = await import('../../skills/instagram/scripts/pending.ts');
const FAKE = { sessionid: 's', csrftoken: 'c', ds_user_id: '1' };

/** A minimal reel plan: one "video" item whose upload the fake server accepts. */
function reelPlan(id: string): any {
    const f = path.join(DATA, `${id}.mp4`);
    writeFileSync(f, 'x');
    return {
        kind: 'reel',
        contract: 'observed-in-bundle',
        caption: 'c',
        items: [{ label: `${id}.mp4`, file: f, facts: { kind: 'video', path: f, bytes: 1, width: 1080, height: 1920, durationMs: 4000, mime: 'video/mp4' }, uploadId: id, cover: null }],
        configure: { url: 'https://www.instagram.com/api/v1/media/configure_to_clips/', encoding: 'form', body: { caption: 'c', upload_id: id, is_gen_ai_self_disclosure: true } },
        check: { errors: [], warnings: [] },
    };
}

describe('comet: reel publish against a fake server', () => {
    const realFetch = globalThis.fetch;
    const realTimeout = globalThis.setTimeout;
    afterEach(() => {
        globalThis.fetch = realFetch;
        globalThis.setTimeout = realTimeout;
    });
    const server = (answers: Array<() => Response>, seen: Array<{ url: string; body: string; headers: Record<string, string> }>, home = PAGE()) =>
        (async (u: URL, init?: RequestInit) => {
            const url = new URL(String(u));
            if ((init?.method ?? 'GET') === 'GET' && url.pathname === '/') return new Response(home);
            if (url.pathname.includes('rupload')) return new Response('{"status":"ok","upload_id":"1"}');
            seen.push({ url: url.pathname, body: String(init?.body ?? ''), headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)) });
            return (answers.shift() ?? (() => new Response('')))();
        }) as unknown as typeof fetch;
    const fastTimers = () => {
        globalThis.setTimeout = ((fn: () => void) => realTimeout(fn, 0)) as unknown as typeof setTimeout;
    };

    test('"still processing" twice, then the media: same fields and upload id each time, tokens sent, success returned', async () => {
        const seen: any[] = [];
        const pending = () => new Response('for (;;);{"__ar":1,"payload":{"statusCode":202}}');
        globalThis.fetch = server([pending, pending, () => new Response('for (;;);{"__ar":1,"payload":{"media":{"pk":"3900000000000000001","code":"Dfq","user":{"username":"me"}},"status":"ok"}}')], seen);
        fastTimers();
        const c = await IgClient.create({ cookies: { ...FAKE } });
        const r: any = await executePlan(c, reelPlan('r1'));
        expect(r.pk).toBe('3900000000000000001');
        expect(seen).toHaveLength(3);
        const forms = seen.map((s) => new URLSearchParams(s.body));
        for (const f of forms) {
            expect(f.get('upload_id')).toBe('r1');
            expect(f.get('signed_body')).toBe(forms[0].get('signed_body'));
            expect(f.get('fb_dtsg')).toBe('FAKE_dtsg:1:2');
            expect(f.get('lsd')).toBe('FAKElsd');
            expect(f.get('__a')).toBe('1');
            expect(f.get('__comet_req')).toBe('7');
        }
        expect(forms.map((f) => f.get('__req'))).toEqual(['1', '2', '3']);
        expect(JSON.parse(forms[0].get('signed_body')!.slice(10))).toEqual({ caption: 'c', upload_id: 'r1', is_gen_ai_self_disclosure: true });
        expect(seen[0].headers['X-FB-LSD']).toBe('FAKElsd');
        expect(seen[0].headers['X-Instagram-AJAX']).toBe('1054385069');
        expect(await listPending()).toEqual([]);
    });

    test('HTTP 200 with an empty body is never success and never retried; it stays unresolved with its evidence', async () => {
        const seen: any[] = [];
        globalThis.fetch = server([() => new Response('')], seen);
        fastTimers();
        const c = await IgClient.create({ cookies: { ...FAKE } });
        await expect(executePlan(c, reelPlan('r2'))).rejects.toThrow(/without a clear answer.*empty body/);
        expect(seen).toHaveLength(1);
        const pend: any[] = await listPending();
        expect(pend).toHaveLength(1);
        expect(pend[0].attempts[0]).toMatchObject({ http: 200, bytes: 0, body: 'empty body' });
        await clearPending(pend[0].id);
    });

    test('an account signal inside a "still processing" payload stops at once', async () => {
        const seen: any[] = [];
        globalThis.fetch = server([() => new Response('for (;;);{"__ar":1,"payload":{"statusCode":202,"medias":[{"status":"ERROR","error_info":{"error_type":"login_required"}}]}}')], seen);
        fastTimers();
        const c = await IgClient.create({ cookies: { ...FAKE } });
        await expect(executePlan(c, reelPlan('r3'))).rejects.toMatchObject({ kind: 'not_logged_in' });
        expect(seen).toHaveLength(1);
        const pend: any[] = await listPending();
        expect(pend).toHaveLength(1);
        await clearPending(pend[0].id);
    });

    test('an envelope error is not success, is not retried, and nothing secret is stored', async () => {
        const seen: any[] = [];
        globalThis.fetch = server([() => new Response('for (;;);{"__ar":1,"error":1357004,"errorSummary":"Sorry","errorDescription":"Please try again","dtsgToken":"NEW_SECRET"}')], seen);
        fastTimers();
        const c = await IgClient.create({ cookies: { ...FAKE } });
        await expect(executePlan(c, reelPlan('r4'))).rejects.toThrow(/without a clear answer/);
        expect(seen).toHaveLength(1);
        const pend: any[] = await listPending();
        expect(JSON.stringify(pend)).not.toContain('NEW_SECRET');
        expect(JSON.stringify(pend)).not.toContain('FAKE_dtsg');
        for (const p of pend) await clearPending(p.id);
    });

    test('a page without the request context stops before anything is uploaded', async () => {
        const seen: any[] = [];
        let uploads = 0;
        const base = server([], seen, '<html>signed in, but no context</html>');
        globalThis.fetch = (async (u: URL, init?: RequestInit) => {
            if (String(u).includes('rupload')) uploads++;
            return base(u as any, init);
        }) as unknown as typeof fetch;
        const c = await IgClient.create({ cookies: { ...FAKE } });
        await expect(executePlan(c, reelPlan('r5'))).rejects.toThrow(/Cannot prepare the publish request/);
        expect(uploads).toBe(0);
        expect(seen).toHaveLength(0);
        expect(await listPending()).toEqual([]);
    });

    const cases: Array<[string, string]> = [
        ['a rejection that mentions "media not ready"', 'for (;;);{"__ar":1,"payload":{"statusCode":400,"status":"fail","message":"media not ready SECRET_D"}}'],
        ['a 500 inside the payload with an in-progress status', 'for (;;);{"__ar":1,"payload":{"statusCode":500,"status":"in_progress"}}'],
        ['a payload with neither media nor a status code', 'for (;;);{"__ar":1,"payload":{"status":"ok"}}'],
        ['a malformed media id', 'for (;;);{"__ar":1,"payload":{"media":{"pk":"0_1"},"status":"ok"}}'],
    ];
    for (const [name, body] of cases) {
        test(`${name}: one request, unresolved, nothing secret kept`, async () => {
            const seen: any[] = [];
            globalThis.fetch = server([() => new Response(body)], seen);
            fastTimers();
            const c = await IgClient.create({ cookies: { ...FAKE } });
            let message = '';
            await executePlan(c, reelPlan(`c${cases.findIndex((x) => x[0] === name)}`)).catch((e: Error) => (message = e.message));
            expect(message).toMatch(/without a clear answer|no usable media id/);
            expect(message).not.toMatch(/SECRET_|FAKE_dtsg|FAKElsd/);
            expect(seen).toHaveLength(1);
            const pend: any[] = await listPending();
            expect(pend).toHaveLength(1);
            expect(JSON.stringify(pend)).not.toMatch(/SECRET_|FAKE_dtsg|FAKElsd/);
            await clearPending(pend[0].id);
        });
    }

    test('"still processing" with media in the same answer is success, not another request', async () => {
        const seen: any[] = [];
        globalThis.fetch = server([() => new Response('for (;;);{"__ar":1,"payload":{"statusCode":202,"media":{"pk":"3900000000000000001","code":"Dfq"}}}')], seen);
        fastTimers();
        const c = await IgClient.create({ cookies: { ...FAKE } });
        const r: any = await executePlan(c, reelPlan('m1'));
        expect(r.pk).toBe('3900000000000000001');
        expect(seen).toHaveLength(1);
    });

    test('an account signal after "still processing" stops and stays unresolved', async () => {
        const seen: any[] = [];
        globalThis.fetch = server([() => new Response('for (;;);{"__ar":1,"payload":{"statusCode":202}}'), () => new Response('for (;;);{"__ar":1,"payload":{"require_login":true,"message":"login_required SECRET_E"}}')], seen);
        fastTimers();
        const c = await IgClient.create({ cookies: { ...FAKE } });
        let err: any;
        await executePlan(c, reelPlan('a1')).catch((e) => (err = e));
        expect(err.kind).toBe('not_logged_in');
        expect(err.message).not.toContain('SECRET_E');
        expect(seen).toHaveLength(2);
        const pend: any[] = await listPending();
        expect(pend).toHaveLength(1);
        expect(JSON.stringify(pend)).not.toContain('SECRET_E');
        await clearPending(pend[0].id);
    });

    test('"still processing" with a root media id is success, not another request', async () => {
        const seen: any[] = [];
        globalThis.fetch = server([() => new Response('for (;;);{"__ar":1,"payload":{"statusCode":202,"pk":"3900000000000000001","code":"Dfq"}}')], seen);
        fastTimers();
        const c = await IgClient.create({ cookies: { ...FAKE } });
        const r: any = await executePlan(c, reelPlan('m2'));
        expect(r.pk).toBe('3900000000000000001');
        expect(seen).toHaveLength(1);
    });

    test('a login flag beside a "still processing" payload stops at once and stays unresolved', async () => {
        const seen: any[] = [];
        globalThis.fetch = server([() => new Response('for (;;);{"__ar":1,"require_login":true,"payload":{"statusCode":202}}')], seen);
        fastTimers();
        const c = await IgClient.create({ cookies: { ...FAKE } });
        await expect(executePlan(c, reelPlan('a2'))).rejects.toMatchObject({ kind: 'not_logged_in' });
        expect(seen).toHaveLength(1);
        const pend: any[] = await listPending();
        expect(pend).toHaveLength(1);
        await clearPending(pend[0].id);
    });

    test('a redirect on the publish step repeats nothing from its Location, in the error, the ledger or the log', async () => {
        const seen: any[] = [];
        globalThis.fetch = server([() => new Response('', { status: 302, headers: { location: '/redirect/SECRET_SENTINEL?t=SECRET_Q' } })], seen);
        fastTimers();
        const c = await IgClient.create({ cookies: { ...FAKE } });
        let err: any;
        await executePlan(c, reelPlan('rd1')).catch((e) => (err = e));
        expect(`${err.message} ${err.hint ?? ''}`).not.toMatch(/SECRET_/);
        expect(seen).toHaveLength(1);
        const pend: any[] = await listPending();
        expect(pend).toHaveLength(1);
        expect(JSON.stringify(pend)).not.toMatch(/SECRET_/);
        const { readdirSync, readFileSync, statSync } = await import('node:fs');
        const walk = (d: string): string[] => readdirSync(d).flatMap((n) => (statSync(path.join(d, n)).isDirectory() ? walk(path.join(d, n)) : [path.join(d, n)]));
        for (const f of walk(DATA).filter((n) => /\.(jsonl?|log)$/.test(n))) expect(readFileSync(f, 'utf8')).not.toMatch(/SECRET_|FAKE_dtsg|FAKElsd/);
        await clearPending(pend[0].id);
    });

    test('a challenge object beside "still processing" stops at once and stays unresolved', async () => {
        const seen: any[] = [];
        globalThis.fetch = server([() => new Response('for (;;);{"__ar":1,"payload":{"statusCode":202,"challenge":{"url":"/challenge/123/"}}}')], seen);
        fastTimers();
        const c = await IgClient.create({ cookies: { ...FAKE } });
        await expect(executePlan(c, reelPlan('ch1'))).rejects.toMatchObject({ kind: 'checkpoint' });
        expect(seen).toHaveLength(1);
        const pend: any[] = await listPending();
        expect(pend).toHaveLength(1);
        await clearPending(pend[0].id);
    });

    test('media together with a challenge object is not reported as a clean success', async () => {
        const seen: any[] = [];
        globalThis.fetch = server([() => new Response('for (;;);{"__ar":1,"payload":{"media":{"pk":"3900000000000000001"},"challenge":{"url":"/challenge/1/"}}}')], seen);
        fastTimers();
        const c = await IgClient.create({ cookies: { ...FAKE } });
        await expect(executePlan(c, reelPlan('ch2'))).rejects.toMatchObject({ kind: 'checkpoint' });
        const pend: any[] = await listPending();
        expect(pend).toHaveLength(1);
        await clearPending(pend[0].id);
    });

    test('a plain-form failure never puts server-provided values in the error, the ledger or the log', async () => {
        const { planPhotoLike } = { planPhotoLike: null as any };
        void planPhotoLike;
        const seen: any[] = [];
        globalThis.fetch = (async (u: URL, init?: RequestInit) => {
            const url = new URL(String(u));
            if (url.pathname.includes('rupload')) return new Response('{"status":"ok","upload_id":"1"}');
            seen.push(url.pathname);
            return new Response('{"status":"fail","message":"token NAcO9zT3_SECRETSECRETSECRET:12:1794540000 rejected SECRETVALUE_ABCDEFGHIJKLMNOP"}', { status: 500 });
        }) as unknown as typeof fetch;
        const c = await IgClient.create({ cookies: { ...FAKE } });
        const f = path.join(DATA, 'p.jpg');
        writeFileSync(f, 'x');
        const plan: any = {
            kind: 'photo',
            contract: 'verified-live',
            caption: 'c',
            items: [{ label: 'p.jpg', file: f, facts: { kind: 'image', path: f, bytes: 1, width: 1080, height: 1350, mime: 'image/jpeg' }, uploadId: 'ph1', cover: null }],
            configure: { url: 'https://www.instagram.com/api/v1/media/configure/', encoding: 'form', body: { caption: 'c', upload_id: 'ph1' } },
            check: { errors: [], warnings: [] },
        };
        let err: any;
        await executePlan(c, plan).catch((e) => (err = e));
        expect(err).toBeDefined();
        expect(`${err.message} ${err.hint ?? ''}`).not.toMatch(/SECRET/);
        const pend: any[] = await listPending();
        expect(JSON.stringify(pend)).not.toMatch(/SECRET/);
        const { readdirSync, readFileSync, statSync } = await import('node:fs');
        const walk = (d: string): string[] => readdirSync(d).flatMap((n) => (statSync(path.join(d, n)).isDirectory() ? walk(path.join(d, n)) : [path.join(d, n)]));
        for (const file of walk(DATA).filter((n) => /\.(jsonl?|log)$/.test(n))) expect(readFileSync(file, 'utf8')).not.toMatch(/SECRET/);
        for (const p of pend) await clearPending(p.id);
    });
});
