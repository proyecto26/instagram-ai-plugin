/**
 * Instagram link (or local file) -> source/video.mp4, source/cover.jpg, source/meta.json.
 *
 * Read-only. The session cookies go only to Instagram's own hosts through the shared client.
 * Media bytes come from Instagram's CDN with a plain request that carries no cookies.
 */
import { copyFile, mkdir, open, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Reading a post from a link needs the signed-in session, which lives in this plugin's `instagram` skill.
 * It is loaded only for that path, so `doctor` and local-file analysis work with this folder alone.
 */
async function loadInstagramSkill(): Promise<{ IgClient: any; getMedia: any }> {
    try {
        const [{ IgClient }, { getMedia }] = await Promise.all([import('../../instagram/scripts/client.ts'), import('../../instagram/scripts/read.ts')]);
        return { IgClient, getMedia };
    } catch (e) {
        throw new Error(`Fetching from an Instagram link needs the "instagram" skill of this plugin next to this one (skills/instagram). It could not be loaded: ${(e as Error).message}. Analysing a local video file (fetch --file) works without it.`);
    }
}

export const CDN_SUFFIXES = ['.cdninstagram.com', '.fbcdn.net'];
export const DEFAULT_MAX_BYTES = 200 * 1024 * 1024;
/** A download with no data for this long is abandoned. */
export const IDLE_MS = 60_000;
/** The media lookup is abandoned after this long (the shared client has no timeout of its own). */
export const LOOKUP_MS = 60_000;

/** https only, and the host must be a subdomain of one of Instagram's CDN domains. */
export function isAllowedCdn(url: string): boolean {
    let u: URL;
    try {
        u = new URL(url);
    } catch {
        return false;
    }
    if (u.protocol !== 'https:' || u.username || u.password) return false;
    const host = u.hostname.toLowerCase();
    return CDN_SUFFIXES.some((s) => host.endsWith(s) && host.length > s.length);
}

export interface Variant {
    url: string;
    width: number;
    height: number;
    bandwidth: number;
    type: number | null;
    expiresAt: string | null;
}

/** Largest picture first, then highest bandwidth. */
export function pickVariant(versions: any[] | undefined): Variant | null {
    const list = (versions ?? []).filter((v) => typeof v?.url === 'string');
    if (!list.length) return null;
    const score = (v: any) => [Number(v.width ?? 0) * Number(v.height ?? 0), Number(v.bandwidth ?? 0)];
    const best = [...list].sort((a, b) => {
        const [pa, ba] = score(a);
        const [pb, bb] = score(b);
        return pb - pa || bb - ba;
    })[0];
    const us = Number(best.url_expiration_timestamp_us ?? 0);
    return {
        url: best.url,
        width: Number(best.width ?? 0),
        height: Number(best.height ?? 0),
        bandwidth: Number(best.bandwidth ?? 0),
        type: best.type ?? null,
        expiresAt: us > 0 ? new Date(us / 1000).toISOString() : null,
    };
}

export function parseMentions(caption: string): string[] {
    const out = new Set<string>();
    for (const m of caption.matchAll(/(?:^|[^A-Za-z0-9._])@([A-Za-z0-9._]{1,30})/g)) out.add(m[1].replace(/\.+$/, '').toLowerCase());
    out.delete('');
    return [...out];
}

export interface Attribution {
    kind: 'licensed_music' | 'original_audio';
    title: string | null;
    artist: string | null;
    source: string;
}

/**
 * Which audio Instagram credits. This is an attribution, not proof of what is audible.
 * Paths seen in the wild differ by media type, so each one is read defensively.
 */
export function audioAttribution(raw: any): { attribution: Attribution | null; source: string } {
    const music = raw?.clips_metadata?.music_info?.music_asset_info;
    if (music && (music.title || music.display_artist)) {
        return { attribution: { kind: 'licensed_music', title: music.title ?? null, artist: music.display_artist ?? null, source: 'clips_metadata.music_info' }, source: 'clips_metadata.music_info' };
    }
    const orig = raw?.clips_metadata?.original_sound_info;
    if (orig && (orig.original_audio_title || orig.ig_artist)) {
        return { attribution: { kind: 'original_audio', title: orig.original_audio_title ?? null, artist: orig.ig_artist?.username ?? null, source: 'clips_metadata.original_sound_info' }, source: 'clips_metadata.original_sound_info' };
    }
    const story = raw?.music_metadata?.music_info?.music_asset_info;
    if (story && (story.title || story.display_artist)) {
        return { attribution: { kind: 'licensed_music', title: story.title ?? null, artist: story.display_artist ?? null, source: 'music_metadata.music_info' }, source: 'music_metadata.music_info' };
    }
    return { attribution: null, source: 'not_present' };
}

export interface Child {
    index: number;
    kind: 'video' | 'photo';
    durationSec: number | null;
}

export class SelectionError extends Error {
    constructor(
        message: string,
        readonly children: Child[],
    ) {
        super(message);
    }
}

export function listChildren(raw: any): Child[] {
    return (raw?.carousel_media ?? []).map((c: any, i: number) => ({
        index: i + 1,
        kind: c?.media_type === 2 || c?.video_versions?.length ? 'video' : 'photo',
        durationSec: typeof c?.video_duration === 'number' ? Math.round(c.video_duration * 100) / 100 : null,
    }));
}

/** One video per run: a carousel needs --item N (1-based, the order of carousel_media). */
export function selectItem(raw: any, item?: number): { media: any; collection: { pk: string; count: number; item_index: number } | null } {
    const children = listChildren(raw);
    if (!children.length) {
        if (item !== undefined && item !== 1) throw new SelectionError(`This post is a single item; --item ${item} does not exist.`, []);
        return { media: raw, collection: null };
    }
    const describe = children.map((c) => `${c.index}: ${c.kind}${c.durationSec ? ` ${c.durationSec}s` : ''}`).join(', ');
    if (item === undefined) throw new SelectionError(`This post is a carousel with ${children.length} items (${describe}). Pass --item N to choose one video.`, children);
    const c = children[item - 1];
    if (!Number.isInteger(item) || !c) throw new SelectionError(`--item ${item} is out of range (${describe}).`, children);
    if (c.kind !== 'video') throw new SelectionError(`Item ${item} is a photo; only videos are analysed (${describe}).`, children);
    return { media: raw.carousel_media[item - 1], collection: { pk: String(raw.pk ?? raw.id ?? ''), count: children.length, item_index: item } };
}

/** Streams a CDN file to disk without cookies. A redirect, a foreign host or the size cap is an error. */
export async function downloadCdn(url: string, dest: string, maxBytes: number, fetchImpl: typeof fetch = fetch, log?: (m: string) => void): Promise<number> {
    if (!isAllowedCdn(url)) throw new Error(`Refusing to download from a host that is not an Instagram CDN: ${safeHost(url)}`);
    const res = await fetchImpl(url, { redirect: 'manual', credentials: 'omit', headers: { accept: '*/*' } });
    if (res.status === 429) throw new Error('The CDN answered HTTP 429 (rate limited). Stopping; try again later.');
    if (res.status >= 300 && res.status < 400) throw new Error(`The CDN answered with a redirect (HTTP ${res.status}); not following it.`);
    if (!res.ok || !res.body) throw new Error(`The CDN answered HTTP ${res.status} for ${safeHost(url)}. The link may have expired; run fetch again.`);
    const declared = Number(res.headers.get('content-length') ?? 0);
    if (declared > maxBytes) throw new Error(`The file is ${declared} bytes, over the --max-bytes limit of ${maxBytes}.`);
    await mkdir(path.dirname(dest), { recursive: true });
    // Sequential writes through a file handle: each chunk is on disk before the next is read,
    // so memory stays flat and there is no stream state to wait on.
    const handle = await open(dest, 'w');
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    let bytes = 0;
    let lastLog = Date.now();
    try {
        for (;;) {
            // Some runtimes never signal the end of a CDN body, so stop at the declared length
            // and give up when no data arrives for IDLE_MS.
            if (declared > 0 && bytes >= declared) break;
            let timer: ReturnType<typeof setTimeout> | undefined;
            const idle = new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error(`The download stalled: no data for ${IDLE_MS / 1000} s after ${bytes} bytes.`)), IDLE_MS);
            });
            let step: { done: boolean; value?: Uint8Array };
            try {
                step = await Promise.race([reader.read(), idle]);
            } finally {
                clearTimeout(timer);
            }
            if (step.done || !step.value) break;
            bytes += step.value.length;
            if (bytes > maxBytes) throw new Error(`The download passed the --max-bytes limit of ${maxBytes}.`);
            await handle.write(step.value);
            if (log && Date.now() - lastLog > 10_000) {
                lastLog = Date.now();
                log(`[breakdown] downloading: ${(bytes / 1048576).toFixed(1)} MB${declared ? ` of ${(declared / 1048576).toFixed(1)}` : ''}`);
            }
        }
        if (declared > 0 && bytes < declared) throw new Error(`The download ended early: ${bytes} of ${declared} bytes.`);
        await handle.close();
        void reader.cancel().catch(() => {});
    } catch (e) {
        void reader.cancel().catch(() => {});
        await handle.close().catch(() => {});
        await rm(dest, { force: true });
        throw e;
    }
    if (bytes === 0) {
        await rm(dest, { force: true });
        throw new Error('The CDN returned an empty file.');
    }
    return bytes;
}

