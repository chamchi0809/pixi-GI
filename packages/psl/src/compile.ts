/**
 * Where a graph becomes a PixiJS `Shader`.
 *
 * A program declares its inputs up front -- uniform groups, textures,
 * attributes, varyings -- then compiles each stage's graph twice, once per
 * language, and hands both sources plus the matching resource record to Pixi.
 * The WGSL bindings, the GLSL declarations, and the resource keys are all
 * generated from the same declarations, which is the whole trick: there is no
 * name to keep in sync by hand.
 *
 * With no vertex graph the shader draws a unit quad and `uv` runs 0..1 across
 * the target -- a filter or a fullscreen pass. Give it one and the same program
 * is a mesh material: read {@link position} and friends, write the clip position
 * yourself, and pass whatever you like down to the fragment stage as varyings.
 *
 * The names PixiJS itself fixes -- `aPosition`, `aUV`, `vUV`, the global and
 * local uniform blocks -- are exported as nodes rather than left to be spelled
 * out, and declare themselves into whichever program's graph reaches them.
 */
import { Shader, Texture } from 'pixi.js';
import type { TextureSource } from 'pixi.js';
import { Builder, builder, runGraph } from './builder.ts';
import type { PslStage } from './builder.ts';
import { PslNode, node, vec4 } from './nodes.ts';
import type { Operand } from './nodes.ts';
import type { PslPrimitive, PslStructType, PslTarget, PslType } from './types.ts';
import { declarator, typeName } from './types.ts';

/** One member of a uniform group: a PSL type and the value Pixi should upload. */
export interface PslUniform {
    type: PslPrimitive;
    value: unknown;
}

export type PslUniformSpec = Record<string, PslUniform>;

/** The nodes for a uniform group, one per member. */
export type PslUniformNodes<T extends PslUniformSpec> = { readonly [K in keyof T]: PslNode };

/**
 * A name that belongs to a declaration: bare in GLSL, a member of its group's
 * struct in WGSL. Reaching it marks the declaration as used by this stage.
 */
class GroupRef extends PslNode {
    override readonly trivial = true;

    constructor(
        readonly type: PslType,
        private readonly _group: string,
        private readonly _key: string,
    ) {
        super();
    }

    emit(b: Builder): string {
        b.needs.add(this._group);
        return b.wgsl ? `${this._group}.${this._key}` : this._key;
    }
}

/**
 * A value handed from the vertex stage to the fragment stage.
 *
 * One declaration, two spellings: an `out`/`in` pair in GLSL, and in WGSL a
 * member of the vertex stage's output struct that arrives as a fragment entry
 * parameter at the same location.
 */
export class PslVarying extends PslNode {
    override readonly trivial = true;
    override readonly lvalue = true;

    constructor(
        readonly name: string,
        readonly type: PslPrimitive,
    ) {
        super();
    }

    emit(b: Builder): string {
        // Declared on use, so the built-in varyings cost nothing when unused and a
        // program never has to name one twice.
        b.program.declareVarying(this.name, this.type);
        if (b.stage === 'fragment') b.needs.add(`read:${this.name}`);
        return b.wgsl && b.stage === 'vertex' ? `out.${this.name}` : this.name;
    }

    override assign(value: Operand): void {
        const b = builder();
        if (b.stage !== 'vertex') {
            throw new Error(`[psl] ${this.name} is written in the vertex stage, read in the fragment stage`);
        }
        b.needs.add(`write:${this.name}`);
        b.line(`${this.emit(b)} = ${b.expr(node(value))};`);
    }
}

/** A vertex attribute: a bare name in both languages, and an entry parameter in WGSL. */
export class PslAttribute extends PslNode {
    override readonly trivial = true;

    constructor(
        readonly name: string,
        readonly type: PslPrimitive,
        private readonly _location?: number,
    ) {
        super();
    }

    emit(b: Builder): string {
        if (b.stage !== 'vertex') {
            throw new Error(`[psl] ${this.name} is a vertex attribute, so it cannot be read here`);
        }
        b.program.declareAttribute(this.name, this.type, this._location);
        b.needs.add(this.name);
        return this.name;
    }
}

