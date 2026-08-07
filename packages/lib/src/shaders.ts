/**
 * All GLSL for the holographic-radiance-cascade pipeline.
 *
 * Conventions shared by every pass:
 *  - `vUV` is 0..1 across the render target, matching PixiJS' own sprite UV
 *    orientation, so reading and writing at the same `vUV` is an identity copy.
 *  - "GI pixel space" is the coordinate system of the emissive / occlusion
 *    buffers: a square `uExtent x uExtent` image of the world scaled by
 *    `RadianceCascadesOptions.resolution`, covering the view plus
 *    `RadianceCascadesOptions.margin` of world on every side.
 *  - Every cascade buffer is *right-facing*: planes run along x, rays travel
 *    towards +x. The four 90-degree frustums are the same passes over the same
 *    layout with the scene rotated underneath, which {@link FRUSTUM} does.
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

/** Shared fullscreen-quad vertex shader. `aPosition` is a unit quad; the mesh is scaled to the target. */
export const VERTEX = /* glsl */ `#version 300 es
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
 * Cascade memory <-> scene, for the frustum in `uFrustum`.
 *
 *  0: +x, the identity.   1: +y, transposed.
 *  2: -x, mirrored.       3: -y, transposed the other way.
 *
 * Each is its own inverse, so the same call serves the seed (memory -> scene)
 * and the resolve (scene -> memory). Texel centres map to texel centres, which
 * is what lets the seed sample the scene without any filtering error.
 */
const FRUSTUM = /* glsl */ `
uniform float uExtent;
uniform float uFrustum;

vec2 frustum(vec2 p) {
    vec2 r = mix(p, p.yx, mod(uFrustum, 2.0));
    return mix(r, uExtent - r, step(0.5, mod(uFrustum, 3.0)));
}
`;

/**
 * One ray out of a cascade's buffer, and the front-to-back join that chains two
 * of them. Rays outside the buffer read as "nothing here, nothing blocked", so
 * the hierarchy simply runs out at the edges instead of needing a bounds test
 * at every call site.
 *
 * `stride` is how many texels a plane occupies -- `interval + 1` for a ray
 * buffer, `1` for a cone buffer, whose index is the cone rather than the ray.
 */
const FETCH = /* glsl */ `
vec4 fetch(sampler2D tex, vec2 size, vec2 probe, float index, float interval, float stride) {
    vec2 p = vec2(floor(probe.x / interval) * stride + index + 0.5, probe.y) / size;
    return floor(p) == vec2(0.0) ? texture(tex, p) : vec4(0.0, 0.0, 0.0, 1.0);
}

vec4 join(vec4 near, vec4 far) {
    return vec4(near.rgb + far.rgb * near.a, near.a * far.a);
}
`;

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
export const SEED_FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUV;
out vec4 finalColor;

uniform sampler2D uEmissive;
uniform sampler2D uOcclusion;
uniform vec2 uTexSize;
uniform float uEmissiveScale;
${FRUSTUM}

void main() {
    vec2 texel = vUV * uTexSize;
    // Two texels per plane, one per ray, holding the same thing.
    float plane = floor(texel.x * 0.5);
    vec2 uv = frustum(vec2(plane + 0.5, texel.y)) / uExtent;
    finalColor = vec4(
        texture(uEmissive, uv).rgb * uEmissiveScale,
        1.0 - texture(uOcclusion, uv).a);
}
`;

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
export const EXTEND_FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUV;
out vec4 finalColor;

uniform sampler2D uPrev;
uniform vec2 uPrevSize;
uniform vec2 uTexSize;
/// 2^n for the cascade being written. Its children are half this long.
uniform float uInterval;
${FETCH}

vec4 extend(vec2 probe, float lo, float hi, float interval, float stride) {
    vec2 far = probe + vec2(interval, -interval + lo * 2.0);
    return join(
        fetch(uPrev, uPrevSize, probe, lo, interval, stride),
        fetch(uPrev, uPrevSize, far, hi, interval, stride));
}

