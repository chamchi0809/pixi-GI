/**
 * Noita-style falling-sand cellular automaton.
 *
 * Pure logic, no Pixi and no assets -- every pixel is a grid cell whose colour
 * comes from the material table plus a per-cell jitter. `check.ts` runs it
 * headless.
 */

export const EMPTY = 0;
export const STONE = 1;
export const SAND = 2;
export const WATER = 3;
export const OIL = 4;
export const LAVA = 5;
export const FIRE = 6;
export const SMOKE = 7;
export const STEAM = 8;
export const WOOD = 9;
export const ACID = 10;
export const EMBER = 11;
export const MOSS = 12;

export type Kind = 'air' | 'static' | 'powder' | 'liquid' | 'gas';

export interface Material {
    name: string;
    kind: Kind;
    /** Heavier sinks through lighter. */
    density: number;
    /** Base colour 0..255; the per-cell jitter shifts it up or down. */
    rgb: readonly [number, number, number];
    jitter: number;
    /** Occlusion-map alpha, 0..255. Air and flame let light straight through. */
    occ: number;
    /** Albedo alpha, 0..255. Air is 0 so the background wall shows through. */
    opacity: number;
    /** Emitted colour, or `null` for a cold material. */
    glow: readonly [number, number, number] | null;
    /** Multiplier on {@link Material.glow} when the emission map is written. */
    heat: number;
    /** Chance per adjacent flame of catching fire. */
    flammable: number;
    /** How many cells a liquid may slide sideways in one step. */
    dispersion: number;
    /** Frames before a gas or flame decays. 0 = never. */
    life: number;
    /** Brightening on the top ~12% of cells, which reads as mineral grit. */
    speckle: number;
}

const M = (name: string, kind: Kind, density: number, rgb: [number, number, number], jitter: number, occ: number, extra: Partial<Material> = {}): Material => ({
    name,
    kind,
    density,
    rgb,
    jitter,
    occ,
    opacity: 255,
    glow: null,
    heat: 0,
    flammable: 0,
    dispersion: 0,
    life: 0,
    speckle: 0,
    ...extra,
});

export const MATERIALS: readonly Material[] = [
    M('air', 'air', 0, [0, 0, 0], 0, 0, { opacity: 0 }),
    // Cold blue-grey with pale grit in it, the way cave rock reads once the
    // ambient is this dark. Low jitter, high speckle: mottled, not noisy.
    M('stone', 'static', 9, [56, 62, 74], 9, 255, { speckle: 34 }),
    M('sand', 'powder', 5, [176, 146, 88], 20, 255, { speckle: 26 }),
    M('water', 'liquid', 3, [30, 74, 138], 10, 190, { dispersion: 6, opacity: 225 }),
    M('oil', 'liquid', 2, [46, 36, 28], 8, 205, { dispersion: 3, flammable: 0.35 }),
    M('lava', 'liquid', 6, [246, 82, 14], 22, 110, {
        dispersion: 1,
        glow: [255, 78, 16],
        heat: 1,
    }),
    // Orange into red, no yellow: the jitter is what pushes the hottest cells
    // up towards white, so the base colour has to start well below it.
    M('fire', 'gas', 0.4, [230, 74, 18], 54, 0, {
        life: 42,
        opacity: 235,
        glow: [255, 70, 14],
        heat: 0.7,
    }),
    M('smoke', 'gas', 0.3, [44, 44, 52], 12, 70, { life: 170, opacity: 195 }),
    M('steam', 'gas', 0.2, [150, 168, 184], 14, 45, { life: 130, opacity: 165 }),
    M('wood', 'static', 9, [96, 70, 38], 12, 255, { flammable: 0.06, speckle: 22 }),
    M('acid', 'liquid', 3.5, [110, 226, 60], 18, 190, { dispersion: 4, opacity: 230 }),
    // Burning wood. Flame is a gas and floats away from its fuel within a few
    // frames, so the thing that actually spreads a fire has to stay put.
    M('ember', 'static', 9, [156, 44, 14], 40, 255, { life: 200, glow: [255, 62, 12], heat: 0.9 }),
    // The green crust on every upward-facing rock surface. Purely cosmetic, but
    // it is what makes a cave read as a cave rather than a cave-shaped hole.
    M('moss', 'static', 9, [88, 108, 42], 14, 255, { flammable: 0.05, speckle: 46 }),
];

