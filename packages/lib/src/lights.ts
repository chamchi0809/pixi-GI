/**
 * Point-light approximation of the scene's emitters, used **only** by the
 * occluder surface light in the composite pass -- not by the cascades.
 *
 * Pure arithmetic, no Pixi, so `check.ts` can exercise it.
 */

/**
 * Floats one light occupies in the instance buffer: `vec4` position followed by
 * `vec4` colour, matching the `aLight` / `aLightColor` attributes.
 */
export const LIGHT_FLOATS = 8;

/** World/screen-space AABB. Structurally compatible with Pixi's `Bounds`. */
export interface LightBounds {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
}

/** 0..255 emissive colour plus its multiplier -- the fields of a resolved material. */
export interface LightColor {
    r: number;
    g: number;
    b: number;
    intensity: number;
    occlusion: number;
}

/** Screen size, the screen -> GI pixel scale, and the falloff range in screen pixels. */
export interface LightView {
    width: number;
    height: number;
    sx: number;
    sy: number;
    range: number;
}

/**
 * Write one emitter into instance `slot` of the light pass' buffer.
 *
 * Floats `0..3` get `(x, y, radius, 0)` in GI pixels; `4..7` get the
 * intensity-premultiplied linear colour. Returns `false` -- writing nothing --
 * when the emitter's falloff cannot reach the view, so the caller can reuse the
 * slot for one that can.
 */
export function packLight(
    bounds: LightBounds,
    color: LightColor,
    view: LightView,
    slot: number,
    out: Float32Array,
): boolean {
    const { minX, minY, maxX, maxY } = bounds;
    const r = view.range;
    if (maxX < -r || minX > view.width + r || maxY < -r || minY > view.height + r) return false;

    const o = slot * LIGHT_FLOATS;
    const radius = Math.max(Math.max((maxX - minX) * view.sx, (maxY - minY) * view.sy) * 0.5, 0.5);
    out[o] = ((minX + maxX) * 0.5) * view.sx;
    out[o + 1] = ((minY + maxY) * 0.5) * view.sy;
    out[o + 2] = radius;
    out[o + 3] = 0;

    // Radiance leaving the emitter towards us. `emissiveIntensity` is radiance
    // *per lighting pixel a ray travels through the body*, exactly as the
    // cascades integrate it, so a solid caster (occlusion 1) emits it once at
    // its surface while a glowing volume accumulates it over its whole width.
    // Skipping this makes a 70px torch ~70x dimmer here than in the cascades.
    const traversal = 1 + (1 - color.occlusion) * (2 * radius - 1);
    const k = (color.intensity * traversal) / 255;
    out[o + 4] = color.r * k;
    out[o + 5] = color.g * k;
    out[o + 6] = color.b * k;
    out[o + 7] = 0;
    return true;
}
