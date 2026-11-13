#!/usr/bin/env bun
/**
 * instagram-video-remake: remake a video you are allowed to remake, replacing one person with another
 * (and optionally continuing a shot), with MiniMax H3 running in a local ComfyUI.
 *
 *   bun scripts/main.ts <command> [options]     (see HELP below, and references/workflow.md)
 *
 * Nothing here publishes anything, and nothing leaves this computer unless --allow-remote-comfy is given.
 */
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { FINE_RATE, findOffset } from './audio.ts';
import { Comfy, ComfyError, DEFAULT_COMFY_URL, graphHash, pickVideo } from './comfy.ts';
import * as ff from './ff.ts';
import { CONTINUE_DEFAULTS, H3_FPS, MODELS, REQUIRED_NODES, SAVE_NODE, SWAP_DEFAULTS, type Graph, type Rect, buildContinuation, continuationFrames, fillSwap, generatedArea, tierCanvas, toPreparedPoint } from './graphs.ts';
import { type Attempt, type Manifest, type Shot, SCHEMA, checkId, chosen, invalidate, load, lockRun, parseSegments, reference, save, sha256File, shot, staleContinuation, timelineGaps } from './manifest.ts';

const HELP = `instagram-video-remake — replace a person in a video, keep everything else

  doctor [--comfy-url <url>]
      Check ffmpeg, the ComfyUI server, the node pack and the seven model files.

  init <run-folder> --source <video> --identity <photo> --consent "<statement>" [--character "<card>"]
      Start a remake. --consent is your own statement that the person in the photo agreed to appear
      in this video and that you may reuse the source. It is stored in remake.json.

  swap <run> --shot <id> --start <s> --duration <s> [--prompt "<text>" | --prompt-file <f>]
       [--tier 480|768] [--seed <n>] [--expand <px>] [--recover]
       [--point <x,y> | --point-prepared <x,y>] [--detect <word>] [--selection largest|leftmost|rightmost|index] [--index <n>]
       [--crop <w:h:x:y>] [--reverse] [--timeout <s>]
  swap <run> --shot <id> --resume <prompt-id|last>  collect a job that timed out or whose answer was lost
                                                    (same for continue); nothing is submitted again
      Regenerate one stretch of the source with the person replaced.
      --crop      send only this area of the frame (for a small or distant subject); it is put back in place later
      --point     one click on the person to replace, in pixels of the source frame (needed when others are in
                  frame). --point-prepared gives it in pixels of the frame the model works at instead.
      --reverse   run the stretch backwards (when the subject is only clearly visible at its END), then flip the result

  continue <run> --shot <id> --after <shot> --seconds <s> (--prompt "<text>" | --prompt-file <f>)
       [--guide-frames <n>] [--seed <n>] [--timeout <s>]
      Extend a shot past its end. The last frames of <shot> are anchored so the movement carries on.

  place <run> --shot <id> [--attempt <n>] [--feather <px>]
      Fit the generated clip to the source frame (a cropped shot is blended back over the original).

  approve <run> --shot <id> [--note "<text>"]
      Record that you watched the placed shot and accept it.

  assemble <run> --segments "source:0-7.5,shot:far,source:10-13,shot:close,shot:more" [--allow-unapproved]
      Join stretches of the source and placed shots into the timeline.

  audio <run> --rights "<basis>" [--file <recording> (--start <s> | --match)]
      Add the sound. Default: the source's own audio. A remake longer than the source needs --file: the same
      track as a longer recording, placed with --start or found with --match. Never loops.
      --rights is your basis for publishing a video with this sound in it (your own recording, a licence,
      or "review copy only, not for publication"). It is stored with the remake.

  audio-offset --clip <file> --track <file>
      Where does the clip's sound sit inside the longer recording?

  compare <run>        Side-by-side video: source | remake.
  status <run>         What exists, what is approved, what is next.

  Common: --comfy-url <url> (default ${DEFAULT_COMFY_URL}), --allow-remote-comfy, --json
`;

type Flags = Record<string, string | true>;

export function parseArgs(argv: string[]): { cmd: string; pos: string[]; flags: Flags } {
    const [cmd = 'help', ...rest] = argv;
    const pos: string[] = [];
    const flags: Flags = {};
    const BOOL = ['json', 'reverse', 'recover', 'match', 'allow-remote-comfy', 'allow-unapproved', 'help'];
    for (let i = 0; i < rest.length; i++) {
        const a = rest[i];
        if (!a.startsWith('--')) {
            pos.push(a);
            continue;
        }
        const eq = a.indexOf('=');
        const key = eq > 0 ? a.slice(2, eq) : a.slice(2);
        if (BOOL.includes(key)) flags[key] = true;
        else if (eq > 0) flags[key] = a.slice(eq + 1);
        else if (i + 1 < rest.length) flags[key] = rest[++i];
        else throw new Error(`--${key} needs a value.`);
    }
    return { cmd, pos, flags };
}

