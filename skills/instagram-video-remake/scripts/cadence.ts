/**
 * Shot cuts and frame cadence, measured from frame-to-frame differences (mean absolute difference of small
 * grayscale frames, 0-255). Pure functions: ff.ts reads the frames, this file decides what they mean.
 *
 * Two things went wrong in practice and are what this file is for:
 *  - A swap stretch that stopped a frame or two short of the cut left original frames of the replaced person in the
 *    timeline (a visible flash of the original person). Cuts are measured to the frame so stretches can end on them.
 *  - Material shot at 24 fps and carried at 30 fps repeats one frame in five. The model's own 30->24 resampling can
 *    keep those repeats and drop real frames, which turned smooth motion into jumps. The repeats are found here so
 *    only the distinct frames are sent, and the source's own rhythm is restored when the result is put back.
 */

export const MODEL_FPS = 24;

/**
 * The length to ask the model for so that it takes exactly `frames` frames. The node pack counts
 * floor(seconds * 24): 56 / 24 written as 2.33333 s gives 55, and the frame lost is the LAST one the model sees,
 * which for a reversed stretch is the first one in playing order (every frame after it then lands one early).
 * Half a frame of margin makes the count exact; the clip itself ends there anyway.
 */
export function modelSeconds(frames: number): number {
    // Rounded UP to 5 decimals, so floor(seconds * 24) is exactly `frames` and stays within frames / 24 + half a frame.
    return Math.ceil(((frames + 0.25) / MODEL_FPS) * 1e5) / 1e5;
}

