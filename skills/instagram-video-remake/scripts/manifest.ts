/**
 * The record of one remake (ig.remake.v1), kept as remake.json in the run folder: what the source and the
 * references are, who agreed to what, every generation attempt with its settings and result, how each shot
 * was put back, and the final timeline. A later session resumes from this file alone.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Rect } from './graphs.ts';

export const SCHEMA = 'ig.remake.v1';

export interface Reference {
    id: string;
    role: 'identity' | 'scene';
    file: string;
    sha256: string;
}

export interface Attempt {
    n: number;
    at: string;
    kind: 'swap' | 'continue';
    /** Settings that produced it (seed, tier, prompt, point, mask growth...). */
    settings: Record<string, unknown>;
    graphHash: string;
    clientId: string;
    promptId?: string;
    status: 'submitted' | 'done' | 'failed' | 'unknown';
    error?: string;
    seconds?: number;
    /** The generated clip as downloaded (forward order, guide frames removed), relative to the run folder. */
    output?: string;
    outputSha256?: string;
    frames?: number;
}

export interface Shot {
    id: string;
    kind: 'swap' | 'continue';
    /** Stretch of the source this shot replaces (swap), in seconds. */
    start?: number;
    duration?: number;
    /** Area of the source frame sent to the model (the whole frame when absent). */
    crop?: Rect;
    reversed?: boolean;
    /** For a continuation: the shot it continues. */
    after?: string;
    attempts: Attempt[];
    /** Attempt chosen for the timeline. */
    selected?: number;
    /** The selected attempt fitted to the source frame (file relative to the run folder) and how. */
    placed?: { file: string; sha256: string; area?: Rect; feather?: number; fromAttempt: number };
    /** A person looked at the placed shot in motion and accepted it. Bound to that exact file. */
    approved?: { at: string; sha256: string; note?: string };
}

export interface Manifest {
    schema: typeof SCHEMA;
    createdAt: string;
    source: { file: string; sha256: string; width: number; height: number; fps: number; duration: number; hasAudio: boolean };
    /** The user's own statement that the people shown agreed and that they may use the source. Required. */
    consent: { statement: string; at: string };
    references: Reference[];
    /** Free-text card repeated in every prompt: face, hair, build, wardrobe. */
    character?: string;
    shots: Shot[];
    timeline?: { segments: Array<{ source: [number, number] } | { shot: string }>; file: string; sha256: string; duration: number; draft?: boolean };
    audio?: { mode: 'source' | 'file'; file?: string; sha256?: string; start: number; match?: Record<string, unknown>; measuredStart?: number | null; rights: string };
    final?: { file: string; sha256: string; duration: number; at: string; draft?: boolean };
}

export async function sha256File(file: string): Promise<string> {
    return createHash('sha256').update(await readFile(file)).digest('hex');
}

export function manifestPath(run: string): string {
    return path.join(run, 'remake.json');
}

export async function load(run: string): Promise<Manifest> {
    let text: string;
    try {
        text = await readFile(manifestPath(run), 'utf8');
    } catch {
        throw new Error(`${run} is not a remake folder (no remake.json). Create one with: init <folder> --source <video> --identity <photo> --consent "<statement>"`);
    }
    const m = JSON.parse(text) as Manifest;
    if (m.schema !== SCHEMA) throw new Error(`remake.json has schema "${m.schema}"; this version reads ${SCHEMA}.`);
    return m;
}

/** Written to a temporary file and renamed, so a crash never leaves half a manifest. */
export async function save(run: string, m: Manifest): Promise<void> {
    const tmp = `${manifestPath(run)}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(m, null, 2)}\n`);
    await rename(tmp, manifestPath(run));
}

/**
 * One command at a time per run folder. A command reads the manifest, may work for minutes, and writes it back;
 * two at once would erase each other's records. Returns the function that releases the lock.
 *
 * `remake.lock` names the owner (pid). It is only ever created, inspected or removed inside a short critical
 * section guarded by `remake.lock.guard`, a directory made with mkdir (atomic: exactly one caller succeeds).
 * So deciding "the owner has exited" and replacing its lock cannot interleave with another command taking the
 * lock, and a live lock is never moved or removed by anyone but its owner.
 * A guard left by a process that died inside those few milliseconds is NOT removed automatically: the error says
 * which folder to delete.
 */
