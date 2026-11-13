/**
 * ComfyUI graphs (API format) for the two generation steps of a remake, both with MiniMax H3:
 *
 *  - fillSwap: replaces one person in a clip, keeping the performance, the scene and everyone else.
 *    It fills the bundled character-swap template (assets/workflows/h3_swap.api.json).
 *  - buildContinuation: extends a shot past its end, anchored on the last frames of that shot.
 *
 * Pure functions: no file or network access. Every default here is a setting of a run that was kept;
 * references/workflow.md says which.
 */

export type Graph = Record<string, { class_type: string; inputs: Record<string, any> }>;

export const MODELS = {
    unet: 'minimax_h3_ref2va_pruned_int8_convrot.safetensors',
    textEncoder: 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors',
    videoVae: 'minimax_h3_video_vae_fp16.safetensors',
    audioVae: 'minimax_h3_audio_vae_fp32.safetensors',
    turboLora: 'minimax_h3_fl2v_turbo_8step_v1.0_768p_comfyui_bf16.safetensors',
    swapLora: 'h3_character_swap_v1.5.safetensors',
    sam: 'sam3.1_multiplex_fp16.safetensors',
} as const;

/** Node classes the graphs need: core nodes of a recent ComfyUI plus the H3 character-swap node pack. */
export const REQUIRED_NODES = [
    // the bundled swap template
    'CLIPLoader', 'CLIPTextEncode', 'CheckpointLoaderSimple', 'CreateVideo', 'H3CharacterSwapAssemble', 'H3CharacterSwapController', 'H3CharacterSwapExpandMask',
    'H3CharacterSwapModels', 'H3CharacterSwapPrepareVideo', 'H3CharacterSwapRecoverMasks', 'H3CharacterSwapSelectSubject', 'H3CharacterSwapSettings', 'H3CharacterSwapShot',
    'H3CharacterSwapWindowPlan', 'ImageFromBatch', 'ImageScale', 'LoadImage', 'LoadVideo', 'LoraLoaderModelOnly', 'MiniMaxH3SigmaShift', 'ModelAttentionBackend',
    'SAM3_Detect', 'SAM3_TrackToMask', 'SAM3_VideoTrack', 'SaveVideo', 'SelectCLIPDevice', 'UNETLoader', 'VAELoader', 'Video Slice',
    // the continuation graph
    'BasicGuider', 'BasicScheduler', 'GetVideoComponents', 'KSamplerSelect', 'MiniMaxH3AddGuide', 'MiniMaxH3ReferenceToVideo', 'RandomNoise', 'SamplerCustomAdvanced', 'VAEDecode',
];

/** The node whose file is the result, in each graph. */
export const SAVE_NODE = { swap: '809', continue: '42' } as const;

/** Generated clips are 24 fps. */
export const H3_FPS = 24;
/** Longest clip one swap run takes, in seconds (the template's window plan). */
export const SWAP_MAX_SECONDS = 10;

export interface SwapOptions {
    /** File names inside ComfyUI's input folder. */
    video: string;
    identity: string;
    /** Where the wanted stretch starts inside `video`, and how long it is, in seconds. */
    start: number;
    duration: number;
    /** Working height class: "480" is fast and enough for a small subject, "768" for a close shot. */
    tier: '480' | '768';
    seed: number;
    prompt?: string;
    /** Text for the detector when no point is given. */
    detect: string;
    /** Which detection to follow when the text finds several. */
    selection: 'largest' | 'leftmost' | 'rightmost' | 'index';
    index: number;
    /** One click on the target, in prepared-frame pixels. Replaces text detection: use it when others are in frame. */
    point?: { x: number; y: number };
    /** How far the edit mask grows past the tracked body, in pixels of the prepared frame. */
    expand: number;
    /** Re-detect on frames where tracking lost the subject. Only safe when one person is in frame. */
    recover: boolean;
    /** Optional still that fixes the look of the first frame. */
    anchor?: string;
    /** Name used for the output files. */
    prefix: string;
}

export const SWAP_DEFAULTS = { start: 0, tier: '768', seed: 904239, detect: 'person', selection: 'largest', index: 0, expand: 64, recover: false } as const;

