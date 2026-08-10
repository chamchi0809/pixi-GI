/**
 * Self-check: `pnpm --filter pixi-psl check`.
 *
 * One graph, exercising every construct where the two languages disagree, and
 * an assert per disagreement. If PSL ever emits GLSL semantics into WGSL (or the
 * reverse) this is what fails.
 */
import assert from 'node:assert/strict';
import { If, Loop, PslProgram, mod, select, uv, vec2, vec3, vec4 } from './src/index.ts';

const p = new PslProgram('check');
const u = p.uniforms('checkUniforms', {
    uExtent: { type: 'float', value: 4 },
    uFrustum: { type: 'float', value: 0 },
    uAmbient: { type: 'vec3', value: new Float32Array(3) },
});
const tex = p.texture('uSource');

const { glsl, wgsl } = p.sources(() => {
    const texel = uv.mul(u.uExtent);
    const out = vec3(0).toVar();
    If(texel.x.lessThan(1), () => {
        out.assign(tex.sample(uv).rgb);
    }).Else(() => {
        out.assign(select(texel.equal(vec2(0, 0)), u.uAmbient, vec3(1)));
    });
    Loop({ start: 1, end: u.uFrustum }, (l) => {
        out.assign(out.add(tex.sampleLod(uv, l).rgb));
    });
    return vec4(out.mul(mod(texel.x, 2)), 1);
});

// mod: WGSL's `%` truncates towards zero, so it is written out longhand there.
assert.match(glsl, /mod\(/, 'glsl keeps the built-in mod');
assert.doesNotMatch(wgsl, /[^a-zA-Z]mod\(/, 'wgsl must not use a mod built-in');
assert.match(wgsl, /- \S+ \* floor\(/, 'wgsl expands mod to floored form');

// Vector equality is whole-value in GLSL, component-wise in WGSL.
assert.match(wgsl, /all\(/, 'wgsl folds vector == with all()');
assert.doesNotMatch(glsl, /all\(/, 'glsl == is already a scalar bool');

// select() reverses its operands between the two.
assert.match(wgsl, /select\(/, 'wgsl uses select()');
assert.match(glsl, /\?/, 'glsl uses a ternary');

// Sampling is always at an explicit level, so a branch cannot make it illegal.
assert.match(glsl, /textureLod\(uSource, /, 'glsl samples at an explicit lod');
assert.match(wgsl, /textureSampleLevel\(uSource, uSourceSampler, /, 'wgsl samples with its sampler');
assert.doesNotMatch(wgsl, /textureSample\(/, 'wgsl must never use implicit-lod sampling');

// Declarations: the same names on both sides, bound where Pixi expects them.
assert.match(glsl, /uniform sampler2D uSource;/, 'glsl declares the sampler2D');
// Bindings are numbered in declaration order, starting after Pixi's own groups.
assert.match(wgsl, /@group\(2\) @binding\(0\) var<uniform> checkUniforms :/, 'uniform block was declared first');
assert.match(wgsl, /@group\(2\) @binding\(1\) var uSource : texture_2d<f32>;/, 'texture at group 2');
assert.match(wgsl, /@group\(2\) @binding\(2\) var uSourceSampler : sampler;/, 'sampler follows its texture');
assert.match(glsl, /uniform vec3 uAmbient;/, 'glsl uniforms are loose');
assert.match(wgsl, /uAmbient : vec3<f32>,/, 'wgsl uniforms are struct members');
assert.match(wgsl, /checkUniforms\.uAmbient/, 'wgsl reads uniforms through the group');

// Entry points and the fragment result.
assert.match(glsl, /finalColor = \w+;\n}/, 'glsl writes its out variable last');
assert.match(wgsl, /return \w+;\n}/, 'wgsl returns its result');
assert.match(wgsl, /-> @location\(0\) vec4<f32>/, 'wgsl fragment returns to location 0');

// Loops count in float on both, so the arithmetic inside cannot diverge.
assert.match(glsl, /for \(float \w+ = /, 'glsl loop counter is a float');
assert.match(wgsl, /for \(var \w+ : f32 = /, 'wgsl loop counter is a float');

// Both languages must have the same number of statements: the graph is one program.
const count = (source: string): number => source.split('\n').filter((line) => line.trim().endsWith(';')).length;
assert.equal(
    count(glsl.slice(glsl.indexOf('void main'))),
    count(wgsl.slice(wgsl.indexOf('fn main'))),
    'the two bodies must be the same program',
);

console.log('psl: ok');