function safeHost(url: string): string {
    try {
        return new URL(url).hostname;
    } catch {
        return 'an invalid URL';
    }
}

export interface Meta {
    schema: 'ig.breakdown.source.v1';
    origin: 'instagram' | 'local_file';
    fetched_at: string;
    ref: string | null;
    url: string | null;
    owner: string | null;
    shortcode: string | null;
    product_type: string | null;
    caption: string;
    hashtags: string[];
    mentions: string[];
    metrics: { likes: number | null; comments: number | null; plays: number | null; views: number | null };
    duration_sec: number | null;
    has_audio: boolean | null;
    taken_at: string | null;
    audio_attribution: Attribution | null;
    attribution_source: string;
    collection: { pk: string; count: number; item_index: number } | null;
    video: { file: string; bytes: number; width: number | null; height: number | null; cdn_host: string | null; url_expires_at: string | null };
    cover: string | null;
}

/** Builds meta.json from a raw media item. Pure, so payload fixtures can test it. */
export function buildMeta(raw: any, post: any, ref: string, item?: number): { meta: Omit<Meta, 'video' | 'cover' | 'fetched_at'>; variant: Variant; coverUrl: string | null } {
    const { media, collection } = selectItem(raw, item);
    const variant = pickVariant(media?.video_versions);
    if (!variant) throw new Error('This post has no video to analyse (it is a photo, or Instagram returned no video variants).');
    const caption = String(post?.caption ?? raw?.caption?.text ?? '');
    const att = audioAttribution(raw);
    const covers = (media?.image_versions2?.candidates ?? []).filter((c: any) => typeof c?.url === 'string');
    const cover = covers.sort((a: any, b: any) => Number(b.width ?? 0) - Number(a.width ?? 0))[0]?.url ?? null;
    return {
        variant,
        coverUrl: cover,
        meta: {
            schema: 'ig.breakdown.source.v1',
            origin: 'instagram',
            ref,
            url: post?.url ?? null,
            owner: post?.owner ?? raw?.user?.username ?? null,
            shortcode: post?.shortcode ?? raw?.code ?? null,
            product_type: raw?.product_type ?? null,
            caption,
            hashtags: post?.hashtags ?? [],
            mentions: parseMentions(caption),
            metrics: { likes: post?.likes ?? null, comments: post?.comments ?? null, plays: post?.plays ?? null, views: post?.views ?? null },
            duration_sec: typeof media?.video_duration === 'number' ? Math.round(media.video_duration * 1000) / 1000 : (post?.durationSec ?? null),
            has_audio: typeof media?.has_audio === 'boolean' ? media.has_audio : null,
            taken_at: post?.takenAt ?? null,
            audio_attribution: att.attribution,
            attribution_source: att.source,
            collection,
        },
    };
}

