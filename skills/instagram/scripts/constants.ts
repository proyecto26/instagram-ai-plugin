import process from 'node:process';

/**
 * Every value Instagram can rotate lives here so a change is a one-line fix.
 * Values verified against the live instagram.com web client on 2026-11-03:
 *  - IG_APP_ID: the web app id embedded in the page HTML ("X-IG-App-ID").
 *  - ASBD_ID:   require("BDHeaderConfig").ASBD_ID, sent as "X-ASBD-ID".
 * Both can be overridden by env vars, and `main.ts probe --refresh-config`
 * re-reads them from the live page and stores them in the data dir.
 */
function env(name: string): string | undefined {
    const v = process.env[name]?.trim();
    return v ? v : undefined;
}

/**
 * Origin overrides exist for debugging only and must stay on Instagram: Bun
 * auto-loads a `.env` from the working directory, so an override pointing
 * elsewhere would hand the session cookies to that host. Anything that is not
 * https on instagram.com (or a subdomain) is ignored with a warning.
 */
export function instagramOrigin(name: string, fallback: string): string {
    const raw = env(name);
    if (!raw) return fallback;
    try {
        const u = new URL(raw);
        if (u.protocol === 'https:' && (u.hostname === 'instagram.com' || u.hostname.endsWith('.instagram.com'))) return u.origin;
    } catch {
        // fall through
    }
    process.stderr.write(`[instagram] Ignoring ${name}: only https://*.instagram.com origins are allowed.
`);
    return fallback;
}

export const IG_ORIGIN = instagramOrigin('INSTAGRAM_BASE_URL', 'https://www.instagram.com');
export const IG_HOST = new URL(IG_ORIGIN).hostname;
export const IG_URL = `${IG_ORIGIN}/`;

/** Upload host used by the web client's rupload module (withCredentials). */
export const IG_UPLOAD_ORIGIN = instagramOrigin('INSTAGRAM_UPLOAD_URL', 'https://i.instagram.com');

/** Mobile-style API host; several read endpoints answer here with web cookies. */
export const IG_API_ORIGIN = instagramOrigin('INSTAGRAM_API_URL', 'https://i.instagram.com');

export const DEFAULT_IG_APP_ID = '936619743392459';
export const DEFAULT_ASBD_ID = '359341';

export const USER_AGENT =
    env('INSTAGRAM_USER_AGENT') ??
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';

/** Minimum gap between two requests to Instagram, in ms. */
export const MIN_REQUEST_GAP_MS = Number(env('INSTAGRAM_MIN_GAP_MS') ?? 1500);

/** Instagram content limits enforced before anything is uploaded. */
export const LIMITS = {
    captionChars: 2200,
    /** Instagram caps hashtags at 5 per post since Dec 2025 (marketingskills platform-limits). */
    hashtagsMax: Number(process.env.INSTAGRAM_MAX_HASHTAGS ?? 5),
    mentionsHard: 20,
    carouselMin: 2,
    carouselMax: 20,
    /** width / height. 4:5 portrait .. 1.91:1 landscape for feed photos. */
    feedAspectMin: 0.8,
    feedAspectMax: 1.91,
    reelMinSeconds: 3,
    reelMaxSeconds: 15 * 60,
    storyVideoMaxSeconds: 60,
    photoMaxBytes: 8 * 1024 * 1024,
    videoMaxBytes: 1024 * 1024 * 1024,
    commentChars: 2200,
} as const;

export const KNOWN_HOSTS = [...new Set(['www.instagram.com', 'instagram.com', 'i.instagram.com', IG_HOST, new URL(IG_UPLOAD_ORIGIN).hostname, new URL(IG_API_ORIGIN).hostname])];

/** Extracts a shortcode from a post/reel URL, or returns null. */
export function shortcodeFromUrl(input: string): string | null {
    try {
        const u = new URL(input);
        if (!KNOWN_HOSTS.includes(u.hostname)) return null;
        const m = u.pathname.match(/\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/);
        return m ? m[1] : null;
    } catch {
        return null;
    }
}

const SHORTCODE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Converts a post shortcode to its numeric media pk (base64url alphabet, big-endian). */
export function shortcodeToPk(shortcode: string): string {
    let n = 0n;
    // Private posts append extra chars after 11; the pk lives in the first 11.
    for (const ch of shortcode.slice(0, 11)) {
        const i = SHORTCODE_ALPHABET.indexOf(ch);
        if (i < 0) throw new Error(`Invalid shortcode character "${ch}" in ${shortcode}`);
        n = n * 64n + BigInt(i);
    }
    return n.toString();
}

/** Converts a numeric media pk to its shortcode. */
export function pkToShortcode(pk: string): string {
    let n = BigInt(pk.split('_')[0]);
    let out = '';
    while (n > 0n) {
        out = SHORTCODE_ALPHABET[Number(n % 64n)] + out;
        n /= 64n;
    }
    return out || 'A';
}

export function postUrl(shortcode: string, kind: 'p' | 'reel' = 'p'): string {
    return `${IG_ORIGIN}/${kind}/${shortcode}/`;
}
