import { Container, Sprite, Texture } from "pixi.js";
import { setMaterial } from "pixi-rcgi";

export const TILE = 70;

/**
 * A cave. Brick backdrop is painted behind every non-wall cell and is left
 * untagged on purpose: no material means "background" -- it receives light but
 * casts no shadow and emits nothing.
 *
 *   S stone wall   # grass top   = grass fill   x crate
 *   T lit torch    l lava        W lit window   R light grate
 *   g/G gems       c coin        * star         ^ plant      P spawn
 */
const MAP = [
  "SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS",
  "S..............................................S",
  "S..T................T.....................T....S",
  "S..........SW..................SS..............S",
  "S..P.......SS.....RRRRR........SS......c.......S",
  "S..###..###SS..................SS...#####......S",
  "S..===..===SS...#######........SS...=====......S",
  "S..........SS...=======........SS..............S",
  "S....g.....SS....x..T..x.......SW....*.........S",
  "S..#####...SS...####...##......SS..######......S",
  "S..=====...SS...====...==......SS..======......S",
  "S..........SS..................SS.......^......S",
  "S..T....G.^SS.......c....^.....SS..T......c....S",
  "S#########.SS..###########.....SS.###########..S",
  "S=========lSS==###########==...SS=###########..S",
  "SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS",
];

export const COLS = MAP[0]!.length;
export const ROWS = MAP.length;
export const LEVEL_WIDTH = COLS * TILE;
export const LEVEL_HEIGHT = ROWS * TILE;

/** Tiles the player stands on / bumps into. Backdrops and decorations are not solid. */
const SOLID = new Set("S#=xW");

export interface LevelTextures {
  stoneCenter: Texture;
  brickWall: Texture;
  grassMid: Texture;
  grassCenter: Texture;
  box: Texture;
  torch: Texture;
  lavaTop: Texture;
  window: Texture;
  gemBlue: Texture;
  gemRed: Texture;
  coin: Texture;
  star: Texture;
  plant: Texture;
  /** Procedural: per-pixel occlusion for the grate. */
  grate: Texture;
  /** Procedural: per-pixel normals, bevelling the crates. */
  bevel: Texture;
}

export interface Level {
  /** Everything that gets lit. Hand this to the GI as its world. */
  root: Container;
  spawnX: number;
  spawnY: number;
  isSolid(col: number, row: number): boolean;
}

export function buildLevel(tex: LevelTextures): Level {
  for (const row of MAP) {
    if (row.length !== COLS)
      throw new Error(`level rows must be ${COLS} chars, got ${row.length}`);
  }

  const root = new Container();
  const backdrop = new Container();
  const solidLayer = new Container();
  const decor = new Container();
  const lights = new Container();
  root.addChild(backdrop, solidLayer, decor, lights);

  const solid: boolean[][] = MAP.map((row) =>
    [...row].map((c) => SOLID.has(c)),
  );
  let spawnX = TILE * 2;
  let spawnY = TILE * 2;

  const place = (
    parent: Container,
    texture: Texture,
    col: number,
    row: number,
    scale = 1,
  ): Sprite => {
    const s = new Sprite(texture);
    s.anchor.set(0.5);
    s.scale.set(scale);
    s.position.set(col * TILE + TILE / 2, row * TILE + TILE / 2);
    parent.addChild(s);
    return s;
  };

  for (let row = 0; row < ROWS; row++) {
    const line = MAP[row]!;
    for (let col = 0; col < COLS; col++) {
      const cell = line[col]!;
      if (cell !== "S") place(backdrop, tex.brickWall, col, row);

      switch (cell) {
        // --- occluders ----------------------------------------------------
        // The cascades never light these -- a wall is inside its own
        // shadow -- so what you see on them is the occluder surface light.
        case "S":
          setMaterial(place(solidLayer, tex.stoneCenter, col, row), {
            occlusion: 1,
          });
          break;
        case "#":
          setMaterial(place(solidLayer, tex.grassMid, col, row), {
            occlusion: 1,
          });
          break;
        case "=":
          setMaterial(place(solidLayer, tex.grassCenter, col, row), {
            occlusion: 1,
          });
          break;
        case "x":
          // Only the crates get a normal map. Bevelling a *tiled*
          // surface just draws a grid of pillows -- the relief has to
          // match something the art already shows.
          setMaterial(place(solidLayer, tex.box, col, row), {
            occlusion: 1,
            normalMap: tex.bevel,
          });
          break;

        // --- decoration: untagged, so pure background ---------------------
        case "^":
          place(decor, tex.plant, col, row);
          break;

        // --- emitters -----------------------------------------------------
        case "T":
          setMaterial(place(lights, tex.torch, col, row), {
            emissive: 0xffb347,
            emissiveIntensity: 0.8,
            occlusion: 0,
          });
          break;
        case "l":
          setMaterial(place(lights, tex.lavaTop, col, row), {
            emissive: 0xff5a1e,
            emissiveIntensity: 0.45,
            occlusion: 0.15,
          });
          break;
        case "g":
          setMaterial(place(lights, tex.gemBlue, col, row), {
            emissive: 0x66ccff,
            emissiveIntensity: 3,
            occlusion: 1,
          });
          break;
        case "G":
          setMaterial(place(lights, tex.gemRed, col, row), {
            emissive: 0xff5577,
            emissiveIntensity: 3,
            occlusion: 1,
          });
          break;
        case "c":
          setMaterial(place(lights, tex.coin, col, row, 0.7), {
            emissive: 0xffd85e,
            emissiveIntensity: 0.35,
            occlusion: 0,
          });
          break;
        case "*":
          setMaterial(place(lights, tex.star, col, row), {
            emissive: 0xfff2a8,
            emissiveIntensity: 0.5,
            occlusion: 0,
          });
          break;

        // --- per-pixel maps -------------------------------------------------
        case "W":
          // Solid to walk on; the sprite's own pixels shape the emission,
          // so the white frame throws most of the light and the darker
          // pane throws less. No map needed -- the art is the map.
          setMaterial(place(solidLayer, tex.window, col, row), {
            emissive: 0xffeec0,
            emissiveIntensity: 6,
            occlusion: 1,
          });
          break;
        case "R": {
          // Barely visible on screen, but its occlusion map cuts the
          // light above it into bars.
          const grate = place(decor, tex.grate, col, row);
          grate.alpha = 0.35;
          setMaterial(grate, { occlusion: 1, occlusionMap: tex.grate });
          break;
        }

        case "P":
          spawnX = col * TILE + TILE / 2;
          spawnY = (row + 1) * TILE;
          break;
        default:
          break;
      }
    }
  }

  return {
    root,
    spawnX,
    spawnY,
    isSolid: (col, row) => solid[row]?.[col] ?? true,
  };
}
