import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { MediaFacts } from './types.ts';

/**
 * Header-only media inspection (no dependencies). Instagram's rupload needs the
 * exact width/height (and duration for video) up front, so we read them from the
 * container instead of trusting file names.
 */

export function jpegSize(buf: Uint8Array): { width: number; height: number; orientation: number } | null {
    if (buf[0] !== 0xff || buf[1] !== 0xd8) return null;
    let i = 2;
    let orientation = 1;
    while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) {
            i++;
            continue;
        }
        const marker = buf[i + 1];
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
            i += 2;
            continue;
        }
        const len = (buf[i + 2] << 8) | buf[i + 3];
        // APP1 Exif: read the orientation tag so rotated phone photos get the right box.
        if (marker === 0xe1 && String.fromCharCode(...buf.slice(i + 4, i + 8)) === 'Exif') {
            orientation = exifOrientation(buf.slice(i + 10, i + 2 + len)) ?? orientation;
        }
        const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
        if (isSof) {
            const height = (buf[i + 5] << 8) | buf[i + 6];
            const width = (buf[i + 7] << 8) | buf[i + 8];
            return { width, height, orientation };
        }
        i += 2 + len;
    }
    return null;
}

function exifOrientation(tiff: Uint8Array): number | null {
    if (tiff.length < 8) return null;
    const le = tiff[0] === 0x49;
    const u16 = (o: number) => (le ? tiff[o] | (tiff[o + 1] << 8) : (tiff[o] << 8) | tiff[o + 1]);
    const u32 = (o: number) => (le ? (tiff[o] | (tiff[o + 1] << 8) | (tiff[o + 2] << 16)) + tiff[o + 3] * 2 ** 24 : tiff[o] * 2 ** 24 + ((tiff[o + 1] << 16) | (tiff[o + 2] << 8) | tiff[o + 3]));
    const ifd = u32(4);
    if (ifd + 2 > tiff.length) return null;
    const n = u16(ifd);
    for (let k = 0; k < n; k++) {
        const e = ifd + 2 + k * 12;
        if (e + 12 > tiff.length) break;
        if (u16(e) === 0x0112) return u16(e + 8);
    }
    return null;
}

export function pngSize(buf: Uint8Array): { width: number; height: number } | null {
    const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    if (!sig.every((b, k) => buf[k] === b)) return null;
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    return { width: dv.getUint32(16), height: dv.getUint32(20) };
}

export function webpSize(buf: Uint8Array): { width: number; height: number } | null {
    const tag = (o: number) => String.fromCharCode(buf[o], buf[o + 1], buf[o + 2], buf[o + 3]);
    if (tag(0) !== 'RIFF' || tag(8) !== 'WEBP') return null;
    const chunk = tag(12);
    if (chunk === 'VP8X') return { width: 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16)), height: 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16)) };
    if (chunk === 'VP8 ') return { width: (buf[26] | (buf[27] << 8)) & 0x3fff, height: (buf[28] | (buf[29] << 8)) & 0x3fff };
    if (chunk === 'VP8L') {
        const b = buf.slice(21, 25);
        return { width: 1 + (((b[1] & 0x3f) << 8) | b[0]), height: 1 + (((b[3] & 0xf) << 10) | (b[2] << 2) | ((b[1] & 0xc0) >> 6)) };
    }
    return null;
}

interface Mp4Info {
    width: number;
    height: number;
    durationMs: number;
    codec?: string;
    hasAudio: boolean;
}

/** Walks ISO-BMFF boxes: moov/mvhd (duration), trak/tkhd (size + rotation), mdia/hdlr, stsd (codec). */
export function mp4Info(buf: Uint8Array): Mp4Info | null {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const type = (o: number) => String.fromCharCode(buf[o], buf[o + 1], buf[o + 2], buf[o + 3]);
    if (buf.length < 12 || type(4) !== 'ftyp') return null;

    const boxes = (start: number, end: number): { type: string; start: number; end: number; body: number }[] => {
        const out: { type: string; start: number; end: number; body: number }[] = [];
        let o = start;
        while (o + 8 <= end) {
            let size = dv.getUint32(o);
            let header = 8;
            if (size === 1) {
                size = Number(dv.getBigUint64(o + 8));
                header = 16;
            } else if (size === 0) {
                size = end - o;
            }
            if (size < header || o + size > end) break;
            out.push({ type: type(o + 4), start: o, end: o + size, body: o + header });
            o += size;
        }
        return out;
    };

    const moov = boxes(0, buf.length).find((b) => b.type === 'moov');
    if (!moov) return null;
    let durationMs = 0;
    let width = 0;
    let height = 0;
    let codec: string | undefined;
    let hasAudio = false;

    for (const b of boxes(moov.body, moov.end)) {
        if (b.type === 'mvhd') {
            const v = buf[b.body];
            const timescale = v === 1 ? dv.getUint32(b.body + 20) : dv.getUint32(b.body + 12);
            const duration = v === 1 ? Number(dv.getBigUint64(b.body + 24)) : dv.getUint32(b.body + 16);
            if (timescale) durationMs = Math.round((duration / timescale) * 1000);
        }
        if (b.type !== 'trak') continue;
        const kids = boxes(b.body, b.end);
        const mdia = kids.find((k) => k.type === 'mdia');
        const hdlr = mdia ? boxes(mdia.body, mdia.end).find((k) => k.type === 'hdlr') : undefined;
        const handler = hdlr ? type(hdlr.body + 8) : '';
        if (handler === 'soun') hasAudio = true;
        if (handler !== 'vide') continue;
        const tkhd = kids.find((k) => k.type === 'tkhd');
        if (tkhd) {
            const v = buf[tkhd.body];
            const matrixAt = tkhd.body + (v === 1 ? 52 : 40);
            const wAt = tkhd.body + (v === 1 ? 88 : 76);
            let w = Math.round(dv.getUint32(wAt) / 65536);
            let h = Math.round(dv.getUint32(wAt + 4) / 65536);
            // A 90/270-degree rotation matrix has a == 0: swap to the displayed size.
            if (dv.getInt32(matrixAt) === 0 && dv.getInt32(matrixAt + 4) !== 0) [w, h] = [h, w];
            width = w;
            height = h;
        }
        const minf = mdia ? boxes(mdia.body, mdia.end).find((k) => k.type === 'minf') : undefined;
        const stbl = minf ? boxes(minf.body, minf.end).find((k) => k.type === 'stbl') : undefined;
        const stsd = stbl ? boxes(stbl.body, stbl.end).find((k) => k.type === 'stsd') : undefined;
        if (stsd) codec = type(stsd.body + 12);
    }
    if (!width || !height) return null;
    return { width, height, durationMs, codec, hasAudio };
}