function clone<T>(v: T): T {
    return JSON.parse(JSON.stringify(v));
}

/** Fills the bundled swap template. Throws when the template is not the one this function was written for. */
export function fillSwap(template: Graph, o: SwapOptions): Graph {
    const w = clone(template);
    for (const id of ['30', '9', 'trim', '31', '101', '103', '104', '105', '106', '107', '110', '801', '803', '807', '809']) {
        if (!w[id]) throw new Error(`The swap template is missing node "${id}": it is not the bundled h3_swap.api.json.`);
    }
    if (!(o.duration > 0) || o.duration > SWAP_MAX_SECONDS) throw new Error(`A swap covers up to ${SWAP_MAX_SECONDS} s per run; got ${o.duration}.`);
    if (o.start < 0) throw new Error('start must not be negative.');
    w['30'].inputs.file = o.video;
    w['9'].inputs.image = o.identity;
    Object.assign(w.trim.inputs, { start_time: o.start, duration: o.duration, strict_duration: false });
    // The node pack accepts the resolution as a string only.
    Object.assign(w['31'].inputs, { resolution: o.tier, duration_seconds: o.duration });
    w['101'].inputs.text = o.detect;
    Object.assign(w['104'].inputs, { selection: o.selection, index: o.index });
    // Re-detecting can jump to another person, so it is opt-in.
    w['107'].inputs.recover_empty_frames = Boolean(o.recover);
    if (o.point) {
        if (!Number.isInteger(o.point.x) || !Number.isInteger(o.point.y) || o.point.x < 0 || o.point.y < 0) throw new Error('point must be whole, non-negative pixel coordinates.');
        // One explicit target and no text detection competing with it.
        w['103'].inputs.positive_coords = JSON.stringify([{ x: o.point.x, y: o.point.y }]);
        delete w['103'].inputs.conditioning;
        Object.assign(w['104'].inputs, { selection: 'index', index: 0 });
        delete w['105'].inputs.conditioning;
        w['106'].inputs.object_indices = '0';
    }
    w['110'].inputs.expansion_px = o.expand;
    w['801'].inputs.seed = o.seed;
    if (o.prompt) w['801'].inputs.prompt = o.prompt;
    if (o.anchor) {
        if (!w.anchor_image) throw new Error('The swap template has no anchor nodes.');
        w.anchor_image.inputs.image = o.anchor;
        w['803'].inputs.use_anchor = true;
    } else {
        delete w.anchor_image;
        delete w.anchor_fit;
        delete w['803'].inputs.anchor;
        w['803'].inputs.use_anchor = false;
    }
    // A single-GPU ComfyUI offers "default" and "cpu" for the text-encoder device; the template asks for "gpu:0".
    for (const node of Object.values(w)) {
        if (node.class_type === 'SelectCLIPDevice' && !['default', 'cpu'].includes(node.inputs.device)) node.inputs.device = 'default';
    }
    w['803'].inputs.shot_id = o.prefix;
    w['807'].inputs.filename_prefix = o.prefix;
    w['809'].inputs.filename_prefix = `video/${o.prefix}`;
    return w;
}

/** H3 clip lengths are 17k + 5 frames. Returns the first valid length that holds `frames`. */
export function h3Length(frames: number): number {
    const base = Math.max(5, Math.round(frames));
    return base + ((5 - (base % 17)) % 17 + 17) % 17;
}

export interface ContinuationOptions {
    /** File names inside ComfyUI's input folder. */
    scene: string;
    identity: string;
    /** The shot being continued; its last `guideFrames` frames are anchored at the start. */
    previous: string;
    /** Frame count of `previous`. */
    previousFrames: number;
    guideFrames: number;
    prompt: string;
    width: number;
    height: number;
    /** New material wanted, in seconds, NOT counting the anchored guide frames. */
    seconds: number;
    seed: number;
    steps: number;
    prefix: string;
}

export const CONTINUE_DEFAULTS = { guideFrames: 25, seed: 1, steps: 8 } as const;

