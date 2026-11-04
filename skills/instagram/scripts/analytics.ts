import type { Post, Profile } from './types.ts';

/**
 * Descriptive account analytics from public post counters. Everything here is
 * correlation on a small sample, so each bucket carries its sample size and
 * buckets under MIN_BUCKET posts are reported as insufficient instead of ranked.
 * Reach, saves, shares, profile visits and follows-from-post live in Instagram
 * Insights, which the web session does not expose: they are listed as MISSING.
 */

export const MIN_BUCKET = 3;

export function median(xs: number[]): number | null {
    const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
    if (!v.length) return null;
    const m = Math.floor(v.length / 2);
    return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

const round = (x: number | null, d = 2) => (x === null ? null : Math.round(x * 10 ** d) / 10 ** d);

export function engagement(p: Post): number | null {
    // Hidden like counts would bias the post low: exclude it instead of counting comments only.
    if (p.likes === null) return null;
    return p.likes + (p.comments ?? 0);
}

export interface PostScore {
    shortcode: string;
    url: string;
    format: Post['format'];
    takenAt: string;
    engagement: number | null;
    engagementRatePct: number | null;
    plays: number | null;
    /** engagement / account median. >= 3 is an outlier worth studying. */
    outlierMultiple: number | null;
    hook: string;
}

export interface Bucket {
    key: string;
    n: number;
    medianEngagement: number | null;
    medianEngagementRatePct: number | null;
    medianPlays?: number | null;
    note?: string;
}

export interface Audit {
    account: Pick<Profile, 'username' | 'followers' | 'following' | 'mediaCount' | 'isBusiness' | 'category'> & { bioChars: number; hasLink: boolean };
    sample: { posts: number; from: string | null; to: string | null; source: string; timezone: string };
    totals: { medianEngagement: number | null; medianEngagementRatePct: number | null; medianReelPlays: number | null };
    cadence: { postsPerWeek: number | null; longestGapDays: number | null };
    byFormat: Bucket[];
    byWeekday: Bucket[];
    byHour: Bucket[];
    byCaptionLength: Bucket[];
    hashtags: Bucket[];
    outliers: PostScore[];
    underperformers: PostScore[];
    posts: PostScore[];
    missing: string[];
}

function bucketize(items: { key: string; post: Post; er: number | null }[], order?: string[]): Bucket[] {
    const groups = new Map<string, { post: Post; er: number | null }[]>();
    for (const it of items) groups.set(it.key, [...(groups.get(it.key) ?? []), it]);
    const keys = order ? order.filter((k) => groups.has(k)) : [...groups.keys()];
    return keys.map((key) => {
        const g = groups.get(key)!;
        const b: Bucket = {
            key,
            n: g.length,
            medianEngagement: round(median(g.map((x) => engagement(x.post) ?? NaN)), 1),
            medianEngagementRatePct: round(median(g.map((x) => x.er ?? NaN)), 3),
        };
        const plays = g.map((x) => x.post.plays ?? NaN).filter(Number.isFinite);
        if (plays.length) b.medianPlays = round(median(plays), 0);
        if (g.length < MIN_BUCKET) b.note = `insufficient data (n<${MIN_BUCKET})`;
        return b;
    });
}

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function localParts(iso: string, timeZone: string): { weekday: string; hour: number } {
    const d = new Date(iso);
    const fmt = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: '2-digit', hourCycle: 'h23' });
    const parts = Object.fromEntries(fmt.formatToParts(d).map((p) => [p.type, p.value]));
    return { weekday: parts.weekday, hour: Number(parts.hour) };
}

export function firstLine(caption: string): string {
    return (caption.split('\n').find((l) => l.trim()) ?? '').trim().slice(0, 140);
}

