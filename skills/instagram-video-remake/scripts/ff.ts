/**
 * ffmpeg / ffprobe steps of a remake: cutting the stretch to regenerate, cropping around a small subject,
 * reversing a clip, putting a generated clip back over the original, assembling the timeline and the sound.
 * Everything is re-encoded with a high-quality intermediate (x264 CRF 12) so cuts are frame-exact.
 */
import { spawn } from 'node:child_process';
import type { Rect } from './graphs.ts';

export class ToolError extends Error {}

export function run(cmd: string, args: string[], opts: { input?: Uint8Array; binary?: boolean } = {}): Promise<{ code: number; stdout: Buffer; stderr: string }> {
    return new Promise((resolve, reject) => {
        const p = spawn(cmd, args, { windowsHide: true });
        const out: Buffer[] = [];
        let err = '';
        p.stdout.on('data', (d: Buffer) => out.push(d));
        p.stderr.on('data', (d: Buffer) => {
            err = (err + d.toString()).slice(-4000);
        });
        p.on('error', (e: NodeJS.ErrnoException) => reject(new ToolError(e.code === 'ENOENT' ? `${cmd} was not found. Install ffmpeg (with ffprobe) and make sure it is on PATH.` : `${cmd}: ${e.message}`)));
        p.on('close', (code) => resolve({ code: code ?? 1, stdout: Buffer.concat(out), stderr: err }));
        if (opts.input) p.stdin.end(opts.input);
    });
}

async function ffmpeg(args: string[], what: string): Promise<void> {
    const r = await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
    if (r.code !== 0) throw new ToolError(`ffmpeg failed while ${what}: ${r.stderr.trim().split('\n').slice(-3).join(' | ')}`);
}

export interface Probe {
    width: number;
    height: number;
    fps: number;
    duration: number;
    frames: number;
    hasAudio: boolean;
    /** Length of the audio stream itself, in seconds (0 when there is none). */
    audioDuration: number;
    /** The frames are not evenly spaced (nominal and average rates differ, or the count does not match the length). */
    variableRate: boolean;
}

export function parseRate(r: string | undefined): number {
    if (!r) return 0;
    const [a, b] = r.split('/').map(Number);
    return b ? a / b : a || 0;
}

/** Display size (rotation applied), frame rate, video duration and an exact frame count. */
export async function probe(file: string): Promise<Probe> {
    const r = await run('ffprobe', ['-v', 'error', '-count_frames', '-print_format', 'json', '-show_streams', '-show_format', file]);
    if (r.code !== 0) throw new ToolError(`ffprobe could not read ${file}: ${r.stderr.trim().slice(-300)}`);
    const j = JSON.parse(r.stdout.toString());
    const v = (j.streams ?? []).find((s: any) => s.codec_type === 'video');
    if (!v) throw new ToolError(`${file} has no video stream.`);
    const rot = Math.abs(Number(v.tags?.rotate ?? v.side_data_list?.find((s: any) => s.rotation !== undefined)?.rotation ?? 0)) % 180;
    const [width, height] = rot === 90 ? [v.height, v.width] : [v.width, v.height];
    const fps = parseRate(v.avg_frame_rate) || parseRate(v.r_frame_rate);
    const duration = Math.min(...[Number(v.duration), Number(j.format?.duration)].filter((n) => n > 0));
    const frames = Number(v.nb_read_frames) || Math.round(duration * fps);
    const a = (j.streams ?? []).find((s: any) => s.codec_type === 'audio');
    const nominal = parseRate(v.r_frame_rate);
    const variableRate = (nominal > 0 && Math.abs(nominal - fps) / fps > 0.005) || Math.abs(frames - duration * fps) > 1.5;
    return { width, height, fps, duration, frames, hasAudio: Boolean(a), audioDuration: a ? Number(a.duration) || 0 : 0, variableRate };
}

const ENC = ['-c:v', 'libx264', '-preset', 'medium', '-crf', '12', '-pix_fmt', 'yuv420p'];

export function cropFilter(r: Rect): string {
    return `crop=${r.w}:${r.h}:${r.x}:${r.y}`;
}

export function checkRect(r: Rect, frame: { width: number; height: number }): void {
    for (const [k, v] of Object.entries(r)) if (!Number.isInteger(v) || v < 0) throw new ToolError(`crop ${k} must be a whole, non-negative number.`);
    if (r.w < 64 || r.h < 64 || r.w % 2 || r.h % 2) throw new ToolError('The crop must be at least 64x64 with even width and height.');
    if (r.x + r.w > frame.width || r.y + r.h > frame.height) throw new ToolError(`The crop ${r.w}x${r.h}+${r.x}+${r.y} does not fit inside the ${frame.width}x${frame.height} frame.`);
}