/** Frames the continuation graph generates, guide included, and how many of them are new. */
export function continuationFrames(seconds: number, guideFrames: number): { length: number; guide: number; fresh: number } {
    const length = h3Length(Math.round(seconds * H3_FPS) + guideFrames);
    return { length, guide: guideFrames, fresh: length - guideFrames };
}

/**
 * Continues a shot. <Picture 1> is the scene (the last frame of the shot), <Picture 2> the identity photo; the
 * last frames of the shot are anchored from frame 0 so the movement carries on at the same speed. The caller
 * drops those guide frames from the result (continuationFrames says how many).
 */
export function buildContinuation(o: ContinuationOptions): Graph {
    if (!o.prompt.trim()) throw new Error('A continuation needs a prompt that describes the movement in order.');
    if (o.width % 16 || o.height % 16) throw new Error(`Width and height must be multiples of 16; got ${o.width}x${o.height}.`);
    if (o.guideFrames < 1 || o.guideFrames > o.previousFrames) throw new Error(`guideFrames must be between 1 and the ${o.previousFrames} frames of the previous shot.`);
    const { length } = continuationFrames(o.seconds, o.guideFrames);
    const size = { upscale_method: 'lanczos', width: o.width, height: o.height, crop: 'center' };
    return {
        '1': { class_type: 'UNETLoader', inputs: { unet_name: MODELS.unet, weight_dtype: 'default' } },
        '2': { class_type: 'MiniMaxH3SigmaShift', inputs: { shift_video: 12, shift_audio: 3, model: ['1', 0] } },
        '4': { class_type: 'LoraLoaderModelOnly', inputs: { lora_name: MODELS.turboLora, strength_model: 1, model: ['2', 0] } },
        '6': { class_type: 'CLIPLoader', inputs: { clip_name: MODELS.textEncoder, type: 'minimax', device: 'default' } },
        '7': { class_type: 'VAELoader', inputs: { vae_name: MODELS.videoVae } },
        '8': { class_type: 'VAELoader', inputs: { vae_name: MODELS.audioVae } },
        '10': { class_type: 'LoadImage', inputs: { image: o.scene } },
        '11': { class_type: 'LoadImage', inputs: { image: o.identity } },
        '12': { class_type: 'ImageScale', inputs: { image: ['10', 0], ...size } },
        '14': { class_type: 'LoadVideo', inputs: { file: o.previous } },
        '15': { class_type: 'GetVideoComponents', inputs: { video: ['14', 0] } },
        '16': { class_type: 'ImageFromBatch', inputs: { image: ['15', 0], batch_index: o.previousFrames - o.guideFrames, length: o.guideFrames } },
        '17': { class_type: 'ImageScale', inputs: { image: ['16', 0], ...size } },
        '20': {
            class_type: 'MiniMaxH3ReferenceToVideo',
            inputs: { ref_image_size: 'match', clip: ['6', 0], prompt: o.prompt, width: o.width, height: o.height, length, vae: ['7', 0], audio_vae: ['8', 0], 'ref_images.ref_image_0': ['12', 0], 'ref_images.ref_image_1': ['11', 0] },
        },
        '21': { class_type: 'MiniMaxH3AddGuide', inputs: { positive: ['20', 0], latent: ['20', 1], frame_idx: 0, vae: ['7', 0], audio_vae: ['8', 0], image: ['17', 0] } },
        '30': { class_type: 'RandomNoise', inputs: { noise_seed: o.seed } },
        '31': { class_type: 'KSamplerSelect', inputs: { sampler_name: 'er_sde' } },
        '32': { class_type: 'BasicScheduler', inputs: { scheduler: 'normal', denoise: 1, model: ['4', 0], steps: o.steps } },
        '33': { class_type: 'BasicGuider', inputs: { model: ['4', 0], conditioning: ['21', 0] } },
        '34': { class_type: 'SamplerCustomAdvanced', inputs: { noise: ['30', 0], guider: ['33', 0], sampler: ['31', 0], sigmas: ['32', 0], latent_image: ['20', 1] } },
        '40': { class_type: 'VAEDecode', inputs: { samples: ['34', 0], vae: ['7', 0] } },
        '41': { class_type: 'CreateVideo', inputs: { fps: H3_FPS, bit_depth: 8, color_space: 'sRGB', codec: 'none', images: ['40', 0] } },
        '42': { class_type: 'SaveVideo', inputs: { filename_prefix: `video/${o.prefix}`, format: 'auto', video: ['41', 0], 'format.codec': 'auto' } },
    };
}

