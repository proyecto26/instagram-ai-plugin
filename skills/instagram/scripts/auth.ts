import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import process from 'node:process';

import { buildCookieMap, hasRequiredCookies } from './cookie-store.ts';
import { resolveChromeProfileDir, resolveDataDir } from './paths.ts';
import { ensurePrivateDir } from './secure.ts';
import type { LogFn } from './types.ts';

import { IG_URL } from './constants.ts';

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.unref();
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            if (!address || typeof address === 'string') {
                server.close(() => reject(new Error('Unable to allocate a free TCP port for Chrome debugging.')));
                return;
            }
            const port = address.port;
            server.close((err) => {
                if (err) reject(err);
                else resolve(port);
            });
        });
    });
}

function findChromeExecutable(): string | undefined {
    const override = process.env.INSTAGRAM_CHROME_PATH?.trim();
    if (override && fs.existsSync(override)) return override;

    const candidates: string[] = [];
    switch (process.platform) {
        case 'darwin':
            candidates.push(
                '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
                '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
                '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta',
                '/Applications/Chromium.app/Contents/MacOS/Chromium',
                '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
            );
            break;
        case 'win32':
            candidates.push(
                'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
                'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
                'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
                'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
            );
            break;
        default:
            candidates.push(
                '/usr/bin/google-chrome',
                '/usr/bin/google-chrome-stable',
                '/usr/bin/chromium',
                '/usr/bin/chromium-browser',
                '/snap/bin/chromium',
                '/usr/bin/microsoft-edge',
                '/usr/bin/microsoft-edge-stable',
            );
            break;
    }

    for (const p of candidates) {
        if (fs.existsSync(p)) return p;
    }
    return undefined;
}

async function fetchJson<T = unknown>(url: string): Promise<T> {
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) {
        throw new Error(`Request failed: ${res.status} ${res.statusText} (${url})`);
    }
    return (await res.json()) as T;
}

