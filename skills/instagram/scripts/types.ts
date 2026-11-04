export type LogFn = (message: string) => void;

export interface CookieFileV1 {
    version: 1;
    updatedAt: string;
    cookieMap: Record<string, string>;
}

export interface RuntimeConfig {
    appId: string;
    asbdId: string;
    /** X-IG-WWW-Claim, returned by Instagram in the `x-ig-set-www-claim` header. */
    wwwClaim?: string;
    updatedAt?: string;
}

export type MediaKind = 'photo' | 'video';

export interface MediaFacts {
    path: string;
    kind: MediaKind;
    mime: string;
    bytes: number;
    width: number;
    height: number;
    /** Video only, milliseconds. */
    durationMs?: number;
    /** Video only, e.g. "avc1" / "hvc1". */
    codec?: string;
    hasAudio?: boolean;
}

/** One normalized post, independent of which endpoint returned it. */
export interface Post {
    id: string;
    pk: string;
    shortcode: string;
    url: string;
    /** feed | carousel | reel | igtv | story */
    format: 'photo' | 'carousel' | 'reel' | 'video' | 'unknown';
    takenAt: string;
    caption: string;
    likes: number | null;
    comments: number | null;
    /** Reels: plays (`play_count` / `ig_play_count`); null when hidden. */
    plays: number | null;
    views: number | null;
    durationSec: number | null;
    owner?: string;
    hashtags: string[];
}

export interface Profile {
    pk: string;
    username: string;
    fullName: string;
    biography: string;
    externalUrl: string | null;
    bioLinks: string[];
    followers: number | null;
    following: number | null;
    mediaCount: number | null;
    isPrivate: boolean;
    isVerified: boolean;
    isBusiness: boolean;
    category: string | null;
    profilePicUrl: string | null;
}

export interface Comment {
    pk: string;
    text: string;
    user: string;
    createdAt: string;
    likes: number;
    replies: number;
}
