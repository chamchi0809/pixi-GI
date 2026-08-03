/**
 * The one runnable check: the cascade hierarchy is the only part of the library
 * that is pure logic rather than GPU output. `pnpm --filter pixi-rcgi check`
 */
import assert from 'node:assert/strict';
import { buildLevels, cascadeTextureSize } from './src/cascades.ts';
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

// An explicit cascade count is honoured and clamped to something renderable.
assert.equal(buildLevels(640, 360, 2, 2, 3).length, 3);
assert.equal(buildLevels(640, 360, 2, 2, 0).length, 1);
assert.equal(buildLevels(640, 360, 2, 2, 99).length, 10);

// --- occluder surface lights -------------------------------------------------
{
    const out = new Float32Array(4 * LIGHT_FLOATS);
    // Half-resolution lighting on an 800x600 screen, 100px of falloff.
    const view = { width: 800, height: 600, sx: 0.5, sy: 0.5, range: 100 };
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
console.log('occluder light packing ok');
