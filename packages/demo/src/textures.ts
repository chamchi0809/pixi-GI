import { Texture } from 'pixi.js';

/** Draw into an offscreen canvas and hand it to Pixi as a texture. */
function fromCanvas(size: number, draw: (ctx: CanvasRenderingContext2D, size: number) => void): Texture {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas unavailable');
    draw(ctx, size);
    return Texture.from(canvas);
}

/**
 * Chiselled-block normal map for the crates: flat in the middle, sloping outward
 * over a border of `bevel` of the tile. OpenGL tangent space (+Y up), which is
 * what `normalMap` expects, so a light passing by sweeps a highlight across the
 * top edge and then the bottom.
 */
export function bevelNormal(size = 64, bevel = 0.3, slope = 1.6): Texture {
    /** -1 at the near edge, +1 at the far one, 0 in the flat middle. */
    const ramp = (v: number): number => {
        const b = size * bevel;
        if (v < b) return v / b - 1;
        if (v > size - 1 - b) return 1 - (size - 1 - v) / b;
        return 0;
    };

    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas unavailable');
    const img = ctx.createImageData(size, size);

    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const nx = ramp(x + 0.5) * slope;
            const ny = ramp(y + 0.5) * slope; // still y-down here
            const len = Math.hypot(nx, ny, 1);
            const i = (y * size + x) * 4;
            img.data[i] = (nx / len) * 127.5 + 127.5;
            img.data[i + 1] = 127.5 - (ny / len) * 127.5; // flip to +Y up
            img.data[i + 2] = (1 / len) * 127.5 + 127.5;
            img.data[i + 3] = 255;
        }
    }
    ctx.putImageData(img, 0, 0);
    return Texture.from(canvas);
}

/** Vertical bars: opaque where the grate blocks light, transparent between. */
export function grateMask(size = 70, bars = 5): Texture {
    return fromCanvas(size, (ctx, s) => {
        ctx.clearRect(0, 0, s, s);
        ctx.fillStyle = '#8a8f9a';
        const pitch = s / bars;
        for (let i = 0; i < bars; i++) ctx.fillRect(i * pitch + pitch * 0.2, 0, pitch * 0.45, s);
    });
}
