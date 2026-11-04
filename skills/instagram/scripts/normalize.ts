import { pkToShortcode, postUrl } from './constants.ts';
import type { Comment, Post, Profile } from './types.ts';

/**
 * Instagram returns the same objects in three dialects:
 *  - v1 REST / xdt GraphQL "media" (pk, code, media_type, like_count, ...)
 *  - legacy GraphQL "node" (shortcode, __typename, edge_liked_by, ...) from web_profile_info
 *  - user objects in both styles
 * These functions accept any of them and return one shape.
 */

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

export function hashtagsOf(text: string): string[] {
    return [...new Set([...text.matchAll(/#([\p{L}\p{N}_]+)/gu)].map((m) => m[1].toLowerCase()))];
}

export function normalizePost(m: any): Post {
    if (m?.media && !m.pk && !m.shortcode) m = m.media;
    if (m?.node) m = m.node;
    const isLegacy = typeof m?.__typename === 'string' || 'shortcode' in (m ?? {});
    const pk = String(m?.pk ?? m?.id ?? '').split('_')[0];
    const shortcode = String(m?.code ?? m?.shortcode ?? (pk ? pkToShortcode(pk) : ''));
    const caption = isLegacy ? (m?.edge_media_to_caption?.edges?.[0]?.node?.text ?? '') : (m?.caption?.text ?? '');

    let format: Post['format'] = 'unknown';
    const productType = m?.product_type;
    if (productType === 'clips') format = 'reel';
    else if (m?.media_type === 8 || m?.__typename === 'GraphSidecar' || m?.__typename === 'XDTGraphSidecar' || productType === 'carousel_container') format = 'carousel';
    else if (m?.media_type === 2 || m?.is_video || m?.__typename === 'GraphVideo') format = productType === 'igtv' ? 'video' : 'reel';
    else if (m?.media_type === 1 || m?.__typename === 'GraphImage') format = 'photo';

    const takenAtSec = m?.taken_at ?? m?.taken_at_timestamp ?? m?.device_timestamp;
    const likes = num(m?.like_count) ?? num(m?.edge_liked_by?.count) ?? num(m?.edge_media_preview_like?.count);
    const comments = num(m?.comment_count) ?? num(m?.edge_media_to_comment?.count) ?? num(m?.edge_media_preview_comment?.count);
    const plays = num(m?.play_count) ?? num(m?.ig_play_count) ?? num(m?.video_play_count);
    const views = num(m?.view_count) ?? num(m?.video_view_count);

    return {
        id: String(m?.id ?? pk),
        pk,
        shortcode,
        url: postUrl(shortcode, format === 'reel' ? 'reel' : 'p'),
        format,
        takenAt: typeof takenAtSec === 'number' ? new Date(takenAtSec * 1000).toISOString() : '',
        caption,
        // like_and_view_counts_disabled posts report 0/absent; keep null when the flag is set.
        likes: m?.like_and_view_counts_disabled ? null : likes,
        comments: m?.comments_disabled ? null : comments,
        plays,
        views,
        durationSec: num(m?.video_duration),
        owner: m?.user?.username ?? m?.owner?.username,
        hashtags: hashtagsOf(caption),
    };
}

export function normalizeProfile(u: any): Profile {
    if (u?.data?.user) u = u.data.user;
    else if (u?.user) u = u.user;
    const links: string[] = Array.isArray(u?.bio_links) ? u.bio_links.map((l: any) => l?.url ?? l?.lynx_url).filter(Boolean) : [];
    return {
        pk: String(u?.pk ?? u?.id ?? ''),
        username: String(u?.username ?? ''),
        fullName: String(u?.full_name ?? ''),
        biography: String(u?.biography ?? ''),
        externalUrl: u?.external_url || null,
        bioLinks: links,
        followers: num(u?.follower_count) ?? num(u?.edge_followed_by?.count),
        following: num(u?.following_count) ?? num(u?.edge_follow?.count),
        mediaCount: num(u?.media_count) ?? num(u?.edge_owner_to_timeline_media?.count),
        isPrivate: Boolean(u?.is_private),
        isVerified: Boolean(u?.is_verified),
        isBusiness: Boolean(u?.is_business ?? u?.is_business_account ?? u?.is_professional_account),
        category: u?.category ?? u?.category_name ?? null,
        profilePicUrl: u?.hd_profile_pic_url_info?.url ?? u?.profile_pic_url_hd ?? u?.profile_pic_url ?? null,
    };
}

/** Posts embedded in a web_profile_info response (legacy edges, up to 12). */
export function embeddedPosts(u: any): Post[] {
    const user = u?.data?.user ?? u?.user ?? u;
    const edges = user?.edge_owner_to_timeline_media?.edges;
    return Array.isArray(edges) ? edges.map((e: any) => normalizePost(e.node)) : [];
}

export function normalizeComment(c: any): Comment {
    return {
        pk: String(c?.pk ?? c?.id ?? ''),
        text: String(c?.text ?? ''),
        user: String(c?.user?.username ?? c?.owner?.username ?? ''),
        createdAt: typeof c?.created_at === 'number' ? new Date(c.created_at * 1000).toISOString() : '',
        likes: num(c?.comment_like_count) ?? num(c?.edge_liked_by?.count) ?? 0,
        replies: num(c?.child_comment_count) ?? 0,
    };
}

/** Media from tags/web_info (top + recent sections). */
export function hashtagPosts(data: any): { top: Post[]; recent: Post[]; mediaCount: number | null } {
    const d = data?.data ?? data;
    const fromSections = (sections: any): Post[] => {
        if (!Array.isArray(sections)) return [];
        const out: Post[] = [];
        for (const s of sections) {
            const medias = s?.layout_content?.medias ?? s?.layout_content?.fill_items ?? [];
            for (const it of medias) if (it?.media) out.push(normalizePost(it.media));
        }
        return out;
    };
    return {
        top: fromSections(d?.top?.sections),
        recent: fromSections(d?.recent?.sections),
        mediaCount: num(d?.media_count) ?? num(d?.count),
    };
}
