/**
 * The "comet async" request shape instagram.com uses for some writes (configure_to_clips always; stories and
 * carousels behind server gates). Evidence: a live capture of the web composer publishing a reel (2026-11-12; see
 * PR #1), and the web client's getAsyncParams / DTSGUtils / PolarisCreationAPI modules.
 *
 * The request is the ordinary form fields plus a set of page-context parameters; the answer is always HTTP 200
 * with `for (;;);{"__ar":1,"payload":{...}}`. "Still processing" is payload.statusCode 202, not an HTTP status.
 *
 * Everything here is pure: parsing the page context out of saved HTML, building the form, decoding the answer.
 * Nothing in the page is ever executed. Token values (fb_dtsg, lsd, the nonce, hsi, the session id) are secrets:
 * they must never be logged, printed in a dry run, or stored on disk.
 */

/** Page context read from the signed-in instagram.com HTML. Kept in memory only. */
export interface WebContext {
    fetchedAt: number;
    /** DTSGInitialData.token (secret). */
    fbDtsg: string;
    /** LSD.token (secret). */
    lsd: string;
    /** SprinkleConfig: the name of the numeric-token parameter (normally "jazoest") and how it is derived. */
    sprinkleParam: string;
    sprinkleVersion: number;
    sprinkleRandomize: boolean;
    /** CurrentUserInitialData.USER_ID, exactly as served (it is "0" on instagram.com). */
    user: string;
    /** SiteData. */
    cometEnv: number | null;
    wbloksEnv: boolean;
    clientRevision: string;
    hasteSession: string;
    hsi: string;
    spin: { r: string; b: string; t: string } | null;
    /** InstagramWebPushInfo.rollout_hash, sent as X-Instagram-AJAX. */
    rolloutHash: string;
    /** Server gates that decide the transport for stories (28588) and carousels (18382). null = not found. */
    gates: { storyComet: boolean | null; sidecarComet: boolean | null };
}

/** Reads the object of a `["Name",[],{...},123]` server definition by scanning balanced braces. No eval. */
export function readDefine(html: string, name: string): Record<string, any> | null {
    const marker = `["${name}",[],`;
    let from = 0;
    for (;;) {
        const at = html.indexOf(marker, from);
        if (at < 0) return null;
        const start = at + marker.length;
        from = start;
        if (html[start] !== '{') continue;
        let depth = 0;
        let inStr = false;
        // Definitions are small; refuse to scan more than 200 kB for one.
        const limit = Math.min(html.length, start + 200_000);
        for (let i = start; i < limit; i++) {
            const ch = html[i];
            if (inStr) {
                if (ch === '\\') i++;
                else if (ch === '"') inStr = false;
            } else if (ch === '"') inStr = true;
            else if (ch === '{') depth++;
            else if (ch === '}' && --depth === 0) {
                try {
                    const v = JSON.parse(html.slice(start, i + 1));
                    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
                } catch {
                    break;
                }
            }
        }
    }
}

function gate(html: string, id: string): boolean | null {
    const m = html.match(new RegExp(`"${id}":\\{"result":(true|false)`));
    return m ? m[1] === 'true' : null;
}

/**
 * Extracts the page context. Throws an Error naming every missing piece: a write that needs the comet shape
 * must not be attempted with guessed or partial values.
 */
export function extractWebContext(html: string, now: number = Date.now()): WebContext {
    const dtsg = readDefine(html, 'DTSGInitialData');
    const lsd = readDefine(html, 'LSD');
    const sprinkle = readDefine(html, 'SprinkleConfig');
    const user = readDefine(html, 'CurrentUserInitialData');
    const site = readDefine(html, 'SiteData');
    const push = readDefine(html, 'InstagramWebPushInfo');
    const missing: string[] = [];
    const str = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? String(v) : '');
    if (!str(dtsg?.token)) missing.push('DTSGInitialData.token');
    if (!str(lsd?.token)) missing.push('LSD.token');
    if (!str(sprinkle?.param_name)) missing.push('SprinkleConfig.param_name');
    if (user?.USER_ID === undefined) missing.push('CurrentUserInitialData.USER_ID');
    if (!site) missing.push('SiteData');
    else for (const k of ['client_revision', 'haste_session', 'hsi']) if (!str(site[k])) missing.push(`SiteData.${k}`);
    if (!str(push?.rollout_hash)) missing.push('InstagramWebPushInfo.rollout_hash');
    if (missing.length) throw new Error(`The instagram.com page did not carry the expected request context (${missing.join(', ')}).`);
    return {
        fetchedAt: now,
        fbDtsg: str(dtsg!.token),
        lsd: str(lsd!.token),
        sprinkleParam: str(sprinkle!.param_name),
        sprinkleVersion: Number(sprinkle!.version ?? 2),
        sprinkleRandomize: sprinkle!.should_randomize === true,
        user: str(user!.USER_ID),
        cometEnv: typeof site!.comet_env === 'number' ? site!.comet_env : null,
        wbloksEnv: site!.wbloks_env === true,
        clientRevision: str(site!.client_revision),
        hasteSession: str(site!.haste_session),
        hsi: str(site!.hsi),
        spin: site!.spin ? { r: str(site!.__spin_r), b: str(site!.__spin_b), t: str(site!.__spin_t) } : null,
        rolloutHash: str(push!.rollout_hash),
        gates: { storyComet: gate(html, '28588'), sidecarComet: gate(html, '18382') },
    };
}

