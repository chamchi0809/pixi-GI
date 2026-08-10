/**
 * The whole holographic-radiance-cascade pipeline, written once in PSL and
 * compiled to GLSL 300 es and WGSL together, so WebGL and WebGPU run the same
 * program rather than two that have to be kept in step by hand.
 *
 * Conventions shared by every pass:
 *  - `uv` is 0..1 across the render target, matching PixiJS' own sprite UV
 *    orientation, so reading and writing at the same `uv` is an identity copy.
 *  - "GI pixel space" is the coordinate system of the emissive / occlusion
 *    buffers: a square `uExtent x uExtent` image of the world scaled by
 *    `RadianceCascadesOptions.resolution`, covering the view plus
 *    `RadianceCascadesOptions.margin` of world on every side.
 *  - Every cascade buffer is *right-facing*: planes run along x, rays travel
 *    towards +x. The four 90-degree frustums are the same passes over the same
 *    layout with the scene rotated underneath, which {@link frustum} does.
 *  - A ray is stored as `vec4(radiance, transmittance)` -- the light it picked
 *    up along its length, and what is left of anything arriving behind it. One
 *    channel of transmittance rather than three, matching the library's
 *    single-channel occlusion.
 *  - Every fragment writes alpha, so blending must be off. The one exception is
 *    the resolve pass, which is additive and *depends* on alpha accumulating with
 *    it -- that is where the free-space mask comes from. Do not add a plain alpha
 *    blend to any of these passes, and do not let the resolve's `add` degrade to
 *    `add-npm`, which would multiply its rgb by that mask a second time.
 */
import { PslProgram, position, uv } from 'pixi-psl';
import type { PslNode, PslTexture } from 'pixi-psl';
import {
    If,
    Loop,
    atan,
    ceil,
    dot,
    exp2,
    float,
    floor,
    length,
    log2,
    max,
    mix,
    mod,
    normalize,
    select,
    step,
    vec2,
    vec3,
    vec4,
    ySign,
} from 'pixi-psl';
import type { Shader } from 'pixi.js';

const f32 = (n: number): Float32Array => new Float32Array(n);

/**
 * The vertex stage the four internal passes share: a unit quad, straight to clip
 * space, with no matrices in it at all.
 *
 * PSL's default quad goes through Pixi's projection and the mesh's own
 * transform, which is what something living in the scene graph wants -- the
 * composite does, and keeps it. A pass that always covers its whole render
 * target gets nothing out of it but two uniform blocks for Pixi to fill and a
 * transform to revalidate every time the quad is rescaled to a new target. A
 * pass always covers its whole target, which projects 0..size onto -1..1, so the
 * whole chain collapses to a doubling -- and with it goes the reason a pass had
 * to be a `Mesh` inside a `Container` at all. See {@link Pass}.
 *
 * All of it except which way y runs, which the two backends disagree about and
 * Pixi hides inside that projection; `ySign` is that difference, and skipping it
 * costs you a vertically mirrored image on one backend only.
 */
const fullscreen = (): PslNode => {
    uv.assign(position);
    return vec4(position.mul(2).sub(1).mul(vec2(1, ySign)), 0, 1);
};

/// Fluence -> mean incoming radiance. See {@link resolveShader} for why it is pi, not 2pi.
export const FLUENCE_NORM = 1 / Math.PI;

/**
 * Cascade memory <-> scene, for the frustum in `uFrustum`.
 *
 *  0: +x, the identity.   1: +y, transposed.
 *  2: -x, mirrored.       3: -y, transposed the other way.
 *
 * Each is its own inverse, so the same call serves the seed (memory -> scene)
 * and the resolve (scene -> memory). Texel centres map to texel centres, which
 * is what lets the seed sample the scene without any filtering error.
 */
function frustum(u: { uExtent: PslNode; uFrustum: PslNode }, p: PslNode): PslNode {
    const r = mix(p, p.yx, mod(u.uFrustum, 2));
    return mix(r, u.uExtent.sub(r), step(0.5, mod(u.uFrustum, 3)));
}