export interface Rect {
    x: number;
    y: number;
    w: number;
    h: number;
}

/**
 * The swap node resizes its input to cover the working canvas and crops the centre. Given the area that was sent
 * (the whole frame or a crop of it) and the size of the generated clip, this is the part of that area the
 * generated clip actually shows: the rectangle to scale it back into.
 */
export function generatedArea(sent: Rect, genW: number, genH: number): Rect {
    const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
    const sentAR = sent.w / sent.h;
    const genAR = genW / genH;
    if (Math.abs(sentAR - genAR) < 1e-4) return { ...sent };
    if (genAR < sentAR) {
        const w = Math.min(sent.w, even(sent.h * genAR));
        return { x: sent.x + Math.round((sent.w - w) / 2), y: sent.y, w, h: sent.h };
    }
    const h = Math.min(sent.h, even(sent.w / genAR));
    return { x: sent.x, y: sent.y + Math.round((sent.h - h) / 2), w: sent.w, h };
}

/** Maps a point on the frame that was sent to prepared-frame pixels, where the detector expects it. */
export function toPreparedPoint(p: { x: number; y: number }, sent: Rect, prepW: number, prepH: number): { x: number; y: number } {
    const area = generatedArea(sent, prepW, prepH);
    const x = Math.round(((p.x - area.x) / area.w) * prepW);
    const y = Math.round(((p.y - area.y) / area.h) * prepH);
    if (x < 0 || y < 0 || x >= prepW || y >= prepH) throw new Error('That point falls outside the part of the frame the model sees. Pick a point on the subject, or widen the crop.');
    return { x, y };
}

/** Pixels the swap node works with at each tier. */
const TIER_PIXELS = { '480': 500_000, '768': 1_000_000 } as const;

/**
 * The size the swap node pack (at the commit pinned in references/setup.md) prepares its input at:
 *  - an input already within the tier's pixel budget, with both sides multiples of 32, is kept as it is;
 *  - otherwise the frame is rescaled to the size on a 32-pixel grid, within the budget, whose proportions are
 *    closest to the input's (closest in ratio terms on both sides; on an exact tie the larger area wins).
 * The kept runs agree with this: 360x640 -> 512x928 at "480", 720x1280 -> 736x1344 at "768".
 */
export function tierCanvas(tier: '480' | '768', area: { w: number; h: number }): { w: number; h: number } {
    const budget = TIER_PIXELS[tier];
    if (!(area.w > 0 && area.h > 0)) throw new Error('The area has no size.');
    if (area.w * area.h <= budget && area.w % 32 === 0 && area.h % 32 === 0) return { w: area.w, h: area.h };
    const ratio = area.w / area.h;
    const idealW = Math.sqrt(budget * ratio);
    const idealH = Math.sqrt(budget / ratio);
    let best: { score: number; w: number; h: number } | null = null;
    for (let w = 32; w <= Math.min(16384, Math.floor(budget / 32)); w += 32) {
        const maxH = Math.min(16384, Math.floor(Math.floor(budget / w) / 32) * 32);
        const fit = (h: number) => Math.max(32, Math.min(maxH, h));
        for (const h of new Set([fit(Math.floor(idealH / 32) * 32), fit(Math.ceil(idealH / 32) * 32)])) {
            const score = Math.log(w / idealW) ** 2 + Math.log(h / idealH) ** 2;
            // Order: lower score, then larger area, then smaller width, then smaller height (no tolerance).
            const better = !best || score < best.score || (score === best.score && (w * h > best.w * best.h || (w * h === best.w * best.h && (w < best.w || (w === best.w && h < best.h)))));
            if (better) best = { score, w, h };
        }
    }
    return { w: best!.w, h: best!.h };
}
