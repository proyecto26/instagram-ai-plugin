import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { LIMITS, pkToShortcode, postUrl } from './constants.ts';
import { IgClient, IgError, logAction } from './client.ts';
import { E } from './endpoints.ts';
import { GraphQL } from './graphql.ts';
import { extractCover, inspectMedia, toJpeg } from './media.ts';
import { hashtagsOf } from './normalize.ts';
import { acquirePublishLock, beginPending, clearPending, listPending, markUnresolved, type PendingOp } from './pending.ts';
import { getPosts, toMediaPk } from './read.ts';
import type { MediaFacts } from './types.ts';

/**
 * Write contracts. Status says how much evidence backs each one:
 *   observed-in-bundle  endpoint + field names read from the live web client (2026-11-03)
 *   unverified          long-standing web contract, not yet confirmed by a live post
 *   verified-live       confirmed by test/live.test.ts on a real account
 * Update the status here when a live test passes.
 */
export type ContractStatus = 'verified-live' | 'observed-in-bundle' | 'unverified';

/** Every write needs --experimental until its own live test passes and it is marked verified-live. */
export const CONTRACTS: Record<'photo' | 'carousel' | 'reel' | 'reelExtras' | 'reelCollab' | 'story' | 'storyAiLabel' | 'storyMention' | 'editCaption' | 'comment', ContractStatus> = {
    photo: 'verified-live', // 2026-11-04, 1080x1350 with alt text
    carousel: 'verified-live', // 2026-11-04, 5 slides
    // 2026-11-04: a plain-form reel was verified live. On 2026-11-12 that form got HTTP 200 with an
    // empty body twice, and the web composer was captured using the comet async request instead. The plugin now
    // sends that shape. Verified live 2026-11-13: 4 s reel with --no-feed, one "still processing" answer, then
    // the media. Tags, collaborators and the AI label are a separate contract (reelExtras).
    reel: 'verified-live',
    story: 'verified-live', // 2026-11-04, photo and video (rupload_igvideo + cover + configure_to_story)
    // Read from the live web client's request builder on 2026-11-12 (module "polarisConfigureToClips..." next to
    // XPolarisIGXAPIMediaPublishClipsControllerRouteBuilder): usertags = JSON {in:[{user_id}]},
    // invite_coauthor_user_ids_string = JSON [ids], is_gen_ai_self_disclosure = true with
    // gen_ai_detection_method = "SELF_DISCLOSURE_FLOW". Not yet confirmed by a live post.
    // Verified live 2026-11-13: one tag and the AI label, both present in the read-back
    // (usertags kept; ai_label_info.gen_ai_detection_method = SELF_DISCLOSURE_FLOW).
    reelExtras: 'verified-live',
    // Collaborator invites: same builder, never sent live.
    reelCollab: 'observed-in-bundle',
    // PolarisAPICreationFinalizeStory sends gen_ai_detection_method = "SELF_DISCLOSURE_FLOW" (same date). The web
    // story composer sends NO mention field at all.
    storyAiLabel: 'observed-in-bundle',
    // Tried live 2026-11-13 (one story, one mention): the story was posted, but neither the
    // read-back nor the story page showed a mention. Treat as NOT working until a capture shows the real field.
    // reel_mentions is the field the web client READS on a story (seen in the live bundle, 2026-11-12); sending it
    // on configure_to_story is the long-standing private-API contract, not yet confirmed by a live post here.
    storyMention: 'unverified',
    editCaption: 'observed-in-bundle',
    comment: 'verified-live', // 2026-11-04, comment + threaded reply via GraphQL PolarisPostCommentInputRevampedMutation (/api/graphql)
};
export type ContractName = keyof typeof CONTRACTS;

// ---------------------------------------------------------------- validation

export interface Check {
    errors: string[];
    warnings: string[];
}

