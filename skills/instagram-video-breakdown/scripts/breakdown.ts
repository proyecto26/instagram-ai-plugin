/**
 * breakdown.json schema, the review contract and its validation, and the text deliverables.
 *
 * Division of labour: scripts measure, the reviewing agent looks at frames and describes, and
 * this file refuses any conclusion that has no observation behind it (speech without a
 * transcript, music or voice that nobody listened to).
 */
import type { AudioFacts } from './audio.ts';
import type { Meta } from './fetch.ts';
import type { Motion, ShotImages, TextCandidate, VideoFacts } from './shots.ts';
import { segmentsForShot, withinVideo, type Segment, type Transcript } from './transcript.ts';

export const SHOT_TYPES = ['filmed', 'film_clip', 'ai_video', 'avatar', 'render_3d', 'animation_2d', 'code_render', 'screen_recording', 'still_pan_zoom', 'static_hold'] as const;
export type ShotType = (typeof SHOT_TYPES)[number];
/** Types that claim a continuously moving picture. */
export const MOVING_TYPES: ShotType[] = ['filmed', 'film_clip', 'ai_video'];
export const TEXT_ROLES = ['caption', 'title', 'label', 'sticker', 'watermark', 'ui'] as const;
export const LAYER_KINDS = ['sticker', 'picture_in_picture', 'screenshot', 'logo', 'shape', 'other'] as const;
export const SUPPLY = ['user_must_supply', 'can_generate', 'reference_only'] as const;
export const AUDIO_SOURCES = ['transcript', 'user_listened', 'no_audio_stream'] as const;
export type Tri = true | false | 'unconfirmed';

export interface Shot {
    id: number;
    start: number;
    end: number;
    duration: number;
    motion: Motion;
    text_change_candidates: TextCandidate[];
    images: ShotImages;
    review: ShotReview | null;
}

export interface TextItem {
    text: string;
    role: (typeof TEXT_ROLES)[number];
    position: string;
    start: number;
    end: number;
    style?: string;
}

export interface Layer {
    kind: (typeof LAYER_KINDS)[number];
    description: string;
    position: string;
    action?: string;
    start: number;
    end: number;
    asset?: string;
}

export interface ShotReview {
    type: ShotType;
    confidence: number;
    evidence: string[];
    description: string;
    camera?: string;
    transition_in?: string;
    motion_note?: string;
    on_screen_text: TextItem[];
    layers: Layer[];
}

export interface Breakdown {
    schema: 'ig.breakdown.v1';
    /** Changes whenever the shots change; review answers are bound to it. */
    analysis_id: string;
    generated_at: string;
    source: Meta;
    video: VideoFacts;
    cuts: { threshold: number; detected: number[]; from_frame_diff: number[]; added: number[]; removed: number[]; final: number[] };
    pacing: { shots: number; median_shot_sec: number; mean_shot_sec: number; cuts_per_10s: number };
    shots: Shot[];
    audio: AudioFacts;
    storyboard: string | null;
    transcript: { file: string; source: string; language: string | null; segments: number } | null;
    review: TopReview | null;
    script: ScriptLine[] | null;
    speech: { status: 'transcribed' | 'none_transcribed' | 'unconfirmed'; reason?: string };
}

export interface ScriptLine {
    shot: number;
    start: number;
    end: number;
    text: string;
    speaker?: string;
}

export interface TopReview {
    hook: string;
    structure: Array<{ label: string; start: number; end: number; note?: string }>;
    cast: Array<{ id: string; description: string; appears_in: number[] }>;
    visual_style: string;
    audio_notes: {
        voice_present: Tri;
        music_present: Tri;
        evidence: { voice?: { source: string; note?: string }; music?: { source: string; note?: string } };
        description?: string;
        mix?: string;
    };
    sound_cues: Array<{ t: number; description: string; visual_event?: string; source: 'user_listened' | 'unconfirmed' }>;
    assets: Array<{ id: string; kind: string; description: string; used_in: number[]; supply: (typeof SUPPLY)[number] }>;
    applied_at?: string;
    notes?: string[];
}

