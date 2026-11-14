// instagram-video-remake: shot cuts measured to the frame, and the rhythm of 24 fps material carried at 30 fps.
// The numbers in the pure tests are the ones measured on the production that showed both problems: a two-frame
// flash of the original person at a cut, and a far shot whose motion stalled two frames out of five.
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { MODEL_FPS, detectCuts, distinctFrames, modelSeconds, extraRepeats, frameMap, originalInSwappedScenes, repeatedFrames, scenes, stretchProblems } from '../../skills/instagram-video-remake/scripts/cadence.ts';
import * as ff from '../../skills/instagram-video-remake/scripts/ff.ts';
import { parseArgs } from '../../skills/instagram-video-remake/scripts/main.ts';

const TMP = mkdtempSync(path.join(os.tmpdir(), 'ig-cadence-'));
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0 && spawnSync('ffmpeg', ['-hide_banner', '-encoders']).stdout?.toString().includes('libx264');

// One repeat every fifth frame: 24 fps material at 30 fps.
const pulldown = (n: number, move = 4, phase = 0) => Array.from({ length: n }, (_, i) => ((i + phase) % 5 === 4 ? 0.1 : move + (i % 3) * 0.3));

describe('remake cuts and scenes', () => {
    test('a cut is a jump far above its neighbours, found to the frame', () => {
        const d = [1, 1, 0.8, 0.9, 0.8, 35.1, 3.6, 3.5, 0, 3.7, 3.4];
        // diffs[5] compares frames 5 and 6: the new shot starts at frame 6.
        expect(detectCuts(d)).toEqual([6]);
        // Fast motion is not a cut.
        expect(detectCuts([12, 14, 15, 13, 16, 14, 15, 12])).toEqual([]);
    });
    test('scenes are frame ranges between cuts', () => {
        expect(scenes([152, 302], 451)).toEqual([
            { n: 1, first: 0, end: 152 },
            { n: 2, first: 152, end: 302 },
            { n: 3, first: 302, end: 451 },
        ]);
    });
    test('a swap stretch that stops short of a cut or crosses one is named', () => {
        // The far shot of the production: frames 233-300, the cut at 302.
        expect(stretchProblems(233, 301, [152, 302])).toEqual(['it ends 1 frame(s) before the cut at frame 302; those frames would still show the original person']);
        // The close shot started at 303, one frame after the cut.
        expect(stretchProblems(303, 450, [152, 302])[0]).toMatch(/starts 1 frame\(s\) after the cut at frame 302/);
        expect(stretchProblems(290, 320, [302])[0]).toMatch(/crosses the cut at frame 302/);
        // Cut to cut, or well inside a shot: fine.
        expect(stretchProblems(152, 302, [152, 302])).toEqual([]);
        expect(stretchProblems(233, 302, [152, 302])).toEqual([]);
        expect(stretchProblems(200, 250, [152, 302])).toEqual([]);
    });
    test('the two-frame filler at the cut is found as original frames in swapped shots', () => {
        const found = originalInSwappedScenes(
            [
                { first: 0, end: 233, label: 'source:0-7.7667' },
                { first: 301, end: 303, label: 'source:10.0333-10.1' },
            ],
            [
                { id: 'far2', first: 233, end: 301 },
                { id: 'close', first: 303, end: 450 },
            ],
            scenes([152, 302], 451),
        );
        expect(found).toEqual([
            { label: 'source:0-7.7667', first: 152, end: 233, scene: 2, shots: ['far2'] },
            { label: 'source:10.0333-10.1', first: 301, end: 302, scene: 2, shots: ['far2'] },
            { label: 'source:10.0333-10.1', first: 302, end: 303, scene: 3, shots: ['close'] },
        ]);
    });
});

describe('remake options and timing checks', () => {
    test('the new switches take no value', () => {
        const { flags, pos } = parseArgs(['swap', 'run', '--all-frames', '--seed', '42', '--leave-original', '--allow-shift', '--allow-original']);
        expect(flags).toMatchObject({ 'all-frames': true, seed: '42', 'leave-original': true, 'allow-shift': true, 'allow-original': true });
        expect(pos).toEqual(['run']);
    });
    test('a few frames off the constant-rate grid are found even when the average rate looks right', () => {
        const even = Array.from({ length: 1000 }, (_, i) => i / 30);
        expect(ff.countUneven(even, 30)).toBe(0);
        // 996 frames over the same ticks: four early pictures missing, average 29.88 fps.
        const sparse = even.filter((_, i) => ![10, 20, 30, 40].includes(i));
        expect(ff.countUneven(sparse, 29.88)).toBeGreaterThan(0);
    });
});