/**
 * One ray out of a cascade's buffer. Rays outside the buffer read as "nothing
 * here, nothing blocked", so the hierarchy simply runs out at the edges instead
 * of needing a bounds test at every call site.
 *
 * `base` is the plane the ray belongs to and `stride` how many texels a plane
 * occupies -- `interval + 1` for a ray buffer. A cone buffer holds one texel per
 * cone with no plane spacing of its own, so it passes the probe's texel column
 * as `base` and omits the stride. Every caller already knows the plane it is
 * after; recovering it here from the probe's x cost a divide and a floor per
 * call, and a merge fragment makes up to eight of them.
 *
 * `invSize` is 1/size, so normalising is a multiply rather than two more
 * divides. Every lookup lands on a texel centre, half a texel clear of either
 * bound -- four orders of magnitude more slack than a reciprocal's rounding --
 * so the bounds test below is nowhere near the edge of flipping.
 */
function fetch(
    tex: PslTexture,
    invSize: PslNode,
    base: PslNode,
    y: PslNode,
    index: PslNode,
    stride?: PslNode,
): PslNode {
    const column = stride ? base.mul(stride).add(index) : base.add(index);
    const p = vec2(column.add(0.5), y).mul(invSize);
    return select(floor(p).equal(vec2(0, 0)), tex.sample(p), vec4(0, 0, 0, 1));
}

/** Front-to-back chaining of two rays. */
function join(near: PslNode, far: PslNode): PslNode {
    return vec4(near.rgb.add(far.rgb.mul(near.a)), near.a.mul(far.a));
}

/**
 * Cascade 0's rays, straight off the scene. Their interval is one pixel, so both
 * rays of a probe begin and end on the probe's own texel and neither needs
 * tracing -- read the emission and the transmittance there and be done. This is
 * the *only* pass that touches the scene; everything above it is ray extension,
 * which is what makes the hierarchy cost `log2(extent)` samples per ray.
 *
 * Emission is radiance per pixel of travel, not a surface radiance, so a pixel
 * that emits without occluding still lights the room -- unlike a strict
 * volumetric model, where an emitter has to absorb to be visible.
 */
export function seedShader(): Shader {
    const p = new PslProgram('gi-seed');
    const emissive = p.texture('uEmissive');
    const occlusion = p.texture('uOcclusion');
    const u = p.uniforms('seedUniforms', {
        uTexSize: { type: 'vec2', value: f32(2) },
        uExtent: { type: 'float', value: 1 },
        uFrustum: { type: 'float', value: 0 },
        uEmissiveScale: { type: 'float', value: 1 },
    });

    return p.build({
        vertex: fullscreen,
        fragment: () => {
            const texel = uv.mul(u.uTexSize);
            // Two texels per plane, one per ray, holding the same thing.
            const plane = floor(texel.x.mul(0.5));
            const scene = frustum(u, vec2(plane.add(0.5), texel.y)).div(u.uExtent);
            return vec4(
                emissive.sample(scene).rgb.mul(u.uEmissiveScale),
                float(1).sub(occlusion.sample(scene).a),
            );
        },
    });
}

/**
 * Ray extension: build cascade `n`'s rays out of cascade `n-1`'s, four child
 * rays per parent, instead of tracing them.
 *
 * A parent ray spans two child planes. Take the child rays either side of the
 * parent's direction, chain the left one into the right one and the right one
 * into the left, and average: two chains that cross and converge back on the
 * parent direction. Even ray indices land exactly on a child direction, both
 * chains are identical and the average is a no-op.
 *
 * The averaging is angular diffusion, and it is why extensions start here at
 * cascade 1 rather than at cascade 3 as the paper has it: more diffusion, and a
 * moving light stops crawling.
 */
export function extendShader(): Shader {
    const p = new PslProgram('gi-extend');
    const prev = p.texture('uPrev');
    const u = p.uniforms('extendUniforms', {
        /// 1 / the child cascade's buffer size; see {@link fetch}.
        uPrevInv: { type: 'vec2', value: f32(2) },
        uTexSize: { type: 'vec2', value: f32(2) },
        /// 2^n for the cascade being written. Its children are half this long.
        uInterval: { type: 'float', value: 1 },
    });

    /**
     * `child` is the first of the two child planes the parent spans and `y` the
     * parent probe's row. The near half is read on that plane, the far half one
     * plane on, at the row the ray has climbed to by then.
     */
    const extend = (child: PslNode, y: PslNode, lo: PslNode, hi: PslNode, half: PslNode, stride: PslNode): PslNode =>
        join(
            fetch(prev, u.uPrevInv, child, y, lo, stride),
            fetch(prev, u.uPrevInv, child.add(1), y.add(half.negate().add(lo.mul(2))), hi, stride),
        );

    return p.build({
        vertex: fullscreen,
        fragment: () => {
            const texel = uv.mul(u.uTexSize);
            const rays = u.uInterval.add(1);
            const plane = floor(texel.x.div(rays));
            const index = floor(texel.x.sub(plane.mul(rays)));

            const half = u.uInterval.mul(0.5).toVar();
            const stride = half.add(1);
            // Child planes sit half as far apart, so plane p spans 2p and 2p + 1.
            const child = plane.mul(2).toVar();
            const lower = floor(index.mul(0.5)).toVar();
            const upper = ceil(index.mul(0.5)).toVar();
            return mix(
                extend(child, texel.y, lower, upper, half, stride),
                extend(child, texel.y, upper, lower, half, stride),
                0.5,
            );
        },
    });
}

