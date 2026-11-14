/**
 * Audio measurements without any model: loudness, silence, an onset envelope, a gated tempo
 * estimate and how many cuts land on beats/onsets.
 *
 * These are measured facts. None of them says whether music or a voice is present: a click
 * track has rhythm, and a speech-band cue is only a cue.
 */
import path from 'node:path';

import { ffmpeg, run } from './ff.ts';

export const SR = 22050;
export const FFT_N = 1024;
export const HOP = 512;
export const ENV_RATE = SR / HOP;
/** Reported tempo range. Outside it there is no result rather than an alias. */
export const TEMPO = { min: 60, max: 180 };
/** Smallest envelope value (summed log-magnitude flux) that can be an onset. */
export const ONSET_FLOOR = 0.5;
export const GATE = { minDuration: 4, silentDb: -60, minOnsets: 8, periodicity: 0.15, beatStrength: 2.0, consistency: 0.5, tolerance: 0.08 };

/** In-place radix-2 FFT. `re` and `im` must have a power-of-two length. */
export function fft(re: Float64Array, im: Float64Array): void {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
        let bit = n >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) {
            [re[i], re[j]] = [re[j], re[i]];
            [im[i], im[j]] = [im[j], im[i]];
        }
    }
    for (let len = 2; len <= n; len <<= 1) {
        const ang = (-2 * Math.PI) / len;
        const wr = Math.cos(ang);
        const wi = Math.sin(ang);
        for (let i = 0; i < n; i += len) {
            let cr = 1;
            let ci = 0;
            for (let k = 0; k < len / 2; k++) {
                const a = i + k;
                const b = a + len / 2;
                const tr = re[b] * cr - im[b] * ci;
                const ti = re[b] * ci + im[b] * cr;
                re[b] = re[a] - tr;
                im[b] = im[a] - ti;
                re[a] += tr;
                im[a] += ti;
                const ncr = cr * wr - ci * wi;
                ci = cr * wi + ci * wr;
                cr = ncr;
            }
        }
    }
}

export async function decodeMono(video: string, rate = SR): Promise<Float32Array> {
    const r = await ffmpeg(['-i', video, '-vn', '-ac', '1', '-ar', String(rate), '-f', 'f32le', '-']);
    const buf = r.stdout;
    return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4)).slice();
}

export function rmsDb(x: Float32Array): number {
    if (!x.length) return -Infinity;
    let s = 0;
    for (let i = 0; i < x.length; i++) s += x[i] * x[i];
    const rms = Math.sqrt(s / x.length);
    return rms > 0 ? 20 * Math.log10(rms) : -Infinity;
}

export interface Envelope {
    env: Float64Array;
    /** Share of non-silent frames whose 300-3400 Hz band holds over 60 % of the energy. */
    speechBandRatio: number | null;
}

/** Positive log-spectral flux, minus a 0.5 s moving mean, clipped at zero. */
export function onsetEnvelope(x: Float32Array): Envelope {
    const frames = x.length >= FFT_N ? 1 + Math.floor((x.length - FFT_N) / HOP) : 0;
    const win = new Float64Array(FFT_N);
    for (let i = 0; i < FFT_N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_N - 1));
    const bins = FFT_N / 2;
    const flux = new Float64Array(frames);
    let prev = new Float64Array(bins);
    const re = new Float64Array(FFT_N);
    const im = new Float64Array(FFT_N);
    const lo = Math.round((300 * FFT_N) / SR);
    const hi = Math.round((3400 * FFT_N) / SR);
    let voiced = 0;
    let loud = 0;
    for (let f = 0; f < frames; f++) {
        let e = 0;
        for (let i = 0; i < FFT_N; i++) {
            const v = x[f * HOP + i];
            re[i] = v * win[i];
            im[i] = 0;
            e += v * v;
        }
        fft(re, im);
        const cur = new Float64Array(bins);
        let sum = 0;
        let band = 0;
        let total = 0;
        for (let k = 0; k < bins; k++) {
            const p = re[k] * re[k] + im[k] * im[k];
            total += p;
            if (k >= lo && k <= hi) band += p;
            cur[k] = Math.log1p(Math.sqrt(p));
            const d = cur[k] - prev[k];
            if (d > 0) sum += d;
        }
        flux[f] = f === 0 ? 0 : sum;
        prev = cur;
        if (Math.sqrt(e / FFT_N) > 0.0056) {
            // about -45 dBFS
            loud++;
            if (total > 0 && band / total > 0.6) voiced++;
        }
    }
    const half = Math.max(1, Math.round((0.5 * ENV_RATE) / 2));
    const env = new Float64Array(frames);
    const prefix = new Float64Array(frames + 1);
    for (let i = 0; i < frames; i++) prefix[i + 1] = prefix[i] + flux[i];
    for (let i = 0; i < frames; i++) {
        const a = Math.max(0, i - half);
        const b = Math.min(frames, i + half + 1);
        env[i] = Math.max(0, flux[i] - (prefix[b] - prefix[a]) / (b - a));
    }
    return { env, speechBandRatio: loud ? Math.round((voiced / loud) * 1000) / 1000 : null };
}