export function checkCaption(caption: string, maxHashtags: number = LIMITS.hashtagsMax): Check {
    const c: Check = { errors: [], warnings: [] };
    const chars = [...caption].length;
    if (chars > LIMITS.captionChars) c.errors.push(`Caption is ${chars} chars; Instagram allows ${LIMITS.captionChars}.`);
    const tags = hashtagsOf(caption);
    if (tags.length > maxHashtags) c.errors.push(`${tags.length} hashtags; the limit is ${maxHashtags} (override with --max-hashtags only if Instagram allows more for you).`);
    const mentions = new Set([...caption.matchAll(/@([A-Za-z0-9._]{1,30})/g)].map((m) => m[1].toLowerCase()));
    if (mentions.size > LIMITS.mentionsHard) c.errors.push(`${mentions.size} @mentions; Instagram allows ${LIMITS.mentionsHard}.`);
    const firstLine = caption.split('\n')[0] ?? '';
    if ([...firstLine].length > 125) c.warnings.push('First line is longer than the ~125 chars shown before "more".');
    if (/https?:\/\//i.test(caption)) c.warnings.push('Links in captions are not clickable on Instagram.');
    return c;
}

function checkFeedImage(f: MediaFacts, label: string, c: Check): void {
    const ratio = f.width / f.height;
    if (ratio < LIMITS.feedAspectMin - 0.01 || ratio > LIMITS.feedAspectMax + 0.01) {
        c.errors.push(`${label}: aspect ${ratio.toFixed(3)} (${f.width}x${f.height}) is outside 4:5..1.91:1. Crop it first.`);
    }
    if (f.width < 320) c.warnings.push(`${label}: ${f.width}px wide; Instagram upsizes below 320px and it will look soft.`);
    if (f.bytes > LIMITS.photoMaxBytes) c.errors.push(`${label}: ${(f.bytes / 1e6).toFixed(1)} MB is over the 8 MB photo limit.`);
}

function checkVideo(f: MediaFacts, label: string, c: Check, opts: { minS: number; maxS: number; vertical?: boolean }): void {
    const s = (f.durationMs ?? 0) / 1000;
    if (!f.durationMs) c.warnings.push(`${label}: could not read the duration from the container.`);
    else if (s < opts.minS || s > opts.maxS) c.errors.push(`${label}: ${s.toFixed(1)}s is outside ${opts.minS}s..${opts.maxS}s.`);
    if (f.codec && !['avc1', 'avc3', 'hvc1', 'hev1'].includes(f.codec)) c.errors.push(`${label}: codec ${f.codec} is not H.264/HEVC. Re-encode: ffmpeg -i in -c:v libx264 -c:a aac out.mp4`);
    if (opts.vertical && Math.abs(f.width / f.height - 9 / 16) > 0.02) c.warnings.push(`${label}: ${f.width}x${f.height} is not 9:16; Instagram will letterbox or crop it.`);
    if (f.bytes > LIMITS.videoMaxBytes) c.errors.push(`${label}: file is over 1 GB.`);
}

// ---------------------------------------------------------------- plans

export interface UploadItem {
    label: string;
    file: string;
    facts: MediaFacts;
    uploadId: string;
    /** Only for video: JPEG cover uploaded under the same upload_id. */
    cover?: { file: string; width: number; height: number } | null;
}

export interface PublishPlan {
    kind: 'photo' | 'carousel' | 'reel' | 'story';
    contract: string;
    caption: string;
    items: UploadItem[];
    configure: { url: string; encoding: 'form' | 'json'; body: Record<string, unknown> };
    check: Check;
}

let lastUploadId = 0;
/** Instagram upload ids are millisecond timestamps; keep them strictly increasing. */
export function newUploadId(): string {
    const now = Date.now();
    lastUploadId = now > lastUploadId ? now : lastUploadId + 1;
    return String(lastUploadId);
}

export function entityName(uploadId: string): string {
    return `fb_uploader_${uploadId}`;
}

export function photoRuploadParams(uploadId: string, f: { width: number; height: number }, opts?: { sidecar?: boolean; videoCover?: boolean }): Record<string, unknown> {
    return {
        media_type: opts?.videoCover ? 2 : 1,
        upload_id: uploadId,
        upload_media_height: f.height,
        upload_media_width: f.width,
        ...(opts?.sidecar ? { is_sidecar: '1' } : {}),
    };
}

export function videoRuploadParams(uploadId: string, f: MediaFacts, opts: { clips?: boolean; sidecar?: boolean }): Record<string, unknown> {
    return {
        'client-passthrough': '1',
        is_clips_video: opts.clips ? '1' : '0',
        is_sidecar: opts.sidecar ? '1' : '0',
        is_unified_video: '0',
        media_type: 2,
        for_album: false,
        video_format: '',
        upload_id: uploadId,
        upload_media_duration_ms: f.durationMs ?? 0,
        upload_media_height: f.height,
        upload_media_width: f.width,
        video_transform: null,
        extract_cover_frame: '1',
    };
}

const COMMON_CONFIGURE = {
    source_type: 'library',
    disable_comments: '0',
    like_and_view_counts_disabled: '0',
    igtv_share_preview_to_feed: '1',
    is_unified_video: '1',
    video_subtitles_enabled: '0',
    is_meta_only_post: '0',
    media_share_flow: 'creation_flow',
    share_to_threads: 'false',
};

export interface PostOptions {
    caption?: string;
    altText?: string;
    disableComments?: boolean;
    hideLikes?: boolean;
    maxHashtags?: number;
    /** Reels: also show in the profile grid (default true). */
    shareToFeed?: boolean;
    cover?: string;
    coverAt?: number;
    /** Reels: people tagged in the video (no position for video). */
    tags?: UserRef[];
    /** Reels: accounts invited as collaborators (they must accept). */
    collaborators?: UserRef[];
    /** Reels and stories: Instagram's "AI-generated" self-disclosure label. */
    aiLabel?: boolean;
}

export interface UserRef {
    username: string;
    /** Numeric user id (pk). */
    userId: string;
}

export const REEL_TAGS_MAX = 20;
export const REEL_COLLABORATORS_MAX = 5;

/** Fields the web client adds to configure_to_clips for tags, collaborators and the AI label. */
export function reelExtraFields(o: Pick<PostOptions, 'tags' | 'collaborators' | 'aiLabel'>): Record<string, string | boolean> {
    const uniq = (list: UserRef[] | undefined) => {
        const seen = new Set<string>();
        return (list ?? []).filter((u) => (seen.has(u.userId) ? false : (seen.add(u.userId), true)));
    };
    const tags = uniq(o.tags);
    const collabs = uniq(o.collaborators);
    return {
        ...(tags.length ? { usertags: JSON.stringify({ in: tags.map((u) => ({ user_id: u.userId })) }) } : {}),
        ...(collabs.length ? { invite_coauthor_user_ids_string: JSON.stringify(collabs.map((u) => u.userId)) } : {}),
        ...(o.aiLabel ? { is_gen_ai_self_disclosure: true, gen_ai_detection_method: 'SELF_DISCLOSURE_FLOW' } : {}),
    };
}

export function checkReelExtras(o: Pick<PostOptions, 'tags' | 'collaborators' | 'aiLabel'>, check: Check): void {
    const tags = o.tags ?? [];
    const collabs = o.collaborators ?? [];
    if (tags.length > REEL_TAGS_MAX) check.errors.push(`${tags.length} tagged accounts; at most ${REEL_TAGS_MAX} are sent.`);
    if (collabs.length > REEL_COLLABORATORS_MAX) check.errors.push(`${collabs.length} collaborators; at most ${REEL_COLLABORATORS_MAX} are sent.`);
    for (const u of [...tags, ...collabs]) if (!/^\d+$/.test(u.userId)) check.errors.push(`@${u.username}: user id "${u.userId}" is not numeric.`);
    if (tags.length) check.warnings.push(`Tags ${tags.map((u) => '@' + u.username).join(', ')}: each account is notified and the reel can appear in its tagged tab.`);
    if (collabs.length) check.warnings.push(`Collaborator invites to ${collabs.map((u) => '@' + u.username).join(', ')}: each account is notified and must accept.`);
    if (collabs.length) check.warnings.push('Collaborator invites use a field read from the web client but never confirmed by a live post.');
    if (tags.length || collabs.length || o.aiLabel) check.warnings.push('After posting, the command reads the reel back and reports which tags, invites and label Instagram kept.');
}

/** Parses a comma-separated handle list for --tag / --collab. Empty or invalid input is an error. */
export function parseHandleList(flag: string, value: string | true | undefined, max: number): string[] {
    if (value === undefined) return [];
    const parts = value === true ? [] : String(value).split(',').map((n) => n.trim().replace(/^@/, '').toLowerCase());
    const names = [...new Set(parts.filter(Boolean))];
    if (!names.length || parts.some((p) => !p)) throw new Error(`--${flag} needs one or more usernames separated by commas, for example --${flag} user1,user2.`);
    for (const n of names) if (!/^[a-z0-9._]{1,30}$/.test(n)) throw new Error(`"${n}" is not a valid Instagram username.`);
    if (names.length > max) throw new Error(`${names.length} accounts for --${flag}; at most ${max} are sent.`);
    return names;
}

/** Canonical "name=id,name=id" string for a recipient list, sorted. */
export function recipientsKey(list: UserRef[]): string {
    const seen = new Map<string, string>();
    for (const u of list) seen.set(u.username.toLowerCase(), u.userId);
    return [...seen.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([n, id]) => `${n}=${id}`).join(',');
}

export interface ApprovalSubject {
    account: string;
    kind: string;
    files: Array<{ name: string; bytes: number }>;
    caption: string;
    aiLabel: boolean;
    /** Recipients by role, e.g. { tag: [...], collab: [...], mention: [...] }. */
    roles: Record<string, UserRef[]>;
    /** sha256 of every uploaded file and cover plus the publish fields (see planDigest). */
    digest?: string;
}

/** sha256 over the bytes of each media file and cover and the publish fields, leaving out the generated upload ids. */
export async function planDigest(plan: PublishPlan): Promise<string> {
    const h = new Bun.CryptoHasher('sha256');
    for (const it of plan.items) {
        h.update(new Uint8Array(await Bun.file(it.file).arrayBuffer()));
        if (it.cover) h.update(new Uint8Array(await Bun.file(it.cover.file).arrayBuffer()));
        h.update('|');
    }
    const ids = new Set(plan.items.map((i) => i.uploadId));
    const strip = (v: unknown): unknown => (typeof v === 'string' && ids.has(v) ? '<upload_id>' : Array.isArray(v) ? v.map(strip) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v as object).map(([k, x]) => [k, strip(x)])) : v);
    h.update(JSON.stringify([plan.kind, plan.configure.url, strip(plan.configure.body)]));
    return h.digest('hex');
}