const EXT_MIME: Record<string, string> = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.heic': 'image/heic',
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.m4v': 'video/mp4',
};

/** Reads facts about a local media file. Throws with a fix when the format is unusable. */
export async function inspectMedia(file: string): Promise<MediaFacts> {
    const abs = path.resolve(file);
    const info = await stat(abs).catch(() => null);
    if (!info?.isFile()) throw new Error(`File not found: ${abs}`);
    const buf = new Uint8Array(await readFile(abs));
    const base = { path: abs, bytes: info.size };

    const jpg = jpegSize(buf);
    if (jpg) {
        const swap = jpg.orientation >= 5 && jpg.orientation <= 8;
        return { ...base, kind: 'photo', mime: 'image/jpeg', width: swap ? jpg.height : jpg.width, height: swap ? jpg.width : jpg.height };
    }
    const png = pngSize(buf);
    if (png) return { ...base, kind: 'photo', mime: 'image/png', ...png };
    const webp = webpSize(buf);
    if (webp) return { ...base, kind: 'photo', mime: 'image/webp', ...webp };
    const mp4 = mp4Info(buf);
    if (mp4) {
        return {
            ...base,
            kind: 'video',
            mime: EXT_MIME[path.extname(abs).toLowerCase()] === 'video/quicktime' ? 'video/quicktime' : 'video/mp4',
            width: mp4.width,
            height: mp4.height,
            durationMs: mp4.durationMs,
            codec: mp4.codec,
            hasAudio: mp4.hasAudio,
        };
    }
    throw new Error(`Unsupported or unreadable media: ${abs}. Use JPEG/PNG/WebP images or MP4/MOV (H.264) video.`);
}

export function ffmpegPath(): string | null {
    const override = process.env.INSTAGRAM_FFMPEG_PATH?.trim();
    const cmd = override || 'ffmpeg';
    const r = spawnSync(cmd, ['-version'], { stdio: 'ignore', shell: false });
    return r.status === 0 ? cmd : null;
}

const tempDirs: string[] = [];
process.on('exit', () => {
    for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

/** Temp files (converted JPEGs, cover frames) are removed when the process exits. */
async function tmpFile(name: string): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'instagram-ai-'));
    tempDirs.push(dir);
    return path.join(dir, name);
}

/** Converts any image ffmpeg can read to a JPEG Instagram accepts. */
export async function toJpeg(file: string): Promise<string> {
    const ff = ffmpegPath();
    if (!ff) throw new Error(`${path.basename(file)} is not a JPEG and ffmpeg is not installed. Convert it to .jpg first, or install ffmpeg.`);
    const out = await tmpFile(`${path.parse(file).name}.jpg`);
    const r = spawnSync(ff, ['-y', '-loglevel', 'error', '-i', path.resolve(file), '-q:v', '2', out], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`ffmpeg could not convert ${file}: ${r.stderr}`);
    return out;
}

/** Extracts one frame (default 0s) of a video as a JPEG cover. Returns null without ffmpeg. */
export async function extractCover(video: string, atSeconds = 0): Promise<string | null> {
    const ff = ffmpegPath();
    if (!ff) return null;
    const out = await tmpFile(`${path.parse(video).name}-cover.jpg`);
    const r = spawnSync(ff, ['-y', '-loglevel', 'error', '-ss', String(atSeconds), '-i', path.resolve(video), '-frames:v', '1', '-q:v', '2', out], { encoding: 'utf8' });
    return r.status === 0 ? out : null;
}