const str = (f: Flags, k: string): string | undefined => (typeof f[k] === 'string' ? (f[k] as string) : undefined);
function need(f: Flags, k: string): string {
    const v = str(f, k);
    if (v === undefined || v === '') throw new Error(`--${k} is required.`);
    return v;
}
function num(f: Flags, k: string, fallback?: number): number {
    const v = str(f, k);
    if (v === undefined) {
        if (fallback === undefined) throw new Error(`--${k} is required.`);
        return fallback;
    }
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error(`--${k} must be a number; got "${v}".`);
    return n;
}
export function parseRect(v: string): Rect {
    const m = /^(\d+):(\d+):(\d+):(\d+)$/.exec(v);
    if (!m) throw new Error(`--crop must be w:h:x:y in pixels; got "${v}".`);
    return { w: Number(m[1]), h: Number(m[2]), x: Number(m[3]), y: Number(m[4]) };
}
export function parsePoint(v: string, flag: string): { x: number; y: number } {
    const m = /^(\d+),(\d+)$/.exec(v);
    if (!m) throw new Error(`--${flag} must be x,y in pixels; got "${v}".`);
    return { x: Number(m[1]), y: Number(m[2]) };
}

const log = (m: string) => process.stderr.write(`[remake] ${m}\n`);
let asJson = false;
function emit(data: Record<string, unknown>): void {
    if (asJson) process.stdout.write(`${JSON.stringify({ ok: true, ...data })}\n`);
    else for (const [k, v] of Object.entries(data)) process.stdout.write(`${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}\n`);
}

const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
async function swapTemplate(): Promise<Graph> {
    return JSON.parse(await readFile(path.join(SKILL_DIR, 'assets', 'workflows', 'h3_swap.api.json'), 'utf8'));
}
const comfyOf = (f: Flags) => new Comfy(str(f, 'comfy-url') ?? process.env.COMFY_LOCAL_URL ?? DEFAULT_COMFY_URL, Boolean(f['allow-remote-comfy']));
async function promptOf(f: Flags, required: boolean): Promise<string | undefined> {
    const file = str(f, 'prompt-file');
    const text = file ? (await readFile(file, 'utf8')).trim() : str(f, 'prompt');
    if (required && !text) throw new Error('A prompt is required: --prompt "<text>" or --prompt-file <file>.');
    return text;
}

// ---------------------------------------------------------------- doctor

async function doctor(f: Flags): Promise<void> {
    const report: Record<string, unknown> = {};
    for (const tool of ['ffmpeg', 'ffprobe']) {
        try {
            const r = await ff.run(tool, ['-version']);
            report[tool] = r.code === 0 ? r.stdout.toString().split('\n')[0].slice(0, 60) : 'not working';
        } catch (e) {
            report[tool] = `MISSING: ${(e as Error).message}`;
        }
    }
    try {
        const comfy = comfyOf(f);
        const stats = await comfy.json('/system_stats');
        report.comfyui = `${comfy.base} (ComfyUI ${stats?.system?.comfyui_version ?? '?'})`;
        report.gpu = (stats?.devices ?? []).map((d: any) => `${d.name}: ${Math.round((d.vram_total ?? 0) / 2 ** 30)} GB`).join('; ') || 'none reported';
        const missing = await comfy.missingNodes(REQUIRED_NODES);
        report.nodes = missing.length ? `MISSING: ${missing.join(', ')} — see references/setup.md` : 'all present';
        const have = new Set<string>();
        for (const [cls, input] of [['UNETLoader', 'unet_name'], ['CLIPLoader', 'clip_name'], ['VAELoader', 'vae_name'], ['LoraLoaderModelOnly', 'lora_name'], ['CheckpointLoaderSimple', 'ckpt_name']] as const) {
            for (const c of await comfy.choices(cls, input).catch(() => [])) have.add(path.basename(c.replace(/\\/g, '/')));
        }
        const lacking = Object.values(MODELS).filter((m) => !have.has(m));
        report.models = lacking.length ? `MISSING: ${lacking.join(', ')} — see references/setup.md` : 'all seven present';
    } catch (e) {
        report.comfyui = `NOT READY: ${(e as Error).message}`;
    }
    report.ready = !Object.values(report).some((v) => /MISSING|NOT READY|not working/.test(String(v)));
    emit(report);
    if (!report.ready) process.exitCode = 1;
}

// ---------------------------------------------------------------- init

async function init(pos: string[], f: Flags): Promise<void> {
    const run = pos[0];
    if (!run) throw new Error('Usage: init <run-folder> --source <video> --identity <photo> --consent "<statement>"');
    const consent = need(f, 'consent').trim();
    if (consent.length < 20) throw new Error('--consent must be a real sentence: who agreed to appear, and why you may reuse the source video.');
    const source = need(f, 'source');
    const identity = need(f, 'identity');
    await mkdir(run, { recursive: true });
    const release = await lockRun(run);
    try {
        await initLocked(run, f, consent, source, identity);
    } finally {
        await release();
    }
}