export async function fetchFromInstagram(ref: string, outDir: string, options: { item?: number; maxBytes?: number; log?: (m: string) => void }): Promise<Meta> {
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    const { IgClient, getMedia } = await loadInstagramSkill();
    const client = await IgClient.create({ log: options.log });
    let raw: any;
    let post: any;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        const timeout = new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`Instagram did not answer the media lookup within ${LOOKUP_MS / 1000} s. This usually means the session is being slowed down; stop and try again later.`)), LOOKUP_MS);
        });
        ({ raw, post } = await Promise.race([getMedia(client, ref), timeout]));
    } finally {
        clearTimeout(timer);
        await client.flush();
    }
    const built = buildMeta(raw, post, ref, options.item);
    const src = path.join(outDir, 'source');
    await mkdir(src, { recursive: true });
    options.log?.('[breakdown] downloading the video (Instagram serves it at about playback speed, so allow roughly its duration)');
    const bytes = await downloadCdn(built.variant.url, path.join(src, 'video.mp4'), maxBytes, fetch, options.log);
    let cover: string | null = null;
    if (built.coverUrl && isAllowedCdn(built.coverUrl)) {
        try {
            await downloadCdn(built.coverUrl, path.join(src, 'cover.jpg'), 20 * 1024 * 1024);
            cover = 'source/cover.jpg';
        } catch (e) {
            options.log?.(`[breakdown] cover not saved: ${(e as Error).message}`);
        }
    }
    const meta: Meta = {
        ...built.meta,
        fetched_at: new Date().toISOString(),
        video: { file: 'source/video.mp4', bytes, width: built.variant.width || null, height: built.variant.height || null, cdn_host: safeHost(built.variant.url), url_expires_at: built.variant.expiresAt },
        cover,
    };
    await writeFile(path.join(src, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`);
    return meta;
}

export async function fetchFromFile(file: string, outDir: string): Promise<Meta> {
    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) throw new Error(`${file} is not a file.`);
    const src = path.join(outDir, 'source');
    await mkdir(src, { recursive: true });
    const dest = path.join(src, 'video.mp4');
    if (path.resolve(file) !== path.resolve(dest)) await copyFile(file, dest);
    const meta: Meta = {
        schema: 'ig.breakdown.source.v1', origin: 'local_file', fetched_at: new Date().toISOString(), ref: path.basename(file), url: null, owner: null, shortcode: null,
        product_type: null, caption: '', hashtags: [], mentions: [], metrics: { likes: null, comments: null, plays: null, views: null }, duration_sec: null,
        has_audio: null, taken_at: null, audio_attribution: null, attribution_source: 'local_file', collection: null,
        video: { file: 'source/video.mp4', bytes: info.size, width: null, height: null, cdn_host: null, url_expires_at: null }, cover: null,
    };
    await writeFile(path.join(src, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`);
    return meta;
}