/**
 * Merge cascade `n`'s rays into its cones, against the cones of cascade `n+1`.
 *
 * A cascade with `2^n + 1` rays has `2^n` angular spans between them, and it is
 * those -- the cones -- that carry fluence. Each cone is its two bounding rays,
 * every ray merged with the cascade-above cone that starts where it ends.
 *
 * Because probes are planes, a ray carries rectangular radiance, so it has to be
 * weighted by half the angular span of the cone it lands in before merging. That
 * is `wedge`, and it is the whole reason this looks nothing like a vanilla RC
 * merge.
 *
 * Odd planes land exactly on a plane of the cascade above. Even ones fall half
 * an interval short of it, so their rays reach twice as far, merge against the
 * far plane, and the result is averaged with the merge at the near plane --
 * fluence interpolated *after* merging. Interpolating position instead, or
 * before, breaks the volumetrics outright.
 */
export function mergeShader(): Shader {
    const p = new PslProgram('gi-merge');
    /// This cascade's rays.
    const rays = p.texture('uRays');
    /// Cascade n+1's cones. Bind a 1x1 texture with uConesSize = (1,1) at the top
    /// of the hierarchy: every lookup then falls outside it and reads as empty.
    const cones = p.texture('uCones');
    const u = p.uniforms('mergeUniforms', {
        /// 1 / this cascade's ray buffer size, and 1 / the cone buffer's; see {@link fetch}.
        uRaysInv: { type: 'vec2', value: f32(2) },
        uConesInv: { type: 'vec2', value: f32(2) },
        uTexSize: { type: 'vec2', value: f32(2) },
        uInterval: { type: 'float', value: 1 },
        /// 1 / uInterval. A power of two, so multiplying by it is exact.
        uInvInterval: { type: 'float', value: 1 },
    });

    /**
     * One bounding ray of cone "index", merged into the cone above it. `column`
     * is the probe's texel column in a cone buffer -- `plane * uInterval`.
     */
    const edge = (plane: PslNode, y: PslNode, column: PslNode, index: PslNode, side: number): PslNode => {
        const cone = index.mul(2).add(side).toVar();
        const ray = index.add(side).toVar();
        const stride = u.uInterval.add(1);
        const align = float(2).sub(mod(plane, 2)).toVar();
        /// Rows the ray climbs over one interval of travel.
        const rise = u.uInterval.negate().add(ray.mul(2)).toVar();

        /**
         * Half the cone's angular span. Its two bounding directions share an x,
         * so the difference of their arctangents collapses by the tangent
         * subtraction identity to a single `atan(I / (I^2 + k(k + 1)))`, where k
         * is the cone counted from straight ahead. k is a whole number, so
         * `k(k + 1)` is never negative and the denominator never drops below
         * I^2 -- the argument stays small and positive for every cone of every
         * cascade, off the quadrant boundaries that make `atan2` the dearer
         * call. Two of those per edge become one `atan`, and the cancellation of
         * subtracting angles that agreed to three digits goes with them, so the
         * weight lands more accurate than it was.
         */
        const off = cone.sub(u.uInterval).toVar();
        const wedge = atan(u.uInterval.div(u.uInterval.mul(u.uInterval).add(off.mul(off.add(1)))))
            .mul(0.5)
            .toVar();

        const r = fetch(rays, u.uRaysInv, plane, y, ray, stride).toVar();
        const far = fetch(
            cones,
            u.uConesInv,
            column.add(u.uInterval.mul(align)),
            y.add(rise.mul(align)),
            cone,
        ).rgb.toVar();

        const out = vec3(0).toVar();
        If(align.lessThan(1.5), () => {
            out.assign(r.rgb.mul(wedge).add(far.mul(r.a)));
        }).Else(() => {
            const chained = join(r, fetch(rays, u.uRaysInv, plane.add(1), y.add(rise), ray, stride)).toVar();
            const near = fetch(cones, u.uConesInv, column, y, cone).rgb;
            out.assign(mix(chained.rgb.mul(wedge).add(far.mul(chained.a)), near, 0.5));
        });
        return out;
    };

    return p.build({
        vertex: fullscreen,
        fragment: () => {
            const texel = uv.mul(u.uTexSize);
            const plane = floor(texel.x.mul(u.uInvInterval)).toVar();
            const index = floor(texel.x.sub(plane.mul(u.uInterval))).toVar();
            const column = plane.mul(u.uInterval).toVar();

            // Plane 0's rays would have to come from outside the buffer. The resolve
            // pass reads one texel further in, so nothing ever looks here.
            const out = vec4(0).toVar();
            If(plane.greaterThanEqual(1), () => {
                out.assign(
                    vec4(edge(plane, texel.y, column, index, 0).add(edge(plane, texel.y, column, index, 1)), 1),
                );
            });
            return out;
        },
    });
}

