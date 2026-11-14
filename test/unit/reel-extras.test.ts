// instagram skill: reel tags, collaborator invites and the AI label. The field names come from the
// live web client's request builder (2026-11-12); these tests pin the shapes, not Instagram's behaviour.
import { describe, expect, test } from 'bun:test';
import { aiLabelReadBack, approvalKey, readConfigureAnswer, checkReelExtras, isAccountSignal, parseHandleList, recipientsKey, reelExtraFields, reelExtrasReadBack, unsupportedFlags } from '../../skills/instagram/scripts/publish.ts';
import { nestedErrorKind, resolveKind } from '../../skills/instagram/scripts/client.ts';

const A = { username: 'ana', userId: '11' };
const B = { username: 'bob', userId: '22' };

describe('reel extras', () => {
    test('nothing requested adds nothing', () => {
        expect(reelExtraFields({})).toEqual({});
        expect(reelExtraFields({ tags: [], collaborators: [], aiLabel: false })).toEqual({});
    });
    test('field shapes match the web client', () => {
        const f = reelExtraFields({ tags: [A, B, A], collaborators: [B], aiLabel: true });
        expect(JSON.parse(String(f.usertags))).toEqual({ in: [{ user_id: '11' }, { user_id: '22' }] });
        expect(JSON.parse(String(f.invite_coauthor_user_ids_string))).toEqual(['22']);
        expect(f.is_gen_ai_self_disclosure).toBe(true);
        expect(f.gen_ai_detection_method).toBe('SELF_DISCLOSURE_FLOW');
    });
    test('handle lists: empty or invalid input is an error', () => {
        expect(parseHandleList('tag', undefined, 20)).toEqual([]);
        expect(parseHandleList('tag', '@Ana, bob ,ana', 20)).toEqual(['ana', 'bob']);
        for (const bad of ['', ',', 'a,,b', true as const, 'a b']) expect(() => parseHandleList('tag', bad, 20)).toThrow(/--tag|valid/);
        expect(() => parseHandleList('collab', 'a,b,c', 2)).toThrow(/at most 2/);
    });
    test('validation names the recipients and says the fields are unconfirmed', () => {
        const c = { errors: [] as string[], warnings: [] as string[] };
        checkReelExtras({ tags: [A], collaborators: [B], aiLabel: true }, c);
        expect(c.errors).toEqual([]);
        expect(c.warnings.join(' ')).toMatch(/@ana/);
        expect(c.warnings.join(' ')).toMatch(/@bob/);
        expect(c.warnings.join(' ')).toMatch(/never confirmed/);
        const bad = { errors: [] as string[], warnings: [] as string[] };
        checkReelExtras({ tags: [{ username: 'x', userId: 'abc' }] }, bad);
        expect(bad.errors.join(' ')).toMatch(/not numeric/);
        const none = { errors: [] as string[], warnings: [] as string[] };
        checkReelExtras({}, none);
        expect(none).toEqual({ errors: [], warnings: [] });
    });
    test('read-back: confirmed, partial, not kept, unknown', () => {
        const o = { tags: [A, B], collaborators: [B], aiLabel: true };
        const full = reelExtrasReadBack(o, { usertags: { in: [{ user: { pk: '11' } }, { user: { pk: 22 } }] }, invited_coauthor_producers: [{ pk: '22' }], gen_ai_detection_method: 'SELF_DISCLOSURE_FLOW' });
        expect(full.tags!.outcome).toBe('confirmed');
        expect(full.collaborators!.outcome).toBe('confirmed');
        expect(full.aiLabel!.outcome).toBe('confirmed');
        const partial = reelExtrasReadBack(o, { usertags: { in: [{ user: { pk: '11' } }] }, coauthor_producers: [], ai_label_info: null });
        expect(partial.tags).toMatchObject({ outcome: 'partial', kept: ['@ana'] });
        expect(partial.collaborators!.outcome).toBe('not_kept');
        expect(partial.aiLabel!.outcome).toBe('not_observed');
        const unknown = reelExtrasReadBack(o, { pk: '1' });
        expect(unknown.tags!.outcome).toBe('unknown');
        expect(unknown.collaborators!.outcome).toBe('unknown');
        expect(unknown.aiLabel!.outcome).toBe('unknown');
        expect(unknown.note).toMatch(/do not post again/);
    });
    test('approval key is canonical: order and case do not matter, ids do', () => {
        expect(recipientsKey([B, A])).toBe('ana=11,bob=22');
        expect(recipientsKey([{ username: 'Ana', userId: '11' }, B, A])).toBe('ana=11,bob=22');
        expect(recipientsKey([{ username: 'ana', userId: '99' }])).not.toBe(recipientsKey([A]));
        expect(recipientsKey([])).toBe('');
    });
    test('a flag the post kind does not support is reported, so it can never be dropped silently', () => {
        expect(unsupportedFlags('reel', { tag: 'a', 'ai-label': true })).toEqual([]);
        expect(unsupportedFlags('reel', { mention: 'a' })).toEqual(['mention']);
        expect(unsupportedFlags('story', { tag: 'a', collab: 'b', mention: 'c' })).toEqual(['tag', 'collab']);
        expect(unsupportedFlags('photo', { 'ai-label': true, tag: 'a' })).toEqual(['tag', 'ai-label']);
        expect(unsupportedFlags('carousel', { 'ai-label': false })).toEqual([]);
        expect(unsupportedFlags('photo', {})).toEqual([]);
    });
    test('approval covers role, account, files, caption and AI label', () => {
        const base = { account: '@Me', kind: 'reel', files: [{ name: 'a.mp4', bytes: 10 }], caption: 'hi', aiLabel: true, roles: { tag: [A], collab: [], mention: [] } };
        const k = approvalKey(base);
        expect(k).toMatch(/^tag:ana=11#[0-9a-f]{10}$/);
        expect(approvalKey({ ...base, account: 'me' })).toBe(k);
        expect(approvalKey({ ...base, roles: { tag: [], collab: [A], mention: [] } })).not.toBe(k);
        expect(approvalKey({ ...base, account: 'other' })).not.toBe(k);
        expect(approvalKey({ ...base, caption: 'hi!' })).not.toBe(k);
        expect(approvalKey({ ...base, aiLabel: false })).not.toBe(k);
        expect(approvalKey({ ...base, files: [{ name: 'a.mp4', bytes: 11 }] })).not.toBe(k);
        expect(approvalKey({ ...base, kind: 'story' })).not.toBe(k);
    });
    test('AI label read-back confirms only the detection-method property', () => {
        expect(aiLabelReadBack({ gen_ai_detection_method: 'SELF_DISCLOSURE_FLOW' }).outcome).toBe('confirmed');
        expect(aiLabelReadBack({ ai_label_info: { gen_ai_detection_method: 'self_disclosure' } }).outcome).toBe('confirmed');
        expect(aiLabelReadBack({ ai_label_info: { subtitle_text: 'SELF_DISCLOSURE_FLOW' } }).outcome).toBe('unknown');
        expect(aiLabelReadBack({ ai_label_info: { subtitle_text: 'AI info' } }).outcome).toBe('unknown');
        expect(aiLabelReadBack({ ai_label_info: {} }).outcome).toBe('not_observed');
        expect(aiLabelReadBack({ ai_label_info: null }).outcome).toBe('not_observed');
        expect(aiLabelReadBack({ pk: '1' }).outcome).toBe('unknown');
        expect(aiLabelReadBack(null).outcome).toBe('unknown');
    });
    test('approval changes with the content digest', () => {
        const base = { account: 'me', kind: 'reel', files: [{ name: 'a.mp4', bytes: 10 }], caption: 'hi', aiLabel: true, roles: { tag: [A] } };
        expect(approvalKey({ ...base, digest: 'aa' })).not.toBe(approvalKey({ ...base, digest: 'bb' }));
    });
    test('configure answers: media, completed medias entry, pending, error, empty', () => {
        expect(readConfigureAnswer({ media: { pk: '5' } })).toMatchObject({ state: 'done', media: { pk: '5' } });
        expect(readConfigureAnswer({ medias: [{ status: 'COMPLETED', media_dict: { pk: 7 } }] })).toMatchObject({ state: 'done', media: { pk: 7 } });
        expect(readConfigureAnswer({ pk: '9', code: 'X' }).state).toBe('done');
        expect(readConfigureAnswer({ medias: [{ status: 'PENDING' }] }).state).toBe('pending');
        expect(readConfigureAnswer({ posts: [{ status: 'ERROR' }], medias: [{ status: 'PENDING' }] }).state).toBe('error');
        expect(readConfigureAnswer({ media: { pk: '0' } }).state).toBe('empty');
        expect(readConfigureAnswer({}).state).toBe('empty');
        expect(readConfigureAnswer(null).state).toBe('empty');
    });
    test('account signals are recognised; other errors are not', () => {
        expect(isAccountSignal(new Error('x'))).toBe(false);
    });
    test('a nested ERROR entry is terminal and keeps its account signal, even on HTTP 202', () => {
        expect(nestedErrorKind(202, { medias: [{ status: 'ERROR', error_info: { error_type: 'login_required', message: 'login_required' } }] })).toBe('not_logged_in');
        expect(nestedErrorKind(202, { posts: [{ status: 'ERROR', error_info: { error_type: 'x', message: 'checkpoint_required' } }] })).toBe('checkpoint');
        expect(nestedErrorKind(202, { medias: [{ status: 'error' }] })).toBe('bad_request');
        expect(nestedErrorKind(202, { medias: [{ status: 'ERROR', error_info: { message: 'Transcode not finished yet.' } }] })).toBe('bad_request');
        expect(nestedErrorKind(202, { medias: [{ status: 'PENDING' }] })).toBeNull();
        expect(nestedErrorKind(202, {})).toBeNull();
        expect(readConfigureAnswer({ media: { pk: '5' }, medias: [{ status: 'ERROR' }] }).state).toBe('error');
    });
    test('an account signal anywhere beats "still processing"', () => {
        const login = { status: 'ERROR', error_info: { error_type: 'login_required' } };
        expect(resolveKind(202, { status: 'in_progress', medias: [login] }, true)).toBe('not_logged_in');
        expect(resolveKind(202, { medias: [{ status: 'ERROR', error_info: { message: 'x' } }, { status: 'ERROR', error_info: { message: 'checkpoint_required' } }] }, true)).toBe('checkpoint');
        expect(resolveKind(202, { message: 'feedback_required', medias: [{ status: 'PENDING' }] }, true)).toBe('feedback_required');
        expect(resolveKind(202, { status: 'in_progress', medias: [{ status: 'ERROR' }] }, true)).toBe('bad_request');
        expect(resolveKind(202, {}, true)).toBe('transcode_pending');
        expect(resolveKind(202, { medias: [{ status: 'PENDING' }] }, true)).toBe('transcode_pending');
        expect(resolveKind(202, {}, false)).toBeNull();
        expect(resolveKind(200, { media: { pk: '1' }, status: 'ok' }, true)).toBeNull();
    });
});
