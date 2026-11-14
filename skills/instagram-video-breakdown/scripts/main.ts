#!/usr/bin/env -S npx -y bun
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { analyseAudio } from './audio.ts';
import { analysisId, answersTemplate, applyReview, buildScript, buildTasks, pacing, recreateMarkdown, summaryText, type Breakdown, type Shot } from './breakdown.ts';
import { DEFAULT_MAX_BYTES, SelectionError, fetchFromFile, fetchFromInstagram, type Meta } from './fetch.ts';
import { ToolError, installHint, majorOf, toolVersion } from './ff.ts';
import { applyOverrides, detectCuts, diffCuts, exportShotImages, grayFrames, mergeCuts, motionForShot, pairStats, probe, recordOverrides, sheet, spans, storyboard, textCandidates, type CutOverrides } from './shots.ts';
import { importTranscript, runRecogniser, type Transcript } from './transcript.ts';

const HELP = `Instagram video breakdown: reverse-engineer a reel so a similar one can be made

Usage: npx -y bun scripts/main.ts <command> [options]

  doctor                                   Check ffmpeg, ffprobe, Bun, the speech recogniser setting and comfy
  fetch <url|shortcode|id> -o <dir>        Download one video and its metadata (read-only, needs \`login\` in the instagram skill)
        [--item N] [--max-bytes N]         --item picks one video of a carousel (1-based)
  fetch --file <video> -o <dir>            Use a local video instead (no Instagram session needed)
  analyze <dir> [--scene 0.30]             Cuts, per-shot frames and strips, motion and text-change hints, audio facts
        [--max-duration 900]               Refuse longer videos (frames and audio are decoded into memory)
        [--add-cut t1,t2] [--remove-cut t] [--reset-cuts]   Manual cut corrections (remembered in cuts_override.json)
        [--no-diff-cuts]                   Use only ffmpeg's scene score (skip the frame-difference cuts)
  frames <dir> --from <s> --to <s> [--fps 4]    Dense sheet of any time range, timestamps under each tile
  transcribe <dir> --import <file>         Use an existing transcript (.srt, .vtt, .json)
  transcribe <dir> --cmd "<template>"      Run your own recogniser; template uses {audio} and {out} (and optional {lang})
        [--lang xx]                        Also read from IG_BREAKDOWN_ASR_CMD
  review <dir>                             Write review_tasks.json and a review_answers.json template
  apply-review <dir> [--answers <file>]    Validate the answers and merge them into breakdown.json
  summary <dir>                            Print the breakdown and write recreate.md

Output is JSON on stdout unless noted; progress goes to stderr.`;

class UsageError extends Error {}
const log = (m: string) => process.stderr.write(`${m}\n`);
const print = (o: unknown) => process.stdout.write(`${typeof o === 'string' ? o : JSON.stringify(o, null, 2)}\n`);

interface Args {
    _: string[];
    flags: Record<string, string | true>;
}

const VALUE_FLAGS = new Set(['o', 'out', 'item', 'max-bytes', 'max-duration', 'file', 'scene', 'add-cut', 'remove-cut', 'from', 'to', 'fps', 'import', 'cmd', 'lang', 'answers']);

function parseArgs(argv: string[]): Args {
    const out: Args = { _: [], flags: {} };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a.startsWith('--') || (a.startsWith('-') && a.length === 2 && !/\d/.test(a[1]))) {
            const name = a.replace(/^-+/, '');
            const eq = name.indexOf('=');
            if (eq > 0) out.flags[name.slice(0, eq)] = name.slice(eq + 1);
            else if (VALUE_FLAGS.has(name)) {
                if (i + 1 >= argv.length) throw new UsageError(`--${name} needs a value.`);
                out.flags[name] = argv[++i];
            } else out.flags[name] = true;
        } else out._.push(a);
    }
    return out;
}