async function initLocked(run: string, f: Flags, consent: string, source: string, identity: string): Promise<void> {
    if (await stat(path.join(run, 'remake.json')).catch(() => null)) throw new Error(`${run} already holds a remake. Use another folder.`);
    await mkdir(path.join(run, 'refs'), { recursive: true });
    await mkdir(path.join(run, 'shots'), { recursive: true });
    const p = await ff.probe(source);
    const src = `source${path.extname(source).toLowerCase() || '.mp4'}`;
    const idf = `refs/identity${path.extname(identity).toLowerCase() || '.jpg'}`;
    await copyFile(source, path.join(run, src));
    await copyFile(identity, path.join(run, idf));
    const m: Manifest = {
        schema: SCHEMA,
        createdAt: new Date().toISOString(),
        source: { file: src, sha256: await sha256File(path.join(run, src)), width: p.width, height: p.height, fps: p.fps, duration: p.duration, hasAudio: p.hasAudio },
        consent: { statement: consent, at: new Date().toISOString() },
        references: [{ id: 'identity', role: 'identity', file: idf, sha256: await sha256File(path.join(run, idf)) }],
        ...(str(f, 'character') ? { character: str(f, 'character') } : {}),
        shots: [],
    };
    await save(run, m);
    emit({ run, source: `${p.width}x${p.height}, ${p.fps.toFixed(2)} fps, ${p.duration.toFixed(2)} s${p.hasAudio ? '' : ', no audio'}`, next: 'swap <run> --shot <id> --start <s> --duration <s> ...' });
}

// ---------------------------------------------------------------- generation

/** Waits for the attempt's job and downloads its video. `graph` is submitted first unless the attempt already has a job. */
async function generate(comfy: Comfy, graph: Graph | null, attempt: Attempt, run: string, m: Manifest, f: Flags, dest: string): Promise<void> {
    const timeoutMs = num(f, 'timeout', 1800) * 1000;
    const t0 = Date.now();
    try {
        if (!attempt.promptId) {
            if (!graph) throw new Error('This attempt was never submitted; run the command again without --resume.');
            // Saved BEFORE the request: if the answer is lost, the job is found again by this client id.
            await save(run, m);
            attempt.promptId = (await comfy.submit(graph, attempt.clientId)).promptId;
            await save(run, m);
            log(`submitted ${attempt.promptId}; waiting (this takes minutes)`);
        }
        let lastTick = 0;
        const entry = await comfy.wait(attempt.promptId, {
            timeoutMs,
            onTick: (_s, ms) => {
                if (ms - lastTick >= 30_000) {
                    lastTick = ms;
                    log(`still generating, ${Math.round(ms / 1000)} s`);
                }
            },
        });
        await comfy.download(pickVideo(entry, SAVE_NODE[attempt.kind]), dest);
        attempt.status = 'done';
        delete attempt.error;
        attempt.seconds = (attempt.seconds ?? 0) + Math.round((Date.now() - t0) / 1000);
    } catch (e) {
        attempt.status = e instanceof ComfyError && (e.kind === 'timeout' || e.kind === 'unknown_submit' || e.kind === 'unreachable') ? 'unknown' : 'failed';
        attempt.error = (e as Error).message;
        await save(run, m);
        throw e;
    }
}

/**
 * The attempt a --resume refers to. `--resume <prompt-id>` names a recorded job; `--resume last` takes the latest
 * unfinished attempt of the shot. An attempt whose submission was never confirmed has no job id yet: it is looked
 * up in ComfyUI by the client id that was saved before submitting. Nothing is prepared, uploaded or resubmitted.
 */
async function resumable(comfy: Comfy, s: Shot | undefined, id: string, promptId: string, kind: Attempt['kind']): Promise<Attempt> {
    if (!s) throw new Error(`There is no shot "${id}" to resume.`);
    const unfinished = s.attempts.filter((x) => x.status !== 'done' && x.kind === kind);
    let a = promptId === 'last' ? unfinished[unfinished.length - 1] : s.attempts.find((x) => x.promptId === promptId);
    if (!a && promptId !== 'last') {
        // A job id found by hand in ComfyUI: accept it only if ComfyUI says it was submitted with the client id
        // saved for one of this shot's unconfirmed attempts.
        const client = await comfy.clientOf(promptId);
        a = client ? unfinished.find((x) => !x.promptId && x.clientId === client) : undefined;
        if (a) a.promptId = promptId;
        else throw new Error(`Job ${promptId} does not belong to an unfinished ${kind} of shot "${id}"${client === null ? ' (ComfyUI does not know that job)' : ''}. status lists the unfinished attempts; --resume last looks the job up for you.`);
    }
    if (!a) throw new Error(`Shot "${id}" has no unfinished ${kind}.`);
    if (a.kind !== kind) throw new Error(`Job ${promptId} is a ${a.kind}, not a ${kind}.`);
    if (a.status === 'done') throw new Error(`Job ${promptId} was already collected (attempt ${a.n}).`);
    if (!a.promptId) {
        const found = await comfy.findByClient(a.clientId);
        if (!found) {
            throw new Error(`The job of attempt ${a.n} of shot "${id}" is not in ComfyUI's queue or in the history it still keeps. Either it never arrived or the history was cleared. Look in ComfyUI's output folder for files starting with "remake_${id}_${a.n}_" before making a new attempt; if you find the job id, pass it with --resume <prompt-id>.`);
        }
        a.promptId = found;
        log(`found the job of attempt ${a.n} in ComfyUI: ${found}`);
    }
    return a;
}