/**
 * The string the user approves: recipients with their role, plus a short hash of everything else that
 * was reviewed (account, post kind, files, caption, AI label). Any change gives a different string.
 */
export function approvalKey(s: ApprovalSubject): string {
    const roles = Object.entries(s.roles).filter(([, l]) => l.length).sort((a, b) => a[0].localeCompare(b[0])).map(([r, l]) => `${r}:${recipientsKey(l)}`).join(';');
    const rest = JSON.stringify([s.account.replace(/^@/, '').toLowerCase(), s.kind, s.files.map((x) => [x.name, x.bytes]), s.caption, s.aiLabel, s.digest ?? '']);
    const hash = new Bun.CryptoHasher('sha256').update(rest).digest('hex').slice(0, 10);
    return `${roles}#${hash}`;
}

export type AiLabelOutcome = 'confirmed' | 'not_observed' | 'unknown';

/**
 * Reads the AI-label state from a media object. "confirmed" only when the detection-method property itself says
 * self-disclosure; an empty value right after posting is "not_observed" (it may appear later), not proof of absence.
 */
export function aiLabelReadBack(raw: any): { outcome: AiLabelOutcome; observed: Record<string, unknown> } {
    const observed: Record<string, unknown> = {};
    if (raw && typeof raw === 'object') for (const k of ['ai_label_info', 'gen_ai_detection_method']) if (k in raw) observed[k] = raw[k];
    if (!Object.keys(observed).length) return { outcome: 'unknown', observed };
    const methods = [raw.gen_ai_detection_method, raw.ai_label_info?.gen_ai_detection_method].filter((m) => typeof m === 'string') as string[];
    if (methods.some((m) => /^self_disclosure(_flow)?$/i.test(m))) return { outcome: 'confirmed', observed };
    const empty = Object.values(observed).every((v) => v === null || v === undefined || v === '' || (typeof v === 'object' && !Object.keys(v as object).length));
    return { outcome: empty ? 'not_observed' : 'unknown', observed };
}

/**
 * What a configure answer means, following the web client (PolarisCreationAPI): a media object, or a completed
 * entry in medias[] carrying media_dict, is success; ERROR entries are failures; PENDING entries mean accepted
 * but not finished.
 */
/** A media id as Instagram writes it: digits (optionally "<pk>_<owner>"), not zero. Anything else is not an id. */
export function mediaPk(media: any): string {
    // pk first, then id ("<pk>_<owner>"): a numeric pk too large to be exact is skipped in favour of the id string.
    for (const raw of [media?.pk, media?.id]) {
        if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0) return String(raw);
        if (typeof raw !== 'string') continue;
        const m = /^(\d{1,25})(_\d+)?$/.exec(raw);
        if (m && !/^0+$/.test(m[1])) return m[1];
    }
    return '';
}

export function readConfigureAnswer(res: any): { media: any | null; state: 'done' | 'pending' | 'error' | 'empty' } {
    const is = (v: unknown, s: string) => typeof v === 'string' && v.toLowerCase() === s.toLowerCase();
    const lists = [res?.medias, res?.posts].filter(Array.isArray) as any[][];
    const has = (s: string) => lists.some((l) => l.some((e) => is(e?.status, s)));
    let media = res?.media && typeof res.media === 'object' ? res.media : null;
    if (!media && Array.isArray(res?.medias)) media = res.medias.find((e: any) => (is(e?.status, 'COMPLETED') || is(e?.status, 'SUCCESS') || is(e?.status, 'ok')) && e?.media_dict)?.media_dict ?? null;
    if (!media && res && (res.pk || res.id)) media = res;
    // An explicit failure wins over anything else in the same answer.
    if (has('ERROR') || is(res?.status, 'fail')) return { media: null, state: 'error' };
    if (media && mediaPk(media)) return { media, state: 'done' };
    if (has('PENDING')) return { media: null, state: 'pending' };
    return { media: null, state: 'empty' };
}

/** Errors after which no further Instagram request may be made in this run. */
export function isAccountSignal(e: unknown): boolean {
    return e instanceof IgError && ['rate_limited', 'checkpoint', 'feedback_required', 'not_logged_in'].includes(e.kind);
}

/** Flags that only some post kinds support. Asking for one elsewhere must fail, never post without it. */
export function unsupportedFlags(kind: string, flags: Record<string, unknown>): string[] {
    const allowed: Record<string, string[]> = { reel: ['tag', 'collab', 'ai-label', 'user-id', 'approve'], story: ['mention', 'ai-label', 'user-id', 'approve'], photo: [], carousel: [] };
    const all = ['tag', 'collab', 'mention', 'ai-label', 'user-id', 'approve'];
    return all.filter((k) => flags[k] !== undefined && flags[k] !== false && !(allowed[kind] ?? []).includes(k));
}

export interface ExtrasReadBack {
    tags?: { outcome: MentionOutcome; requested: string[]; kept: string[] };
    collaborators?: { outcome: MentionOutcome; requested: string[]; kept: string[] };
    aiLabel?: { outcome: AiLabelOutcome; observed: Record<string, unknown> };
    /** Collaborators Instagram lists as invited (not yet accepted) and as accepted; null when that list was not in the read. */
    collaboratorLists?: { invited: string[] | null; accepted: string[] | null };
    note: string;
}