const str = (a: Args, ...names: string[]) => {
    for (const n of names) if (typeof a.flags[n] === 'string') return a.flags[n] as string;
    return undefined;
};
function num(a: Args, name: string): number | undefined {
    const v = str(a, name);
    if (v === undefined) return undefined;
    const n = Number(v);
    if (!Number.isFinite(n)) throw new UsageError(`--${name} must be a number.`);
    return n;
}
const list = (v: string | undefined) => (v ? v.split(',').map((x) => Number(x.trim())) : []);

function dirArg(a: Args): string {
    const d = a._[1];
    if (!d) throw new UsageError('Pass the breakdown directory (the -o directory used with fetch).');
    return path.resolve(d);
}

async function readJson<T>(file: string): Promise<T | null> {
    try {
        return JSON.parse(await readFile(file, 'utf8')) as T;
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw new Error(`${file} is not valid JSON: ${(e as Error).message}`);
    }
}
const writeJson = (file: string, data: unknown) => writeFile(file, `${JSON.stringify(data, null, 2)}\n`);

async function loadBreakdown(dir: string): Promise<Breakdown> {
    const b = await readJson<Breakdown>(path.join(dir, 'breakdown.json'));
    if (!b) throw new UsageError(`No breakdown.json in ${dir}. Run: analyze ${dir}`);
    return b;
}

async function requireFf(): Promise<void> {
    for (const tool of ['ffmpeg', 'ffprobe']) {
        if (!(await toolVersion(tool))) throw new ToolError(`${tool} was not found on PATH.`, installHint(tool));
    }
}

async function doctor() {
    const [ff, fp, comfy] = await Promise.all([toolVersion('ffmpeg'), toolVersion('ffprobe'), toolVersion('comfy', '--version')]);
    const asr = process.env.IG_BREAKDOWN_ASR_CMD ?? null;
    const problems: string[] = [];
    if (!ff) problems.push(`ffmpeg missing. ${installHint('ffmpeg')}`);
    else if ((majorOf(ff) ?? 99) < 6) problems.push(`ffmpeg ${ff} is older than 6; update it.`);
    if (!fp) problems.push(`ffprobe missing. ${installHint('ffprobe')}`);
    const result = {
        ok: problems.length === 0,
        required: { ffmpeg: ff, ffprobe: fp, bun: typeof Bun !== 'undefined' ? Bun.version : null },
        optional: {
            speech_recogniser: asr ? 'configured (IG_BREAKDOWN_ASR_CMD)' : 'not configured: the script will be "unconfirmed" until you run transcribe (references/transcription.md)',
            comfy: comfy ?? `not found. ${installHint('comfy')}`,
        },
        problems,
    };
    print(result);
    return problems.length ? 1 : 0;
}

async function cmdFetch(a: Args) {
    const out = str(a, 'o', 'out');
    if (!out) throw new UsageError('fetch needs -o <dir>.');
    const dir = path.resolve(out);
    await mkdir(dir, { recursive: true });
    const file = str(a, 'file');
    let meta: Meta;
    if (file) meta = await fetchFromFile(path.resolve(file), dir);
    else {
        const ref = a._[1];
        if (!ref) throw new UsageError('fetch needs an Instagram link, shortcode or id (or --file <video>).');
        const item = num(a, 'item');
        try {
            meta = await fetchFromInstagram(ref, dir, { item, maxBytes: num(a, 'max-bytes') ?? DEFAULT_MAX_BYTES, log });
        } catch (e) {
            if (e instanceof SelectionError) {
                print({ ok: false, error: e.message, children: e.children });
                return 2;
            }
            throw e;
        }
    }
    print({ ok: true, dir, video: meta.video, owner: meta.owner, duration_sec: meta.duration_sec, collection: meta.collection, audio_attribution: meta.audio_attribution, next: `analyze ${dir}` });
    return 0;
}