async function swap(pos: string[], f: Flags): Promise<void> {
    const run = pos[0];
    const m = await load(run);
    const id = checkId(need(f, 'shot'));
    const dir = path.join(run, 'shots', id);
    const comfy = comfyOf(f);
    let s = m.shots.find((x) => x.id === id);
    let attempt: Attempt;
    let graph: Graph | null = null;

    if (str(f, 'resume')) {
        // Collect a job that is already running or finished: nothing is prepared, uploaded or submitted again,
        // and the shot's own recorded settings decide how the result is treated.
        attempt = await resumable(comfy, s, id, str(f, 'resume')!, 'swap');
    } else {
        // Snapped to whole frames of the source, so the stretch recorded is exactly the one cut.
        const span = ff.frameSpan(num(f, 'start'), num(f, 'duration'), m.source.fps);
        const start = Number(span.start.toFixed(5));
        const duration = Number(span.duration.toFixed(5));
        if (start + duration > m.source.duration + 0.05) throw new Error(`The stretch ${start}–${(start + duration).toFixed(2)} s is outside the ${m.source.duration.toFixed(2)} s source.`);
        const tier = (str(f, 'tier') ?? SWAP_DEFAULTS.tier) as '480' | '768';
        if (!['480', '768'].includes(tier)) throw new Error('--tier is 480 or 768.');
        const crop = str(f, 'crop') ? parseRect(str(f, 'crop')!) : undefined;
        if (crop) ff.checkRect(crop, m.source);
        const reversed = Boolean(f.reverse);
        const sent: Rect = crop ?? { x: 0, y: 0, w: m.source.width, h: m.source.height };
        if (str(f, 'point') && str(f, 'point-prepared')) throw new Error('Give --point or --point-prepared, not both.');
        let point = str(f, 'point-prepared') ? parsePoint(str(f, 'point-prepared')!, 'point-prepared') : undefined;
        if (str(f, 'point')) {
            const canvas = tierCanvas(tier, sent);
            point = toPreparedPoint(parsePoint(str(f, 'point')!, 'point'), sent, canvas.w, canvas.h);
            log(`the model works at ${canvas.w}x${canvas.h}; the point is (${point.x}, ${point.y}) there`);
        }
        const selection = (str(f, 'selection') ?? SWAP_DEFAULTS.selection) as 'largest';
        if (!['largest', 'leftmost', 'rightmost', 'index'].includes(selection)) throw new Error('--selection is largest, leftmost, rightmost or index.');
        if (s && (s.kind !== 'swap' || s.start !== start || s.duration !== duration || JSON.stringify(s.crop) !== JSON.stringify(crop) || Boolean(s.reversed) !== reversed)) {
            throw new Error(`Shot "${id}" already exists with a different stretch, crop or direction. Use a new shot id.`);
        }
        if (!s) {
            s = { id, kind: 'swap', start, duration, ...(crop ? { crop } : {}), ...(reversed ? { reversed } : {}), attempts: [] };
            m.shots.push(s);
        }
        const n = s.attempts.length + 1;
        await mkdir(dir, { recursive: true });
        const driving = path.join(dir, 'driving.mp4');
        await ff.cut(path.join(run, m.source.file), driving, { start, duration, fps: m.source.fps, crop, reverse: reversed, hasAudio: m.source.hasAudio });
        // The first frame the model sees: the detector's point or word must hit the subject HERE.
        const firstFrame = path.join(dir, 'first_frame.jpg');
        await ff.frameAt(driving, firstFrame, 'first');
        log(`stretch ${start.toFixed(4)}–${(start + duration).toFixed(4)} s (source frames ${span.first}–${span.first + span.frames - 1}); first frame the model sees: ${firstFrame}`);
        const prefix = `remake_${id}_${n}_${randomUUID().slice(0, 8)}`;
        const settings = {
            tier,
            seed: num(f, 'seed', SWAP_DEFAULTS.seed),
            prompt: await promptOf(f, false),
            detect: str(f, 'detect') ?? SWAP_DEFAULTS.detect,
            selection,
            index: num(f, 'index', SWAP_DEFAULTS.index),
            point,
            expand: num(f, 'expand', SWAP_DEFAULTS.expand),
            recover: Boolean(f.recover),
        };
        const identity = reference(m, 'identity');
        graph = fillSwap(await swapTemplate(), {
            ...settings,
            video: await comfy.upload(driving, `${prefix}_driving.mp4`),
            identity: await comfy.upload(path.join(run, identity.file), `${prefix}_identity${path.extname(identity.file)}`),
            start: 0,
            duration,
            prefix,
        });
        attempt = { n, at: new Date().toISOString(), kind: 'swap', settings: { ...settings, identitySha256: identity.sha256 }, graphHash: graphHash(graph), clientId: randomUUID(), status: 'submitted' };
        s.attempts.push(attempt);
        // A new attempt makes everything built on this shot out of date, whether or not it succeeds.
        invalidate(m, id, 'attempt');
    }
    const raw = path.join(dir, `attempt${attempt.n}.raw.mp4`);
    await generate(comfy, graph, attempt, run, m, f, raw);
    const out = path.join(dir, `attempt${attempt.n}.mp4`);
    if (s!.reversed) await ff.reverse(raw, out);
    else await copyFile(raw, out);
    const p = await ff.probe(out);
    Object.assign(attempt, { output: path.relative(run, out).replace(/\\/g, '/'), outputSha256: await sha256File(out), frames: p.frames });
    invalidate(m, id, 'attempt');
    await save(run, m);
    emit({ shot: id, attempt: attempt.n, output: out, size: `${p.width}x${p.height}`, frames: p.frames, seconds: attempt.seconds, next: `place ${run} --shot ${id}   (then watch it, then approve)` });
}

