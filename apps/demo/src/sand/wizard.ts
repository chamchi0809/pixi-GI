import { Container, Sprite } from 'pixi.js';
import { setMaterial } from 'pixi-radiance';
import { pixelTexture } from './pixels';
import { FIRE, Sim } from './sim';

/**
 * Side profile, facing right: hat trailing back, nose out front, one eye. Not
 * mirror-symmetric, so which way he is turned is legible at twelve pixels tall.
 */
const ART = [
    '...HH.....',
    '..HHHHH...',
    '.HHHHHHH..',
    '..HHHHH.S.',
    '..FFFn..S.',
    '..FeFn..S.',
    '..BBB...S.',
    '.RRRRr..S.',
    '.RRRRR..S.',
    '.RRRRR..S.',
    '..RRRR....',
    '.RRRRRR...',
];
const PALETTE: Record<string, number> = {
    H: 0x40265c, // hat
    F: 0xe8c49a, // face
    n: 0xcf9f78, // nose, one shade down so the profile reads
    e: 0x1a1420, // eye
    B: 0xd6d8e4, // beard
    R: 0xc4508c, // robe
    r: 0xe87ab4, // robe trim
    S: 0x6b4a2a, // staff
};

/** The staff's crystal and the fireball: pixel art, and the emitters themselves. */
const SPARK = pixelTexture(['.c.', 'cwc', '.c.'], { c: 0x7ad4ff, w: 0xe8fbff });
/** One pixel: the streak comes from the ember trail, not from a fat sprite. */
const FIREBALL_FRAMES = [0xff7a2a, 0xff4410].map((c) => pixelTexture(['f'], { f: c }));
/** What the shot sheds on its way. Cools bright orange -> dark red, then out. */
const EMBER_FRAMES = [0xff8a2a, 0xe8461a, 0x8c1c08].map((c) => pixelTexture(['e'], { e: c }));
const TRAIL_LIFE = 0.45;
const MAX_TRAIL = 260;
const ART_W = ART[0]!.length;
const ART_H = ART.length;
/** Where the staff tip sits, in art cells -- the crystal and the muzzle share it. */
const TIP_X = 8;
const TIP_Y = 2;

const HALF_W = 2;
const HALF_H = 6;

const GRAVITY = 100;
const THRUST = 250;
const RUN = 300;
const MAX_FALL = 95;
const MAX_RISE = 60;
const MAX_RUN = 52;

const SHOT_SPEED = 170;
const SHOT_LIFE = 3;
const MAX_SHOTS = 10;
const BLAST = 7;

export interface WizardInput {
    left: boolean;
    right: boolean;
    up: boolean;
    down: boolean;
    /** Pointer x in grid coordinates. He turns to face it, not to face his run. */
    aimX: number;
}

interface Shot {
    sprite: Sprite;
    x: number;
    y: number;
    vx: number;
    vy: number;
    life: number;
}

interface Ember extends Shot {
    /** Life it started with, so the colour ramp knows how far along it is. */
    max: number;
}

/**
 * A flying wizard, in grid coordinates. He occludes -- so he throws a real
 * shadow -- and everything he emits is a small sprite, which is what the
 * occluder surface light wants (it approximates emitters by their bounds).
 */
export class Wizard {
    readonly view = new Container();
    /** Fireballs live in their own container so they draw over the terrain. */
    readonly shots = new Container();

    x: number;
    y: number;
    private vx = 0;
    private vy = 0;
    private facing = 1;
    private cooldown = 0;
    private tick = 0;
    /** 0 or 1: the fireball animation phase. He himself has no idle motion. */
    private flame = 0;
    private readonly body: Sprite;
    private readonly staff: Sprite;
    private readonly live: Shot[] = [];
    private readonly pool: Shot[] = [];
    private readonly trail: Ember[] = [];
    private readonly trailPool: Ember[] = [];