async function loadTranscript(dir: string): Promise<Transcript | null> {
    return readJson<Transcript>(path.join(dir, 'transcript.json'));
}

async function analyze(a: Args) {
    const dir = dirArg(a);
    await requireFf();
    const video = path.join(dir, 'source', 'video.mp4');
    const meta = await readJson<Meta>(path.join(dir, 'source', 'meta.json'));
    if (!meta) throw new UsageError(`No source/meta.json in ${dir}. Run fetch first.`);
    const threshold = num(a, 'scene') ?? 0.3;
    if (!(threshold > 0 && threshold < 1)) throw new UsageError('--scene must be between 0 and 1.');

    const overridesFile = path.join(dir, 'cuts_override.json');
    const remembered: CutOverrides = a.flags['reset-cuts'] ? { add: [], remove: [] } : ((await readJson<CutOverrides>(overridesFile)) ?? { add: [], remove: [] });
    const add = list(str(a, 'add-cut'));
    const remove = list(str(a, 'remove-cut'));
    if ([...add, ...remove].some((n) => !Number.isFinite(n) || n < 0)) throw new UsageError('--add-cut / --remove-cut take seconds, comma separated.');
    const overrides = recordOverrides(remembered, add, remove);
    if (add.length || remove.length || a.flags['reset-cuts']) await writeJson(overridesFile, overrides);

    log('[breakdown] probing');
    const facts = await probe(video);
    const maxDuration = num(a, 'max-duration') ?? 900;
    if (facts.duration > maxDuration) {
        // Frames and audio are decoded into memory; an unbounded input could exhaust it.
        throw new UsageError(`This video is ${Math.round(facts.duration)} s long; the limit is ${maxDuration} s (decoded frames and audio are held in memory). Trim it with ffmpeg, or raise --max-duration if the machine has the memory.`);
    }
    log('[breakdown] detecting cuts');
    const scene = mergeCuts(await detectCuts(video, threshold), facts.duration);
    log('[breakdown] measuring motion');
    const frames = await grayFrames(video);
    const pairs = pairStats(frames);
    const fromDiff = a.flags['no-diff-cuts'] ? [] : diffCuts(pairs, scene);
    const detected = mergeCuts([...scene, ...fromDiff], facts.duration);
    const cuts = applyOverrides(detected, overrides, facts.duration);
    const shotSpans = spans(cuts, facts.duration);
    log(`[breakdown] ${shotSpans.length} shots`);
    const candidates = textCandidates(pairs, cuts);
    const shots: Shot[] = [];
    for (const s of shotSpans) {
        log(`[breakdown] frames for shot ${s.id}/${shotSpans.length}`);
        shots.push({
            ...s,
            motion: motionForShot(frames, pairs, s),
            text_change_candidates: candidates.filter((c) => c.t > s.start && c.t <= s.end),
            images: await exportShotImages(video, dir, s, facts.fps),
            review: null,
        });
    }
    const board = await storyboard(dir, shots.map((s) => s.images.mid));
    log('[breakdown] audio');
    const audio = await analyseAudio(video, dir, cuts, facts.hasAudio);
    const transcript = await loadTranscript(dir);
    const { script, speech } = buildScript(shots, transcript);
    const b: Breakdown = {
        schema: 'ig.breakdown.v1',
        analysis_id: analysisId(facts.duration, cuts),
        generated_at: new Date().toISOString(),
        source: meta,
        video: facts,
        cuts: { threshold, detected, from_frame_diff: fromDiff, added: overrides.add, removed: overrides.remove, final: cuts },
        pacing: pacing(shots, facts.duration),
        shots,
        audio,
        storyboard: board,
        transcript: transcript ? { file: 'transcript.json', source: transcript.source, language: transcript.language, segments: transcript.segments.length } : null,
        review: null,
        script,
        speech,
    };
    await writeJson(path.join(dir, 'breakdown.json'), b);
    print({
        ok: true, dir, duration: facts.duration, shots: shots.length, pacing: b.pacing,
        low_motion_shots: shots.filter((s) => s.motion.low_motion).map((s) => s.id),
        text_change_candidates: candidates.length,
        audio: { present: audio.present, bpm: audio.rhythm?.bpm ?? null, rhythm_reason: audio.rhythm_reason },
        speech: speech.status,
        next: transcript ? `review ${dir}` : `transcribe ${dir} (optional, needed for the script), then review ${dir}`,
    });
    return 0;
}