/** A sampled texture. Bound by name, with its sampler alongside it under WebGPU. */
export class PslTexture {
    constructor(readonly name: string) {}

    /** The sampler's resource name -- `uFoo` is paired with `uFooSampler`. */
    get samplerName(): string {
        return `${this.name}Sampler`;
    }

    /**
     * Sample at LOD 0.
     *
     * Explicit rather than implicit even in GLSL, because WGSL forbids implicit
     * derivatives under non-uniform control flow and this way the two backends
     * cannot drift apart at a branch.
     */
    sample(coord: Operand): PslNode {
        return this.sampleLod(coord, 0);
    }

    sampleLod(coord: Operand, lod: Operand): PslNode {
        return new SampleNode(this, node(coord), node(lod));
    }
}

class SampleNode extends PslNode {
    readonly type = 'vec4' as const;

    constructor(
        private readonly _texture: PslTexture,
        private readonly _coord: PslNode,
        private readonly _lod: PslNode,
    ) {
        super();
    }

    emit(b: Builder): string {
        const { name, samplerName } = this._texture;
        b.needs.add(name);
        const coord = b.expr(this._coord);
        const lod = b.expr(this._lod);
        return b.wgsl
            ? `textureSampleLevel(${name}, ${samplerName}, ${coord}, ${lod})`
            : `textureLod(${name}, ${coord}, ${lod})`;
    }
}

interface Decl {
    kind: 'uniforms' | 'texture' | 'attribute' | 'varying';
    name: string;
    spec?: PslUniformSpec;
    type?: PslPrimitive;
    location?: number;
    /** WGSL binding index, assigned in declaration order across the whole program. */
    binding?: number;
}

// --- built-ins ------------------------------------------------------------
//
// The names PixiJS already fixes, as nodes, so a graph never spells one out and
// cannot misspell one. Each declares itself on first use, so an unused built-in
// costs nothing and is absent from the generated source.

/**
 * `aPosition` -- the vertex position, in the geometry's own space.
 *
 * Load-bearing beyond the shader: `Geometry.bounds` looks up `aPosition` by name
 * and returns an empty box without it, which silently takes `Mesh` culling,
 * `getBounds` and `containsPoint` with it.
 */
export const position: PslAttribute = new PslAttribute('aPosition', 'vec2');

/** `aUV` -- the texture coordinate `MeshGeometry` and `BatchGeometry` both carry. */
export const vertexUV: PslAttribute = new PslAttribute('aUV', 'vec2');

/** `aColor` -- the per-vertex tint `BatchGeometry` carries. Not in `MeshGeometry`. */
export const vertexColor: PslAttribute = new PslAttribute('aColor', 'vec4');

/**
 * `vUV` -- the texture coordinate handed to the fragment stage.
 *
 * With no vertex graph the built-in quad writes it, running 0..1 across the
 * target as PixiJS orients sprite UVs. With one, assign it yourself.
 */
export const uv: PslVarying = new PslVarying('vUV', 'vec2');

/**
 * The uniforms PixiJS supplies to every mesh, in the exact struct shape its own
 * shader bits use, so `GpuProgram` recognises groups 0 and 1 and the mesh
 * adaptor fills them in.
 */
const GLOBALS = {
    uProjectionMatrix: 'mat3',
    uWorldTransformMatrix: 'mat3',
    uWorldColorAlpha: 'vec4',
    uResolution: 'vec2',
} as const;

const LOCALS = {
    uTransformMatrix: 'mat3',
    uColor: 'vec4',
    uRound: 'float',
} as const;

/** Renderer-wide: the camera projection. */
export const projectionMatrix: PslNode = new GroupRef('mat3', 'globalUniforms', 'uProjectionMatrix');
/** The transform of the render group being drawn. */
export const worldMatrix: PslNode = new GroupRef('mat3', 'globalUniforms', 'uWorldTransformMatrix');
/** The render group's accumulated tint and alpha, premultiplied. */
export const worldColorAlpha: PslNode = new GroupRef('vec4', 'globalUniforms', 'uWorldColorAlpha');
/** Pixels per CSS pixel, as Pixi's `resolution`. */
export const resolution: PslNode = new GroupRef('vec2', 'globalUniforms', 'uResolution');
/** Per-object: the mesh's own transform. */
export const modelMatrix: PslNode = new GroupRef('mat3', 'localUniforms', 'uTransformMatrix');
/** The object's tint and alpha, premultiplied. */
export const tint: PslNode = new GroupRef('vec4', 'localUniforms', 'uColor');
/** 1 when Pixi wants vertices snapped to the pixel grid, 0 otherwise. */
export const roundPixels: PslNode = new GroupRef('float', 'localUniforms', 'uRound');

