/**
 * The one runnable check: the cascade hierarchy is the only part of the library
 * that is pure logic rather than GPU output. `pnpm --filter pixi-rcgi check`
 */
import assert from 'node:assert/strict';
import { buildLevels, cascadeTextureSize, snapQuantum } from './src/cascades.ts';
import { LIGHT_FLOATS, packLight } from './src/lights.ts';

for (const [w, h] of [
    [640, 360],
    [1920, 1080],
    [100, 100],
    [17, 3],
] as const) {
    for (const spacing of [1, 2, 4]) {
        const levels = buildLevels(w, h, spacing, spacing);
        const label = `${w}x${h} @ spacing ${spacing}`;

        assert.ok(levels.length >= 1, `${label}: at least one cascade`);
        assert.equal(levels[0]!.intervalStart, 0, `${label}: cascade 0 starts at the probe`);

        for (let n = 0; n < levels.length; n++) {
            const level = levels[n]!;
            assert.equal(level.spacing, spacing * 2 ** n, `${label}: spacing doubles`);
            assert.equal(level.dirGrid ** 2, 4 ** (n + 1), `${label}: direction count quadruples`);
            // Probes must cover the whole buffer, or the edges never get lit.
            assert.ok(level.probeX * level.spacing >= w, `${label}: level ${n} covers width`);
            assert.ok(level.probeY * level.spacing >= h, `${label}: level ${n} covers height`);

            // The march must be able to walk the whole interval within its step
            // budget, or the far end of every cascade is silently never sampled.
            assert.ok(level.stride >= 1, `${label}: level ${n} stride is at least one pixel`);
            assert.ok(
                level.maxSteps * level.stride >= level.intervalEnd - level.intervalStart,
                `${label}: level ${n} can march its whole interval`,
            );
            assert.ok(level.maxSteps <= 64, `${label}: level ${n} respects the shader loop bound`);

            const next = levels[n + 1];
            if (next) {
                assert.equal(next.intervalStart, level.intervalEnd, `${label}: intervals are contiguous`);
                assert.equal(
                    (next.intervalEnd - next.intervalStart) / (level.intervalEnd - level.intervalStart),
                    4,
                    `${label}: interval length quadruples`,
                );
            }
        }

        // Without an explicit count the top cascade must out-reach the diagonal,
        // otherwise distant lights simply vanish.
        const reach = levels[levels.length - 1]!.intervalEnd;
        assert.ok(reach >= Math.hypot(w, h), `${label}: top cascade reaches ${reach}, needs ${Math.hypot(w, h)}`);

        // Memory invariance: no level may need a bigger target than we allocate.
        const size = cascadeTextureSize(levels);
        for (const level of levels) {
            assert.ok(level.probeX * level.dirGrid <= size.width, `${label}: fits allocated width`);
            assert.ok(level.probeY * level.dirGrid <= size.height, `${label}: fits allocated height`);
        }
    }
}

// --- the snap grid -----------------------------------------------------------
// Every filter over the lighting buffers is aligned to the buffers, so they are
// rasterised on this grid to stop those filters sliding as the camera moves.
{
    for (const [w, h] of [
        [640, 360],
        [1920, 1080],
        [100, 100],
    ] as const) {
        for (const spacing of [1, 2, 3, 4]) {
            const levels = buildLevels(w, h, spacing, spacing);
            const q = snapQuantum(levels, Math.min(w, h));
            const label = `${w}x${h} @ spacing ${spacing}`;

            for (const level of levels) {
                if (level.spacing > Math.min(w, h)) continue;
                // Both grids the level filters on have to divide the snap, or that
                // level slides anyway: its probe lattice and its mip cell, which
                // is the next power of two at or above its stride.
                assert.equal(q % level.spacing, 0, `${label}: snap ${q} holds level spacing ${level.spacing}`);
                const cell = 2 ** Math.ceil(Math.log2(level.stride));
                assert.equal(q % cell, 0, `${label}: snap ${q} holds mip cell ${cell}`);
            }
            // The buffers are padded by the snap, so it must stay a fraction of
            // them rather than a multiple.
            assert.ok(q <= Math.min(w, h), `${label}: snap ${q} fits the buffer`);
        }
    }
    // A cascade coarser than the buffer is skipped rather than snapped to.
    assert.equal(snapQuantum(buildLevels(640, 360, 2, 2, 10), 360), 256);
    assert.equal(snapQuantum(buildLevels(640, 360, 2, 2, 1), 360), 2);
}

// An explicit cascade count is honoured and clamped to something renderable.
assert.equal(buildLevels(640, 360, 2, 2, 3).length, 3);
assert.equal(buildLevels(640, 360, 2, 2, 0).length, 1);
assert.equal(buildLevels(640, 360, 2, 2, 99).length, 10);

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

    // The GI buffers are rasterised on a coarse grid, so lights are shifted onto
    // it too -- position only, never the falloff radius.
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

console.log('cascade hierarchy ok');
console.log('snap grid ok');
console.log('occluder light packing ok');
