/** ffmpeg / ffprobe helpers. Every call passes an argument array; nothing goes through a shell. */
import { spawn } from 'node:child_process';

export interface RunResult {
    code: number;
    stdout: Buffer;
    stderr: string;
}

export class ToolError extends Error {
    constructor(
        message: string,
        readonly hint?: string,
    ) {
        super(message);
    }
}

/** `fullStderr` keeps all of stderr: required when stderr carries measurements (showinfo), not just diagnostics. */
export function run(cmd: string, args: string[], options?: { cwd?: string; fullStderr?: boolean }): Promise<RunResult> {
    return new Promise((resolve, reject) => {
        const child = spawn(cmd, args, { cwd: options?.cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        const out: Buffer[] = [];
        let err = '';
        const errAll: Buffer[] = [];
        child.stdout.on('data', (c: Buffer) => out.push(c));
        child.stderr.on('data', (c: Buffer) => {
            if (options?.fullStderr) errAll.push(c);
            // Diagnostics keep the tail only: ffmpeg can print megabytes of progress.
            else err = (err + c.toString('utf8')).slice(-400_000);
        });
        child.on('error', (e: NodeJS.ErrnoException) => {
            if (e.code === 'ENOENT') reject(new ToolError(`${cmd} was not found on PATH.`, installHint(cmd)));
            else reject(e);
        });
        child.on('close', (code) => resolve({ code: code ?? -1, stdout: Buffer.concat(out), stderr: options?.fullStderr ? Buffer.concat(errAll).toString('utf8') : err }));
    });
}

/** Runs a tool and throws with the last lines of stderr when it exits non-zero. */
export async function must(cmd: string, args: string[], options?: { cwd?: string }): Promise<RunResult> {
    const r = await run(cmd, args, options);
    if (r.code !== 0) {
        const tail = r.stderr.trim().split(/\r?\n/).slice(-6).join('\n');
        throw new ToolError(`${cmd} failed (exit ${r.code}):\n${tail}`);
    }
    return r;
}

export const ffmpeg = (args: string[]) => must('ffmpeg', ['-hide_banner', '-nostdin', '-y', ...args]);
export const ffprobe = (args: string[]) => must('ffprobe', ['-v', 'error', ...args]);

export function installHint(cmd: string): string {
    if (cmd === 'ffmpeg' || cmd === 'ffprobe') {
        return 'Install ffmpeg (it includes ffprobe): Windows `winget install Gyan.FFmpeg`, macOS `brew install ffmpeg`, Debian/Ubuntu `sudo apt install ffmpeg`. Then open a new terminal.';
    }
    if (cmd === 'comfy') return 'Optional. Install the ComfyUI CLI with `pip install comfy-cli` to use the "generate" routes.';
    return `Install ${cmd} and make sure it is on PATH.`;
}

/** First version-looking token of `<tool> -version` (or `--version`), or null when the tool is absent. */
export async function toolVersion(cmd: string, flag = '-version'): Promise<string | null> {
    try {
        const r = await run(cmd, [flag]);
        const text = `${r.stdout.toString('utf8')}\n${r.stderr}`;
        const m = text.match(/version\s+([0-9][^\s,]*)/i) ?? text.match(/\b(\d+\.\d+(?:\.\d+)?)\b/);
        return m ? m[1] : r.code === 0 ? 'unknown' : null;
    } catch {
        return null;
    }
}

export function majorOf(version: string | null): number | null {
    const m = version?.match(/^n?(\d+)/);
    return m ? Number(m[1]) : null;
}

/** Seconds with millisecond precision, the form ffmpeg accepts for -ss / -t. */
export const sec = (n: number) => Math.max(0, n).toFixed(3);