/**
 * The chain a vertex stage almost always wants: `vec3(position, 1)` through this
 * lands where Pixi puts the mesh. The same product Pixi's own vertex shaders form.
 */
export const mvpMatrix: PslNode = projectionMatrix.mul(worldMatrix).mul(modelMatrix);

/** The shared fullscreen-quad vertex stage, used when a program declares no vertex graph. */
const QUAD_GLSL = /* glsl */ `#version 300 es
in vec2 aPosition;
out vec2 vUV;

uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;

void main() {
    mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
    gl_Position = vec4((mvp * vec3(aPosition, 1.0)).xy, 0.0, 1.0);
    vUV = aPosition;
}
`;

const QUAD_WGSL = /* wgsl */ `
struct GlobalUniforms {
    uProjectionMatrix : mat3x3<f32>,
    uWorldTransformMatrix : mat3x3<f32>,
    uWorldColorAlpha : vec4<f32>,
    uResolution : vec2<f32>,
};

@group(0) @binding(0) var<uniform> globalUniforms : GlobalUniforms;

struct LocalUniforms {
    uTransformMatrix : mat3x3<f32>,
    uColor : vec4<f32>,
    uRound : f32,
};

@group(1) @binding(0) var<uniform> localUniforms : LocalUniforms;

struct VSOutput {
    @builtin(position) position : vec4<f32>,
    @location(0) vUV : vec2<f32>,
};

@vertex
fn main(@location(0) aPosition : vec2<f32>) -> VSOutput {
    let mvp = globalUniforms.uProjectionMatrix * globalUniforms.uWorldTransformMatrix * localUniforms.uTransformMatrix;
    var out : VSOutput;
    out.position = vec4<f32>((mvp * vec3<f32>(aPosition, 1.0)).xy, 0.0, 1.0);
    out.vUV = aPosition;
    return out;
}
`;

/** Custom bindings start after Pixi's global (0) and local (1) groups. */
const GROUP = 2;

/** Graphs a program compiles. A vertex graph returns the clip position. */
export interface PslGraphs {
    vertex?: () => Operand;
    fragment: () => Operand;
}

export interface PslSources {
    vertex: string;
    fragment: string;
}

export class PslProgram {
    private readonly _decls: Decl[] = [];
    private readonly _resources: Record<string, unknown> = {};
    private _binding = 0;

    constructor(readonly name: string) {}

    /**
     * A uniform block. One GLSL uniform per member, one WGSL struct for the lot;
     * Pixi lays the buffer out from the same spec, so declaration order is the
     * only thing that has to match, and it does by construction.
     */
    uniforms<T extends PslUniformSpec>(name: string, spec: T): PslUniformNodes<T> {
        this._decls.push({ kind: 'uniforms', name, spec, binding: this._binding++ });
        const group: Record<string, { type: string; value: unknown }> = {};
        const nodes: Record<string, PslNode> = {};
        for (const key of Object.keys(spec)) {
            const member = spec[key]!;
            group[key] = { type: typeName(member.type, 'wgsl'), value: member.value };
            nodes[key] = new GroupRef(member.type, name, key);
        }
        this._resources[name] = group;
        return nodes as PslUniformNodes<T>;
    }

    /** A texture slot, empty until {@link setTexture} points it somewhere. */
    texture(name: string): PslTexture {
        this._decls.push({ kind: 'texture', name, binding: this._binding });
        // The sampler takes the binding after its texture.
        this._binding += 2;
        this._resources[name] = Texture.EMPTY.source;
        this._resources[`${name}Sampler`] = Texture.EMPTY.source.style;
        return new PslTexture(name);
    }

