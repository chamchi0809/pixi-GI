# pixi-rcgi

**Holographic radiance cascades** global illumination for [PixiJS](https://pixijs.com) v8.

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
| `resolution` | `0.5` | Fraction of the *logical* size the lighting runs at. The only cost knob. See below. |
| `cascades` | auto | As many as the buffer holds. Lowering it caps how far light travels, at `2^cascades` lighting pixels. |
| `margin` | `0.5` | Off-view world that still emits and occludes, as a fraction of the view per side. Free, but capped. See below. |
| `ambient` | `0x000000` | Flat light added everywhere. |
| `occluderAmbient` | `0x000000` | Flat light for pixels that occlude. See below. |
| `occluderLightRange` | `256` | How far into an occluder light reaches, in world pixels. Rounded to a power of two. |
| `occluderLightHeight` | `48` | Virtual z of the light when shading a `normalMap`, in world pixels. |
| `occluderLightStrength` | `1` | Multiplier on the occluder surface light. `0` disables it. |
| `strength` / `exposure` / `emissiveBoost` | `1` | Bounce light / pre-tonemap / how bright emitters draw. |
| `toneMap` | `true` | Reinhard. |
| `background` | `0x000000` | Colour behind the world. |
| `width` / `height` | screen | Logical size. |

Runtime: `view`, `render()`, `resize(w, h)`, `destroy()`, `stats`, the mutable
fields `strength`, `exposure`, `emissiveBoost`, `toneMap`,
`occluderLightRange` / `occluderLightHeight` / `occluderLightStrength`, plus
`ambient` / `occluderAmbient` / `background` setters.

#### Cost and sharpness: `resolution`

HRC probes *every* lighting pixel — there is no probe spacing to trade away — so
`resolution` alone sets both the sharpness and the price. Fluence is one texel
per lighting pixel, and at `resolution: 1` shadow edges are pixel-crisp.

Every buffer is a square power of two big enough to hold the view, so what
actually matters is `max(width, height) * resolution` and where it lands relative
to a power of two. Measured on the demo, 960x540, Apple M1 Pro,
Chrome/ANGLE-Metal — `hrc` is the whole hierarchy, all four frustums:

| `resolution` | buffers | cascades | `hrc` | frame |
| --- | --- | --- | --- | --- |
| `0.25` | 256² | 8 | 3.0ms | 8.3ms |
| `0.5` | 512² | 9 | 8.5-10.4ms | vsync (16.7ms) |

Each step up is 4x the pixels *and* one more cascade, so expect a bit worse than
4x. Memory is the harder ceiling: every cascade keeps its own ray buffer, so the
hierarchy is `extent² * (cascades + 2)` RGBA16F texels — 23MB at 512, 96MB at
1024, 436MB at 2048, which is where `MAX_EXTENT` stops.

`resolution` is fixed at construction (every buffer size depends on it), so a
quality setting means a new instance — see the demo's `Q` key. On a HiDPI canvas
it is relative to the *logical* size, so pass `renderer.resolution` (not `1`) for
physically pixel-perfect, at 4x the cost.

What stays soft is angular: cascade 0 resolves two rays per probe, and the
extension chain averages crossed pairs on the way up, which is deliberate — that
diffusion is what stops a moving light crawling.

### Lighting occluders

Radiance cascades simulate light travelling *in the plane*. A pixel that
occludes is therefore permanently inside its own shadow: the cascades deliver it
almost nothing and a wall renders pure black. That is correct for the model and
useless for a game.

Rather than shade those pixels from a second, non-RC light model, they reuse the
cascades' own answer and just **fetch it from where light exists**.

The resolve pass premultiplies fluence by free space (`1 - occlusion`) and keeps
that mask in alpha, so the fluence buffer is a *masked* field. Mipmap it, and mip
level `l` holds the light within a `2^l` footprint already weighted by how much of
that footprint light could reach. The composite sums every level and divides the
totals **once**:

```
occluder light = occluderAmbient
               + occluderLightStrength * (Σ w·rgb) / (Σ w·a) * shading,  w = 2^-l
```

That is the mean radiance of whatever free space is in reach, with blocked pixels
contributing nothing rather than black. A rim pixel is dominated by level 1 and
keeps a crisp contact edge; deep inside a wall the fine levels are empty, add
nothing to either total, and the coarse ones take over on their own. It is blended
in by how much the pixel occludes, so a half-transparent caster gets half this and
half the cascades.

The buffers are snapped onto a lattice as coarse as the coarsest mip read (capped
by the margin, which absorbs the offset), so a world point keeps a fixed phase
inside every mip box as the camera pans. Without that the box grid is locked to the
buffer while the world scrolls under it, and the averaging window for a given rock
pixel cycles through every phase of the grid -- which is a blink, not a shadow.

Each level is read as four bilinear taps at the corners of its own texel rather
than one. A mip box is locked to the buffer's grid while the world scrolls under
it, so for a given world point the averaging window drifts through every phase of
that grid as the camera pans; one bilinear tap reconstructs that drift linearly and
it shows as blinking. Four is a box of boxes -- quadratic, and near enough
translation-invariant to sit still.

**Nothing picks a level**, and that matters: a per-pixel choice of mip facets the
surface along every boundary where the choice flips, and dividing per level pinches
wherever that level's coverage is near zero. Both are artefacts of the
reconstruction rather than of the light, and summing removes them.

```ts
new RadianceCascades({
    renderer, world,
    ambient: 0x0a0d14,           // everything the cascades do reach
    occluderAmbient: 0x141821,   // the floor for walls, crates, anything occluding
    occluderLightRange: 320,     // world px; how deep into a wall light gets
    occluderLightHeight: 44,     // how far in front of the wall the light sits
});

setMaterial(wall, { occlusion: 1, normalMap: brickNormals });
```

**What this buys** over shading occluders from a light list: shadowing, colour,
bounce and the correct 2D `1/d` falloff all come along for free, because they are
already baked into the field being averaged. A wall behind another wall stays
dark. Emitters are per-pixel — an `emissiveMap` full of scattered embers lights
the rock beside it as embers, not as one lamp the size of the sprite. There is no
emitter list, no bounding-box approximation, no light count to cap, and no second
model to keep in brightness agreement with the first. It costs four taps per
level -- `4 * log2(occluderLightRange)` in the composite, plus 16 more for the
normal-map gradient -- and one mip reduction of the fluence buffer per frame.

`normalMap` is optional and per object. Fluence is directionless, but the
*gradient* of the dilated field points at where the light is, and the mip
footprint is its distance — enough of a light vector to shade relief with, and it
follows real shadowed light rather than a straight line to an emitter. Shading is
**wrap (half-Lambert)**, not plain `N·L`: a normal map here paints relief onto a
flat sprite rather than describing real geometry, and since the light sits nearly
in the surface plane, plain `N·L` would just make mapped surfaces darker than
un-mapped ones. `occluderLightHeight` is the look knob — small grazes the surface
and exaggerates the relief, large flattens it.

Set `occluderLightStrength: 0` to get flat behaviour (just `occluderAmbient`), or
leave both at `0x000000` / `0` for pure silhouettes.

**The limits.** Light still does not travel *through* an occluder in the
simulation, so this is a dilation, not a solve: a thick wall's interior is lit by
the average of whatever is open around it, which is why `occluderLightRange` is a
look knob and not a physical distance. The mip footprints are axis-aligned, so
deep interiors are broad and soft by construction.

## Limitations

Read this before shipping with it.

- **WebGL2 only.** No WebGPU/WGSL path. The constructor throws on a WebGPU
  renderer. It also requires `EXT_color_buffer_float`; the constructor throws
  with a clear message when the device does not expose it.
- **Three extra renders of your world per frame** (albedo, emission, occlusion),
  plus `4 * (2N + 1)` fullscreen passes for the hierarchy — 76 at nine cascades —
  and one mip reduction of the fluence buffer. On a scene where
  PixiJS draw calls already dominate, expect roughly 3× that cost. A **fourth**
  render is added the moment anything in the scene has a `normalMap`.
- **Occluders are not lit by the simulation**, they are lit by the *dilation* of
  it described above: the mean radiance of the free space nearest them. That
  keeps the shadowing, but the interior of a thick wall is a broad average rather
  than a solve.
- **The scene graph is walked every frame** to collect participants, and
  `tint`/`alpha`/`blendMode`/`texture` are temporarily overridden on tagged
  nodes and restored afterwards. Cost is O(nodes in `world`). If you mutate
  those properties from a `render`-priority ticker callback you will fight it.
- **Relative emissive intensity is quantised to 8 bits.** Intensity is folded
  into the sprite's `tint` and undone by a uniform normalised against the
  brightest emitter in the scene. A light 500× dimmer than the brightest one
  will band or vanish. Absolute HDR range is fine; the *ratio* is what is
  limited.
- **Holographic radiance cascades**, and specifically the *ray-extension*
  variant: only cascade 0 ever samples the scene, and every ray above it is built
  from four rays of the cascade below. That is what makes each ray `O(log N)`
  instead of a march, and it is why this is memory-bound rather than
  bandwidth-bound. Extensions start at cascade 0 rather than cascade 3 as the
  paper has it — more angular diffusion, and a light you carry around stops
  crawling.
- **Light bends at grazing angles.** Rays are chained rather than traced, so a
  chain can slip past a thin occluder that a straight ray would have hit, and
  light leaks a little around the ends of thin walls. Cascade 0 is exact; the
  error grows with the cascade.
- **Memory grows with `resolution`, not just time.** Every cascade holds its own
  ray buffer for the whole merge, so there is no streaming it — see the table
  above, and `MAX_EXTENT` (2048) as the hard stop.
- **2D only, single bounce of the scene as drawn.** There is no albedo feedback
  loop: light bounces off surfaces via the cascade merge, but a lit surface does
  not re-emit its own albedo.
- **`occlusionMap` reads alpha only** — its colour is ignored. `emissiveMap`
  uses colour × alpha × the `emissive` tint.
- **The world container must not be on the stage.** Add `gi.view` instead. If
  you add both you will render the scene twice.
- **`margin` is capped by the power-of-two rounding, not by what you ask for.**
  The buffers are square and already rounded up past the view, and the margin is
  the slack that rounding paid for — so it costs nothing, and asking for more than
  fits is clamped rather than honoured (honouring it would double `extent` and
  quadruple the memory). On 16:9 that means plenty of off-view world above and
  below and almost none either side: 1920x1080 at `resolution: 0.5` gets 483
  lighting pixels of margin vertically and 63 horizontally. Rays that leave the
  buffers see nothing — there is no sky term.
- **Camera zoom is a `world.scale`,** and it is read off that transform every
  frame — no reallocation, and `margin` follows it because it is a fraction.
  Probe spacing and ray reach are fixed in *buffer* pixels, so zooming out shows
  more world lit at the same screen sharpness rather than the same world lit more
  coarsely. `occluderLightRange` / `occluderLightHeight` are the two knobs in
  world pixels, scaled by the zoom so a torch lights the same wall either way
  (the range as the mip level it rounds to).
- **No sub-region / scrolling optimisation.** The lighting always covers the
  full logical size, re-rendered from scratch every frame; nothing is cached
  between frames.
- **The lighting buffers are rasterised snapped to whole texels.** Every ray in
  the hierarchy starts and ends on a texel centre, so a world drawn half a texel
  off would slide across the ray fan as the camera moves and pump the light. The
  picture itself still moves at sub-pixel precision — only the *lighting* is
  quantised. The camera is read from `world`'s own transform, so move it there and
  not on a child, or there is nothing to snap and the flicker comes back.

## Check

`pnpm check` runs `check.ts`, which asserts the buffer layout is square,
power-of-two, big enough for the view and its margins, and that every cascade's
planes tile it exactly, plus that the occluder light packing culls and converts
to GI pixels correctly. The GPU passes are not unit-tested — they are verified by
looking at the demo.

## Credits

Radiance cascades is Alexander Sannikov's technique. The holographic variant is
[Yaazarai's](https://github.com/Yaazarai/Volumetric-HRC), after
[arXiv:2505.02041](https://arxiv.org/abs/2505.02041); this is a port of its
ray-extension implementation.

## License

MIT.
