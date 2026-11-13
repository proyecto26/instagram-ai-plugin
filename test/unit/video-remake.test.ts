// instagram-video-remake: graphs, geometry, audio matching, the ComfyUI client and the ffmpeg steps.
// The three fixtures under test/fixtures/remake are the graphs of runs that were kept, with file names,
// prompts and output names replaced: the builders must reproduce every other setting exactly.
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { FINE_RATE, correlate, envelope, findOffset } from '../../skills/instagram-video-remake/scripts/audio.ts';
import { Comfy, ComfyError, checkComfyUrl, failureOf, graphHash, outputsOf, pickVideo } from '../../skills/instagram-video-remake/scripts/comfy.ts';
import * as ff from '../../skills/instagram-video-remake/scripts/ff.ts';
import { CONTINUE_DEFAULTS, MODELS, REQUIRED_NODES, SWAP_DEFAULTS, buildContinuation, continuationFrames, fillSwap, generatedArea, h3Length, tierCanvas, toPreparedPoint, type Graph } from '../../skills/instagram-video-remake/scripts/graphs.ts';
import { main, parseArgs, parsePoint, parseRect } from '../../skills/instagram-video-remake/scripts/main.ts';
import { checkId, descendants, invalidate, lockRun, parseSegments, staleContinuation, timelineGaps } from '../../skills/instagram-video-remake/scripts/manifest.ts';

const ROOT = path.resolve(import.meta.dir, '..', '..');
const fixture = (n: string): Graph => JSON.parse(readFileSync(path.join(ROOT, 'test', 'fixtures', 'remake', `${n}.json`), 'utf8'));
const template = (): Graph => JSON.parse(readFileSync(path.join(ROOT, 'skills', 'instagram-video-remake', 'assets', 'workflows', 'h3_swap.api.json'), 'utf8'));
const TMP = mkdtempSync(path.join(os.tmpdir(), 'ig-remake-'));
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0 && spawnSync('ffmpeg', ['-hide_banner', '-encoders']).stdout?.toString().includes('libx264');

describe('remake graphs reproduce the kept runs', () => {
    const base = { video: 'driving.mp4', identity: 'identity.jpg', prompt: 'PROMPT', prefix: 'shot', ...SWAP_DEFAULTS };
    test('close shot: text detection, 768 tier', () => {
        expect(fillSwap(template(), { ...base, start: 0, duration: 4.9, tier: '768' })).toEqual(fixture('swap_text_768'));
    });
    test('small subject: one point, 480 tier, tighter mask', () => {
        const got = fillSwap(template(), { ...base, start: 0, duration: 2.266667, tier: '480', point: { x: 370, y: 380 }, expand: 32 });
        const want = fixture('swap_point_480');
        // The point travels as a JSON string; compare its value, not its spacing.
        for (const g of [got, want]) g['103'].inputs.positive_coords = JSON.parse(g['103'].inputs.positive_coords);
        expect(got).toEqual(want);
    });
    test('continuation anchored on the last 25 frames of the previous shot', () => {
        const g = buildContinuation({ scene: 'scene.png', identity: 'identity.jpg', previous: 'previous.mp4', previousFrames: 117, prompt: 'PROMPT', width: 736, height: 1344, seconds: 5.4, prefix: 'shot', ...CONTINUE_DEFAULTS });
        expect(g).toEqual(fixture('continue_guided'));
    });
    test('the template is not modified and options are validated', () => {
        const t = template();
        const before = JSON.stringify(t);
        fillSwap(t, { ...base, start: 0, duration: 3, tier: '480' });
        expect(JSON.stringify(t)).toBe(before);
        expect(() => fillSwap(t, { ...base, start: 0, duration: 11, tier: '480' })).toThrow(/up to 10 s/);
        expect(() => fillSwap(t, { ...base, start: -1, duration: 3, tier: '480' })).toThrow(/negative/);
        expect(() => fillSwap(t, { ...base, start: 0, duration: 3, tier: '480', point: { x: 1.5, y: 2 } })).toThrow(/whole/);
        expect(() => fillSwap({ a: { class_type: 'X', inputs: {} } }, { ...base, start: 0, duration: 3, tier: '480' })).toThrow(/not the bundled/);
    });
    test('an anchor keeps the anchor nodes; without one they are removed', () => {
        const withAnchor = fillSwap(template(), { ...base, start: 0, duration: 3, tier: '480', anchor: 'first.png' });
        expect(withAnchor.anchor_image.inputs.image).toBe('first.png');
        expect(withAnchor['803'].inputs.use_anchor).toBe(true);
        const without = fillSwap(template(), { ...base, start: 0, duration: 3, tier: '480' });
        expect(without.anchor_image).toBeUndefined();
        expect(without['803'].inputs.anchor).toBeUndefined();
    });
    test('recover is off unless asked for', () => {
        expect(fillSwap(template(), { ...base, start: 0, duration: 3, tier: '480' })['107'].inputs.recover_empty_frames).toBe(false);
        expect(fillSwap(template(), { ...base, start: 0, duration: 3, tier: '480', recover: true })['107'].inputs.recover_empty_frames).toBe(true);
    });
    test('doctor asks for every node class the two graphs use', () => {
        const used = new Set<string>();
        for (const g of [template(), fixture('continue_guided')]) for (const n of Object.values(g)) used.add(n.class_type);
        expect([...used].filter((c) => !REQUIRED_NODES.includes(c))).toEqual([]);
    });
    test('every model the graphs name is in MODELS', () => {
        const names = new Set<string>();
        for (const g of [fixture('swap_text_768'), fixture('continue_guided')]) for (const n of Object.values(g)) for (const v of Object.values(n.inputs)) if (typeof v === 'string' && v.endsWith('.safetensors')) names.add(v);
        expect([...names].sort()).toEqual(Object.values(MODELS).sort());
    });
});