/** DTSGUtils.getNumericValue: the sum of the token's UTF-16 code units, prefixed with the config version. */
export function numericToken(token: string, version: number, randomize: boolean): string {
    let sum = 0;
    for (let i = 0; i < token.length; i++) sum += token.charCodeAt(i);
    return randomize ? String(sum) : `${version}${sum}`;
}

/** A WebSession-style id: three six-character base36 parts. A correlation value, not a credential. */
export function newWebSessionId(rand: () => number = Math.random): string {
    const part = () => Math.floor(rand() * 36 ** 6).toString(36).padStart(6, '0');
    return `${part()}:${part()}:${part()}`;
}

/** Names of the fields and headers whose values are secret; used to redact anything shown or stored. */
export const COMET_SECRET_FIELDS = ['fb_dtsg', 'lsd', 'jazoest', '__hsi', '__s', '__hs'];
export const COMET_SECRET_HEADERS = ['X-FB-LSD', 'X-Web-Session-ID'];

/**
 * The page-context parameters added to the form (getAsyncParams, POST branch). Resource-state bitmaps
 * (__dyn, __csr, __hsdp, __hblp, __sjsp), telemetry (qpl_active_flow_ids, __crn) and browser measurements
 * (dpr, __ccg) are left out: they describe a running browser and are not invented here.
 */
export function cometParams(ctx: WebContext, req: number, sessionId: string): Record<string, string> {
    const token = ctx.fbDtsg || ctx.lsd;
    const p: Record<string, string> = {
        __d: 'www',
        __user: ctx.user,
        __a: '1',
        __req: req.toString(36),
        __hs: ctx.hasteSession,
        __rev: ctx.clientRevision,
        __s: sessionId,
        __hsi: ctx.hsi,
    };
    if (!ctx.wbloksEnv && ctx.cometEnv) p.__comet_req = String(ctx.cometEnv);
    p.fb_dtsg = ctx.fbDtsg;
    p[ctx.sprinkleParam] = numericToken(token, ctx.sprinkleVersion, ctx.sprinkleRandomize);
    p.lsd = ctx.lsd;
    if (ctx.spin) {
        p.__spin_r = ctx.spin.r;
        p.__spin_b = ctx.spin.b;
        p.__spin_t = ctx.spin.t;
    }
    return p;
}

export function cometHeaders(ctx: WebContext, sessionId: string): Record<string, string> {
    return { 'X-FB-LSD': ctx.lsd, 'X-IG-D': 'www', 'X-Instagram-AJAX': ctx.rolloutHash, 'X-Web-Session-ID': sessionId };
}

/** The whole form: publish fields, signed_body over exactly those fields, then the page-context parameters. */
export function cometForm(fields: Record<string, unknown>, ctx: WebContext, req: number, sessionId: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(fields)) if (v !== undefined) out[k] = String(v);
    out.signed_body = `SIGNATURE.${JSON.stringify(fields)}`;
    return { ...out, ...cometParams(ctx, req, sessionId) };
}

/** A form with every secret value replaced by a placeholder, safe to show in a dry run. */
export function redactComet(form: Record<string, string>): Record<string, string> {
    return Object.fromEntries(Object.entries(form).map(([k, v]) => [k, COMET_SECRET_FIELDS.includes(k) ? `<${k}: hidden>` : v]));
}

export type CometSignal = 'not_logged_in' | 'checkpoint' | 'feedback_required' | 'rate_limited' | null;

export type CometAnswer =
    /** HTTP 200 with no body: the endpoint did not answer this request shape. Never success, never retried. */
    | { kind: 'empty' }
    /** Not an envelope at all (HTML, plain JSON, garbage). */
    | { kind: 'not_envelope'; summary: string }
    /** The envelope itself reports an error (truthy `error`). `code` is digits only. */
    | { kind: 'error'; code: string; signal: CometSignal; summary: string }
    /** A payload: classify it like a publish answer. statusCode is the value INSIDE the payload. */
    | { kind: 'payload'; payload: any; statusCode: number | null; signal: CometSignal; summary: string };