/** What the posted reel's metadata says about the requested tags, collaborators and AI label. */
export function reelExtrasReadBack(o: Pick<PostOptions, 'tags' | 'collaborators' | 'aiLabel'>, raw: any): ExtrasReadBack {
    const out: ExtrasReadBack = { note: 'The reel is posted. This is what one metadata read shows right after posting: "confirmed" means the field is present there, not that people were notified, that an invited collaborator accepted, or how the label is displayed. "unknown" means this read did not include the field. Fix anything missing by editing the reel in the app; do not post again.' };
    const compare = (requested: UserRef[], ids: string[] | null) => {
        const names = requested.map((u) => '@' + u.username);
        if (ids === null) return { outcome: 'unknown' as MentionOutcome, requested: names, kept: [] };
        const kept = requested.filter((u) => ids.includes(u.userId)).map((u) => '@' + u.username);
        return { outcome: (kept.length === requested.length ? 'confirmed' : kept.length ? 'partial' : 'not_kept') as MentionOutcome, requested: names, kept };
    };
    if (o.tags?.length) {
        const list = raw?.usertags?.in;
        out.tags = compare(o.tags, Array.isArray(list) ? list.map((t: any) => String(t?.user?.pk ?? t?.user?.id ?? t?.user_id ?? '')) : null);
    }
    if (o.collaborators?.length) {
        const a = raw?.coauthor_producers;
        const b = raw?.invited_coauthor_producers;
        const ids = Array.isArray(a) || Array.isArray(b) ? [...(a ?? []), ...(b ?? [])].map((u: any) => String(u?.pk ?? u?.id ?? '')) : null;
        // invited_coauthor_producers = invited, not yet accepted; coauthor_producers = accepted.
        out.collaborators = compare(o.collaborators, ids);
        const names = (l: unknown) => (Array.isArray(l) ? o.collaborators!.filter((u) => l.some((x: any) => String(x?.pk ?? x?.id ?? '') === u.userId)).map((u) => '@' + u.username) : null);
        out.collaboratorLists = { invited: names(b), accepted: names(a) };
    }
    if (o.aiLabel) out.aiLabel = aiLabelReadBack(raw);
    return out;
}

function flags(o: PostOptions): Record<string, string> {
    return {
        ...COMMON_CONFIGURE,
        disable_comments: o.disableComments ? '1' : '0',
        like_and_view_counts_disabled: o.hideLikes ? '1' : '0',
        ...(o.altText ? { custom_accessibility_caption: o.altText } : {}),
    };
}

async function asJpeg(file: string): Promise<{ file: string; facts: MediaFacts }> {
    const facts = await inspectMedia(file);
    if (facts.kind !== 'photo') throw new IgError('validation', `${file} is a video; expected an image.`);
    if (facts.mime === 'image/jpeg') return { file: facts.path, facts };
    const converted = await toJpeg(facts.path);
    return { file: converted, facts: await inspectMedia(converted) };
}

export async function planPhoto(file: string, o: PostOptions): Promise<PublishPlan> {
    const caption = o.caption ?? '';
    const check = checkCaption(caption, o.maxHashtags);
    const { file: jpg, facts } = await asJpeg(file);
    checkFeedImage(facts, path.basename(file), check);
    const uploadId = newUploadId();
    return {
        kind: 'photo',
        contract: CONTRACTS.photo,
        caption,
        items: [{ label: path.basename(file), file: jpg, facts, uploadId }],
        configure: { url: E.configurePhoto, encoding: 'form', body: { ...flags(o), caption, upload_id: uploadId } },
        check,
    };
}

export async function planCarousel(files: string[], o: PostOptions): Promise<PublishPlan> {
    const caption = o.caption ?? '';
    const check = checkCaption(caption, o.maxHashtags);
    if (files.length < LIMITS.carouselMin || files.length > LIMITS.carouselMax) {
        check.errors.push(`A carousel needs ${LIMITS.carouselMin}-${LIMITS.carouselMax} items; got ${files.length}.`);
    }
    const items: UploadItem[] = [];
    for (const f of files) {
        const facts = await inspectMedia(f);
        const label = path.basename(f);
        if (facts.kind === 'photo') {
            const j = await asJpeg(f);
            checkFeedImage(j.facts, label, check);
            items.push({ label, file: j.file, facts: j.facts, uploadId: newUploadId() });
        } else {
            checkVideo(facts, label, check, { minS: 3, maxS: 60 });
            const cover = await extractCover(facts.path);
            const coverFacts = cover ? await inspectMedia(cover) : null;
            items.push({ label, file: facts.path, facts, uploadId: newUploadId(), cover: cover && coverFacts ? { file: cover, width: coverFacts.width, height: coverFacts.height } : null });
        }
    }
    if (items.length > 1) {
        const r0 = items[0].facts.width / items[0].facts.height;
        if (items.some((it) => Math.abs(it.facts.width / it.facts.height - r0) > 0.02)) {
            check.warnings.push('Items have different aspect ratios; Instagram crops every slide to the first one.');
        }
    }
    return {
        kind: 'carousel',
        contract: CONTRACTS.carousel,
        caption,
        items,
        configure: {
            url: E.configureSidecar,
            encoding: 'json',
            body: {
                archive_only: false,
                caption,
                children_metadata: items.map((it) => ({ upload_id: it.uploadId })),
                client_sidecar_id: newUploadId(),
                disable_comments: o.disableComments ? '1' : '0',
                like_and_view_counts_disabled: Boolean(o.hideLikes),
                source_type: 'library',
            },
        },
        check,
    };
}

export async function planReel(video: string, o: PostOptions): Promise<PublishPlan> {
    const caption = o.caption ?? '';
    const check = checkCaption(caption, o.maxHashtags);
    const facts = await inspectMedia(video);
    if (facts.kind !== 'video') throw new IgError('validation', `${video} is not a video.`);
    checkVideo(facts, path.basename(video), check, { minS: LIMITS.reelMinSeconds, maxS: LIMITS.reelMaxSeconds, vertical: true });
    let cover: UploadItem['cover'] = null;
    if (o.cover) {
        const j = await asJpeg(o.cover);
        cover = { file: j.file, width: j.facts.width, height: j.facts.height };
    } else {
        const c = await extractCover(facts.path, o.coverAt ?? 0);
        if (c) {
            const cf = await inspectMedia(c);
            cover = { file: c, width: cf.width, height: cf.height };
        } else {
            check.warnings.push('No --cover and no ffmpeg: Instagram will pick the cover frame (extract_cover_frame=1).');
        }
    }
    checkReelExtras(o, check);
    const uploadId = newUploadId();
    return {
        kind: 'reel',
        contract: o.collaborators?.length ? CONTRACTS.reelCollab : o.tags?.length || o.aiLabel ? CONTRACTS.reelExtras : CONTRACTS.reel,
        caption,
        items: [{ label: path.basename(video), file: facts.path, facts, uploadId, cover }],
        configure: {
            url: E.configureClips,
            encoding: 'form',
            body: {
                ...flags(o),
                caption,
                upload_id: uploadId,
                clips_share_preview_to_feed: o.shareToFeed === false ? '0' : '1',
                archive_only: 'false',
                disable_oa_reuse: 'false',
                ...reelExtraFields(o),
            },
        },
        check,
    };
}

/**
 * A photo or video story. Video follows the web client's story flow
 * (PolarisStoryCreation): rupload_igvideo with the upload id, the cover frame
 * as rupload_igphoto with the same id, then configure_to_story.
 */
export interface StoryMention {
    username: string;
    /** Numeric user id (pk). */
    userId: string;
}

/** Where the tappable mention area sits, as fractions of the story (centre x/y, width, height). */
export interface MentionArea {
    x: number;
    y: number;
    width: number;
    height: number;
}