async function continueShot(pos: string[], f: Flags): Promise<void> {
    const run = pos[0];
    const m = await load(run);
    const id = checkId(need(f, 'shot'));
    const dir = path.join(run, 'shots', id);
    const comfy = comfyOf(f);
    let s = m.shots.find((x) => x.id === id);
    let attempt: Attempt;
    let graph: Graph | null = null;

    if (str(f, 'resume')) {
        attempt = await resumable(comfy, s, id, str(f, 'resume')!, 'continue');
    } else {
        const after = shot(m, need(f, 'after'));
        if (after.crop) throw new Error(`Shot "${after.id}" was generated from a crop. Only a full-frame shot can be continued.`);
        const upstream = staleContinuation(m, after);
        if (upstream) throw new Error(`Shot "${after.id}" is out of date: ${upstream}. Regenerate it before continuing it.`);
        if (!after.approved || !after.placed || after.approved.sha256 !== after.placed.sha256) throw new Error(`Shot "${after.id}" is not approved. Place it, watch it and approve it first: the continuation is built on exactly that version.`);
        const seconds = num(f, 'seconds');
        if (!(seconds > 0) || seconds > 10) throw new Error('--seconds is the new material wanted, up to 10.');
        const guideFrames = num(f, 'guide-frames', CONTINUE_DEFAULTS.guideFrames);
        if (!Number.isInteger(guideFrames) || guideFrames < 1) throw new Error('--guide-frames is a whole number of frames, 1 or more.');
        const prev = chosen(after);
        const prevFile = path.join(run, prev.output!);
        if ((await sha256File(prevFile)) !== prev.outputSha256) throw new Error(`The file of shot "${after.id}" changed since it was generated. Generate it again.`);
        const pp = await ff.probe(prevFile);
        if (pp.width % 16 || pp.height % 16) throw new Error(`The shot to continue is ${pp.width}x${pp.height}; the model needs multiples of 16.`);
        if (s && (s.kind !== 'continue' || s.after !== after.id)) throw new Error(`Shot "${id}" already exists as something else. Use a new shot id.`);
        if (!s) {
            s = { id, kind: 'continue', after: after.id, attempts: [] };
            m.shots.push(s);
        }
        const n = s.attempts.length + 1;
        await mkdir(dir, { recursive: true });
        const scene = path.join(dir, 'scene.png');
        await ff.frameAt(prevFile, scene, 'last');
        const prefix = `remake_${id}_${n}_${randomUUID().slice(0, 8)}`;
        const identity = reference(m, 'identity');
        const settings = { seconds, guideFrames, seed: num(f, 'seed', CONTINUE_DEFAULTS.seed), steps: CONTINUE_DEFAULTS.steps, prompt: (await promptOf(f, true))!, width: pp.width, height: pp.height, afterAttempt: prev.n, afterSha256: prev.outputSha256, identitySha256: identity.sha256 };
        graph = buildContinuation({
            ...settings,
            scene: await comfy.upload(scene, `${prefix}_scene.png`),
            identity: await comfy.upload(path.join(run, identity.file), `${prefix}_identity${path.extname(identity.file)}`),
            previous: await comfy.upload(prevFile, `${prefix}_previous.mp4`),
            previousFrames: pp.frames,
            prefix,
        });
        attempt = { n, at: new Date().toISOString(), kind: 'continue', settings, graphHash: graphHash(graph), clientId: randomUUID(), status: 'submitted' };
        s.attempts.push(attempt);
        invalidate(m, id, 'attempt');
    }
    const guideFrames = Number(attempt.settings.guideFrames);
    const raw = path.join(dir, `attempt${attempt.n}.raw.mp4`);
    await generate(comfy, graph, attempt, run, m, f, raw);
    const expected = continuationFrames(Number(attempt.settings.seconds), guideFrames);
    const rp = await ff.probe(raw);
    if (rp.frames <= guideFrames) throw new Error(`The generated clip has ${rp.frames} frames, not more than the ${guideFrames} guide frames.`);
    const out = path.join(dir, `attempt${attempt.n}.mp4`);
    // This command owns the overlap: the guide frames repeat the end of the previous shot and are removed here, once.
    await ff.dropFrames(raw, out, guideFrames);
    const p = await ff.probe(out);
    Object.assign(attempt, { output: path.relative(run, out).replace(/\\/g, '/'), outputSha256: await sha256File(out), frames: p.frames });
    invalidate(m, id, 'attempt');
    await save(run, m);
    emit({ shot: id, attempt: attempt.n, output: out, generatedFrames: rp.frames, expectedFrames: expected.length, newFrames: p.frames, newSeconds: (p.frames / H3_FPS).toFixed(2), seconds: attempt.seconds, next: `place ${run} --shot ${id}` });
}

