/**
 * Speech transcript: import an existing file or run the user's own recogniser. This skill ships
 * no speech model and downloads none; see references/transcription.md for recipes.
 */
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';

import { run } from './ff.ts';

export interface Segment {
    start: number;
    end: number;
    text: string;
    speaker?: string;
}

export interface Transcript {
    schema: 'ig.transcript.v1';
    source: string;
    language: string | null;
    segments: Segment[];
    words?: Array<{ start: number; end: number; text: string }>;
}

/**
 * Splits a command template into argv. Whitespace separates tokens; single or double quotes
 * group one token. No escapes, no variable expansion, no shell.
 */
export function tokenize(template: string): string[] {
    const out: string[] = [];
    let cur = '';
    let quote: string | null = null;
    let open = false;
    for (const ch of template) {
        if (quote) {
            if (ch === quote) quote = null;
            else cur += ch;
        } else if (ch === '"' || ch === "'") {
            quote = ch;
            open = true;
        } else if (/\s/.test(ch)) {
            if (cur || open) out.push(cur);
            cur = '';
            open = false;
        } else {
            cur += ch;
        }
    }
    if (quote) throw new Error(`Unclosed ${quote} in the command template.`);
    if (cur || open) out.push(cur);
    return out;
}

/** Tokenise first, then substitute placeholders inside tokens, so a path stays one argument. */
export function buildArgv(template: string, vars: Record<string, string>): string[] {
    const tokens = tokenize(template);
    if (!tokens.length) throw new Error('The command template is empty.');
    for (const name of ['audio', 'out']) {
        if (!tokens.some((t) => t.includes(`{${name}}`))) throw new Error(`The command template must contain {${name}}.`);
    }
    return tokens.map((t) => t.replace(/\{(audio|out|lang)\}/g, (_, k: string) => vars[k] ?? ''));
}

function clock(s: string): number {
    const parts = s.trim().replace(',', '.').split(':').map(Number);
    if (parts.some((p) => !Number.isFinite(p))) return NaN;
    return parts.reduce((acc, p) => acc * 60 + p, 0);
}

const clean = (t: string) => t.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

/** SRT and WebVTT cues. */
export function parseCues(text: string): Segment[] {
    const out: Segment[] = [];
    const blocks = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).replace(/\r/g, '').split(/\n{2,}/);
    for (const block of blocks) {
        const lines = block.split('\n').filter((l) => l.trim() !== '');
        const i = lines.findIndex((l) => l.includes('-->'));
        if (i < 0) continue;
        const m = lines[i].match(/([0-9:.,]+)\s*-->\s*([0-9:.,]+)/);
        if (!m) continue;
        const start = clock(m[1]);
        const end = clock(m[2]);
        let body = lines.slice(i + 1).join(' ');
        let speaker: string | undefined;
        const v = body.match(/^<v\s+([^>]+)>/);
        if (v) speaker = v[1].trim();
        body = clean(body);
        if (!Number.isFinite(start) || !Number.isFinite(end) || !body) continue;
        out.push({ start, end, text: body, ...(speaker ? { speaker } : {}) });
    }
    return out;
}

/** Accepts this skill's schema, openai-whisper `segments`, transformers `chunks`, whisper.cpp `transcription`. */
export function normalizeJson(j: any): { segments: Segment[]; language: string | null; words?: Transcript['words'] } {
    const language = typeof j?.language === 'string' ? j.language : typeof j?.result?.language === 'string' ? j.result.language : null;
    let segments: Segment[] = [];
    if (Array.isArray(j?.segments)) {
        segments = j.segments.map((s: any) => ({ start: typeof s.start === 'number' ? s.start : NaN, end: Number(s.end ?? s.start), text: clean(String(s.text ?? '')), ...(s.speaker ? { speaker: String(s.speaker) } : {}) }));
    } else if (Array.isArray(j?.chunks)) {
        // A chunk without a start time has no place on the timeline and is dropped (Number(null) would be 0).
        segments = j.chunks.map((c: any) => ({ start: typeof c.timestamp?.[0] === 'number' ? c.timestamp[0] : NaN, end: Number(c.timestamp?.[1] ?? c.timestamp?.[0]), text: clean(String(c.text ?? '')) }));
    } else if (Array.isArray(j?.transcription)) {
        segments = j.transcription.map((t: any) => ({ start: typeof t.offsets?.from === 'number' ? t.offsets.from / 1000 : NaN, end: Number(t.offsets?.to) / 1000, text: clean(String(t.text ?? '')) }));
    } else {
        throw new Error('Unrecognised transcript JSON: expected "segments", "chunks" or "transcription".');
    }
    segments = segments.filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.text);
    const words = Array.isArray(j?.words) ? j.words.map((w: any) => ({ start: Number(w.start), end: Number(w.end), text: String(w.text ?? w.word ?? '').trim() })).filter((w: any) => Number.isFinite(w.start) && w.text) : undefined;
    return { segments, language, ...(words?.length ? { words } : {}) };
}