describe('remake lengths and geometry', () => {
    test('clip lengths are 17k + 5', () => {
        expect(h3Length(1)).toBe(5);
        expect(h3Length(5)).toBe(5);
        expect(h3Length(6)).toBe(22);
        expect(h3Length(155)).toBe(158);
        expect(h3Length(158)).toBe(158);
        for (let f = 1; f < 400; f++) {
            const l = h3Length(f);
            expect((l - 5) % 17).toBe(0);
            expect(l).toBeGreaterThanOrEqual(f);
            expect(l - f).toBeLessThan(17);
        }
    });
    test('a continuation counts the guide frames once', () => {
        expect(continuationFrames(5.4, 25)).toEqual({ length: 158, guide: 25, fresh: 133 });
        expect(continuationFrames(2, 25).fresh).toBeGreaterThanOrEqual(48);
    });
    test('the generated clip covers the centre of what was sent', () => {
        // 360x640 crop at (150,520) through a 512x928 canvas: full height, 354 wide, centred.
        expect(generatedArea({ x: 150, y: 520, w: 360, h: 640 }, 512, 928)).toEqual({ x: 153, y: 520, w: 354, h: 640 });
        // Same aspect: unchanged.
        expect(generatedArea({ x: 0, y: 0, w: 720, h: 1280 }, 1080, 1920)).toEqual({ x: 0, y: 0, w: 720, h: 1280 });
        // Wider canvas than the area: full width, centred vertically.
        const r = generatedArea({ x: 10, y: 20, w: 400, h: 400 }, 928, 512);
        expect(r.w).toBe(400);
        expect(r.h).toBe(220);
        expect(r.y).toBe(20 + 90);
    });
    test('a click on the source frame maps into the prepared frame, and outside it is refused', () => {
        expect(toPreparedPoint({ x: 330, y: 840 }, { x: 150, y: 520, w: 360, h: 640 }, 512, 928)).toEqual({ x: 256, y: 464 });
        expect(() => toPreparedPoint({ x: 151, y: 840 }, { x: 150, y: 520, w: 360, h: 640 }, 512, 928)).toThrow(/outside/);
    });
    test('the working size follows the node pack: kept if small and on the 32 grid, otherwise fitted to the tier', () => {
        // The two sizes observed in the kept runs.
        expect(tierCanvas('480', { w: 360, h: 640 })).toEqual({ w: 512, h: 928 });
        expect(tierCanvas('768', { w: 720, h: 1280 })).toEqual({ w: 736, h: 1344 });
        // Already within budget and on the grid: unchanged, so a point maps one to one.
        expect(tierCanvas('480', { w: 288, h: 512 })).toEqual({ w: 288, h: 512 });
        expect(tierCanvas('480', { w: 512, h: 512 })).toEqual({ w: 512, h: 512 });
        expect(toPreparedPoint({ x: 144, y: 256 }, { x: 0, y: 0, w: 288, h: 512 }, 288, 512)).toEqual({ x: 144, y: 256 });
        // Within budget but off the grid, and over budget: refitted, always on the grid and within the budget.
        for (const [tier, budget] of [['480', 500_000], ['768', 1_000_000]] as const) {
            for (const area of [{ w: 300, h: 500 }, { w: 1280, h: 720 }, { w: 1080, h: 1080 }, { w: 1920, h: 1080 }, { w: 720, h: 1280 }, { w: 100, h: 2000 }]) {
                const c = tierCanvas(tier, area);
                expect(c.w % 32).toBe(0);
                expect(c.h % 32).toBe(0);
                expect(c.w * c.h).toBeLessThanOrEqual(budget);
                expect(Math.abs(Math.log(c.w / c.h / (area.w / area.h)))).toBeLessThan(0.2);
            }
        }
        expect(tierCanvas('480', { w: 1280, h: 720 })).toEqual({ w: 928, h: 512 });
        expect(() => tierCanvas('480', { w: 0, h: 10 })).toThrow();
    });
});

