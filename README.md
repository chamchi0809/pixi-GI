# pixi-rcgi

Holographic-radiance-cascades global illumination for [PixiJS](https://pixijs.com) v8.

<img width="745" height="376" alt="image" src="https://github.com/user-attachments/assets/db2e9cce-a6f5-49bc-ba0c-9f6a7601c9f6" />


Tag what emits light and what blocks it. <br/>
Everything else is lit background, but it neither emits nor blocks.

Occluders would sit in their own shadow, so they are lit by the mean radiance of
the free space nearest them -- read out of the cascades' own answer, mip by mip.

**[Live demo](https://chamchi0809.github.io/pixi-GI/)** · [API reference](packages/lib/README.md)

## Install

```bash
npm i pixi-rcgi
```

You need `pixi.js ^8.6.0`. Runs on WebGL2 (needs `EXT_color_buffer_float`) and
on WebGPU -- the shaders are written once in
[`pixi-psl`](https://www.npmjs.com/package/pixi-psl) and compiled to both.

## Getting started

Build your scene in a `Container` that is **not** on the stage, and add
`gi.view` instead.

```ts
import { Application, Container, Sprite, UPDATE_PRIORITY } from "pixi.js";
import { RadianceCascades, setMaterial } from "pixi-rcgi";

const app = new Application();
await app.init(); // WebGL2 or WebGPU
document.body.appendChild(app.canvas);

const world = new Container();
world.addChild(floor, wall, torch);

setMaterial(wall, { occlusion: 1 }); // casts shadows
setMaterial(torch, { emissive: 0xffb347, emissiveIntensity: 4 }); // emits light
// `floor` is untagged, so it is lit but invisible to the lighting

const gi = new RadianceCascades({
  renderer: app.renderer,
  world,
  ambient: 0x0a0d14, // so unlit corners are not pure black
  occluderAmbient: 0x141821, // floor brightness for walls and other casters
});

app.stage.addChild(gi.view);
app.ticker.add(() => gi.render(), null, UPDATE_PRIORITY.HIGH);
```

Move the camera by moving `world`; call `gi.resize(w, h)` on canvas resize.

Since `world` is off the stage, PixiJS would not hit-test it. `enableWorldEvents`
puts the pointer back:

```ts
enableWorldEvents(gi);
torch.eventMode = "static";
torch.on("pointertap", () => torch.blowOut());
```

Zooming works too — scale `world` — and the lighting follows it: `occluderLightRange`
and `occluderLightHeight` are in world pixels, everything else is in the buffers
and scales with them.

The lighting is computed over the view grown by `margin` on every side, so a
torch just off-screen still lights what you can see instead of popping in. It is
free: the buffers are square powers of two and the margin is the slack that
rounding already paid for, which is also why asking for more than fits is
clamped. On 16:9 there is a lot of it above and below and very little either
side.

### Materials

`setMaterial(target, material)` applies to the whole subtree; tag a child to
override.

| field                                        |                                                                          |
| -------------------------------------------- | ------------------------------------------------------------------------ |
| `emissive`                                   | Emitted colour, multiplied by the object's pixels. Omit to emit nothing. |
| `emissiveIntensity`                          | Radiance multiplier, default `1`. `2..10` for a solid lamp.              |
| `occlusion`                                  | `0..1`, default `1`. `0` is a glow that casts no shadow.                 |
| `emissiveMap` / `occlusionMap` / `normalMap` | Per-pixel versions of the above.                                         |

Intensity is radiance _per lighting pixel a ray crosses_, so a wide
`occlusion: 0` glow accumulates it — a 100px soft glow wants `0.2`, not `4`.

### Sharpness

```ts
new RadianceCascades({ renderer, world, resolution: 1 });
```

HRC probes every lighting pixel, so `resolution` is the only knob: it sets the
sharpness and the price together, and `1` is pixel-crisp. It is fixed at
construction, and each step up costs 4× the pixels, 4× the memory and one more
cascade. [Measurements](packages/lib/README.md#cost-and-sharpness-resolution).

The merge leaves a faint grid in the light — probes are planes, and the merge
branches on their parity. `smoothing` (default `1`) filters it out at a few taps
a frame: the pattern is periodic, so the pass is tuned to be exactly zero at its
frequency rather than to blur it.
[How](packages/lib/README.md#the-plane-lattice-smoothing).

The [reference](packages/lib/README.md#limitations) has the full list and the
reasoning behind each one.

## Credits

Radiance cascades is Alexander Sannikov's technique. The holographic variant is
[Yaazarai's](https://github.com/Yaazarai/Volumetric-HRC), after
[arXiv:2505.02041](https://arxiv.org/abs/2505.02041); this is a port of its
ray-extension implementation to PixiJS.

Platformer art:
[Platformer Art Complete Pack](https://kenney.nl/assets/platformer-art-complete-pack-now-with-enemies)
by Kenney Vleugels, CC0.

## License

MIT.