/** What acid eats. */
const DISSOLVES = new Set([STONE, SAND, WOOD, MOSS]);
/** What sets its neighbours on fire. */
const IGNITES = new Set([LAVA, FIRE, EMBER]);

/** A wall bracket. Not a cell: the scene draws it as a pixel-art emitter. */
export interface Torch {
    x: number;
    y: number;
    /** Which way the bracket points away from the rock: -1 left, 1 right. */
    dir: number;
}

export class Sim {
    readonly width: number;
    readonly height: number;
    /** Material id per cell. */
    readonly cell: Uint8Array;
    /** Per-cell colour jitter, rolled once when the cell is written. */
    readonly tint: Uint8Array;
    /** Countdown for gases and flame. */
    readonly life: Uint8Array;
    /** Where {@link generate} bracketed torches to the rock. */
    readonly torches: Torch[] = [];
    /** Frame stamp: a cell that already moved this step is skipped. */
    private readonly stamp: Uint32Array;
    private frame = 0;
    private seed: number;

    constructor(width: number, height: number, seed = 1) {
        this.width = width;
        this.height = height;
        const n = width * height;
        this.cell = new Uint8Array(n);
        this.tint = new Uint8Array(n);
        this.life = new Uint8Array(n);
        this.stamp = new Uint32Array(n);
        this.seed = seed >>> 0 || 1;
    }

    /** LCG -- deterministic, so the headless check reproduces. */
    private rnd(): number {
        this.seed = (Math.imul(this.seed, 1664525) + 1013904223) >>> 0;
        return this.seed / 4294967296;
    }

    at(x: number, y: number): number {
        if (x < 0 || y < 0 || x >= this.width || y >= this.height) return STONE; // walls
        return this.cell[y * this.width + x]!;
    }

    set(i: number, mat: number): void {
        const { life } = MATERIALS[mat]!;
        this.cell[i] = mat;
        this.tint[i] = (this.rnd() * 256) | 0;
        // Spread the lifetimes out. A blast writes a hundred cells in one call,
        // and on a fixed life the whole cloud winks out on the same frame.
        this.life[i] = life ? Math.min(255, (life * (0.55 + this.rnd() * 0.9)) | 0) : 0;
    }

    /** Stamp a disc of `mat`. `EMPTY` erases. */
    paint(cx: number, cy: number, radius: number, mat: number, density = 1): void {
        const r2 = radius * radius;
        for (let y = Math.max(0, cy - radius); y <= Math.min(this.height - 1, cy + radius); y++) {
            for (let x = Math.max(0, cx - radius); x <= Math.min(this.width - 1, cx + radius); x++) {
                const dx = x - cx;
                const dy = y - cy;
                if (dx * dx + dy * dy > r2) continue;
                if (density < 1 && this.rnd() > density) continue;
                this.set(y * this.width + x, mat);
            }
        }
    }

    /** Can the wizard stand on / bump into this? */
    solid(x: number, y: number): boolean {
        const k = MATERIALS[this.at(x, y)]!.kind;
        return k === 'static' || k === 'powder';
    }

    /** Blow a crater and scatter flame around its lip. */
    explode(cx: number, cy: number, radius: number): void {
        this.paint(cx, cy, Math.round(radius * 0.55), EMPTY);
        for (let y = Math.max(0, cy - radius); y <= Math.min(this.height - 1, cy + radius); y++) {
            for (let x = Math.max(0, cx - radius); x <= Math.min(this.width - 1, cx + radius); x++) {
                const d = Math.hypot(x - cx, y - cy);
                if (d > radius || this.rnd() > 1 - d / radius) continue;
                const i = y * this.width + x;
                if (this.cell[i] === STONE) continue; // the cave itself survives the lip
                this.set(i, FIRE);
            }
        }
    }