/**
 * A mention on a story is a tap area bound to a user id; nothing is drawn by Instagram. With
 * no username burned into the picture the mention is invisible, like the app's "Mention" tool:
 * the person is notified and can reshare, viewers see no handle. The default area is a thin
 * strip at the bottom centre so it does not swallow taps on the rest of the story.
 */
export const DEFAULT_MENTION_AREA: MentionArea = { x: 0.5, y: 0.93, width: 0.4, height: 0.05 };
export const STORY_MENTIONS_MAX = 10;

/** Splits a --mention value into handles. Throws on an empty value or an invalid handle, so a typo can never turn into an ordinary story. */
export function parseMentionList(value: string | true | undefined): string[] {
    if (value === undefined) return [];
    const parts = value === true ? [] : String(value).split(',').map((n) => n.trim().replace(/^@/, '').toLowerCase());
    const names = [...new Set(parts.filter(Boolean))];
    if (!names.length || parts.some((p) => !p)) throw new Error('--mention needs one or more usernames separated by commas, for example --mention user1,user2.');
    for (const n of names) if (!/^[a-z0-9._]{1,30}$/.test(n)) throw new Error(`"${n}" is not a valid Instagram username.`);
    if (names.length > STORY_MENTIONS_MAX) throw new Error(`${names.length} mentions; at most ${STORY_MENTIONS_MAX} are sent.`);
    return names;
}

export type MentionOutcome = 'confirmed' | 'partial' | 'not_kept' | 'unknown';

/** What the story's metadata says about the requested mentions, right after posting. */
export function mentionReadBack(requested: StoryMention[], raw: any): { outcome: MentionOutcome; requested: string[]; kept: string[]; note: string } {
    const names = requested.map((x) => '@' + x.username);
    const list = raw?.reel_mentions;
    if (!Array.isArray(list)) {
        return { outcome: 'unknown', requested: names, kept: [], note: 'The story was posted. Its metadata did not include a reel_mentions field on this read, which can be a delay or an endpoint that omits it: check the story in the app. Do not post again to retry the mention.' };
    }
    const keptIds = new Set<string>(list.map((r: any) => String(r?.user?.pk ?? r?.user?.id ?? r?.user_id ?? '')));
    const kept = requested.filter((x) => keptIds.has(x.userId)).map((x) => '@' + x.username);
    const outcome: MentionOutcome = kept.length === requested.length ? 'confirmed' : kept.length ? 'partial' : 'not_kept';
    const note = outcome === 'confirmed' ? 'Instagram stored every requested mention. Whether the people were notified and the mention is invisible to viewers still has to be checked in the app.'
        : 'The story was posted, but Instagram did not store ' + (outcome === 'partial' ? 'all' : 'any') + ' of the requested mentions. Add them in the app or delete the story there; do not post again to retry.';
    return { outcome, requested: names, kept, note };
}

export function storyMentionFields(mentions: StoryMention[], area: MentionArea = DEFAULT_MENTION_AREA): Record<string, string> {
    if (!mentions.length) return {};
    const seen = new Set<string>();
    const list = mentions
        .filter((m) => (seen.has(m.userId) ? false : (seen.add(m.userId), true)))
        .map((m, i) => ({
            x: area.x,
            // Several mentions are stacked upwards so their areas do not overlap.
            y: Math.max(0.05, area.y - i * (area.height + 0.01)),
            z: 0,
            width: area.width,
            height: area.height,
            rotation: 0,
            type: 'mention',
            user_id: m.userId,
            is_sticker: false,
            display_type: 'mention_username',
        }));
    const json = JSON.stringify(list);
    return { reel_mentions: json, tap_models: json };
}

export function checkStoryMentions(mentions: StoryMention[], area: MentionArea, check: Check): void {
    if (mentions.length > STORY_MENTIONS_MAX) check.errors.push(`${mentions.length} story mentions; at most ${STORY_MENTIONS_MAX} are sent.`);
    for (const m of mentions) if (!/^\d+$/.test(m.userId)) check.errors.push(`@${m.username}: user id "${m.userId}" is not numeric.`);
    for (const [k, v] of Object.entries(area)) if (!(v >= 0 && v <= 1)) check.errors.push(`Mention area ${k}=${v} must be between 0 and 1.`);
    if (!(area.width > 0 && area.height > 0)) check.errors.push('Mention area width and height must be greater than 0.');
    if (area.x - area.width / 2 < 0 || area.x + area.width / 2 > 1 || area.y - area.height / 2 < 0 || area.y + area.height / 2 > 1) check.errors.push('The mention area must lie inside the story.');
    if (mentions.length) {
        check.warnings.push(`Mentions ${mentions.map((m) => '@' + m.username).join(', ')}: each of these people is expected to be notified.`);
        check.warnings.push('No handle is drawn by this command, so the mention is meant to be invisible, but that, the notification and resharing are NOT verified: the fields sent are an unconfirmed contract. After posting, the command reads the story back and reports which mentions Instagram kept.');
    }
}

export async function planStory(file: string, o: Pick<PostOptions, 'cover' | 'coverAt' | 'aiLabel'> & { mentions?: StoryMention[]; mentionArea?: MentionArea } = {}): Promise<PublishPlan> {
    const check: Check = { errors: [], warnings: [] };
    const facts = await inspectMedia(file);
    const uploadId = newUploadId();
    let item: UploadItem;
    if (facts.kind === 'video') {
        checkVideo(facts, path.basename(file), check, { minS: 1, maxS: LIMITS.storyVideoMaxSeconds, vertical: true });
        let cover: UploadItem['cover'] = null;
        if (o.cover) {
            const j = await asJpeg(o.cover);
            cover = { file: j.file, width: j.facts.width, height: j.facts.height };
        } else {
            const c = await extractCover(facts.path, o.coverAt ?? 0);
            if (c) {
                const cf = await inspectMedia(c);
                cover = { file: c, width: cf.width, height: cf.height };
            } else {
                check.errors.push('A video story needs a cover frame: pass --cover <jpg>, or install ffmpeg so one can be extracted.');
            }
        }
        item = { label: path.basename(file), file: facts.path, facts, uploadId, cover };
    } else {
        const j = await asJpeg(file);
        item = { label: path.basename(file), file: j.file, facts: j.facts, uploadId };
    }
    const mentions = o.mentions ?? [];
    const area = o.mentionArea ?? DEFAULT_MENTION_AREA;
    checkStoryMentions(mentions, area, check);
    if (Math.abs(item.facts.width / item.facts.height - 9 / 16) > 0.02) check.warnings.push(`${item.facts.width}x${item.facts.height} is not 9:16; the story will be cropped or padded.`);
    return {
        kind: 'story',
        contract: mentions.length ? CONTRACTS.storyMention : o.aiLabel ? CONTRACTS.storyAiLabel : CONTRACTS.story,
        caption: '',
        items: [item],
        configure: { url: E.configureStory, encoding: 'form', body: { source_type: 'library', configure_mode: '1', upload_id: uploadId, caption: '', ...(o.aiLabel ? { gen_ai_detection_method: 'SELF_DISCLOSURE_FLOW' } : {}), ...storyMentionFields(mentions, area) } },
        check,
    };
}