/** Local maxima above mean + 1.5 std, at least 60 ms apart. Returns times in seconds. */
export function pickOnsets(env: Float64Array, rate = ENV_RATE): number[] {
    const n = env.length;
    if (n < 3) return [];
    let mean = 0;
    for (let i = 0; i < n; i++) mean += env[i];
    mean /= n;
    let v = 0;
    for (let i = 0; i < n; i++) v += (env[i] - mean) ** 2;
    // The floor keeps numerical ripple of a steady tone from counting as onsets.
    const thr = Math.max(mean + 1.5 * Math.sqrt(v / n), ONSET_FLOOR);
    const minGap = Math.max(1, Math.round(0.06 * rate));
    const out: number[] = [];
    let lastIdx = -Infinity;
    for (let i = 1; i < n - 1; i++) {
        if (env[i] > thr && env[i] >= env[i - 1] && env[i] > env[i + 1]) {
            if (i - lastIdx < minGap) {
                if (env[i] > env[lastIdx as number]) {
                    out[out.length - 1] = i / rate;
                    lastIdx = i;
                }
                continue;
            }
            out.push(i / rate);
            lastIdx = i;
        }
    }
    return out;
}

export interface Rhythm {
    bpm: number;
    periodicity: number;
    beat_strength: number;
    beat_consistency: number;
    phase_s: number;
    beats: number[];
}

export type RhythmReason = 'too_short' | 'silent_stream' | 'few_onsets' | 'weak_rhythm';

/**
 * Tempo from the autocorrelation of the onset envelope over 60-180 BPM, refined to a fractional
 * period (parabola around the best lag, then a least-squares fit of the onsets that sit on the
 * grid). Returns null with a reason unless the periodicity is real: an absolute ACF value, a
 * relative strength and a share of beats that actually have an onset must all pass.
 */