    step(): void {
        const { width: w, height: h, cell, stamp } = this;
        this.frame++;
        const frame = this.frame;

        for (let y = h - 1; y >= 0; y--) {
            // Alternate scan direction so piles do not lean.
            const leftward = ((frame + y) & 1) === 1;
            for (let k = 0; k < w; k++) {
                const x = leftward ? w - 1 - k : k;
                const i = y * w + x;
                const m = cell[i]!;
                if (m === EMPTY || stamp[i] === frame) continue;
                const mat = MATERIALS[m]!;

                if (IGNITES.has(m)) this.burn(x, y, i, m);
                if (m === ACID) this.corrode(x, y, i);
                if (m === EMBER) this.smoulder(x, y, i);
                if (cell[i] !== m) continue; // the reaction consumed us

                switch (mat.kind) {
                    case 'powder':
                        this.fall(x, y, i, 1);
                        break;
                    case 'liquid':
                        if (!this.fall(x, y, i, 1)) this.slide(x, y, i, mat.dispersion);
                        break;
                    case 'gas':
                        if (this.life[i]! <= 1) {
                            // Mostly smoke: a flame should hand off to something
                            // on its way up, not just stop existing.
                            this.set(i, m === FIRE ? (this.rnd() < 0.7 ? SMOKE : EMPTY) : EMPTY);
                        } else {
                            this.life[i] = this.life[i]! - 1;
                            if (!this.fall(x, y, i, -1)) this.slide(x, y, i, 2);
                        }
                        break;
                    default:
                        break;
                }
            }
        }
    }

    // --- movement -------------------------------------------------------------

    /** Down for `dy = 1`, up for gases. Straight first, then the two diagonals. */
    private fall(x: number, y: number, i: number, dy: number): boolean {
        if (this.move(i, x, y + dy)) return true;
        const d = this.rnd() < 0.5 ? -1 : 1;
        return this.move(i, x + d, y + dy) || this.move(i, x - d, y + dy);
    }

    /** Walk sideways up to `n` cells, stopping at the first blocked one. */
    private slide(x: number, y: number, i: number, n: number): void {
        if (n <= 0) return;
        const d = this.rnd() < 0.5 ? -1 : 1;
        let cx = x;
        let ci = i;
        for (let s = 0; s < n; s++) {
            if (!this.move(ci, cx + d, y)) break;
            cx += d;
            ci = y * this.width + cx;
        }
    }

    /** Swap into (tx, ty) if that cell is air, or fluid that this one outweighs. */
    private move(from: number, tx: number, ty: number): boolean {
        const { width: w, height: h } = this;
        if (tx < 0 || ty < 0 || tx >= w || ty >= h) return false;
        const to = ty * w + tx;
        const target = this.cell[to]!;
        if (target !== EMPTY) {
            const t = MATERIALS[target]!;
            if (t.kind === 'static' || t.kind === 'powder') return false;
            // Sinking needs the target to be lighter; a rising gas needs it
            // heavier, otherwise steam would drown under the water that made it.
            const d = MATERIALS[this.cell[from]!]!.density;
            if (ty < ((from / w) | 0) ? d >= t.density : d <= t.density) return false;
        }
        this.swap(from, to);
        return true;
    }

    private swap(a: number, b: number): void {
        const { cell, tint, life, stamp } = this;
        const c = cell[a]!;
        cell[a] = cell[b]!;
        cell[b] = c;
        const t = tint[a]!;
        tint[a] = tint[b]!;
        tint[b] = t;
        const l = life[a]!;
        life[a] = life[b]!;
        life[b] = l;
        stamp[a] = this.frame;
        stamp[b] = this.frame;
    }

    // --- reactions ------------------------------------------------------------