export function parseTranscript(text: string, file: string, source: string, lang?: string | null): Transcript {
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const looksJson = /^\s*[{[]/.test(text);
    if (looksJson) {
        const n = normalizeJson(JSON.parse(text));
        return { schema: 'ig.transcript.v1', source, language: lang ?? n.language, segments: sort(n.segments), ...(n.words ? { words: n.words } : {}) };
    }
    if (!text.includes('-->')) throw new Error(`${file} is not SRT, WebVTT or a supported JSON transcript.`);
    return { schema: 'ig.transcript.v1', source, language: lang ?? null, segments: sort(parseCues(text)) };
}

const sort = (s: Segment[]) => [...s].sort((a, b) => a.start - b.start).map((x) => ({ ...x, start: r3(x.start), end: r3(Math.max(x.start, x.end)) }));
const r3 = (n: number) => Math.round(n * 1000) / 1000;

export async function importTranscript(file: string, lang?: string | null): Promise<Transcript> {
    return parseTranscript(await readFile(file, 'utf8'), file, `import:${path.basename(file)}`, lang);
}

/**
 * Runs the user's recogniser. {out} is a path without extension; the tool may write exactly
 * that path or add .json, .srt or .vtt to it.
 */
export async function runRecogniser(template: string, audio: string, outBase: string, lang?: string | null): Promise<Transcript> {
    const argv = buildArgv(template, { audio, out: outBase, lang: lang ?? '' });
    const candidates = [`${outBase}.json`, `${outBase}.srt`, `${outBase}.vtt`, outBase];
    // Output of an earlier run must not be mistaken for this one's.
    for (const c of candidates) await rm(c, { force: true });
    const r = await run(argv[0], argv.slice(1));
    if (r.code !== 0) throw new Error(`The recogniser exited with code ${r.code}:\n${r.stderr.trim().split(/\r?\n/).slice(-8).join('\n')}`);
    for (const candidate of candidates) {
        let text: string;
        try {
            text = await readFile(candidate, 'utf8');
        } catch {
            continue;
        }
        return parseTranscript(text, candidate, `cmd:${path.basename(argv[0])}`, lang);
    }
    throw new Error(`The recogniser finished but wrote none of ${outBase}[.json|.srt|.vtt].`);
}

/**
 * Segments that start inside the video, with their end clipped to its length. A segment that
 * starts later belongs to some other recording.
 */
export function withinVideo(segments: Segment[], duration: number): Segment[] {
    return segments.filter((s) => s.start >= 0 && s.start < duration).map((s) => (s.end > duration ? { ...s, end: duration } : s));
}

/**
 * Each segment goes to the shot that holds most of it. A segment that overlaps no shot (it
 * starts after the video ends) is not assigned anywhere.
 */
export function segmentsForShot(segments: Segment[], shots: Array<{ id: number; start: number; end: number }>): Map<number, Segment[]> {
    const map = new Map<number, Segment[]>(shots.map((s) => [s.id, []]));
    for (const seg of segments) {
        let best: number | null = null;
        let bestOverlap = 0;
        for (const s of shots) {
            const o = Math.min(seg.end, s.end) - Math.max(seg.start, s.start);
            if (o > bestOverlap) {
                bestOverlap = o;
                best = s.id;
            }
        }
        // Zero-length segments (a single timestamp) have no overlap: place them by their start.
        if (best === null) best = shots.find((x) => seg.start >= x.start && seg.start < x.end)?.id ?? null;
        if (best !== null) map.get(best)!.push(seg);
    }
    return map;
}