void main() {
    vec2 texel = vUV * uTexSize;
    float rays = uInterval + 1.0;
    float plane = floor(texel.x / rays);
    float index = floor(texel.x - plane * rays);
    vec2 probe = vec2(plane * uInterval + 0.5, texel.y);

    float child = uInterval * 0.5;
    float lower = floor(index * 0.5);
    float upper = ceil(index * 0.5);
    finalColor = mix(
        extend(probe, lower, upper, child, child + 1.0),
        extend(probe, upper, lower, child, child + 1.0),
        0.5);
}
`;

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
export const MERGE_FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUV;
out vec4 finalColor;

/// This cascade's rays.
uniform sampler2D uRays;
uniform vec2 uRaysSize;
/// Cascade n+1's cones. Bind a 1x1 texture with uConesSize = (1,1) at the top
/// of the hierarchy: every lookup then falls outside it and reads as empty.
uniform sampler2D uCones;
uniform vec2 uConesSize;
uniform vec2 uTexSize;
uniform float uInterval;
${FETCH}

/** One bounding ray of cone "index", merged into the cone above it. */
vec3 edge(vec2 probe, float plane, float index, float side) {
    float cone = index * 2.0 + side;
    float ray = index + side;
    float stride = uInterval + 1.0;
    float align = 2.0 - mod(plane, 2.0);
    vec2 reach = vec2(uInterval, -uInterval + ray * 2.0);

    vec2 lo = vec2(2.0 * uInterval, -2.0 * uInterval + cone * 2.0);
    vec2 hi = vec2(2.0 * uInterval, -2.0 * uInterval + (cone + 1.0) * 2.0);
    float wedge = 0.5 * (atan(hi.y, hi.x) - atan(lo.y, lo.x));

    vec4 r = fetch(uRays, uRaysSize, probe, ray, uInterval, stride);
    vec3 far = fetch(uCones, uConesSize, probe + align * reach, cone, 1.0, 1.0).rgb;
    if (align < 1.5) return r.rgb * wedge + far * r.a;

    r = join(r, fetch(uRays, uRaysSize, probe + reach, ray, uInterval, stride));
    vec3 near = fetch(uCones, uConesSize, probe, cone, 1.0, 1.0).rgb;
    return mix(r.rgb * wedge + far * r.a, near, 0.5);
}

void main() {
    vec2 texel = vUV * uTexSize;
    float plane = floor(texel.x / uInterval);
    float index = floor(texel.x - plane * uInterval);
    vec2 probe = vec2(plane * uInterval + 0.5, texel.y);

    // Plane 0's rays would have to come from outside the buffer. The resolve
    // pass reads one texel further in, so nothing ever looks here.
    finalColor = plane < 1.0
        ? vec4(0.0)
        : vec4(edge(probe, plane, index, 0.0) + edge(probe, plane, index, 1.0), 1.0);
}
`;

/**
 * One frustum's cascade-0 cones, un-rotated into the scene and added to the
 * fluence buffer. Run additively, once per frustum.
 *
 * Read one texel along the frustum's own direction: consecutive frustums share
 * the ray on the boundary between them, and sampling at the pixel itself would
 * count it twice.
 *
 * `uNorm` turns fluence into mean incoming radiance, so `strength: 1` means
 * "as bright as the light actually arriving". The weights above sum to pi rather
 * than the full 2pi of directions -- each ray carries half of its cone's span
 * and the two halves belong to different cones -- so that, not 2pi, is the
 * divisor.
 *
 * Alpha carries free space and rgb is premultiplied by it, so the fluence buffer
 * is a *masked* field: mip-averaging it averages only the pixels light could
 * actually reach, which is what lets the composite dilate it into the occluders.
 * See {@link COMPOSITE_FRAG}. A quarter of the mask each, so the four frustums
 * sum to it rather than to four times it.
 */
export const RESOLVE_FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUV;
out vec4 finalColor;

uniform sampler2D uCones;
uniform sampler2D uOcclusion;
uniform float uNorm;
${FRUSTUM}