/**
 * Cuts [start, start+duration) from `src`, optionally cropped and optionally played backwards. Audio is kept
 * (reversed too) because the model uses it as a timing guide.
 */
export async function cut(src: string, out: string, o: { start: number; duration: number; fps: number; crop?: Rect; reverse?: boolean; hasAudio: boolean; keep?: number[]; keepFps?: number }): Promise<void> {
    // Whole frames only: the stretch is snapped to the frame grid and counted, so it can never run one frame into
    // the next shot (which, played backwards, would put that other shot on the first frame the model sees).
    const g = frameSpan(o.start, o.duration, o.fps);
    // `keep`: only these frames of the stretch (its distinct frames), played at `keepFps`. The model then receives
    // every real frame instead of resampling repeats in and real frames out.
    let pick: string[] = [];
    if (o.keep) {
        const keep = new Set(o.keep);
        const drop = Array.from({ length: g.frames }, (_, i) => i).filter((i) => !keep.has(i));
        if (drop.length) pick = [`select='not(${drop.map((i) => `eq(n\\,${i})`).join('+')})'`];
        pick.push(`setpts=N/${(o.keepFps ?? 24).toFixed(5)}/TB`);
    }
    // The frames are counted INSIDE the filter chain, before `reverse`: that filter reads its whole input first,
    // so limiting the output alone would reverse everything up to the end of the file.
    const vf = [`trim=end_frame=${g.frames}`, 'setpts=PTS-STARTPTS', ...pick, o.crop ? cropFilter(o.crop) : null, o.reverse ? 'reverse' : null].filter(Boolean).join(',');
    const args = ['-ss', g.seek.toFixed(5), '-t', (g.duration + 1).toFixed(5), '-i', src, '-vf', vf];
    if (o.keep) args.push('-r', (o.keepFps ?? 24).toFixed(5), '-fps_mode', 'cfr');
    if (o.hasAudio) args.push('-af', [`atrim=duration=${g.duration.toFixed(5)}`, 'asetpts=PTS-STARTPTS', o.reverse ? 'areverse' : null].filter(Boolean).join(','), '-c:a', 'aac', '-b:a', '192k');
    else args.push('-an');
    await ffmpeg([...args, ...ENC, out], 'cutting the clip');
}

/**
 * How many frames are NOT on a constant `fps` grid (more than a third of a frame away from first + i / fps, in
 * presentation order). Average rates can hide a few dropped or doubled frames; their timestamps cannot.
 */
export async function unevenFrames(file: string, fps: number): Promise<number> {
    const r = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time', '-of', 'csv=p=0', file]);
    if (r.code !== 0) throw new ToolError(`ffprobe could not read ${file}: ${r.stderr.trim().slice(-200)}`);
    const pts = r.stdout.toString().split(/\r?\n/).map((l) => Number.parseFloat(l)).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
    return countUneven(pts, fps);
}

export function countUneven(pts: number[], fps: number): number {
    if (!pts.length || !(fps > 0)) return 0;
    let bad = 0;
    for (let i = 0; i < pts.length; i++) if (Math.abs(pts[i] - pts[0] - i / fps) > 1 / (3 * fps)) bad++;
    return bad;
}

/**
 * Differences between consecutive frames (mean absolute difference of small grayscale frames, 0-255), for the whole
 * file or `frames` frames from frame `first`, optionally inside `area` only. Entry i compares frame i with i+1.
 */
