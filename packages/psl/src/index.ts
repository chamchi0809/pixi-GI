/**
 * PSL -- pixi shader language.
 *
 * Write a fragment shader once, as TypeScript, and get GLSL 300 es and WGSL out
 * of it, wired into a PixiJS `Shader` with the resource names both backends
 * expect. The API follows three.js' TSL: nodes are expressions, methods chain,
 * and `If` / `Loop` / `.toVar()` are statements that run as the graph function
 * runs.
 *
 *     const p = new PslProgram('tint');
 *     const u = p.uniforms('tintUniforms', { uTint: { type: 'vec3', value: [1, 0, 0] } });
 *     const src = p.texture('uSource');
 *     const shader = p.build(() => src.sample(uv).mul(vec4(u.uTint, 1.0)));
 */
export type { PslTarget, PslType } from './types.ts';
export type { PslStage } from './builder.ts';
export type { Operand } from './nodes.ts';
export { PslNode, PslVar, PslBranch } from './nodes.ts';
export {
    // constructors
    bool,
    int,
    float,
    vec2,
    vec3,
    vec4,
    // statements
    If,
    Loop,
    Fn,
    select,
    // math
    abs,
    atan2,
    ceil,
    clamp,
    cos,
    dot,
    exp2,
    floor,
    fract,
    length,
    log2,
    max,
    min,
    mix,
    mod,
    normalize,
    pow,
    sign,
    sin,
    smoothstep,
    sqrt,
    step,
} from './nodes.ts';
export type { PslLoopOptions } from './nodes.ts';
export { PslProgram, PslTexture, setTexture, uv } from './compile.ts';
export type { PslUniform, PslUniformSpec, PslUniformNodes } from './compile.ts';
export { patchRenderer } from './patch.ts';