describe('remake command line and manifest helpers', () => {
    test('arguments', () => {
        const a = parseArgs(['swap', 'run', '--shot', 'far', '--start=7.5', '--reverse', '--crop', '360:640:150:520']);
        expect(a).toEqual({ cmd: 'swap', pos: ['run'], flags: { shot: 'far', start: '7.5', reverse: true, crop: '360:640:150:520' } });
        expect(() => parseArgs(['swap', '--shot'])).toThrow(/needs a value/);
        expect(parseRect('360:640:150:520')).toEqual({ w: 360, h: 640, x: 150, y: 520 });
        expect(() => parseRect('360x640')).toThrow();
        expect(parsePoint('10,20', 'point')).toEqual({ x: 10, y: 20 });
        expect(() => parsePoint('10;20', 'point')).toThrow();
    });
    test('segments and ids', () => {
        expect(parseSegments('source:0-7.5, shot:far ,source:10-13,shot:close')).toEqual([{ source: [0, 7.5] }, { shot: 'far' }, { source: [10, 13] }, { shot: 'close' }]);
        for (const bad of ['', 'source:5-5', 'source:7-3', 'clip:a', 'shot:Bad Id']) expect(() => parseSegments(bad)).toThrow();
        const shots: any[] = [{ id: 'far', kind: 'swap', start: 7.7667, duration: 2.2667, attempts: [] }, { id: 'close', kind: 'swap', start: 10.1, duration: 4.9, attempts: [] }, { id: 'more', kind: 'continue', after: 'close', attempts: [] }];
        expect(timelineGaps(parseSegments('source:0-7.7667,shot:far,source:10.0334-10.1,shot:close,shot:more'), shots, 30)).toEqual([]);
        const gaps = timelineGaps(parseSegments('source:0-7.7667,shot:far,shot:close,shot:more'), shots, 30);
        expect(gaps).toHaveLength(1);
        expect(gaps[0]).toMatch(/shot:far ends at 10\.033 s and shot:close starts at 10\.100 s: 0\.067 s of the source is skipped/);
        expect(timelineGaps(parseSegments('source:0-8,shot:far'), shots, 30)[0]).toMatch(/repeated/);
        expect(checkId('far_2')).toBe('far_2');
        for (const bad of ['Far', '../x', '', 'a'.repeat(40)]) expect(() => checkId(bad)).toThrow();
    });
    test('init refuses to start without a real consent statement', async () => {
        await expect(main(['init', path.join(TMP, 'r0'), '--source', 'x.mp4', '--identity', 'y.jpg'])).rejects.toThrow(/--consent is required/);
        await expect(main(['init', path.join(TMP, 'r0'), '--source', 'x.mp4', '--identity', 'y.jpg', '--consent', 'ok'])).rejects.toThrow(/real sentence/);
    });
});

describe('remake audio matching', () => {
    const noise = (n: number, seed: number) => {
        const x = new Float32Array(n);
        let s = seed;
        for (let i = 0; i < n; i++) {
            s = (s * 1664525 + 1013904223) >>> 0;
            // A slowly varying loudness, so the envelope has structure as music does.
            x[i] = ((s / 2 ** 32) * 2 - 1) * (0.2 + 0.8 * Math.abs(Math.sin(i / 3000) * Math.sin(i / 17000)));
        }
        return x;
    };
    test('finds a clip inside a longer recording to the sample', () => {
        const track = noise(FINE_RATE * 60, 7);
        const at = Math.round(FINE_RATE * 29.235);
        const clip = track.slice(at, at + FINE_RATE * 8);
        const r = findOffset(track, clip);
        expect(r.verdict).toBe('match');
        expect(Math.abs(r.offset - 29.235)).toBeLessThan(1 / FINE_RATE + 1e-9);
        expect(r.score).toBeGreaterThan(0.99);
    });
    test('a different recording is not a match', () => {
        const r = findOffset(noise(FINE_RATE * 30, 7), noise(FINE_RATE * 5, 99));
        expect(r.verdict).not.toBe('match');
    });
    test('too short or longer than the track', () => {
        expect(findOffset(noise(FINE_RATE * 10, 1), noise(100, 1)).verdict).toBe('no_match');
        expect(findOffset(noise(FINE_RATE * 2, 1), noise(FINE_RATE * 5, 1)).verdict).toBe('no_match');
    });
    test('helpers', () => {
        const env = envelope(new Float32Array([1, 1, 0, 0, 3, 4]), 2);
        expect(env[0]).toBe(1);
        expect(env[1]).toBe(0);
        expect(env[2]).toBeCloseTo(Math.sqrt(12.5), 5);
        const hay = new Float32Array([0, 0, 1, 3, 2, 0, 0, 0]);
        expect(correlate(hay, new Float32Array([1, 3, 2]), 0, 99).lag).toBe(2);
    });
});

