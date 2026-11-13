// instagram skill: invisible story mentions. Pure functions only; nothing here proves what
// Instagram does with the fields (that needs one approved live post).
import { describe, expect, test } from 'bun:test';
import { DEFAULT_MENTION_AREA, checkStoryMentions, mentionReadBack, parseMentionList, storyMentionFields } from '../../skills/instagram/scripts/publish.ts';

describe('story mentions', () => {
    test('a malformed --mention is an error, never an ordinary story', () => {
        expect(parseMentionList(undefined)).toEqual([]);
        expect(parseMentionList('@Ana.O, bob_1 ,ana.o')).toEqual(['ana.o', 'bob_1']);
        for (const bad of ['', ',,', 'a,,b', true as const, 'has space', 'x'.repeat(31), 'a/b']) expect(() => parseMentionList(bad)).toThrow();
        expect(() => parseMentionList(Array.from({ length: 11 }, (_, i) => 'u' + i).join(','))).toThrow(/at most 10/);
    });
    test('no mentions adds no fields', () => {
        expect(storyMentionFields([])).toEqual({});
    });
    test('fields: numeric ids, de-duplicated, stacked, non-sticker mention entries, same JSON in both fields', () => {
        const f = storyMentionFields([{ username: 'a', userId: '11' }, { username: 'b', userId: '22' }, { username: 'a', userId: '11' }]);
        expect(Object.keys(f).sort()).toEqual(['reel_mentions', 'tap_models']);
        expect(f.tap_models).toBe(f.reel_mentions);
        const list = JSON.parse(f.reel_mentions);
        expect(list.map((m: any) => m.user_id)).toEqual(['11', '22']);
        expect(list[0]).toEqual({ x: 0.5, y: 0.93, z: 0, width: 0.4, height: 0.05, rotation: 0, type: 'mention', user_id: '11', is_sticker: false, display_type: 'mention_username' });
        expect(list[1].y).toBeLessThan(list[0].y - list[0].height + 0.001);
    });
    test('ten mentions with the default area stay inside the story without overlapping', () => {
        const list = JSON.parse(storyMentionFields(Array.from({ length: 10 }, (_, i) => ({ username: 'u' + i, userId: String(i + 1) }))).reel_mentions);
        for (let i = 0; i < list.length; i++) {
            expect(list[i].y - list[i].height / 2).toBeGreaterThanOrEqual(0);
            if (i) expect(list[i - 1].y - list[i].y).toBeGreaterThanOrEqual(list[i].height);
        }
    });
    test('validation: ids, area, limit, and warnings that name the recipients and do not promise invisibility', () => {
        const c = { errors: [] as string[], warnings: [] as string[] };
        checkStoryMentions([{ username: 'x', userId: 'abc' }], { x: 0.5, y: 1.2, width: 0.4, height: 0.05 }, c);
        expect(c.errors.join(' ')).toMatch(/not numeric/);
        expect(c.errors.join(' ')).toMatch(/between 0 and 1/);
        const zero = { errors: [] as string[], warnings: [] as string[] };
        checkStoryMentions([{ username: 'x', userId: '1' }], { x: 0.5, y: 0.5, width: 0, height: 0.05 }, zero);
        expect(zero.errors.join(' ')).toMatch(/greater than 0/);
        const outside = { errors: [] as string[], warnings: [] as string[] };
        checkStoryMentions([{ username: 'x', userId: '1' }], { x: 0.95, y: 0.5, width: 0.4, height: 0.05 }, outside);
        expect(outside.errors.join(' ')).toMatch(/inside the story/);
        const ok = { errors: [] as string[], warnings: [] as string[] };
        checkStoryMentions([{ username: 'ana', userId: '1' }], DEFAULT_MENTION_AREA, ok);
        expect(ok.errors).toEqual([]);
        expect(ok.warnings.join(' ')).toMatch(/@ana/);
        expect(ok.warnings.join(' ')).toMatch(/notified/);
        expect(ok.warnings.join(' ')).toMatch(/NOT verified/);
        const none = { errors: [] as string[], warnings: [] as string[] };
        checkStoryMentions([], DEFAULT_MENTION_AREA, none);
        expect(none).toEqual({ errors: [], warnings: [] });
    });
    test('read-back distinguishes confirmed, partial, not kept and unknown', () => {
        const req = [{ username: 'a', userId: '11' }, { username: 'b', userId: '22' }];
        expect(mentionReadBack(req, { reel_mentions: [{ user: { pk: '11' } }, { user: { pk: 22 } }] }).outcome).toBe('confirmed');
        const partial = mentionReadBack(req, { reel_mentions: [{ user: { pk: '11' } }] });
        expect(partial).toMatchObject({ outcome: 'partial', kept: ['@a'] });
        expect(partial.note).toMatch(/do not post again/);
        expect(mentionReadBack(req, { reel_mentions: [] }).outcome).toBe('not_kept');
        const unknown = mentionReadBack(req, { pk: '1' });
        expect(unknown.outcome).toBe('unknown');
        expect(unknown.note).toMatch(/Do not post again/);
    });
});
