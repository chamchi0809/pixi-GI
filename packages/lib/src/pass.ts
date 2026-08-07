import { Container, Geometry, Mesh, Shader } from 'pixi.js';
import type { BLEND_MODES, Renderer, RenderTexture, TextureSource } from 'pixi.js';
import { VERTEX } from './shaders';

/** A fullscreen shader pass, drawn as a unit quad scaled to the target. */
export class Pass {
    readonly mesh: Mesh<Geometry, Shader>;
    /**
     * A Mesh is only given its `groupBlendMode` as somebody's *child*; as the
     * root of a `renderer.render` call it would silently stay `normal`.
     */
    private readonly _root = new Container();

    constructor(name: string, fragment: string, resources: Record<string, unknown>, blendMode?: BLEND_MODES) {
        const shader = Shader.from({
            gl: { vertex: VERTEX, fragment, name },
            resources,
        });
        const geometry = new Geometry({
            attributes: { aPosition: [0, 0, 1, 0, 1, 1, 0, 1] },
            indexBuffer: [0, 1, 2, 0, 2, 3],
        });
        this.mesh = new Mesh<Geometry, Shader>({ geometry, shader });
        if (blendMode) this.mesh.blendMode = blendMode;
        this._root.addChild(this.mesh);
    }

    /** Uniform groups and texture slots, by shader resource name. */
    get resources(): Record<string, any> {
        return this.mesh.shader!.resources;
    }

    setTexture(name: string, source: TextureSource): void {
        this.resources[name] = source;
    }

    /** `clear: false` accumulates into whatever is already there -- for the additive passes. */
    run(renderer: Renderer, target: RenderTexture, clear = true): void {
        this.mesh.scale.set(target.width, target.height);
        renderer.render({ container: this._root, target, clear, clearColor: [0, 0, 0, 0] });
    }

    destroy(): void {
        this._root.destroy({ children: true });
    }
}