/**
 * One frustum's cascade-0 cones, un-rotated into the scene and added to the
 * fluence buffer. Run additively, once per frustum.
 *
 * Read one texel along the frustum's own direction: consecutive frustums share
 * the ray on the boundary between them, and sampling at the pixel itself would
 * count it twice.
 *
 * `uNorm` turns fluence into mean incoming radiance, so `strength: 1` means
 * "as bright as the light actually arriving". The merge weights sum to pi rather
 * than the full 2pi of directions -- each ray carries half of its cone's span
 * and the two halves belong to different cones -- so that, not 2pi, is the
 * divisor.
 *
 * Alpha carries free space and rgb is premultiplied by it, so the fluence buffer
 * is a *masked* field: mip-averaging it averages only the pixels light could
 * actually reach, which is what lets the composite dilate it into the occluders.
 * See {@link compositeShader}. A quarter of the mask each, so the four frustums
 * sum to it rather than to four times it.
 */
export function resolveShader(): Shader {
    const p = new PslProgram('gi-resolve');
    const cones = p.texture('uCones');
    const occlusion = p.texture('uOcclusion');
    const u = p.uniforms('resolveUniforms', {
        uExtent: { type: 'float', value: 1 },
        uFrustum: { type: 'float', value: 0 },
        uNorm: { type: 'float', value: FLUENCE_NORM },
    });

    return p.build({
        vertex: fullscreen,
        fragment: () => {
            const q = frustum(u, uv.mul(u.uExtent)).add(vec2(1, 0));
            const mask = float(1).sub(occlusion.sample(uv).a).toVar();
            return vec4(cones.sample(q.div(u.uExtent)).rgb.mul(u.uNorm.mul(mask)), mask.mul(0.25));
        },
    });
}

/** Rec. 709 luma, for the gradient the occluder shading follows. */
const LUMA = vec3(0.2126, 0.7152, 0.0722);

/**
 * Shade the albedo with the resolved fluence. Rendered straight into the scene
 * graph, so it also does exposure + tone map.
 *
 * Occluding pixels are the awkward case: the cascades simulate light travelling
 * *in the plane*, so an occluder sits permanently inside its own shadow and its
 * visible face resolves to black. Rather than shade it from a second, non-RC
 * light model, this reuses the cascades' own answer and simply fetches it from
 * where light exists -- see `dilate` below.
 *
 * `ambient` and `occluderAmbient` are bound live: the caller keeps writing into
 * those arrays and every bind re-uploads them.
 */