// ---------------------------------------------------------------- place / approve / assemble / audio

async function place(pos: string[], f: Flags): Promise<void> {
    const run = pos[0];
    const m = await load(run);
    const s = shot(m, need(f, 'shot'));
    if (str(f, 'attempt')) {
        const n = num(f, 'attempt');
        if (!s.attempts.some((a) => a.n === n && a.status === 'done')) throw new Error(`Shot "${s.id}" has no finished attempt ${n}.`);
        if (s.selected !== n) {
            // Choosing another attempt changes what any continuation was built on.
            invalidate(m, s.id, 'attempt');
            s.selected = n;
        }
    }
    const a = chosen(s);
    const stale = staleContinuation(m, s);
    if (stale) throw new Error(`Shot "${s.id}" is out of date: ${stale}. Generate it again with continue.`);
    const gen = path.join(run, a.output!);
    if ((await sha256File(gen)) !== a.outputSha256) throw new Error(`The generated file of attempt ${a.n} changed since it was made. Generate the shot again.`);
    const gp = await ff.probe(gen);
    const out = path.join(run, 'shots', s.id, 'placed.mp4');
    const frame = { width: m.source.width, height: m.source.height, fps: m.source.fps };
    let area: Rect | undefined;
    const feather = str(f, 'feather') ? num(f, 'feather') : undefined;
    // Exactly as many frames as the stretch it replaces (swap), or as its own length gives (continuation).
    const span = s.kind === 'swap' ? ff.frameSpan(s.start!, s.duration!, m.source.fps) : null;
    const frames = span ? span.frames : Math.round((gp.frames / H3_FPS) * m.source.fps);
    if (s.kind === 'swap' && s.crop) area = generatedArea(s.crop, gp.width, gp.height);
    await ff.placeBack({ source: path.join(run, m.source.file), firstFrame: span?.first ?? 0, frames, generated: gen, out, frame, area, feather });
    const pp = await ff.probe(out);
    if (pp.frames !== frames) throw new Error(`The placed clip has ${pp.frames} frames instead of ${frames}. It was not accepted.`);
    invalidate(m, s.id, 'placement');
    s.placed = { file: path.relative(run, out).replace(/\\/g, '/'), sha256: await sha256File(out), ...(area ? { area, feather: feather ?? 12 } : {}), fromAttempt: a.n };
    await save(run, m);
    emit({ shot: s.id, placed: out, frames, ...(area ? { area: `${area.w}x${area.h}+${area.x}+${area.y} (outside it the picture is the original)` } : { fit: 'whole frame' }), next: `watch ${out} in motion, then: approve ${run} --shot ${s.id}` });
}

async function approve(pos: string[], f: Flags): Promise<void> {
    const run = pos[0];
    const m = await load(run);
    const s = shot(m, need(f, 'shot'));
    if (!s.placed) throw new Error(`Shot "${s.id}" has not been placed yet. Run place first, and watch the result.`);
    const stale = staleContinuation(m, s);
    if (stale) throw new Error(`Shot "${s.id}" is out of date: ${stale}. Generate it again with continue.`);
    const sha = await sha256File(path.join(run, s.placed.file));
    if (sha !== s.placed.sha256) throw new Error('The placed file changed since it was written. Run place again.');
    s.approved = { at: new Date().toISOString(), sha256: sha, ...(str(f, 'note') ? { note: str(f, 'note') } : {}) };
    await save(run, m);
    emit({ shot: s.id, approved: s.placed.file });
}