async function cmdFrames(a: Args) {
    const dir = dirArg(a);
    await requireFf();
    const b = await loadBreakdown(dir);
    const from = num(a, 'from');
    const to = num(a, 'to');
    if (from === undefined || to === undefined || !(to > from) || from < 0 || to > b.video.duration + 0.05) throw new UsageError(`frames needs --from and --to within 0-${b.video.duration}.`);
    const fps = num(a, 'fps') ?? 4;
    if (!(fps > 0 && fps <= 30)) throw new UsageError('--fps must be between 0 and 30.');
    await mkdir(path.join(dir, 'frames'), { recursive: true });
    const rel = `frames/frames_${from.toFixed(2)}_${to.toFixed(2)}.jpg`;
    const s = await sheet(path.join(dir, 'source', 'video.mp4'), from, to, fps, path.join(dir, rel), 300, 48);
    print({ ok: true, image: path.join(dir, rel), fps: s.fps, times: s.times, timestamps_burned: s.labelled });
    return 0;
}

async function transcribe(a: Args) {
    const dir = dirArg(a);
    const lang = str(a, 'lang') ?? null;
    const imp = str(a, 'import');
    const cmd = str(a, 'cmd') ?? process.env.IG_BREAKDOWN_ASR_CMD;
    let t: Transcript;
    if (imp) t = await importTranscript(path.resolve(imp), lang);
    else if (cmd) {
        const audio = path.join(dir, 'source', 'audio.wav');
        const b = await readJson<Breakdown>(path.join(dir, 'breakdown.json'));
        if (b && !b.audio.present) throw new UsageError('This video has no audio stream; there is nothing to transcribe.');
        if (!(await readFile(audio).catch(() => null))) throw new UsageError(`No source/audio.wav in ${dir}. Run analyze first.`);
        log('[breakdown] running the recogniser');
        t = await runRecogniser(cmd, audio, path.join(dir, 'asr_out'), lang);
    } else {
        print({
            ok: false,
            error: 'No transcript source. This skill ships no speech model.',
            options: [
                'transcribe <dir> --import <file.srt|.vtt|.json>   (any transcript you already have)',
                'transcribe <dir> --cmd "<your recogniser> {audio} {out}"   (or set IG_BREAKDOWN_ASR_CMD)',
                'Recipes for Whisper and other local models: references/transcription.md',
                'Or skip it: the script stays "unconfirmed" and everything else still works.',
            ],
        });
        return 2;
    }
    await writeJson(path.join(dir, 'transcript.json'), t);
    let reviewCleared = false;
    let speechNote: string | undefined;
    const b = await readJson<Breakdown>(path.join(dir, 'breakdown.json'));
    if (b) {
        const { script, speech } = buildScript(b.shots, t);
        // Conclusions of an earlier review may rest on the old transcript: they are cleared, and
        // apply-review rebuilds them from the (kept) answers file against the new one.
        reviewCleared = Boolean(b.review);
        await writeJson(path.join(dir, 'breakdown.json'), { ...b, shots: b.shots.map((s) => ({ ...s, review: null })), review: null, transcript: { file: 'transcript.json', source: t.source, language: t.language, segments: t.segments.length }, script, speech });
        speechNote = speech.reason;
    }
    print({ ok: true, segments: t.segments.length, language: t.language, source: t.source, preview: t.segments.slice(0, 3), ...(speechNote ? { note: speechNote } : {}), next: reviewCleared ? `The earlier review was cleared because the transcript changed: apply-review ${dir}` : `review ${dir}` });
    return 0;
}

