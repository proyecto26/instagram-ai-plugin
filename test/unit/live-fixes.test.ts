/**
 * Behaviour added while publishing on a real account (2026-11-04): reading the signed-in
 * account from the home page, the --account guard, video stories, the story URL, the web
 * client's comment mutation and the edit_media body. All network is mocked or trapped.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { IgClient } from '../../skills/instagram/scripts/client.ts';
import { COMMENT_MUTATION, addComment, commentVariables, editCaption, executePlan, planStory } from '../../skills/instagram/scripts/publish.ts';
import { viewerFromHomeHtml, whoami } from '../../skills/instagram/scripts/read.ts';

const ROOT = path.resolve(import.meta.dir, '../..');
const MAIN = path.join(ROOT, 'skills/instagram/scripts/main.ts');
const TRAP = path.join(import.meta.dir, 'fetch-trap.ts');
const FAKE = { sessionid: 'S1', csrftoken: 'C1', ds_user_id: '42' };

const tmp = mkdtempSync(path.join(os.tmpdir(), 'ig-fix-'));
function file(name: string, bytes: Uint8Array): string {
    const p = path.join(tmp, name);
    writeFileSync(p, bytes);
    return p;
}
function jpeg(w: number, h: number): Uint8Array {
    const app0 = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0];
    const sof = [0xff, 0xc0, 0x00, 0x11, 8, h >> 8, h & 255, w >> 8, w & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
    return new Uint8Array([0xff, 0xd8, ...app0, ...sof, 0xff, 0xd9]);
}
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
function ffmpegVideo(name: string, size: string, seconds: number): string {
    const p = path.join(tmp, name);
    spawnSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `testsrc=s=${size}:d=${seconds}:r=10`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', p]);
    return p;
}

/** The viewer block as it appears in the logged-in home page: JSON inside a script string. */
const homeHtml = (id: string, username: string) =>
    `<script>{"require":[["x",{"__bbox":{"result":"{\\"data\\":{\\"xdt_viewer\\":{\\"user\\":{\\"username\\":\\"${username}\\",\\"full_name\\":\\"Juan\\",\\"id\\":\\"${id}\\"}}}}"}}]]}</script>`;

const realFetch = globalThis.fetch;
afterEach(() => {
    globalThis.fetch = realFetch;
});