async function assemble(pos: string[], f: Flags): Promise<void> {
    const run = pos[0];
    const m = await load(run);
    const segments = parseSegments(need(f, 'segments'));
    const src = path.join(run, m.source.file);
    if ((await sha256File(src)) !== m.source.sha256) throw new Error('The source file in the run folder changed since init.');
    const parts: ff.Segment[] = [];
    const notApproved: string[] = [];
    for (const seg of segments) {
        if ('source' in seg) {
            if (seg.source[1] > m.source.duration + 0.05) throw new Error(`source:${seg.source[0]}-${seg.source[1]} runs past the end of the source (${m.source.duration.toFixed(2)} s).`);
            const g = ff.frameSpan(seg.source[0], seg.source[1] - seg.source[0], m.source.fps);
            parts.push({ file: src, start: g.seek, frames: g.frames });
        } else {
            const s = shot(m, seg.shot);
            if (!s.placed) throw new Error(`Shot "${s.id}" has not been placed. Run place first.`);
            const stale = staleContinuation(m, s);
            if (stale) throw new Error(`Shot "${s.id}" is out of date: ${stale}. Generate it again with continue.`);
            // The file on disk, not the record: an edited file is not the one that was approved.
            if ((await sha256File(path.join(run, s.placed.file))) !== s.placed.sha256) throw new Error(`The placed file of shot "${s.id}" changed since it was written. Run place again.`);
            if (!s.approved || s.approved.sha256 !== s.placed.sha256) notApproved.push(s.id);
            parts.push({ file: path.join(run, s.placed.file) });
        }
    }
    if (notApproved.length && !f['allow-unapproved']) throw new Error(`Not approved yet: ${notApproved.join(', ')}. Watch each placed shot and run approve, or pass --allow-unapproved for a draft.`);
    const gaps = timelineGaps(segments, m.shots, m.source.fps);
    for (const g of gaps) log(`warning: ${g}. The picture after it will be out of step with the source sound.`);
    const out = path.join(run, 'timeline.mp4');
    await ff.concat(parts, out, m.source);
    const p = await ff.probe(out);
    m.timeline = { segments, file: 'timeline.mp4', sha256: await sha256File(out), duration: p.duration, ...(notApproved.length ? { draft: true } : {}) };
    delete m.final;
    await save(run, m);
    emit({ timeline: out, duration: p.duration.toFixed(2), frames: p.frames, sourceDuration: m.source.duration.toFixed(2), ...(notApproved.length ? { draft: `includes unapproved shots: ${notApproved.join(', ')}` } : {}), ...(gaps.length ? { gaps } : {}), next: `audio ${run} --rights "<basis>"` });
}

async function matchOffset(clip: string, track: string, clipSeconds: number): Promise<ReturnType<typeof findOffset>> {
    const [t, c] = await Promise.all([ff.decodeAudio(track, FINE_RATE), ff.decodeAudio(clip, FINE_RATE, { duration: Math.min(clipSeconds, 20) })]);
    return findOffset(t, c);
}

async function audio(pos: string[], f: Flags): Promise<void> {
    const run = pos[0];
    const m = await load(run);
    if (!m.timeline) throw new Error('Assemble the timeline first.');
    const video = path.join(run, m.timeline.file);
    if ((await sha256File(video)) !== m.timeline.sha256) throw new Error('timeline.mp4 changed since it was assembled. Run assemble again.');
    const rights = str(f, 'rights');
    if (!rights || rights.trim().length < 10) {
        throw new Error('--rights is required: your basis for a video that carries this sound (for example "my own recording", "licensed from <whom>", or "review copy only, not for publication"). The sound of someone else\'s reel is usually not yours to republish; for Instagram, add a library track in the app instead. The statement is stored with the remake.');
    }
    const src = path.join(run, m.source.file);
    const out = path.join(run, 'final.mp4');
    const file = str(f, 'file');
    const videoDuration = m.timeline.duration;
    if (!file) {
        const have = await ff.audioLength(src);
        if (!have) throw new Error('The source has no audio. Pass --file <recording> --start <s>.');
        if (videoDuration > have + 0.05) {
            throw new Error(`The remake (${videoDuration.toFixed(2)} s) is longer than the source's audio (${have.toFixed(2)} s). Pass --file <a longer recording of the same track> with --match or --start. The audio is never looped.`);
        }
        const gaps = timelineGaps(m.timeline.segments, m.shots, m.source.fps);
        if (gaps.length) log(`warning: the timeline skips or repeats source time (${gaps.length} place${gaps.length > 1 ? 's' : ''}); the source sound will not stay in step after the first one.`);
        await ff.mux(video, src, out, { audioStart: 0, videoDuration, audioDuration: have });
        m.audio = { mode: 'source', start: 0, rights: rights.trim() };
    } else {
        const audioDuration = await ff.audioLength(file);
        let start: number;
        let match: Record<string, unknown> | undefined;
        if (f.match) {
            if (!m.source.hasAudio) throw new Error('--match compares with the source audio, and the source has none. Use --start.');
            const r = await matchOffset(src, file, m.source.duration);
            match = { ...r };
            if (r.verdict !== 'match') throw new Error(`Could not place the source's sound inside that recording with confidence (waveform match ${r.score.toFixed(2)}, next best place ${r.runnerUp.toFixed(2)}). It may be a different version of the track. Give the position yourself with --start.`);
            start = r.offset;
        } else start = num(f, 'start');
        await ff.mux(video, file, out, { audioStart: start, videoDuration, audioDuration });
        // Measure where the sound of the finished file actually sits in the recording, instead of trusting the cut.
        const check = await matchOffset(out, file, videoDuration);
        const placedAt = check.verdict === 'match' ? Number(check.offset.toFixed(4)) : null;
        if (placedAt === null) log('warning: the position of the sound in the finished file could not be measured (the track repeats, or is too quiet there). Check the sync by ear.');
        if (placedAt !== null && Math.abs(placedAt - start) > 0.02) throw new Error(`The sound ended up ${(1000 * (placedAt - start)).toFixed(0)} ms away from where it was meant to be. The file was not accepted.`);
        m.audio = { mode: 'file', file: path.resolve(file), sha256: await sha256File(file), start, ...(match ? { match } : {}), measuredStart: placedAt, rights: rights.trim() };
    }
    const p = await ff.probe(out);
    m.final = { file: 'final.mp4', sha256: await sha256File(out), duration: p.duration, at: new Date().toISOString(), ...(m.timeline.draft ? { draft: true } : {}) };
    await save(run, m);
    emit({ final: out, duration: p.duration.toFixed(2), audio: m.audio.mode === 'source' ? 'source audio' : `${path.basename(file!)} from ${m.audio.start.toFixed(3)} s (measured in the finished file: ${m.audio.measuredStart ?? 'could not be measured'})`, ...(file ? { note: 'The recording replaces the whole soundtrack, including any voices or ambience of the source.' } : {}), next: `compare ${run}   then watch final.mp4 with sound before publishing` });
}

