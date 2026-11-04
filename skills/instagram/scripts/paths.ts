import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const APP_DATA_DIR = 'instagram-ai';

export function resolveUserDataRoot(): string {
    if (process.platform === 'win32') {
        return process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
    }
    if (process.platform === 'darwin') {
        return path.join(os.homedir(), 'Library', 'Application Support');
    }
    return process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share');
}

function override(name: string): string | undefined {
    const v = process.env[name]?.trim();
    return v ? path.resolve(v) : undefined;
}

export function resolveDataDir(): string {
    return override('INSTAGRAM_DATA_DIR') ?? path.join(resolveUserDataRoot(), APP_DATA_DIR);
}

export function resolveCookiePath(): string {
    return override('INSTAGRAM_COOKIE_PATH') ?? path.join(resolveDataDir(), 'cookies.json');
}

export function resolveChromeProfileDir(): string {
    return override('INSTAGRAM_CHROME_PROFILE_DIR') ?? path.join(resolveDataDir(), 'chrome-profile');
}

/** Runtime config learned from the live page (app id, ASBD id, www-claim). */
export function resolveRuntimeConfigPath(): string {
    return path.join(resolveDataDir(), 'runtime-config.json');
}

export function resolveOutputDir(): string {
    return override('INSTAGRAM_OUTPUT_DIR') ?? path.join(resolveDataDir(), 'outputs');
}

/** Append-only log of every write the CLI performed (no secrets). */
export function resolveActionLogPath(): string {
    return path.join(resolveDataDir(), 'actions.jsonl');
}
