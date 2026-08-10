/**
 * PSL -- pixi shader language.
 *
 * Write a shader once, as TypeScript, and get GLSL 300 es and WGSL out of it,
 * wired into a PixiJS `Shader` with the resource names both backends expect. The
 * API follows three.js' TSL: nodes are expressions, methods chain, and `If` /
 * `Loop` / `Switch` / `.toVar()` are statements that run as the graph function
 * runs.
 *
 *     const p = new PslProgram('tint');
 *     const u = p.uniforms('tintUniforms', { uTint: { type: 'vec3', value: [1, 0, 0] } });
 *     const src = p.texture('uSource');
 *     const shader = p.build(() => src.sample(uv).mul(vec4(u.uTint, 1.0)));
 *
 * With no vertex graph that is a fullscreen pass. Pass `build({ vertex, fragment })`
 * to use the same program as a mesh material: `position`, `vertexUV`, `uv`,
 * `mvpMatrix` and the rest are the names PixiJS already fixes, as nodes.
 */
export type { PslArrayType, PslPrimitive, PslStructType, PslTarget, PslType } from './types.ts';
export type { PslStage } from './builder.ts';
export type { Operand, PslStruct, PslSwizzle } from './nodes.ts';
export { PslNode, PslVar, PslBranch, PslSwitch } from './nodes.ts';
export {
    // constructors
    bool,
    int,
    uint,
    float,
    vec2,
    vec3,
    vec4,
    mat3,
    mat4,
    // composites
    struct,
    array,
    arrayOf,
    arrayVar,
    // statements
    If,
    Loop,
    Break,
    Continue,
    Discard,
    Switch,
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
export { PslProgram, PslAttribute, PslTexture, PslVarying, setTexture } from './compile.ts';
export {
    // the names PixiJS fixes, as nodes -- attributes, the varying, the two uniform blocks
    position,
    vertexUV,
    vertexColor,
    uv,
    projectionMatrix,
    worldMatrix,
    worldColorAlpha,
    resolution,
    modelMatrix,
    mvpMatrix,
    tint,
    roundPixels,
} from './compile.ts';
export type {
    PslGraphs,
    PslSources,
    PslUniform,
    PslUniformSpec,
    PslUniformNodes,
} from './compile.ts';
export { patchRenderer } from './patch.ts';