async function audioOffset(f: Flags): Promise<void> {
    const clip = need(f, 'clip');
    const p = await ff.probe(clip).catch(() => null);
    const r = await matchOffset(clip, need(f, 'track'), p?.duration ?? 20);
    emit({ ...r, offset: Number(r.offset.toFixed(4)) });
    if (r.verdict !== 'match') process.exitCode = 1;
}

async function compare(pos: string[]): Promise<void> {
    const run = pos[0];
    const m = await load(run);
    const result = m.final?.file ?? m.timeline?.file;
    if (!result) throw new Error('Nothing to compare yet: assemble the timeline first.');
    const want = m.final?.sha256 ?? m.timeline!.sha256;
    if ((await sha256File(path.join(run, result))) !== want) throw new Error(`${result} changed since it was made. Run assemble (and audio) again.`);
    const out = path.join(run, 'compare.mp4');
    await ff.sideBySide(path.join(run, m.source.file), path.join(run, result), out);
    emit({ compare: out, left: 'source', right: result });
}

async function status(pos: string[]): Promise<void> {
    const run = pos[0];
    const m = await load(run);
    const shots = m.shots.map((s) => {
        const done = s.attempts.filter((a) => a.status === 'done').length;
        const unknown = s.attempts.filter((a) => a.status === 'unknown');
        let stale: string | null = null;
        try {
            stale = staleContinuation(m, s);
        } catch {
            stale = null;
        }
        const state = stale ? `out of date: ${stale}` : s.approved && s.placed && s.approved.sha256 === s.placed.sha256 ? 'approved' : s.placed ? 'placed, not approved' : done ? 'generated, not placed' : unknown.length ? `unfinished job ${unknown[unknown.length - 1].promptId ?? '(not submitted?)'}: re-run with --resume` : 'no finished attempt';
        return { id: s.id, kind: s.kind, attempts: s.attempts.length, state };
    });
    emit({ run, source: `${m.source.width}x${m.source.height} ${m.source.duration.toFixed(2)} s`, shots, timeline: m.timeline ? `${m.timeline.duration.toFixed(2)} s${m.timeline.draft ? ' (draft: unapproved shots)' : ''}` : 'not assembled', final: m.final ? `${m.final.file}${m.final.draft ? ' (draft)' : ''}` : 'not made' });
}

// ---------------------------------------------------------------- entry

export async function main(argv: string[]): Promise<void> {
    const { cmd, pos, flags } = parseArgs(argv);
    asJson = Boolean(flags.json);
    if (cmd === 'help' || cmd === '--help' || flags.help) {
        process.stdout.write(HELP);
        return;
    }
    const needsRun = ['swap', 'continue', 'place', 'approve', 'assemble', 'audio', 'compare', 'status'];
    if (needsRun.includes(cmd) && !pos[0]) throw new Error(`Usage: ${cmd} <run-folder> ...`);
    const writers: Record<string, (pos: string[], f: Flags) => Promise<void>> = { swap, continue: continueShot, place, approve, assemble, audio };
    if (writers[cmd]) {
        await load(pos[0]); // a clear error before locking when the folder is not a remake
        const release = await lockRun(pos[0]);
        try {
            return await writers[cmd](pos, flags);
        } finally {
            await release();
        }
    }
    switch (cmd) {
        case 'doctor':
            return doctor(flags);
        case 'init':
            return init(pos, flags);
        case 'audio-offset':
            return audioOffset(flags);
        case 'compare':
            return compare(pos);
        case 'status':
            return status(pos);
        default:
            throw new Error(`Unknown command "${cmd}". Run with --help.`);
    }
}

if (import.meta.main) {
    main(process.argv.slice(2)).catch((e) => {
        const message = (e as Error).message;
        if (asJson || process.argv.includes('--json')) process.stdout.write(`${JSON.stringify({ ok: false, error: message, kind: e instanceof ComfyError ? e.kind : e instanceof ff.ToolError ? 'tool' : 'error' })}\n`);
        else process.stderr.write(`Error: ${message}\n`);
        process.exitCode = 1;
    });
}
