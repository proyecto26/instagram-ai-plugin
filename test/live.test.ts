/**
 * Live tests against a real Instagram account. They never run by default.
 *
 *   INSTAGRAM_LIVE=1 bun test live.test.ts
 *
 * Read-only. The plugin has no delete, so an automated write test would leave a
 * post behind; writes are verified by hand (dry run, --confirm --account, read back)
 * and recorded in CONTRACTS in skills/instagram/scripts/publish.ts.
 * The session comes from the normal cookie file (run `login` first) or INSTAGRAM_COOKIES.
 */
import { describe, expect, test } from 'bun:test';
import { IgClient } from '../skills/instagram/scripts/client.ts';
import { getPosts, whoami } from '../skills/instagram/scripts/read.ts';

const LIVE = process.env.INSTAGRAM_LIVE === '1';
const log = (m: string) => process.stderr.write(`${m}\n`);

describe.skipIf(!LIVE)('live read', () => {
    test('whoami and own posts', async () => {
        const c = await IgClient.create({ log });
        try {
            const me = await whoami(c);
            expect(me.profile.username).toBeTruthy();
            const { posts, via } = await getPosts(c, null, 6);
            log(`[live] posts via ${via}: ${posts.length}`);
            expect(Array.isArray(posts)).toBe(true);
        } finally {
            await c.flush();
        }
    }, 60_000);
});