    /**
     * A geometry attribute of your own. For the names Pixi's geometries already
     * use, take the built-in {@link position}, {@link vertexUV} or
     * {@link vertexColor} instead.
     *
     * The name is the whole contract: Pixi matches a shader attribute to a
     * `Geometry`'s attributes by string, on both backends, so locations only have
     * to be unique and are handed out as the graph reaches each attribute.
     * `location` is there for a geometry whose layout is fixed by something else.
     */
    attribute(name: string, type: PslPrimitive, location?: number): PslNode {
        return new PslAttribute(name, type, location);
    }

    /**
     * A value the vertex stage writes and the fragment stage reads. Both stages
     * take the location from the same list, so the two sides cannot disagree. The
     * texture coordinate is the built-in {@link uv}.
     */
    varying(name: string, type: PslPrimitive): PslVarying {
        return new PslVarying(name, type);
    }

    /**
     * @internal Register a name the graph just reached, once. Called by
     * {@link PslAttribute} and {@link PslVarying} as they emit, which is how the
     * built-ins belong to whichever program uses them.
     */
    declareAttribute(name: string, type: PslPrimitive, location?: number): void {
        this._declare('attribute', name, type, location);
    }

    /** @internal As {@link declareAttribute}, for a vertex-to-fragment value. */
    declareVarying(name: string, type: PslPrimitive): void {
        this._declare('varying', name, type);
    }

    private _declare(kind: 'attribute' | 'varying', name: string, type: PslPrimitive, location?: number): void {
        const existing = this._decls.find((d) => d.kind === kind && d.name === name);
        if (existing) {
            if (existing.type !== type) {
                throw new Error(`[psl] ${name} is already a ${existing.type} ${kind}, not ${type}`);
            }
            return;
        }
        const kindred = this._decls.filter((d) => d.kind === kind);
        this._decls.push({ kind, name, type, location: location ?? kindred.length });
    }

    /** Both languages, both stages, as text. Each graph is walked once per target. */
    sources(graphs: PslGraphs | (() => Operand)): Record<PslTarget, PslSources> {
        const g: PslGraphs = typeof graphs === 'function' ? { fragment: graphs } : graphs;
        const compile = (target: PslTarget): PslSources => {
            const vertex = g.vertex ? this._stage(target, 'vertex', g.vertex) : null;
            const fragment = this._stage(target, 'fragment', g.fragment);
            // A varying the vertex stage never writes reads back as whatever was in
            // the register under GLSL and as zero under WGSL -- the two backends
            // would quietly disagree, so it is a graph bug.
            if (vertex) {
                for (const need of fragment.builder.needs) {
                    if (!need.startsWith('read:')) continue;
                    const name = need.slice('read:'.length);
                    if (!vertex.builder.needs.has(`write:${name}`)) {
                        throw new Error(
                            `[psl] ${name} is read in the fragment stage but the vertex graph never writes it`,
                        );
                    }
                }
            } else {
                // The quad writes `vUV` at location 0 and nothing else, so another
                // varying would sit at a location the quad never fills -- and push
                // `vUV` off location 0 if it got there first.
                const stray = this._varyings().find((d) => d.name !== uv.name);
                if (stray) {
                    throw new Error(
                        `[psl] ${stray.name} and the other varyings need a vertex graph to write them -- build({ vertex, fragment })`,
                    );
                }
            }
            return {
                vertex: vertex?.source ?? (target === 'wgsl' ? QUAD_WGSL : QUAD_GLSL),
                fragment: fragment.source,
            };
        };
        return { glsl: compile('glsl'), wgsl: compile('wgsl') };
    }

    /** Compile the graphs and hand Pixi both languages at once. */
    build(graphs: PslGraphs | (() => Operand)): Shader {
        const { glsl, wgsl } = this.sources(graphs);
        return Shader.from({
            gl: { vertex: glsl.vertex, fragment: glsl.fragment, name: this.name },
            gpu: {
                vertex: { source: wgsl.vertex, entryPoint: 'main' },
                fragment: { source: wgsl.fragment, entryPoint: 'main' },
                name: this.name,
            },
            resources: { ...this._resources },
        });
    }

    // --- stage emission -----------------------------------------------------