describe('remake ComfyUI client', () => {
    test('only this computer unless allowed', () => {
        expect(checkComfyUrl('http://127.0.0.1:8188', false).port).toBe('8188');
        expect(checkComfyUrl('http://localhost:8189/', false).hostname).toBe('localhost');
        expect(() => checkComfyUrl('http://192.168.1.20:8188', false)).toThrow(/not this computer/);
        expect(checkComfyUrl('http://192.168.1.20:8188', true).hostname).toBe('192.168.1.20');
        expect(() => checkComfyUrl('ftp://x', false)).toThrow();
        expect(() => checkComfyUrl('nonsense', false)).toThrow();
    });
    test('reading a finished or failed job', () => {
        const entry = { status: { status_str: 'success', completed: true }, outputs: { '809': { images: [{ filename: 'a_00001_.mp4', subfolder: 'video', type: 'output' }], animated: [true] }, '5': { images: [{ filename: 'p.png', subfolder: '', type: 'temp' }] } } };
        expect(outputsOf(entry)).toHaveLength(2);
        expect(pickVideo(entry, '809')).toEqual({ filename: 'a_00001_.mp4', subfolder: 'video', type: 'output' });
        expect(() => pickVideo(entry, '42')).toThrow(/save node \(42\) reported 0/);
        expect(() => pickVideo({ outputs: {} }, '809')).toThrow(/reported 0/);
        expect(failureOf(entry)).toBeNull();
        expect(failureOf({ status: { status_str: 'error', messages: [['execution_error', { node_type: 'SAM3_VideoTrack', exception_message: 'lost the selected person\n' }]] } })).toBe('SAM3_VideoTrack: lost the selected person');
    });
    test('a rejected graph reports the node errors; a lost answer is looked up, not resubmitted', async () => {
        const g: Graph = { '1': { class_type: 'X', inputs: {} } };
        expect(graphHash(g)).toMatch(/^[0-9a-f]{16}$/);
        const rejecting = new Comfy('http://127.0.0.1:8188', false, (async () => new Response(JSON.stringify({ error: { message: 'Prompt outputs failed validation' }, node_errors: { '809': { class_type: 'SaveVideo', errors: [{ message: 'Required input is missing', details: 'format.codec' }] } } }), { status: 400 })) as unknown as typeof fetch);
        await expect(rejecting.submit(g)).rejects.toThrow(/SaveVideo: Required input is missing format.codec/);

        let posts = 0;
        const lost = new Comfy('http://127.0.0.1:8188', false, (async (u: string, init?: RequestInit) => {
            expect(init?.redirect).toBe('manual');
            expect(init?.signal).toBeDefined();
            if (init?.method === 'POST') {
                posts++;
                throw new Error('socket hang up');
            }
            if (String(u).endsWith('/queue')) return new Response(JSON.stringify({ queue_running: [[0, 'pid-123', {}, { client_id: 'cid-1' }]], queue_pending: [] }));
            return new Response('{}');
        }) as unknown as typeof fetch);
        expect(await lost.submit(g, 'cid-1')).toEqual({ promptId: 'pid-123', clientId: 'cid-1' });
        expect(posts).toBe(1);

        const gone = new Comfy('http://127.0.0.1:8188', false, (async (_u: string, init?: RequestInit) => {
            if (init?.method === 'POST') throw new Error('socket hang up');
            return new Response(JSON.stringify({ queue_running: [], queue_pending: [] }));
        }) as unknown as typeof fetch);
        await expect(gone.submit(g, 'cid-2')).rejects.toMatchObject({ kind: 'unknown_submit' });

        // The server accepted the request but the body never arrived: look the job up, do not call it a rejection.
        const cutOff = new Comfy('http://127.0.0.1:8188', false, (async (u: string, init?: RequestInit) => {
            if (init?.method === 'POST') return new Response('{"prompt_id": "pid-9', { status: 200 });
            if (String(u).endsWith('/queue')) return new Response(JSON.stringify({ queue_running: [], queue_pending: [[1, 'pid-9', {}, { client_id: 'cid-3' }]] }));
            return new Response('{}');
        }) as unknown as typeof fetch);
        expect((await cutOff.submit(g, 'cid-3')).promptId).toBe('pid-9');

        // A redirect is refused: the files must not be forwarded to another host.
        const redirecting = new Comfy('http://127.0.0.1:8188', false, (async () => new Response('', { status: 307, headers: { location: 'http://elsewhere.example/prompt' } })) as unknown as typeof fetch);
        await expect(redirecting.submit(g, 'cid-4')).rejects.toThrow(/redirect, which is refused/);
        await expect(redirecting.json('/queue')).rejects.toThrow(/redirect/);
    });
    test('a job whose id was never received is found later by its client id', async () => {
        const c = new Comfy('http://127.0.0.1:8188', false, (async (u: string) => {
            if (String(u).endsWith('/queue')) return new Response(JSON.stringify({ queue_running: [], queue_pending: [] }));
            return new Response(JSON.stringify({ 'pid-77': { prompt: [1, 'pid-77', {}, { client_id: 'cid-lost' }] }, other: { prompt: [2, 'other', {}, { client_id: 'x' }] } }));
        }) as unknown as typeof fetch);
        expect(await c.findByClient('cid-lost')).toBe('pid-77');
        expect(await c.findByClient('cid-none')).toBeNull();
        // The whole retained history is searched, not a recent slice.
        const asked: string[] = [];
        const big = new Comfy('http://127.0.0.1:8188', false, (async (u: string) => {
            asked.push(String(u));
            if (String(u).endsWith('/queue')) return new Response(JSON.stringify({ queue_running: [], queue_pending: [] }));
            const h: Record<string, unknown> = {};
            for (let i = 0; i < 300; i++) h[`p${i}`] = { prompt: [i, `p${i}`, {}, { client_id: `c${i}` }] };
            return new Response(JSON.stringify(h));
        }) as unknown as typeof fetch);
        expect(await big.findByClient('c7')).toBe('p7');
        expect(asked.some((u) => u.endsWith('/history'))).toBe(true);
        expect(asked.some((u) => u.includes('max_items'))).toBe(false);
        // Who submitted a job: from the queue, from the history, or unknown.
        const who = new Comfy('http://127.0.0.1:8188', false, (async (u: string) => {
            if (String(u).endsWith('/queue')) return new Response(JSON.stringify({ queue_running: [[0, 'run-1', {}, { client_id: 'cq' }]], queue_pending: [] }));
            if (String(u).endsWith('/history/done-1')) return new Response(JSON.stringify({ 'done-1': { prompt: [1, 'done-1', {}, { client_id: 'ch' }] } }));
            return new Response('{}');
        }) as unknown as typeof fetch);
        expect(await who.clientOf('run-1')).toBe('cq');
        expect(await who.clientOf('done-1')).toBe('ch');
        expect(await who.clientOf('nope')).toBeNull();
    });
    test('waiting: failure, timeout without cancelling, completion', async () => {
        const seq = (entries: any[]) => {
            let i = 0;
            return (async () => new Response(JSON.stringify(entries[Math.min(i++, entries.length - 1)]))) as unknown as typeof fetch;
        };
        const ok = new Comfy('http://127.0.0.1:8188', false, seq([{}, { p: { status: { status_str: 'success', completed: true }, outputs: {} } }]));
        expect((await ok.wait('p', { timeoutMs: 5000, pollMs: 1 })).status.completed).toBe(true);
        const bad = new Comfy('http://127.0.0.1:8188', false, seq([{ p: { status: { status_str: 'error', messages: [['execution_error', { node_type: 'N', exception_message: 'boom' }]] } } }]));
        await expect(bad.wait('p', { timeoutMs: 5000, pollMs: 1 })).rejects.toThrow(/N: boom/);
        const slow = new Comfy('http://127.0.0.1:8188', false, seq([{}]));
        const e: ComfyError = await slow.wait('p', { timeoutMs: 5, pollMs: 5 }).catch((x) => x);
        expect(e.kind).toBe('timeout');
        expect(e.message).toMatch(/NOT cancelled.*--resume p/);
    });
});