    constructor(
        private readonly sim: Sim,
        x: number,
        y: number,
    ) {
        this.x = x;
        this.y = y;

        this.body = new Sprite(pixelTexture(ART, PALETTE));
        this.body.anchor.set(0.5);
        setMaterial(this.body, { occlusion: 1 });

        this.staff = new Sprite(SPARK);
        this.staff.anchor.set(0.5);
        setMaterial(this.staff, { emissive: 0x9fe4ff, emissiveIntensity: 6, occlusion: 1 });

        this.view.addChild(this.body, this.staff);
    }

    /** Muzzle position in grid coordinates, mirrored with the sprite. */
    get tipX(): number {
        return this.x + (TIP_X - ART_W / 2 + 0.5) * this.facing;
    }
    get tipY(): number {
        return this.y + (TIP_Y - ART_H / 2 + 0.5);
    }

    cast(aimX: number, aimY: number): void {
        if (this.cooldown > 0 || this.live.length >= MAX_SHOTS) return;
        this.cooldown = 0.22;

        const dx = aimX - this.tipX;
        const dy = aimY - this.tipY;
        const len = Math.hypot(dx, dy) || 1;
        const shot = this.pool.pop() ?? this.newShot();
        shot.x = this.tipX;
        shot.y = this.tipY;
        shot.vx = (dx / len) * SHOT_SPEED;
        shot.vy = (dy / len) * SHOT_SPEED;
        shot.life = SHOT_LIFE;
        shot.sprite.visible = true;
        this.live.push(shot);
        // Recoil, so hovering and spraying pushes you around.
        this.vx -= (dx / len) * 6;
        this.vy -= (dy / len) * 6;
    }

    private newShot(): Shot {
        const sprite = new Sprite(FIREBALL_FRAMES[0]);
        sprite.anchor.set(0.5);
        // Up from 7: the head is one pixel now, so it has less area to emit from.
        setMaterial(sprite, { emissive: 0xff4a10, emissiveIntensity: 10, occlusion: 1 });
        this.shots.addChild(sprite);
        return { sprite, x: 0, y: 0, vx: 0, vy: 0, life: 0 };
    }

    private newEmber(): Ember {
        const sprite = new Sprite(EMBER_FRAMES[0]);
        sprite.anchor.set(0.5);
        // Its own pixel colour is the light, and it stays out of the occluder
        // surface light -- 90 of these would evict every torch from its 32 slots.
        setMaterial(sprite, {
            emissive: 0xffffff,
            emissiveIntensity: 5,
            occlusion: 0,
            occluderLight: false,
        });
        this.shots.addChild(sprite);
        return { sprite, x: 0, y: 0, vx: 0, vy: 0, life: 0, max: 1 };
    }

    /** Drop one cooling ember at a point. */
    private shed(x: number, y: number): void {
        if (this.trail.length >= MAX_TRAIL) return;
        const e = this.trailPool.pop() ?? this.newEmber();
        e.x = x;
        e.y = y;
        e.vx = (Math.random() - 0.5) * 14;
        e.vy = -8 - Math.random() * 12;
        e.max = e.life = TRAIL_LIFE * (0.5 + Math.random());
        e.sprite.visible = true;
        this.trail.push(e);
    }

    private moveTrail(dt: number): void {
        for (let n = this.trail.length - 1; n >= 0; n--) {
            const e = this.trail[n]!;
            e.life -= dt;
            if (e.life <= 0) {
                e.sprite.visible = false;
                this.trail.splice(n, 1);
                this.trailPool.push(e);
                continue;
            }
            // Rises, then gives up: buoyancy bleeding off is what stops it
            // sailing off the top of the screen.
            e.vy += 26 * dt;
            e.x += e.vx * dt;
            e.y += e.vy * dt;
            const k = ((1 - e.life / e.max) * EMBER_FRAMES.length) | 0;
            e.sprite.texture = EMBER_FRAMES[Math.min(EMBER_FRAMES.length - 1, k)]!;
            e.sprite.position.set(Math.round(e.x) + 0.5, Math.round(e.y) + 0.5);
        }
    }