const KNOWN_KEYS = ['statusCode', 'status', 'media', 'medias', 'posts', 'upload_id', 'message', 'error_title', 'error_type', 'require_login', 'checkpoint_url', 'spam', 'feedback_title', 'lock'];
const KNOWN_STATUS = ['ok', 'fail', 'pending', 'in_progress', 'error'];

/**
 * Account signals anywhere in an envelope or payload: flags, redirect targets and the known message words.
 * Only the classification leaves this function, never the text it was read from.
 */
export function cometSignal(...parts: unknown[]): CometSignal {
    let text = '';
    const walk = (v: unknown, depth: number): void => {
        if (depth > 6 || v === null || v === undefined) return;
        if (typeof v === 'string') text += ` ${v.slice(0, 400)}`;
        else if (Array.isArray(v)) for (const x of v.slice(0, 50)) walk(x, depth + 1);
        else if (typeof v === 'object') {
            const o = v as Record<string, unknown>;
            // Every structured flag the plain-form classifier (client.ts classifyBody) knows, by truthiness,
            // plus the ones seen on envelopes. A null or empty value is not a signal.
            if (o.require_login === true) text += ' login_required';
            if (o.checkpoint_url || o.challenge || o.lock === true) text += ' checkpoint_required';
            if (o.spam === true || o.feedback_required === true || (typeof o.feedback_title === 'string' && o.feedback_title)) text += ' feedback_required';
            for (const k of ['message', 'error_type', 'error_title', 'errorSummary', 'errorDescription', '__html', 'redirectTo', 'error_info', 'medias', 'posts', 'payload']) walk(o[k], depth + 1);
        }
    };
    for (const p of parts) walk(p, 0);
    const t = text.toLowerCase();
    // Exact protocol words and paths only, so an ordinary sentence in a successful answer is not a signal.
    if (/\blogin_required\b|\bnot logged in\b|\/accounts\/login\//.test(t)) return 'not_logged_in';
    if (/\bcheckpoint_required\b|\bchallenge_required\b|\/challenge\/|\/checkpoint\//.test(t)) return 'checkpoint';
    if (/\bfeedback_required\b/.test(t)) return 'feedback_required';
    if (/please wait a few minutes|\brate_limit_error\b/.test(t)) return 'rate_limited';
    return null;
}

/** Whether a payload shows that something was created: a media object, a medias[] entry with media_dict, or a root id. */
export function hasCreationEvidence(p: any): boolean {
    if (!p || typeof p !== 'object') return false;
    if (p.media && typeof p.media === 'object') return true;
    if (Array.isArray(p.medias) && p.medias.some((e: any) => e?.media_dict)) return true;
    return p.pk !== undefined || p.id !== undefined;
}

/** Decodes a comet answer. The text is data: the `for (;;);` guard is removed and the rest parsed as JSON. */
export function decodeComet(text: string): CometAnswer {
    const body = text.trim();
    if (!body) return { kind: 'empty' };
    // Media ids exceed 2^53: quote them before parsing so they are not rounded.
    const json = body.replace(/^for ?\(;;\);/, '').replace(/"(pk|id|media_id|fbid)":\s*(\d{16,})(?=\s*[,}])/g, '"$1":"$2"');
    let env: any;
    try {
        env = JSON.parse(json);
    } catch {
        return { kind: 'not_envelope', summary: `${body.length} characters, not JSON` };
    }
    if (!env || typeof env !== 'object' || Array.isArray(env) || !('__ar' in env || 'payload' in env || 'error' in env)) {
        return { kind: 'not_envelope', summary: 'JSON without an envelope' };
    }
    if (env.error) {
        const code = String(env.error).replace(/\D/g, '').slice(0, 12) || 'unknown';
        return { kind: 'error', code, signal: cometSignal(env), summary: `envelope error ${code}` };
    }
    const payload = env.payload;
    if (payload === undefined || payload === null || typeof payload !== 'object' || Array.isArray(payload)) return { kind: 'not_envelope', summary: 'envelope without a payload object' };
    const statusCode = typeof payload.statusCode === 'number' && Number.isInteger(payload.statusCode) ? payload.statusCode : null;
    // Allow-listed diagnostics only: nothing the server wrote is copied, only which known fields were present.
    const keys = Object.keys(payload);
    const known = keys.filter((k) => KNOWN_KEYS.includes(k));
    const status = typeof payload.status === 'string' && KNOWN_STATUS.includes(payload.status.toLowerCase()) ? payload.status.toLowerCase() : null;
    const summary = `payload fields: ${known.join(',') || 'none known'}${keys.length > known.length ? ` (+${keys.length - known.length} other)` : ''}${statusCode !== null ? `; statusCode ${statusCode}` : ''}${status ? `; status ${status}` : ''}`;
    // The whole envelope is inspected: a flag beside the payload (require_login, lock, ...) counts too.
    return { kind: 'payload', payload, statusCode, signal: cometSignal(env), summary };
}