export async function frameDiffs(file: string, o: { fps: number; first?: number; frames?: number; area?: Rect; width?: number } = { fps: 30 }): Promise<Float32Array> {
    const w = o.width ?? 96;
    const pre: string[] = [];
    if (o.first !== undefined) pre.push('-ss', Math.max(0, (o.first - 0.5) / o.fps).toFixed(5));
    const chain = [o.frames !== undefined ? `trim=end_frame=${o.frames}` : null, o.area ? cropFilter(o.area) : null, `scale=${w}:-2:flags=area`, 'format=gray'].filter(Boolean).join(',');
    const sized = await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...pre, '-i', file, '-vf', chain, '-frames:v', '1', '-f', 'rawvideo', '-']);
    if (sized.code !== 0 || !sized.stdout.length) throw new ToolError(`Could not read frames from ${file}: ${sized.stderr.trim().slice(-200)}`);
    const size = sized.stdout.length;
    const r = await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...pre, '-i', file, '-vf', chain, '-fps_mode', 'passthrough', '-f', 'rawvideo', '-']);
    if (r.code !== 0) throw new ToolError(`Could not read frames from ${file}: ${r.stderr.trim().slice(-200)}`);
    const n = Math.floor(r.stdout.length / size);
    const out = new Float32Array(Math.max(0, n - 1));
    for (let i = 0; i + 1 < n; i++) {
        let sum = 0;
        const a = i * size;
        const b = a + size;
        for (let k = 0; k < size; k++) sum += Math.abs(r.stdout[a + k] - r.stdout[b + k]);
        out[i] = sum / size;
    }
    return out;
}

async function smallFrames(file: string, w = 64): Promise<Uint8Array[]> {
    const vf = `scale=${w}:${Math.round((w * 16) / 9 / 2) * 2},format=gray`;
    const r = await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file, '-vf', vf, '-fps_mode', 'passthrough', '-f', 'rawvideo', '-']);
    if (r.code !== 0) throw new ToolError(`Could not read frames from ${file}: ${r.stderr.trim().slice(-200)}`);
    const size = w * Math.round((w * 16) / 9 / 2) * 2;
    const out: Uint8Array[] = [];
    for (let i = 0; i + size <= r.stdout.length; i += size) out.push(r.stdout.subarray(i, i + size));
    return out;
}

/**
 * Which frame of the clip sent to the model each generated frame lines up with: the shift (in frames, -3..3)
 * that makes the two most alike, with the error at that shift and at no shift. Outside the replaced person the
 * model keeps the picture it was given, so a whole-clip shift shows clearly there. `sentReversed`: the clip sent
 * plays backwards relative to `generated`.
 */
export async function frameAlignment(generated: string, sent: string, sentReversed: boolean): Promise<{ shift: number; error: number; errorAtZero: number }> {
    const g = await smallFrames(generated);
    let s = await smallFrames(sent);
    if (sentReversed) s = s.reverse();
    const err = (shift: number) => {
        let sum = 0;
        let n = 0;
        for (let k = 0; k < g.length; k++) {
            const j = k + shift;
            if (j < 0 || j >= s.length) continue;
            let d = 0;
            for (let p = 0; p < g[k].length; p++) d += Math.abs(g[k][p] - s[j][p]);
            sum += d / g[k].length;
            n++;
        }
        return n ? sum / n : Number.POSITIVE_INFINITY;
    };
    let best = { shift: 0, error: err(0) };
    for (const shift of [-3, -2, -1, 1, 2, 3]) {
        const e = err(shift);
        if (e < best.error) best = { shift, error: e };
    }
    return { ...best, errorAtZero: err(0) };
}

/**
 * Turns a generated clip into exactly `map.length` frames at `fps`, output frame j showing generated frame map[j].
 * Used to give a generated shot the source's own rhythm of repeated frames. `work` is an empty scratch folder.
 */
export async function retime(generated: string, out: string, map: number[], fps: number, work: string): Promise<void> {
    await ffmpeg(['-i', generated, '-fps_mode', 'passthrough', '-start_number', '0', `${work}/g%05d.png`], 'reading the generated frames');
    const { copyFile, link } = await import('node:fs/promises');
    const pad = (k: number) => String(k).padStart(5, '0');
    // One numbered image per output frame, read back at exactly `fps`: no durations to round.
    for (let j = 0; j < map.length; j++) {
        const from = `${work}/g${pad(map[j])}.png`;
        const to = `${work}/o${pad(j)}.png`;
        await link(from, to).catch(() => copyFile(from, to));
    }
    await ffmpeg(['-framerate', fps.toFixed(5), '-start_number', '0', '-i', `${work}/o%05d.png`, '-frames:v', String(map.length), '-an', ...ENC, out], 'retiming the generated clip');
}

/** The stretch [start, start+duration) as whole frames: first frame index, frame count, and where to seek. */
export function frameSpan(start: number, duration: number, fps: number): { first: number; frames: number; seek: number; start: number; duration: number } {
    const first = Math.max(0, Math.round(start * fps));
    const frames = Math.max(1, Math.round(duration * fps));
    // Seek to half a frame before the first wanted frame, so rounding can only land on it.
    return { first, frames, seek: Math.max(0, (first - 0.5) / fps), start: first / fps, duration: frames / fps };
}