    update(dt: number, input: WizardInput): void {
        this.cooldown -= dt;
        this.flame = ((this.tick++ / 6) | 0) & 1;
        this.facing = input.aimX >= this.x ? 1 : -1;

        const drive = (input.right ? 1 : 0) - (input.left ? 1 : 0);
        this.vx += drive * RUN * dt;
        if (drive === 0) this.vx *= 0.82;
        this.vx = clamp(this.vx, -MAX_RUN, MAX_RUN);

        this.vy += (input.up ? GRAVITY - THRUST : GRAVITY) * dt;
        if (input.down) this.vy += GRAVITY * 0.6 * dt;
        this.vy = clamp(this.vy, -MAX_RISE, MAX_FALL);

        this.sweep(this.vx * dt, this.vy * dt);
        this.drawSelf();
        this.moveShots(dt);
        this.moveTrail(dt);
    }

    /** Step along the path a cell at a time so nothing tunnels through a wall. */
    private sweep(dx: number, dy: number): void {
        const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy))));
        for (let s = 0; s < steps; s++) {
            if (!this.blocked(this.x + dx / steps, this.y)) this.x += dx / steps;
            else this.vx = 0;
            if (!this.blocked(this.x, this.y + dy / steps)) this.y += dy / steps;
            else this.vy = 0;
        }
        this.x = clamp(this.x, HALF_W, this.sim.width - HALF_W);
        this.y = clamp(this.y, HALF_H, this.sim.height - HALF_H);
    }

    private blocked(x: number, y: number): boolean {
        for (let cy = Math.floor(y - HALF_H); cy <= Math.ceil(y + HALF_H); cy++) {
            for (let cx = Math.floor(x - HALF_W); cx <= Math.ceil(x + HALF_W); cx++) {
                if (this.sim.solid(cx, cy)) return true;
            }
        }
        return false;
    }

    private drawSelf(): void {
        // Whole pixels, no rotation, no idle bob: at this size any of that
        // resamples into mush or reads as a twitch.
        this.body.position.set(Math.round(this.x), Math.round(this.y));
        this.body.scale.x = this.facing;
        this.staff.position.set(Math.round(this.tipX) + 0.5, Math.round(this.tipY) + 0.5);
    }

    private moveShots(dt: number): void {
        for (let n = this.live.length - 1; n >= 0; n--) {
            const shot = this.live[n]!;
            shot.life -= dt;
            shot.vy += GRAVITY * 0.25 * dt;

            const steps = Math.max(1, Math.ceil(Math.hypot(shot.vx, shot.vy) * dt));
            let hit = false;
            for (let s = 0; s < steps && !hit; s++) {
                shot.x += (shot.vx * dt) / steps;
                shot.y += (shot.vy * dt) / steps;
                // One per sub-step, and a sub-step is about a pixel: shedding
                // once a frame left visible gaps at this speed.
                this.shed(shot.x, shot.y);
                hit = this.sim.solid(Math.round(shot.x), Math.round(shot.y));
            }

            if (hit || shot.life <= 0) {
                if (hit) this.sim.explode(Math.round(shot.x), Math.round(shot.y), BLAST);
                else this.sim.paint(Math.round(shot.x), Math.round(shot.y), 2, FIRE, 0.6);
                for (let k = 0; k < 14; k++) this.shed(shot.x, shot.y);
                shot.sprite.visible = false;
                this.live.splice(n, 1);
                this.pool.push(shot);
                continue;
            }
            shot.sprite.texture = FIREBALL_FRAMES[this.flame]!;
            shot.sprite.position.set(Math.round(shot.x) + 0.5, Math.round(shot.y) + 0.5);
        }
    }
}

function clamp(v: number, lo: number, hi: number): number {
    return Math.min(Math.max(v, lo), hi);
}