export async function lockRun(run: string): Promise<() => Promise<void>> {
    const file = path.join(run, 'remake.lock');
    const guard = `${file}.guard`;
    const alive = (pid: number) => {
        try {
            process.kill(pid, 0);
            return true;
        } catch (e) {
            return (e as NodeJS.ErrnoException).code === 'EPERM';
        }
    };
    const guarded = async <T>(fn: () => Promise<T>): Promise<T> => {
        const started = Date.now();
        for (;;) {
            try {
                await mkdir(guard);
                break;
            } catch (e) {
                if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
                if (Date.now() - started > 10_000) throw new Error(`The run folder is busy (${guard} has existed for over 10 s). If no command is running, delete that folder and try again.`);
                await new Promise((r) => setTimeout(r, 20 + Math.floor(Math.random() * 30)));
            }
        }
        try {
            return await fn();
        } finally {
            await rm(guard, { recursive: true, force: true });
        }
    };
    const owner = async (): Promise<{ pid: number; at: string } | null | 'unreadable'> => {
        let text: string;
        try {
            text = await readFile(file, 'utf8');
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
            throw e;
        }
        try {
            const j = JSON.parse(text);
            return typeof j?.pid === 'number' ? j : 'unreadable';
        } catch {
            return 'unreadable';
        }
    };
    await guarded(async () => {
        const cur = await owner();
        if (cur === 'unreadable') throw new Error(`The lock file ${file} cannot be read. If no command is running, delete it and try again.`);
        if (cur && alive(cur.pid)) throw new Error(`Another command is working on this remake (process ${cur.pid}, since ${cur.at}). Wait for it to finish; generation takes minutes.`);
        // Absent, or left by a command that exited: replace it, still inside the critical section.
        await writeFile(file, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    });
    return () =>
        guarded(async () => {
            const cur = await owner();
            if (cur && cur !== 'unreadable' && cur.pid === process.pid) await rm(file, { force: true });
        });
}

/** Every shot that continues `shotId`, directly or through other continuations. */
export function descendants(m: Manifest, shotId: string): Shot[] {
    const out: Shot[] = [];
    const walk = (id: string) => {
        for (const c of m.shots) {
            if (c.kind === 'continue' && c.after === id && !out.includes(c)) {
                out.push(c);
                walk(c.id);
            }
        }
    };
    walk(shotId);
    return out;
}

/**
 * Everything built on a shot stops being valid when the shot changes: its placed file and approval, every shot
 * that continues it (at any depth), the timeline and the final file.
 */
export function invalidate(m: Manifest, shotId: string, what: 'attempt' | 'placement'): void {
    const s = m.shots.find((x) => x.id === shotId);
    if (s) {
        if (what === 'attempt') {
            delete s.placed;
            delete s.selected;
        }
        delete s.approved;
    }
    if (what === 'attempt') {
        for (const c of descendants(m, shotId)) {
            delete c.placed;
            delete c.approved;
        }
    }
    delete m.timeline;
    delete m.final;
}

/** Why a continuation no longer matches the shot it continues, or null when it does. */
export function staleContinuation(m: Manifest, s: Shot, seen: string[] = []): string | null {
    if (s.kind !== 'continue' || !s.after) return null;
    if (seen.includes(s.id)) return 'its chain of continuations loops';
    const prev = m.shots.find((x) => x.id === s.after);
    if (!prev) return `the shot it continues ("${s.after}") no longer exists`;
    const a = chosen(s);
    let prevAttempt: Attempt;
    try {
        prevAttempt = chosen(prev);
    } catch {
        return `shot "${prev.id}" has no finished attempt any more`;
    }
    if (a.settings.afterSha256 !== prevAttempt.outputSha256) return `it continues an earlier version of shot "${prev.id}" (attempt ${String(a.settings.afterAttempt)}), not the one now selected (attempt ${prevAttempt.n})`;
    // The shot it continues may itself be built on something that changed.
    const up = staleContinuation(m, prev, [...seen, s.id]);
    return up ? `shot "${prev.id}", which it continues, is out of date (${up})` : null;
}

export function shot(m: Manifest, id: string): Shot {
    const s = m.shots.find((x) => x.id === id);
    if (!s) throw new Error(`No shot "${id}" in this remake. Shots: ${m.shots.map((x) => x.id).join(', ') || 'none yet'}.`);
    return s;
}

export function reference(m: Manifest, role: Reference['role'], id?: string): Reference {
    const r = m.references.find((x) => x.role === role && (!id || x.id === id));
    if (!r) throw new Error(`No ${role} reference${id ? ` "${id}"` : ''} in this remake.`);
    return r;
}

export function chosen(s: Shot): Attempt {
    const done = s.attempts.filter((a) => a.status === 'done' && a.output);
    const a = s.selected !== undefined ? done.find((x) => x.n === s.selected) : done[done.length - 1];
    if (!a) throw new Error(`Shot "${s.id}" has no finished attempt${s.selected !== undefined ? ` number ${s.selected}` : ''}.`);
    return a;
}

/** A shot id is used in file names. */
export function checkId(id: string): string {
    if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(id)) throw new Error(`"${id}" is not a usable shot id: lowercase letters, digits, "-" and "_", up to 32 characters.`);
    return id;
}

