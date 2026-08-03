/**
 * The cascade hierarchy: pure arithmetic, no PixiJS. Kept separate so it can be
 * checked without a GPU (`pnpm --filter pixi-radiance check`).
 */

/** @internal One level of the hierarchy, in lighting-resolution pixels. */
export interface CascadeLevel {
    /** Distance between probes. */
    spacing: number;
    probeX: number;
    probeY: number;
    /** Directions are laid out in a `dirGrid x dirGrid` block grid. */
    dirGrid: number;
    intervalStart: number;
    intervalEnd: number;
    /** Volumetric integration step, in lighting pixels. Empty space is still skipped by the SDF. */
    stride: number;
    maxSteps: number;
}

/**
 * @internal
 * Vanilla radiance cascades: per level, probe spacing doubles, the direction
 * count quadruples, and the ray interval quadruples, so each level costs about
 * the same and the whole hierarchy is memory-invariant.
 */
export function buildLevels(
    giWidth: number,
    giHeight: number,
    probeSpacing: number,
    intervalLength: number,
    override?: number,
): CascadeLevel[] {
    // Ray reach after n cascades is intervalLength * (4^n - 1) / 3; solve for
    // the first n that spans the screen diagonal.
    const diagonal = Math.hypot(giWidth, giHeight);
    const auto = Math.ceil(Math.log((3 * diagonal) / intervalLength + 1) / Math.log(4));
    const count = Math.min(10, Math.max(1, override ?? auto));

    const levels: CascadeLevel[] = [];
    for (let n = 0; n < count; n++) {
        const scale = 4 ** n;
        const spacing = probeSpacing * 2 ** n;
        const start = (intervalLength * (scale - 1)) / 3;
        const length = intervalLength * scale;
        // A cascade cannot resolve anything finer than its own probe spacing, so
        // that is also the step it integrates media at. Marching a 4096px
        // top-cascade ray one pixel at a time was ~40% of the frame.
        const stride = spacing;
        levels.push({
            spacing,
            probeX: Math.max(1, Math.ceil(giWidth / spacing)),
            probeY: Math.max(1, Math.ceil(giHeight / spacing)),
            dirGrid: 2 ** (n + 1),
            intervalStart: start,
            intervalEnd: start + length,
            stride,
            // Empty space is skipped by the distance field, so this only has to
            // cover the worst case of grazing along a surface.
            maxSteps: Math.min(64, Math.ceil(length / stride) + 8),
        });
    }
    return levels;
}

/** @internal Size of the cascade render targets: the largest level decides. */
export function cascadeTextureSize(levels: CascadeLevel[]): { width: number; height: number } {
    let width = 1;
    let height = 1;
    for (const level of levels) {
        width = Math.max(width, level.probeX * level.dirGrid);
        height = Math.max(height, level.probeY * level.dirGrid);
    }
    return { width, height };
}