/** A printable description of exactly what `execute` would send. Secrets are redacted. */
export function describePlan(plan: PublishPlan): Record<string, unknown> {
    const requests: Record<string, unknown>[] = [];
    for (const it of plan.items) {
        const isVideo = it.facts.kind === 'video';
        requests.push({
            method: 'POST',
            url: isVideo ? E.ruploadVideo(entityName(it.uploadId)) : E.ruploadPhoto(entityName(it.uploadId)),
            headers: {
                'X-Instagram-Rupload-Params': isVideo
                    ? videoRuploadParams(it.uploadId, it.facts, { clips: plan.kind === 'reel', sidecar: plan.kind === 'carousel' })
                    : photoRuploadParams(it.uploadId, it.facts, { sidecar: plan.kind === 'carousel' }),
                'X-Entity-Name': entityName(it.uploadId),
                'X-Entity-Length': it.facts.bytes,
                Cookie: '<redacted>',
                'X-CSRFToken': '<redacted>',
            },
            body: `<${it.facts.bytes} bytes of ${it.facts.mime} from ${it.file}>`,
        });
        if (it.cover) {
            requests.push({
                method: 'POST',
                url: E.ruploadPhoto(entityName(it.uploadId)),
                note: 'video cover, same upload_id',
                headers: { 'X-Instagram-Rupload-Params': photoRuploadParams(it.uploadId, it.cover, { videoCover: true, sidecar: plan.kind === 'carousel' }) },
                body: `<cover jpeg from ${it.cover.file}>`,
            });
        }
    }
    requests.push({
        method: 'POST',
        url: plan.configure.url,
        encoding: plan.configure.encoding,
        body: plan.configure.body,
        ...(plan.kind === 'reel'
            ? {
                  transport: 'comet async request, as the web composer sends it',
                  alsoSent: 'signed_body ("SIGNATURE." + JSON of the fields above) and the page-context parameters __d, __user, __a, __req, __hs, __rev, __s, __hsi, __comet_req, fb_dtsg, jazoest, lsd, __spin_r, __spin_b, __spin_t; headers X-FB-LSD, X-IG-D, X-Instagram-AJAX, X-Web-Session-ID. Their values are read from the signed-in page at publish time and are never shown.',
                  answer: 'HTTP 200 with a wrapped payload; "still processing" (payload.statusCode 202) repeats the same request with a growing wait.',
              }
            : plan.kind === 'story' || plan.kind === 'carousel'
              ? { transport: 'plain form, or the comet async request when instagram.com says this session uses it (decided at publish time)' }
              : {}),
    });
    return {
        kind: plan.kind,
        contract: plan.contract,
        media: plan.items.map((i) => ({ label: i.label, ...i.facts, path: i.file })),
        errors: plan.check.errors,
        warnings: plan.check.warnings,
        requests,
    };
}

// ---------------------------------------------------------------- execution

async function rupload(client: IgClient, kind: 'photo' | 'video', uploadId: string, file: string, params: Record<string, unknown>, mime: string): Promise<void> {
    const bytes = new Uint8Array(await readFile(file));
    const entity = entityName(uploadId);
    const url = kind === 'photo' ? E.ruploadPhoto(entity) : E.ruploadVideo(entity);
    const res = await client.request<any>('POST', url, {
        body: bytes,
        headers: {
            'Content-Type': kind === 'photo' ? 'image/jpeg' : mime,
            'X-Instagram-Rupload-Params': JSON.stringify(params),
            'X-Entity-Name': entity,
            'X-Entity-Length': String(bytes.length),
            'X-Entity-Type': kind === 'photo' ? 'image/jpeg' : mime,
            Offset: '0',
        },
    });
    if (res?.status && res.status !== 'ok') throw new IgError('bad_request', `Upload of ${path.basename(file)} was not accepted (status ${['fail', 'error'].includes(String(res.status).toLowerCase()) ? String(res.status).toLowerCase() : 'not ok'}).`);
}

async function uploadItem(client: IgClient, plan: PublishPlan, it: UploadItem, log: (m: string) => void): Promise<void> {
    const sidecar = plan.kind === 'carousel';
    if (it.facts.kind === 'photo') {
        log(`[instagram] Uploading ${it.label} (${(it.facts.bytes / 1e6).toFixed(2)} MB)`);
        await rupload(client, 'photo', it.uploadId, it.file, photoRuploadParams(it.uploadId, it.facts, { sidecar }), 'image/jpeg');
        return;
    }
    log(`[instagram] Uploading video ${it.label} (${(it.facts.bytes / 1e6).toFixed(1)} MB)`);
    await rupload(client, 'video', it.uploadId, it.file, videoRuploadParams(it.uploadId, it.facts, { clips: plan.kind === 'reel', sidecar }), it.facts.mime);
    if (it.cover) {
        log(`[instagram] Uploading cover for ${it.label}`);
        await rupload(client, 'photo', it.uploadId, it.cover.file, photoRuploadParams(it.uploadId, it.cover, { videoCover: true, sidecar }), 'image/jpeg');
    }
}

const TRANSCODE_BACKOFF_S = [3, 6, 12, 24, 48, 64, 64, 64, 64, 64, 64, 64];

/** Configure with bounded retries on an explicit "not ready yet" answer only. */
/** One line of evidence per publish attempt; kept in the pending record when the outcome is unclear. */
export interface ConfigureAttempt {
    attempt: number;
    at: string;
    http?: number;
    bytes?: number;
    outcome: string;
    body?: string;
}

const ANSWER_KEYS = ['status', 'statusCode', 'media', 'medias', 'posts', 'upload_id', 'message', 'error_type', 'error_title', 'client_sidecar_id'];

/**
 * What is kept about a publish answer: which known fields it had and its status word. Never the answer's own
 * text, on any transport: an unexpected page or JSON body can carry tokens, and this goes to disk and to stdout.
 */
function snippet(v: unknown): string {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return `answer of type ${Array.isArray(v) ? 'array' : typeof v}`;
    const keys = Object.keys(v as object);
    const known = keys.filter((k) => ANSWER_KEYS.includes(k));
    const status = (v as any).status;
    const word = typeof status === 'string' && ['ok', 'fail', 'pending', 'in_progress', 'error'].includes(status.toLowerCase()) ? `; status ${status.toLowerCase()}` : '';
    return `answer fields: ${known.join(',') || 'none known'}${keys.length > known.length ? ` (+${keys.length - known.length} other)` : ''}${word}`;
}

/** Which transport the publish step uses, following the web client: reels always comet; stories and carousels by gate. */
export function usesComet(plan: Pick<PublishPlan, 'kind'>, client: Pick<IgClient, 'webGates'>): boolean {
    if (plan.kind === 'reel') return true;
    const g = client.webGates();
    if (plan.kind === 'story') return g?.storyComet === true;
    // Carousels: the comet variant needs nested form fields that are not implemented; executeLocked refuses it.
    return false;
}