/** Stable id of a segmentation: same duration and cuts give the same id. */
export function analysisId(duration: number, cuts: number[]): string {
    let h = 2166136261;
    for (const ch of `${duration.toFixed(3)}|${cuts.map((c) => c.toFixed(3)).join(',')}`) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
    return `a${h.toString(16).padStart(8, '0')}-${cuts.length + 1}`;
}

export function pacing(shots: Array<{ duration: number }>, duration: number): Breakdown['pacing'] {
    const d = shots.map((s) => s.duration).sort((a, b) => a - b);
    const mid = Math.floor(d.length / 2);
    const median = d.length ? (d.length % 2 ? d[mid] : (d[mid - 1] + d[mid]) / 2) : 0;
    return {
        shots: shots.length,
        median_shot_sec: r2(median),
        mean_shot_sec: r2(d.reduce((a, b) => a + b, 0) / Math.max(1, d.length)),
        cuts_per_10s: r2(((shots.length - 1) / Math.max(0.001, duration)) * 10),
    };
}

export function buildScript(shots: Array<{ id: number; start: number; end: number }>, transcript: Transcript | null): { script: ScriptLine[] | null; speech: Breakdown['speech'] } {
    if (!transcript) return { script: null, speech: { status: 'unconfirmed', reason: 'no_transcript' } };
    const duration = shots.length ? shots[shots.length - 1].end : 0;
    const usable = withinVideo(transcript.segments, duration);
    const outside = transcript.segments.length - usable.length;
    if (!usable.length) {
        return { script: [], speech: { status: 'none_transcribed', reason: outside ? `All ${outside} transcript segment(s) start after the video ends (${duration}s): is this the transcript of another file?` : 'The recogniser returned no speech. That does not prove nobody speaks.' } };
    }
    const map = segmentsForShot(usable, shots);
    const script: ScriptLine[] = [];
    for (const s of shots) for (const seg of map.get(s.id) ?? []) script.push({ shot: s.id, start: seg.start, end: seg.end, text: seg.text, ...(seg.speaker ? { speaker: seg.speaker } : {}) });
    return { script, speech: { status: 'transcribed', ...(outside ? { reason: `${outside} transcript segment(s) after the end of the video were ignored.` } : {}) } };
}

// ---------- review tasks ----------

export function buildTasks(b: Breakdown, transcript: Transcript | null) {
    const segs = transcript ? segmentsForShot(withinVideo(transcript.segments, b.video.duration), b.shots) : null;
    return {
        schema: 'ig.review_tasks.v1',
        analysis_id: b.analysis_id,
        instructions: [
            'Open every image listed for a shot before answering. The strip is the timeline of the shot at strip_fps; use it for text that changes.',
            'If a strip is not enough to read or time a text, run: main.ts frames <dir> --from <s> --to <s> --fps 4',
            'text_change_candidates are places to look. A shot without candidates can still have changing text.',
            'Write what is visible. Never write spoken lines: the script comes from the transcript only.',
            'You cannot hear the audio. Leave voice_present and music_present as "unconfirmed" unless a transcript or the user (who listened) supports the answer.',
            'If a shot contains a cut the detector missed, answer split_at for that shot instead of forcing one type.',
        ],
        enums: { type: SHOT_TYPES, text_role: TEXT_ROLES, layer_kind: LAYER_KINDS, supply: SUPPLY, audio_evidence_source: AUDIO_SOURCES },
        measured: {
            duration: b.video.duration,
            pacing: b.pacing,
            audio: { present: b.audio.present, rhythm: b.audio.rhythm ? { bpm: b.audio.rhythm.bpm } : null, rhythm_reason: b.audio.rhythm_reason, speech_band_ratio: b.audio.speech_band_ratio, attribution: b.source.audio_attribution },
            speech: b.speech,
            caption: b.source.caption,
        },
        storyboard: b.storyboard,
        shots: b.shots.map((s) => ({
            id: s.id,
            start: s.start,
            end: s.end,
            duration: s.duration,
            images: { first: s.images.first, last: s.images.last, sheet: s.images.sheet, strip: s.images.strip },
            strip_fps: s.images.strip_fps,
            strip_times: s.images.strip_times,
            motion: s.motion,
            text_change_candidates: s.text_change_candidates,
            transcript: segs?.get(s.id) ?? null,
        })),
    };
}

