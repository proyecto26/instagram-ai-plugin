/**
 * Shot segmentation and per-shot visual evidence: cuts, a low-motion hint, text-change
 * candidates, first/last/mid frames, contact sheets and dense strips.
 *
 * All frame differences are mean absolute differences (MAD) on the 0-255 gray scale between
 * consecutive frames decoded at GRAY_FPS. Nothing here classifies a shot: the numbers are hints
 * for the reviewer.
 */
import { copyFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

import { ffmpeg, ffprobe, run, sec } from './ff.ts';

export const GRAY_W = 160;
export const GRAY_H = 90;
export const GRAY_FPS = 8;
export const MIN_SHOT = 0.25;

export const MOTION = { pairMad: 1.0, staticRatio: 0.95, firstLastMad: 1.0, blockMad: 3.0, minDuration: 0.5, minPairs: 3 };
export const TEXT = { bandMad: 6.0, outsideMad: 2.0, clusterGap: 0.5 };
/** Horizontal bands as fractions of the frame height. */
export const BANDS = { top: [0, 0.22], middle: [0.38, 0.62], bottom: [0.62, 0.92] } as const;
export type Band = keyof typeof BANDS;

export interface VideoFacts {
    duration: number;
    width: number;
    height: number;
    fps: number;
    rotation: number;
    videoCodec: string | null;
    audioCodec: string | null;
    hasAudio: boolean;
    bitrate: number | null;
    formatName: string | null;
    encoder: string | null;
}

export async function probe(video: string): Promise<VideoFacts> {
    const r = await ffprobe(['-print_format', 'json', '-show_format', '-show_streams', video]);
    const j = JSON.parse(r.stdout.toString('utf8'));
    const v = (j.streams ?? []).find((s: any) => s.codec_type === 'video');
    const a = (j.streams ?? []).find((s: any) => s.codec_type === 'audio');
    if (!v) throw new Error(`${video} has no video stream.`);
    const ratio = (s: string | undefined) => {
        const [n, d] = String(s ?? '0/1').split('/').map(Number);
        return d ? n / d : 0;
    };
    const rot = Number(v.tags?.rotate ?? v.side_data_list?.find((d: any) => d.rotation != null)?.rotation ?? 0) || 0;
    // The picture can end before the container does (a longer audio track): frames exist only
    // up to the video stream's own duration.
    const container = Number(j.format?.duration ?? 0);
    const stream = Number(v.duration ?? 0);
    const duration = stream > 0 && container > 0 ? Math.min(stream, container) : stream || container;
    if (!(duration > 0)) throw new Error(`${video}: ffprobe reported no duration.`);
    return {
        duration,
        width: Number(v.width),
        height: Number(v.height),
        fps: ratio(v.avg_frame_rate) || ratio(v.r_frame_rate),
        rotation: rot,
        videoCodec: v.codec_name ?? null,
        audioCodec: a?.codec_name ?? null,
        hasAudio: Boolean(a),
        bitrate: j.format?.bit_rate ? Number(j.format.bit_rate) : null,
        formatName: j.format?.format_name ?? null,
        encoder: j.format?.tags?.encoder ?? v.tags?.encoder ?? null,
    };
}

/** Raw cut times from ffmpeg's scene score. */
export async function detectCuts(video: string, threshold: number): Promise<number[]> {
    const r = await run('ffmpeg', ['-hide_banner', '-nostdin', '-i', video, '-an', '-vf', `select='gt(scene,${threshold})',showinfo`, '-f', 'null', '-'], { fullStderr: true });
    if (r.code !== 0) throw new Error(`ffmpeg scene detection failed:\n${r.stderr.trim().split(/\r?\n/).slice(-4).join('\n')}`);
    const out: number[] = [];
    for (const m of r.stderr.matchAll(/pts_time:([0-9.]+)/g)) out.push(Number(m[1]));
    return out;
}

/** Sorts, drops cuts closer than `min` to the previous cut or to either end. */
export function mergeCuts(cuts: number[], duration: number, min = MIN_SHOT): number[] {
    const out: number[] = [];
    let prev = 0;
    for (const c of [...new Set(cuts)].filter((x) => Number.isFinite(x)).sort((a, b) => a - b)) {
        if (c - prev < min || duration - c < min) continue;
        out.push(c);
        prev = c;
    }
    return out;
}

export interface CutOverrides {
    add: number[];
    remove: number[];
}

/**
 * Records new manual corrections on top of the remembered ones. The newest instruction wins:
 * removing a time cancels a remembered addition near it, and adding a time cancels a remembered
 * removal near it.
 */
export function recordOverrides(prev: CutOverrides, add: number[], remove: number[]): CutOverrides {
    const near = (a: number, b: number) => Math.abs(a - b) <= 0.1;
    const uniq = (xs: number[]) => [...new Set(xs)].sort((x, y) => x - y);
    const keptAdd = prev.add.filter((a) => !remove.some((r) => near(a, r)));
    const keptRemove = prev.remove.filter((r) => !add.some((a) => near(a, r)));
    // The removal is remembered even when it cancelled a manual addition: detection may supply
    // the same boundary. Only an addition in the same call overrides it.
    const newRemove = remove.filter((r) => !add.some((a) => near(a, r)));
    return { add: uniq([...keptAdd, ...add]), remove: uniq([...keptRemove, ...newRemove]) };
}

/** Manual corrections: `remove` drops detected cuts within 0.1 s; `add` inserts cuts. */
export function applyOverrides(cuts: number[], o: CutOverrides, duration: number): number[] {
    const kept = cuts.filter((c) => !o.remove.some((r) => Math.abs(r - c) <= 0.1));
    return mergeCuts([...kept, ...o.add.filter((a) => a > 0 && a < duration)], duration);
}

export interface ShotSpan {
    id: number;
    start: number;
    end: number;
    duration: number;
}

export function spans(cuts: number[], duration: number): ShotSpan[] {
    const edges = [0, ...cuts, duration];
    return edges.slice(0, -1).map((start, i) => ({ id: i + 1, start: round3(start), end: round3(edges[i + 1]), duration: round3(edges[i + 1] - start) }));
}

/** Gray frames at GRAY_FPS, each GRAY_W*GRAY_H bytes. Frame i is at i / GRAY_FPS seconds. */
export async function grayFrames(video: string): Promise<Uint8Array[]> {
    const r = await ffmpeg(['-i', video, '-an', '-vf', `fps=${GRAY_FPS},scale=${GRAY_W}:${GRAY_H},format=gray`, '-f', 'rawvideo', '-']);
    const size = GRAY_W * GRAY_H;
    const frames: Uint8Array[] = [];
    for (let o = 0; o + size <= r.stdout.length; o += size) frames.push(r.stdout.subarray(o, o + size));
    return frames;
}

export interface PairStat {
    /** Time of the later frame of the pair. */
    t: number;
    mad: number;
    /** Largest MAD among the cells of a 4x4 grid. */
    maxBlock: number;
    band: Record<Band, { mad: number; outside: number }>;
}

export function frameMad(a: Uint8Array, b: Uint8Array): number {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
    return s / a.length;
}

export function pairStats(frames: Uint8Array[], w = GRAY_W, h = GRAY_H, fps = GRAY_FPS): PairStat[] {
    const out: PairStat[] = [];
    const bw = Math.floor(w / 4);
    const bh = Math.floor(h / 4);
    for (let f = 1; f < frames.length; f++) {
        const a = frames[f - 1];
        const b = frames[f];
        const rows = new Float64Array(h);
        const blocks = new Float64Array(16);
        for (let y = 0; y < h; y++) {
            const by = Math.min(3, Math.floor(y / bh));
            let rs = 0;
            for (let x = 0; x < w; x++) {
                const d = Math.abs(a[y * w + x] - b[y * w + x]);
                rs += d;
                blocks[by * 4 + Math.min(3, Math.floor(x / bw))] += d;
            }
            rows[y] = rs;
        }
        let total = 0;
        for (let y = 0; y < h; y++) total += rows[y];
        const band = {} as PairStat['band'];
        for (const name of Object.keys(BANDS) as Band[]) {
            const y0 = Math.round(BANDS[name][0] * h);
            const y1 = Math.round(BANDS[name][1] * h);
            let s = 0;
            for (let y = y0; y < y1; y++) s += rows[y];
            const inPx = (y1 - y0) * w;
            band[name] = { mad: s / inPx, outside: (total - s) / (w * h - inPx) };
        }
        // Edge cells absorb the remainder columns/rows, so divide by the nominal cell size at least.
        let maxBlock = 0;
        for (let i = 0; i < 16; i++) {
            const cw = i % 4 === 3 ? w - 3 * bw : bw;
            const ch = i >= 12 ? h - 3 * bh : bh;
            maxBlock = Math.max(maxBlock, blocks[i] / (cw * ch));
        }
        out.push({ t: f / fps, mad: total / (w * h), maxBlock, band });
    }
    return out;
}

export const DIFF_CUT = { minMad: 20, ratio: 4, window: 1.5, nearScene: 0.5, localMax: 0.375 };

/**
 * Cuts the scene score misses (animated wipes, whip transitions, some dissolves): an isolated
 * spike of whole-frame change. A pair qualifies when its MAD is at least DIFF_CUT.minMad, at
 * least DIFF_CUT.ratio times the median MAD of the surrounding 3 s (so sustained fast motion
 * does not qualify), the largest within 0.375 s, and not next to a scene cut. Times are only as
 * precise as the sampling rate; `--remove-cut` undoes a wrong one.
 */
export function diffCuts(pairs: PairStat[], sceneCuts: number[], fps = GRAY_FPS): number[] {
    const out: number[] = [];
    for (let i = 0; i < pairs.length; i++) {
        const p = pairs[i];
        if (p.mad < DIFF_CUT.minMad) continue;
        if (sceneCuts.some((c) => Math.abs(c - p.t) <= DIFF_CUT.nearScene)) continue;
        const near = pairs.filter((q) => Math.abs(q.t - p.t) <= DIFF_CUT.localMax);
        if (near.some((q) => q.mad > p.mad)) continue;
        const around = pairs.filter((q) => Math.abs(q.t - p.t) <= DIFF_CUT.window).map((q) => q.mad).sort((x, y) => x - y);
        const median = around[around.length >> 1];
        if (p.mad < DIFF_CUT.ratio * Math.max(median, 0.5)) continue;
        if (out.length && p.t - out[out.length - 1] < DIFF_CUT.nearScene) continue;
        // The change happens between the two frames of the pair.
        out.push(round3(p.t - 0.5 / fps));
    }
    return out;
}

export interface Motion {
    static_ratio: number | null;
    first_last_mad: number | null;
    max_block_mad: number | null;
    /** true = probably a still or a hold; null = too short to measure. A hint, never a verdict. */
    low_motion: boolean | null;
}

/** Frame indices i with start <= i/fps < end. */
function frameRange(start: number, end: number, count: number, fps: number): [number, number] {
    const a = Math.min(count, Math.ceil(start * fps - 1e-9));
    const b = Math.min(count, Math.ceil(end * fps - 1e-9));
    return [a, b];
}

export function motionForShot(frames: Uint8Array[], pairs: PairStat[], shot: { start: number; end: number; duration: number }, fps = GRAY_FPS): Motion {
    const [a, b] = frameRange(shot.start, shot.end, frames.length, fps);
    // Pair f compares frames f-1 and f; both must lie inside the shot.
    const inside = pairs.slice(a, Math.max(a, b - 1));
    if (shot.duration < MOTION.minDuration || inside.length < MOTION.minPairs) {
        return { static_ratio: null, first_last_mad: null, max_block_mad: null, low_motion: null };
    }
    const staticRatio = inside.filter((p) => p.mad < MOTION.pairMad).length / inside.length;
    const firstLast = frameMad(frames[a], frames[b - 1]);
    const maxBlock = Math.max(...inside.map((p) => p.maxBlock));
    return {
        static_ratio: round3(staticRatio),
        first_last_mad: round3(firstLast),
        max_block_mad: round3(maxBlock),
        low_motion: staticRatio >= MOTION.staticRatio && firstLast < MOTION.firstLastMad && maxBlock < MOTION.blockMad,
    };
}

export interface TextCandidate {
    t: number;
    band: Band;
}

/**
 * A band changed while the rest of the frame stayed still: a caption probably appeared, changed
 * or left. Pairs that straddle a cut are ignored. Candidates of one band closer than
 * TEXT.clusterGap form one cluster reported at its first time. No candidates does NOT mean no
 * changing text (text over moving footage never triggers).
 */
export function textCandidates(pairs: PairStat[], cuts: number[], fps = GRAY_FPS): TextCandidate[] {
    const out: TextCandidate[] = [];
    const last: Partial<Record<Band, number>> = {};
    for (const p of pairs) {
        const prevT = p.t - 1 / fps;
        if (cuts.some((c) => c > prevT - 1e-9 && c <= p.t + 1e-9)) continue;
        for (const name of Object.keys(BANDS) as Band[]) {
            const s = p.band[name];
            if (!(s.mad > TEXT.bandMad && s.outside < TEXT.outsideMad)) continue;
            const prev = last[name];
            if (prev === undefined || p.t - prev >= TEXT.clusterGap) out.push({ t: round3(p.t), band: name });
            last[name] = p.t;
        }
    }
    return out.sort((x, y) => x.t - y.t);
}

// ---------- images ----------

/** One frame at `t`. Seeking at or past the last frame yields nothing, so step back and retry. */
async function grab(video: string, t: number, dest: string): Promise<void> {
    let last: unknown;
    for (const back of [0, 0.1, 0.25, 0.5, 1]) {
        try {
            await ffmpeg(['-ss', sec(t - back), '-i', video, '-frames:v', '1', '-q:v', '3', dest]);
            return;
        } catch (e) {
            last = e;
        }
    }
    throw last;
}

function grid(n: number, maxCols = 8): { cols: number; rows: number } {
    const cols = Math.min(maxCols, Math.max(1, n));
    return { cols, rows: Math.max(1, Math.ceil(n / cols)) };
}

/**
 * Dense sheet of a time range with the source timestamp under each tile. Returns the tile times.
 * Falls back to an unlabelled sheet when this ffmpeg build cannot draw text (no fontconfig).
 */
export async function sheet(video: string, from: number, to: number, fps: number, dest: string, tileWidth = 240, maxTiles = 40): Promise<{ times: number[]; fps: number; labelled: boolean }> {
    const dur = Math.max(0.05, to - from);
    let rate = fps;
    if (dur * rate > maxTiles) rate = maxTiles / dur;
    const n = Math.max(1, Math.min(maxTiles, Math.floor(dur * rate + 1e-6) || 1));
    const { cols, rows } = grid(n);
    const label = `drawtext=text='%{pts\\:flt\\:${sec(from)}}':x=4:y=h-th-4:fontsize=16:fontcolor=white:box=1:boxcolor=black@0.65:boxborderw=3`;
    const build = (withLabel: boolean) => [
        '-ss', sec(from), '-t', sec(dur), '-i', video, '-an',
        '-vf', [`fps=${rate.toFixed(4)}`, `scale=${tileWidth}:-2`, ...(withLabel ? [label] : []), `tile=${cols}x${rows}`].join(','),
        '-frames:v', '1', '-q:v', '4', dest,
    ];
    let labelled = true;
    try {
        await ffmpeg(build(true));
    } catch {
        labelled = false;
        await ffmpeg(build(false));
    }
    const times = Array.from({ length: n }, (_, k) => round3(from + k / rate));
    return { times, fps: round3(rate), labelled };
}

export interface ShotImages {
    first: string;
    last: string;
    mid: string;
    sheet: string;
    strip: string;
    first_t: number;
    mid_t: number;
    last_t: number;
    strip_fps: number;
    strip_times: number[];
    timestamps_burned: boolean;
}

export async function exportShotImages(video: string, outDir: string, shot: ShotSpan, fps: number): Promise<ShotImages> {
    const dir = path.join(outDir, 'shots');
    await mkdir(dir, { recursive: true });
    const frame = 1 / (fps || 30);
    const id = String(shot.id).padStart(3, '0');
    const firstT = shot.start + frame * 0.5;
    const lastT = Math.max(firstT, shot.end - frame * 1.5);
    const midT = (shot.start + shot.end) / 2;
    const rel = (n: string) => `shots/shot_${id}_${n}.jpg`;
    await grab(video, firstT, path.join(outDir, rel('first')));
    await grab(video, midT, path.join(outDir, rel('mid')));
    await grab(video, lastT, path.join(outDir, rel('last')));
    const sheetRel = `shots/shot_${id}.jpg`;
    await ffmpeg([
        '-i', path.join(outDir, rel('first')), '-i', path.join(outDir, rel('mid')), '-i', path.join(outDir, rel('last')),
        '-filter_complex', '[0]scale=360:-2[a];[1]scale=360:-2[b];[2]scale=360:-2[c];[a][b][c]hstack=inputs=3',
        '-frames:v', '1', '-q:v', '4', path.join(outDir, sheetRel),
    ]);
    const s = await sheet(video, shot.start, shot.end, 2, path.join(outDir, rel('strip')));
    return {
        first: rel('first'), last: rel('last'), mid: rel('mid'), sheet: sheetRel, strip: rel('strip'),
        first_t: round3(firstT), mid_t: round3(midT), last_t: round3(lastT),
        strip_fps: s.fps, strip_times: s.times, timestamps_burned: s.labelled,
    };
}

/** One tile per shot (its middle frame), at most `max` tiles sampled evenly. */
export async function storyboard(outDir: string, mids: string[], max = 60): Promise<string | null> {
    if (!mids.length) return null;
    const pick = mids.length <= max ? mids : Array.from({ length: max }, (_, i) => mids[Math.floor((i * mids.length) / max)]);
    const tmp = path.join(outDir, '.storyboard');
    await rm(tmp, { recursive: true, force: true });
    await mkdir(tmp, { recursive: true });
    try {
        for (let i = 0; i < pick.length; i++) await copyFile(path.join(outDir, pick[i]), path.join(tmp, `${String(i + 1).padStart(3, '0')}.jpg`));
        const { cols, rows } = grid(pick.length, 6);
        await ffmpeg(['-framerate', '1', '-start_number', '1', '-i', path.join(tmp, '%03d.jpg'), '-vf', `scale=200:-2,tile=${cols}x${rows}`, '-frames:v', '1', '-q:v', '4', path.join(outDir, 'storyboard.jpg')]);
    } finally {
        await rm(tmp, { recursive: true, force: true });
    }
    return 'storyboard.jpg';
}

export const round3 = (n: number) => Math.round(n * 1000) / 1000;
