# pixi-psl

Write a PixiJS fragment shader once as TypeScript expressions; get GLSL 300 es and
WGSL that do the same thing. The API follows three.js' TSL: nodes are values,
methods chain, statements go through `If` / `Loop` / `.toVar()`.

```ts
import { PslProgram, uv, floor, mod, vec4 } from 'pixi-psl';

const program = new PslProgram('tint');
const u = program.uniforms('tintUniforms', {
    uTexSize: { type: 'vec2', value: new Float32Array([1, 1]) },
    uAmount: { type: 'float', value: 1 },
});
const uSource = program.texture('uSource');

const shader = program.build(() => {
    const src = uSource.sample(uv).toVar();
    return vec4(src.rgb.mul(u.uAmount), src.a);
});
```

`build()` returns a `pixi.js` `Shader` with both programs and the resource
records for both backends. Bind textures with `setTexture(shader, name, source)`
-- it also sets the `<name>Sampler` slot WebGPU needs and WebGL ignores.

Divergences the codegen handles: `mod` (WGSL `%` truncates), `atan(y, x)`,
vector `==` (scalar bool in GLSL, `vecN<bool>` in WGSL), the ternary, explicit
sampling LOD (WGSL forbids implicit-LOD sampling in non-uniform control flow),
type spelling, and `var`/`let` declarations.

`node --experimental-transform-types check.ts` asserts all of the above on one
graph compiled to both targets.

## patchRenderer

```ts
import { patchRenderer } from 'pixi-psl';

patchRenderer(app.renderer); // once, before rendering; no-op on WebGL
```

Identical sources are not enough on their own: two bugs in Pixi 8.19's WebGPU
backend make a correctly translated shader render differently, or not at all, and
a shader author cannot reach either of them.

- **Pipelines ignore the render target's colour format.** `getColorTargets`
  hardcodes `bgra8unorm` and the pipeline cache is not keyed by format, so drawing
  into an `rgba16float` (or any non-default) render texture gets the command buffer
  rejected and the frame comes out black, with only a console validation warning to
  say so.
- **`add` blends alpha differently.** WebGL uses `blendFunc(ONE, ONE)`, which covers
  alpha; WebGPU is given `src-alpha`/`one-minus-src-alpha` for it. RGB matches and
  `add-npm` is already correct on both. Harmless while nothing reads the destination
  alpha, wrong as soon as something does -- an additively accumulated render texture
  composites too transparent on WebGPU, or comes out several times too bright if the
  consumer divides the colour by that alpha.

Both are patched on the renderer instance, so nothing leaks into a renderer that
did not ask. Delete the call once Pixi fixes them.

## Limits

- Fragment stage only; the vertex stage is a fixed unit-quad passthrough.
- `Fn` is an identity wrapper -- graph functions inline at every call site rather
  than emitting a shader function.
- Types: `bool int float vec2 vec3 vec4 mat3`.
