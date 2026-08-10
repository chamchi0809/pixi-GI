/**
 * Backend parity fixes for PixiJS' WebGPU renderer.
 *
 * PSL's promise is that one shader source produces one picture. Compiling to both
 * languages is most of that, but not all of it: two bugs in Pixi 8.19's WebGPU
 * backend make correctly translated shaders render differently, or not at all, and
 * neither is anything a shader author can work around. Both live in the one call
 * that builds a pipeline's colour targets, so both are fixed in the same place.
 *
 * Call it once per renderer, before rendering:
 *
 *     patchRenderer(app.renderer);
 *
 * It is a no-op on WebGL.
 */
import type { Renderer, WebGPURenderer } from 'pixi.js';

/**
 * **1. The pipeline's colour format is hardcoded.** `GpuStateSystem.getColorTargets`
 * returns `format: 'bgra8unorm'` no matter what is bound, and `PipelineSystem`'s
 * cache key does not include the format at all. Draw into a render texture of any
 * other format -- `rgba16float` for anything HDR, `rgba8unorm`, `r8unorm` -- and the
 * pipeline and the pass disagree, WebGPU rejects the command buffer, and the frame
 * is silently black. A validation warning in the console is the only sign. Filters
 * and the usual `RenderTexture.create()` escape it because Pixi's own default *is*
 * `bgra8unorm`. The fix reports the bound target's format and adds it to the
 * pipeline cache key so pipelines for two formats cannot collide; both read it live
 * from `renderer.renderTarget`, which Pixi assigns before it starts the pass -- and
 * `setRenderTarget` calls `_updatePipeHash` on every switch, so the cache follows
 * along on its own.
 *
 * **2. `add` does not blend alpha the way WebGL does.** WebGL maps it to
 * `blendFunc(ONE, ONE)`, which covers alpha as well, while WebGPU is handed
 * `src-alpha`/`one-minus-src-alpha` for the alpha channel -- so `srcA + dstA` on one
 * backend and `srcA*srcA + dstA*(1 - srcA)` on the other. RGB is identical, and
 * `add-npm` already has the right factors, which is what marks this as a slip rather
 * than a decision. It stays invisible as long as nothing reads the destination
 * alpha, which is why additive glow on an opaque target looks fine either way. It
 * becomes visible the moment the alpha is used: accumulate additively into a render
 * texture and WebGPU's alpha comes out far lower, so the texture composites too
 * transparent, or -- if the consumer un-premultiplies by dividing -- far too bright.
 *
 * ponytail: patched per renderer instance rather than on the prototypes, so it
 * cannot leak into a renderer that did not ask for it. Delete this file once Pixi
 * keys pipelines by format and matches its own WebGL blend.
 */
export function patchRenderer(renderer: Renderer): void {
    const gpu = renderer as WebGPURenderer;
    // WebGL has no pipeline objects, and only the first call has anything to do.
    if (!gpu.pipeline || (gpu as PatchFlag)[PATCHED]) return;
    (gpu as PatchFlag)[PATCHED] = true;

    const pipeline = gpu.pipeline as unknown as PipelineInternals;
    const state = gpu.state as unknown as StateInternals;
    const getColorTargets = state.getColorTargets.bind(state);
    // Nothing is bound yet during the initial context change.
    const format = (): string => gpu.renderTarget?.renderTarget?.colorTexture.format ?? 'bgra8unorm';

    pipeline._updatePipeHash = (): void => {
        const key = [
            pipeline._stencilMode,
            pipeline._multisampleCount,
            pipeline._colorMask,
            pipeline._depthStencilAttachment,
            pipeline._colorTargetCount,
            format(),
        ].join('|');
        pipeline._pipeStateCaches[key] ??= Object.create(null) as Record<string, unknown>;
        pipeline._pipeCache = pipeline._pipeStateCaches[key];
    };

    state.getColorTargets = (drawState, count) => {
        // Copies, not edits: the descriptors Pixi returns are shared module-level
        // objects, and writing through them would change every other renderer too.
        // Only called on a pipeline cache miss, so the allocation is not on any path
        // that runs per draw.
        return getColorTargets(drawState, count).map((target) => ({
            ...target,
            // ponytail: one format for every attachment. MRT with mixed formats would
            // need the format list threaded through, and Pixi does not expose one.
            format: format(),
            blend:
                drawState.blendMode === 'add'
                    ? { ...target.blend, alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' } }
                    : target.blend,
        }));
    };
}

const PATCHED = Symbol.for('pixi-psl.rendererPatched');
type PatchFlag = { [PATCHED]?: boolean };

/** The private surface of Pixi's PipelineSystem this leans on. */
interface PipelineInternals {
    _updatePipeHash(): void;
    _stencilMode: number;
    _multisampleCount: number;
    _colorMask: number;
    _depthStencilAttachment: number;
    _colorTargetCount: number;
    _pipeCache: Record<string, unknown>;
    _pipeStateCaches: Record<string, Record<string, unknown>>;
}

interface StateInternals {
    getColorTargets(
        state: { blendMode: string },
        count: number,
    ): { format: string; blend: { alpha: unknown } }[];
}