async function configure(client: IgClient, plan: PublishPlan, log: (m: string) => void, attempts: ConfigureAttempt[] = []): Promise<any> {
    const { url, encoding, body } = plan.configure;
    for (let attempt = 0; ; attempt++) {
        const meta: { status?: number; bytes?: number; text?: string } = {};
        const at = new Date().toISOString();
        try {
            // Reels (always) and stories / carousels (when the server gate says so) go through the comet async shape,
            // exactly as the web client sends them; everything else keeps the plain form.
            const res = usesComet(plan, client)
                ? await client.cometPost(url, body as Record<string, unknown>, meta)
                : await client.request<any>('POST', url, encoding === 'json' ? { json: body, meta } : { form: body as Record<string, string>, meta });
            attempts.push({ attempt: attempt + 1, at, http: meta.status, bytes: meta.bytes, outcome: readConfigureAnswer(res).state, body: usesComet(plan, client) ? meta.text : snippet(res) });
            log(`[instagram] publish answer: HTTP ${meta.status ?? '?'}, ${meta.bytes ?? '?'} bytes (attempt ${attempt + 1})`);
            if (res && typeof res === 'object') Object.defineProperty(res, '__httpStatus', { value: meta.status, enumerable: false });
            return res;
        } catch (e) {
            const ig = e instanceof IgError ? e : null;
            attempts.push({ attempt: attempt + 1, at, http: meta.status ?? ig?.status, bytes: meta.bytes, outcome: ig?.kind ?? 'error', body: usesComet(plan, client) ? meta.text ?? ig?.kind ?? 'error' : ig?.body !== undefined ? snippet(ig.body) : `${ig?.kind ?? 'error'}; ${meta.bytes ?? '?'} bytes, not a JSON answer` });
            log(`[instagram] publish answer: HTTP ${meta.status ?? ig?.status ?? '?'}, ${meta.bytes ?? '?'} bytes, ${ig?.kind === 'transcode_pending' ? 'still processing' : ig?.kind ?? 'error'} (attempt ${attempt + 1})`);
            const hasVideo = plan.items.some((i) => i.facts.kind === 'video');
            // Retry only on a JSON "not ready" answer below 500: a 5xx never proves nothing was created.
            const clearNotReady = ig !== null && ig.kind === 'transcode_pending' && ig.body !== undefined && (ig.status ?? 0) < 500;
            if (clearNotReady && hasVideo && attempt < TRANSCODE_BACKOFF_S.length - 1) {
                const wait = TRANSCODE_BACKOFF_S[attempt];
                log(`[instagram] Instagram is still processing the video; retrying in ${wait}s (attempt ${attempt + 2} of ${TRANSCODE_BACKOFF_S.length})`);
                await new Promise((r) => setTimeout(r, wait * 1000));
                continue;
            }
            throw e;
        }
    }
}

export interface PublishResult {
    pk: string;
    code: string;
    url: string;
    kind: PublishPlan['kind'];
}

/**
 * Lists the account's newest posts that could be the result of a pending publish
 * (same caption, created after it started). Used by `pending check`; it never
 * resolves anything by itself, because a match can be a coincidence and a miss can
 * be read lag. Stories are not in the post feed, so story ops are always manual.
 */
export async function candidatesFor(client: IgClient, op: PendingOp): Promise<{ post: PublishResult; captionMatches: boolean; takenAt: string }[]> {
    if (op.kind === 'story') return [];
    const since = Date.parse(op.startedAt) - 120_000;
    const { posts } = await getPosts(client, null, 6);
    return posts
        .filter((p) => Date.parse(p.takenAt) >= since)
        .map((p) => ({
            post: { pk: p.pk, code: p.shortcode, url: p.url, kind: (p.format === 'reel' ? 'reel' : p.format === 'carousel' ? 'carousel' : 'photo') as PublishPlan['kind'] },
            captionMatches: p.caption.trim() === op.caption.trim(),
            takenAt: p.takenAt,
        }));
}

/** Errors after which Instagram definitely did not create the post. */
const DEFINITIVE: string[] = ['bad_request', 'validation', 'rate_limited', 'feedback_required', 'checkpoint', 'not_logged_in', 'not_found'];

export async function executePlan(client: IgClient, plan: PublishPlan, log: (m: string) => void = () => undefined, opts?: { ignorePending?: boolean }): Promise<PublishResult> {
    if (plan.check.errors.length) throw new IgError('validation', `Refusing to publish:\n  - ${plan.check.errors.join('\n  - ')}`);
    let release: () => Promise<void>;
    try {
        release = await acquirePublishLock();
    } catch (e) {
        throw new IgError('validation', (e as Error).message);
    }
    try {
        return await executeLocked(client, plan, log, opts);
    } finally {
        await release();
    }
}

