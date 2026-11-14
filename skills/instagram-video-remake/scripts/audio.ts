/**
 * Finds where a short clip's sound sits inside a longer recording of the same track, so a remake that runs
 * longer than its reference can carry the music on instead of looping it.
 *
 * Two passes of normalised cross-correlation. The coarse pass compares loudness envelopes (100 values per
 * second) and keeps the few best places: music repeats, so the envelope alone cannot tell a chorus from its
 * repeat. The fine pass compares the waveform itself around each of those places and picks the one that lines
 * up. Pure functions; decoding is in ff.ts.
 */

export const FINE_RATE = 8000;
const COARSE_STEP = FINE_RATE / 100;

/** RMS loudness per window of `step` samples. */
export function envelope(x: Float32Array, step: number): Float32Array {
    const n = Math.floor(x.length / step);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        let s = 0;
        for (let j = i * step, e = j + step; j < e; j++) s += x[j] * x[j];
        out[i] = Math.sqrt(s / step);
    }
    return out;
}

/** Normalised correlation of `needle` against `hay` at every lag in [from, to]. */
export function scores(hay: Float32Array, needle: Float32Array, from: number, to: number): Array<[lag: number, score: number]> {
    const n = needle.length;
    let nMean = 0;
    for (let i = 0; i < n; i++) nMean += needle[i];
    nMean /= n;
    let nVar = 0;
    for (let i = 0; i < n; i++) nVar += (needle[i] - nMean) ** 2;
    const out: Array<[number, number]> = [];
    for (let lag = Math.max(0, from); lag <= Math.min(to, hay.length - n); lag++) {
        let hMean = 0;
        for (let i = 0; i < n; i++) hMean += hay[lag + i];
        hMean /= n;
        let num = 0;
        let hVar = 0;
        for (let i = 0; i < n; i++) {
            const h = hay[lag + i] - hMean;
            num += h * (needle[i] - nMean);
            hVar += h * h;
        }
        out.push([lag, hVar > 0 && nVar > 0 ? num / Math.sqrt(hVar * nVar) : 0]);
    }
    return out;
}

/** The `k` highest scores that are at least `guard` lags apart. */
export function peaks(list: Array<[number, number]>, k: number, guard: number): Array<[number, number]> {
    const sorted = [...list].sort((a, b) => b[1] - a[1]);
    const out: Array<[number, number]> = [];
    for (const s of sorted) {
        if (out.length >= k) break;
        if (out.every((p) => Math.abs(p[0] - s[0]) > guard)) out.push(s);
    }
    return out;
}

/** Best lag of `needle` inside `hay` within [from, to]. */
export function correlate(hay: Float32Array, needle: Float32Array, from: number, to: number): { lag: number; score: number } {
    const [best] = peaks(scores(hay, needle, from, to), 1, 0);
    return best ? { lag: best[0], score: best[1] } : { lag: -1, score: 0 };
}

export interface OffsetResult {
    /** Seconds into the long recording where the clip's sound starts. */
    offset: number;
    /** Correlation of the waveforms at that position (1 = identical). */
    score: number;
    /** Waveform correlation at the next best candidate place. A close second means the match is ambiguous. */
    runnerUp: number;
    verdict: 'match' | 'weak' | 'no_match';
}

/**
 * `track` and `clip` are mono PCM at FINE_RATE. `verdict` is "match" only when the waveform itself lines up
 * (score >= 0.6) and clearly better than at any other candidate place (by 0.1 or more).
 */
export function findOffset(track: Float32Array, clip: Float32Array): OffsetResult {
    const none: OffsetResult = { offset: -1, score: 0, runnerUp: 0, verdict: 'no_match' };
    if (clip.length < FINE_RATE || track.length < clip.length) return none;
    const candidates = peaks(scores(envelope(track, COARSE_STEP), envelope(clip, COARSE_STEP), 0, Number.MAX_SAFE_INTEGER), 5, 50);
    if (!candidates.length) return none;
    // Fine pass on at most the first 6 seconds of the clip, +/- two coarse steps around each candidate.
    const needle = clip.subarray(0, Math.min(clip.length, FINE_RATE * 6));
    const fine = candidates.map(([lag]) => correlate(track, needle, lag * COARSE_STEP - 2 * COARSE_STEP, lag * COARSE_STEP + 2 * COARSE_STEP)).sort((a, b) => b.score - a.score);
    const best = fine[0];
    const runnerUp = Math.max(0, fine[1]?.score ?? 0);
    const verdict = best.score >= 0.6 && best.score - runnerUp >= 0.1 ? 'match' : best.score >= 0.3 ? 'weak' : 'no_match';
    return { offset: best.lag / FINE_RATE, score: best.score, runnerUp, verdict };
}
