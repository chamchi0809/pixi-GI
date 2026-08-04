/**
 * The holographic-radiance-cascade buffer layout: pure arithmetic, no PixiJS.
 * Kept separate so it can be checked without a GPU (`pnpm --filter pixi-rcgi check`).
 *
 * HRC casts probes as *planes* rather than a lattice. Cascade `n` puts a plane
 * every `2^n` pixels, each plane holds one probe per pixel row, and each probe
 * casts `2^n + 1` rays fanning across 90 degrees -- so one ray every two pixels
 * of the frustum's width, whatever the cascade. The 90 degrees is why the whole
 * thing runs four times, once per frustum direction, with the scene rotated
 * under it; that rotation swaps x and y, which is why every buffer is square.
 */

/**
 * Largest square lighting buffer this will allocate. The ray buffers together
 * cost `extent^2 * (cascades + 2)` texels, so this is a memory cliff, not a
 * speed one: 512 is ~23MB, 1024 ~96MB, 2048 ~436MB. Lower `resolution` rather
 * than reaching for the ceiling.
 */
export const MAX_EXTENT = 2048;

/** @internal Where the lighting buffers sit, in lighting-resolution pixels. */
export interface HrcLayout {
    /**
     * Side of every lighting buffer. Square because the frustum rotations swap
     * x and y, and a power of two so every cascade's planes tile it exactly.
     */
    extent: number;
    /**
     * Merge levels. Cascade `n` reaches `2^n` pixels and they are contiguous, so
     * the hierarchy reaches `2^cascades` -- the buffer, unless capped.
     */
    cascades: number;
    /** Where the view starts inside the buffers. The rest is off-view world the rays still see. */
    marginX: number;
    marginY: number;
}

/**
 * @internal
 * Fit the buffers around a view. `extent` is the next power of two that holds
 * the view plus a texel of snap slack; whatever that rounding leaves over
 * becomes margin, capped at `marginFraction` of the view per side.
 *
 * The margin is therefore free -- it is space the power of two paid for
 * already. Asking for more than the rounding left would double `extent` and
 * quadruple the memory, so it is clamped instead of honoured.
 */
export function buildLayout(
    viewW: number,
    viewH: number,
    marginFraction: number,
    override?: number,
): HrcLayout {
    const need = Math.max(viewW, viewH) + 1;
    const extent = Math.min(MAX_EXTENT, 2 ** Math.ceil(Math.log2(Math.max(2, need))));
    const top = Math.log2(extent);
    return {
        extent,
        cascades: Math.max(1, Math.min(top, Math.round(override ?? top))),
        marginX: margin(viewW, extent, marginFraction),
        marginY: margin(viewH, extent, marginFraction),
    };
}

function margin(view: number, extent: number, fraction: number): number {
    const room = Math.floor((extent - view - 1) / 2);
    return Math.max(0, Math.min(Math.round(view * fraction), room));
}

/**
 * @internal
 * Width of cascade `n`'s ray buffer. Every plane stores its `2^n + 1` rays
 * side by side, so this is a little wider than `extent` -- 2x at cascade 0,
 * where each of the two rays is one pixel long, and tending to 1x above.
 */
export function raysWidth(extent: number, n: number): number {
    const interval = 2 ** n;
    return Math.floor(extent / interval) * (interval + 1);
}
