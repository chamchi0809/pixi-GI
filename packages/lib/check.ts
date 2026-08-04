/**
 * The one runnable check: the buffer layout is the only part of the library that
 * is pure logic rather than GPU output. `pnpm --filter pixi-rcgi check`
 */
import assert from 'node:assert/strict';
import { MAX_EXTENT, buildLayout, raysWidth } from './src/cascades.ts';
import { LIGHT_FLOATS, packLight } from './src/lights.ts';

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

// --- occluder surface lights -------------------------------------------------
{
    const out = new Float32Array(4 * LIGHT_FLOATS);
    // Half-resolution lighting on an 800x600 screen, 100px of falloff.
    const view = { width: 800, height: 600, sx: 0.5, sy: 0.5, range: 100, ox: 0, oy: 0 };
    const orange = { r: 255, g: 128, b: 0, intensity: 2, occlusion: 1 };
    const box = { minX: 100, minY: 100, maxX: 140, maxY: 180 };

    assert.ok(packLight(box, orange, view, 0, out), 'an on-screen emitter gets a slot');
    assert.deepEqual([...out.subarray(0, 3)], [60, 70, 20], 'centre and half-extent are in GI pixels');
    // A solid caster stops the ray, so it emits its intensity once at the surface.
    assert.equal(out[4], 2, 'colour is intensity-premultiplied');
    assert.ok(Math.abs(out[5]! - (128 / 255) * 2) < 1e-6, 'colour keeps its hue');

    // A glowing volume accumulates over its whole width instead -- 2 * 20 px
    // here -- which is what keeps it as bright as the cascades make it.
    packLight(box, { ...orange, occlusion: 0 }, view, 0, out);
    assert.equal(out[4], 2 * 40, 'a non-occluding emitter emits over its traversal');
    packLight(box, { ...orange, occlusion: 0.5 }, view, 0, out);
    assert.equal(out[4], 2 * 20.5, 'a partial occluder lands between the two');

    // The GI buffers are rasterised snapped to whole texels, so lights are
    // shifted by the same residual -- position only, never the falloff radius.
    packLight(box, orange, { ...view, ox: -0.5, oy: 0.25 }, 0, out);
    assert.deepEqual([...out.subarray(0, 3)], [59.5, 70.25, 20], 'the grid offset moves the light');
    packLight(box, orange, view, 0, out);

    // Slots are LIGHT_FLOATS apart and do not tread on each other.
    assert.ok(packLight({ ...box, minX: 300, maxX: 340 }, orange, view, 2, out));
    assert.equal(out[2 * LIGHT_FLOATS], 160, 'slot 2 starts at its own offset');
    assert.equal(out[0], 60, 'writing slot 2 leaves slot 0 alone');

    // Off-screen but still within range of it: its falloff reaches the view.
    assert.ok(packLight({ minX: -140, minY: 100, maxX: -99, maxY: 180 }, orange, view, 1, out));
    // One pixel further out it cannot, and must not consume the slot.
    out[LIGHT_FLOATS] = 12345;
    assert.ok(!packLight({ minX: -200, minY: 100, maxX: -101, maxY: 180 }, orange, view, 1, out));
    assert.ok(!packLight({ minX: 100, minY: 701, maxX: 140, maxY: 900 }, orange, view, 1, out));
    assert.equal(out[LIGHT_FLOATS], 12345, 'a culled emitter writes nothing');
}

console.log('buffer layout ok');
console.log('occluder light packing ok');