export function audit(profile: Profile, posts: Post[], opts: { source: string; timeZone?: string }): Audit {
    const timeZone = opts.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';
    const followers = profile.followers;
    const er = (p: Post) => {
        const e = engagement(p);
        return e === null || !followers ? null : (e / followers) * 100;
    };
    const sorted = [...posts].filter((p) => p.takenAt).sort((a, b) => a.takenAt.localeCompare(b.takenAt));
    const med = median(sorted.map((p) => engagement(p) ?? NaN));

    const scores: PostScore[] = sorted.map((p) => {
        const e = engagement(p);
        return {
            shortcode: p.shortcode,
            url: p.url,
            format: p.format,
            takenAt: p.takenAt,
            engagement: e,
            engagementRatePct: round(er(p), 3),
            plays: p.plays,
            outlierMultiple: e !== null && med ? round(e / med, 2) : null,
            hook: firstLine(p.caption),
        };
    });

    let postsPerWeek: number | null = null;
    let longestGapDays: number | null = null;
    if (sorted.length >= 2) {
        const first = Date.parse(sorted[0].takenAt);
        const last = Date.parse(sorted[sorted.length - 1].takenAt);
        const weeks = Math.max((last - first) / (7 * 86400e3), 1 / 7);
        postsPerWeek = round(sorted.length / weeks, 2);
        let gap = 0;
        for (let i = 1; i < sorted.length; i++) gap = Math.max(gap, Date.parse(sorted[i].takenAt) - Date.parse(sorted[i - 1].takenAt));
        longestGapDays = round(gap / 86400e3, 1);
    }

    const items = sorted.map((p) => ({ post: p, er: er(p) }));
    const lengthKey = (n: number) => (n === 0 ? 'none' : n <= 125 ? '1-125' : n <= 500 ? '126-500' : n <= 1200 ? '501-1200' : '1201+');

    const tagItems: { key: string; post: Post; er: number | null }[] = [];
    for (const it of items) for (const t of it.post.hashtags) tagItems.push({ key: `#${t}`, ...it });
    const hashtags = bucketize(tagItems)
        .filter((b) => b.n >= 2)
        .sort((a, b) => (b.medianEngagement ?? 0) - (a.medianEngagement ?? 0))
        .slice(0, 20);

    const withMultiple = scores.filter((s) => s.outlierMultiple !== null);
    return {
        account: {
            username: profile.username,
            followers: profile.followers,
            following: profile.following,
            mediaCount: profile.mediaCount,
            isBusiness: profile.isBusiness,
            category: profile.category,
            bioChars: [...profile.biography].length,
            hasLink: Boolean(profile.externalUrl || profile.bioLinks?.length),
        },
        sample: { posts: sorted.length, from: sorted[0]?.takenAt ?? null, to: sorted.at(-1)?.takenAt ?? null, source: opts.source, timezone: timeZone },
        totals: {
            medianEngagement: round(med, 1),
            medianEngagementRatePct: round(median(items.map((i) => i.er ?? NaN)), 3),
            medianReelPlays: round(median(sorted.filter((p) => p.format === 'reel').map((p) => p.plays ?? NaN)), 0),
        },
        cadence: { postsPerWeek, longestGapDays },
        byFormat: bucketize(items.map((i) => ({ key: i.post.format, ...i })), ['reel', 'carousel', 'photo', 'video', 'unknown']),
        byWeekday: bucketize(items.map((i) => ({ key: localParts(i.post.takenAt, timeZone).weekday, ...i })), WEEKDAYS),
        byHour: bucketize(
            items.map((i) => {
                const h = localParts(i.post.takenAt, timeZone).hour;
                const from = Math.floor(h / 3) * 3;
                return { key: `${String(from).padStart(2, '0')}-${String(from + 3).padStart(2, '0')}h`, ...i };
            }),
            ['00-03h', '03-06h', '06-09h', '09-12h', '12-15h', '15-18h', '18-21h', '21-24h'],
        ),
        byCaptionLength: bucketize(items.map((i) => ({ key: lengthKey([...i.post.caption].length), ...i })), ['none', '1-125', '126-500', '501-1200', '1201+']),
        hashtags,
        outliers: withMultiple.filter((s) => (s.outlierMultiple ?? 0) >= 3).sort((a, b) => (b.outlierMultiple ?? 0) - (a.outlierMultiple ?? 0)),
        underperformers: withMultiple.filter((s) => (s.outlierMultiple ?? 1) <= 0.5).sort((a, b) => (a.outlierMultiple ?? 0) - (b.outlierMultiple ?? 0)),
        posts: scores.reverse(),
        missing: [
            'reach / impressions (Insights only)',
            'saves (Insights only)',
            'watch time and retention (Insights only)',
            'shares / sends (Insights only)',
            'profile visits and follows from post (Insights only)',
            'audience demographics and active hours (Insights only)',
            ...(followers === null ? ['follower count (hidden or unavailable)'] : []),
        ],
    };
}

/** Outlier swipe file across several accounts: each post scored against its own account median. */
export function swipeFile(accounts: { username: string; posts: Post[] }[], minMultiple = 3): { username: string; shortcode: string; url: string; format: string; multiple: number; engagement: number; hook: string }[] {
    const out: { username: string; shortcode: string; url: string; format: string; multiple: number; engagement: number; hook: string }[] = [];
    for (const a of accounts) {
        const med = median(a.posts.map((p) => engagement(p) ?? NaN));
        if (!med) continue;
        for (const p of a.posts) {
            const e = engagement(p);
            if (e === null) continue;
            const m = e / med;
            if (m >= minMultiple) out.push({ username: a.username, shortcode: p.shortcode, url: p.url, format: p.format, multiple: Math.round(m * 100) / 100, engagement: e, hook: firstLine(p.caption) });
        }
    }
    return out.sort((x, y) => y.multiple - x.multiple);
}