describe.skipIf(!hasFfmpeg)('remake ffmpeg steps', () => {
    const make = (name: string, size: string, seconds: number, color: string, fps = 30, tone = 440) => {
        const f = path.join(TMP, name);
        const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${color}:s=${size}:r=${fps}:d=${seconds}`, '-f', 'lavfi', '-i', `sine=frequency=${tone}:sample_rate=44100:duration=${seconds}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', f]);
        if (r.status !== 0) throw new Error(r.stderr.toString());
        return f;
    };
    const pixel = (file: string, t: number, x: number, y: number): number[] => {
        const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', '-vf', `crop=2:2:${x}:${y},scale=1:1`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
        return Array.from(r.stdout as Buffer);
    };
    const near = (a: number[], b: number[], tol = 14) => a.every((v, i) => Math.abs(v - b[i]) <= tol);

    test('probe, cut, crop and reverse', async () => {
        const src = make('src.mp4', '360x640', 3, 'blue');
        const p = await ff.probe(src);
        expect(p).toMatchObject({ width: 360, height: 640, hasAudio: true });
        expect(Math.round(p.fps)).toBe(30);
        expect(p.frames).toBe(90);
        const out = path.join(TMP, 'cut.mp4');
        await ff.cut(src, out, { start: 1, duration: 1, fps: p.fps, crop: { x: 100, y: 200, w: 160, h: 320 }, reverse: true, hasAudio: true });
        const c = await ff.probe(out);
        expect(c).toMatchObject({ width: 160, height: 320, hasAudio: true });
        expect(c.frames).toBe(30);
        // A reversed cut from the middle must hold the wanted stretch, not the end of the file: the source is
        // blue for 2 s and then red, and the first second, reversed, must be blue on its first frame.
        const twoTone = path.join(TMP, 'twotone.mp4');
        spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=64x64:r=30:d=2', '-f', 'lavfi', '-i', 'color=c=red:s=64x64:r=30:d=2', '-filter_complex', '[0][1]concat=n=2:v=1:a=0', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', twoTone]);
        const rev = path.join(TMP, 'rev.mp4');
        await ff.cut(twoTone, rev, { start: 0.5, duration: 1, fps: 30, reverse: true, hasAudio: false });
        expect((await ff.probe(rev)).frames).toBe(30);
        const first = pixel(rev, 0, 10, 10);
        expect(first[2]).toBeGreaterThan(150);
        expect(first[0]).toBeLessThan(90);
        // 7.77 s at 30 fps is frame 233; 2.2667 s is 68 frames: 233..300, never 301.
        expect(ff.frameSpan(7.77, 2.2667, 30)).toMatchObject({ first: 233, frames: 68 });
        expect(ff.frameSpan(0, 0.01, 30)).toMatchObject({ first: 0, frames: 1, seek: 0 });
        expect(() => ff.checkRect({ x: 300, y: 0, w: 160, h: 320 }, p)).toThrow(/does not fit/);
        expect(() => ff.checkRect({ x: 0, y: 0, w: 161, h: 320 }, p)).toThrow(/even/);
    });

    test('a cropped shot is blended back inside its area only', async () => {
        const src = make('base.mp4', '360x640', 2, 'blue');
        const gen = make('gen.mp4', '128x232', 2, 'red', 24);
        const out = path.join(TMP, 'placed.mp4');
        const area = { x: 100, y: 200, w: 160, h: 290 };
        await ff.placeBack({ source: src, firstFrame: 0, frames: 60, generated: gen, out, frame: { width: 360, height: 640, fps: 30 }, area, feather: 10 });
        const p = await ff.probe(out);
        expect(p).toMatchObject({ width: 360, height: 640, hasAudio: false });
        expect(Math.round(p.fps)).toBe(30);
        expect(p.frames).toBe(60);
        const blue = pixel(src, 1, 10, 10);
        const red = pixel(gen, 1, 60, 100);
        expect(near(pixel(out, 1, 10, 10), blue)).toBe(true); // far outside
        expect(near(pixel(out, 1, 90, 340), blue)).toBe(true); // just outside the left edge
        expect(near(pixel(out, 1, 264, 340), blue)).toBe(true); // just outside the right edge
        expect(near(pixel(out, 1, 180, 345), red, 24)).toBe(true); // centre of the area
    });

    test('a full-frame shot is scaled to cover the frame at the source frame rate', async () => {
        const gen = make('genfull.mp4', '184x336', 1, 'green', 24);
        const out = path.join(TMP, 'placedfull.mp4');
        // 24 frames of generated material must fill a stretch of exactly 31 source frames: the last frame is held.
        await ff.placeBack({ source: gen, firstFrame: 0, frames: 31, generated: gen, out, frame: { width: 360, height: 640, fps: 30 } });
        const p = await ff.probe(out);
        expect(p).toMatchObject({ width: 360, height: 640 });
        expect(p.frames).toBe(31);
    });

    test('guide frames are dropped once; segments join; audio is never looped', async () => {
        const a = make('a.mp4', '360x640', 2, 'blue', 24);
        const dropped = path.join(TMP, 'dropped.mp4');
        await ff.dropFrames(a, dropped, 25);
        expect((await ff.probe(dropped)).frames).toBe(48 - 25);
        const b = make('b.mp4', '360x640', 1, 'red');
        const joined = path.join(TMP, 'joined.mp4');
        const a30 = make('a30.mp4', '360x640', 2, 'blue');
        await ff.concat([{ file: a30, start: 0, frames: 30 }, { file: b }, { file: a30, start: 1 - 0.5 / 30, frames: 15 }], joined, { width: 360, height: 640, fps: 30 });
        const j = await ff.probe(joined);
        expect(j.frames).toBe(75);
        expect(j.hasAudio).toBe(false);
        const final = path.join(TMP, 'final.mp4');
        await expect(ff.mux(joined, b, final, { audioStart: 0, videoDuration: j.duration, audioDuration: await ff.audioLength(b) })).rejects.toThrow(/too short/);
        // A wrong length handed in cannot hide a short audio stream: the result is measured.
        await expect(ff.mux(joined, b, final, { audioStart: 0, videoDuration: j.duration, audioDuration: 99 })).rejects.toThrow(/came out incomplete/);
        const silent = path.join(TMP, 'silent.mp4');
        spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', b, '-an', '-c:v', 'copy', silent]);
        expect(await ff.audioLength(silent)).toBe(0);
        await expect(ff.mux(joined, silent, final, { audioStart: 0, videoDuration: 1, audioDuration: 0 })).rejects.toThrow(/no audio stream/);
        const three = make('three.mp4', '64x64', 3, 'black');
        await ff.mux(joined, three, final, { audioStart: 0, videoDuration: j.duration, audioDuration: await ff.audioLength(three) });
        const fp = await ff.probe(final);
        expect(fp.hasAudio).toBe(true);
        expect(fp.frames).toBe(75);
        expect(Math.abs(fp.audioDuration - 2.5)).toBeLessThan(0.1);
        const cmp = path.join(TMP, 'cmp.mp4');
        await ff.sideBySide(a, final, cmp, 320);
        expect((await ff.probe(cmp)).width).toBe(360);
    });

    test('the run folder flow without a model: init, a hand-made shot, place, approve, assemble, audio, status', async () => {
        const run = path.join(TMP, 'run1');
        const src = make('flow.mp4', '360x640', 3, 'blue');
        const idPhoto = path.join(TMP, 'id.jpg');
        spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=white:s=64x64', '-frames:v', '1', idPhoto]);
        await main(['init', run, '--source', src, '--identity', idPhoto, '--consent', 'The person in the photo agreed to appear in this test video.', '--json']);
        const mf = path.join(run, 'remake.json');
        const m = JSON.parse(readFileSync(mf, 'utf8'));
        expect(m.schema).toBe('ig.remake.v1');
        expect(m.consent.statement).toMatch(/agreed/);
        // Stand in for a generated attempt of the stretch 1.0–2.0 s, sent as a crop.
        const gen = make('flowgen.mp4', '128x232', 1, 'red', 24);
        const { mkdirSync, copyFileSync } = await import('node:fs');
        mkdirSync(path.join(run, 'shots', 'far'), { recursive: true });
        copyFileSync(gen, path.join(run, 'shots', 'far', 'attempt1.mp4'));
        m.shots.push({ id: 'far', kind: 'swap', start: 1, duration: 1, crop: { x: 100, y: 200, w: 160, h: 290 }, attempts: [{ n: 1, at: 'x', kind: 'swap', settings: {}, graphHash: 'h', clientId: 'c', status: 'done', output: 'shots/far/attempt1.mp4', outputSha256: createHash('sha256').update(readFileSync(gen)).digest('hex'), frames: 24 }] });
        writeFileSync(mf, JSON.stringify(m));
        await main(['place', run, '--shot', 'far', '--json']);
        await expect(main(['assemble', run, '--segments', 'source:0-1,shot:far,source:2-3'])).rejects.toThrow(/Not approved yet: far/);
        await main(['approve', run, '--shot', 'far', '--json']);
        await main(['assemble', run, '--segments', 'source:0-1,shot:far,source:2-3', '--json']);
        await expect(main(['audio', run])).rejects.toThrow(/--rights is required/);
        await main(['audio', run, '--rights', 'Review copy only, not for publication.', '--json']);
        await main(['compare', run, '--json']);
        await main(['status', run, '--json']);
        const done = JSON.parse(readFileSync(mf, 'utf8'));
        expect(done.shots[0].approved.sha256).toBe(done.shots[0].placed.sha256);
        expect(Math.abs(done.timeline.duration - 3)).toBeLessThan(0.1);
        expect(done.audio).toEqual({ mode: 'source', start: 0, rights: 'Review copy only, not for publication.' });
        expect(done.shots[0].placed.sha256).toBeDefined();
        expect((await ff.probe(path.join(run, 'shots', 'far', 'placed.mp4'))).frames).toBe(30);
        expect((await ff.probe(path.join(run, 'timeline.mp4'))).frames).toBe(90);
        const fin = await ff.probe(path.join(run, 'final.mp4'));
        expect(fin.hasAudio).toBe(true);
        // Re-placing invalidates the approval, the timeline and the final file.
        await main(['place', run, '--shot', 'far', '--feather', '4', '--json']);
        const after = JSON.parse(readFileSync(mf, 'utf8'));
        expect(after.shots[0].approved).toBeUndefined();
        expect(after.timeline).toBeUndefined();
        expect(after.final).toBeUndefined();
        // A placed file edited after approval is not the approved one.
        await main(['approve', run, '--shot', 'far', '--json']);
        const placedFile = path.join(run, 'shots', 'far', 'placed.mp4');
        const original = readFileSync(placedFile);
        writeFileSync(placedFile, Buffer.concat([original, Buffer.from('x')]));
        await expect(main(['assemble', run, '--segments', 'source:0-1,shot:far,source:2-3'])).rejects.toThrow(/changed since it was written/);
        writeFileSync(placedFile, original);
        // --point needs a 9:16 area; resume needs an attempt with that job.
        await expect(main(['swap', run, '--shot', 'far', '--point', '1,1', '--point-prepared', '1,1', '--start', '1', '--duration', '1', '--crop', '160:290:100:200'])).rejects.toThrow(/not both/);
        // An unknown job id is checked against ComfyUI (here: an address nothing listens on), never guessed.
        await expect(main(['swap', run, '--shot', 'far', '--resume', 'nope', '--comfy-url', 'http://127.0.0.1:9'])).rejects.toThrow(/did not answer|does not belong to an unfinished swap/);
        await expect(main(['swap', run, '--shot', 'far', '--resume', 'last'])).rejects.toThrow(/no unfinished swap/);
        await expect(main(['swap', run, '--shot', 'ghost', '--resume', 'last'])).rejects.toThrow(/no shot "ghost"/);
        // One command at a time.
        const release = await lockRun(run);
        await expect(main(['approve', run, '--shot', 'far'])).rejects.toThrow(/Another command is working/);
        await release();
        // A longer timeline than the source needs a recording and a stated basis; it is never looped.
        await main(['approve', run, '--shot', 'far', '--json']);
        await main(['assemble', run, '--segments', 'source:0-3,shot:far', '--json']);
        await expect(main(['audio', run, '--rights', 'Review copy only, not for publication.'])).rejects.toThrow(/longer than the source's audio/);
        const long = make('long.mp4', '64x64', 6, 'black');
        await expect(main(['audio', run, '--file', long, '--start', '1'])).rejects.toThrow(/--rights is required/);
        await main(['audio', run, '--file', long, '--start', '1', '--rights', 'My own recording, made for this test.', '--json']);
        expect(JSON.parse(readFileSync(mf, 'utf8')).audio).toMatchObject({ mode: 'file', start: 1 });
    }, 120_000);
});

