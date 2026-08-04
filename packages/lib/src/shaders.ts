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
 *  - Every fragment writes alpha, so blending must be off (or additive with the
 *    alpha ignored). Do not add a plain alpha blend to any of these passes.
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
 */
export const RESOLVE_FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUV;
out vec4 finalColor;

uniform sampler2D uCones;
uniform float uNorm;
${FRUSTUM}

void main() {
    vec2 p = frustum(vUV * uExtent) + vec2(1.0, 0.0);
    finalColor = vec4(texture(uCones, p / uExtent).rgb * uNorm, 1.0);
}
`;

/**
 * Vertex shader for the deferred occluder light pass. One instance per emitter.
 *
 * `aPosition` is the shared unit quad; each instance expands it to the AABB of
 * its own falloff circle, so a fragment outside `uLightRange` is never
 * rasterised in the first place. That is the whole point of the deferred pass:
 * cost follows the area the lights actually cover, not pixels x lights, and
 * nothing caps the light count but the instance buffer.
 *
 * Positions are in GI pixel space directly -- the mesh is left at scale 1, and
 * `uProjectionMatrix` already maps target pixels to clip space.
 */
export const LIGHT_VERTEX = /* glsl */ `#version 300 es
in vec2 aPosition;
/// Per instance: xy = centre in GI pixels, z = source half-extent, w unused.
in vec4 aLight;
/// Per instance: rgb = intensity-premultiplied colour.
in vec4 aLightColor;

uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;
uniform float uLightRange;

out vec2 vPos;
out vec3 vLight;
out vec3 vColor;

void main() {
    vec2 p = aLight.xy + (aPosition * 2.0 - 1.0) * uLightRange;
    mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
    gl_Position = vec4((mvp * vec3(p, 1.0)).xy, 0.0, 1.0);
    vPos = p;
    vLight = aLight.xyz;
    vColor = aLightColor.rgb;
}
`;

/**
 * One emitter's contribution to the *occluder surface light*: a second,
 * deliberately non-RC model for pixels that occlude. The cascades simulate
 * light travelling in the plane, so an occluder is permanently inside its own
 * shadow and its visible face gets nothing. Here those pixels are instead shaded
 * directly from the emitters, as point lights with distance falloff and an
 * optional normal map. It is unshadowed by design -- that is what makes it cheap.
 *
 * Blended additively into the light buffer, which the composite then reads once.
 * Alpha is 1 so the result is the same whether the blend resolves to `add` or
 * `add-npm`; only rgb is ever read back.
 */
export const LIGHT_FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec2 vPos;
in vec3 vLight;
in vec3 vColor;
out vec4 finalColor;

uniform sampler2D uOcclusion;
uniform sampler2D uNormal;
uniform vec2 uSceneSize;
uniform float uLightRange;
uniform float uLightHeight;

void main() {
    vec2 uv = vPos / uSceneSize;
    // Only occluding pixels use this model; everything else is lit by the cascades.
    if (texture(uOcclusion, uv).a <= 0.002) discard;

    vec2 delta = vLight.xy - vPos;
    float dist = length(delta);
    if (dist >= uLightRange) discard;

    // 1/d, not 1/d^2: this is a 2D world. A source of half-extent r subtends
    // 2r/d radians at distance d, and the composite averages radiance over the
    // whole 2*pi, so it fills r/(pi*d) of the incoming light -- the same
    // relationship the cascades arrive at by tracing. Clamping at r stops the
    // singularity inside the emitter.
    float radius = max(vLight.z, 1.0);
    float atten = radius / (3.14159265 * max(dist, radius));
    // Taper to exactly zero at uLightRange so a light never pops out.
    float window = 1.0 - (dist * dist) / (uLightRange * uLightRange);
    atten *= window * window;

    // Clear colour is (0,0,0,0), which decodes to a harmless direction that the
    // alpha mask then throws away.
    vec4 nTex = texture(uNormal, uv);
    vec3 n = normalize(vec3(nTex.r * 2.0 - 1.0, 1.0 - nTex.g * 2.0, nTex.b * 2.0 - 1.0));
    // Wrap (half-Lambert) shading. A normalMap describes painted relief on a
    // flat sprite, not real geometry, so it should add shape without making the
    // surface darker on average than an un-mapped one -- and plain N.L would,
    // since every light is nearly in the surface plane.
    vec3 dir = normalize(vec3(delta, uLightHeight));
    float ndl = mix(1.0, dot(n, dir) * 0.5 + 0.5, nTex.a);

    finalColor = vec4(vColor * (atten * ndl), 1.0);
}
`;

/**
 * Shade the albedo with the resolved fluence. Rendered straight into the scene
 * graph, so it also does exposure + tone map.
 *
 * Occluding pixels take their light from `uLight` -- the buffer the deferred
 * light pass accumulated -- instead of the cascades. See {@link LIGHT_FRAG}.
 */
export const COMPOSITE_FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUV;
out vec4 finalColor;

uniform sampler2D uAlbedo;
uniform sampler2D uEmissive;
uniform sampler2D uOcclusion;
uniform sampler2D uLight;
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

void main() {
    // Where this fragment's world point sits in the lighting buffers.
    vec2 giUV = (vUV * uViewSize + uGiOffset + uMargin) / uSceneSize;

    vec3 irradiance = texture(uFluence, giUV).rgb;
    vec4 albedo = texture(uAlbedo, vUV);
    vec3 emissive = texture(uEmissive, giUV).rgb * uEmissiveScale * uEmissiveBoost;

    // Occluding pixels get the surface light instead of the cascades, in
    // proportion to how much they occlude, so a half-transparent caster gets
    // half of each model.
    float occ = texture(uOcclusion, giUV).a;
    vec3 surface = uOccluderAmbient + texture(uLight, giUV).rgb * uLightStrength;
    vec3 ambient = mix(uAmbient, surface, occ);

    vec3 color = albedo.rgb * (irradiance * uStrength + ambient) + emissive;
    color *= uExposure;
    if (uToneMap > 0.5) color = color / (1.0 + color);

    finalColor = vec4(color, albedo.a);
}
`;