export async function reverse(src: string, out: string): Promise<void> {
    await ffmpeg(['-i', src, '-vf', 'reverse', '-an', ...ENC, out], 'reversing the clip');
}

/** Drops the first `frames` frames (the guide frames of a continuation). */
export async function dropFrames(src: string, out: string, frames: number): Promise<void> {
    await ffmpeg(['-i', src, '-vf', `select='gte(n\\,${frames})',setpts=N/FRAME_RATE/TB`, '-an', ...ENC, out], 'removing the guide frames');
}

export async function frameAt(src: string, out: string, which: 'first' | 'last' | number): Promise<void> {
    if (which === 'last') await ffmpeg(['-sseof', '-0.5', '-i', src, '-update', '1', '-q:v', '1', out], 'reading the last frame');
    else await ffmpeg(['-ss', which === 'first' ? '0' : String(which), '-i', src, '-frames:v', '1', '-q:v', '1', out], 'reading a frame');
}

/**
 * Puts a generated clip back over the stretch of the original it came from, as EXACTLY `frames` frames at the
 * original's size and frame rate, with no audio. The generated clip is resampled to that rate and, if it comes
 * up short (24 fps material rarely lands on the same count), its last frame is held.
 *  - `area` given: the generated clip is scaled into that rectangle and blended with a feather that lies INSIDE
 *    it. Outside the rectangle the picture is the original, re-encoded (visually identical, not bit-identical).
 *    `firstFrame` is the index of the stretch's first frame in the source.
 *  - no `area`: the generated clip replaces the whole frame (scaled to cover it, centre-cropped).
 */
export async function placeBack(o: { source: string; firstFrame: number; frames: number; generated: string; out: string; frame: { width: number; height: number; fps: number }; area?: Rect; feather?: number }): Promise<void> {
    const fps = o.frame.fps.toFixed(5);
    const hold = `fps=${fps},tpad=stop_mode=clone:stop=${o.frames},trim=end_frame=${o.frames},setpts=PTS-STARTPTS`;
    if (!o.area) {
        const vf = `${hold},scale=${o.frame.width}:${o.frame.height}:force_original_aspect_ratio=increase:flags=lanczos,crop=${o.frame.width}:${o.frame.height},setsar=1`;
        await ffmpeg(['-i', o.generated, '-vf', vf, '-frames:v', String(o.frames), '-an', ...ENC, o.out], 'fitting the generated clip to the frame');
        return;
    }
    const a = o.area;
    const f = Math.max(1, Math.min(o.feather ?? 12, Math.floor(Math.min(a.w, a.h) / 4)));
    const alpha = `255*min(1\\,min(min(X\\,W-1-X)\\,min(Y\\,H-1-Y))/${f})`;
    const seek = Math.max(0, (o.firstFrame - 0.5) / o.frame.fps);
    const graph = [
        `[0:v]trim=end_frame=${o.frames},setpts=PTS-STARTPTS,setsar=1[base]`,
        `[1:v]${hold},scale=${a.w}:${a.h}:flags=lanczos,format=yuva444p,geq=lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)':a='${alpha}'[gen]`,
        `[base][gen]overlay=${a.x}:${a.y}:shortest=1[v]`,
    ].join(';');
    await ffmpeg(['-ss', seek.toFixed(5), '-t', (o.frames / o.frame.fps + 1).toFixed(5), '-i', o.source, '-i', o.generated, '-filter_complex', graph, '-map', '[v]', '-frames:v', String(o.frames), '-an', ...ENC, o.out], 'placing the generated clip over the original');
}

export interface Segment {
    file: string;
    /** For a stretch of the original: where to seek and how many frames to take. Omit both to use the whole file. */
    start?: number;
    frames?: number;
}

