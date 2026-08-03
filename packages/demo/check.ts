/**
 * The one runnable check: the falling-sand rules are the only part of the demo
 * that is pure logic rather than pixels on a screen. `pnpm --filter demo check`
 */
import assert from 'node:assert/strict';
import { EMBER, EMPTY, FIRE, LAVA, MOSS, SAND, STEAM, STONE, Sim, WATER, WOOD, generate } from './src/sand/sim.ts';
import { keyOf } from './src/keys.ts';

// --- the keyboard reads physical keys, so an active IME cannot break it -------
{
    // What Chrome actually reports for W with a Korean layout: key is the jamo on
    // keydown and 'Process' mid-composition, code stays KeyW.
    for (const key of ['w', 'W', 'ㅈ', 'Process', 'Unidentified', '']) {
        assert.equal(keyOf({ code: 'KeyW', key } as KeyboardEvent), 'w', `KeyW + ${key || '<empty>'}`);
    }
    assert.equal(keyOf({ code: 'Digit3', key: 'Process' } as KeyboardEvent), '3');
    assert.equal(keyOf({ code: 'Space', key: ' ' } as KeyboardEvent), ' ');
    assert.equal(keyOf({ code: 'ArrowLeft', key: 'ArrowLeft' } as KeyboardEvent), 'arrowleft');
    assert.equal(keyOf({ code: 'BracketRight', key: 'ㅐ' } as KeyboardEvent), ']');
    assert.equal(keyOf({ code: '', key: 'Shift' } as KeyboardEvent), 'shift', 'falls back to key');
}

const count = (sim: Sim, mat: number): number => sim.cell.reduce((n, c) => n + (c === mat ? 1 : 0), 0);
const run = (sim: Sim, steps: number): Sim => {
    for (let i = 0; i < steps; i++) sim.step();
    return sim;
};

// --- powders fall, and nothing is created or destroyed on the way down --------
{
    const sim = new Sim(32, 40);
    sim.paint(16, 4, 5, SAND);
    const grains = count(sim, SAND);
    assert.ok(grains > 50, 'the brush actually painted something');

    run(sim, 200);
    assert.equal(count(sim, SAND), grains, 'sand is conserved while falling');
    for (let x = 0; x < 32; x++) {
        assert.equal(sim.at(x, 0), EMPTY, `column ${x} emptied at the top`);
    }
    const settled = Array.from({ length: 40 }, (_, y) =>
        Array.from({ length: 32 }, (_, x) => sim.at(x, y)).filter((m) => m === SAND).length,
    );
    assert.ok(settled.slice(0, 30).every((n) => n === 0), 'the pile settled in the bottom rows');
}

// --- liquids spread sideways, powders do not ---------------------------------
{
    const width = (sim: Sim): number => {
        let lo = Infinity;
        let hi = -Infinity;
        for (let y = 0; y < sim.height; y++) {
            for (let x = 0; x < sim.width; x++) {
                if (sim.at(x, y) === WATER) {
                    lo = Math.min(lo, x);
                    hi = Math.max(hi, x);
                }
            }
        }
        return hi - lo;
    };
    const sim = new Sim(64, 40);
    sim.paint(32, 6, 4, WATER);
    const dropped = width(sim);
    run(sim, 300);
    assert.ok(width(sim) > dropped * 2, `water pooled out (${dropped} -> ${width(sim)})`);
}

// --- sand sinks through water ------------------------------------------------
{
    const sim = new Sim(16, 40);
    for (let y = 20; y < 40; y++) for (let x = 0; x < 16; x++) sim.set(y * 16 + x, WATER);
    sim.set(8 * 16 + 8, SAND);
    run(sim, 400);
    let sandY = -1;
    for (let y = 0; y < 40; y++) for (let x = 0; x < 16; x++) if (sim.at(x, y) === SAND) sandY = y;
    assert.ok(sandY > 30, `sand sank through the water to row ${sandY}`);
}

// --- lava quenches into stone, water flashes to steam ------------------------
{
    const sim = new Sim(20, 20);
    for (let x = 0; x < 20; x++) {
        sim.set(9 * 20 + x, LAVA);
        sim.set(10 * 20 + x, WATER);
        sim.set(19 * 20 + x, STONE); // a floor, so nothing leaves the bottom
    }
    run(sim, 60);
    assert.ok(count(sim, STONE) > 20, 'lava froze on contact with water');
    assert.ok(count(sim, STEAM) > 0, 'the water boiled off');
}

// --- fire consumes wood and then goes out ------------------------------------
{
    const sim = new Sim(24, 24);
    for (let x = 2; x < 22; x++) for (let y = 10; y < 13; y++) sim.set(y * 24 + x, WOOD);
    sim.set(11 * 24 + 12, FIRE); // buried in the plank, so it cannot just float off
    const wood = count(sim, WOOD);
    run(sim, 400);
    assert.ok(count(sim, WOOD) < wood / 2, `fire ate the plank (${wood} -> ${count(sim, WOOD)})`);

    run(sim, 900);
    assert.equal(count(sim, FIRE) + count(sim, EMBER), 0, 'the fire goes out once there is nothing left');
}

// --- a generated cave has the things the demo promises -----------------------
{
    const sim = generate(new Sim(320, 180));
    // Every seed, not just the default one: torch placement used to be a per-cell
    // dice roll and some caves came out pitch black.
    for (const seed of [7, 123, 99999]) {
        const cave = generate(new Sim(320, 180), seed);
        assert.ok(cave.torches.length > 8, `seed ${seed} got wall torches (${cave.torches.length})`);
        for (const t of cave.torches) {
            assert.equal(cave.at(t.x, t.y - 6), EMPTY, 'the torch flame has room above it');
            const behind = cave.at(t.x - t.dir, t.y);
            // MOSS too: the crust pass runs after the torches are sited.
            assert.ok(behind === STONE || behind === MOSS, `rock behind the bracket, got ${behind}`);
        }
    }
    assert.ok(count(sim, LAVA) > 400, 'there is a lava lake to light the place');
    assert.ok(count(sim, WOOD) > 100, 'there are wooden spans to burn');
    assert.ok(count(sim, EMPTY) > 320 * 180 * 0.15, 'and enough open cave to fly around in');

    // A fireball hit carves the rock and leaves flame around the lip.
    let hit = -1;
    for (let i = 0; i < sim.cell.length && hit < 0; i++) if (sim.cell[i] === STONE) hit = i;
    const rock = count(sim, STONE);
    sim.explode(hit % 320, (hit / 320) | 0, 7);
    assert.ok(count(sim, STONE) < rock, 'the blast took a bite out of the rock');
    assert.ok(count(sim, FIRE) > 0, 'and scattered fire');

    // That fire has to die out, not pop: every cell of one blast used to get the
    // same lifetime, so the whole cloud vanished on a single frame.
    const peak = count(sim, FIRE);
    let worst = 0;
    for (let prev = peak; prev > 0; ) {
        sim.step();
        const now = count(sim, FIRE);
        worst = Math.max(worst, prev - now);
        prev = now;
    }
    assert.ok(worst < peak * 0.35, `the flame thins out over many frames (worst frame lost ${worst}/${peak})`);
}

console.log('sand sim ok');