export function compositeShader(ambient: Float32Array, occluderAmbient: Float32Array): Shader {
    const p = new PslProgram('gi-composite');
    const albedoTex = p.texture('uAlbedo');
    const emissiveTex = p.texture('uEmissive');
    const occlusionTex = p.texture('uOcclusion');
    const normalTex = p.texture('uNormal');
    const fluence = p.texture('uFluence');
    /**
     * The same emission and occlusion, drawn at albedo resolution with the albedo's
     * own camera. Everything else the composite reads is light, which is allowed to
     * be soft, but these two are *the objects themselves* -- an emitter's own glow
     * and the mask that says which pixels get occluder shading -- so taking them
     * from the lighting buffers would show the resolution option as blocky emitters
     * and stair-stepped occluder edges. Only bound below 1:1; see uUpscale.
     */
    const emissiveHi = p.texture('uEmissiveHi');
    const occlusionHi = p.texture('uOcclusionHi');

    const u = p.uniforms('compositeUniforms', {
        /// 1 when the hi-res pair above is live, 0 when the lighting already runs at 1:1.
        uUpscale: { type: 'float', value: 0 },
        uSceneSize: { type: 'vec2', value: f32(2) },
        /// The screen, in GI pixels. Smaller than uSceneSize, which the margin pads.
        uViewSize: { type: 'vec2', value: f32(2) },
        /**
         * GI pixels the lighting buffers are offset from the albedo: they are
         * rasterised snapped to whole texels, so that an emitter's footprint stays
         * put in the world as the camera moves, while the albedo uses the exact
         * camera. Every lookup into a lighting buffer is shifted by this to land on
         * the world point this fragment shows.
         */
        uGiOffset: { type: 'vec2', value: f32(2) },
        /// Where the view starts inside the buffers -- the off-view world the rays also see.
        uMargin: { type: 'vec2', value: f32(2) },
        uStrength: { type: 'float', value: 1 },
        uExposure: { type: 'float', value: 1 },
        uEmissiveScale: { type: 'float', value: 1 },
        uEmissiveBoost: { type: 'float', value: 1 },
        uToneMap: { type: 'float', value: 1 },
        uAmbient: { type: 'vec3', value: ambient },
        uOccluderAmbient: { type: 'vec3', value: occluderAmbient },
        uLightStrength: { type: 'float', value: 1 },
        /// Coarsest fluence mip the occluder light may reach for -- occluderLightRange.
        uLightLod: { type: 'float', value: 1 },
        uLightHeight: { type: 'float', value: 1 },
    });

    /**
     * Undo the resolve pass' mask premultiply: the mean radiance of the *free*
     * space in this tap, with the blocked part contributing nothing rather than
     * black.
     */
    const unmask = (s: PslNode): PslNode => s.rgb.div(max(s.a, 1e-4));

    /**
     * One level of the chain, filtered wider than the hardware would.
     *
     * A mip tap is a box average locked to that level's grid, and bilinear between
     * boxes is not a smooth enough reconstruction to hide the grid: the world scrolls
     * under a fixed mip lattice, so a light crossing a boundary empties one box into
     * the next, and every pixel reading those boxes blinks in step. Four bilinear taps
     * at the corners of the level's own texel is a box of boxes -- quadratic rather
     * than linear, so the seams flatten out and the reconstruction is near enough
     * translation-invariant that camera motion stops showing.
     */
    const tap = (at: PslNode, l: PslNode): PslNode => {
        const d = exp2(l).mul(0.5).div(u.uSceneSize).toVar();
        const flip = vec2(d.x, d.y.negate()).toVar();
        return fluence
            .sampleLod(at.add(d), l)
            .add(fluence.sampleLod(at.sub(d), l))
            .add(fluence.sampleLod(at.add(flip), l))
            .add(fluence.sampleLod(at.sub(flip), l))
            .mul(0.25);
    };

    /// Still mask-premultiplied: only ratios of it are ever used, and not dividing
    /// per tap is what keeps the gradient free of the pinch unmask can produce.
    const lodLuma = (at: PslNode, lod: PslNode): PslNode => dot(tap(at, lod).rgb, LUMA);

    /**
     * The occluder surface light, taken straight out of the fluence buffer.
     *
     * Because the resolve pass premultiplied fluence by free space and kept that mask
     * in alpha, mip level l holds the light within a 2^l footprint already weighted by
     * how much of that footprint light could reach. So summing levels and dividing the
     * totals *once* is the mean radiance of whatever free space is in reach, with
     * blocked pixels contributing nothing rather than black.
     *
     * Every level is summed, weighted towards the finest: a rim pixel is dominated by
     * level 1 and keeps a crisp contact edge, while deep inside a wall the fine levels
     * are empty, add nothing to either total, and the coarse ones take over on their
     * own. Nothing anywhere picks *a* level, and that is the point -- a per-pixel
     * choice of mip facets the surface along every boundary where the choice flips,
     * and dividing per level pinches wherever that level's coverage is near zero.
     * Both artefacts are of the reconstruction, not of the light.
     *
     * Everything the cascades did comes along -- shadowing, colour, bounce, and the
     * correct 2D distance falloff, since that is already baked into the field being
     * averaged. `scale` comes back as the coverage-weighted mean footprint: how far
     * off the light that reached this pixel was found.
     */
    const dilate = (at: PslNode): { light: PslNode; scale: PslNode } => {
        const light = vec3(0).toVar();
        const cover = float(0).toVar();
        const span = float(0).toVar();
        const w = float(1).toVar();
        Loop({ start: 1, end: u.uLightLod }, (l) => {
            const s = tap(at, l).toVar();
            light.assign(light.add(s.rgb.mul(w)));
            cover.assign(cover.add(s.a.mul(w)));
            span.assign(span.add(s.a.mul(w).mul(exp2(l))));
            // Halving per level: fine detail wins wherever it exists, and the coarse
            // levels are left as the broad fill under it. Raise it for softer, flatter
            // occluders, lower it for crisper contact light.
            w.assign(w.mul(0.5));
        });
        const total = max(cover, 1e-4).toVar();
        return { light: light.div(total).toVar(), scale: span.div(total).toVar() };
    };

    return p.build(() => {
        // Where this fragment's world point sits in the lighting buffers.
        const giUV = uv.mul(u.uViewSize).add(u.uGiOffset).add(u.uMargin).div(u.uSceneSize).toVar();

        // Explicit lod 0: the buffer is mipmapped for the occluder light below, and
        // nothing here should ever be allowed to slide into a coarser level.
        const irradiance = unmask(fluence.sampleLod(giUV, 0));
        const albedo = albedoTex.sample(uv);
        const hi = u.uUpscale.greaterThan(0.5);
        const emissive = select(hi, emissiveHi.sample(uv).rgb, emissiveTex.sample(giUV).rgb)
            .mul(u.uEmissiveScale)
            .mul(u.uEmissiveBoost);

        // Occluding pixels get the dilated light instead of the cascades directly,
        // in proportion to how much they occlude, so a half-transparent caster gets
        // half of each.
        const occ = select(hi, occlusionHi.sample(uv).a, occlusionTex.sample(giUV).a).toVar();
        const surface = u.uOccluderAmbient.toVar();
        If(occ.greaterThan(0.002).and(u.uLightStrength.greaterThan(0)), () => {
            const { light, scale } = dilate(giUV);
            const lit = light.toVar();

            // Clear colour is (0,0,0,0), whose alpha says "no normal here".
            const nTex = normalTex.sample(giUV).toVar();
            If(nTex.a.greaterThan(0), () => {
                // Fluence is directionless, but the *gradient* of the dilated field
                // points at where the light is, and scale is how far off it was
                // found -- enough of a light vector to shade relief with. Read at the
                // level that footprint belongs to, so the gradient is as smooth as the
                // light it came from.
                const lod = log2(max(scale, 2)).toVar();
                const d = scale.div(u.uSceneSize).toVar();
                const g = vec2(
                    lodLuma(giUV.add(vec2(d.x, 0)), lod).sub(lodLuma(giUV.sub(vec2(d.x, 0)), lod)),
                    lodLuma(giUV.add(vec2(0, d.y)), lod).sub(lodLuma(giUV.sub(vec2(0, d.y)), lod)),
                ).toVar();
                const len = length(g).toVar();
                const dir = normalize(
                    vec3(select(len.greaterThan(1e-8), g.mul(scale.div(len)), vec2(0, 0)), u.uLightHeight),
                );
                const n = normalize(
                    vec3(nTex.r.mul(2).sub(1), float(1).sub(nTex.g.mul(2)), nTex.b.mul(2).sub(1)),
                );
                // Wrap (half-Lambert) shading. A normalMap describes painted relief
                // on a flat sprite, not real geometry, so it should add shape without
                // making the surface darker on average than an un-mapped one -- and
                // plain N.L would, since the light is nearly in the surface plane.
                lit.assign(lit.mul(mix(float(1), dot(n, dir).mul(0.5).add(0.5), nTex.a)));
            });
            surface.assign(surface.add(lit.mul(u.uLightStrength)));
        });
        const ambientTerm = mix(u.uAmbient, surface, occ);

        const color = albedo.rgb
            .mul(irradiance.mul(u.uStrength).add(ambientTerm))
            .add(emissive)
            .mul(u.uExposure)
            .toVar();
        If(u.uToneMap.greaterThan(0.5), () => {
            color.assign(color.div(float(1).add(color)));
        });
        return vec4(color, albedo.a);
    });
}