export function estimateRhythm(env: Float64Array, onsets: number[], duration: number, levelDb: number, rate = ENV_RATE): { rhythm: Rhythm | null; reason: RhythmReason | null; periodicity: number | null; beat_strength: number | null } {
    const none = (reason: RhythmReason, periodicity: number | null = null, strength: number | null = null) => ({ rhythm: null, reason, periodicity, beat_strength: strength });
    if (duration < GATE.minDuration) return none('too_short');
    if (!(levelDb > GATE.silentDb)) return none('silent_stream');
    if (onsets.length < GATE.minOnsets) return none('few_onsets');

    const n = env.length;
    let mean = 0;
    for (let i = 0; i < n; i++) mean += env[i];
    mean /= n;
    let energy = 0;
    for (let i = 0; i < n; i++) energy += (env[i] - mean) ** 2;
    if (!(energy > 0)) return none('weak_rhythm');
    // Integer lags that bracket 60-180 BPM; a result outside that range is rejected at the end.
    const lagMin = Math.floor((rate * 60) / 180);
    const lagMax = Math.ceil((rate * 60) / 60);
    const acf = (lag: number) => {
        let s = 0;
        for (let i = 0; i + lag < n; i++) s += (env[i] - mean) * (env[i + lag] - mean);
        return s / energy;
    };
    const vals = new Map<number, number>();
    for (let l = lagMin - 1; l <= lagMax + 1; l++) vals.set(l, acf(l));
    let max = -Infinity;
    let absSum = 0;
    for (let l = lagMin; l <= lagMax; l++) {
        const v = vals.get(l)!;
        max = Math.max(max, v);
        absSum += Math.abs(v);
    }
    const target = (rate * 60) / 120;
    let best = lagMin;
    let bestDist = Infinity;
    for (let l = lagMin; l <= lagMax; l++) {
        const v = vals.get(l)!;
        if (v >= max - 0.01 * Math.abs(max) && Math.abs(l - target) < bestDist) {
            best = l;
            bestDist = Math.abs(l - target);
        }
    }
    // A period that falls between two integer lags splits its peak, while a multiple of that
    // period may land on one lag and look stronger. Prefer the faster tempo (a third, then a half
    // of the lag) when its two neighbouring lags together carry most of that strength.
    for (const k of [3, 2]) {
        const part = best / k;
        if (part < lagMin) continue;
        const lo = Math.floor(part);
        const hi = Math.ceil(part);
        if (lo < lagMin) continue;
        const vl = vals.get(lo)!;
        const vh = vals.get(hi)!;
        if ((lo === hi ? vl : vl + vh) >= 0.6 * vals.get(best)!) {
            best = vl >= vh ? lo : hi;
            max = Math.max(vl, vh);
            break;
        }
    }
    const meanAbs = absSum / (lagMax - lagMin + 1);
    const periodicity = r3(max);
    const strength = meanAbs > 0 ? r3(max / meanAbs) : null;
    if (strength === null || max < GATE.periodicity || strength < GATE.beatStrength) return none('weak_rhythm', periodicity, strength);

    const a = vals.get(best - 1)!;
    const b = vals.get(best)!;
    const c = vals.get(best + 1)!;
    const denom = a - 2 * b + c;
    const delta = denom < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / denom)) : 0;
    let period = (best + delta) / rate;

    // Phase: the offset whose grid collects the most envelope.
    const sample = (t: number) => {
        const x = t * rate;
        const i = Math.floor(x);
        if (i < 0 || i + 1 >= n) return 0;
        return env[i] + (env[i + 1] - env[i]) * (x - i);
    };
    const phaseFor = (p: number) => {
        let bestPhase = 0;
        let bestScore = -Infinity;
        const steps = Math.max(8, Math.round(p * rate * 2));
        for (let k = 0; k < steps; k++) {
            const ph = (k / steps) * p;
            let s = 0;
            for (let t = ph; t < duration; t += p) s += sample(t);
            if (s > bestScore) {
                bestScore = s;
                bestPhase = ph;
            }
        }
        return bestPhase;
    };
    let phase = phaseFor(period);
    // Least squares on the onsets that sit on the grid: removes the integer-lag quantisation.
    for (let pass = 0; pass < 2; pass++) {
        const pts: Array<[number, number]> = [];
        for (const t of onsets) {
            const k = Math.round((t - phase) / period);
            if (Math.abs(t - (phase + k * period)) <= GATE.tolerance) pts.push([k, t]);
        }
        if (pts.length < 6) break;
        const mk = pts.reduce((s, p) => s + p[0], 0) / pts.length;
        const mt = pts.reduce((s, p) => s + p[1], 0) / pts.length;
        const sxx = pts.reduce((s, p) => s + (p[0] - mk) ** 2, 0);
        if (!(sxx > 0)) break;
        const slope = pts.reduce((s, p) => s + (p[0] - mk) * (p[1] - mt), 0) / sxx;
        if (!(slope >= 60 / TEMPO.max && slope <= 60 / TEMPO.min)) break;
        period = slope;
        const intercept = mt - slope * mk;
        phase = ((intercept % period) + period) % period;
    }
    const beats: number[] = [];
    for (let t = phase; t < duration; t += period) beats.push(r3(t));
    const hit = beats.filter((bt) => onsets.some((o) => Math.abs(o - bt) <= GATE.tolerance)).length;
    const consistency = beats.length ? hit / beats.length : 0;
    const bpm = 60 / period;
    if (consistency < GATE.consistency || bpm < TEMPO.min - 0.5 || bpm > TEMPO.max + 0.5) return none('weak_rhythm', periodicity, strength);
    return {
        rhythm: { bpm: Math.round(bpm * 10) / 10, periodicity, beat_strength: strength, beat_consistency: r3(consistency), phase_s: r3(phase), beats },
        reason: null,
        periodicity,
        beat_strength: strength,
    };
}

