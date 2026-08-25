import { AnimatedSprite, Container, Sprite } from "pixi.js";
import type { Texture } from "pixi.js";
import { setMaterial } from "pixi-rcgi";
import { TILE, type Level } from "./level.ts";

const WIDTH = 46;
const HEIGHT = 88;
const GRAVITY = 2600;
const RUN_SPEED = 430;
const GROUND_ACCEL = 9000;
const AIR_ACCEL = 3200;
const GROUND_FRICTION = 9000;
const JUMP_SPEED = 1150;
const MAX_FALL = 1400;
/** Ground jump + one air jump. */
const MAX_JUMPS = 2;
/** Still jumpable this long after walking off a ledge. */
const COYOTE = 0.09;
/** A jump pressed this long before landing still fires. */
const BUFFER = 0.12;
/** Walk cycle steps at 12fps. */
const WALK_STEP = 1 / 12;

export interface PlayerTextures {
  stand: Texture;
  jump: Texture;
  duck: Texture;
  walk: Texture[];
}

export interface Input {
  left: boolean;
  right: boolean;
  down: boolean;
  jump: boolean;
}

export class Player {
  readonly view = new Container();

  /** Hitbox top-left, in level pixels. */
  x: number;
  y: number;
  vx = 0;
  vy = 0;
  onGround = false;

  private readonly _stand: Sprite;
  private readonly _jump: Sprite;
  private readonly _duck: Sprite;
  private readonly _walk: AnimatedSprite;
  private _facing = 1;
  private _coyote = 0;
  private _buffer = 0;
  private _jumps = MAX_JUMPS;
  private _walkTime = 0;
  private _jumpHeld = false;

  // Not a constructor parameter property: `check.ts` runs under node's
  // strip-only TypeScript, which rejects those.
  private readonly level: Level;

  constructor(level: Level, tex: PlayerTextures) {
    this.level = level;
    this.x = level.spawnX - WIDTH / 2;
    this.y = level.spawnY - HEIGHT;

    const body = new Container();
    const make = (texture: Texture): Sprite => {
      const s = new Sprite(texture);
      s.anchor.set(0.5, 1);
      body.addChild(s);
      return s;
    };
    this._stand = make(tex.stand);
    this._jump = make(tex.jump);
    this._duck = make(tex.duck);

    this._walk = new AnimatedSprite(tex.walk);
    this._walk.anchor.set(0.5, 1);
    // Stepped by hand in _draw: Ticker.shared is not app.ticker, so an
    // autoUpdate sprite runs on its own clock and keeps going while idle.
    this._walk.autoUpdate = false;
    body.addChild(this._walk);

    setMaterial(body, { occlusion: 1 });
    this.view.addChild(body);
  }

  update(dt: number, input: Input): void {
    const ducking = input.down && this.onGround;
    const dir = (input.right ? 1 : 0) - (input.left ? 1 : 0);

    if (dir !== 0 && !ducking) {
      this._facing = dir;
      const accel = this.onGround ? GROUND_ACCEL : AIR_ACCEL;
      this.vx = approach(this.vx, dir * RUN_SPEED, accel * dt);
    } else {
      this.vx = approach(
        this.vx,
        0,
        (this.onGround ? GROUND_FRICTION : AIR_ACCEL * 0.5) * dt,
      );
    }

    this._coyote = this.onGround ? COYOTE : Math.max(0, this._coyote - dt);
    this._buffer =
      input.jump && !this._jumpHeld ? BUFFER : Math.max(0, this._buffer - dt);
    this._jumpHeld = input.jump;

    // Fell off a ledge without jumping: the ground jump is spent, the air one isn't.
    if (this.onGround) this._jumps = MAX_JUMPS;
    else if (this._coyote <= 0)
      this._jumps = Math.min(this._jumps, MAX_JUMPS - 1);

    if (this._buffer > 0 && this._jumps > 0) {
      this.vy = -JUMP_SPEED;
      this._jumps--;
      this._buffer = 0;
      this._coyote = 0;
      this.onGround = false;
    }

    this.vy = Math.min(this.vy + GRAVITY * dt, MAX_FALL);
    this._move(dt);
    this._draw(dt, ducking, dir);
  }

  private _move(dt: number): void {
    this.x += this.vx * dt;
    this._resolve("x");
    this.y += this.vy * dt;
    this.onGround = false;
    this._resolve("y");

    this.view.position.set(this.x + WIDTH / 2, this.y + HEIGHT);
  }

  /** Per-axis AABB against the tile grid. Assumes < 1 tile of travel per step. */
  private _resolve(axis: "x" | "y"): void {
    const left = Math.floor(this.x / TILE);
    const right = Math.floor((this.x + WIDTH - 1) / TILE);
    const top = Math.floor(this.y / TILE);
    const bottom = Math.floor((this.y + HEIGHT - 1) / TILE);

    if (axis === "x") {
      if (this.vx > 0) {
        for (let r = top; r <= bottom; r++) {
          if (this.level.isSolid(right, r)) {
            this.x = right * TILE - WIDTH;
            this.vx = 0;
            return;
          }
        }
      } else if (this.vx < 0) {
        for (let r = top; r <= bottom; r++) {
          if (this.level.isSolid(left, r)) {
            this.x = (left + 1) * TILE;
            this.vx = 0;
            return;
          }
        }
      }
      return;
    }

    if (this.vy > 0) {
      // No 1px inset here: resting flush on a tile must still read as
      // ground, or `onGround` flickers every other frame as gravity
      // re-penetrates less than a pixel.
      const feet = Math.floor((this.y + HEIGHT) / TILE);
      for (let c = left; c <= right; c++) {
        if (this.level.isSolid(c, feet)) {
          this.y = feet * TILE - HEIGHT;
          this.vy = 0;
          this.onGround = true;
          return;
        }
      }
    } else if (this.vy < 0) {
      for (let c = left; c <= right; c++) {
        if (this.level.isSolid(c, top)) {
          this.y = (top + 1) * TILE;
          this.vy = 0;
          return;
        }
      }
    }
  }

  private _draw(dt: number, ducking: boolean, dir: number): void {
    const moving =
      this.onGround && dir !== 0 && Math.abs(this.vx) > 20 && !ducking;
    this._stand.visible = this.onGround && !ducking && !moving;
    this._walk.visible = moving;
    this._duck.visible = ducking;
    this._jump.visible = !this.onGround;

    if (moving) {
      this._walkTime += dt;
      while (this._walkTime >= WALK_STEP) {
        this._walkTime -= WALK_STEP;
        this._walk.gotoAndStop(
          (this._walk.currentFrame + 1) % this._walk.totalFrames,
        );
      }
    } else {
      this._walkTime = 0;
    }
    this.view.scale.x = this._facing;
  }
}

function approach(value: number, target: number, delta: number): number {
  return value < target
    ? Math.min(value + delta, target)
    : Math.max(value - delta, target);
}