describe('remake state: what a change invalidates', () => {
    const attempt = (n: number, sha: string, extra: Record<string, unknown> = {}): any => ({ n, at: 'x', kind: 'swap', settings: extra, graphHash: 'g', clientId: 'c', status: 'done', output: `o${n}.mp4`, outputSha256: sha });
    const manifest = (): any => ({
        shots: [
            { id: 'close', kind: 'swap', start: 1, duration: 2, attempts: [attempt(1, 'A')], placed: { file: 'p', sha256: 'P', fromAttempt: 1 }, approved: { at: 'x', sha256: 'P' } },
            { id: 'more', kind: 'continue', after: 'close', attempts: [{ ...attempt(1, 'M', { afterAttempt: 1, afterSha256: 'A' }), kind: 'continue' }], placed: { file: 'q', sha256: 'Q', fromAttempt: 1 }, approved: { at: 'x', sha256: 'Q' } },
            { id: 'other', kind: 'swap', start: 5, duration: 1, attempts: [attempt(1, 'O')], placed: { file: 'r', sha256: 'R', fromAttempt: 1 }, approved: { at: 'x', sha256: 'R' } },
        ],
        timeline: { segments: [], file: 't', sha256: 'T', duration: 1 },
        final: { file: 'f', sha256: 'F', duration: 1, at: 'x' },
    });
    test('a new attempt clears the shot, its continuation, the timeline and the final file, and nothing else', () => {
        const m = manifest();
        m.shots[0].selected = 1;
        invalidate(m, 'close', 'attempt');
        expect(m.shots[0].placed).toBeUndefined();
        expect(m.shots[0].approved).toBeUndefined();
        expect(m.shots[0].selected).toBeUndefined();
        expect(m.shots[1].placed).toBeUndefined();
        expect(m.shots[1].approved).toBeUndefined();
        expect(m.shots[2].approved).toBeDefined();
        expect(m.timeline).toBeUndefined();
        expect(m.final).toBeUndefined();
    });
    test('placing again clears the approval and the downstream files, not the continuation', () => {
        const m = manifest();
        invalidate(m, 'close', 'placement');
        expect(m.shots[0].approved).toBeUndefined();
        expect(m.shots[0].placed).toBeDefined();
        expect(m.shots[1].placed).toBeDefined();
        expect(m.final).toBeUndefined();
    });
    test('a continuation built on an older version of its shot is reported', () => {
        const m = manifest();
        expect(staleContinuation(m, m.shots[1])).toBeNull();
        expect(staleContinuation(m, m.shots[0])).toBeNull();
        m.shots[0].attempts.push(attempt(2, 'B'));
        expect(staleContinuation(m, m.shots[1])).toMatch(/earlier version of shot "close" \(attempt 1\), not the one now selected \(attempt 2\)/);
        m.shots[0].selected = 1;
        expect(staleContinuation(m, m.shots[1])).toBeNull();
    });
    test('changes reach continuations of continuations', () => {
        const m = manifest();
        m.shots.push({ id: 'evenmore', kind: 'continue', after: 'more', attempts: [{ ...attempt(1, 'E', { afterAttempt: 1, afterSha256: 'M' }), kind: 'continue' }], placed: { file: 's', sha256: 'S', fromAttempt: 1 }, approved: { at: 'x', sha256: 'S' } });
        expect(descendants(m, 'close').map((s) => s.id)).toEqual(['more', 'evenmore']);
        expect(staleContinuation(m, m.shots[3])).toBeNull();
        // A new attempt of the first shot: the grandchild's own parent hash still matches, but its ancestry does not.
        m.shots[0].attempts.push(attempt(2, 'B'));
        expect(staleContinuation(m, m.shots[3])).toMatch(/shot "more", which it continues, is out of date/);
        invalidate(m, 'close', 'attempt');
        expect(m.shots[1].approved).toBeUndefined();
        expect(m.shots[3].approved).toBeUndefined();
        expect(m.shots[3].placed).toBeUndefined();
        expect(m.shots[2].approved).toBeDefined();
    });
    test('many contenders for the lock: exactly one wins, repeatedly, and a live lock is never displaced', async () => {
        const { mkdirSync, writeFileSync: w, readFileSync: r, existsSync, readdirSync, rmSync } = await import('node:fs');
        const run = path.join(TMP, 'lockrace');
        mkdirSync(run, { recursive: true });
        const lock = path.join(run, 'remake.lock');
        for (let round = 0; round < 6; round++) {
            w(lock, JSON.stringify({ pid: 999999, at: 'x' })); // left by a command that exited
            const results = await Promise.allSettled(Array.from({ length: 10 }, () => lockRun(run)));
            const won = results.filter((x) => x.status === 'fulfilled') as Array<PromiseFulfilledResult<() => Promise<void>>>;
            expect(won).toHaveLength(1);
            for (const x of results) if (x.status === 'rejected') expect(String(x.reason)).toMatch(/Another command is working/);
            // While it is held, the lock names this process and further contenders are all refused.
            expect(JSON.parse(r(lock, 'utf8')).pid).toBe(process.pid);
            const late = await Promise.allSettled(Array.from({ length: 5 }, () => lockRun(run)));
            expect(late.every((x) => x.status === 'rejected')).toBe(true);
            expect(JSON.parse(r(lock, 'utf8')).pid).toBe(process.pid);
            await won[0].value();
            expect(existsSync(lock)).toBe(false);
        }
        expect(readdirSync(run)).toEqual([]);
        // An unreadable lock is never taken for a stale one.
        w(lock, '');
        await expect(lockRun(run)).rejects.toThrow(/cannot be read/);
        rmSync(lock);
        // A guard left behind is reported, not removed.
        mkdirSync(`${lock}.guard`);
        const realNow = Date.now;
        let t0 = realNow();
        Date.now = () => (t0 += 4000);
        try {
            await expect(lockRun(run)).rejects.toThrow(/run folder is busy/);
        } finally {
            Date.now = realNow;
        }
        expect(existsSync(`${lock}.guard`)).toBe(true);
        rmSync(`${lock}.guard`, { recursive: true });
    });
    test('the run lock is exclusive and survives a dead owner', async () => {
        const { mkdirSync, writeFileSync: w, existsSync } = await import('node:fs');
        const run = path.join(TMP, 'lockrun');
        mkdirSync(run, { recursive: true });
        const release = await lockRun(run);
        await expect(lockRun(run)).rejects.toThrow(/Another command/);
        await release();
        expect(existsSync(path.join(run, 'remake.lock'))).toBe(false);
        w(path.join(run, 'remake.lock'), JSON.stringify({ pid: 999999, at: 'x' }));
        const again = await lockRun(run);
        await again();
    });
});