async function waitForChromeDebugPort(
    port: number,
    timeoutMs: number,
): Promise<{ webSocketDebuggerUrl: string }> {
    const start = Date.now();
    let lastError: unknown = null;

    while (Date.now() - start < timeoutMs) {
        try {
            const version = await fetchJson<{ webSocketDebuggerUrl?: string }>(
                `http://127.0.0.1:${port}/json/version`,
            );
            if (version.webSocketDebuggerUrl) {
                return { webSocketDebuggerUrl: version.webSocketDebuggerUrl };
            }
            lastError = new Error('Missing webSocketDebuggerUrl');
        } catch (error) {
            lastError = error;
        }

        await sleep(200);
    }

    throw new Error(
        `Chrome debugging endpoint did not become ready within ${timeoutMs}ms: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    );
}

class CdpConnection {
    private ws: WebSocket;
    private nextId = 0;
    private pending = new Map<
        number,
        { resolve: (value: unknown) => void; reject: (reason: Error) => void; timer: ReturnType<typeof setTimeout> | null }
    >();

    private constructor(ws: WebSocket) {
        this.ws = ws;
        this.ws.addEventListener('message', (event) => {
            try {
                const data = (() => {
                    if (typeof event.data === 'string') return event.data;
                    if (event.data instanceof ArrayBuffer) {
                        return new TextDecoder().decode(new Uint8Array(event.data));
                    }
                    if (ArrayBuffer.isView(event.data)) {
                        return new TextDecoder().decode(event.data);
                    }
                    return String(event.data);
                })();
                const msg = JSON.parse(data) as { id?: number; result?: unknown; error?: { message?: string } };
                if (!msg.id) return;
                const pending = this.pending.get(msg.id);
                if (!pending) return;
                this.pending.delete(msg.id);
                if (pending.timer) clearTimeout(pending.timer);
                if (msg.error?.message) pending.reject(new Error(msg.error.message));
                else pending.resolve(msg.result);
            } catch {
                // ignore malformed events
            }
        });

        this.ws.addEventListener('close', () => {
            for (const [id, pending] of this.pending.entries()) {
                this.pending.delete(id);
                if (pending.timer) clearTimeout(pending.timer);
                pending.reject(new Error('Chrome DevTools connection closed.'));
            }
        });
    }

    static async connect(url: string, timeoutMs: number): Promise<CdpConnection> {
        const ws = new WebSocket(url);
        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('Timed out connecting to Chrome DevTools.')), timeoutMs);
            ws.addEventListener('open', () => {
                clearTimeout(timer);
                resolve();
            });
            ws.addEventListener('error', () => {
                clearTimeout(timer);
                reject(new Error('Failed to connect to Chrome DevTools.'));
            });
        });
        return new CdpConnection(ws);
    }

    async send<T = unknown>(
        method: string,
        params?: Record<string, unknown>,
        options?: { sessionId?: string; timeoutMs?: number },
    ): Promise<T> {
        const id = (this.nextId += 1);
        const message: Record<string, unknown> = { id, method };
        if (params) message.params = params;
        if (options?.sessionId) message.sessionId = options.sessionId;

        const timeoutMs = options?.timeoutMs ?? 15_000;

        const result = await new Promise<unknown>((resolve, reject) => {
            const timer =
                timeoutMs > 0
                    ? setTimeout(() => {
                          this.pending.delete(id);
                          reject(new Error(`CDP command timeout (${method}) after ${timeoutMs}ms.`));
                      }, timeoutMs)
                    : null;
            this.pending.set(id, {
                resolve,
                reject: (reason) => reject(reason),
                timer,
            });
            this.ws.send(JSON.stringify(message));
        });

        return result as T;
    }

    close(): void {
        try {
            this.ws.close();
        } catch {
            // ignore
        }
    }
}


/**
 * Opens Chrome on instagram.com with a dedicated profile, waits until the user is
 * signed in (sessionid + ds_user_id present and the page left /accounts/login),
 * and returns the instagram.com cookies. `sessionid` is HttpOnly, which is why this
 * reads cookies through the DevTools protocol instead of document.cookie.
 */
export async function getInstagramCookiesViaChrome(options?: {
    timeoutMs?: number;
    pollIntervalMs?: number;
    log?: LogFn;
    userDataDir?: string;
    chromePath?: string;
}): Promise<Record<string, string>> {
    const log = options?.log;
    const timeoutMs = options?.timeoutMs ?? 5 * 60_000;
    const pollIntervalMs = options?.pollIntervalMs ?? 2_000;
    const userDataDir = options?.userDataDir ?? resolveChromeProfileDir();
    const chromePath = options?.chromePath ?? findChromeExecutable();
    if (!chromePath) {
        throw new Error('Unable to locate Chrome/Chromium/Edge. Install Chrome, set INSTAGRAM_CHROME_PATH, or use `import-cookies`.');
    }
    // The Chrome profile will hold a signed-in session: lock the data dir before Chrome writes to it.
    await ensurePrivateDir(resolveDataDir());
    // Recursive: a reused profile may contain files with their own (wider) permissions.
    await ensurePrivateDir(userDataDir, { recursive: true });

    const port = await getFreePort();
    log?.(`[instagram] Launching Chrome for sign-in (profile: ${userDataDir})`);
    const chrome = spawn(
        chromePath,
        [
            `--remote-debugging-port=${port}`,
            `--user-data-dir=${userDataDir}`,
            '--no-first-run',
            '--no-default-browser-check',
            IG_URL,
        ],
        { stdio: 'ignore' },
    );

    let cdp: CdpConnection | null = null;
    try {
        const { webSocketDebuggerUrl } = await waitForChromeDebugPort(port, 30_000);
        cdp = await CdpConnection.connect(webSocketDebuggerUrl, 30_000);
        const { targetInfos } = await cdp.send<{ targetInfos: { targetId: string; type: string; url: string }[] }>('Target.getTargets');
        const page = targetInfos.find((t) => t.type === 'page');
        const targetId = page
            ? page.targetId
            : (await cdp.send<{ targetId: string }>('Target.createTarget', { url: IG_URL })).targetId;
        const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
        await cdp.send('Network.enable', {}, { sessionId });

        log?.('[instagram] Sign in to Instagram in the opened window (2FA is fine). Waiting...');
        const start = Date.now();
        let last = '';
        while (Date.now() - start < timeoutMs) {
            const res = await cdp.send<{ cookies?: { name: string; value: string; domain: string; path: string }[] }>(
                'Network.getAllCookies',
                {},
                { sessionId },
            );
            const map = buildCookieMap(res.cookies ?? []);
            if (hasRequiredCookies(map)) {
                let href = '';
                try {
                    const ev = await cdp.send<{ result?: { value?: string } }>(
                        'Runtime.evaluate',
                        { expression: 'location.href' },
                        { sessionId, timeoutMs: 5_000 },
                    );
                    href = ev?.result?.value ?? '';
                } catch {
                    // page navigating; retry next tick
                }
                if (href && !/\/accounts\/(login|onetap|suspended)|\/challenge\//.test(href)) {
                    log?.('[instagram] Signed in; session cookies captured.');
                    return map;
                }
                last = `page is ${href || 'loading'}`;
            } else {
                last = 'no session cookie yet';
            }
            await sleep(pollIntervalMs);
        }
        throw new Error(`Timed out waiting for Instagram sign-in after ${timeoutMs / 1000}s (${last}).`);
    } finally {
        if (cdp) {
            try {
                await cdp.send('Browser.close', {}, { timeoutMs: 5_000 });
            } catch {
                // ignore
            }
            cdp.close();
        }
        try {
            chrome.kill('SIGTERM');
        } catch {
            // ignore
        }
    }
}