/** Joins segments into one silent video with the given size and frame rate. */
export async function concat(segments: Segment[], out: string, frame: { width: number; height: number; fps: number }): Promise<void> {
    if (!segments.length) throw new ToolError('Nothing to assemble.');
    const args: string[] = [];
    const parts: string[] = [];
    segments.forEach((s, i) => {
        if (s.start !== undefined) args.push('-ss', s.start.toFixed(5));
        if (s.frames !== undefined) args.push('-t', (s.frames / frame.fps + 1).toFixed(5));
        args.push('-i', s.file);
        // A stretch of the original is counted in frames, like the shots that replace its neighbours.
        const take = s.frames !== undefined ? `trim=end_frame=${s.frames},setpts=PTS-STARTPTS,` : '';
        parts.push(`[${i}:v]${take}fps=${frame.fps.toFixed(5)},scale=${frame.width}:${frame.height}:force_original_aspect_ratio=increase:flags=lanczos,crop=${frame.width}:${frame.height},setsar=1,format=yuv420p[v${i}]`);
    });
    const graph = `${parts.join(';')};${segments.map((_, i) => `[v${i}]`).join('')}concat=n=${segments.length}:v=1:a=0[v]`;
    await ffmpeg([...args, '-filter_complex', graph, '-map', '[v]', '-an', ...ENC, out], 'assembling the timeline');
}

/**
 * Adds sound: `audio` from `audioStart` for the whole length of the video. `audioDuration` must be the length of
 * the audio STREAM (not of its container). The audio is never looped or padded: too short is an error, and the
 * result is checked to be as long as the video.
 */
export async function mux(video: string, audio: string, out: string, o: { audioStart: number; videoDuration: number; audioDuration: number }): Promise<void> {
    if (o.audioStart < 0) throw new ToolError('The audio start must not be negative.');
    if (!(o.audioDuration > 0)) throw new ToolError('That file has no audio stream.');
    if (o.audioStart + o.videoDuration > o.audioDuration + 0.05) {
        throw new ToolError(`The audio is too short: it has ${Math.max(0, o.audioDuration - o.audioStart).toFixed(2)} s from ${o.audioStart.toFixed(2)} s, and the video is ${o.videoDuration.toFixed(2)} s. Use a longer recording (--file) instead of looping.`);
    }
    // The cut is made on decoded samples (atrim), not by seeking the compressed file: seeking an AAC or MP3 file
    // lands on a packet boundary and left the sound about 45 ms late in practice.
    const af = `atrim=start=${o.audioStart.toFixed(5)}:duration=${o.videoDuration.toFixed(5)},asetpts=PTS-STARTPTS`;
    await ffmpeg(['-i', video, '-i', audio, '-map', '0:v', '-map', '1:a', '-af', af, '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', out], 'adding the audio');
    const p = await probe(out);
    if (p.duration < o.videoDuration - 0.1 || p.audioDuration < o.videoDuration - 0.15) {
        throw new ToolError(`The file with sound came out incomplete (picture ${p.duration.toFixed(2)} s, sound ${p.audioDuration.toFixed(2)} s, expected ${o.videoDuration.toFixed(2)} s). It was not accepted.`);
    }
}

/** Length of a file's audio stream in seconds (works for audio-only files); 0 when it has none. */
export async function audioLength(file: string): Promise<number> {
    const r = await run('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=duration:format=duration', '-of', 'json', file]);
    if (r.code !== 0) throw new ToolError(`ffprobe could not read ${file}.`);
    const j = JSON.parse(r.stdout.toString());
    if (!(j.streams ?? []).length) return 0;
    return Number(j.streams[0].duration) || Number(j.format?.duration) || 0;
}

/** Original on the left, result on the right, same height, for reviewing the edit in motion. */
export async function sideBySide(a: string, b: string, out: string, height = 960): Promise<void> {
    const graph = `[0:v]scale=-2:${height},setsar=1[l];[1:v]scale=-2:${height},setsar=1[r];[l][r]hstack=inputs=2:shortest=0[v]`;
    await ffmpeg(['-i', a, '-i', b, '-filter_complex', graph, '-map', '[v]', '-map', '1:a?', '-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'aac', out], 'building the comparison video');
}

/** Mono 32-bit float PCM at `rate` Hz. */
export async function decodeAudio(file: string, rate: number, o: { start?: number; duration?: number } = {}): Promise<Float32Array> {
    const args = ['-hide_banner', '-loglevel', 'error'];
    if (o.start !== undefined) args.push('-ss', o.start.toFixed(4));
    if (o.duration !== undefined) args.push('-t', o.duration.toFixed(4));
    args.push('-i', file, '-vn', '-ac', '1', '-ar', String(rate), '-f', 'f32le', '-');
    const r = await run('ffmpeg', args);
    if (r.code !== 0 || !r.stdout.length) throw new ToolError(`Could not read audio from ${file}: ${r.stderr.trim().slice(-200) || 'no audio stream'}`);
    return new Float32Array(r.stdout.buffer, r.stdout.byteOffset, Math.floor(r.stdout.length / 4)).slice();
}
