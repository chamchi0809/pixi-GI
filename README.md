# pixi-GI

pnpm monorepo: a radiance-cascades global illumination library for PixiJS, and
two demos that use it.

| package | |
| --- | --- |
| [`packages/pixi-radiance`](packages/pixi-radiance) | The library. **[Read its README](packages/pixi-radiance/README.md)** — API and limitations live there. |
| `apps/demo` | Two scenes, **TAB** to switch: a falling-sand cave and a side-scroller. |

- **sand** (default) — Noita-style cellular automaton, 320×180, zero assets:
  every pixel is generated in code. Sand, water, oil, lava, fire, embers, acid,
  smoke; stone and wood bridges, wall torches, a procedural brick backdrop that
  is lit but casts no shadow, and a flying wizard who shoots glowing fireballs
  that blast holes in the rock.
- **platformer** — tile collision, coyote time, jump buffering, torches, lava,
  gems, normal-mapped crates.

## Run

```bash
pnpm install
pnpm dev        # demo at http://localhost:8282
pnpm build      # library (bundle + .d.ts), then the demo
pnpm typecheck
pnpm check              # cascade-hierarchy assertions
pnpm --filter demo check # falling-sand rules
```

Requires Node ≥ 22.12 and a browser with WebGL2 + `EXT_color_buffer_float`.

Both scenes: **TAB** switch demo, **G** toggle GI, **Q** cycle lighting quality
(pixel-perfect / sharp / fast), **`[` `]`** exposure, **H** hide the HUD.

Sand: **WASD**/**←→** fly (**W**/**space** to hover), **left click** fireball,
**right drag** pour the current material, **wheel** brush size, **1**–**0**
material, **R** new cave.

Platformer: **A/D** or **←/→** move, **space/W** jump, **S** duck.

`pnpm dev` aliases `pixi-radiance` to the library **source**, so edits to the
shaders hot-reload without a rebuild.

## Stack

PixiJS 8.19 · Vite 8.2 · TypeScript **6.0.3**.

TypeScript 6.0 is what was asked for. Note that `typescript@latest` is 7.x — 6.0
is a real, published, stable release, but it is not the newest line.

## Credits

Platformer art: **[Platformer Art Complete Pack](https://kenney.nl/assets/platformer-art-complete-pack-now-with-enemies)**
by Kenney Vleugels (kenney.nl), CC0. See `apps/demo/public/assets/license.txt`.
The sand demo uses no assets at all.

Radiance cascades is Alexander Sannikov's technique. This is the "vanilla"
formulation, without the bilinear fix.

Library is MIT.
