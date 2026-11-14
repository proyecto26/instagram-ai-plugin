// instagram-video-breakdown: pure logic runs on in-memory data; the media tests build their own
// fixtures with ffmpeg lavfi and are skipped (with a message) when ffmpeg is not installed.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SR, analyseSamples, estimateRhythm, fft, pickOnsets, alignedRatio } from '../../skills/instagram-video-breakdown/scripts/audio.ts';
import { analysisId, applyReview, buildScript, pacing, recreateMarkdown, summaryText, type Breakdown, type Shot } from '../../skills/instagram-video-breakdown/scripts/breakdown.ts';
import { SelectionError, audioAttribution, buildMeta, downloadCdn, isAllowedCdn, parseMentions, pickVariant, selectItem } from '../../skills/instagram-video-breakdown/scripts/fetch.ts';
import { run } from '../../skills/instagram-video-breakdown/scripts/ff.ts';
import { GRAY_H, GRAY_W, recordOverrides, applyOverrides, detectCuts, diffCuts, grayFrames, mergeCuts, motionForShot, pairStats, probe, spans, textCandidates } from '../../skills/instagram-video-breakdown/scripts/shots.ts';
import { buildArgv, normalizeJson, parseCues, parseTranscript, runRecogniser, segmentsForShot, tokenize, type Transcript } from '../../skills/instagram-video-breakdown/scripts/transcript.ts';

const MAIN = path.resolve(import.meta.dir, '../../skills/instagram-video-breakdown/scripts/main.ts');
const HAS_FFMPEG = spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;
if (!HAS_FFMPEG) console.warn('[video-breakdown] ffmpeg/ffprobe not found: media fixture tests are skipped.');

// ---------- fetch ----------

describe('CDN allow-list', () => {
    const ok = ['https://instagram.feoh14-1.fna.fbcdn.net/v/t1/x.mp4?a=1', 'https://scontent-mia3-1.cdninstagram.com/o1/v/x.mp4', 'https://SCONTENT.cdninstagram.com/x'];
    const bad = [
        'http://scontent.cdninstagram.com/x.mp4',
        'https://cdninstagram.com/x.mp4',
        'https://fbcdn.net/x',
        'https://evilcdninstagram.com/x.mp4',
        'https://cdninstagram.com.evil.example/x.mp4',
        'https://fbcdn.net.evil.example/x',
        'https://www.instagram.com/x.mp4',
        'https://user:pw@scontent.cdninstagram.com/x',
        'ftp://scontent.cdninstagram.com/x',
        'not a url',
        '',
    ];
    for (const u of ok) test(`accepts ${u}`, () => expect(isAllowedCdn(u)).toBe(true));
    for (const u of bad) test(`rejects ${u || '(empty)'}`, () => expect(isAllowedCdn(u)).toBe(false));
});

describe('downloadCdn', () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'ig-bd-dl-'));
    afterAll(() => rmSync(tmp, { recursive: true, force: true }));
    const url = 'https://scontent.cdninstagram.com/v.mp4';
    const reply = (body: Uint8Array | null, init: ResponseInit) => (async (_u: any, _o: any) => new Response(body as any, init)) as unknown as typeof fetch;

    test('sends no cookies and does not follow redirects', async () => {
        let seen: any;
        const f = (async (_u: any, o: any) => {
            seen = o;
            return new Response(new Uint8Array(10), { status: 200 });
        }) as unknown as typeof fetch;
        expect(await downloadCdn(url, path.join(tmp, 'a.mp4'), 100, f)).toBe(10);
        expect(seen.redirect).toBe('manual');
        expect(seen.credentials).toBe('omit');
        expect(Object.keys(seen.headers).map((k) => k.toLowerCase())).not.toContain('cookie');
        expect(Object.keys(seen.headers).map((k) => k.toLowerCase())).not.toContain('authorization');
    });
    test('refuses other hosts before any request', async () => {
        let called = false;
        const f = (async () => {
            called = true;
            return new Response('x');
        }) as unknown as typeof fetch;
        await expect(downloadCdn('https://example.com/v.mp4', path.join(tmp, 'b.mp4'), 100, f)).rejects.toThrow(/not an Instagram CDN/);
        expect(called).toBe(false);
    });
    test('a redirect is an error', async () => {
        await expect(downloadCdn(url, path.join(tmp, 'c.mp4'), 100, reply(null, { status: 302, headers: { location: 'https://example.com/' } }))).rejects.toThrow(/redirect/);
    });
    test('429 stops', async () => {
        await expect(downloadCdn(url, path.join(tmp, 'd.mp4'), 100, reply(null, { status: 429 }))).rejects.toThrow(/429/);
    });
    test('the size cap deletes the partial file', async () => {
        const dest = path.join(tmp, 'e.mp4');
        await expect(downloadCdn(url, dest, 50, reply(new Uint8Array(500), { status: 200 }))).rejects.toThrow(/max-bytes/);
        expect(existsSync(dest)).toBe(false);
    });
});

