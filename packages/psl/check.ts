/**
 * Self-check: `pnpm --filter pixi-psl check`.
 *
 * Two programs -- a fullscreen pass and a mesh material -- exercising every
 * construct where the two languages disagree, and an assert per disagreement. If
 * PSL ever emits GLSL semantics into WGSL (or the reverse) this is what fails.
 */
import assert from 'node:assert/strict';
import {
    Break,
    Continue,
    Discard,
    Fn,
    If,
    Loop,
    PslProgram,
    Switch,
    arrayVar,
    dot,
    float,
    int,
    mat4,
    mod,
    modelMatrix,
    mvpMatrix,
    position,
    select,
    struct,
    tint,
    uint,
    uv,
    vec2,
    vertexUV,
    vec3,
    vec4,
} from './src/index.ts';

// --- a fullscreen pass ----------------------------------------------------------

const p = new PslProgram('check');
const u = p.uniforms('checkUniforms', {
    uExtent: { type: 'float', value: 4 },
    uFrustum: { type: 'float', value: 0 },
    uAmbient: { type: 'vec3', value: new Float32Array(3) },
});
const tex = p.texture('uSource');

/** A real function: one definition, however many call sites. */
const luma = Fn(['vec3'], 'float', (c) => dot(c, vec3(0.2126, 0.7152, 0.0722)));
const Hit = struct('Hit', { colour: 'vec3', distance: 'float' });

const { glsl, wgsl } = p.sources(() => {
    const texel = uv.mul(u.uExtent);
    const out = vec3(0).toVar();
    If(texel.x.lessThan(1), () => {
        out.assign(tex.sample(uv).rgb);
    })
        .ElseIf(texel.x.lessThan(2), () => {
            Discard();
        })
        .Else(() => {
            out.assign(select(texel.equal(vec2(0, 0)), u.uAmbient, vec3(1)));
        });

    // Both swizzle sets, including combinations only the template-literal type covers.
    out.assign(out.bgr.add(out.zyx).mul(0.5));

    const scratch = arrayVar('vec3', 3);
    Loop({ start: 1, end: u.uFrustum }, (l) => {
        If(l.greaterThan(8), () => {
            Break();
        });
        If(l.lessThan(0), () => {
            Continue();
        });
        scratch.element(int(1)).assign(tex.sampleLod(uv, l).rgb);
        out.assign(out.add(scratch.element(int(1))));
    });

    // A struct built, returned from a var, and read back by member.
    const hit = Hit({ colour: out, distance: luma(out) }).toVar();
    const total = float(0).toVar();
    Switch(int(u.uFrustum), (s) => {
        s.Case(0, () => {
            total.assign(luma(hit.get('colour')));
        })
            .Case([1, 2], () => {
                total.assign(hit.get('distance'));
            })
            .Default(() => {
                total.assign(1);
            });
    });

    // uint and mat4 exist and are spelled per language.
    const packed = uint(3).toVar();
    const m = mat4(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1).toVar();
    const bumped = m.mul(vec4(out, 1)).toVar();
    return vec4(
        bumped.rgb.mul(mod(texel.x, 2)).mul(total).add(float(packed).mul(0)),
        hit.get('distance'),
    );
});

