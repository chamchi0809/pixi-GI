/** CPU-written textures. Everything the sand demo draws is generated here. */
import { BufferImageSource, Texture } from 'pixi.js';

export function buffer(
    width: number,
    height: number,
): { data: Uint8Array; texture: Texture; source: BufferImageSource } {
    const data = new Uint8Array(width * height * 4);
    const source = new BufferImageSource({
        resource: data,
        width,
        height,
        format: 'rgba8unorm',
        scaleMode: 'nearest',
        // Everything written here is premultiplied: the occlusion map is
        // white * alpha, and the albedo is already colour * alpha.
        alphaMode: 'premultiplied-alpha',
    });
    return { data, texture: new Texture({ source }), source };
}

/**
 * Rasterise a string map at one texel per character. `.` is transparent, every
 * other character indexes `palette`. One texel is one simulation pixel, so
 * these sprites are placed at integer coordinates and never scaled.
 */
export function pixelTexture(rows: readonly string[], palette: Record<string, number>): Texture {
    const w = rows[0]!.length;
    const h = rows.length;
    const t = buffer(w, h);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const rgb = palette[rows[y]![x]!];
            if (rgb === undefined) continue;
            const p = (y * w + x) * 4;
            t.data[p] = (rgb >> 16) & 255;
            t.data[p + 1] = (rgb >> 8) & 255;
            t.data[p + 2] = rgb & 255;
            t.data[p + 3] = 255;
        }
    }
    t.source.update();
    return t.texture;
}

export function clamp8(v: number): number {
    return v < 0 ? 0 : v > 255 ? 255 : v | 0;
}