describe('media payload', () => {
    const vv = [
        { url: 'https://a.fbcdn.net/1', width: 480, height: 854, bandwidth: 900, type: 103 },
        { url: 'https://a.fbcdn.net/2', width: 720, height: 1280, bandwidth: 1500, type: 102 },
        { url: 'https://a.fbcdn.net/3', width: 720, height: 1280, bandwidth: 2500, type: 101, url_expiration_timestamp_us: 1_800_000_000_000_000 },
    ];
    test('picks the largest picture, then the highest bandwidth', () => {
        const v = pickVariant(vv)!;
        expect(v.url).toBe('https://a.fbcdn.net/3');
        expect(v.expiresAt).toBe(new Date(1_800_000_000_000).toISOString());
        expect(pickVariant([])).toBeNull();
        expect(pickVariant(undefined)).toBeNull();
    });
    test('mentions come from the caption', () => {
        expect(parseMentions('Thanks @Some.User and @other_1! mail me at a@b.com. (@last.)')).toEqual(['some.user', 'other_1', 'last']);
    });
    test('audio attribution paths', () => {
        expect(audioAttribution({ clips_metadata: { music_info: { music_asset_info: { title: 'T', display_artist: 'A' } } } }).attribution).toMatchObject({ kind: 'licensed_music', title: 'T', artist: 'A' });
        expect(audioAttribution({ clips_metadata: { original_sound_info: { original_audio_title: 'Original audio', ig_artist: { username: 'me' } } } }).attribution).toMatchObject({ kind: 'original_audio', artist: 'me' });
        expect(audioAttribution({ music_metadata: { music_info: { music_asset_info: { title: 'S' } } } }).source).toBe('music_metadata.music_info');
        expect(audioAttribution({ music_metadata: { music_info: null } })).toEqual({ attribution: null, source: 'not_present' });
        expect(audioAttribution({})).toEqual({ attribution: null, source: 'not_present' });
    });
    const carousel = { pk: '99', carousel_media: [{ media_type: 1, image_versions2: { candidates: [] } }, { media_type: 2, video_duration: 4.2, video_versions: vv }, { media_type: 2, video_duration: 9, video_versions: [vv[0]] }] };
    test('a carousel needs --item and lists its children', () => {
        try {
            selectItem(carousel);
            throw new Error('should have thrown');
        } catch (e) {
            expect(e).toBeInstanceOf(SelectionError);
            expect((e as SelectionError).children).toEqual([{ index: 1, kind: 'photo', durationSec: null }, { index: 2, kind: 'video', durationSec: 4.2 }, { index: 3, kind: 'video', durationSec: 9 }]);
        }
    });
    test('carousel selection rules', () => {
        expect(() => selectItem(carousel, 1)).toThrow(/photo/);
        expect(() => selectItem(carousel, 4)).toThrow(/out of range/);
        expect(() => selectItem(carousel, 0)).toThrow(/out of range/);
        const s = selectItem(carousel, 3);
        expect(s.media).toBe(carousel.carousel_media[2]);
        expect(s.collection).toEqual({ pk: '99', count: 3, item_index: 3 });
        expect(selectItem({ video_versions: vv }).collection).toBeNull();
        expect(() => selectItem({ video_versions: vv }, 2)).toThrow(/single item/);
    });
    test('buildMeta for a story-shaped item', () => {
        const raw = { pk: '1', product_type: 'story', media_type: 2, video_duration: 43.766, has_audio: true, video_versions: vv, image_versions2: { candidates: [{ url: 'https://a.fbcdn.net/c', width: 640 }] }, music_metadata: { music_info: null }, caption: null };
        const { meta, variant, coverUrl } = buildMeta(raw, { caption: 'Hi @bob #x', hashtags: ['x'], owner: 'me', url: 'u', shortcode: 's' }, 'ref');
        expect(variant.width).toBe(720);
        expect(coverUrl).toBe('https://a.fbcdn.net/c');
        expect(meta).toMatchObject({ owner: 'me', product_type: 'story', duration_sec: 43.766, has_audio: true, mentions: ['bob'], hashtags: ['x'], audio_attribution: null, attribution_source: 'not_present', collection: null });
        expect(JSON.stringify(meta)).not.toContain('fbcdn.net/3');
    });
    test('a photo post is refused', () => {
        expect(() => buildMeta({ media_type: 1 }, {}, 'ref')).toThrow(/no video/);
    });
});

// ---------- shots ----------

describe('process runner', () => {
    test('fullStderr keeps every line; the default keeps only the tail', async () => {
        const script = "for (let i = 0; i < 12000; i++) process.stderr.write('n:' + i + ' pts_time:' + (i / 60).toFixed(6) + ' ' + 'x'.repeat(40) + String.fromCharCode(10))";
        const full = await run(process.execPath, ['-e', script], { fullStderr: true });
        expect([...full.stderr.matchAll(/pts_time:([0-9.]+)/g)].length).toBe(12000);
        const tail = await run(process.execPath, ['-e', script]);
        expect(tail.stderr.length).toBeLessThanOrEqual(400_000);
        expect(tail.stderr).toMatch(/n:11999 /);
    }, 60_000);
});


describe('cuts', () => {
    test('merge drops cuts too close to each other or to the ends', () => {
        expect(mergeCuts([5, 0.1, 2, 2.1, 2.2, 9.9, 5], 10)).toEqual([2, 5]);
        expect(mergeCuts([], 10)).toEqual([]);
    });
    test('overrides add and remove', () => {
        expect(applyOverrides([2, 5], { add: [7.5], remove: [5.05] }, 10)).toEqual([2, 7.5]);
        expect(applyOverrides([2], { add: [0, 10, 12], remove: [] }, 10)).toEqual([2]);
    });
    test('the newest correction wins: a manual cut can be removed again', () => {
        const added = recordOverrides({ add: [], remove: [] }, [3], []);
        expect(added).toEqual({ add: [3], remove: [] });
        const removed = recordOverrides(added, [], [3.05]);
        expect(removed).toEqual({ add: [], remove: [3.05] });
        expect(applyOverrides([2, 4], removed, 6)).toEqual([2, 4]);
        // The same boundary may also be detected: the removal must hold against it too.
        expect(applyOverrides([2, 3, 4], removed, 6)).toEqual([2, 4]);
        expect(recordOverrides(removed, [3], [])).toEqual({ add: [3], remove: [] });
        expect(recordOverrides({ add: [], remove: [] }, [3], [3])).toEqual({ add: [3], remove: [] });
        const dropDetected = recordOverrides({ add: [], remove: [] }, [], [4]);
        expect(applyOverrides([2, 4], dropDetected, 6)).toEqual([2]);
        expect(recordOverrides(dropDetected, [4], [])).toEqual({ add: [4], remove: [] });
    });
    test('spans', () => {
        expect(spans([2, 5], 10)).toEqual([{ id: 1, start: 0, end: 2, duration: 2 }, { id: 2, start: 2, end: 5, duration: 3 }, { id: 3, start: 5, end: 10, duration: 5 }]);
    });
});

const W = GRAY_W;
const H = GRAY_H;
const blank = (v: number) => new Uint8Array(W * H).fill(v);