/**
 * Places where the timeline skips or repeats source time: between two neighbouring segments that both come from
 * the source (a kept stretch or a swapped shot), the second should start where the first ends. A gap or an
 * overlap of more than half a frame shifts everything after it against the sound.
 */
export function timelineGaps(segments: Array<{ source: [number, number] } | { shot: string }>, shots: Shot[], fps: number): string[] {
    const span = (seg: { source: [number, number] } | { shot: string }): [number, number] | null => {
        if ('source' in seg) return seg.source;
        const s = shots.find((x) => x.id === seg.shot);
        return s && s.kind === 'swap' && s.start !== undefined && s.duration !== undefined ? [s.start, s.start + s.duration] : null;
    };
    const name = (seg: { source: [number, number] } | { shot: string }) => ('source' in seg ? `source:${seg.source[0]}-${seg.source[1]}` : `shot:${seg.shot}`);
    const out: string[] = [];
    for (let i = 1; i < segments.length; i++) {
        const a = span(segments[i - 1]);
        const b = span(segments[i]);
        if (!a || !b) continue;
        const d = b[0] - a[1];
        if (Math.abs(d) > 0.5 / fps) out.push(`${name(segments[i - 1])} ends at ${a[1].toFixed(3)} s and ${name(segments[i])} starts at ${b[0].toFixed(3)} s: ${Math.abs(d).toFixed(3)} s of the source is ${d > 0 ? 'skipped' : 'repeated'}`);
    }
    return out;
}

/** Parses "source:0-7.5,shot:far,source:10.2-13,shot:close,shot:more". */
export function parseSegments(spec: string): Array<{ source: [number, number] } | { shot: string }> {
    const out: Array<{ source: [number, number] } | { shot: string }> = [];
    for (const part of spec.split(',').map((p) => p.trim()).filter(Boolean)) {
        const m = /^source:(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)$/.exec(part);
        if (m) {
            const a = Number(m[1]);
            const b = Number(m[2]);
            if (!(b > a)) throw new Error(`"${part}": the end must be after the start.`);
            out.push({ source: [a, b] });
            continue;
        }
        const s = /^shot:([a-z0-9][a-z0-9_-]*)$/.exec(part);
        if (!s) throw new Error(`"${part}" is not a segment. Use source:<start>-<end> (seconds) or shot:<id>.`);
        out.push({ shot: s[1] });
    }
    if (!out.length) throw new Error('The timeline has no segments.');
    return out;
}