    /** Fire and lava: ignite what burns, quench in water, make steam. */
    private burn(x: number, y: number, i: number, m: number): void {
        for (let k = 0; k < 4; k++) {
            const nx = x + (k === 0 ? -1 : k === 1 ? 1 : 0);
            const ny = y + (k === 2 ? -1 : k === 3 ? 1 : 0);
            if (nx < 0 || ny < 0 || nx >= this.width || ny >= this.height) continue;
            const j = ny * this.width + nx;
            const n = this.cell[j]!;

            if (n === WATER || n === ACID) {
                // Lava freezes where it meets water, boiling it off. Flame goes
                // out; a doused ember is just wet wood again.
                if (m === LAVA) {
                    this.set(j, STEAM);
                    this.set(i, STONE);
                } else {
                    this.set(i, m === EMBER ? WOOD : STEAM);
                }
                return;
            }
            const f = MATERIALS[n]!.flammable;
            if (f === 0 || this.rnd() >= f) continue;
            // Solid fuel smoulders in place; a liquid one flashes off as flame.
            this.set(j, MATERIALS[n]!.kind === 'static' ? EMBER : FIRE);
        }
    }

    /** An ember eats its own log, throws the odd flame, and finally goes out. */
    private smoulder(x: number, y: number, i: number): void {
        const left = this.life[i]! - 1;
        if (left <= 0) {
            this.set(i, this.rnd() < 0.35 ? SMOKE : EMPTY);
            return;
        }
        this.life[i] = left;
        if (this.rnd() < 0.1 && y > 0 && this.cell[i - this.width] === EMPTY) {
            this.set(i - this.width, FIRE);
        }
    }

    /** Acid eats a neighbour and is used up doing it. */
    private corrode(x: number, y: number, i: number): void {
        if (this.rnd() > 0.06) return;
        const k = (this.rnd() * 4) | 0;
        const nx = x + (k === 0 ? -1 : k === 1 ? 1 : 0);
        const ny = y + (k === 2 ? -1 : k === 3 ? 1 : 0);
        if (nx < 0 || ny < 0 || nx >= this.width || ny >= this.height) return;
        const j = ny * this.width + nx;
        if (!DISSOLVES.has(this.cell[j]!)) return;
        this.set(j, EMPTY);
        this.set(i, this.rnd() < 0.5 ? EMPTY : SMOKE);
    }
}

// --- world generation ---------------------------------------------------------

/** Hash-based value noise. No tables, no imports, deterministic. */
export function noise(x: number, y: number, seed: number): number {
    const h = (a: number, b: number): number => {
        let n = Math.imul(a, 374761393) + Math.imul(b, 668265263) + Math.imul(seed, 2654435761);
        n = Math.imul(n ^ (n >>> 13), 1274126177);
        return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
    };
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const fx = x - xi;
    const fy = y - yi;
    const sx = fx * fx * (3 - 2 * fx);
    const sy = fy * fy * (3 - 2 * fy);
    const a = h(xi, yi) + (h(xi + 1, yi) - h(xi, yi)) * sx;
    const b = h(xi, yi + 1) + (h(xi + 1, yi + 1) - h(xi, yi + 1)) * sx;
    return a + (b - a) * sy;
}

function fbm(x: number, y: number, seed: number): number {
    return (
        noise(x, y, seed) * 0.5 + noise(x * 2, y * 2, seed + 1) * 0.3 + noise(x * 4, y * 4, seed + 2) * 0.2
    );
}

/** Rows between cavern floors. */
const FLOOR = 46;
const TORCH_SPACING = 34;
/** Scene density, not a library limit -- the occluder light pass is unbounded. */
const MAX_TORCHES = 18;

/**
 * A cave in layers: wide flat-floored chambers stacked on top of each other,
 * sand in the upper pockets, water in the middle ones, a lava lake at the
 * bottom and a few wooden props to set alight.
 */
