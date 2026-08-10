/**
 * Where a graph becomes a PixiJS `Shader`.
 *
 * A program declares its inputs up front -- uniform groups and textures -- then
 * `build()` walks the fragment graph twice, once per language, and hands both
 * sources plus the matching resource record to Pixi. The WGSL bindings and the
 * resource keys are generated from the same declarations, which is the whole
 * trick: there is no name to keep in sync by hand.
 */
import { Shader, Texture } from 'pixi.js';
import type { TextureSource } from 'pixi.js';
import { Builder, runGraph } from './builder.ts';
import { PslNode, RefNode, node } from './nodes.ts';
import type { Operand } from './nodes.ts';
import type { PslType } from './types.ts';
import { typeName } from './types.ts';

/** One member of a uniform group: a PSL type and the value Pixi should upload. */
export interface PslUniform {
    type: PslType;
    value: unknown;
}

export type PslUniformSpec = Record<string, PslUniform>;

/** The nodes for a uniform group, one per member. */
export type PslUniformNodes<T extends PslUniformSpec> = { readonly [K in keyof T]: PslNode };

/**
 * `vUV` -- 0..1 across the target, as PixiJS orients sprite UVs, so reading and
 * writing the same `vUV` is an identity copy.
 */
export const uv: PslNode = new RefNode('vec2', 'vUV');

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
        const coord = b.expr(this._coord);
        const lod = b.expr(this._lod);
        return b.wgsl
            ? `textureSampleLevel(${name}, ${samplerName}, ${coord}, ${lod})`
            : `textureLod(${name}, ${coord}, ${lod})`;
    }
}

interface GroupDecl {
    kind: 'uniforms' | 'texture';
    name: string;
    spec?: PslUniformSpec;
}

/**
 * The shared fullscreen-quad vertex stage.
 *
 * ponytail: the vertex stage is fixed, not a graph. Every pass here is a quad
 * scaled to its target, so a second graph walker plus WGSL varying-struct
 * plumbing would buy nothing today. Add `program.vertex(fn)` -- emitting into a
 * `VSOutput` struct built from declared varyings -- when a pass needs real
 * geometry.
 */
const VERTEX_GLSL = /* glsl */ `#version 300 es
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

/**
 * Groups 0 and 1 are spelled exactly as PixiJS' own shader bits spell them --
 * struct names included -- so `GpuProgram` recognises them and the mesh adaptor
 * fills them in. Unused members stay declared for the same reason: the bind
 * group Pixi hands over is laid out for the whole struct.
 */
const VERTEX_WGSL = /* wgsl */ `
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

export class PslProgram {
    private readonly _decls: GroupDecl[] = [];
    private readonly _resources: Record<string, unknown> = {};

    constructor(readonly name: string) {}

    /**
     * A uniform block. One GLSL uniform per member, one WGSL struct for the lot;
     * Pixi lays the buffer out from the same spec, so declaration order is the
     * only thing that has to match, and it does by construction.
     */
    uniforms<T extends PslUniformSpec>(name: string, spec: T): PslUniformNodes<T> {
        this._decls.push({ kind: 'uniforms', name, spec });
        const group: Record<string, { type: string; value: unknown }> = {};
        const nodes: Record<string, PslNode> = {};
        for (const key of Object.keys(spec)) {
            const member = spec[key]!;
            group[key] = { type: typeName(member.type, 'wgsl'), value: member.value };
            nodes[key] = new RefNode(member.type, key, `${name}.${key}`);
        }
        this._resources[name] = group;
        return nodes as PslUniformNodes<T>;
    }

    /** A texture slot, empty until {@link setTexture} points it somewhere. */
    texture(name: string): PslTexture {
        this._decls.push({ kind: 'texture', name });
        this._resources[name] = Texture.EMPTY.source;
        this._resources[`${name}Sampler`] = Texture.EMPTY.source.style;
        return new PslTexture(name);
    }

    /** Both languages, as text. The graph is walked once per target. */
    sources(fragment: () => PslNode): { glsl: string; wgsl: string } {
        return { glsl: this._fragment('glsl', fragment), wgsl: this._fragment('wgsl', fragment) };
    }

    /** Compile the fragment graph and hand Pixi both languages at once. */
    build(fragment: () => PslNode): Shader {
        const { glsl, wgsl } = this.sources(fragment);
        return Shader.from({
            gl: { vertex: VERTEX_GLSL, fragment: glsl, name: this.name },
            gpu: {
                vertex: { source: VERTEX_WGSL, entryPoint: 'main' },
                fragment: { source: wgsl, entryPoint: 'main' },
                name: this.name,
            },
            resources: { ...this._resources },
        });
    }

    private _fragment(target: 'glsl' | 'wgsl', fragment: () => PslNode): string {
        const b = new Builder(target, 'fragment');
        // The result has to be resolved before the body is joined -- resolving it
        // is what writes its last temporary out.
        const result = runGraph(b, () => b.expr(fragment()));
        const body = b.lines.join('\n');

        if (target === 'glsl') {
            return `#version 300 es
precision highp float;
in vec2 vUV;
out vec4 finalColor;

${this._headerGlsl()}
void main() {
${body}
    finalColor = ${result};
}
`;
        }
        return `${this._headerWgsl()}
@fragment
fn main(@location(0) vUV : vec2<f32>) -> @location(0) vec4<f32> {
${body}
    return ${result};
}
`;
    }

    private _headerGlsl(): string {
        const lines: string[] = [];
        for (const decl of this._decls) {
            if (decl.kind === 'texture') {
                lines.push(`uniform sampler2D ${decl.name};`);
                continue;
            }
            for (const key of Object.keys(decl.spec!)) {
                lines.push(`uniform ${typeName(decl.spec![key]!.type, 'glsl')} ${key};`);
            }
        }
        return `${lines.join('\n')}\n`;
    }

    private _headerWgsl(): string {
        const lines: string[] = [];
        let binding = 0;
        for (const decl of this._decls) {
            if (decl.kind === 'texture') {
                lines.push(`@group(${GROUP}) @binding(${binding++}) var ${decl.name} : texture_2d<f32>;`);
                lines.push(`@group(${GROUP}) @binding(${binding++}) var ${decl.name}Sampler : sampler;`);
                continue;
            }
            // The struct name only has to be unique and distinct from the group
            // variable's, which shares the shader's namespace.
            const struct = `${decl.name}_t`;
            const members = Object.keys(decl.spec!)
                .map((key) => `    ${key} : ${typeName(decl.spec![key]!.type, 'wgsl')},`)
                .join('\n');
            lines.push(`struct ${struct} {\n${members}\n};`);
            lines.push(`@group(${GROUP}) @binding(${binding++}) var<uniform> ${decl.name} : ${struct};`);
        }
        return `${lines.join('\n')}\n`;
    }
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
