import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { resolveDataDir } from './paths.ts';

/**
 * Write-ahead record for publishes. A record is written before the final
 * "configure" call and removed only when Instagram gives a definitive answer.
 * If the answer is lost (network drop, 5xx, HTML), the record stays `unresolved`
 * and every later publish is refused until the user resolves it, because
 * retrying an operation that may already have succeeded creates a duplicate post.
 * Nothing here ever retries automatically.
 */

export interface PendingOp {
    id: string;
    kind: string;
    caption: string;
    uploadIds: string[];
    startedAt: string;
    state: 'configuring' | 'unresolved';
    error?: string;
}

function dir(): string {
    return path.join(resolveDataDir(), 'pending');
}

export async function beginPending(op: Omit<PendingOp, 'state' | 'startedAt'>): Promise<PendingOp> {
    await mkdir(dir(), { recursive: true });
    const rec: PendingOp = { ...op, state: 'configuring', startedAt: new Date().toISOString() };
    await writeFile(path.join(dir(), `${op.id}.json`), `${JSON.stringify(rec, null, 2)}\n`);
    return rec;
}

export async function markUnresolved(op: PendingOp, error: string): Promise<void> {
    await writeFile(path.join(dir(), `${op.id}.json`), `${JSON.stringify({ ...op, state: 'unresolved', error }, null, 2)}\n`);
}

export async function clearPending(id: string): Promise<boolean> {
    const p = path.join(dir(), `${id}.json`);
    try {
        await readFile(p);
    } catch {
        return false;
    }
    await rm(p, { force: true });
    return true;
}

function alive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (e) {
        return (e as NodeJS.ErrnoException).code === 'EPERM';
    }
}

interface Claim {
    file: string;
    pid?: number;
    startedAt?: string;
}

async function readClaims(): Promise<Claim[]> {
    const names = (await readdir(dir())).filter((n) => n.startsWith('publish-') && n.endsWith('.lock'));
    const out: Claim[] = [];
    for (const n of names) {
        let c: Partial<Claim> = {};
        try {
            c = JSON.parse(await readFile(path.join(dir(), n), 'utf8'));
        } catch {
            // being written, or unreadable: counts as a live claim
        }
        out.push({ file: n, pid: c.pid, startedAt: c.startedAt });
    }
    return out;
}

/** A claim blocks unless its owner is known to have exited. */
function blocks(c: Claim): boolean {
    return typeof c.pid !== 'number' || alive(c.pid);
}

/**
 * Exclusive publish lock, so two runs cannot both pass the empty-ledger check.
 * Every run creates its own uniquely named claim file, then looks for other
 * claims. If any other claim may be live, it withdraws its own claim and stops.
 * Two runs that start together may both stop (safe); they can never both go on.
 * No step ever deletes a claim that might be live: claims of exited processes are
 * ignored, and `pending unlock` only deletes those. A crash after configure is
 * still caught by the pending record, which is written before configure.
 */
export async function acquirePublishLock(): Promise<() => Promise<void>> {
    await mkdir(dir(), { recursive: true });
    const name = `publish-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.lock`;
    const mine = path.join(dir(), name);
    await writeFile(mine, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), { flag: 'wx' });
    const release = async () => {
        await rm(mine, { force: true });
    };
    let others: Claim[];
    try {
        others = (await readClaims()).filter((c) => c.file !== name && blocks(c));
    } catch (e) {
        await release();
        throw e;
    }
    if (others.length) {
        await release();
        const o = others[0];
        throw new Error(`Another publish is in progress (pid ${o.pid ?? '?'}, since ${o.startedAt ?? '?'}). Wait for it to finish, then try again.`);
    }
    return release;
}

/** Deletes claim files whose owner process has exited. Never touches a live claim. */
export async function unlockStale(): Promise<{ removed: string[]; live: number }> {
    let claims: Claim[] = [];
    try {
        claims = await readClaims();
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { removed: [], live: 0 };
        throw e;
    }
    const removed: string[] = [];
    for (const c of claims) {
        if (blocks(c)) continue;
        await rm(path.join(dir(), c.file), { force: true });
        removed.push(c.file);
    }
    return { removed, live: claims.length - removed.length };
}

export async function listPending(): Promise<PendingOp[]> {
    let names: string[] = [];
    try {
        names = await readdir(dir());
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
        // Unknown recovery state must block publishing, never look empty.
        throw new Error(`Cannot read the pending-publish ledger at ${dir()}: ${(e as Error).message}`);
    }
    const out: PendingOp[] = [];
    for (const n of names.filter((x) => x.endsWith('.json'))) {
        try {
            out.push(JSON.parse(await readFile(path.join(dir(), n), 'utf8')) as PendingOp);
        } catch {
            // A corrupt record still blocks: it may describe a publish that went live.
            out.push({ id: n.replace(/\.json$/, ''), kind: 'unknown', caption: '', uploadIds: [], startedAt: '', state: 'unresolved', error: 'corrupt pending record' });
        }
    }
    // A "configuring" record left behind means the process died mid-publish: treat as unresolved.
    return out.map((o) => ({ ...o, state: 'unresolved' as const })).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}