    private _stage(
        target: PslTarget,
        stage: PslStage,
        graph: () => Operand,
    ): { source: string; builder: Builder } {
        const b = new Builder(this, target, stage);
        // The result has to be resolved before the body is joined -- resolving it
        // is what writes its last temporary out.
        const result = runGraph(b, () => {
            const value = node(graph());
            return b.expr(stage === 'vertex' ? clipPosition(value) : value);
        });
        const body = b.lines.join('\n');
        const head = [
            this._structs(b, target),
            this._interface(b, stage, target),
            this._resourceDecls(b, target),
            b.functions.join('\n\n'),
        ]
            .filter((part) => part.length > 0)
            .join('\n\n');

        const source =
            target === 'glsl'
                ? this._glsl(stage, head, body, result)
                : this._wgsl(b, stage, head, body, result);
        return { source, builder: b };
    }

    private _glsl(stage: PslStage, head: string, body: string, result: string): string {
        const preamble = stage === 'vertex' ? '' : 'precision highp float;\n';
        const write = stage === 'vertex' ? `gl_Position = ${result};` : `finalColor = ${result};`;
        return `#version 300 es
${preamble}${head}

void main() {
${body}
    ${write}
}
`;
    }

    private _wgsl(b: Builder, stage: PslStage, head: string, body: string, result: string): string {
        if (stage === 'vertex') {
            // Only what the stage read: Pixi builds its vertex buffer layout from
            // the attributes it finds in this signature, and looks each one up in
            // the geometry by name, so an unused declaration is a missing buffer.
            const params = this._decls
                .filter((d) => d.kind === 'attribute' && b.needs.has(d.name))
                .map((d) => `@location(${d.location}) ${declarator(d.name, d.type!, 'wgsl')}`)
                .join(', ');
            // `out` is declared before the body, because the body is what assigns
            // the varyings.
            return `${head}

@vertex
fn main(${params}) -> VSOutput {
    var out : VSOutput;
${body}
    out.position = ${result};
    return out;
}
`;
        }
        const params = this._varyings()
            .map((d) => `@location(${d.location}) ${declarator(d.name, d.type!, 'wgsl')}`)
            .join(', ');
        return `${head}

@fragment
fn main(${params}) -> @location(0) vec4<f32> {
${body}
    return ${result};
}
`;
    }

    /**
     * The varyings this program carries, which is however many the graphs reached.
     * Both stages read this same list, so their locations cannot disagree.
     */
    private _varyings(): Decl[] {
        return this._decls.filter((d) => d.kind === 'varying');
    }

    /** Struct types the stage reached, in the order they have to be declared. */
    private _structs(b: Builder, target: PslTarget): string {
        return [...b.structs.values()].map((type) => structDecl(type, target)).join('\n\n');
    }

    /**
     * The stage's inputs and outputs: attributes and varyings in GLSL, and in
     * WGSL only the vertex output struct -- everything else rides on the entry
     * point's signature.
     */
    private _interface(b: Builder, stage: PslStage, target: PslTarget): string {
        const varyings = this._varyings();
        if (target === 'wgsl') {
            if (stage !== 'vertex') return '';
            const members = varyings
                .map((d) => `    @location(${d.location}) ${declarator(d.name, d.type!, 'wgsl')},`)
                .join('\n');
            return `struct VSOutput {\n    @builtin(position) position : vec4<f32>,\n${members}\n};`;
        }
        const lines: string[] = [];
        if (stage === 'vertex') {
            for (const d of this._decls) {
                if (d.kind === 'attribute' && b.needs.has(d.name)) {
                    lines.push(`in ${declarator(d.name, d.type!, 'glsl')};`);
                }
            }
        }
        const direction = stage === 'vertex' ? 'out' : 'in';
        for (const d of varyings) lines.push(`${direction} ${declarator(d.name, d.type!, 'glsl')};`);
        if (stage === 'fragment') lines.push('out vec4 finalColor;');
        return lines.join('\n');
    }

