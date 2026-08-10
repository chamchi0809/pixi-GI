import { Geometry, State } from 'pixi.js';
import type { BLEND_MODES, Renderer, RenderTexture, Shader, TextureSource } from 'pixi.js';
import { setTexture } from 'pixi-psl';

/**
 * A fullscreen shader pass, drawn as a unit quad straight into a render target.
 *
 * The obvious way to write this is a `Mesh` in a `Container` handed to
 * `renderer.render`, and that is what it used to be. But a cascade frame issues
 * some seventy of these, and the scene-graph path charges every one of them for
 * machinery a fullscreen quad has no use for: a render group to walk, transforms
 * to revalidate, an instruction set to rebuild whenever the quad is rescaled to
 * its target, batcher start/finish, and the prerender and postrender runners
 * over every system in the renderer. Measured, it came to ~3.5us of CPU per pass
 * against ~6us of GPU -- close enough to starve the GPU between passes.
 *
 * So the passes take the same route Pixi's own filters do: bind the target, draw
 * the quad through the encoder. That is the whole of it. It costs the two things
 * the scene graph was providing -- see `fullscreen` in `shaders.ts` for the
 * transform, and {@link Pass.run} for the WebGPU command encoder.
 */
export class Pass {
    readonly shader: Shader;
    /** Blend and depth state, fixed at construction; nothing per draw touches it. */
    private readonly _state = State.for2d();

    constructor(shader: Shader, blendMode?: BLEND_MODES) {
        this.shader = shader;
        if (blendMode) this._state.blendMode = blendMode;
    }

    /** Uniform groups and texture slots, by shader resource name. */
    get resources(): Record<string, any> {
        return this.shader.resources;
    }

    /** Sampler included -- WebGPU binds one per texture, WebGL ignores it. */
    setTexture(name: string, source: TextureSource): void {
        setTexture(this.shader, name, source);
    }

    /**
     * `clear: false` accumulates into whatever is already there -- for the additive passes.
     *
     * The encoder calls are WebGPU's, and are absent on the WebGL one. WebGPU
     * records into a command encoder that Pixi opens when a render begins and
     * submits when it ends, so a draw outside `renderer.render` -- which is
     * exactly where the cascades live -- would record into nothing.
     *
     * A pass gets a command buffer to itself, and it has to: the stages reuse one
     * shader across every cascade and rewrite its uniforms between draws, and
     * `queue.writeBuffer` orders against the *submit*, not against the draw it was
     * meant for. Batch the passes into one buffer and all of them read whatever
     * the last one wrote. This is what `renderer.render` was doing per pass too,
     * so it is no more work than before -- the saving is everything above it.
     */
    run(renderer: Renderer, target: RenderTexture, clear = true): void {
        const encoder = (renderer as Encoding).encoder;

        encoder.renderStart?.();
        renderer.renderTarget.bind(target, clear, CLEAR);
        encoder.draw({
            geometry: QUAD,
            shader: this.shader,
            state: this._state,
            topology: 'triangle-list',
        });
        encoder.postrender?.();
    }

    destroy(): void {
        this.shader.destroy(true);
    }
}

/** Every pass draws this same quad; nothing about it depends on the target. */
const QUAD = new Geometry({
    attributes: { aPosition: [0, 0, 1, 0, 1, 1, 0, 1] },
    indexBuffer: [0, 1, 2, 0, 2, 3],
});

const CLEAR: [number, number, number, number] = [0, 0, 0, 0];

/** The slice of the renderer's encoder this leans on; Pixi does not type it on `Renderer`. */
interface Encoding {
    encoder: {
        draw(options: { geometry: Geometry; shader: Shader; state: State; topology: string }): void;
        /** WebGPU only. */
        renderStart?(): void;
        /** WebGPU only. */
        postrender?(): void;
    };
}
