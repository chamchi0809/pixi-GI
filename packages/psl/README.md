# pixi-psl

Write a PixiJS shader once as TypeScript expressions; get GLSL 300 es and WGSL
that do the same thing. The API follows three.js' TSL: nodes are values, methods
chain, statements go through `If` / `Loop` / `Switch` / `.toVar()`.

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

With one graph, as above, the vertex stage is a fullscreen quad and `uv` runs
0..1 across the target: a full-screen pass drawn as a `Mesh`.

Divergences the codegen handles: `mod` (WGSL `%` truncates), `atan(y, x)`,
vector `==` (scalar bool in GLSL, `vecN<bool>` in WGSL), the ternary, explicit
sampling LOD (WGSL forbids implicit-LOD sampling in non-uniform control flow),
`switch` case labels and WGSL's mandatory `default`, `discard` being
fragment-only in WGSL, array declarator position, type spelling, and `var`/`let`
declarations.

## Mesh materials

Pass `{ vertex, fragment }` instead and the same program is a mesh material.

```ts
import { mvpMatrix, position, uv, vertexUV } from 'pixi-psl';

const p = new PslProgram('material');
const shader = p.build({
    vertex: () => {
        uv.assign(vertexUV);
        return mvpMatrix.mul(vec3(position, 1)); // a vec3 is widened to the clip position
    },
    fragment: () => vec4(uv, 0, 1),
});
new Mesh({ geometry, shader });
```

### Built-ins

PixiJS already fixes some names, so PSL exports them as nodes rather than
leaving them to be spelled out. Each declares itself into whichever program's
graph reaches it, so an unused one is absent from the generated source.

| Node | Is | Stage |
| --- | --- | --- |
| `position` | attribute `aPosition`, vec2 | vertex |
| `vertexUV` | attribute `aUV`, vec2 | vertex |
| `vertexColor` | attribute `aColor`, vec4 (`BatchGeometry` only) | vertex |
| `uv` | varying `vUV`, vec2 | write in vertex, read in fragment |
| `projectionMatrix` `worldMatrix` `worldColorAlpha` `resolution` | Pixi's group 0 | both |
| `modelMatrix` `tint` `roundPixels` | Pixi's group 1 | both |
| `mvpMatrix` | `projectionMatrix * worldMatrix * modelMatrix` | vertex |

The uniforms are declared in the group layout Pixi's own shaders use, so they
arrive filled in; only the blocks a stage actually reads are declared in it.

`position` is load-bearing beyond the shader: `Geometry.bounds` looks up
`aPosition` by name and returns an empty box without it, which silently takes
`Mesh` culling, `getBounds` and `containsPoint` with it.

For anything else, `p.attribute(name, type)` and `p.varying(name, type)`. Names
are matched to the geometry by string on both backends, so locations only have
to be unique and PSL hands them out as the graph reaches each one.

Three things are checked at compile time rather than left to the driver: a
varying the fragment stage reads but the vertex stage never writes (undefined in
GLSL, zero in WGSL), an attribute read from the fragment stage, and a name used
at two different types.

Fragment output is premultiplied, as everywhere else in Pixi.

## Checks

`node --experimental-transform-types check.ts` asserts the above on two graphs --
a fullscreen pass and a mesh material -- compiled to both targets.

That compares the two languages as text. `node tools/compare.mjs --page
material.html` is the other half: it draws a PSL mesh material on both backends
and diffs the frames, which is the only thing that catches a shader that
translates cleanly and still renders wrong.

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

- No compute stage.
- Not a Pixi `Filter`. A filter's bind groups are laid out differently --
  `GlobalFilterUniforms`, `uTexture` and `uSampler` all at group 0, the filter's
  own uniforms at group 1 -- and PSL emits the mesh layout. Fullscreen passes
  work; drawing one as a `Mesh` over the screen is the way in.
- Types: `bool int uint float vec2 vec3 vec4 mat3 mat4`, plus `struct` and
  fixed-length `array`. No `mat2`, no integer vectors, no runtime-sized arrays.
- Math is free functions (`max(a, b)`), not methods (`a.max(b)`) -- only
  arithmetic, comparison, swizzles and access chain.
- `Fn(params, returns, body)` emits a real function, once per stage. `Fn(body)`
  is still the identity wrapper that inlines at every call site.
- An else-if nests inside the else, one level per link, because the chained
  condition's temporaries have to be written before its `if`.
- Textures are 2D and sampled at an explicit LOD. No storage textures, no
  texelFetch, no cube maps, no arrays.
