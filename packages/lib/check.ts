/**
 * The one runnable check: the buffer layout is the only part of the library that
 * is pure logic rather than GPU output. `pnpm --filter pixi-rcgi check`
 */
import assert from 'node:assert/strict';
import { MAX_EXTENT, buildLayout, raysWidth, snapStep } from './src/cascades.ts';

for (const [w, h] of [
    [640, 360],
    [1920, 1080],
    [100, 100],
    [17, 3],
    [1, 1],
    [4096, 2160],
] as const) {
    for (const margin of [0, 0.25, 0.5, 4]) {
        const { extent, cascades, marginX, marginY } = buildLayout(w, h, margin);
        const label = `${w}x${h} @ margin ${margin}`;
        const capped = Math.max(w, h) + 1 > MAX_EXTENT;

        // Square power of two: the frustum rotations swap x and y, and every
        // cascade's planes have to tile the buffer exactly.
        assert.equal(2 ** Math.log2(extent), extent, `${label}: extent ${extent} is a power of two`);
        assert.ok(extent <= MAX_EXTENT, `${label}: extent respects the ceiling`);
        // The view has to fit, margins included, or the composite reads outside
        // the buffers and the screen edges go dark.
        if (!capped) {
            assert.ok(w + 2 * marginX < extent, `${label}: view + margin fits across`);
            assert.ok(h + 2 * marginY < extent, `${label}: view + margin fits down`);
            assert.ok(extent < 2 * (Math.max(w, h) + 1), `${label}: extent ${extent} is not oversized`);
        }
        assert.ok(marginX >= 0 && marginY >= 0, `${label}: margins are non-negative`);
        assert.ok(
            marginX <= Math.round(w * margin) && marginY <= Math.round(h * margin),
            `${label}: margin is never exceeded`,
        );

        assert.ok(cascades >= 1, `${label}: at least one cascade`);
        // The top ray has to cross the view, or distant light simply vanishes.
        if (!capped) assert.ok(2 ** cascades >= Math.max(w, h), `${label}: reach ${2 ** cascades} covers the view`);

        for (let n = 0; n < cascades; n++) {
            const width = raysWidth(extent, n);
            const interval = 2 ** n;
            // Planes tile the buffer exactly and each stores its 2^n+1 rays.
            assert.equal(width, (extent / interval) * (interval + 1), `${label}: cascade ${n} width`);
            // Every ray buffer is between 1x and 2x the buffer wide, which is
            // what makes the whole hierarchy extent^2 * (cascades + 2) texels.
            assert.ok(width > extent && width <= 2 * extent, `${label}: cascade ${n} width is bounded`);
        }
        // Cascade 0's two rays per plane is what the seed pass assumes.
        assert.equal(raysWidth(extent, 0), 2 * extent, `${label}: cascade 0 is two texels per plane`);

        // The snap pushes the covered world up to a step off the view, so the
        // margin has to still cover the view afterwards -- this is the whole reason
        // the step is capped, and getting it wrong darkens a screen edge.
        for (let lod = 1; lod <= Math.log2(extent); lod++) {
            const step = snapStep(lod, marginX, marginY);
            assert.equal(2 ** Math.log2(step), step, `${label}: step ${step} is a power of two`);
            assert.ok(step <= 2 ** lod, `${label}: step never exceeds the mip it aligns`);
            // `<=`, because the residual is strictly less than a step: the last
            // fragment reads just inside the last texel, never past it.
            if (!capped) {
                assert.ok(marginX + w + step <= extent, `${label}: lod ${lod} stays inside across`);
                assert.ok(marginY + h + step <= extent, `${label}: lod ${lod} stays inside down`);
            }
        }
    }
}

// The margin is the slack the power-of-two rounding already paid for: 16:9 has
// plenty above and below, and none at all across.
{
    const { extent, marginX, marginY } = buildLayout(1920, 1080, 0.5);
    assert.equal(extent, 2048);
    assert.equal(marginX, 63);
    assert.equal(marginY, 483);
}

// An explicit cascade count is honoured and clamped to something renderable.
assert.equal(buildLayout(640, 360, 0, 3).cascades, 3);
assert.equal(buildLayout(640, 360, 0, 0).cascades, 1);
assert.equal(buildLayout(640, 360, 0, 99).cascades, Math.log2(1024));

console.log('buffer layout ok');