export function answersTemplate(b: Breakdown) {
    return {
        schema: 'ig.review_answers.v1',
        analysis_id: b.analysis_id,
        hook: '',
        structure: [{ label: 'hook', start: 0, end: 0, note: '' }],
        cast: [] as unknown[],
        visual_style: '',
        audio_notes: { voice_present: 'unconfirmed', music_present: 'unconfirmed', evidence: {}, description: '', mix: '' },
        sound_cues: [] as unknown[],
        assets: [] as unknown[],
        shots: b.shots.map((s) => ({ id: s.id, type: '', confidence: 0, evidence: [] as string[], description: '', camera: '', transition_in: '', on_screen_text: [] as unknown[], layers: [] as unknown[] })),
    };
}

// ---------- validation ----------

export interface ApplyResult {
    ok: boolean;
    errors: string[];
    warnings: string[];
    downgrades: string[];
    /** Missed cuts the reviewer reported; when present nothing is applied. */
    splits: number[];
    breakdown?: Breakdown;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export function applyReview(b: Breakdown, answers: any, transcript: Transcript | null): ApplyResult {
    const errors: string[] = [];
    const warnings: string[] = [];
    const downgrades: string[] = [];
    const splits: number[] = [];
    const eps = 0.051;
    if (!answers || typeof answers !== 'object') return { ok: false, errors: ['The answers file is not a JSON object.'], warnings, downgrades, splits };
    if (answers.analysis_id !== b.analysis_id) {
        return { ok: false, errors: [`These answers were written for another analysis (answers ${JSON.stringify(answers.analysis_id ?? null)}, breakdown "${b.analysis_id}"). The shots may have changed: run review again and answer from the new review_tasks.json.`], warnings, downgrades, splits };
    }

    if ('script' in answers || (Array.isArray(answers.shots) && answers.shots.some((s: any) => s && ('spoken' in s || 'dialogue' in s || 'script' in s)))) {
        errors.push(transcript ? 'Remove script/spoken lines from the answers: the script is built from transcript.json.' : 'Spoken lines were supplied but there is no transcript. Run `transcribe` first; the script is never written from frames.');
    }

    const byId = new Map(b.shots.map((s) => [s.id, s]));
    const seen = new Set<number>();
    const reviews = new Map<number, ShotReview>();
    const list: any[] = Array.isArray(answers.shots) ? answers.shots : [];
    if (!Array.isArray(answers.shots)) errors.push('"shots" must be an array.');

    const assets: TopReview['assets'] = [];
    const assetIds = new Set<string>();
    for (const [i, a] of (Array.isArray(answers.assets) ? answers.assets : []).entries()) {
        const at = `assets[${i}]`;
        if (!isStr(a?.id)) errors.push(`${at}.id is required.`);
        else if (assetIds.has(a.id)) errors.push(`${at}.id "${a.id}" is duplicated.`);
        else assetIds.add(a.id);
        if (!isStr(a?.description)) errors.push(`${at}.description is required.`);
        if (!SUPPLY.includes(a?.supply)) errors.push(`${at}.supply must be one of ${SUPPLY.join(', ')}.`);
        const used = Array.isArray(a?.used_in) ? a.used_in : [];
        for (const u of used) if (!byId.has(u)) errors.push(`${at}.used_in references unknown shot ${u}.`);
        assets.push({ id: String(a?.id ?? ''), kind: String(a?.kind ?? 'other'), description: String(a?.description ?? ''), used_in: used, supply: a?.supply });
    }

    for (const [i, a] of list.entries()) {
        const at = `shots[${i}]`;
        const shot = byId.get(a?.id);
        if (!shot) {
            errors.push(`${at}.id ${JSON.stringify(a?.id)} is not a shot of this breakdown.`);
            continue;
        }
        if (seen.has(shot.id)) {
            errors.push(`${at}: shot ${shot.id} is answered twice.`);
            continue;
        }
        seen.add(shot.id);
        const tag = `shot ${shot.id}`;

        if (Array.isArray(a.split_at) && a.split_at.length) {
            for (const t of a.split_at) {
                if (!isNum(t) || t <= shot.start + eps || t >= shot.end - eps) errors.push(`${tag}: split_at ${t} must lie strictly inside ${shot.start}-${shot.end}.`);
                else splits.push(t);
            }
            continue;
        }

        if (!SHOT_TYPES.includes(a.type)) errors.push(`${tag}: type ${JSON.stringify(a.type)} is not one of ${SHOT_TYPES.join(', ')}.`);
        if (!isNum(a.confidence) || a.confidence < 0 || a.confidence > 1) errors.push(`${tag}: confidence must be a number from 0 to 1.`);
        const evidence = Array.isArray(a.evidence) ? a.evidence.filter(isStr) : [];
        if (!evidence.length) errors.push(`${tag}: evidence needs at least one observation from the frames.`);
        if (!isStr(a.description)) errors.push(`${tag}: description is required.`);

        if (shot.motion.low_motion === true && MOVING_TYPES.includes(a.type)) {
            const m = shot.motion;
            if (!isStr(a.motion_note)) {
                errors.push(`${tag}: measured as low motion (static_ratio ${m.static_ratio}, first_last_mad ${m.first_last_mad}, max_block_mad ${m.max_block_mad}) but typed "${a.type}". Look at the strip; if something does move, keep the type and say what moves in motion_note.`);
            } else {
                warnings.push(`${tag}: typed "${a.type}" although measured as low motion; kept with motion_note.`);
            }
        }

        const inShot = (s: unknown, e: unknown) => isNum(s) && isNum(e) && s >= shot.start - eps && e <= shot.end + eps && e >= s;
        const texts: TextItem[] = [];
        for (const [k, t] of (Array.isArray(a.on_screen_text) ? a.on_screen_text : []).entries()) {
            const where = `${tag}: on_screen_text[${k}]`;
            if (!isStr(t?.text)) errors.push(`${where}.text is required.`);
            if (!TEXT_ROLES.includes(t?.role)) errors.push(`${where}.role must be one of ${TEXT_ROLES.join(', ')}.`);
            if (!inShot(t?.start, t?.end)) errors.push(`${where}: start/end must lie inside the shot (${shot.start}-${shot.end}).`);
            texts.push({ text: String(t?.text ?? ''), role: t?.role, position: String(t?.position ?? ''), start: t?.start, end: t?.end, ...(isStr(t?.style) ? { style: t.style } : {}) });
        }
        const layers: Layer[] = [];
        for (const [k, l] of (Array.isArray(a.layers) ? a.layers : []).entries()) {
            const where = `${tag}: layers[${k}]`;
            if (!LAYER_KINDS.includes(l?.kind)) errors.push(`${where}.kind must be one of ${LAYER_KINDS.join(', ')}.`);
            if (!isStr(l?.description)) errors.push(`${where}.description is required.`);
            if (!inShot(l?.start, l?.end)) errors.push(`${where}: start/end must lie inside the shot (${shot.start}-${shot.end}).`);
            if (l?.asset !== undefined && !assetIds.has(l.asset)) errors.push(`${where}.asset "${l.asset}" is not declared in assets[].`);
            layers.push({ kind: l?.kind, description: String(l?.description ?? ''), position: String(l?.position ?? ''), start: l?.start, end: l?.end, ...(isStr(l?.action) ? { action: l.action } : {}), ...(l?.asset !== undefined ? { asset: l.asset } : {}) });
        }
        if (shot.text_change_candidates.length > texts.length) {
            warnings.push(`${tag}: ${shot.text_change_candidates.length} text-change candidate(s) at ${shot.text_change_candidates.map((c) => `${c.t}s/${c.band}`).join(', ')} but ${texts.length} text item(s). Check with: frames <dir> --from ${shot.start} --to ${shot.end} --fps 4`);
        }
        reviews.set(shot.id, {
            type: a.type, confidence: a.confidence, evidence, description: String(a.description ?? ''),
            ...(isStr(a.camera) ? { camera: a.camera } : {}), ...(isStr(a.transition_in) ? { transition_in: a.transition_in } : {}), ...(isStr(a.motion_note) ? { motion_note: a.motion_note } : {}),
            on_screen_text: texts, layers,
        });
    }
    for (const s of b.shots) if (!seen.has(s.id)) errors.push(`shot ${s.id} has no answer.`);

    if (!isStr(answers.hook)) errors.push('hook is required: what the first seconds show and promise.');
    if (!isStr(answers.visual_style)) errors.push('visual_style is required.');
    const structure: TopReview['structure'] = [];
    for (const [i, s] of (Array.isArray(answers.structure) ? answers.structure : []).entries()) {
        if (!isStr(s?.label) || !isNum(s?.start) || !isNum(s?.end) || s.start < -eps || s.end > b.video.duration + eps || s.end < s.start) errors.push(`structure[${i}] needs a label and start/end within 0-${b.video.duration}.`);
        structure.push({ label: String(s?.label ?? ''), start: s?.start, end: s?.end, ...(isStr(s?.note) ? { note: s.note } : {}) });
    }
    if (!structure.length) errors.push('structure needs at least one section.');
    const cast: TopReview['cast'] = [];
    for (const [i, c] of (Array.isArray(answers.cast) ? answers.cast : []).entries()) {
        if (!isStr(c?.id) || !isStr(c?.description)) errors.push(`cast[${i}] needs id and description.`);
        const ap = Array.isArray(c?.appears_in) ? c.appears_in : [];
        for (const u of ap) if (!byId.has(u)) errors.push(`cast[${i}].appears_in references unknown shot ${u}.`);
        cast.push({ id: String(c?.id ?? ''), description: String(c?.description ?? ''), appears_in: ap });
    }

    // Audio: only an observation can confirm voice or music, in either direction.
    const an = answers.audio_notes ?? {};
    const ev = an.evidence ?? {};
    const hasTranscriptSpeech = Boolean(transcript && withinVideo(transcript.segments, b.video.duration).length);
    const noStream = !b.audio.present;
    const decide = (what: 'voice' | 'music', value: unknown): Tri => {
        if (value !== true && value !== false) return 'unconfirmed';
        const src = ev?.[what]?.source;
        const fail = (why: string): Tri => {
            downgrades.push(`${what}_present: ${JSON.stringify(value)} -> "unconfirmed" (${why})`);
            return 'unconfirmed';
        };
        if (!AUDIO_SOURCES.includes(src)) return fail(`audio_notes.evidence.${what}.source must be one of ${AUDIO_SOURCES.join(', ')}; tempo, loudness and Instagram's audio attribution are not evidence`);
        if (src === 'no_audio_stream') {
            if (!noStream) return fail('the file has an audio stream');
            return value === false ? false : fail('a file without an audio stream cannot have it');
        }
        if (src === 'user_listened') return isStr(ev[what].note) ? value : fail('user_listened needs a note with what the user said they heard');
        // transcript
        if (what === 'music') return fail('a transcript says nothing about music; ask the user to listen');
        if (value === true) return hasTranscriptSpeech ? true : fail('the transcript has no speech segments');
        return fail('an empty or missing transcript does not prove nobody speaks; ask the user to listen');
    };
    const voice = decide('voice', an.voice_present);
    const music = decide('music', an.music_present);
    const cues: TopReview['sound_cues'] = [];
    for (const [i, c] of (Array.isArray(answers.sound_cues) ? answers.sound_cues : []).entries()) {
        if (!isNum(c?.t) || c.t < 0 || c.t > b.video.duration + eps || !isStr(c?.description)) {
            errors.push(`sound_cues[${i}] needs t within the video and a description.`);
            continue;
        }
        let source: 'user_listened' | 'unconfirmed' = c.source === 'user_listened' ? 'user_listened' : 'unconfirmed';
        if (c.source !== undefined && c.source !== 'user_listened' && c.source !== 'unconfirmed') {
            downgrades.push(`sound_cues[${i}].source ${JSON.stringify(c.source)} -> "unconfirmed"`);
            source = 'unconfirmed';
        }
        cues.push({ t: c.t, description: c.description, ...(isStr(c.visual_event) ? { visual_event: c.visual_event } : {}), source });
    }

    if (errors.length) return { ok: false, errors, warnings, downgrades, splits };
    if (splits.length) return { ok: false, errors: [], warnings, downgrades, splits: splits.sort((x, y) => x - y) };

    const { script, speech } = buildScript(b.shots, transcript);
    const top: TopReview = {
        hook: answers.hook, structure, cast, visual_style: answers.visual_style,
        audio_notes: {
            voice_present: voice, music_present: music,
            evidence: { ...(voice !== 'unconfirmed' ? { voice: ev.voice } : {}), ...(music !== 'unconfirmed' ? { music: ev.music } : {}) },
            ...(isStr(an.description) ? { description: an.description } : {}), ...(isStr(an.mix) ? { mix: an.mix } : {}),
        },
        sound_cues: cues, assets, applied_at: new Date().toISOString(), notes: [...warnings, ...downgrades],
    };
    const merged: Breakdown = { ...b, shots: b.shots.map((s) => ({ ...s, review: reviews.get(s.id)! })), review: top, script, speech };
    return { ok: true, errors, warnings, downgrades, splits, breakdown: merged };
}

// ---------- deliverables ----------

export interface Tools {
    ffmpeg: string | null;
    comfy: string | null;
}

interface Route {
    name: string;
    needs: string;
    how: (shot: Shot, r: ShotReview) => string;
}

const frames = (s: Shot) => `first frame \`${s.images.first}\`, last frame \`${s.images.last}\``;

export const ROUTES: Record<ShotType, Route> = {
    filmed: { name: 'Film it', needs: 'a camera or phone', how: (s, r) => `Shoot ${s.duration}s. Match framing and light from ${frames(s)}.${r.camera ? ` Camera: ${r.camera}.` : ''}` },
    film_clip: { name: 'Own or licensed footage', needs: 'footage you have the rights to', how: (s) => `Find ${s.duration}s of comparable footage you own or licence; the original clip is reference only.` },
    ai_video: { name: 'Generate (image-to-video)', needs: 'ComfyUI with the `comfy` CLI, or another video generator', how: (s, r) => `Make your own start image in the style of \`${s.images.first}\` (reference only, do not reuse it), then image-to-video for ${s.duration}s. Motion prompt draft: "${r.camera ?? 'subtle camera move'}; ${r.description}".` },
    avatar: { name: 'Talking head', needs: 'a camera, or an avatar generator plus your own voice track', how: (s) => `Record yourself for ${s.duration}s, or drive an avatar from the exact audio that will play under the shot.` },
    render_3d: { name: '3D render', needs: 'Blender or another 3D tool', how: (s, r) => `Render ${s.duration}s. ${r.camera ? `Camera: ${r.camera}. ` : ''}Use ${frames(s)} for composition.` },
    animation_2d: { name: '2D animation', needs: 'an animation tool or a code renderer', how: (s) => `Animate ${s.duration}s; ${frames(s)} are the key poses.` },
    code_render: { name: 'Code/template render', needs: 'a canvas/HTML renderer or a motion-graphics template', how: (s) => `Rebuild as a template: the texts, positions and timings are in the text table for this shot (${s.duration}s).` },
    screen_recording: { name: 'Screen recording', needs: 'a screen recorder and the app or site shown', how: (s) => `Record your own screen for ${s.duration}s doing the equivalent action.` },
    still_pan_zoom: { name: 'Still with pan/zoom', needs: 'one image and ffmpeg', how: (s) => `Use your own image and animate it for ${s.duration}s, for example: ffmpeg -loop 1 -i image.jpg -vf "zoompan=z='min(zoom+0.0015,1.2)':d=${Math.max(1, Math.round(s.duration * 30))}:s=1080x1920" -t ${s.duration} out.mp4` },
    static_hold: { name: 'Static card', needs: 'one image and ffmpeg', how: (s) => `Hold one image for ${s.duration}s: ffmpeg -loop 1 -i card.png -t ${s.duration} -pix_fmt yuv420p out.mp4` },
};

const tri = (v: Tri) => (v === true ? 'yes' : v === false ? 'no' : 'unconfirmed');
const t1 = (n: number) => n.toFixed(2);

export function summaryText(b: Breakdown): string {
    const L: string[] = [];
    const src = b.source;
    L.push(`${src.origin === 'instagram' ? `@${src.owner ?? '?'} ${src.url ?? src.ref ?? ''}` : `local file ${src.ref}`}`.trim());
    L.push(`${t1(b.video.duration)}s, ${b.video.width}x${b.video.height}, ${Math.round(b.video.fps * 100) / 100} fps, ${b.pacing.shots} shots, median shot ${b.pacing.median_shot_sec}s, ${b.pacing.cuts_per_10s} cuts per 10s`);
    const a = b.audio;
    if (!a.present) L.push('Audio: no audio stream.');
    else {
        const rhythm = a.rhythm ? `${a.rhythm.bpm} BPM (strength ${a.rhythm.beat_strength}, ${a.cuts_on_beat_ratio === null ? 'no cuts to compare' : `${Math.round(a.cuts_on_beat_ratio * 100)}% of cuts on a beat`})` : `no reliable tempo (${a.rhythm_reason})`;
        L.push(`Audio (measured): ${a.integrated_lufs ?? '?'} LUFS, silence ${a.silence_ratio === null ? '?' : Math.round(a.silence_ratio * 100)}%, ${rhythm}`);
    }
    if (src.audio_attribution) L.push(`Instagram credits: ${src.audio_attribution.kind === 'licensed_music' ? 'music' : 'original audio'} "${src.audio_attribution.title ?? '?'}" by ${src.audio_attribution.artist ?? '?'} (an attribution, not proof of what is audible)`);
    const r = b.review;
    if (!r) {
        L.push('', 'Not reviewed yet: run `review`, fill review_answers.json from the frames, then `apply-review`.');
        return L.join('\n');
    }
    L.push(`Voice: ${tri(r.audio_notes.voice_present)}. Music: ${tri(r.audio_notes.music_present)}.`);
    L.push('', `HOOK: ${r.hook}`, `STYLE: ${r.visual_style}`, '', 'STRUCTURE');
    for (const s of r.structure) L.push(`  ${t1(s.start)}-${t1(s.end)}  ${s.label}${s.note ? `: ${s.note}` : ''}`);
    L.push('', 'SHOTS');
    for (const s of b.shots) {
        const v = s.review!;
        L.push(`  ${String(s.id).padStart(2)}  ${t1(s.start)}-${t1(s.end)}  ${v.type} (${v.confidence})  ${v.description}`);
        for (const x of v.on_screen_text) L.push(`        text ${t1(x.start)}-${t1(x.end)} [${x.role}${x.position ? `, ${x.position}` : ''}] "${x.text}"`);
        for (const l of v.layers) L.push(`        layer ${t1(l.start)}-${t1(l.end)} [${l.kind}] ${l.description}`);
    }
    L.push('', 'SCRIPT');
    if (b.script === null) L.push('  unconfirmed: no transcript. Run `transcribe` (see references/transcription.md).');
    else if (!b.script.length) L.push('  no speech was transcribed (this does not prove the video has no voice).');
    else for (const l of b.script) L.push(`  ${t1(l.start)}-${t1(l.end)} [shot ${l.shot}]${l.speaker ? ` ${l.speaker}:` : ''} ${l.text}`);
    if (r.sound_cues.length) {
        L.push('', 'SOUND CUES');
        for (const c of r.sound_cues) L.push(`  ${t1(c.t)}  ${c.description}${c.visual_event ? ` (with: ${c.visual_event})` : ''} [${c.source}]`);
    }
    if (r.notes?.length) L.push('', 'NOTES', ...r.notes.map((n) => `  - ${n}`));
    return L.join('\n');
}

export function recreateMarkdown(b: Breakdown, tools: Tools): string {
    const r = b.review;
    if (!r) throw new Error('The breakdown has not been reviewed. Run review and apply-review first.');
    const L: string[] = [];
    L.push('# Recreate plan', '', 'A plan for an original video in the same format. The source video, its frames and its audio are reference only: do not reuse or re-upload them.', '');
    L.push('## Format', '', `- Length ${t1(b.video.duration)}s, ${b.video.width}x${b.video.height}, ${b.pacing.shots} shots, median ${b.pacing.median_shot_sec}s.`, `- Hook: ${r.hook}`, `- Style: ${r.visual_style}`);
    if (b.audio.rhythm) L.push(`- Measured tempo ${b.audio.rhythm.bpm} BPM${b.audio.cuts_on_beat_ratio !== null ? `; ${Math.round(b.audio.cuts_on_beat_ratio * 100)}% of cuts land on a beat` : ''}.`);
    L.push(`- Voice: ${tri(r.audio_notes.voice_present)}. Music: ${tri(r.audio_notes.music_present)}.${r.audio_notes.mix ? ` Mix: ${r.audio_notes.mix}` : ''}`, '');
    L.push('## Tools found', '', `- ffmpeg: ${tools.ffmpeg ?? 'not found'}`, `- ComfyUI \`comfy\` CLI: ${tools.comfy ?? 'not found (optional; needed only for the generate routes)'}`, '');
    L.push('## Structure', '');
    for (const s of r.structure) L.push(`- ${t1(s.start)}-${t1(s.end)} **${s.label}**${s.note ? `: ${s.note}` : ''}`);
    L.push('', '## Script', '');
    if (b.script === null) L.push('Unconfirmed: there is no transcript, so the spoken lines are unknown. Write your own script to the structure above.');
    else if (!b.script.length) L.push('No speech was transcribed.');
    else for (const l of b.script) L.push(`- ${t1(l.start)}-${t1(l.end)} (shot ${l.shot}): ${l.text}`);
    L.push('', 'Write your own lines; keep the beat lengths, not the wording.', '', '## Shots', '');
    for (const s of b.shots) {
        const v = s.review!;
        const route = ROUTES[v.type];
        L.push(`### Shot ${s.id}: ${t1(s.start)}-${t1(s.end)} (${s.duration}s), ${v.type}`, '', v.description, '', `- Route: **${route.name}**. Needs: ${route.needs}.`, `- How: ${route.how(s, v)}`);
        if (v.transition_in) L.push(`- Transition in: ${v.transition_in}`);
        if (v.confidence < 0.6) L.push(`- Low confidence (${v.confidence}) in the type: check \`${s.images.strip}\` before committing to this route.`);
        for (const x of v.on_screen_text) L.push(`- Text ${t1(x.start)}-${t1(x.end)}, ${x.role}${x.position ? `, ${x.position}` : ''}${x.style ? `, ${x.style}` : ''}: "${x.text}"`);
        for (const l of v.layers) L.push(`- Layer ${t1(l.start)}-${t1(l.end)}, ${l.kind}${l.position ? `, ${l.position}` : ''}: ${l.description}${l.action ? ` (${l.action})` : ''}${l.asset ? ` [asset ${l.asset}]` : ''}`);
        L.push('');
    }
    if (r.sound_cues.length) {
        L.push('## Sound cues', '');
        for (const c of r.sound_cues) L.push(`- ${t1(c.t)}: ${c.description}${c.visual_event ? `, with ${c.visual_event}` : ''} (${c.source})`);
        L.push('');
    }
    L.push('## Assets', '');
    const group = (k: (typeof SUPPLY)[number], title: string) => {
        const items = r.assets.filter((a) => a.supply === k);
        if (!items.length) return;
        L.push(`**${title}**`, '');
        for (const a of items) L.push(`- \`${a.id}\` (${a.kind}): ${a.description}${a.used_in.length ? `. Shots ${a.used_in.join(', ')}` : ''}`);
        L.push('');
    };
    group('user_must_supply', 'You must supply');
    group('can_generate', 'Can be generated');
    group('reference_only', 'Reference only (do not reuse)');
    if (!r.assets.length) L.push('None listed.', '');
    if (r.cast.length) {
        L.push('## Cast', '');
        for (const c of r.cast) L.push(`- \`${c.id}\`: ${c.description}${c.appears_in.length ? ` (shots ${c.appears_in.join(', ')})` : ''}`);
        L.push('');
    }
    L.push('## Assembly', '', 'Cut each shot to the durations above, concatenate, add text and layers on the listed timings, then mix audio and normalise loudness (about -14 LUFS for Instagram):', '', '```', 'ffmpeg -f concat -safe 0 -i shots.txt -c:v libx264 -pix_fmt yuv420p -r 30 silent.mp4', 'ffmpeg -i silent.mp4 -i audio.wav -c:v copy -af loudnorm=I=-14:TP=-1.5:LRA=11 -c:a aac -shortest final.mp4', '```', '');
    if (r.notes?.length) L.push('## Open points', '', ...r.notes.map((n) => `- ${n}`), '');
    return L.join('\n');
}

const r2 = (n: number) => Math.round(n * 100) / 100;
export type { Segment };