void main() {
    vec2 p = frustum(vUV * uExtent) + vec2(1.0, 0.0);
    float mask = 1.0 - texture(uOcclusion, vUV).a;
    finalColor = vec4(texture(uCones, p / uExtent).rgb * (uNorm * mask), mask * 0.25);
}
`;

/**
 * Shade the albedo with the resolved fluence. Rendered straight into the scene
 * graph, so it also does exposure + tone map.
 *
 * Occluding pixels are the awkward case: the cascades simulate light travelling
 * *in the plane*, so an occluder sits permanently inside its own shadow and its
 * visible face resolves to black. Rather than shade it from a second, non-RC
 * light model, this reuses the cascades' own answer and simply fetches it from
 * where light exists -- see {@link dilate}.
 */
export const COMPOSITE_FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUV;
out vec4 finalColor;

uniform sampler2D uAlbedo;
uniform sampler2D uEmissive;
uniform sampler2D uOcclusion;
uniform sampler2D uNormal;
uniform sampler2D uFluence;

uniform vec2 uSceneSize;
/**
 * GI pixels the lighting buffers are offset from the albedo: they are rasterised
 * snapped to whole texels, so that an emitter's footprint stays put in the world
 * as the camera moves, while the albedo uses the exact camera. Every lookup into
 * a lighting buffer is shifted by this to land on the world point this fragment
 * shows.
 */
uniform vec2 uGiOffset;
/// Where the view starts inside the buffers -- the off-view world the rays also see.
uniform vec2 uMargin;
/// The screen, in GI pixels. Smaller than uSceneSize, which the margin pads.
uniform vec2 uViewSize;
uniform float uStrength;
uniform float uExposure;
uniform float uEmissiveScale;
uniform float uEmissiveBoost;
uniform float uToneMap;
uniform vec3 uAmbient;
uniform vec3 uOccluderAmbient;
uniform float uLightStrength;
/// Coarsest fluence mip the occluder light may reach for -- occluderLightRange.
uniform float uLightLod;
uniform float uLightHeight;

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

/**
 * Undo the resolve pass' mask premultiply: the mean radiance of the *free* space
 * in this tap, with the blocked part contributing nothing rather than black.
 */
vec3 unmask(vec4 s) {
    return s.rgb / max(s.a, 1e-4);
}

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
vec4 tap(vec2 uv, float l) {
    vec2 d = exp2(l) * 0.5 / uSceneSize;
    return 0.25 * (textureLod(uFluence, uv + d, l)
        + textureLod(uFluence, uv - d, l)
        + textureLod(uFluence, uv + vec2(d.x, -d.y), l)
        + textureLod(uFluence, uv - vec2(d.x, -d.y), l));
}

/// Still mask-premultiplied: only ratios of it are ever used, and not dividing
/// per tap is what keeps the gradient free of the pinch unmask can produce.
float lodLuma(vec2 uv, float lod) {
    return dot(tap(uv, lod).rgb, LUMA);
}

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
 * averaged. scale comes back as the coverage-weighted mean footprint: how far
 * off the light that reached this pixel was found.
 */
vec3 dilate(vec2 uv, out float scale) {
    vec3 light = vec3(0.0);
    float cover = 0.0;
    float span = 0.0;
    float w = 1.0;
    for (float l = 1.0; l <= uLightLod; l += 1.0) {
        vec4 s = tap(uv, l);
        light += s.rgb * w;
        cover += s.a * w;
        span += s.a * w * exp2(l);
        // Halving per level: fine detail wins wherever it exists, and the coarse
        // levels are left as the broad fill under it. Raise it for softer, flatter
        // occluders, lower it for crisper contact light.
        w *= 0.5;
    }
    scale = span / max(cover, 1e-4);
    return light / max(cover, 1e-4);
}

void main() {
    // Where this fragment's world point sits in the lighting buffers.
    vec2 giUV = (vUV * uViewSize + uGiOffset + uMargin) / uSceneSize;

    // Explicit lod 0: the buffer is mipmapped for the occluder light below, and
    // nothing here should ever be allowed to slide into a coarser level.
    vec3 irradiance = unmask(textureLod(uFluence, giUV, 0.0));
    vec4 albedo = texture(uAlbedo, vUV);
    vec3 emissive = texture(uEmissive, giUV).rgb * uEmissiveScale * uEmissiveBoost;

    // Occluding pixels get the dilated light instead of the cascades directly,
    // in proportion to how much they occlude, so a half-transparent caster gets
    // half of each.
    float occ = texture(uOcclusion, giUV).a;
    vec3 surface = uOccluderAmbient;
    if (occ > 0.002 && uLightStrength > 0.0) {
        float scale;
        vec3 lit = dilate(giUV, scale);

        // Clear colour is (0,0,0,0), whose alpha says "no normal here".
        vec4 nTex = texture(uNormal, giUV);
        if (nTex.a > 0.0) {
            // Fluence is directionless, but the *gradient* of the dilated field
            // points at where the light is, and scale is how far off it was
            // found -- enough of a light vector to shade relief with. Read at the
            // level that footprint belongs to, so the gradient is as smooth as the
            // light it came from.
            float lod = log2(max(scale, 2.0));
            vec2 d = scale / uSceneSize;
            vec2 g = vec2(
                lodLuma(giUV + vec2(d.x, 0.0), lod) - lodLuma(giUV - vec2(d.x, 0.0), lod),
                lodLuma(giUV + vec2(0.0, d.y), lod) - lodLuma(giUV - vec2(0.0, d.y), lod));
            float len = length(g);
            vec3 dir = normalize(vec3(len > 1e-8 ? g * (scale / len) : vec2(0.0), uLightHeight));
            vec3 n = normalize(vec3(nTex.r * 2.0 - 1.0, 1.0 - nTex.g * 2.0, nTex.b * 2.0 - 1.0));
            // Wrap (half-Lambert) shading. A normalMap describes painted relief
            // on a flat sprite, not real geometry, so it should add shape without
            // making the surface darker on average than an un-mapped one -- and
            // plain N.L would, since the light is nearly in the surface plane.
            lit *= mix(1.0, dot(n, dir) * 0.5 + 0.5, nTex.a);
        }
        surface += lit * uLightStrength;
    }
    vec3 ambient = mix(uAmbient, surface, occ);

    vec3 color = albedo.rgb * (irradiance * uStrength + ambient) + emissive;
    color *= uExposure;
    if (uToneMap > 0.5) color = color / (1.0 + color);

    finalColor = vec4(color, albedo.a);
}
`;
