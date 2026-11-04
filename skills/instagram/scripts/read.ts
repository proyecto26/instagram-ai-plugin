import { IG_URL, shortcodeFromUrl, shortcodeToPk } from './constants.ts';
import { IgClient, IgError, type Candidate } from './client.ts';
import { E } from './endpoints.ts';
import { GQL, GraphQL } from './graphql.ts';
import { embeddedPosts, hashtagPosts, normalizeComment, normalizePost, normalizeProfile } from './normalize.ts';
import type { Comment, Post, Profile } from './types.ts';

/** Resolves a shortcode, post/reel URL, numeric pk, or "pk_owner" id to a pk. */
export function toMediaPk(ref: string): string {
    const r = ref.trim();
    const fromUrl = shortcodeFromUrl(r);
    if (fromUrl) return shortcodeToPk(fromUrl);
    if (/^\d+(_\d+)?$/.test(r)) return r.split('_')[0];
    if (/^[A-Za-z0-9_-]{5,}$/.test(r)) return shortcodeToPk(r);
    throw new IgError('validation', `Not a media reference: ${ref}. Use a post URL, shortcode, or numeric id.`);
}

const isAllFailed = (e: unknown) => e instanceof IgError && e.kind === 'not_found' && /no endpoint answered/.test(e.message);

/**
 * The signed-in account, read the way the browser learns it: from the logged-in
 * home page, which embeds `xdt_viewer: { user: { username, id } }`. The v1
 * `users/{id}/info` and `accounts/current_user` endpoints are not used here:
 * for web sessions the first answers HTTP 429 and the second redirects to the
 * home page, so neither identifies the account.
 */
