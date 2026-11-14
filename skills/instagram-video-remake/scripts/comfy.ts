/**
 * A small client for a local ComfyUI server (its ordinary HTTP API): upload inputs, submit a graph, wait for
 * it, download the result. Only loopback addresses are accepted unless the caller opts in: the files sent are
 * a person's likeness and unpublished video.
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Graph } from './graphs.ts';

export class ComfyError extends Error {
    constructor(
        message: string,
        readonly kind: 'unreachable' | 'rejected' | 'failed' | 'timeout' | 'unknown_submit' | 'no_output' | 'config',
        readonly detail?: unknown,
    ) {
        super(message);
    }
}

export const DEFAULT_COMFY_URL = 'http://127.0.0.1:8188';

export function checkComfyUrl(url: string, allowRemote: boolean): URL {
    let u: URL;
    try {
        u = new URL(url);
    } catch {
        throw new ComfyError(`"${url}" is not a URL.`, 'config');
    }
    if (!/^https?:$/.test(u.protocol)) throw new ComfyError('The ComfyUI address must be http or https.', 'config');
    const local = ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(u.hostname);
    if (!local && !allowRemote) {
        throw new ComfyError(`${u.host} is not this computer. The identity photo and the video would leave it; pass --allow-remote-comfy only if the person in them agreed to that.`, 'config');
    }
    return u;
}

export function graphHash(graph: Graph): string {
    return createHash('sha256').update(JSON.stringify(graph)).digest('hex').slice(0, 16);
}

export interface OutputFile {
    filename: string;
    subfolder: string;
    type: string;
}

/** Every file a finished job reports, whatever key the node used (images, video, gifs...). */
export function outputsOf(historyEntry: any): OutputFile[] {
    const found: OutputFile[] = [];
    for (const node of Object.values(historyEntry?.outputs ?? {})) {
        for (const list of Object.values(node as Record<string, unknown>)) {
            if (!Array.isArray(list)) continue;
            for (const f of list) if (f && typeof f === 'object' && typeof (f as any).filename === 'string') found.push({ filename: (f as any).filename, subfolder: String((f as any).subfolder ?? ''), type: String((f as any).type ?? 'output') });
        }
    }
    return found;
}

/** The node error ComfyUI recorded for a failed job, as one line. */
export function failureOf(historyEntry: any): string | null {
    const status = historyEntry?.status;
    if (!status || status.status_str !== 'error') return null;
    const msg = (status.messages ?? []).find((m: any) => Array.isArray(m) && m[0] === 'execution_error')?.[1];
    return msg ? `${msg.node_type ?? 'node'}: ${String(msg.exception_message ?? '').trim().slice(0, 300)}` : 'the job failed without a message';
}

export class Comfy {
    readonly base: string;
    constructor(
        url: string = DEFAULT_COMFY_URL,
        allowRemote = false,
        private readonly fetchImpl: typeof fetch = fetch,
    ) {
        this.base = checkComfyUrl(url, allowRemote).origin;
    }

    /**
     * Every request: redirects are refused (a local server must not be able to forward the files elsewhere) and
     * the whole exchange has a deadline. A deadline here never cancels the job running in ComfyUI.
     */
    private async call(pathname: string, init?: RequestInit, deadlineMs = 60_000): Promise<Response> {
        try {
            const r = await this.fetchImpl(`${this.base}${pathname}`, { ...init, redirect: 'manual', signal: AbortSignal.timeout(deadlineMs) });
            if (r.status >= 300 && r.status < 400) throw new ComfyError(`ComfyUI at ${this.base} answered with a redirect, which is refused: files are only sent to the address given.`, 'config');
            return r;
        } catch (e) {
            if (e instanceof ComfyError) throw e;
            throw new ComfyError(`ComfyUI did not answer at ${this.base} (${(e as Error).message}). Start it, or pass --comfy-url.`, 'unreachable');
        }
    }

    async json(pathname: string): Promise<any> {
        const r = await this.call(pathname);
        if (!r.ok) throw new ComfyError(`ComfyUI answered HTTP ${r.status} on ${pathname}.`, 'rejected');
        return r.json();
    }

    /** Which of these node classes the server does not have. */
    async missingNodes(classes: string[]): Promise<string[]> {
        const info = await this.json('/object_info');
        return classes.filter((c) => !(c in info));
    }

    /** Model file names a loader offers (its combo choices). */
    async choices(nodeClass: string, input: string): Promise<string[]> {
        const info = await this.json(`/object_info/${encodeURIComponent(nodeClass)}`);
        const spec = info?.[nodeClass]?.input?.required?.[input] ?? info?.[nodeClass]?.input?.optional?.[input];
        const first = Array.isArray(spec) ? spec[0] : null;
        if (Array.isArray(first)) return first.map(String);
        const opts = Array.isArray(spec) ? spec[1]?.options : null;
        return Array.isArray(opts) ? opts.map(String) : [];
    }

    /** Uploads a file into ComfyUI's input folder under `name` (overwriting a file of that name) and returns the name to use in a graph. */
    async upload(file: string, name: string): Promise<string> {
        const form = new FormData();
        form.append('image', new Blob([await readFile(file)]), name);
        form.append('overwrite', 'true');
        const r = await this.call('/upload/image', { method: 'POST', body: form }, 300_000);
        if (!r.ok) throw new ComfyError(`ComfyUI refused the upload of ${path.basename(file)} (HTTP ${r.status}).`, 'rejected');
        const j: any = await r.json();
        return j.subfolder ? `${j.subfolder}/${j.name}` : String(j.name);
    }