describe('whoami from the home page', () => {
    test('reads username and id from the escaped xdt_viewer block', () => {
        expect(viewerFromHomeHtml(homeHtml('42', 'some.user_1'))).toEqual({ username: 'some.user_1', id: '42', fullName: 'Juan' });
    });

    test('returns null when the page names no viewer', () => {
        expect(viewerFromHomeHtml('<html>logged out</html>')).toBeNull();
    });

    test('uses only the home page, never the 429-prone users/{id}/info endpoint', async () => {
        const urls: string[] = [];
        globalThis.fetch = (async (u: URL) => {
            urls.push(String(u));
            return new Response(homeHtml('42', 'me'), { headers: { 'content-type': 'text/html' } });
        }) as unknown as typeof fetch;
        const c = await IgClient.create({ cookies: { ...FAKE } });
        const r = await whoami(c);
        expect(r.profile.username).toBe('me');
        expect(urls.some((u) => u.includes('/info/') || u.includes('current_user'))).toBe(false);
    });

    test('refuses a home page signed in as a different user than the cookies', async () => {
        globalThis.fetch = (async () => new Response(homeHtml('999', 'other'), { headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch;
        const c = await IgClient.create({ cookies: { ...FAKE } });
        await expect(whoami(c)).rejects.toMatchObject({ kind: 'not_logged_in' });
    });
});

describe('--account guard (CLI, network trapped)', () => {
    const run = (args: string[]) =>
        spawnSync(process.execPath, ['--preload', TRAP, MAIN, ...args], {
            encoding: 'utf8',
            env: { ...process.env, INSTAGRAM_COOKIES: 'sessionid=S1; csrftoken=C1; ds_user_id=42' },
        });

    test('a live post without --account is refused before any request', () => {
        const r = run(['post', 'photo', file('acct.jpg', jpeg(1080, 1350)), '--caption', 'hi', '--confirm', '--json']);
        expect(r.stderr).not.toContain('FETCH_TRAP');
        expect(r.status).toBe(1);
        expect(JSON.parse(r.stdout).error.message).toContain('--account');
    });

    test('a live comment without --account is refused before any request', () => {
        const r = run(['comment', 'DAbc123xyz0', '--text', 'hi', '--confirm', '--json']);
        expect(r.stderr).not.toContain('FETCH_TRAP');
        expect(r.status).toBe(1);
        expect(JSON.parse(r.stdout).error.message).toContain('--account');
    });
});

describe('stories', () => {
    test.skipIf(!hasFfmpeg)('a 9:16 video story plans rupload_igvideo plus a cover on the same upload id', async () => {
        const plan = await planStory(ffmpegVideo('story.mp4', '108x192', 4));
        expect(plan.check.errors).toEqual([]);
        expect(plan.items[0].facts.kind).toBe('video');
        expect(plan.items[0].cover).not.toBeNull();
        expect(plan.configure.body.upload_id).toBe(plan.items[0].uploadId);
    });

    test.skipIf(!hasFfmpeg)('a video story over 60 s is an error', async () => {
        const plan = await planStory(ffmpegVideo('long.mp4', '108x192', 61));
        expect(plan.check.errors.join()).toContain('outside 1s..60s');
    });

    test('the result URL of a story is /stories/<user>/<pk>/, not /p/<code>/', async () => {
        globalThis.fetch = (async (u: URL) => {
            if (String(u).includes('rupload')) return new Response('{"status":"ok","upload_id":"1"}');
            if (String(u).includes('configure_to_story')) return new Response('{"status":"ok","media":{"pk":"555","code":"DXYZ","user":{"username":"me"}}}');
            return new Response('{"status":"ok","items":[]}');
        }) as unknown as typeof fetch;
        const c = await IgClient.create({ cookies: { ...FAKE } });
        const r = await executePlan(c, await planStory(file('s.jpg', jpeg(1080, 1920))));
        expect(r.url).toBe('https://www.instagram.com/stories/me/555/');
    });
});

describe('comments use the web client mutation', () => {
    test('variables match PolarisPostCommentInput', () => {
        expect(commentVariables('5', 'hi')).toEqual({ data: { comment_text: 'hi', media_id: '5' }, root_connections: [] });
        expect(commentVariables('5', 'hi', '18100956338428020')).toEqual({
            data: { comment_text: 'hi', media_id: '5', replied_to_comment_id: '18100956338428020' },
            root_connections: [],
        });
    });

    test('posts to /api/graphql (not /graphql/query) with the doc_id from the post page', async () => {
        const posts: { path: string; body: URLSearchParams }[] = [];
        globalThis.fetch = (async (u: URL, init?: RequestInit) => {
            const url = new URL(String(u));
            if (init?.method === 'POST') {
                posts.push({ path: url.pathname, body: new URLSearchParams(String(init.body)) });
                return new Response('{"data":{"xig_comment_create":{"comment":{"pk":"777"}}}}');
            }
            return new Response(
                `<script>"DTSGInitialData",[],{"token":"DT"} "LSD",[],{"token":"LS"} __d("${COMMENT_MUTATION}_instagramRelayOperation",[],(function(a,b,c,d,e,f){e.exports="29086430320952860"}),null)</script>`,
                { headers: { 'content-type': 'text/html' } },
            );
        }) as unknown as typeof fetch;
        const c = await IgClient.create({ cookies: { ...FAKE } });
        const r = await addComment(c, 'DAbc123xyz0', 'hi', '18100956338428020');
        expect(r.commentId).toBe('777');
        expect(r.via).toBe(`graphql ${COMMENT_MUTATION}`);
        expect(posts).toHaveLength(1);
        expect(posts[0].path).toBe('/api/graphql');
        expect(posts[0].body.get('doc_id')).toBe('29086430320952860');
        expect(JSON.parse(posts[0].body.get('variables')!).data.replied_to_comment_id).toBe('18100956338428020');
    });

    test('a non-numeric reply id is refused before any request', async () => {
        let called = 0;
        globalThis.fetch = (async () => {
            called++;
            return new Response('{}');
        }) as unknown as typeof fetch;
        const c = await IgClient.create({ cookies: { ...FAKE } });
        await expect(addComment(c, 'DAbc123xyz0', 'hi', 'abc')).rejects.toMatchObject({ kind: 'validation' });
        expect(called).toBe(0);
    });
});

describe('edit caption', () => {
    test('sends coauthor_invites with the caption, like the web client', async () => {
        let body: URLSearchParams | null = null;
        globalThis.fetch = (async (_u: URL, init?: RequestInit) => {
            body = new URLSearchParams(String(init?.body));
            return new Response('{"status":"ok"}');
        }) as unknown as typeof fetch;
        const c = await IgClient.create({ cookies: { ...FAKE } });
        await editCaption(c, 'DAbc123xyz0', 'new caption');
        expect(body!.get('caption_text')).toBe('new caption');
        expect(JSON.parse(body!.get('coauthor_invites')!)).toEqual({ added: [], in: [], removed: [] });
    });
});