describe('remake cadence', () => {
    test('repeats are near-zero differences where the neighbours move; a still scene has none', () => {
        expect(repeatedFrames(pulldown(20))).toEqual([5, 10, 15, 20]);
        expect(repeatedFrames(Array(20).fill(0.2))).toEqual([]);
        // A slow start still shows its repeats (measured: 1.6 2.0 2.2 2.4 2.4 0.5 2.8).
        expect(repeatedFrames([1.6, 2.0, 2.2, 2.4, 2.4, 0.5, 2.8, 2.8, 3.1, 3.4, 0.0, 3.8])).toEqual([6, 11]);
    });
    test('24 fps material at 30 fps sends only its distinct frames; real 30 fps material sends all', () => {
        const keep = distinctFrames(pulldown(67), 68, 30)!;
        expect(keep.length).toBe(68 - 13);
        expect(keep).not.toContain(5);
        expect(distinctFrames(Array(67).fill(4), 68, 30)).toBeNull();
        // 25 fps material in 30 fps is not 24-in-30.
        const fives = Array.from({ length: 59 }, (_, i) => (i % 6 === 5 ? 0.1 : 4));
        expect(distinctFrames(fives, 60, 30)).toBeNull();
        // A 24 fps source is never thinned.
        expect(distinctFrames(pulldown(67), 68, 24)).toBeNull();
    });
    test('the length asked of the model gives exactly the frames sent (the node counts floor(seconds * 24))', () => {
        for (let n = 1; n <= 360; n++) expect(Math.floor(modelSeconds(n) * MODEL_FPS)).toBe(n);
        // The longest stretch (240 frames) still fits the 10 s a run takes, with its margin.
        expect(modelSeconds(240)).toBeLessThanOrEqual(10 + 0.5 / 24);
        // What went wrong: 56 frames written as 56 / 24 s.
        expect(Math.floor(Number((56 / 24).toFixed(5)) * 24)).toBe(55);
    });
    test('a reversed stretch that came back short is missing its FIRST frames in playing order', () => {
        const keep = [0, 1, 2, 3, 4, 6, 7, 8, 9, 11];
        expect(frameMap(keep, 12, 9, true)).toEqual([0, 0, 1, 2, 3, 3, 4, 5, 6, 7, 7, 8]);
    });
    test('the frame map repeats a generated frame exactly where the source repeats', () => {
        const keep = [0, 1, 2, 3, 4, 6, 7, 8, 9, 11];
        expect(frameMap(keep, 12, 10)).toEqual([0, 1, 2, 3, 4, 4, 5, 6, 7, 8, 8, 9]);
        // A generated clip a frame short holds its last frame.
        expect(frameMap(keep, 12, 9)).toEqual([0, 1, 2, 3, 4, 4, 5, 6, 7, 8, 8, 8]);
    });
    test('the stall measured in the replaced area is reported; the source rhythm is not', () => {
        // Placed far shot of the production: two repeats then three moves.
        const stalled = [0.0, 0.1, 0.0, 12.4, 13.4, 17.5, 0.3, 0.1, 12.9, 13.4, 17.4, 0.2, 0.1, 12.8, 13.1, 17.2, 0.1, 0.2, 12.5];
        const source = pulldown(19, 12);
        const r = extraRepeats(stalled, source);
        expect(r.longestRun).toBeGreaterThanOrEqual(2);
        expect(r.extra).toBeGreaterThan(2);
        expect(extraRepeats(source, source)).toEqual({ extra: 0, longestRun: 0 });
        // A frozen clip over a moving source is the worst stall, not "no repeats".
        expect(extraRepeats(Array(19).fill(0), source)).toEqual({ extra: 16, longestRun: 4 });
    });
});

