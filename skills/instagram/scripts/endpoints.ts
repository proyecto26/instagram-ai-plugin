import { IG_API_ORIGIN, IG_ORIGIN, IG_UPLOAD_ORIGIN } from './constants.ts';

/**
 * The single table of Instagram endpoints this skill calls. When Instagram moves
 * something, this is the only file to edit. Each read op lists candidates in the
 * order they are tried (see IgClient.tryEach); writes have one canonical endpoint
 * plus an alternate where one is known.
 *
 * Status column = what was observed on 2026-11-03 from a signed-in web session:
 *   bundle  path present in the live web client's JS (create flow loaded)
 *   200     answered JSON to a GET probe
 *   404     not found on that host
 *   429     rate limited during probing (exists, but untested)
 *   legacy  long-standing web/mobile path, not re-verified
 */
export const E = {
    // --- session --------------------------------------------------------------
    currentUser: [
        { name: 'www accounts/current_user', url: `${IG_ORIGIN}/api/v1/accounts/current_user/?edit=true` }, // 200 (HTML w/o app headers)
        { name: 'i users/{id}/info', url: (id: string) => `${IG_API_ORIGIN}/api/v1/users/${id}/info/` }, // 429
    ],

    // --- reads ----------------------------------------------------------------
    profileByUsername: [
        { name: 'www users/web_profile_info', url: (u: string) => `${IG_ORIGIN}/api/v1/users/web_profile_info/?username=${encodeURIComponent(u)}` }, // 429
        { name: 'i users/web_profile_info', url: (u: string) => `${IG_API_ORIGIN}/api/v1/users/web_profile_info/?username=${encodeURIComponent(u)}` }, // legacy
    ],
    userInfo: [
        { name: 'www users/{id}/info', url: (id: string) => `${IG_ORIGIN}/api/v1/users/${id}/info/` }, // 429
        { name: 'i users/{id}/info', url: (id: string) => `${IG_API_ORIGIN}/api/v1/users/${id}/info/` }, // legacy
    ],
    userFeed: [
        { name: 'i feed/user/{id}', url: (id: string) => `${IG_API_ORIGIN}/api/v1/feed/user/${id}/` }, // legacy (404 on www)
        { name: 'www feed/user/{username}/username', url: (u: string) => `${IG_ORIGIN}/api/v1/feed/user/${encodeURIComponent(u)}/username/` }, // legacy
    ],
    mediaInfo: [
        { name: 'www media/{id}/info', url: (pk: string) => `${IG_ORIGIN}/api/v1/media/${pk}/info/` }, // bundle
        { name: 'i media/{id}/info', url: (pk: string) => `${IG_API_ORIGIN}/api/v1/media/${pk}/info/` }, // legacy
    ],
    mediaComments: [
        { name: 'www media/{id}/comments', url: (pk: string) => `${IG_ORIGIN}/api/v1/media/${pk}/comments/` }, // bundle
        { name: 'i media/{id}/comments', url: (pk: string) => `${IG_API_ORIGIN}/api/v1/media/${pk}/comments/` }, // legacy
    ],
    hashtag: [
        { name: 'www tags/web_info', url: (t: string) => `${IG_ORIGIN}/api/v1/tags/web_info/?tag_name=${encodeURIComponent(t)}` }, // 200
        { name: 'i tags/{tag}/sections', url: (t: string) => `${IG_API_ORIGIN}/api/v1/tags/${encodeURIComponent(t)}/sections/` }, // legacy (POST on mobile; GET may 405)
    ],
    search: [
        { name: 'www web/search/topsearch', url: (q: string) => `${IG_ORIGIN}/api/v1/web/search/topsearch/?context=blended&query=${encodeURIComponent(q)}` }, // 404 without context param
        { name: 'i fbsearch/topsearch_flat', url: (q: string) => `${IG_API_ORIGIN}/api/v1/fbsearch/topsearch_flat/?query=${encodeURIComponent(q)}&context=blended` }, // legacy
        { name: 'i users/search', url: (q: string) => `${IG_API_ORIGIN}/api/v1/users/search/?q=${encodeURIComponent(q)}` }, // legacy
    ],

    // --- uploads (rupload; host and headers from the live upload module) --------
    ruploadPhoto: (entity: string) => `${IG_UPLOAD_ORIGIN}/rupload_igphoto/${entity}`, // bundle
    ruploadVideo: (entity: string) => `${IG_UPLOAD_ORIGIN}/rupload_igvideo/${entity}`, // bundle

    // --- publish --------------------------------------------------------------
    configurePhoto: `${IG_ORIGIN}/api/v1/media/configure/`, // bundle
    configureSidecar: `${IG_ORIGIN}/api/v1/media/configure_sidecar/`, // bundle
    configureClips: `${IG_ORIGIN}/api/v1/media/configure_to_clips/`, // bundle
    configureStory: `${IG_ORIGIN}/api/v1/media/configure_to_story/`, // bundle

    // --- manage ---------------------------------------------------------------
    editMedia: (pk: string) => `${IG_ORIGIN}/api/v1/media/${pk}/edit_media/`, // bundle
    addComment: [
        { name: 'www web/comments/{id}/add', url: (pk: string) => `${IG_ORIGIN}/api/v1/web/comments/${pk}/add/` }, // legacy web
        { name: 'i media/{id}/comment', url: (pk: string) => `${IG_API_ORIGIN}/api/v1/media/${pk}/comment/` }, // legacy mobile
    ],
} as const;

/** Endpoints `probe` checks with a harmless GET, in order. Kept short on purpose: every probe is a request. */
export function probeTargets(userId: string, username: string | null): { name: string; url: string }[] {
    const out: { name: string; url: string }[] = [
        { name: E.currentUser[0].name, url: E.currentUser[0].url },
        { name: E.userInfo[0].name, url: E.userInfo[0].url(userId) },
        { name: E.userFeed[0].name, url: `${E.userFeed[0].url(userId)}?count=1` },
        { name: E.hashtag[0].name, url: E.hashtag[0].url('instagram') },
    ];
    if (username) out.splice(1, 0, { name: E.profileByUsername[0].name, url: E.profileByUsername[0].url(username) });
    return out;
}
