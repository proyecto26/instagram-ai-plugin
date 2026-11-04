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
export const CONTRACTS: Record<'photo' | 'carousel' | 'reel' | 'story' | 'editCaption' | 'comment', ContractStatus> = {
    photo: 'verified-live', // 2026-11-04, 1080x1350 with alt text, DfTN_A7F2z5
    carousel: 'verified-live', // 2026-11-04, 5 slides, DfTK_q1l8iu
    reel: 'verified-live', // 2026-11-04, 27 s with cover, DfTJDK3R8MR
    story: 'verified-live', // 2026-11-04, photo and video (rupload_igvideo + cover + configure_to_story)
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
    const uploadId = newUploadId();
    return {
        kind: 'reel',
        contract: CONTRACTS.reel,
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
export async function planStory(file: string, o: Pick<PostOptions, 'cover' | 'coverAt'> = {}): Promise<PublishPlan> {
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
    if (Math.abs(item.facts.width / item.facts.height - 9 / 16) > 0.02) check.warnings.push(`${item.facts.width}x${item.facts.height} is not 9:16; the story will be cropped or padded.`);
    return {
        kind: 'story',
        contract: CONTRACTS.story,
        caption: '',
        items: [item],
        configure: { url: E.configureStory, encoding: 'form', body: { source_type: 'library', configure_mode: '1', upload_id: uploadId, caption: '' } },
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
    requests.push({ method: 'POST', url: plan.configure.url, encoding: plan.configure.encoding, body: plan.configure.body });
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
    if (res?.status && res.status !== 'ok') throw new IgError('bad_request', `Upload of ${path.basename(file)} answered status=${res.status}.`, { body: res });
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

const TRANSCODE_BACKOFF_S = [3, 5, 8, 13, 20, 30, 45, 60, 60, 60];

/** Configure with bounded retries on an explicit "not ready yet" answer only. */
async function configure(client: IgClient, plan: PublishPlan, log: (m: string) => void): Promise<any> {
    const { url, encoding, body } = plan.configure;
    for (let attempt = 0; ; attempt++) {
        try {
            return await client.request<any>('POST', url, encoding === 'json' ? { json: body } : { form: body as Record<string, string> });
        } catch (e) {
            const hasVideo = plan.items.some((i) => i.facts.kind === 'video');
            // Retry only on a JSON "not ready" answer below 500: a 5xx never proves nothing was created.
            const clearNotReady = e instanceof IgError && e.kind === 'transcode_pending' && e.body !== undefined && (e.status ?? 0) < 500;
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
    for (const it of plan.items) await uploadItem(client, plan, it, log);
    log(`[instagram] Publishing ${plan.kind}`);
    const op = await beginPending({ id: plan.items[0].uploadId, kind: plan.kind, caption: plan.caption, uploadIds: plan.items.map((i) => i.uploadId) });
    let res: any;
    try {
        res = await configure(client, plan, log);
    } catch (e) {
        const kind = e instanceof IgError ? e.kind : 'server_error';
        // A 5xx (or no status at all from a dropped connection) never proves the post was not created,
        // whatever its body says, so it stays pending.
        const status = e instanceof IgError ? e.status : undefined;
        // Only a JSON answer below 500 is definitive. HTML (even a 200 challenge page) proves nothing.
        const jsonAnswer = e instanceof IgError && e.body !== undefined;
        const definitive = DEFINITIVE.includes(kind) && (kind === 'validation' || (jsonAnswer && status !== undefined && status < 500));
        if (definitive) {
            await clearPending(op.id);
            await logAction({ action: `post.${plan.kind}`, failed: true, uploadIds: op.uploadIds, error: (e as Error).message });
            throw e;
        }
        await markUnresolved(op, (e as Error).message);
        await logAction({ action: `post.${plan.kind}`, unresolved: true, pendingId: op.id, error: (e as Error).message });
        throw new IgError(kind, `Publish of ${plan.kind} ended without a clear answer: ${(e as Error).message}`, {
            hint: `It may or may not be live. Do NOT retry. Run \`pending check ${op.id}\`, look at the profile, then \`pending resolve ${op.id} --posted|--not-posted\`.`,
        });
    }
    const media = res?.media ?? res;
    const pk = String(media?.pk ?? media?.id ?? '').split('_')[0];
    const code = String(media?.code ?? '');
    if (!pk) {
        await markUnresolved(op, 'configure answered without a media id');
        throw new IgError('unexpected_response', `Publish returned no media id: ${JSON.stringify(res).slice(0, 300)}`, {
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