export async function whoami(client: IgClient): Promise<{ profile: Profile; via: string }> {
    const html = await client.request<string>('GET', IG_URL, {
        expectJson: false,
        headers: { Accept: 'text/html,application/xhtml+xml', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' },
    });
    const viewer = viewerFromHomeHtml(html);
    if (!viewer) {
        throw new IgError('unexpected_response', 'The instagram.com home page did not name the signed-in account.', {
            hint: 'The page layout may have changed. Run `probe`, or sign in again with `login`.',
        });
    }
    if (viewer.id !== client.userId) {
        throw new IgError('not_logged_in', `The home page is signed in as user ${viewer.id}, but the saved ds_user_id is ${client.userId}.`, {
            hint: 'The saved cookies are inconsistent. Run `login` again.',
        });
    }
    return { profile: viewerProfile(viewer), via: 'home page (xdt_viewer)' };
}

/** Extracts the viewer's username and id from the logged-in home page HTML (plain or JSON-escaped). */
export function viewerFromHomeHtml(html: string): { username: string; id: string; fullName: string } | null {
    const text = html.replace(/\\"/g, '"');
    const block = text.match(/"xdt_viewer"\s*:\s*\{\s*"user"\s*:\s*\{([^{}]*)/)?.[1];
    if (!block) return null;
    const username = block.match(/"username"\s*:\s*"([\w.]+)"/)?.[1];
    const id = block.match(/"(?:id|pk)"\s*:\s*"(\d+)"/)?.[1];
    if (!username || !id) return null;
    return { username, id, fullName: block.match(/"full_name"\s*:\s*"([^"]*)"/)?.[1] ?? '' };
}

function viewerProfile(v: { username: string; id: string; fullName: string }): Profile {
    return {
        pk: v.id, username: v.username, fullName: v.fullName, biography: '', externalUrl: null, bioLinks: [],
        followers: null, following: null, mediaCount: null, isPrivate: false, isVerified: false, isBusiness: false,
        category: null, profilePicUrl: null,
    };
}

function must(p: Profile, what: string): Profile {
    if (!p.username) throw new Error(`no ${what} in response`);
    return p;
}

export async function getProfile(client: IgClient, username: string): Promise<{ profile: Profile; recent: Post[]; via: string }> {
    const u = username.replace(/^@/, '');
    const candidates: Candidate<{ profile: Profile; recent: Post[] }>[] = E.profileByUsername.map((c) => ({
        name: c.name,
        method: 'GET',
        url: c.url(u),
        parse: (d: any) => ({ profile: must(normalizeProfile(d), 'user'), recent: embeddedPosts(d) }),
    }));
    const { value, via } = await client.tryEach('profile', candidates);
    return { ...value, via };
}

/**
 * Recent posts for a user (default: the signed-in account), newest first.
 * Order: v1 user feed (paginated) -> username feed -> GraphQL PolarisProfilePostsQuery
 * -> the 12 posts embedded in web_profile_info. Reports which source answered.
 */
export async function getPosts(
    client: IgClient,
    username: string | null,
    limit = 24,
): Promise<{ posts: Post[]; via: string; profile?: Profile }> {
    let profile: Profile | undefined;
    let userId = client.userId;
    let uname = username?.replace(/^@/, '') ?? null;
    if (uname) {
        const p = await getProfile(client, uname);
        profile = p.profile;
        userId = p.profile.pk;
        if (p.profile.isPrivate && p.recent.length === 0) {
            return { posts: [], via: 'private account (no access)', profile };
        }
    }

    // 1) v1 feed by id, paginated.
    try {
        const posts: Post[] = [];
        let maxId: string | undefined;
        let via = '';
        const pager = new Pager(limit, 33);
        while (posts.length < limit) {
            const { value, via: v } = await client.tryEach('posts', [
                {
                    name: E.userFeed[0].name,
                    method: 'GET',
                    url: E.userFeed[0].url(userId),
                    options: { query: { count: Math.min(33, limit - posts.length), max_id: maxId } },
                    parse: (d: any) => {
                        if (!Array.isArray(d?.items)) throw new Error('no items');
                        return d;
                    },
                },
                ...(uname
                    ? [
                          {
                              name: E.userFeed[1].name,
                              method: 'GET' as const,
                              url: E.userFeed[1].url(uname),
                              options: { query: { count: Math.min(33, limit - posts.length), max_id: maxId } },
                              parse: (d: any) => {
                                  if (!Array.isArray(d?.items)) throw new Error('no items');
                                  return d;
                              },
                          },
                      ]
                    : []),
            ]);
            via = v;
            posts.push(...value.items.map(normalizePost));
            if (!value.more_available || !value.next_max_id) break;
            if (!pager.next(value.items.length, String(value.next_max_id))) break;
            maxId = String(value.next_max_id);
        }
        return { posts: posts.slice(0, limit), via, profile };
    } catch (e) {
        if (!isAllFailed(e)) throw e;
    }

    // 2) GraphQL persisted query.
    const name = uname ?? (await whoami(client)).profile.username;
    try {
        const gql = new GraphQL(client);
        await gql.init(`/${name}/`);
        const posts: Post[] = [];
        let after: string | undefined;
        const pager = new Pager(limit, 12);
        while (posts.length < limit) {
            const data = await gql.query(GQL.profilePosts.name, GQL.profilePosts.variables(name, Math.min(12, limit - posts.length), after));
            const conn = GQL.profilePosts.connection(data);
            if (!conn?.edges) throw new IgError('unexpected_response', 'PolarisProfilePostsQuery returned no timeline connection.');
            posts.push(...conn.edges.map((e: any) => normalizePost(e.node)));
            if (!conn.page_info?.has_next_page || !conn.page_info?.end_cursor) break;
            if (!pager.next(conn.edges.length, String(conn.page_info.end_cursor))) break;
            after = conn.page_info.end_cursor;
        }
        return { posts: posts.slice(0, limit), via: `graphql ${GQL.profilePosts.name}`, profile };
    } catch (e) {
        if (!(e instanceof IgError) || !['not_found', 'unexpected_response', 'bad_request'].includes(e.kind)) throw e;
        client.log?.(`[instagram] GraphQL posts failed (${e.message}); falling back to embedded profile posts`);
    }

    // 3) Last resort: the 12 posts embedded in the profile response.
    const p = await getProfile(client, name);
    return { posts: p.recent.slice(0, limit), via: `${p.via} (embedded, max 12)`, profile: profile ?? p.profile };
}

export async function getMedia(client: IgClient, ref: string): Promise<{ post: Post; raw: any; via: string }> {
    const pk = toMediaPk(ref);
    const { value, via } = await client.tryEach(
        'media',
        E.mediaInfo.map((c) => ({
            name: c.name,
            method: 'GET' as const,
            url: c.url(pk),
            parse: (d: any) => {
                const item = d?.items?.[0];
                if (!item) throw new Error('no items');
                return item;
            },
        })),
    );
    return { post: normalizePost(value), raw: value, via };
}

/**
 * Bounds pagination by requests, not only by results: stops on an empty page, a cursor
 * already seen, or more pages than the limit could need (plus slack). Exported for tests.
 */
export class Pager {
    private readonly seen = new Set<string>();
    private pages = 0;
    private readonly maxPages: number;
    constructor(limit: number, perPage: number) {
        this.maxPages = Math.ceil(limit / Math.max(1, perPage)) + 2;
    }
    /** Call after each page. Returns false when paging must stop. */
    next(itemsOnPage: number, cursor: string): boolean {
        this.pages++;
        if (itemsOnPage === 0 || this.seen.has(cursor) || this.pages >= this.maxPages) return false;
        this.seen.add(cursor);
        return true;
    }
}

export async function getComments(client: IgClient, ref: string, limit = 50): Promise<{ comments: Comment[]; via: string }> {
    const pk = toMediaPk(ref);
    const out: Comment[] = [];
    let minId: string | undefined;
    let via = '';
    const pager = new Pager(limit, 15);
    while (out.length < limit) {
        const { value, via: v } = await client.tryEach(
            'comments',
            E.mediaComments.map((c) => ({
                name: c.name,
                method: 'GET' as const,
                url: c.url(pk),
                options: { query: { can_support_threading: 'true', permalink_enabled: 'false', min_id: minId } },
                parse: (d: any) => {
                    if (!Array.isArray(d?.comments)) throw new Error('no comments array');
                    return d;
                },
            })),
        );
        via = v;
        out.push(...value.comments.map(normalizeComment));
        const next = value.next_min_id ?? value.next_max_id;
        if (!next || value.comments.length === 0) break;
        const cursor = typeof next === 'string' ? next : JSON.stringify(next);
        if (!pager.next(value.comments.length, cursor)) break;
        minId = cursor;
    }
    return { comments: out.slice(0, limit), via };
}

export async function getHashtag(client: IgClient, tag: string): Promise<{ tag: string; mediaCount: number | null; top: Post[]; recent: Post[]; via: string }> {
    const t = tag.replace(/^#/, '').toLowerCase();
    const { value, via } = await client.tryEach('hashtag', [
        {
            name: E.hashtag[0].name,
            method: 'GET',
            url: E.hashtag[0].url(t),
            parse: (d: any) => {
                if (!d?.data) throw new Error('no data');
                return hashtagPosts(d);
            },
        },
    ]);
    return { tag: t, ...value, via };
}

export interface SearchResult {
    users: { username: string; fullName: string; pk: string; isVerified: boolean; followers: number | null }[];
    hashtags: { name: string; mediaCount: number | null }[];
    via: string;
}

function parseSearch(d: any): Omit<SearchResult, 'via'> {
    const usersRaw = d?.users ?? d?.list?.filter((x: any) => x.user) ?? [];
    const users = usersRaw.map((x: any) => normalizeProfile(x.user ?? x)).filter((p: Profile) => p.username);
    const tagsRaw = d?.hashtags ?? d?.list?.filter((x: any) => x.hashtag) ?? [];
    const hashtags = tagsRaw.map((x: any) => ({ name: x.hashtag?.name ?? x.name, mediaCount: x.hashtag?.media_count ?? x.media_count ?? null })).filter((h: any) => h.name);
    if (!users.length && !hashtags.length && !Array.isArray(d?.users) && !Array.isArray(d?.list)) throw new Error('unknown search shape');
    return {
        users: users.map((p: Profile) => ({ username: p.username, fullName: p.fullName, pk: p.pk, isVerified: p.isVerified, followers: p.followers })),
        hashtags,
    };
}

export async function search(client: IgClient, query: string): Promise<SearchResult> {
    try {
        const { value, via } = await client.tryEach(
            'search',
            E.search.map((c) => ({ name: c.name, method: 'GET' as const, url: c.url(query), parse: parseSearch })),
        );
        return { ...value, via };
    } catch (e) {
        if (!isAllFailed(e)) throw e;
    }
    const gql = new GraphQL(client);
    await gql.init('/explore/');
    const data = await gql.query(GQL.topsearch.name, GQL.topsearch.variables(query));
    const res = GQL.topsearch.result(data);
    if (!res) throw new IgError('unexpected_response', 'PolarisAPITopsearchQuery returned no results object.');
    return { ...parseSearch(res), via: `graphql ${GQL.topsearch.name}` };
}