function median(xs: number[]): number {
    if (!xs.length) return 0;
    const s = [...xs].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function around(d: ArrayLike<number>, i: number, radius: number): number[] {
    const out: number[] = [];
    for (let j = Math.max(0, i - radius); j <= Math.min(d.length - 1, i + radius); j++) if (j !== i) out.push(d[j]);
    return out;
}

/**
 * Frames where a new shot starts. `diffs[i]` is the difference between frame i and frame i+1, so a cut found at
 * diffs[i] starts a shot at frame i+1. A cut is a difference that is both large and far above its neighbours.
 */
export function detectCuts(diffs: ArrayLike<number>, o: { min?: number; ratio?: number } = {}): number[] {
    const min = o.min ?? 18;
    const ratio = o.ratio ?? 4;
    const found: number[] = [];
    for (let i = 0; i < diffs.length; i++) {
        const d = diffs[i];
        if (d < min) continue;
        const ref = median(around(diffs, i, 6));
        if (d >= ratio * Math.max(ref, 1)) found.push(i);
    }
    // A cut is often followed by a frame or two that still change a lot (a flash, the new shot settling): keep the
    // largest jump within a few frames.
    const cuts: number[] = [];
    for (const i of found) {
        const rivals = found.filter((j) => j !== i && Math.abs(j - i) <= 3);
        if (rivals.every((j) => diffs[j] < diffs[i] || (diffs[j] === diffs[i] && j > i))) cuts.push(i + 1);
    }
    return cuts;
}

/** Frames (index >= 1) that repeat the frame before them: a near-zero difference where the neighbours move. */
export function repeatedFrames(diffs: ArrayLike<number>, o: { max?: number; ratio?: number } = {}): number[] {
    const max = o.max ?? 0.8;
    const ratio = o.ratio ?? 0.3;
    const out: number[] = [];
    for (let i = 0; i < diffs.length; i++) {
        const d = diffs[i];
        if (d > max) continue;
        const ref = median(around(diffs, i, 4));
        // In a still scene every difference is small; that is not a repeat pattern.
        if (ref >= 1.2 && d <= ratio * ref) out.push(i + 1);
    }
    return out;
}

/**
 * The frames to send to the model when a stretch is 24 fps material carried at a higher rate: every frame that is
 * not a repeat. Null when the stretch is not like that (its distinct frames do not come to about 24 per second),
 * in which case the model's own resampling is the right thing.
 */
export function distinctFrames(diffs: ArrayLike<number>, frames: number, fps: number): number[] | null {
    if (fps <= MODEL_FPS + 0.5 || frames < 10) return null;
    const repeats = new Set(repeatedFrames(diffs));
    const keep: number[] = [];
    for (let i = 0; i < frames; i++) if (!repeats.has(i)) keep.push(i);
    const rate = (keep.length / frames) * fps;
    return repeats.size >= 2 && Math.abs(rate - MODEL_FPS) <= 0.9 ? keep : null;
}

/**
 * For each frame of the stretch, which generated frame shows it: the generated clip holds one frame per entry of
 * `keep` (the distinct frames sent), so a repeated source frame shows the same generated frame as the one before.
 * This puts back exactly the rhythm the source had.
 */
export function frameMap(keep: number[], frames: number, generated: number, reversed = false): number[] {
    if (!keep.length || generated < 1) throw new Error('frameMap needs the frames sent and a generated clip.');
    // Frames the model did not return are missing from the END of what it saw: the end of the stretch, or its START
    // when the stretch was sent reversed. Generated frame k then shows sent frame k + lead.
    const lead = reversed ? Math.max(0, keep.length - generated) : 0;
    const map: number[] = [];
    let k = 0;
    for (let j = 0; j < frames; j++) {
        while (k + 1 < keep.length && keep[k + 1] <= j) k++;
        map.push(Math.min(Math.max(k - lead, 0), generated - 1));
    }
    return map;
}

export interface Scene {
    n: number;
    first: number;
    /** Exclusive. */
    end: number;
}

/** Shots of the source as frame ranges, numbered from 1, from the cut list. */
export function scenes(cuts: number[], frames: number): Scene[] {
    const edges = [0, ...[...new Set(cuts)].filter((c) => c > 0 && c < frames).sort((a, b) => a - b), frames];
    return edges.slice(0, -1).map((first, i) => ({ n: i + 1, first, end: edges[i + 1] }));
}

/**
 * How a swap stretch [first, end) sits against the cuts. A stretch that crosses a cut mixes two shots (the tracker
 * and the model see a jump); one that stops or starts a few frames from a cut leaves original frames of the person
 * next to it, which is the flash of the original that a viewer notices at the cut.
 */
export function stretchProblems(first: number, end: number, cuts: number[], near = 8): string[] {
    const out: string[] = [];
    for (const c of cuts) {
        if (c > first && c < end) out.push(`it crosses the cut at frame ${c}`);
        else if (c >= end && c - end > 0 && c - end <= near) out.push(`it ends ${c - end} frame(s) before the cut at frame ${c}; those frames would still show the original person`);
        else if (c <= first && first - c > 0 && first - c <= near) out.push(`it starts ${first - c} frame(s) after the cut at frame ${c}; those frames would still show the original person`);
    }
    return out;
}

/**
 * Stretches of the original that a timeline takes from a shot of the source in which a person is replaced. Short
 * ones (up to `sliver` frames) are almost always the leftover of a stretch that missed the cut.
 */
export function originalInSwappedScenes(
    sourceSegments: Array<{ first: number; end: number; label: string }>,
    swaps: Array<{ id: string; first: number; end: number }>,
    sc: Scene[],
): Array<{ label: string; first: number; end: number; scene: number; shots: string[] }> {
    const out: Array<{ label: string; first: number; end: number; scene: number; shots: string[] }> = [];
    for (const seg of sourceSegments) {
        for (const s of sc) {
            const a = Math.max(seg.first, s.first);
            const b = Math.min(seg.end, s.end);
            if (b <= a) continue;
            const shots = swaps.filter((w) => w.first < s.end && w.end > s.first).map((w) => w.id);
            if (shots.length) out.push({ label: seg.label, first: a, end: b, scene: s.n, shots });
        }
    }
    return out;
}

/**
 * Repeats the placed shot shows that the source does not, inside the replaced area: `placed[i]`/`source[i]` are the
 * differences between frames i and i+1. Returns how many extra repeats there are and the longest run of repeats
 * (2 or more in a row is a visible stall).
 */
export function extraRepeats(placed: ArrayLike<number>, source: ArrayLike<number>): { extra: number; longestRun: number } {
    // A frame of the placed shot that stands still (a near-zero difference, absolute or against what the source does
    // at that moment) while the source moves. Judged against the source, so a frozen clip is caught too.
    const still = (i: number) => placed[i] <= 0.8 || (source[i] >= 2 && placed[i] <= 0.15 * source[i]);
    let extra = 0;
    let run = 0;
    let longestRun = 0;
    for (let i = 0; i < placed.length; i++) {
        const moves = i < source.length && source[i] > 1.2;
        if (still(i) && moves) {
            extra++;
            run++;
            longestRun = Math.max(longestRun, run);
        } else run = 0;
    }
    return { extra, longestRun };
}