export function generate(sim: Sim, seed = 7): Sim {
    const { width: w, height: h, cell } = sim;
    for (let y = 0; y < h; y++) {
        const depth = y / h;
        // `fbm` sits around 0.5, so a threshold near it splits the map roughly
        // half rock, half cavern. The top is open sky, the last rows are bedrock.
        const openness = depth < 0.06 ? 1.4 : depth > 0.97 ? -1 : 0.58 - depth * 0.05;
        // A soft floor every FLOOR rows. Stacking this on the noise is what
        // turns round blobs into shelves you can stand on and fly between.
        const shelf = Math.cos((y / FLOOR) * Math.PI * 2) * 0.1;
        for (let x = 0; x < w; x++) {
            const i = y * w + x;
            // Stretched five to one, so caverns come out wide and low.
            const rock = fbm(x * 0.009, y * 0.045, seed) - shelf < openness ? EMPTY : STONE;
            let mat = rock;
            if (rock === STONE && depth > 0.15 && fbm(x * 0.05, y * 0.05, seed + 40) > 0.66) {
                mat = SAND;
            }
            if (rock === EMPTY && depth > 0.92) mat = LAVA;
            else if (rock === EMPTY && depth > 0.42 && depth < 0.62 && fbm(x * 0.03, y * 0.09, seed + 80) > 0.66) {
                mat = WATER;
            } else if (rock === EMPTY && depth > 0.24 && depth < 0.38 && fbm(x * 0.04, y * 0.1, seed + 120) > 0.72) {
                mat = OIL;
            }
            sim.set(i, mat);
        }
    }

    // Spans across open space: stone bridges to fly under and stand on, wooden
    // ones to set alight. Both are laid over air only, so they read as built.
    const span = (n: number, mat: number, thickness: number): void => {
        const px = 6 + ((noise(n, 3, seed) * (w - 50)) | 0);
        const want = ((0.18 + noise(n, 9, seed) * 0.6) * h) | 0;
        const len = 18 + ((noise(n, 5, seed) * 40) | 0);
        const end = Math.min(w, px + len);

        // Slide the span to the emptiest row near where it wanted to be: a
        // bridge laid inside solid rock is just rock.
        let py = want;
        let best = -Infinity;
        for (let y = 8; y < h - 8; y += 2) {
            let open = 0;
            for (let x = px; x < end; x++) if (cell[y * w + x] === EMPTY) open++;
            const score = open - Math.abs(y - want) * 0.35;
            if (score > best) {
                best = score;
                py = y;
            }
        }

        for (let x = px; x < end; x++) {
            // A shallow sag, so a bridge is not a perfect ruler.
            const sag = Math.round(Math.sin(((x - px) / len) * Math.PI) * 2);
            for (let y = py + sag; y < Math.min(h, py + sag + thickness); y++) {
                const c = cell[y * w + x];
                if (c === EMPTY || c === SAND) sim.set(y * w + x, mat);
            }
        }
    };
    for (let n = 0; n < 5; n++) span(n, STONE, 3);
    for (let n = 5; n < 10; n++) span(n, WOOD, 2);

    // Torches bracketed to the vertical faces of the rock. Spacing rather than a
    // dice roll: a random-per-cell chance gave one cave sixteen torches and the
    // next none, and the light budget wants them spread out anyway.
    sim.torches.length = 0;
    for (let y = 6; y < h - 6 && sim.torches.length < MAX_TORCHES; y += 2) {
        for (let x = 3; x < w - 3; x++) {
            // Rock on one side, and a clear column above for the flame.
            const facing = cell[y * w + x - 1] === STONE ? 1 : cell[y * w + x + 1] === STONE ? -1 : 0;
            if (facing === 0 || cell[y * w + x + facing] !== EMPTY) continue;
            let room = true;
            for (let k = 0; k <= 6 && room; k++) room = cell[(y - k) * w + x] === EMPTY;
            if (!room) continue;
            if (
                sim.torches.some((t) => Math.abs(t.x - x) < TORCH_SPACING && Math.abs(t.y - y) < TORCH_SPACING)
            ) {
                continue;
            }
            sim.torches.push({ x, y, dir: facing });
        }
    }

    // Moss on every upward-facing rock surface, and a ragged second row under
    // some of it. Last, so the torch scan still sees bare stone walls.
    for (let y = 1; y < h - 1; y++) {
        for (let x = 0; x < w; x++) {
            const i = y * w + x;
            if (cell[i] !== STONE || cell[i - w] !== EMPTY) continue;
            sim.set(i, MOSS);
            if (cell[i + w] === STONE && noise(x, y, seed + 300) > 0.55) sim.set(i + w, MOSS);
        }
    }
    return sim;
}
