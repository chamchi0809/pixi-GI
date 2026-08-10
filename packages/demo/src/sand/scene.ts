import { Container, Sprite, Texture } from "pixi.js";
import { setMaterial } from "pixi-rcgi";
import type { Scene } from "../scene";
import { keyOf } from "../keys";
import { buffer, clamp8, pixelTexture } from "./pixels";
import {
  ACID,
  EMPTY,
  FIRE,
  LAVA,
  MATERIALS,
  OIL,
  SAND,
  Sim,
  SMOKE,
  STONE,
  WATER,
  WOOD,
  generate,
  noise,
} from "./sim";
import { Wizard, type WizardInput } from "./wizard";

/** Simulation grid. Fixed 16:9; the sprite cover-scales to whatever the window is. */
const W = 480;
const H = 270;

const BRUSHES = [
  SAND,
  WATER,
  OIL,
  LAVA,
  FIRE,
  ACID,
  WOOD,
  STONE,
  SMOKE,
  EMPTY,
] as const;

/** Pixel-art torch: iron bracket, wooden shaft, two-frame flame. Anchored bottom-left. */
const TORCH_ROWS = [
  ["..o..", ".oyo.", ".oyo.", "..o..", "..w..", ".bwb.", ".b.b."],
  [".....", "..o..", ".oyo.", ".oyo.", "..w..", ".bwb.", ".b.b."],
];
/** Fire, witch-blue and violet. Only the flame changes; bracket and shaft do not. */
const TORCH_KINDS = [
  { o: 0xd8300a, y: 0xff7a18, light: 0xff6420 },
  { o: 0x1048d0, y: 0x5cc8ff, light: 0x3a92ff },
  { o: 0x6a12c4, y: 0xc86eff, light: 0x9a36ff },
].map((c) => ({
  light: c.light,
  frames: TORCH_ROWS.map((rows) =>
    pixelTexture(rows, { b: 0x3a3a44, w: 0x6b4a2a, o: c.o, y: c.y }),
  ),
}));
const TORCH_W = 5;
const TORCH_H = 7;

/**
 * The timber shoring behind the cave: horizontal boards, upright posts every so
 * often, bare dirt elsewhere. Deliberately untagged -- no material means it is
 * lit but casts no shadow and emits nothing, so light pours across it while the
 * rock in front of it does the occluding.
 *
 * Kept very dark on purpose. With the ambient this low, anything brighter than
 * about 40 stops reading as background and starts competing with the terrain.
 */
function backdropTexture(seed: number): Texture {
  const back = buffer(W, H);
  for (let y = 0; y < H; y++) {
    const board = (y / 9) | 0;
    const grain = y % 9;
    for (let x = 0; x < W; x++) {
      // Posts are a coarse, slow noise so they cluster instead of striping.
      const post = noise(x * 0.06, board * 0.3, seed + 11) > 0.62;
      const seam = grain === 0 || (x + board * 13) % 37 === 0;
      const grit = Math.floor(noise(x * 0.4, y * 0.4, seed) * 4);

      let r: number;
      let g: number;
      let b: number;
      if (post) {
        const v = (seam ? 9 : 20) + grit * 3;
        [r, g, b] = [v * 1.25, v * 0.92, v * 0.58]; // timber
      } else {
        const v = (grain === 4 ? 8 : 12) + grit * 2;
        [r, g, b] = [v * 1.05, v, v * 1.05]; // packed dirt
      }
      const p = (y * W + x) * 4;
      back.data[p] = r;
      back.data[p + 1] = g;
      back.data[p + 2] = b;
      back.data[p + 3] = 255;
    }
  }
  back.source.update();
  return back.texture;
}

/** First spot with room for the wizard, searched down the middle of the cave. */
function spawnPoint(sim: Sim): { x: number; y: number } {
  for (let y = 14; y < H - 14; y++) {
    for (let dx = 0; dx < W / 2; dx += 4) {
      for (const x of [W / 2 + dx, W / 2 - dx]) {
        let clear = true;
        for (let cy = y - 9; cy <= y + 9 && clear; cy++) {
          for (let cx = x - 5; cx <= x + 5 && clear; cx++)
            clear = !sim.solid(cx, cy);
        }
        if (clear) return { x, y };
      }
    }
  }
  return { x: W / 2, y: 20 };
}