    /**
     * Submits a graph. `clientId` must be new for each job: if the answer is lost, the job is looked up by it
     * instead of being submitted twice.
     */
    async submit(graph: Graph, clientId: string = randomUUID()): Promise<{ promptId: string; clientId: string }> {
        const lost = async (): Promise<{ promptId: string; clientId: string }> => {
            const found = await this.findByClient(clientId).catch(() => null);
            if (found) return { promptId: found, clientId };
            throw new ComfyError('The answer to the submission was lost and the job cannot be found in the queue or history. Check the ComfyUI window before submitting again.', 'unknown_submit');
        };
        let r: Response;
        try {
            r = await this.call('/prompt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: graph, client_id: clientId }) });
        } catch (e) {
            if (e instanceof ComfyError && e.kind === 'config') throw e;
            return lost();
        }
        let j: any;
        try {
            j = await r.json();
        } catch {
            // The server answered but the body did not arrive: the job may exist.
            if (r.ok) return lost();
            j = {};
        }
        if (!r.ok || !j.prompt_id) {
            const nodeErrors = Object.entries(j.node_errors ?? {})
                .map(([id, e]: [string, any]) => `${id} ${e.class_type ?? ''}: ${(e.errors ?? []).map((x: any) => `${x.message} ${x.details ?? ''}`.trim()).join('; ')}`)
                .slice(0, 6);
            throw new ComfyError(`ComfyUI rejected the graph: ${j.error?.message ?? `HTTP ${r.status}`}${nodeErrors.length ? ` — ${nodeErrors.join(' | ')}` : ''}`, 'rejected', j.node_errors);
        }
        return { promptId: String(j.prompt_id), clientId };
    }

    /**
     * Looks for a job by the client id it was submitted with: in the queue, then in ALL the history ComfyUI still
     * keeps. null means "not there now", which is not the same as "never received": history can be cleared.
     */
    async findByClient(clientId: string): Promise<string | null> {
        const q = await this.json('/queue');
        for (const item of [...(q.queue_running ?? []), ...(q.queue_pending ?? [])]) if (item?.[3]?.client_id === clientId) return String(item[1]);
        const h = await this.json('/history');
        for (const [id, entry] of Object.entries(h)) if ((entry as any)?.prompt?.[3]?.client_id === clientId) return id;
        return null;
    }

    /** The client id a job was submitted with, or null when ComfyUI does not know the job. */
    async clientOf(promptId: string): Promise<string | null> {
        const q = await this.json('/queue');
        for (const item of [...(q.queue_running ?? []), ...(q.queue_pending ?? [])]) if (String(item?.[1]) === promptId) return String(item?.[3]?.client_id ?? '');
        const h = await this.json(`/history/${encodeURIComponent(promptId)}`);
        const entry = h?.[promptId];
        return entry ? String(entry.prompt?.[3]?.client_id ?? '') : null;
    }

    /** Waits for a job. Resolves with its history entry; throws on failure or after `timeoutMs`. */
    async wait(promptId: string, o: { timeoutMs: number; pollMs?: number; onTick?: (state: string, elapsedMs: number) => void }): Promise<any> {
        const started = Date.now();
        for (;;) {
            const h = await this.json(`/history/${encodeURIComponent(promptId)}`);
            const entry = h?.[promptId];
            if (entry) {
                const failure = failureOf(entry);
                if (failure) throw new ComfyError(`The job failed in ComfyUI — ${failure}`, 'failed', entry.status);
                if (entry.status?.completed !== false) return entry;
            }
            const elapsed = Date.now() - started;
            if (elapsed > o.timeoutMs) throw new ComfyError(`The job is still running after ${Math.round(elapsed / 1000)} s. It was NOT cancelled: run the same command with --resume ${promptId} to collect it.`, 'timeout');
            o.onTick?.(entry ? 'finishing' : 'running', elapsed);
            await new Promise((r) => setTimeout(r, o.pollMs ?? 3000));
        }
    }

    async download(f: OutputFile, dest: string): Promise<void> {
        const q = new URLSearchParams({ filename: f.filename, subfolder: f.subfolder, type: f.type });
        const r = await this.call(`/view?${q}`, undefined, 600_000);
        if (!r.ok) throw new ComfyError(`ComfyUI could not serve ${f.filename} (HTTP ${r.status}).`, 'no_output');
        await writeFile(dest, new Uint8Array(await r.arrayBuffer()));
    }
}

/** The video written by the graph's save node `nodeId` (the one node whose file is the result). */
export function pickVideo(entry: any, nodeId: string): OutputFile {
    const vids = outputsOf({ outputs: { [nodeId]: entry?.outputs?.[nodeId] ?? {} } }).filter((f) => /\.(mp4|webm|mov|mkv)$/i.test(f.filename) && f.type === 'output');
    if (vids.length !== 1) throw new ComfyError(`The job finished but its save node (${nodeId}) reported ${vids.length} video files instead of one.`, 'no_output');
    return vids[0];
}
