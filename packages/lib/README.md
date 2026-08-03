# pixi-rcgi

Vanilla **radiance cascades** global illumination for [PixiJS](https://pixijs.com) v8.

Light bounces, spreads and shadows in 2D from your existing scene graph. You tag
objects with an emissive colour and how much light they block — per object, or
per pixel with a map. Everything you do not tag is background: it gets lit, but
casts no shadow and emits nothing.

```bash
npm i pixi-rcgi   # peer dep: pixi.js ^8.6.0
```

## Use

```ts
import { Application, Container } from 'pixi.js';
import { RadianceCascades, setMaterial } from 'pixi-rcgi';

const app = new Application();
await app.init({ preference: 'webgl' }); // WebGL only — see Limitations

// Build your scene in a container that is NOT on the stage.
const world = new Container();
world.addChild(background, walls, torch);

setMaterial(wall, { occlusion: 1 });                              // solid caster
setMaterial(torch, { emissive: 0xffb347, emissiveIntensity: 2 }); // light source
// `background` is untagged → lit, but invisible to the lighting.

const gi = new RadianceCascades({ renderer: app.renderer, world });
app.stage.addChild(gi.view); // this draws the lit scene

app.ticker.add(() => gi.render(), null, UPDATE_PRIORITY.HIGH);
```

Move the camera by moving `world`, zoom by scaling it. Resize with `gi.resize(w, h)`.

## API

That is the whole public surface — five exports.

### `setMaterial(target, material)` / `getMaterial` / `clearMaterial`

`target` is any `Container`. A material applies to the object's **whole
subtree**; tag a child to override it for that branch.

| field | meaning |
| --- | --- |
| `emissive` | Emitted colour, multiplied by the object's own pixels. `0xffffff` emits the sprite's own colours. Omit to emit nothing. |
| `emissiveIntensity` | Radiance multiplier, default `1`. Values > 1 are HDR. See the note below. |
| `occlusion` | `0..1`, default `1`. How much light the object blocks. `0` = a glow that does not cast shadows. |
| `emissiveMap` | Per-pixel emission. Swapped in for the object's texture during the emission pass; colour *and* alpha shape the light. Scaled to the object's footprint. |
| `occlusionMap` | Per-pixel occlusion. Swapped in during the occlusion pass; only its **alpha** is read. |
| `occluderLight` | Default `true`. Set `false` to keep a big `emissiveMap` sprite out of the occluder surface light, which would otherwise read it as one lamp the size of the sprite. The cascades are per-pixel either way. |
| `normalMap` | Per-pixel surface normal, OpenGL tangent space (+X right, +Y **up**). Used only by the occluder surface light — see below. |

**`emissiveIntensity` is radiance per lighting pixel a ray travels through the
object.** A solid caster (`occlusion: 1`) stops the ray, so it emits the value
once, at its surface — think `2..10`. A glowing volume (`occlusion: 0`)
accumulates it across its whole width, so a 100px soft glow wants something like
`0.2`. This falls straight out of the volumetric model; it is not a fudge.

### `new RadianceCascades(options)`

Required: `renderer`, `world`. Everything else has a default.

| option | default | |
| --- | --- | --- |
| `resolution` | `0.5` | Fraction of the *logical* size the lighting runs at. |
| `probeSpacing` | `2` | Cascade-0 probe spacing in lighting pixels. |
| `cascades` | auto | Enough for the top ray to cross the diagonal. Lowering it caps how far light travels. |
| `intervalLength` | `probeSpacing` | Cascade-0 ray length. |
| `margin` | `0.5` | Off-view world that still emits and occludes, as a fraction of the view per side. `0` is screen-space. See below. |
| `sky` | `0x000000` | Radiance for rays that leave the screen. |
| `ambient` | `0x000000` | Flat light added everywhere. |
| `occluderAmbient` | `0x000000` | Flat light for pixels that occlude. See below. |
| `occluderLightRange` | `256` | How far an emitter's *surface* light reaches, in world pixels. |
| `occluderLightHeight` | `48` | Virtual z of the emitters when shading a `normalMap`, in world pixels. |
| `occluderLightStrength` | `1` | Multiplier on the occluder surface light. `0` disables it. |
| `strength` / `exposure` / `emissiveBoost` | `1` | Bounce light / pre-tonemap / how bright emitters draw. |
| `toneMap` | `true` | Reinhard. |
| `background` | `0x000000` | Colour behind the world. |
| `width` / `height` | screen | Logical size. |

Runtime: `view`, `render()`, `resize(w, h)`, `destroy()`, `stats`, the mutable
fields `strength`, `exposure`, `emissiveBoost`, `toneMap`,
`occluderLightRange` / `occluderLightHeight` / `occluderLightStrength`, plus
`sky` / `ambient` / `occluderAmbient` / `background` setters.

#### Sharpness: `resolution` x `probeSpacing`

These two are the only reason the lighting looks soft. Irradiance is computed at
cascade-0 probes and interpolated between them, so it is sampled every
**`probeSpacing / resolution` screen pixels**. At the defaults that is 4px, which
reads as blur.

`resolution: 1, probeSpacing: 1` gives exactly one probe per screen pixel: the
composite lookup lands on a single texel with nothing to interpolate, and shadow
edges are pixel-crisp.

Measured on the demo scene, 1280x720, Apple M1 Pro, Chrome/ANGLE-Metal, median
of three runs. The 120s are the display's vsync cap, so those are floors:

| `resolution` | `probeSpacing` | probe every | fps |
| --- | --- | --- | --- |
| `1` | `1` | 1px -- pixel-perfect | 79 |
| `1` | `2` | 2px | 120 (capped) |
| `0.5` | `2` (default) | 4px | 120 (capped) |

Pixel-perfect is inherently expensive and no tuning removes that: every cascade
traces `4 * width * height / probeSpacing^2` rays, so halving the spacing
quadruples every level of the hierarchy at once, and the extra reach adds a level
on top -- 4.7x the rays here. Cost is linear in `width * height`, so lighting a
smaller area is the lever that actually works.

Both are fixed at construction (every buffer size depends on them), so a quality
setting means a new instance -- see the demo's `Q` key.

On a HiDPI canvas `resolution` is relative to the *logical* size, so pass
`renderer.resolution` (not `1`) for physical pixel-perfect, at 4x the cost.

Two things stay soft regardless: penumbra width, which comes from cascade-0's 4
directions, and the far field, which higher cascades integrate at their own
(coarser) probe spacing.

### Lighting occluders

Radiance cascades simulate light travelling *in the plane*. A pixel that
occludes is therefore permanently inside its own shadow: the cascades deliver it
almost nothing and a wall renders pure black. That is correct for the model and
useless for a game.

So occluders get a **second, deliberately non-RC light model**, run as a
deferred pass. Every emitter also becomes a point light — position and size from
its bounds, colour from its material — drawn as one additively blended instanced
quad covering its falloff circle, into a light buffer the composite reads once.
Each occluding pixel is therefore shaded directly from the emitters that can
actually reach it, with distance falloff and an optional normal map:

```
occluder light = occluderAmbient
               + occluderLightStrength * Σ emitter radiance * falloff(distance) * shading
```

It is blended in by how much the pixel occludes, so a half-transparent caster
gets half this and half the cascades.

```ts
new RadianceCascades({
    renderer, world,
    ambient: 0x0a0d14,           // everything the cascades do reach
    occluderAmbient: 0x141821,   // the floor for walls, crates, anything occluding
    occluderLightRange: 320,     // world px; falloff hits exactly zero here
    occluderLightHeight: 44,     // how far in front of the wall the lights sit
});

setMaterial(wall, { occlusion: 1, normalMap: brickNormals });
```

Falloff is **1/d, not 1/d²** — this is a 2D world. An emitter of half-extent
`r` subtends `2r/d` radians at distance `d`, and the composite averages incoming
radiance over the full 2π, so it fills `r / (π·d)` of it. That is the same
relationship the cascades arrive at by actually tracing, which is what keeps the
two models at the same brightness. It is tapered to exactly zero at
`occluderLightRange` so a light never pops as it scrolls away, and clamped
inside the emitter's own extent so a large glowing area is not a singularity at
its centre.

`emissiveIntensity` means the same thing here as it does to the cascades —
radiance per lighting pixel a ray travels through the body — so a solid caster
emits it once and a glowing volume (`occlusion: 0`) accumulates it across its
whole width. Tune emitters once; both models follow.

`normalMap` is optional and per object. Without one you get pure distance
falloff; with one, a torch carried past sweeps a highlight across the relief.
Shading is **wrap (half-Lambert)**, not plain `N·L`: a normal map here paints
relief onto a flat sprite rather than describing real geometry, and since every
light sits nearly in the surface plane, plain `N·L` would just make mapped
surfaces darker than un-mapped ones. `occluderLightHeight` is the look knob —
small grazes the surface and exaggerates the relief, large flattens it.

Set `occluderLightStrength: 0` to get the old flat behaviour (just
`occluderAmbient`), or leave both at `0x000000` / `0` for pure silhouettes.

**This is a fake, and its limits are sharp:** it is unshadowed (a wall behind
another wall is still lit), and it approximates each emitter by its bounding box
rather than its `emissiveMap`. It exists to make surfaces readable, not to be
correct. An emitter that does not survive that approximation — a full-screen
sprite lit by scattered `emissiveMap` pixels, say — should set
`occluderLight: false`.

There is **no cap on the emitter count**. Because each light is its own quad, the
pass costs the area the lights cover rather than pixels × lights, it runs at
lighting resolution rather than screen resolution, and emitters whose falloff
cannot reach the view are culled on the CPU before they are ever packed. The
instance buffer doubles as needed, so hundreds of live lights are ordinary; what
you pay for is overlapping light *area*, not light *count*.

## Limitations

Read this before shipping with it.

- **WebGL2 only.** No WebGPU/WGSL path. The constructor throws on a WebGPU
  renderer. It also requires `EXT_color_buffer_float`; the constructor throws
  with a clear message when the device does not expose it.
- **Three extra renders of your world per frame** (albedo, emission, occlusion),
  plus the jump-flood, one draw per cascade and one instanced draw for all
  occluder lights together. On a scene where PixiJS draw calls already dominate,
  expect roughly 3× that cost. A **fourth** render is added the moment anything
  in the scene has a `normalMap`.
- **Occluders are not lit by the simulation.** They are lit by the separate,
  unshadowed deferred surface model described above. If you need a wall to be
  shadowed from a light by another wall, this is not it.
- **The scene graph is walked every frame** to collect participants, and
  `tint`/`alpha`/`blendMode`/`texture` are temporarily overridden on tagged
  nodes and restored afterwards. Cost is O(nodes in `world`). If you mutate
  those properties from a `render`-priority ticker callback you will fight it.
- **Relative emissive intensity is quantised to 8 bits.** Intensity is folded
  into the sprite's `tint` and undone by a uniform normalised against the
  brightest emitter in the scene. A light 500× dimmer than the brightest one
  will band or vanish. Absolute HDR range is fine; the *ratio* is what is
  limited.
- **Vanilla radiance cascades**, i.e. plain bilinear interpolation when merging
  a cascade into its parent — not the "bilinear fix". Expect the known artefacts:
  soft ringing around small bright emitters and light that bends slightly near
  thin occluders at grazing angles.
- **Probe-resolution shadows.** Penumbra detail below one cascade-0 probe
  spacing (`probeSpacing / resolution` screen pixels — 4px at the defaults) does
  not exist. Thin occluders can be missed entirely at higher cascades.
- **2D only, single bounce of the scene as drawn.** There is no albedo feedback
  loop: light bounces off surfaces via the cascade merge, but a lit surface does
  not re-emit its own albedo.
- **`occlusionMap` reads alpha only** — its colour is ignored. `emissiveMap`
  uses colour × alpha × the `emissive` tint.
- **The world container must not be on the stage.** Add `gi.view` instead. If
  you add both you will render the scene twice.
- **Off-view world reaches only as far as `margin`.** The scene the rays march
  through is the view grown by `margin` — a fraction of it, `0.5` by default, so
  the lit region is twice the view on both axes. A light or a wall further out
  than that contributes nothing, and rays leaving the buffers take `sky`. The
  three world renders and the jump flood grow with the area, so `0.5` is 4x the
  area of `0`; the cascade passes are sized by the view and do not change. Past
  the top cascade's reach (about the view diagonal) more margin buys nothing.
  `margin: 0` is the old screen-space behaviour.
- **Camera zoom is a `world.scale`,** and it is read off that transform every
  frame — no reallocation, and `margin` follows it because it is a fraction.
  Probe spacing and ray reach are fixed in *buffer* pixels, so zooming out shows
  more world lit at the same screen sharpness rather than the same world lit more
  coarsely. `occluderLightRange` / `occluderLightHeight` are the two knobs in
  world pixels, scaled by the zoom so a torch lights the same wall either way.
  While the zoom is *changing*, the snap grid below is rescaling with it, so
  expect the same pumping a resize gives; it settles the moment the zoom does.
- **No sub-region / scrolling optimisation.** The lighting always covers the
  full logical size, re-rendered from scratch every frame; nothing is cached
  between frames even though the probe grid is world-aligned.
- **The lighting buffers are wider than the screen.** They are rasterised
  snapped to a grid the size of the coarsest cascade's stride, because everything
  that filters them — the emissive mip pyramid above all — is aligned to the
  buffer rather than to the world, and a camera that slides across those cells
  pumps the light. Snapping pins them to fixed world positions; the padding is
  what keeps every visible pixel inside a buffer the snap has pushed off-screen.
  Costs about 15-30% of the lighting passes, and the picture still moves at
  sub-pixel precision — only the lighting *grid* is quantised.
  Read the camera from `world`'s own transform, so move it there and not on a
  child, or the snap has nothing to snap and the flicker comes back.

## Check

`pnpm check` runs `check.ts`, which asserts the cascade hierarchy is
contiguous, memory-invariant and reaches the screen diagonal, and that the
occluder light packing culls and converts to GI pixels correctly. The GPU
passes are not unit-tested — they are verified by looking at the demo.

## License

MIT.