describe.skipIf(!hasFfmpeg)('remake cadence with ffmpeg', () => {
    // 3 s of moving 24 fps material carried at 30 fps, then a cut to 2 s of something else.
    const syn = path.join(TMP, 'syn.mp4');
    spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=160x288:r=24:d=3', '-f', 'lavfi', '-i', 'life=s=160x288:r=24:mold=10:ratio=0.3:death_color=#202020:life_color=#e0e0e0,trim=duration=2', '-filter_complex', '[0]fps=30,format=yuv420p[a];[1]fps=30,format=yuv420p[b];[a][b]concat=n=2:v=1:a=0', '-c:v', 'libx264', '-crf', '12', '-pix_fmt', 'yuv420p', syn]);

    test('a variable frame rate is recognised', async () => {
        expect((await ff.probe(syn)).variableRate).toBe(false);
        const vfr = path.join(TMP, 'vfr.mp4');
        spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=160x288:r=30:d=3', '-vf', "select='lt(n\,30)+not(mod(n\,3))'", '-fps_mode', 'vfr', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', vfr]);
        expect((await ff.probe(vfr)).variableRate).toBe(true);
        expect(await ff.unevenFrames(syn, 30)).toBe(0);
        expect(await ff.unevenFrames(vfr, (await ff.probe(vfr)).fps)).toBeGreaterThan(0);
    });
    test('the cut is measured to the frame', async () => {
        const d = await ff.frameDiffs(syn, { fps: 30 });
        expect(d.length).toBe(149);
        expect(detectCuts(d)).toEqual([90]);
    });
    test('only distinct frames are sent, and putting them back restores the source rhythm', async () => {
        const fps = 30;
        const d = await ff.frameDiffs(syn, { fps, first: 0, frames: 90 });
        const keep = distinctFrames(d, 90, fps)!;
        expect(keep.length).toBe(72);
        const driving = path.join(TMP, 'driving.mp4');
        await ff.cut(syn, driving, { start: 0, duration: 3, fps, hasAudio: false, keep, keepFps: 24, reverse: true });
        const p = await ff.probe(driving);
        expect(p.frames).toBe(72);
        expect(Math.round(p.fps)).toBe(24);
        // The model's clip: the driving clip itself, played forward again. No repeats in it.
        const forward = path.join(TMP, 'forward.mp4');
        await ff.reverse(driving, forward);
        expect(repeatedFrames(await ff.frameDiffs(forward, { fps: 24 }))).toEqual([]);
        // A generated clip that lost its first frame (what a reversed stretch suffered when the length asked was
        // rounded down) is measured as shifted; the right one is not.
        expect((await ff.frameAlignment(forward, driving, true)).shift).toBe(0);
        const lost = path.join(TMP, 'lost.mp4');
        spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', forward, '-vf', "select='gte(n\\,1)',setpts=N/24/TB", '-c:v', 'libx264', '-crf', '12', '-pix_fmt', 'yuv420p', lost]);
        const al = await ff.frameAlignment(lost, driving, true);
        expect(al.shift).toBe(1);
        expect(al.error).toBeLessThan(0.8 * al.errorAtZero);
        // Retimed to the source's rhythm, it matches the source frame for frame.
        const work = path.join(TMP, 'work');
        mkdirSync(work, { recursive: true });
        const back = path.join(TMP, 'back.mp4');
        await ff.retime(forward, back, frameMap(keep, 90, 72), fps, work);
        expect((await ff.probe(back)).frames).toBe(90);
        const r = extraRepeats(await ff.frameDiffs(back, { fps }), d);
        expect(r).toEqual({ extra: 0, longestRun: 0 });
        // What happened before the fix: the model's 24 fps resampling of the full 30 fps stretch, then a plain
        // 24 -> 30 frame-rate conversion. Depending on phase this stalls; it never matches better than the map.
        const naive = path.join(TMP, 'naive.mp4');
        spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', syn, '-vf', 'trim=end_frame=90,setpts=PTS-STARTPTS,reverse,fps=24:round=near,reverse,fps=30', '-c:v', 'libx264', '-crf', '12', '-pix_fmt', 'yuv420p', naive]);
        expect(extraRepeats(await ff.frameDiffs(naive, { fps }), d).extra).toBeGreaterThanOrEqual(r.extra);
    });
});