export function createSandScene(canvas: HTMLCanvasElement): Scene {
  let seed = 7;
  const sim = generate(new Sim(W, H), seed);

  const albedo = buffer(W, H);
  const occlusion = buffer(W, H);
  const emission = buffer(W, H);

  const root = new Container();
  const backdrop = new Sprite(backdropTexture(seed));
  const field = new Sprite(albedo.texture);
  // One sprite is the whole simulation: its own pixels are the albedo, and two
  // more buffers give it per-pixel occlusion and per-pixel emission. Lava and
  // flame light the cave through the cascades, pixel by pixel -- and the rock
  // faces get that same light back out of the fluence buffer.
  setMaterial(field, {
    occlusion: 1,
    occlusionMap: occlusion.texture,
    emissive: 0xffffff,
    // Still the lowest number in the scene, because lava is semi-transparent in
    // the occlusion map: a ray crossing a wide lake accumulates this once per
    // pixel it passes.
    emissiveIntensity: 7,
    emissiveMap: emission.texture,
  });

  // Torches: pixel art that *is* the emitter.
  const torchLayer = new Container();
  const torchSprites: { s: Sprite; frames: Texture[] }[] = [];

  const start = spawnPoint(sim);
  const wizard = new Wizard(sim, start.x, start.y);

  root.addChild(backdrop, field, torchLayer, wizard.shots, wizard.view);

  function placeTorches(): void {
    for (const t of torchSprites) t.s.destroy();
    torchSprites.length = 0;
    torchLayer.removeChildren();
    for (const t of sim.torches) {
      // Picked from the site, not rolled: walking back past a torch should
      // not find it a different colour.
      const kind = TORCH_KINDS[(t.x * 3 + t.y) % TORCH_KINDS.length]!;
      const s = new Sprite(kind.frames[0]);
      // Nudged one pixel off the rock so the flame is not buried in it.
      s.position.set(t.x - ((TORCH_W / 2) | 0) + t.dir, t.y - TORCH_H + 1);
      // A fireball looks far wider than this only because its ember trail is
      // ~90 emitters spread over the screen. A torch is five flame pixels
      // standing still, so the reach has to come from intensity. This is the
      // knob to turn if the cave reads too bright.
      setMaterial(s, {
        emissive: kind.light,
        emissiveIntensity: 55,
        occlusion: 1,
      });
      torchLayer.addChild(s);
      torchSprites.push({ s, frames: kind.frames });
    }
  }
  placeTorches();

  const scene: Scene = {
    name: "sand",
    root,
    active: false,
    // Near black. In Noita the only thing you can see is what a fire is
    // currently lighting, and that only works if the floor is actually zero.
    lighting: {
      ambient: 0x020306,
      ambientOff: 0x9aa4b4,
      occluderAmbient: 0x05070b,
      occluderLightRange: 380,
      occluderLightHeight: 22,
      occluderLightStrength: 1.25,
      background: 0x000000,
      emissiveBoost: 0.6,
    },
    update,
    status,
  };

  // --- input ----------------------------------------------------------------

  const move: WizardInput = {
    left: false,
    right: false,
    up: false,
    down: false,
    aimX: W / 2,
  };
  let brush = 0;
  let radius = 6;
  let casting = false;
  let painting = false;
  let pointer = { x: W / 2, y: H / 2 };

  // Via the transform rather than the fit scale/offset by hand: `main` zooms the
  // world this root sits in, and `toLocal` is the only mapping that knows about it.
  const toGrid = (e: PointerEvent): void => {
    const r = canvas.getBoundingClientRect();
    pointer = root.toLocal({ x: e.clientX - r.left, y: e.clientY - r.top });
  };

  canvas.addEventListener("contextmenu", (e) => {
    if (scene.active) e.preventDefault(); // right-drag is the material brush
  });
  canvas.addEventListener("pointerdown", (e) => {
    if (!scene.active) return;
    canvas.setPointerCapture(e.pointerId);
    toGrid(e);
    if (e.button === 2) painting = true;
    else casting = true;
  });
  canvas.addEventListener("pointermove", (e) => {
    if (scene.active) toGrid(e);
  });
  const release = (e: PointerEvent): void => {
    if (e.button === 2) painting = false;
    else casting = false;
  };
  canvas.addEventListener("pointerup", release);
  canvas.addEventListener("pointercancel", release);
  canvas.addEventListener(
    "wheel",
    (e) => {
      if (!scene.active) return;
      e.preventDefault();
      radius = Math.min(40, Math.max(1, radius - Math.sign(e.deltaY)));
    },
    { passive: false },
  );

  const key = (e: KeyboardEvent, down: boolean): void => {
    if (!scene.active) return;
    const k = keyOf(e);
    if (k === "a" || k === "arrowleft") move.left = down;
    else if (k === "d" || k === "arrowright") move.right = down;
    else if (k === "w" || k === "arrowup" || k === " ") move.up = down;
    else if (k === "s" || k === "arrowdown") move.down = down;
    else if (!down) return;
    else {
      const digit = "1234567890".indexOf(k);
      if (digit >= 0) brush = digit;
      if (k === "r") respawn();
      return;
    }
    e.preventDefault();
  };
  addEventListener("keydown", (e) => key(e, true));
  addEventListener("keyup", (e) => key(e, false));
  addEventListener("blur", () => {
    move.left = move.right = move.up = move.down = false;
    casting = painting = false;
  });

  function respawn(): void {
    seed = (Math.random() * 1e6) | 0;
    generate(sim, seed);
    backdrop.texture = backdropTexture(seed);
    placeTorches();
    const spot = spawnPoint(sim);
    wizard.x = spot.x;
    wizard.y = spot.y;
  }

  // --- frame ----------------------------------------------------------------

  let accumulator = 0;
  let frame = 0;

  function update(dt: number, width: number, height: number): void {
    const scale = Math.max(width / W, height / H);
    root.scale.set(scale);
    root.position.set((width - W * scale) / 2, (height - H * scale) / 2);

    if (painting) {
      const mat = BRUSHES[brush]!;
      // Powders and liquids come out sparse so a held drag streams rather
      // than dumping a solid disc; walls and the eraser are solid.
      const density =
        MATERIALS[mat]!.kind === "static" || mat === EMPTY ? 1 : 0.35;
      sim.paint(
        Math.round(pointer.x),
        Math.round(pointer.y),
        radius,
        mat,
        density,
      );
    }
    if (casting) wizard.cast(pointer.x, pointer.y);
    move.aimX = pointer.x;

    // ponytail: fixed 60Hz, at most two catch-up steps. A sand sim tied to a
    // variable dt changes behaviour with framerate.
    accumulator = Math.min(accumulator + dt, 2 / 60);
    while (accumulator >= 1 / 60) {
      accumulator -= 1 / 60;
      sim.step();
      wizard.update(1 / 60, move);
      frame++;
    }

    // Flames flicker by swapping frames, not by fading anything.
    const phase = ((frame / 7) | 0) & 1;
    for (const t of torchSprites) t.s.texture = t.frames[phase]!;

    paintBuffers();
  }

  /** One scan fills the albedo, the occlusion map and the emission map. */
  function paintBuffers(): void {
    const { cell, tint } = sim;
    const a = albedo.data;
    const o = occlusion.data;
    const e = emission.data;

    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        const m = cell[i]!;
        const mat = MATERIALS[m]!;
        const p = i * 4;
        if (m === EMPTY) {
          a[p] = a[p + 1] = a[p + 2] = a[p + 3] = 0;
          o[p] = o[p + 1] = o[p + 2] = o[p + 3] = 0;
          e[p] = e[p + 1] = e[p + 2] = e[p + 3] = 0;
          continue;
        }
        // Glowing materials use the frame counter as their jitter phase,
        // so lava and embers shimmer instead of sitting still.
        const seedByte = mat.glow ? (tint[i]! + frame * 7) & 255 : tint[i]!;
        // Jitter is the base mottle; speckle is a hard step on the top
        // eighth of cells, which is what makes rock look granular.
        const shift =
          (((seedByte - 128) * mat.jitter) >> 7) +
          (seedByte > 224 ? mat.speckle : 0);
        // Anything with a lifetime dims over its last half instead of
        // popping: a flame that disappears at full brightness reads as
        // a bug, and the light it casts snaps off with it.
        const fade = mat.life
          ? Math.min(1, sim.life[i]! / (mat.life * 0.5))
          : 1;
        const alpha = (mat.opacity * fade) | 0;
        a[p] = premul(mat.rgb[0] + shift, alpha);
        a[p + 1] = premul(mat.rgb[1] + shift, alpha);
        a[p + 2] = premul(mat.rgb[2] + shift, alpha);
        a[p + 3] = alpha;
        o[p] = o[p + 1] = o[p + 2] = o[p + 3] = mat.occ;

        if (mat.glow) {
          e[p] = clamp8((mat.glow[0] + shift) * mat.heat * fade);
          e[p + 1] = clamp8((mat.glow[1] + shift) * mat.heat * fade);
          e[p + 2] = clamp8((mat.glow[2] + shift) * mat.heat * fade);
          e[p + 3] = 255;
        } else {
          e[p] = e[p + 1] = e[p + 2] = e[p + 3] = 0;
        }
      }
    }
    albedo.source.update();
    occlusion.source.update();
    emission.source.update();
  }

  function status(): string[] {
    return [
      "fly: WASD/←→ (W to hover)    left click: fireball    right drag: pour    wheel: brush    R: new cave",
      `material [${MATERIALS[BRUSHES[brush]!]!.name}]    brush ${radius}    ${sim.torches.length} torches`,
    ];
  }

  return scene;
}

function premul(v: number, alpha: number): number {
  return clamp8((v * alpha) / 255);
}