describe('motion hint', () => {
    const shot = { start: 0, end: 3, duration: 3 };
    test('identical frames are low motion', () => {
        const frames = Array.from({ length: 24 }, () => blank(90));
        expect(motionForShot(frames, pairStats(frames), shot)).toEqual({ static_ratio: 1, first_last_mad: 0, max_block_mad: 0, low_motion: true });
    });
    test('a slow low-contrast edge is NOT low motion (every pair under the threshold)', () => {
        const frames = Array.from({ length: 24 }, (_, f) => {
            const a = blank(100);
            for (let y = 0; y < H; y++) for (let x = f * 6; x < W; x++) a[y * W + x] = 110;
            return a;
        });
        const pairs = pairStats(frames);
        expect(Math.max(...pairs.map((p) => p.mad))).toBeLessThan(1);
        const m = motionForShot(frames, pairs, shot);
        expect(m.static_ratio).toBe(1);
        expect(m.first_last_mad!).toBeGreaterThan(5);
        expect(m.low_motion).toBe(false);
    });
    test('a small object moving inside one cell is NOT low motion (first and last frames equal)', () => {
        const frames = Array.from({ length: 25 }, (_, f) => {
            const a = blank(0);
            const x0 = 10 + 3 * (f % 2);
            for (let y = 5; y < 11; y++) for (let x = x0; x < x0 + 6; x++) a[y * W + x] = 255;
            return a;
        });
        const m = motionForShot(frames, pairStats(frames), { start: 0, end: 3.125, duration: 3.125 });
        expect(m.static_ratio).toBe(1);
        expect(m.first_last_mad).toBe(0);
        expect(m.max_block_mad!).toBeGreaterThan(3);
        expect(m.low_motion).toBe(false);
    });
    test('too short to measure is null, not false', () => {
        const frames = Array.from({ length: 24 }, () => blank(90));
        expect(motionForShot(frames, pairStats(frames), { start: 0, end: 0.3, duration: 0.3 }).low_motion).toBeNull();
    });
});

describe('text-change candidates', () => {
    const withBand = (v: number, y0: number, y1: number) => {
        const a = blank(40);
        for (let y = Math.round(y0 * H); y < Math.round(y1 * H); y++) for (let x = 20; x < 140; x++) a[y * W + x] = v;
        return a;
    };
    test('a band that changes on a still frame is one candidate per change', () => {
        const frames = [
            ...Array.from({ length: 8 }, () => withBand(40, 0.7, 0.85)),
            ...Array.from({ length: 8 }, () => withBand(240, 0.7, 0.85)),
            ...Array.from({ length: 8 }, () => withBand(120, 0.7, 0.8)),
        ];
        expect(textCandidates(pairStats(frames), [])).toEqual([{ t: 1, band: 'bottom' }, { t: 2, band: 'bottom' }]);
    });
    test('changes closer than 0.5 s are one cluster', () => {
        const frames = Array.from({ length: 16 }, (_, f) => withBand(f >= 8 && f <= 10 ? 60 + f * 20 : f > 10 ? 255 : 40, 0.7, 0.85));
        expect(textCandidates(pairStats(frames), []).length).toBe(1);
    });
    test('a whole-frame change is not a text candidate, and neither is a change across a cut', () => {
        const whole = [...Array.from({ length: 8 }, () => blank(20)), ...Array.from({ length: 8 }, () => blank(200))];
        expect(textCandidates(pairStats(whole), [])).toEqual([]);
        const frames = [...Array.from({ length: 8 }, () => withBand(40, 0.7, 0.85)), ...Array.from({ length: 8 }, () => withBand(240, 0.7, 0.85))];
        expect(textCandidates(pairStats(frames), [0.95])).toEqual([]);
    });
});

describe('frame-difference cuts', () => {
    test('an isolated spike is a cut; sustained motion and spikes next to a scene cut are not', () => {
        const still = Array.from({ length: 24 }, () => blank(30));
        const other = Array.from({ length: 24 }, () => blank(120));
        expect(diffCuts(pairStats([...still, ...other]), [])).toEqual([2.938]);
        expect(diffCuts(pairStats([...still, ...other]), [3.0])).toEqual([]);
        const busy = Array.from({ length: 48 }, (_, f) => blank(f % 2 ? 30 : 120));
        expect(diffCuts(pairStats(busy), [])).toEqual([]);
    });
});

// ---------- audio ----------

function clicks(bpm: number, seconds: number, delay = 0): Float32Array {
    const x = new Float32Array(Math.round(seconds * SR));
    const period = 60 / bpm;
    for (let t = delay; t < seconds; t += period) {
        const s = Math.round(t * SR);
        for (let i = 0; i < 220 && s + i < x.length; i++) x[s + i] = Math.sin((2 * Math.PI * 1000 * i) / SR) * Math.exp(-i / 60) * 0.8;
    }
    return x;
}
function rng(seed: number) {
    let s = seed >>> 0;
    return () => {
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
        return s / 2 ** 32;
    };
}

