import { spawnSync } from 'node:child_process';
import { chmod, mkdir, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * The data dir holds a live Instagram session (cookies.json) and a signed-in
 * Chrome profile. Both are credentials, so the directory is locked to the
 * current user BEFORE anything is written, and the CLI refuses to store a
 * session when that cannot be done (fail closed).
 *
 * POSIX: dir 0700, files 0600.
 * Windows: Node ignores chmod, so icacls removes inheritance, grants the current
 * user full control (inherited by children), removes every other explicit
 * principal, then reads the ACL back to prove only the user remains.
 *
 * Escape hatch for unusual setups: INSTAGRAM_ALLOW_INSECURE_STORAGE=1.
 */

export class InsecureStorageError extends Error {
    constructor(target: string, detail: string) {
        super(
            `Could not restrict ${target} to the current user (${detail}). The session was NOT saved. ` +
                'Fix the folder permissions, choose another INSTAGRAM_DATA_DIR, or set INSTAGRAM_ALLOW_INSECURE_STORAGE=1 to accept the risk.',
        );
        this.name = 'InsecureStorageError';
    }
}

function currentPrincipal(): { full: string; name: string } {
    const name = os.userInfo().username;
    const domain = process.env.USERDOMAIN?.trim();
    return { full: domain ? `${domain}\\${name}` : name, name };
}

/** Parses `icacls <path>` output into principal names. Exported for tests. */
export function parseIcaclsPrincipals(output: string, target: string): string[] {
    const out: string[] = [];
    for (const raw of output.split(/\r?\n/)) {
        const line = raw.startsWith(target) ? raw.slice(target.length) : raw;
        const m = line.trim().match(/^(.+?):\(/);
        if (m) out.push(m[1].trim());
    }
    return out;
}

function isSelf(principal: string, me: { full: string; name: string }): boolean {
    const p = principal.toLowerCase();
    // Exact match only: OTHERDOMAIN\<same name> is a different account and must be removed.
    return p === me.full.toLowerCase() || (!p.includes('\\') && p === me.name.toLowerCase());
}

function icacls(args: string[]): { ok: boolean; out: string } {
    const r = spawnSync('icacls', args, { encoding: 'utf8', windowsHide: true });
    return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/**
 * True when every ACE below the root of an `icacls <dir> /T` listing is inherited "(I)".
 * The root grants only the current user, so inherited entries are only that user.
 * Exported for tests.
 */
export function descendantsOnlyInherit(output: string): boolean {
    const blocks = output.split(/\r?\n\s*\r?\n/);
    for (const block of blocks.slice(1)) {
        for (const line of block.split(/\r?\n/)) {
            if (/:\(/.test(line) && !/\(I\)/.test(line)) return false;
        }
    }
    return true;
}

export async function restrictToCurrentUser(target: string, kind: 'dir' | 'file', opts?: { recursive?: boolean }): Promise<{ ok: boolean; detail: string }> {
    if (process.platform !== 'win32') {
        try {
            await chmod(target, kind === 'dir' ? 0o700 : 0o600);
            return { ok: true, detail: kind === 'dir' ? 'chmod 700' : 'chmod 600' };
        } catch (error) {
            return { ok: false, detail: (error as Error).message };
        }
    }
    const me = currentPrincipal();
    if (kind === 'dir' && opts?.recursive) {
        // Drop explicit grants on existing children (e.g. a reused Chrome profile) so they inherit the root.
        const reset = icacls([path.join(target, '*'), '/reset', '/T', '/C', '/Q']);
        // An empty folder has nothing to match "*": that is fine. Any other failure is not.
        const empty = (await readdir(target)).length === 0;
        if (!reset.ok && !empty) return { ok: false, detail: `could not reset permissions inside: ${reset.out.trim()}` };
    }
    const grant = kind === 'dir' ? `${me.full}:(OI)(CI)F` : `${me.full}:F`;
    const set = icacls([target, '/inheritance:r', '/grant:r', grant]);
    if (!set.ok) return { ok: false, detail: set.out.trim() || 'icacls failed' };
    const before = icacls([target]);
    for (const p of parseIcaclsPrincipals(before.out, target)) {
        if (!isSelf(p, me)) icacls([target, '/remove', p]);
    }
    const after = icacls([target]);
    const others = parseIcaclsPrincipals(after.out, target).filter((p) => !isSelf(p, me));
    if (!after.ok) return { ok: false, detail: 'could not read the ACL back' };
    if (others.length) return { ok: false, detail: `still readable by: ${others.join(', ')}` };
    if (kind === 'dir' && opts?.recursive) {
        const tree = icacls([target, '/T', '/C']);
        if (!tree.ok) return { ok: false, detail: 'could not read the permissions inside the folder' };
        if (!descendantsOnlyInherit(tree.out)) return { ok: false, detail: 'a file inside still has its own permissions' };
    }
    return { ok: true, detail: `only ${me.full}` };
}

/** Creates `dir` if needed and locks it down; throws InsecureStorageError when that fails. */
export async function ensurePrivateDir(dir: string, opts?: { recursive?: boolean }): Promise<void> {
    await mkdir(dir, { recursive: true });
    const r = await restrictToCurrentUser(dir, 'dir', opts);
    if (!r.ok && process.env.INSTAGRAM_ALLOW_INSECURE_STORAGE !== '1') throw new InsecureStorageError(dir, r.detail);
}

export async function ensurePrivateFile(file: string): Promise<void> {
    const r = await restrictToCurrentUser(file, 'file');
    if (!r.ok && process.env.INSTAGRAM_ALLOW_INSECURE_STORAGE !== '1') throw new InsecureStorageError(file, r.detail);
}