    /**
     * Uniform blocks and textures, declared only where they are used.
     *
     * Binding numbers come from the declaration order of the whole program, not
     * from what one stage happens to use, so the two stages agree on them and
     * Pixi's reflection sees one layout.
     */
    private _resourceDecls(b: Builder, target: PslTarget): string {
        const lines: string[] = [];
        if (target === 'wgsl') {
            if (b.needs.has('globalUniforms')) {
                lines.push(uniformBlock('GlobalUniforms', 'globalUniforms', GLOBALS, 0, 0));
            }
            if (b.needs.has('localUniforms')) {
                lines.push(uniformBlock('LocalUniforms', 'localUniforms', LOCALS, 1, 0));
            }
        } else {
            const pixi: [string, Record<string, PslPrimitive>][] = [
                ['globalUniforms', GLOBALS],
                ['localUniforms', LOCALS],
            ];
            for (const [group, spec] of pixi) {
                if (!b.needs.has(group)) continue;
                for (const key of Object.keys(spec)) {
                    lines.push(`uniform ${declarator(key, spec[key]!, 'glsl')};`);
                }
            }
        }

        for (const decl of this._decls) {
            if (!b.needs.has(decl.name)) continue;
            if (decl.kind === 'texture') {
                lines.push(
                    target === 'wgsl'
                        ? `@group(${GROUP}) @binding(${decl.binding}) var ${decl.name} : texture_2d<f32>;\n` +
                              `@group(${GROUP}) @binding(${decl.binding! + 1}) var ${decl.name}Sampler : sampler;`
                        : `uniform sampler2D ${decl.name};`,
                );
            } else if (decl.kind === 'uniforms') {
                const spec: Record<string, PslPrimitive> = {};
                for (const key of Object.keys(decl.spec!)) spec[key] = decl.spec![key]!.type;
                if (target === 'wgsl') {
                    // The struct name only has to be unique and distinct from the
                    // group variable's, which shares the shader's namespace.
                    lines.push(uniformBlock(`${decl.name}_t`, decl.name, spec, GROUP, decl.binding!));
                } else {
                    for (const key of Object.keys(spec)) {
                        lines.push(`uniform ${declarator(key, spec[key]!, 'glsl')};`);
                    }
                }
            }
        }
        return lines.join('\n');
    }
}

/**
 * What a vertex graph returns, as the vec4 both languages want in the position.
 *
 * Pixi's 2D transforms are `mat3`, so the natural result of transforming a point
 * is a vec3 whose `.xy` is where it lands -- exactly what Pixi's own vertex
 * shaders widen by hand. Doing it here means a graph can return the transform's
 * result directly and neither backend gets a type mismatch.
 */
function clipPosition(value: PslNode): PslNode {
    switch (value.type) {
        case 'vec4':
            return value;
        case 'vec3':
            return vec4(value.xy, 0, 1);
        case 'vec2':
            return vec4(value, 0, 1);
        default:
            throw new Error(`[psl] a vertex graph returns a position, got ${typeName(value.type, 'glsl')}`);
    }
}

function structDecl(type: PslStructType, target: PslTarget): string {
    const members = Object.entries(type.members)
        .map(([key, member]) =>
            target === 'wgsl'
                ? `    ${declarator(key, member, 'wgsl')},`
                : `    ${declarator(key, member, 'glsl')};`,
        )
        .join('\n');
    return `struct ${type.name} {\n${members}\n};`;
}

function uniformBlock(
    struct: string,
    variable: string,
    spec: Record<string, PslPrimitive>,
    group: number,
    binding: number,
): string {
    const members = Object.keys(spec)
        .map((key) => `    ${declarator(key, spec[key]!, 'wgsl')},`)
        .join('\n');
    return (
        `struct ${struct} {\n${members}\n};\n` +
        `@group(${group}) @binding(${binding}) var<uniform> ${variable} : ${struct};`
    );
}

/**
 * Point a texture slot at a source, sampler included.
 *
 * WebGL has no separate sampler object, and Pixi's GL shader sync skips any
 * resource that is not a texture or a uniform block, so the extra entry is inert
 * there rather than conditional here.
 */
export function setTexture(shader: Shader, name: string, source: TextureSource): void {
    const resources = shader.resources as Record<string, unknown>;
    resources[name] = source;
    resources[`${name}Sampler`] = source.style;
}