describe('audio', () => {
    test('FFT finds a sine at its bin', () => {
        const n = 1024;
        const re = new Float64Array(n);
        const im = new Float64Array(n);
        for (let i = 0; i < n; i++) re[i] = Math.sin((2 * Math.PI * 64 * i) / n);
        fft(re, im);
        const mag = Array.from({ length: n / 2 }, (_, k) => Math.hypot(re[k], im[k]));
        expect(mag.indexOf(Math.max(...mag))).toBe(64);
        expect(mag[64]).toBeCloseTo(n / 2, 3);
        expect(mag[10]).toBeLessThan(1e-6);
    });
    test('120 BPM clicks: tempo within 1 BPM despite integer lags', () => {
        const a = analyseSamples(clicks(120, 12), [2, 4.03, 7.3]);
        expect(a.rhythm).not.toBeNull();
        expect(Math.abs(a.rhythm!.bpm - 120)).toBeLessThanOrEqual(1);
        expect(a.rhythm!.beat_consistency).toBeGreaterThan(0.9);
        expect(a.cuts_on_beat_ratio).toBeCloseTo(2 / 3, 2);
    });
    test('tempo stays inside 60-180 BPM across the range, with and without a delay', () => {
        for (const bpm of [62, 75, 100, 133, 150, 176, 180]) {
            for (const delay of [0, 0.21]) {
                const a = analyseSamples(clicks(bpm, 12, delay), []);
                if (a.rhythm === null) continue; // no result is acceptable, an alias is not
                expect(Math.abs(a.rhythm.bpm - bpm)).toBeLessThanOrEqual(1.5);
            }
        }
        expect(analyseSamples(clicks(176, 12, 0.21), []).rhythm).not.toBeNull();
        expect(analyseSamples(clicks(100, 12), []).rhythm).not.toBeNull();
    });
    test('90 BPM clicks', () => {
        const a = analyseSamples(clicks(90, 12), []);
        expect(Math.abs(a.rhythm!.bpm - 90)).toBeLessThanOrEqual(1);
        expect(a.cuts_on_beat_ratio).toBeNull();
    });
    test('a delayed click track keeps its tempo and reports the phase', () => {
        const a = analyseSamples(clicks(120, 12, 0.21), []);
        expect(Math.abs(a.rhythm!.bpm - 120)).toBeLessThanOrEqual(1);
        const beat = a.rhythm!.beats.find((b) => Math.abs(b - 0.21 - Math.round((b - 0.21) / 0.5) * 0.5) < 0.05);
        expect(beat).toBeDefined();
        const ph = a.rhythm!.phase_s % 0.5;
        expect(Math.min(Math.abs(ph - 0.21), Math.abs(ph - 0.21 + 0.5), Math.abs(ph - 0.21 - 0.5))).toBeLessThan(0.05);
    });
    test('digital silence, a sustained tone and a short clip give no tempo', () => {
        expect(analyseSamples(new Float32Array(6 * SR), [])).toMatchObject({ rhythm: null, rhythm_reason: 'silent_stream', rms_dbfs: null, speech_band_ratio: null });
        const tone = new Float32Array(6 * SR);
        for (let i = 0; i < tone.length; i++) tone[i] = 0.3 * Math.sin((2 * Math.PI * 440 * i) / SR);
        expect(analyseSamples(tone, []).rhythm).toBeNull();
        expect(analyseSamples(clicks(120, 2), [])).toMatchObject({ rhythm: null, rhythm_reason: 'too_short' });
    });
    test('aperiodic noise bursts (speech-like) and plain noise give no tempo', () => {
        const r = rng(7);
        const x = new Float32Array(12 * SR);
        let t = 0.1;
        while (t < 11.5) {
            const len = Math.round((0.05 + r() * 0.2) * SR);
            const s = Math.round(t * SR);
            for (let i = 0; i < len && s + i < x.length; i++) x[s + i] = (r() * 2 - 1) * 0.4;
            t += 0.12 + r() * 0.75;
        }
        expect(analyseSamples(x, []).rhythm).toBeNull();
        const noise = new Float32Array(8 * SR);
        for (let i = 0; i < noise.length; i++) noise[i] = (r() * 2 - 1) * 0.3;
        expect(analyseSamples(noise, []).rhythm).toBeNull();
    });
    test('a weak aperiodic envelope cannot pass on relative strength alone', () => {
        // The round-3 review counterexample: many onsets, tiny autocorrelation, strength over 2.
        const r = rng(3);
        const env = new Float64Array(1300);
        for (let i = 0; i < env.length; i++) env[i] = Math.max(0, r() + r() + r() - 1.9);
        const onsets = pickOnsets(env);
        expect(onsets.length).toBeGreaterThan(8);
        const est = estimateRhythm(env, onsets, env.length / (SR / 512), -20);
        expect(est.rhythm).toBeNull();
        expect(est.reason).toBe('weak_rhythm');
    });
    test('alignedRatio', () => {
        expect(alignedRatio([1, 2, 3], [1.05, 2.2])).toBeCloseTo(1 / 3, 3);
        expect(alignedRatio([], [1])).toBeNull();
        expect(alignedRatio([1], [])).toBeNull();
    });
});

// ---------- transcript ----------