// mod: WGSL's `%` truncates towards zero, so it is written out longhand there.
assert.match(glsl.fragment, /mod\(/, 'glsl keeps the built-in mod');
assert.doesNotMatch(wgsl.fragment, /[^a-zA-Z]mod\(/, 'wgsl must not use a mod built-in');
assert.match(wgsl.fragment, /- \S+ \* floor\(/, 'wgsl expands mod to floored form');

// Vector equality is whole-value in GLSL, component-wise in WGSL.
assert.match(wgsl.fragment, /all\(/, 'wgsl folds vector == with all()');
assert.doesNotMatch(glsl.fragment, /all\(/, 'glsl == is already a scalar bool');

// select() reverses its operands between the two.
assert.match(wgsl.fragment, /select\(/, 'wgsl uses select()');
assert.match(glsl.fragment, /\?/, 'glsl uses a ternary');

// Sampling is always at an explicit level, so a branch cannot make it illegal.
assert.match(glsl.fragment, /textureLod\(uSource, /, 'glsl samples at an explicit lod');
assert.match(
    wgsl.fragment,
    /textureSampleLevel\(uSource, uSourceSampler, /,
    'wgsl samples with its sampler',
);
assert.doesNotMatch(wgsl.fragment, /textureSample\(/, 'wgsl must never use implicit-lod sampling');

// Declarations: the same names on both sides, bound where Pixi expects them.
assert.match(glsl.fragment, /uniform sampler2D uSource;/, 'glsl declares the sampler2D');
// Bindings are numbered in declaration order, starting after Pixi's own groups.
assert.match(
    wgsl.fragment,
    /@group\(2\) @binding\(0\) var<uniform> checkUniforms :/,
    'uniform block was declared first',
);
assert.match(
    wgsl.fragment,
    /@group\(2\) @binding\(1\) var uSource : texture_2d<f32>;/,
    'texture at group 2',
);
assert.match(
    wgsl.fragment,
    /@group\(2\) @binding\(2\) var uSourceSampler : sampler;/,
    'sampler follows its texture',
);
assert.match(glsl.fragment, /uniform vec3 uAmbient;/, 'glsl uniforms are loose');
assert.match(wgsl.fragment, /uAmbient : vec3<f32>,/, 'wgsl uniforms are struct members');
assert.match(wgsl.fragment, /checkUniforms\.uAmbient/, 'wgsl reads uniforms through the group');

// Entry points and the fragment result.
assert.match(glsl.fragment, /finalColor = \w+;\n}/, 'glsl writes its out variable last');
assert.match(wgsl.fragment, /return \w+;\n}/, 'wgsl returns its result');
assert.match(wgsl.fragment, /-> @location\(0\) vec4<f32>/, 'wgsl fragment returns to location 0');
assert.match(wgsl.fragment, /@location\(0\) vUV : vec2<f32>/, 'the quad varying arrives as a parameter');
assert.match(glsl.fragment, /in vec2 vUV;/, 'glsl declares the quad varying');

// Loops count in float on both, so the arithmetic inside cannot diverge.
assert.match(glsl.fragment, /for \(float \w+ = /, 'glsl loop counter is a float');
assert.match(wgsl.fragment, /for \(var \w+ : f32 = /, 'wgsl loop counter is a float');
for (const source of [glsl.fragment, wgsl.fragment]) {
    assert.match(source, /break;/, 'Break is the same keyword in both');
    assert.match(source, /continue;/, 'Continue is the same keyword in both');
    assert.match(source, /discard;/, 'Discard is the same keyword in both');
}

// An else-if nests inside the else, because the chained condition may need
// temporaries and those go before its `if`. The trailing else then has to be
// written back into that nested if -- past the closers already below it.
for (const source of [glsl.fragment, wgsl.fragment]) {
    assert.match(source, /\} else \{\n(?:[^\n]*;\n)+\s+if \(/, 'else-if nests inside the else');
    assert.match(
        source,
        /discard;\n(\s+)\} else \{\n(?:.+\n)+?\1\}\n/,
        'the trailing else body stays inside the else-if',
    );
}

// Switch: WGSL takes a value list, GLSL stacks labels, and both need the default.
assert.match(wgsl.fragment, /case 1, 2: \{/, 'wgsl lists case values');
assert.match(glsl.fragment, /case 1: case 2: \{/, 'glsl stacks case labels');
for (const source of [glsl.fragment, wgsl.fragment]) {
    assert.match(source, /default: \{/, 'both need a default clause');
}
assert.throws(
    () =>
        p.sources(() => {
            Switch(int(1), (s) => s.Case(0, () => {}));
            return vec4(0);
        }),
    /needs a Default/,
    'a switch without a default is a WGSL error, so PSL refuses it',
);
assert.throws(
    () =>
        p.sources(() => {
            Switch(float(1), (s) => s.Default(() => {}));
            return vec4(0);
        }),
    /int or uint selector/,
    'a float selector is refused',
);

// Types that only exist now: uint and mat4.
assert.match(glsl.fragment, /uint \w+ = 3u;/, 'glsl uint literal');
assert.match(wgsl.fragment, /var \w+ : u32 = 3u;/, 'wgsl spells it u32');
assert.match(glsl.fragment, /mat4 \w+ = mat4\(/, 'glsl mat4');
assert.match(wgsl.fragment, /mat4x4<f32> = mat4x4<f32>\(/, 'wgsl spells it mat4x4<f32>');

// Structs: declared once, per language, above the entry point.
assert.match(glsl.fragment, /struct Hit \{\n\s+vec3 colour;\n\s+float distance;\n};/, 'glsl struct');
assert.match(
    wgsl.fragment,
    /struct Hit \{\n\s+colour : vec3<f32>,\n\s+distance : f32,\n};/,
    'wgsl struct',
);
assert.equal(glsl.fragment.match(/struct Hit/g)?.length, 1, 'declared exactly once');

// Arrays: GLSL puts the size after the name, WGSL inside the type.
assert.match(glsl.fragment, /vec3 \w+\[3\];/, 'glsl array declaration is postfix');
assert.match(wgsl.fragment, /var \w+ : array<vec3<f32>, 3>;/, 'wgsl array declaration is a generic');
assert.throws(
    () =>
        p.sources(() => {
            arrayVar('vec3', 2).element(float(1));
            return vec4(0);
        }),
    /index must be int or uint/,
    'a float index is refused rather than passed to the driver',
);

// Fn: one definition per stage, called from every site.
for (const source of [glsl.fragment, wgsl.fragment]) {
    assert.equal(source.match(/fn0\(/g)?.length, 3, 'one definition and two calls');
}
assert.match(glsl.fragment, /^float fn0\(vec3 p0\) \{$/m, 'glsl function signature');
assert.match(wgsl.fragment, /^fn fn0\(p0 : vec3<f32>\) -> f32 \{$/m, 'wgsl function signature');
assert.throws(
    () => {
        const loop: (v: number) => unknown = Fn(['float'], 'float', (v) => loop(0) as never);
        return p.sources(() => vec4(loop(0) as never));
    },
    /cannot call itself/,
    'recursion is illegal in both languages, so it is caught here',
);

// Both languages must have the same number of statements: the graph is one program.
const count = (source: string): number =>
    source.split('\n').filter((line) => line.trim().endsWith(';')).length;
assert.equal(
    count(glsl.fragment.slice(glsl.fragment.indexOf('void main'))),
    count(wgsl.fragment.slice(wgsl.fragment.indexOf('fn main'))),
    'the two bodies must be the same program',
);

// --- a mesh material -----------------------------------------------------------

const mesh = new PslProgram('material');
const camera = mesh.uniforms('cameraUniforms', {
    uWave: { type: 'float', value: 0 },
});
const vTint = mesh.varying('vTint', 'vec4');

const material = mesh.sources({
    vertex: () => {
        // `position`, `vertexUV`, `uv`, `mvpMatrix` and `tint` are the built-ins:
        // the names Pixi fixes, declared into this program by being reached.
        const local = position.add(vec2(0, camera.uWave));
        uv.assign(vertexUV);
        vTint.assign(tint);
        return vec4(mvpMatrix.mul(vec3(local, 1)).xy, 0, 1);
    },
    fragment: () => uv.mul(vTint.a).x.mul(vTint),
});

// Attributes: bare `in` in GLSL, located entry parameters in WGSL.
assert.match(material.glsl.vertex, /in vec2 aPosition;/, 'glsl attribute');
// Locations are assigned as the graph reaches each attribute, and Pixi matches
// them to the geometry by name, so only distinctness is worth asserting.
const params = material.wgsl.vertex.match(/fn main\((.*)\) ->/)![1]!.split(', ');
assert.deepEqual(
    params.map((param) => param.replace(/@location\(\d+\) /, '')).sort(),
    ['aPosition : vec2<f32>', 'aUV : vec2<f32>'],
    'wgsl attributes are entry parameters',
);
assert.equal(
    new Set(params.map((param) => param.match(/@location\((\d+)\)/)![1])).size,
    params.length,
    'each at its own location',
);

// Varyings: an out/in pair in GLSL, a struct member written through `out` in WGSL.
assert.match(material.glsl.vertex, /out vec2 vUV;\nout vec4 vTint;/, 'glsl vertex outputs');
assert.match(material.glsl.fragment, /in vec2 vUV;\nin vec4 vTint;/, 'glsl fragment inputs');
assert.match(
    material.wgsl.vertex,
    /struct VSOutput \{\n\s+@builtin\(position\) position : vec4<f32>,\n\s+@location\(0\) vUV : vec2<f32>,\n\s+@location\(1\) vTint : vec4<f32>,\n};/,
    'wgsl gathers the varyings into the vertex output struct',
);
assert.match(material.wgsl.vertex, /out\.vUV = aUV;/, 'wgsl writes varyings through out');
assert.match(material.glsl.vertex, /vUV = aUV;/, 'glsl writes varyings by name');
assert.match(
    material.wgsl.fragment,
    /@location\(0\) vUV : vec2<f32>, @location\(1\) vTint : vec4<f32>/,
    'the fragment stage takes the same locations back',
);

// The clip position goes to gl_Position / out.position, whichever language.
assert.match(material.glsl.vertex, /gl_Position = \w+;/, 'glsl writes gl_Position');
assert.match(material.wgsl.vertex, /out\.position = \w+;\n\s+return out;/, 'wgsl fills the struct');

// Pixi's own uniform blocks, spelled the way Pixi's own shaders spell them.
assert.match(material.glsl.vertex, /uniform mat3 uProjectionMatrix;/, 'glsl gets loose builtins');
assert.match(
    material.wgsl.vertex,
    /@group\(0\) @binding\(0\) var<uniform> globalUniforms : GlobalUniforms;/,
    'wgsl globals at group 0',
);
assert.match(
    material.wgsl.vertex,
    /@group\(1\) @binding\(0\) var<uniform> localUniforms : LocalUniforms;/,
    'wgsl locals at group 1',
);
assert.match(material.wgsl.vertex, /globalUniforms\.uProjectionMatrix/, 'read through the group');

// Declarations follow use: the fragment stage never sees the vertex stage's inputs.
assert.doesNotMatch(material.glsl.fragment, /aPosition/, 'no attributes in the fragment stage');
assert.doesNotMatch(material.glsl.fragment, /uProjectionMatrix/, 'no unused builtins either');
assert.doesNotMatch(material.wgsl.fragment, /globalUniforms/, 'nor in wgsl');
assert.doesNotMatch(material.glsl.vertex, /precision/, 'precision is a fragment-stage concern');

// A varying with no vertex graph to write it cannot work, so it is refused early.
assert.throws(
    () => {
        const orphan = new PslProgram('orphan');
        const v = orphan.varying('vColour', 'vec3');
        return orphan.sources(() => vec4(v, 1));
    },
    /need a vertex graph to write them/,
    'varyings without a vertex graph are refused',
);
assert.throws(
    () =>
        mesh.sources({
            vertex: () => {
                Discard();
                return vec4(0);
            },
            fragment: () => vec4(0),
        }),
    /only valid in the fragment stage/,
    'discard is fragment-only in WGSL, so PSL enforces it everywhere',
);
assert.throws(
    () =>
        mesh.sources({
            vertex: () => vec4(0),
            // An attribute only exists in the vertex stage; reaching for one from the
            // fragment graph means a varying was meant.
            fragment: () => vec4(position, 0, 1),
        }),
    /vertex attribute/,
    'an attribute read from the fragment stage is a graph bug',
);

// Pixi's 2D transforms are mat3, so a vertex graph may return their vec3 result
// and have it widened to the vec4 the position wants -- identically in both.
const flat = new PslProgram('flat');
const widened = flat.sources({
    vertex: () => modelMatrix.mul(vec3(position, 1)),
    fragment: () => vec4(1),
});
assert.match(widened.glsl.vertex, /vec4 (\w+) = vec4\(\w+\.xy, 0\.0, 1\.0\);\n\s+gl_Position = \1;/, 'glsl widens');
assert.match(
    widened.wgsl.vertex,
    /vec4<f32> = vec4<f32>\(\w+\.xy, 0\.0, 1\.0\);\n\s+out\.position = \w+;/,
    'wgsl widens the same way',
);
assert.throws(
    () => flat.sources({ vertex: () => float(1), fragment: () => vec4(1) }),
    /vertex graph returns a position/,
    'a vertex graph that returns something unusable is caught, not handed to the driver',
);

// A varying read but never written is undefined in GLSL and zero in WGSL, so the
// backends would disagree -- including via the built-in quad `uv`, which only the
// built-in quad vertex stage writes.
assert.throws(
    () => flat.sources({ vertex: () => vec4(position, 0, 1), fragment: () => vec4(uv, 0, 1) }),
    /never writes it/,
    'a custom vertex graph has to write uv itself',
);
assert.throws(
    () =>
        mesh.sources({
            vertex: () => vec4(position, 0, 1),
            fragment: () => vTint,
        }),
    /never writes it/,
    'a varying the vertex graph forgot is caught',
);

// --- built-ins declare themselves, and only where they are used -----------------

// A program that never reaches an attribute must not declare it: Pixi builds the
// vertex buffer layout from the signature and looks each name up in the geometry,
// so a declaration with no buffer behind it is a broken draw rather than dead code.
const lean = new PslProgram('lean');
lean.attribute('aUnused', 'vec4');
const leanSource = lean.sources({
    vertex: () => vec4(position, 0, 1),
    fragment: () => vec4(1),
});
assert.doesNotMatch(leanSource.wgsl.vertex, /aUnused/, 'an unreached attribute is not a parameter');
assert.doesNotMatch(leanSource.glsl.vertex, /aUnused/, 'nor a glsl input');
assert.match(leanSource.wgsl.vertex, /@location\(0\) aPosition/, 'the reached one takes location 0');

// The same built-in node in two programs belongs to both, at each one's own location.
const shared = new PslProgram('shared');
const sharedSource = shared.sources({
    vertex: () => {
        uv.assign(vertexUV);
        return vec4(position, 0, 1);
    },
    fragment: () => vec4(uv, 0, 1),
});
assert.match(sharedSource.wgsl.vertex, /aPosition : vec2<f32>/, 'the same node, this program\'s signature');
assert.match(sharedSource.glsl.fragment, /in vec2 vUV;/, 'uv works with a custom vertex stage now');
assert.throws(
    () =>
        shared.sources({
            vertex: () => vec4(shared.attribute('aPosition', 'vec4')),
            fragment: () => vec4(1),
        }),
    /already a vec2 attribute/,
    'redeclaring a built-in name with another type is a graph bug',
);

console.log('psl: ok');