async function executeLocked(client: IgClient, plan: PublishPlan, log: (m: string) => void, opts?: { ignorePending?: boolean }): Promise<PublishResult> {
    const unresolved = await listPending();
    if (unresolved.length && !opts?.ignorePending) {
        throw new IgError('validation', `${unresolved.length} earlier publish(es) ended without a clear answer (${unresolved.map((u) => u.id).join(', ')}).`, {
            hint: 'Run `pending` to see them and `pending check <id>`; resolve each with `pending resolve <id> --posted|--not-posted` before posting again.',
        });
    }
    // The page context is needed before anything is uploaded: a publish that cannot be finished must not start.
    // A reel cannot be published without it. A story or carousel still has the plain form the web client uses
    // when its gate is off, so a page that cannot be read is reported and the plain form is used.
    if (plan.kind === 'reel') await client.ensureWebContext();
    if (plan.kind === 'story' || plan.kind === 'carousel') {
        try {
            await client.ensureWebContext();
        } catch (e) {
            if (isAccountSignal(e)) throw e;
            log(`[instagram] warning: ${(e as Error).message}`);
        }
        const g = client.webGates() ?? { storyComet: null, sidecarComet: null };
        if (plan.kind === 'story' && g.storyComet === null) log('[instagram] warning: could not read which request shape instagram.com uses for stories on this session; using the plain form, which worked last time it was verified.');
        if (plan.kind === 'carousel' && g.sidecarComet === true) {
            throw new IgError('validation', 'instagram.com now publishes carousels on this session with a request shape this skill does not implement yet. Nothing was uploaded.', {
                hint: 'Publish this carousel from the Instagram app, and report it so the skill can be updated.',
            });
        }
        if (plan.kind === 'carousel' && g.sidecarComet === null) log('[instagram] warning: could not read which request shape instagram.com uses for carousels on this session; using the plain form, which worked last time it was verified.');
    }
    for (const it of plan.items) await uploadItem(client, plan, it, log);
    log(`[instagram] Publishing ${plan.kind} (${usesComet(plan, client) ? 'comet async request' : 'plain form'})`);
    const op = await beginPending({ id: plan.items[0].uploadId, kind: plan.kind, caption: plan.caption, uploadIds: plan.items.map((i) => i.uploadId) });
    let res: any;
    const attempts: ConfigureAttempt[] = [];
    try {
        res = await configure(client, plan, log, attempts);
    } catch (e) {
        const kind = e instanceof IgError ? e.kind : 'server_error';
        // A 5xx (or no status at all from a dropped connection) never proves the post was not created,
        // whatever its body says, so it stays pending.
        const status = e instanceof IgError ? e.status : undefined;
        // Only a JSON answer below 500 is definitive. HTML (even a 200 challenge page) proves nothing.
        const jsonAnswer = e instanceof IgError && e.body !== undefined;
        // A comet error never carries a body, so it is never definitive: an earlier "still processing" answer may
        // already have accepted the publish.
        const definitive = DEFINITIVE.includes(kind) && (kind === 'validation' || (jsonAnswer && status !== undefined && status < 500));
        if (definitive) {
            await clearPending(op.id);
            await logAction({ action: `post.${plan.kind}`, failed: true, uploadIds: op.uploadIds, error: (e as Error).message, attempts });
            throw e;
        }
        await markUnresolved(op, (e as Error).message, attempts as unknown as Array<Record<string, unknown>>);
        await logAction({ action: `post.${plan.kind}`, unresolved: true, pendingId: op.id, error: (e as Error).message, attempts });
        throw new IgError(kind, `Publish of ${plan.kind} ended without a clear answer: ${(e as Error).message}`, {
            status,
            endpoint: e instanceof IgError ? e.endpoint : undefined,
            body: e instanceof IgError ? e.body : undefined,
            hint: `It may or may not be live. Do NOT retry. Run \`pending check ${op.id}\`, look at the profile, then \`pending resolve ${op.id} --posted|--not-posted\`.`,
        });
    }
    const answer = readConfigureAnswer(res);
    const media = answer.media;
    const pk = mediaPk(media);
    const code = String(media?.code ?? '');
    if (!pk) {
        const http = (res as any)?.__httpStatus;
        await markUnresolved(op, `configure answered without a media id (HTTP ${http ?? '?'}, ${answer.state})`, attempts as unknown as Array<Record<string, unknown>>);
        await logAction({ action: `post.${plan.kind}`, unresolved: true, pendingId: op.id, error: `no media id (HTTP ${http ?? '?'}, ${answer.state})`, attempts });
        throw new IgError('unexpected_response', `Publish returned no usable media id (HTTP ${http ?? '?'}, ${answer.state}; ${usesComet(plan, client) ? 'comet answer' : snippet(res)})`, {
            hint: `Check the profile, then \`pending resolve ${op.id} --posted|--not-posted\`.`,
        });
    }
    await clearPending(op.id);
    // A story has a shortcode, but /p/<code>/ does not open it; stories live under /stories/<user>/<pk>/.
    const owner = String(media?.user?.username ?? '');
    const url = plan.kind === 'story'
        ? (owner ? `https://www.instagram.com/stories/${owner}/${pk}/` : '')
        : code ? postUrl(code, plan.kind === 'reel' ? 'reel' : 'p') : '';
    const result: PublishResult = { pk, code, url, kind: plan.kind };
    await logAction({ action: `post.${plan.kind}`, ...result, contract: plan.contract });
    return result;
}

// ---------------------------------------------------------------- manage

export async function editCaption(client: IgClient, ref: string, caption: string, maxHashtags?: number): Promise<{ pk: string }> {
    const check = checkCaption(caption, maxHashtags);
    if (check.errors.length) throw new IgError('validation', check.errors.join('\n'));
    const pk = toMediaPk(ref);
    // Same body as the web client (PolarisPostActionEditPost.editPost): it always sends
    // coauthor_invites, and edit_media answers a non-JSON 500 when it is missing.
    await client.request('POST', E.editMedia(pk), {
        form: { caption_text: caption, coauthor_invites: JSON.stringify({ added: [], in: [], removed: [] }) },
    });
    await logAction({ action: 'edit_caption', pk });
    return { pk };
}

export const COMMENT_MUTATION = 'PolarisPostCommentInputRevampedMutation';

/**
 * Variables for the web client's comment mutation (root field xig_comment_create), as
 * PolarisPostCommentInput sends them. Exported for tests.
 */
export function commentVariables(mediaPk: string, text: string, replyTo?: string): Record<string, unknown> {
    return {
        data: { comment_text: text, media_id: mediaPk, ...(replyTo ? { replied_to_comment_id: replyTo } : {}) },
        root_connections: [],
    };
}

export async function addComment(client: IgClient, ref: string, text: string, replyTo?: string): Promise<{ pk: string; commentId: string; via: string }> {
    if (!text.trim()) throw new IgError('validation', 'Comment text is empty.');
    if ([...text].length > LIMITS.commentChars) throw new IgError('validation', `Comment is over ${LIMITS.commentChars} chars.`);
    if (replyTo && !/^\d+$/.test(replyTo)) throw new IgError('validation', `Comment id ${replyTo} is not numeric.`);
    const pk = toMediaPk(ref);
    // Primary: the web client's mutation. Fall back to the legacy REST endpoints only when
    // its doc_id cannot be found, i.e. before anything was sent; a sent mutation that fails
    // is never retried elsewhere, so a comment cannot be posted twice.
    const gql = new GraphQL(client);
    try {
        await gql.init(`/p/${pkToShortcode(pk)}/`, [COMMENT_MUTATION]);
    } catch (e) {
        // Reading the post page is not a write; only account signals stop here.
        if (!(e instanceof IgError) || !['not_found', 'unexpected_response', 'server_error'].includes(e.kind)) throw e;
    }
    let value: string;
    let via: string;
    if (gql.docId(COMMENT_MUTATION)) {
        const d = await gql.query<any>(COMMENT_MUTATION, commentVariables(pk, text, replyTo), { path: '/api/graphql' });
        const c = d?.data?.xig_comment_create?.comment ?? d?.data?.xig_comment_create;
        const id = c?.pk ?? c?.id;
        if (!id) {
            throw new IgError('unexpected_response', `${COMMENT_MUTATION} returned no comment id. It may or may not be posted; check the post before retrying.`, { body: d });
        }
        value = String(id);
        via = `graphql ${COMMENT_MUTATION}`;
    } else {
        ({ value, via } = await client.tryEach(
            'comment',
            E.addComment.map((c) => ({
                name: c.name,
                method: 'POST' as const,
                url: c.url(pk),
                options: { form: { comment_text: text, ...(replyTo ? { replied_to_comment_id: replyTo } : {}) } },
                parse: (d: any) => {
                    const id = d?.id ?? d?.comment?.pk ?? d?.pk;
                    if (!id) throw new Error('no comment id');
                    return String(id);
                },
            })),
            { mutation: true },
        ));
    }
    await logAction({ action: replyTo ? 'reply' : 'comment', pk, commentId: value, via });
    return { pk, commentId: value, via };
}