async function review(a: Args) {
    const dir = dirArg(a);
    const b = await loadBreakdown(dir);
    const tasks = buildTasks(b, await loadTranscript(dir));
    await writeJson(path.join(dir, 'review_tasks.json'), tasks);
    const answers = path.join(dir, 'review_answers.json');
    let existing = await readJson<{ analysis_id?: string }>(answers);
    let stale: string | null = null;
    if (existing && existing.analysis_id !== b.analysis_id) {
        // Written for other shots: keep it aside so it cannot be applied to this analysis.
        stale = path.join(dir, 'review_answers.stale.json');
        await rename(answers, stale);
        existing = null;
    }
    if (!existing) await writeJson(answers, answersTemplate(b));
    print({ ok: true, tasks: path.join(dir, 'review_tasks.json'), answers, answers_created: !existing, ...(stale ? { stale_answers_moved_to: stale } : {}), shots: b.shots.length, next: `Read the images in review_tasks.json, fill review_answers.json, then: apply-review ${dir}` });
    return 0;
}

async function apply(a: Args) {
    const dir = dirArg(a);
    const b = await loadBreakdown(dir);
    const file = path.resolve(str(a, 'answers') ?? path.join(dir, 'review_answers.json'));
    const answers = await readJson<unknown>(file);
    if (!answers) throw new UsageError(`No answers file at ${file}. Run review first.`);
    const res = applyReview(b, answers, await loadTranscript(dir));
    if (res.splits.length && !res.errors.length) {
        print({ ok: false, reason: 'missed_cuts', splits: res.splits, next: `analyze ${dir} --add-cut ${res.splits.join(',')}  then review again (shot numbers change)` });
        return 2;
    }
    if (!res.ok || !res.breakdown) {
        print({ ok: false, errors: res.errors, warnings: res.warnings, downgrades: res.downgrades });
        return 1;
    }
    await writeJson(path.join(dir, 'breakdown.json'), res.breakdown);
    print({ ok: true, warnings: res.warnings, downgrades: res.downgrades, next: `summary ${dir}` });
    return 0;
}

async function summary(a: Args) {
    const dir = dirArg(a);
    const b = await loadBreakdown(dir);
    let recreate: string | null = null;
    if (b.review) {
        const [ff, comfy] = await Promise.all([toolVersion('ffmpeg'), toolVersion('comfy', '--version')]);
        recreate = path.join(dir, 'recreate.md');
        await writeFile(recreate, recreateMarkdown(b, { ffmpeg: ff, comfy }));
    }
    print(summaryText(b) + (recreate ? `\n\nRecreate plan: ${recreate}` : ''));
    return 0;
}

async function main(): Promise<number> {
    const a = parseArgs(process.argv.slice(2));
    const cmd = a._[0];
    if (!cmd || a.flags.help || a.flags.h) {
        print(HELP);
        return cmd || a.flags.help || a.flags.h ? 0 : 1;
    }
    switch (cmd) {
        case 'doctor': return doctor();
        case 'fetch': return cmdFetch(a);
        case 'analyze': return analyze(a);
        case 'frames': return cmdFrames(a);
        case 'transcribe': return transcribe(a);
        case 'review': return review(a);
        case 'apply-review': return apply(a);
        case 'summary': return summary(a);
        default: throw new UsageError(`Unknown command "${cmd}". Run with --help.`);
    }
}

main().then(
    (code) => process.exit(code),
    (e) => {
        const err = e as Error & { hint?: string; kind?: string };
        print({ ok: false, error: err.message, ...(err.kind ? { kind: err.kind } : {}), ...(err.hint ? { hint: err.hint } : {}) });
        process.exit(e instanceof UsageError ? 2 : 1);
    },
);