/** Share of `cuts` that have a `marks` entry within the tolerance; null when either list is empty. */
export function alignedRatio(cuts: number[], marks: number[], tolerance = GATE.tolerance): number | null {
    if (!cuts.length || !marks.length) return null;
    return r3(cuts.filter((c) => marks.some((m) => Math.abs(m - c) <= tolerance)).length / cuts.length);
}

export interface AudioFacts {
    present: boolean;
    duration: number | null;
    integrated_lufs: number | null;
    rms_dbfs: number | null;
    silence_ratio: number | null;
    onsets: number[] | null;
    rhythm: Rhythm | null;
    rhythm_reason: RhythmReason | null;
    periodicity: number | null;
    beat_strength: number | null;
    cuts_on_beat_ratio: number | null;
    cuts_on_onset_ratio: number | null;
    speech_band_ratio: number | null;
    waveform: string | null;
    wav: string | null;
    note: string;
}

const NOTE = 'Measured facts only. Rhythm, loudness and the speech-band cue do not establish that music or a voice is present.';

export function absentAudio(): AudioFacts {
    return {
        present: false, duration: null, integrated_lufs: null, rms_dbfs: null, silence_ratio: null, onsets: null, rhythm: null, rhythm_reason: null,
        periodicity: null, beat_strength: null, cuts_on_beat_ratio: null, cuts_on_onset_ratio: null, speech_band_ratio: null, waveform: null, wav: null, note: NOTE,
    };
}

export function analyseSamples(x: Float32Array, cuts: number[]): Omit<AudioFacts, 'integrated_lufs' | 'silence_ratio' | 'waveform' | 'wav' | 'present' | 'note'> {
    const duration = x.length / SR;
    const level = rmsDb(x);
    const { env, speechBandRatio } = onsetEnvelope(x);
    const onsets = level > GATE.silentDb ? pickOnsets(env) : [];
    const est = estimateRhythm(env, onsets, duration, level);
    return {
        duration: r3(duration),
        rms_dbfs: Number.isFinite(level) ? Math.round(level * 10) / 10 : null,
        onsets: onsets.map(r3),
        rhythm: est.rhythm,
        rhythm_reason: est.reason,
        periodicity: est.periodicity,
        beat_strength: est.beat_strength,
        cuts_on_beat_ratio: est.rhythm ? alignedRatio(cuts, est.rhythm.beats) : null,
        cuts_on_onset_ratio: alignedRatio(cuts, onsets),
        speech_band_ratio: level > GATE.silentDb ? speechBandRatio : null,
    };
}

export async function analyseAudio(video: string, outDir: string, cuts: number[], hasAudio: boolean): Promise<AudioFacts> {
    if (!hasAudio) return absentAudio();
    const x = await decodeMono(video);
    const core = analyseSamples(x, cuts);
    // 16 kHz mono copy for any speech recogniser.
    await ffmpeg(['-i', video, '-vn', '-ac', '1', '-ar', '16000', path.join(outDir, 'source', 'audio.wav')]);
    const m = await run('ffmpeg', ['-hide_banner', '-nostdin', '-i', video, '-vn', '-af', 'ebur128,silencedetect=noise=-35dB:d=0.3', '-f', 'null', '-'], { fullStderr: true });
    if (m.code !== 0) throw new Error(`ffmpeg loudness/silence measurement failed (exit ${m.code}):\n${m.stderr.trim().split(/\r?\n/).slice(-4).join('\n')}`);
    const lufs = [...m.stderr.matchAll(/\bI:\s+(-?[0-9.]+) LUFS/g)].pop();
    let silent = 0;
    for (const s of m.stderr.matchAll(/silence_duration:\s*([0-9.]+)/g)) silent += Number(s[1]);
    let waveform: string | null = 'audio.png';
    try {
        await ffmpeg(['-i', video, '-vn', '-filter_complex', 'showwavespic=s=1200x200:colors=white', '-frames:v', '1', path.join(outDir, 'audio.png')]);
    } catch {
        waveform = null;
    }
    const lufsValue = lufs ? Number(lufs[1]) : null;
    return {
        present: true,
        ...core,
        integrated_lufs: lufsValue !== null && lufsValue > -70 ? lufsValue : null,
        silence_ratio: core.duration ? r3(Math.min(1, silent / core.duration)) : null,
        waveform,
        wav: 'source/audio.wav',
        note: NOTE,
    };
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;