describe('transcript', () => {
    test('command template: tokenise first, then substitute', () => {
        expect(tokenize(`python "C:/my tools/asr.py" --in {audio} --out '{out}.json' ""`)).toEqual(['python', 'C:/my tools/asr.py', '--in', '{audio}', '--out', '{out}.json', '']);
        expect(buildArgv('asr --in={audio} -o {out}.srt', { audio: 'C:/a b/x y.wav; rm -rf /', out: 'C:/a b/out' })).toEqual(['asr', '--in=C:/a b/x y.wav; rm -rf /', '-o', 'C:/a b/out.srt']);
        expect(() => tokenize('asr "unclosed')).toThrow(/Unclosed/);
        expect(() => buildArgv('asr {audio}', { audio: 'a', out: 'b' })).toThrow(/\{out\}/);
        expect(() => buildArgv('', {})).toThrow(/empty/);
    });
    const srt = '1\n00:00:00,500 --> 00:00:02,000\nHello <i>there</i>\nsecond line\n\n2\n00:00:02,500 --> 00:00:04,000\nBye\n';
    const vtt = 'WEBVTT\n\nNOTE x\n\n00:01.000 --> 00:02.500 align:start\n<v Ana>Hola\n\n01:00:00.000 --> 01:00:01.000\nLate\n';
    test('SRT and WebVTT', () => {
        expect(parseCues(srt)).toEqual([{ start: 0.5, end: 2, text: 'Hello there second line' }, { start: 2.5, end: 4, text: 'Bye' }]);
        expect(parseCues(vtt)).toEqual([{ start: 1, end: 2.5, text: 'Hola', speaker: 'Ana' }, { start: 3600, end: 3601, text: 'Late' }]);
    });
    test('JSON shapes', () => {
        expect(normalizeJson({ language: 'en', segments: [{ start: 0, end: 1, text: ' a ' }, { start: 'x', end: 2, text: 'bad' }] })).toMatchObject({ language: 'en', segments: [{ start: 0, end: 1, text: 'a' }] });
        expect(normalizeJson({ text: 'a b', chunks: [{ timestamp: [0, 1.2], text: ' a' }, { timestamp: [1.2, null], text: ' b' }] }).segments).toEqual([{ start: 0, end: 1.2, text: 'a' }, { start: 1.2, end: 1.2, text: 'b' }]);
        expect(normalizeJson({ transcription: [{ offsets: { from: 1500, to: 2500 }, text: ' hi' }] }).segments).toEqual([{ start: 1.5, end: 2.5, text: 'hi' }]);
        expect(() => normalizeJson({ foo: 1 })).toThrow(/Unrecognised/);
    });
    test('format is sniffed from the content, BOM tolerated', () => {
        expect(parseTranscript(`\uFEFF${JSON.stringify({ segments: [{ start: 1, end: 2, text: 'x' }] })}`, 'out.srt', 's').segments.length).toBe(1);
        expect(parseTranscript(srt, 'out.json', 's').segments.length).toBe(2);
        expect(() => parseTranscript('just words', 'a.txt', 's')).toThrow(/not SRT/);
    });
    test('a recogniser run never picks up the output of an earlier run', async () => {
        const dir = mkdtempSync(path.join(os.tmpdir(), 'ig-bd-asr-'));
        try {
            const base = path.join(dir, 'asr_out');
            writeFileSync(`${base}.json`, JSON.stringify({ segments: [{ start: 0, end: 1, text: 'OLD' }] }));
            const tool = path.join(dir, 'fake asr.js');
            writeFileSync(tool, "require('fs').writeFileSync(process.argv[2] + '.srt', ['1', '00:00:01,000 --> 00:00:02,000', 'NEW', ''].join(String.fromCharCode(10)));");
            const t = await runRecogniser(`"${process.execPath}" "${tool}" {out} {audio}`, 'a.wav', base);
            expect(t.segments.map((s) => s.text)).toEqual(['NEW']);
            writeFileSync(`${base}.json`, JSON.stringify({ segments: [{ start: 0, end: 1, text: 'OLD' }] }));
            writeFileSync(tool, '0;');
            await expect(runRecogniser(`"${process.execPath}" "${tool}" {out} {audio}`, 'a.wav', base)).rejects.toThrow(/wrote none/);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    }, 60_000);
    test('segments go to the shot holding most of them', () => {
        const shots = [{ id: 1, start: 0, end: 2 }, { id: 2, start: 2, end: 5 }];
        const m = segmentsForShot([{ start: 0.2, end: 1.9, text: 'a' }, { start: 1.8, end: 3.5, text: 'b' }, { start: 4, end: 4, text: 'point' }, { start: 9, end: 10, text: 'late' }], shots);
        expect(m.get(1)!.map((s) => s.text)).toEqual(['a']);
        expect(m.get(2)!.map((s) => s.text)).toEqual(['b', 'point']);
    });
    test('chunks without a start time are dropped, not moved to 0', () => {
        expect(normalizeJson({ chunks: [{ timestamp: [null, null], text: 'x' }, { timestamp: [1, null], text: 'y' }] }).segments).toEqual([{ start: 1, end: 1, text: 'y' }]);
        expect(normalizeJson({ segments: [{ start: null, end: 2, text: 'x' }] }).segments).toEqual([]);
    });
});

// ---------- review ----------

function fakeBreakdown(overrides: Partial<Breakdown> = {}): Breakdown {
    const img = (id: number) => ({ first: `shots/shot_00${id}_first.jpg`, last: `shots/shot_00${id}_last.jpg`, mid: `shots/shot_00${id}_mid.jpg`, sheet: `shots/shot_00${id}.jpg`, strip: `shots/shot_00${id}_strip.jpg`, first_t: 0, mid_t: 0, last_t: 0, strip_fps: 2, strip_times: [], timestamps_burned: true });
    const shots: Shot[] = [
        { id: 1, start: 0, end: 2, duration: 2, motion: { static_ratio: 1, first_last_mad: 0, max_block_mad: 0, low_motion: true }, text_change_candidates: [{ t: 1, band: 'bottom' }], images: img(1), review: null },
        { id: 2, start: 2, end: 6, duration: 4, motion: { static_ratio: 0.2, first_last_mad: 30, max_block_mad: 80, low_motion: false }, text_change_candidates: [], images: img(2), review: null },
    ];
    return {
        schema: 'ig.breakdown.v1', analysis_id: analysisId(6, [2]), generated_at: '', source: { origin: 'local_file', ref: 'x.mp4', caption: '', audio_attribution: null } as any,
        video: { duration: 6, width: 1080, height: 1920, fps: 30, rotation: 0, videoCodec: 'h264', audioCodec: 'aac', hasAudio: true, bitrate: null, formatName: 'mp4', encoder: null },
        cuts: { threshold: 0.3, detected: [2], from_frame_diff: [], added: [], removed: [], final: [2] }, pacing: pacing(shots, 6), shots,
        audio: { present: true, rhythm: { bpm: 120, periodicity: 0.5, beat_strength: 5, beat_consistency: 1, phase_s: 0, beats: [] }, cuts_on_beat_ratio: 1 } as any,
        storyboard: null, transcript: null, review: null, script: null, speech: { status: 'unconfirmed', reason: 'no_transcript' }, ...overrides,
    } as Breakdown;
}
const goodAnswers = () => ({
    analysis_id: analysisId(6, [2]),
    hook: 'A title card asks a question', visual_style: 'flat colours, bold captions',
    structure: [{ label: 'hook', start: 0, end: 2 }, { label: 'demo', start: 2, end: 6 }],
    cast: [{ id: 'host', description: 'person at a desk', appears_in: [2] }],
    audio_notes: { voice_present: 'unconfirmed', music_present: 'unconfirmed', evidence: {} },
    sound_cues: [], assets: [{ id: 'logo', kind: 'image', description: 'brand logo', used_in: [1], supply: 'user_must_supply' }],
    shots: [
        { id: 1, type: 'static_hold', confidence: 0.9, evidence: ['identical frames across the strip'], description: 'Title card', on_screen_text: [{ text: 'Tired?', role: 'title', position: 'center', start: 0, end: 1 }, { text: 'Try this', role: 'title', position: 'center', start: 1, end: 2 }], layers: [{ kind: 'logo', description: 'logo top left', position: 'top-left', start: 0, end: 2, asset: 'logo' }] },
        { id: 2, type: 'filmed', confidence: 0.7, evidence: ['hand-held shake, depth of field'], description: 'Host talks to camera', on_screen_text: [], layers: [] },
    ],
});
const tx = (segments: Transcript['segments']): Transcript => ({ schema: 'ig.transcript.v1', source: 'test', language: 'en', segments });

describe('apply-review', () => {
    test('a complete answer merges; script stays unconfirmed without a transcript', () => {
        const r = applyReview(fakeBreakdown(), goodAnswers(), null);
        expect(r.errors).toEqual([]);
        expect(r.ok).toBe(true);
        expect(r.breakdown!.script).toBeNull();
        expect(r.breakdown!.speech.status).toBe('unconfirmed');
        expect(r.breakdown!.shots[0].review!.on_screen_text.length).toBe(2);
        expect(r.breakdown!.review!.audio_notes).toMatchObject({ voice_present: 'unconfirmed', music_present: 'unconfirmed' });
    });
    test('answers written for another analysis are refused', () => {
        const a: any = goodAnswers();
        a.analysis_id = analysisId(6, [2, 4]);
        expect(applyReview(fakeBreakdown(), a, null).errors.join(' ')).toMatch(/another analysis/);
        delete a.analysis_id;
        expect(applyReview(fakeBreakdown(), a, null).ok).toBe(false);
        expect(analysisId(6, [2])).not.toBe(analysisId(6, [2.001]));
    });
    test('a transcript of another recording neither becomes the script nor confirms a voice', () => {
        const a = goodAnswers();
        a.audio_notes = { voice_present: true as any, music_present: 'unconfirmed', evidence: { voice: { source: 'transcript' } } } as any;
        const r = applyReview(fakeBreakdown(), a, tx([{ start: 50, end: 51, text: 'wrong clip' }]));
        expect(r.ok).toBe(true);
        expect(r.breakdown!.script).toEqual([]);
        expect(r.breakdown!.speech.status).toBe('none_transcribed');
        expect(r.breakdown!.speech.reason).toMatch(/another file/);
        expect(r.breakdown!.review!.audio_notes.voice_present).toBe('unconfirmed');
        const mixed = applyReview(fakeBreakdown(), a, tx([{ start: 1, end: 1.5, text: 'ok' }, { start: 50, end: 51, text: 'wrong clip' }]));
        expect(mixed.breakdown!.script!.map((l) => l.text)).toEqual(['ok']);
        expect(mixed.breakdown!.speech.reason).toMatch(/1 transcript segment/);
        const long = applyReview(fakeBreakdown(), a, tx([{ start: 1, end: 500, text: 'runs past the end' }]));
        expect(long.breakdown!.script).toEqual([{ shot: 2, start: 1, end: 6, text: 'runs past the end' }]);
    });
    test('the script is built from the transcript, never from answers', () => {
        const t = tx([{ start: 2.2, end: 4, text: 'Here is the trick.' }]);
        const r = applyReview(fakeBreakdown(), goodAnswers(), t);
        expect(r.breakdown!.script).toEqual([{ shot: 2, start: 2.2, end: 4, text: 'Here is the trick.' }]);
        const bad = { ...goodAnswers(), script: [{ text: 'made up' }] };
        expect(applyReview(fakeBreakdown(), bad, null).errors.join(' ')).toMatch(/no transcript/);
        const bad2 = goodAnswers();
        (bad2.shots[1] as any).spoken = 'made up';
        expect(applyReview(fakeBreakdown(), bad2, null).ok).toBe(false);
    });
    test('music cannot be confirmed from tempo or attribution', () => {
        for (const source of ['tempo', 'attribution', 'transcript', undefined]) {
            const a = goodAnswers();
            a.audio_notes = { voice_present: 'unconfirmed', music_present: true as any, evidence: source ? { music: { source, note: '120 BPM' } } : {} } as any;
            const r = applyReview(fakeBreakdown(), a, tx([{ start: 2.2, end: 4, text: 'x' }]));
            expect(r.ok).toBe(true);
            expect(r.breakdown!.review!.audio_notes.music_present).toBe('unconfirmed');
            expect(r.downgrades.join(' ')).toMatch(/music_present/);
        }
    });
    test('voice: transcript speech confirms presence; an empty or missing transcript never confirms absence', () => {
        const yes = goodAnswers();
        yes.audio_notes = { voice_present: true as any, music_present: 'unconfirmed', evidence: { voice: { source: 'transcript' } } } as any;
        expect(applyReview(fakeBreakdown(), yes, tx([{ start: 2.2, end: 4, text: 'x' }])).breakdown!.review!.audio_notes.voice_present).toBe(true);
        expect(applyReview(fakeBreakdown(), yes, tx([])).breakdown!.review!.audio_notes.voice_present).toBe('unconfirmed');
        const no = goodAnswers();
        no.audio_notes = { voice_present: false as any, music_present: 'unconfirmed', evidence: { voice: { source: 'transcript' } } } as any;
        for (const t of [tx([]), null]) {
            const r = applyReview(fakeBreakdown(), no, t);
            expect(r.breakdown!.review!.audio_notes.voice_present).toBe('unconfirmed');
            expect(r.downgrades.length).toBe(1);
        }
        expect(applyReview(fakeBreakdown(), no, tx([])).breakdown!.speech.status).toBe('none_transcribed');
    });
    test('the user listening, or a missing audio stream, is evidence', () => {
        const a = goodAnswers();
        a.audio_notes = { voice_present: false as any, music_present: true as any, evidence: { voice: { source: 'user_listened', note: 'user: nobody speaks' }, music: { source: 'user_listened', note: 'user: lo-fi beat throughout' } } } as any;
        const r = applyReview(fakeBreakdown(), a, null);
        expect(r.breakdown!.review!.audio_notes).toMatchObject({ voice_present: false, music_present: true });
        expect(r.downgrades).toEqual([]);
        const noNote = goodAnswers();
        noNote.audio_notes = { voice_present: 'unconfirmed', music_present: true as any, evidence: { music: { source: 'user_listened' } } } as any;
        expect(applyReview(fakeBreakdown(), noNote, null).breakdown!.review!.audio_notes.music_present).toBe('unconfirmed');
        const silent = goodAnswers();
        silent.audio_notes = { voice_present: false as any, music_present: false as any, evidence: { voice: { source: 'no_audio_stream' }, music: { source: 'no_audio_stream' } } } as any;
        expect(applyReview(fakeBreakdown(), silent, null).breakdown!.review!.audio_notes.music_present).toBe('unconfirmed');
        expect(applyReview(fakeBreakdown({ audio: { present: false } as any }), silent, null).breakdown!.review!.audio_notes).toMatchObject({ voice_present: false, music_present: false });
    });
    test('low motion never rejects a type, but asks what moves', () => {
        const a = goodAnswers();
        a.shots[0].type = 'ai_video';
        const r = applyReview(fakeBreakdown(), a, null);
        expect(r.ok).toBe(false);
        expect(r.errors.join(' ')).toMatch(/motion_note/);
        (a.shots[0] as any).motion_note = 'steam rises slowly in the top right corner';
        const r2 = applyReview(fakeBreakdown(), a, null);
        expect(r2.ok).toBe(true);
        expect(r2.breakdown!.shots[0].review!.type).toBe('ai_video');
        expect(r2.warnings.join(' ')).toMatch(/low motion/);
    });
    test('validation errors write nothing', () => {
        const a: any = goodAnswers();
        a.shots[0].type = 'hologram';
        a.shots[0].on_screen_text[0].end = 9;
        a.shots[0].layers[0].asset = 'nope';
        a.shots[1].evidence = [];
        a.shots.push({ id: 7, type: 'filmed' });
        a.assets[0].supply = 'steal';
        const r = applyReview(fakeBreakdown(), a, null);
        expect(r.ok).toBe(false);
        expect(r.breakdown).toBeUndefined();
        const all = r.errors.join('\n');
        for (const re of [/hologram/, /inside the shot/, /not declared in assets/, /evidence needs/, /7 is not a shot/, /supply must be/]) expect(all).toMatch(re);
        const missing: any = goodAnswers();
        missing.shots.pop();
        expect(applyReview(fakeBreakdown(), missing, null).errors).toContain('shot 2 has no answer.');
    });
    test('fewer text items than candidates is a warning that names the frames command', () => {
        const a = goodAnswers();
        a.shots[0].on_screen_text = [];
        const r = applyReview(fakeBreakdown(), a, null);
        expect(r.ok).toBe(true);
        expect(r.warnings.join(' ')).toMatch(/frames <dir> --from 0 --to 2/);
    });
    test('split_at reports the missed cut and applies nothing', () => {
        const a: any = goodAnswers();
        a.shots[1] = { id: 2, split_at: [4.1] };
        const r = applyReview(fakeBreakdown(), a, null);
        expect(r).toMatchObject({ ok: false, errors: [], splits: [4.1] });
        expect(r.breakdown).toBeUndefined();
        a.shots[1] = { id: 2, split_at: [2.0] };
        expect(applyReview(fakeBreakdown(), a, null).errors.join(' ')).toMatch(/strictly inside/);
    });
    test('summary and recreate plan stay within the evidence', () => {
        const b = applyReview(fakeBreakdown(), goodAnswers(), null).breakdown!;
        const s = summaryText(b);
        expect(s).toMatch(/Voice: unconfirmed\. Music: unconfirmed\./);
        expect(s).toMatch(/unconfirmed: no transcript/);
        expect(s).toMatch(/"Try this"/);
        const md = recreateMarkdown(b, { ffmpeg: '9.0', comfy: null });
        expect(md).toMatch(/Static card/);
        expect(md).toMatch(/Film it/);
        expect(md).toMatch(/shots\/shot_002_first\.jpg/);
        expect(md).toMatch(/You must supply/);
        expect(md).toMatch(/comfy` CLI: not found/);
        expect(() => recreateMarkdown(fakeBreakdown(), { ffmpeg: null, comfy: null })).toThrow(/not been reviewed/);
        expect(buildScript(b.shots, tx([])).speech.status).toBe('none_transcribed');
    });
});

// ---------- media fixtures (ffmpeg) ----------

describe.skipIf(!HAS_FFMPEG)('media fixtures', () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'ig-bd-fx-'));
    const ff = (args: string[]) => {
        const r = spawnSync('ffmpeg', ['-hide_banner', '-v', 'error', '-y', ...args]);
        if (r.status !== 0) throw new Error(r.stderr.toString());
    };
    const size = '360x640';
    const fx = (n: string) => path.join(tmp, n);
    const cli = (...args: string[]) => {
        const r = spawnSync(process.execPath, [MAIN, ...args], { encoding: 'utf8' });
        return { code: r.status, out: r.stdout, json: (() => { try { return JSON.parse(r.stdout); } catch { return null; } })() };
    };
    let drawtext = true;

    beforeAll(() => {
        // A: three colour segments of different brightness (cut detection reads luma), a 120 BPM click (cuts at 2 s and 4 s, on the beat).
        ff(['-f', 'lavfi', '-i', `color=c=red:s=${size}:d=2:r=30`, '-f', 'lavfi', '-i', `color=c=yellow:s=${size}:d=2:r=30`, '-f', 'lavfi', '-i', `color=c=blue:s=${size}:d=2:r=30`,
            '-f', 'lavfi', '-i', "aevalsrc='if(lt(mod(t,0.5),0.01),sin(2*PI*1000*t),0)':d=6:s=22050",
            '-filter_complex', '[0][1][2]concat=n=3:v=1:a=0[v]', '-map', '[v]', '-map', '3:a', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', fx('a.mp4')]);
        // B: no audio stream.
        ff(['-f', 'lavfi', '-i', `testsrc2=s=${size}:d=3:r=30`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', fx('b.mp4')]);
        // E: a still image for 3 s, then a moving pattern for 3 s.
        ff(['-f', 'lavfi', '-i', `color=c=gray:s=${size}:d=3:r=30`, '-f', 'lavfi', '-i', `testsrc2=s=${size}:d=3:r=30`, '-filter_complex', '[0][1]concat=n=2:v=1:a=0[v]', '-map', '[v]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', fx('e.mp4')]);
        // F: one static shot whose caption changes at 1 s and 2 s.
        const dt = (text: string, when: string) => `drawtext=text='${text}':enable='${when}':x=(w-tw)/2:y=h*0.74:fontsize=64:fontcolor=white`;
        try {
            ff(['-f', 'lavfi', '-i', `color=c=0x202020:s=${size}:d=3:r=30`, '-vf', [dt('ONE', 'lt(t,1)'), dt('TWO WORDS', 'between(t,1,1.999)'), dt('THREE NOW', 'gte(t,2)')].join(','), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', fx('f.mp4')]);
        } catch {
            drawtext = false;
            console.warn('[video-breakdown] this ffmpeg cannot draw text: caption fixture skipped.');
        }
    }, 120_000);
    afterAll(() => rmSync(tmp, { recursive: true, force: true }));

    test('A: exactly two cuts within one frame', async () => {
        const facts = await probe(fx('a.mp4'));
        expect(facts.hasAudio).toBe(true);
        const cuts = mergeCuts(await detectCuts(fx('a.mp4'), 0.3), facts.duration);
        expect(cuts.length).toBe(2);
        expect(Math.abs(cuts[0] - 2)).toBeLessThanOrEqual(1 / 30 + 0.001);
        expect(Math.abs(cuts[1] - 4)).toBeLessThanOrEqual(1 / 30 + 0.001);
    }, 60_000);

    test('E: still then moving', async () => {
        const frames = await grayFrames(fx('e.mp4'));
        const pairs = pairStats(frames);
        expect(motionForShot(frames, pairs, { start: 0, end: 3, duration: 3 }).low_motion).toBe(true);
        expect(motionForShot(frames, pairs, { start: 3, end: 6, duration: 3 }).low_motion).toBe(false);
    }, 60_000);

    test('F: caption changes are candidates, not cuts', async () => {
        if (!drawtext) return;
        const facts = await probe(fx('f.mp4'));
        const scene = mergeCuts(await detectCuts(fx('f.mp4'), 0.3), facts.duration);
        const pairs = pairStats(await grayFrames(fx('f.mp4')));
        expect(scene).toEqual([]);
        expect(diffCuts(pairs, scene)).toEqual([]);
        const c = textCandidates(pairs, scene);
        expect(c.length).toBe(2);
        expect(c.map((x) => x.band)).toEqual(['bottom', 'bottom']);
        expect(Math.abs(c[0].t - 1)).toBeLessThanOrEqual(0.25);
        expect(Math.abs(c[1].t - 2)).toBeLessThanOrEqual(0.25);
    }, 60_000);

    test('CLI end to end on a local file', () => {
        const out = fx('run-a');
        expect(cli('fetch', '--file', fx('a.mp4'), '-o', out).json).toMatchObject({ ok: true });
        const an = cli('analyze', out).json;
        expect(an).toMatchObject({ ok: true, shots: 3, speech: 'unconfirmed', audio: { present: true } });
        expect(Math.abs(an.audio.bpm - 120)).toBeLessThanOrEqual(2);
        const b = JSON.parse(readFileSync(path.join(out, 'breakdown.json'), 'utf8')) as Breakdown;
        expect(b.audio.cuts_on_beat_ratio).toBe(1);
        expect(b.shots.every((s) => s.motion.low_motion === true)).toBe(true);
        for (const s of b.shots) for (const f of [s.images.first, s.images.last, s.images.sheet, s.images.strip]) expect(existsSync(path.join(out, f))).toBe(true);
        expect(existsSync(path.join(out, 'storyboard.jpg'))).toBe(true);
        expect(existsSync(path.join(out, 'source', 'audio.wav'))).toBe(true);

        expect(cli('transcribe', out).code).toBe(2);
        writeFileSync(fx('t.srt'), '1\n00:00:00,300 --> 00:00:01,800\nRed means stop.\n\n2\n00:00:04,200 --> 00:00:05,500\nBlue means calm.\n');
        expect(cli('transcribe', out, '--import', fx('t.srt')).json).toMatchObject({ ok: true, segments: 2 });

        expect(cli('review', out).json).toMatchObject({ ok: true, shots: 3, answers_created: true });
        const tasks = JSON.parse(readFileSync(path.join(out, 'review_tasks.json'), 'utf8'));
        expect(tasks.shots[2].transcript[0].text).toBe('Blue means calm.');
        const answers = JSON.parse(readFileSync(path.join(out, 'review_answers.json'), 'utf8'));
        expect(cli('apply-review', out).code).toBe(1);
        answers.hook = 'A red card';
        answers.visual_style = 'flat colour cards';
        answers.structure = [{ label: 'cards', start: 0, end: 6 }];
        answers.audio_notes = { voice_present: true, music_present: true, evidence: { voice: { source: 'transcript' }, music: { source: 'tempo' } } };
        answers.shots = b.shots.map((s) => ({ id: s.id, type: 'static_hold', confidence: 0.9, evidence: ['one flat colour in every tile'], description: 'Flat colour card', on_screen_text: [], layers: [] }));
        writeFileSync(path.join(out, 'review_answers.json'), JSON.stringify(answers));
        const ap = cli('apply-review', out);
        expect(ap.json).toMatchObject({ ok: true });
        expect(ap.json.downgrades.join(' ')).toMatch(/music_present/);
        const sum = cli('summary', out);
        expect(sum.code).toBe(0);
        expect(sum.out).toMatch(/Voice: yes\. Music: unconfirmed\./);
        expect(sum.out).toMatch(/\[shot 1\] Red means stop\./);
        expect(sum.out).toMatch(/\[shot 3\] Blue means calm\./);
        expect(readFileSync(path.join(out, 'recreate.md'), 'utf8')).toMatch(/Static card/);

        const fr = cli('frames', out, '--from', '1.5', '--to', '2.5', '--fps', '4').json;
        expect(fr.ok).toBe(true);
        expect(fr.times.length).toBe(4);
        expect(existsSync(fr.image)).toBe(true);

        // A new transcript clears the applied review; the kept answers are re-applied against it.
        writeFileSync(fx('empty.srt'), '');
        writeFileSync(fx('empty.json'), JSON.stringify({ segments: [] }));
        expect(cli('transcribe', out, '--import', fx('empty.json')).json.next).toMatch(/earlier review was cleared/);
        expect((JSON.parse(readFileSync(path.join(out, 'breakdown.json'), 'utf8')) as Breakdown).review).toBeNull();
        const again = cli('apply-review', out).json;
        expect(again.ok).toBe(true);
        expect(again.downgrades.join(' ')).toMatch(/voice_present/);
        expect(cli('summary', out).out).toMatch(/Voice: unconfirmed/);
        expect(cli('analyze', out, '--max-duration', '3').code).toBe(2);

        // A manual cut is remembered, can be undone, and old answers cannot be applied to new shots.
        expect(cli('analyze', out, '--add-cut', '5').json).toMatchObject({ ok: true, shots: 4 });
        expect(cli('analyze', out).json.shots).toBe(4);
        expect(cli('apply-review', out).json.errors.join(' ')).toMatch(/another analysis/);
        const rv = cli('review', out).json;
        expect(rv.answers_created).toBe(true);
        expect(existsSync(rv.stale_answers_moved_to)).toBe(true);
        expect(cli('analyze', out, '--remove-cut', '5').json.shots).toBe(3);
        expect(cli('analyze', out).json.shots).toBe(3);
        expect(cli('analyze', out, '--add-cut', '5').json.shots).toBe(4);
        expect(cli('analyze', out, '--reset-cuts').json.shots).toBe(3);
    }, 240_000);

    test('B: a video without an audio stream', () => {
        const out = fx('run-b');
        cli('fetch', '--file', fx('b.mp4'), '-o', out);
        expect(cli('analyze', out).json).toMatchObject({ ok: true, audio: { present: false, bpm: null } });
        const b = JSON.parse(readFileSync(path.join(out, 'breakdown.json'), 'utf8')) as Breakdown;
        expect(b.audio).toMatchObject({ present: false, rhythm: null, onsets: null, wav: null });
        expect(cli('transcribe', out, '--cmd', 'x {audio} {out}').code).toBe(2);
    }, 120_000);

    test('usage errors are JSON with exit 2', () => {
        expect(cli('analyze', fx('nope')).code).toBe(2);
        expect(cli('bogus').code).toBe(2);
        expect(cli('fetch', 'abc').code).toBe(2);
    }, 60_000);
});

