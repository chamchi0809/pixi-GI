import { Buffer, BufferUsage, Container, Geometry, Mesh, Shader } from 'pixi.js';
import type { Renderer, RenderTexture, TextureSource } from 'pixi.js';
import { LIGHT_FRAG, LIGHT_VERTEX, VERTEX } from './shaders';
import { LIGHT_FLOATS } from './lights';

/** A fullscreen shader pass, drawn as a unit quad scaled to the target. */
export class Pass {
    readonly mesh: Mesh<Geometry, Shader>;

    constructor(name: string, fragment: string, resources: Record<string, unknown>) {
        const shader = Shader.from({
            gl: { vertex: VERTEX, fragment, name },
            resources,
        });
        const geometry = new Geometry({
            attributes: { aPosition: [0, 0, 1, 0, 1, 1, 0, 1] },
            indexBuffer: [0, 1, 2, 0, 2, 3],
        });
        this.mesh = new Mesh<Geometry, Shader>({ geometry, shader });
    }

    /** Uniform groups and texture slots, by shader resource name. */
    get resources(): Record<string, any> {
        return this.mesh.shader!.resources;
    }

    setTexture(name: string, source: TextureSource): void {
        this.resources[name] = source;
    }

    run(renderer: Renderer, target: RenderTexture): void {
        this.mesh.scale.set(target.width, target.height);
        renderer.render({ container: this.mesh, target, clear: true, clearColor: 0x000000 });
    }

    destroy(): void {
        this.mesh.destroy({ children: true });
    }
}

/** Lights the buffer starts out able to hold. It doubles from here as needed. */
const INITIAL_CAPACITY = 64;

/**
 * The deferred occluder light pass: one additively blended instanced quad per
 * emitter, accumulated into a light buffer the composite reads once.
 *
 * The instance buffer grows on demand, so the only limit on the light count is
 * memory. See {@link LIGHT_VERTEX} for why the quads are the win.
 */
export class LightPass {
    /** Interleaved instance data, {@link LIGHT_FLOATS} floats per light. */
    private _data = new Float32Array(INITIAL_CAPACITY * LIGHT_FLOATS);
    private readonly _instances: Buffer;
    private readonly _geometry: Geometry;
    private readonly _mesh: Mesh<Geometry, Shader>;
    /**
     * A Mesh is only given its `groupBlendMode` as somebody's *child*; as the
     * root of a `renderer.render` call it would silently stay `normal`.
     */
    private readonly _root = new Container();

    constructor(resources: Record<string, unknown>) {
        this._instances = new Buffer({
            data: this._data,
            usage: BufferUsage.VERTEX | BufferUsage.COPY_DST,
            label: 'gi-light-instances',
        });
        // Explicit stride/offset: Pixi only infers them from the shader, which
        // reports offset 0 for every attribute, and these two share one buffer.
        this._geometry = new Geometry({
            attributes: {
                aPosition: [0, 0, 1, 0, 1, 1, 0, 1],
                aLight: { buffer: this._instances, format: 'float32x4', stride: 32, offset: 0, instance: true },
                aLightColor: { buffer: this._instances, format: 'float32x4', stride: 32, offset: 16, instance: true },
            },
            indexBuffer: [0, 1, 2, 0, 2, 3],
            instanceCount: 0,
        });
        this._mesh = new Mesh<Geometry, Shader>({
            geometry: this._geometry,
            shader: Shader.from({ gl: { vertex: LIGHT_VERTEX, fragment: LIGHT_FRAG, name: 'gi-light' }, resources }),
        });
        this._mesh.blendMode = 'add';
        this._root.addChild(this._mesh);
    }

    /** Uniform groups and texture slots, by shader resource name. */
    get resources(): Record<string, any> {
        return this._mesh.shader!.resources;
    }

    setTexture(name: string, source: TextureSource): void {
        this.resources[name] = source;
    }

    /** Room for `count` lights, as the array to pack them into. */
    reserve(count: number): Float32Array {
        const need = count * LIGHT_FLOATS;
        if (need > this._data.length) {
            let length = this._data.length;
            while (length < need) length *= 2;
            this._data = new Float32Array(length);
            // Pixi reallocates the GPU buffer on the next bind; the VAO keeps
            // pointing at the same WebGLBuffer, so it stays valid.
            this._instances.data = this._data;
        }
        return this._data;
    }

    /** Draw the first `count` packed lights into `target`, which is cleared first. */
    run(renderer: Renderer, target: RenderTexture, count: number): void {
        this._geometry.instanceCount = count;
        if (count > 0) this._instances.update(count * LIGHT_FLOATS * 4);
        renderer.render({ container: this._root, target, clear: true, clearColor: [0, 0, 0, 0] });
    }

    destroy(): void {
        this._root.destroy({ children: true });
        this._instances.destroy();
    }
}
