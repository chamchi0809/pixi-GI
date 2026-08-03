/**
 * All GLSL for the radiance-cascade pipeline.
 *
 * Conventions shared by every pass:
 *  - `vUV` is 0..1 across the render target, matching PixiJS' own sprite UV
 *    orientation, so reading and writing at the same `vUV` is an identity copy.
 *  - "GI pixel space" is `vUV * uSceneSize`, the coordinate system of the
 *    emissive / occlusion / seed textures. It is the screen scaled by
 *    `RadianceCascadesOptions.resolution`.
 *  - Every fragment writes alpha 1 so the default premultiplied blend acts as a
 *    plain overwrite. Do not remove that without also disabling blending.
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
 * Jump-flood seeding. Any texel that either occludes or emits becomes a seed,
 * so the distance field also stops rays inside non-occluding emissive volumes.
 * Stores the seed position in GI pixel space; negative x means "no seed".
 */
export const SEED_FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUV;
out vec4 finalColor;

uniform sampler2D uEmissive;
uniform sampler2D uOcclusion;
uniform vec2 uSceneSize;

void main() {
    float occ = texture(uOcclusion, vUV).a;
    vec3 emissive = texture(uEmissive, vUV).rgb;
    bool solid = occ > 0.002 || max(emissive.r, max(emissive.g, emissive.b)) > 0.002;
    finalColor = solid ? vec4(vUV * uSceneSize, 0.0, 1.0) : vec4(-1.0, -1.0, 0.0, 1.0);
}
`;

/** One jump-flood iteration at `uStep` texels. */
export const JFA_FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUV;
out vec4 finalColor;

uniform sampler2D uSeed;
uniform vec2 uSceneSize;
uniform float uStep;

void main() {
    vec2 here = vUV * uSceneSize;
    vec2 best = vec2(-1.0);
    float bestDist = 1e20;

    for (int y = -1; y <= 1; y++) {
        for (int x = -1; x <= 1; x++) {
            vec2 offset = vec2(float(x), float(y)) * uStep;
            vec2 sampleUV = (here + offset) / uSceneSize;
            if (sampleUV.x < 0.0 || sampleUV.y < 0.0 || sampleUV.x > 1.0 || sampleUV.y > 1.0) continue;
            vec2 candidate = texture(uSeed, sampleUV).xy;
            if (candidate.x < 0.0) continue;
            float d = dot(candidate - here, candidate - here);
            if (d < bestDist) { bestDist = d; best = candidate; }
        }
    }
    finalColor = vec4(best, 0.0, 1.0);
}
`;

/**
 * One cascade of vanilla radiance cascades.
 *
 * Memory layout: the target is tiled into `uDirGrid x uDirGrid` blocks, each
 * `uProbeCount` texels, one block per ray direction. Because probe spacing
 * doubles and the direction count quadruples per cascade, the used region has
 * (near) constant area across the hierarchy.
 *
 * Each texel marches its interval through the distance field, then merges what
 * it did not resolve with the four angular children in the parent cascade,
 * bilinearly interpolated in space (plain bilinear -- this is vanilla RC, not
 * the "bilinear fix" variant).
 */
export const CASCADE_FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUV;
out vec4 finalColor;

uniform sampler2D uEmissive;
uniform sampler2D uOcclusion;
uniform sampler2D uSeed;
uniform sampler2D uParent;

uniform vec2 uSceneSize;
uniform vec2 uTexSize;
uniform vec2 uParentTexSize;
uniform vec2 uProbeCount;
uniform vec2 uParentProbeCount;
uniform float uDirGrid;
uniform float uSpacing;
uniform float uParentSpacing;
uniform float uIntervalStart;
uniform float uIntervalEnd;
uniform float uStride;
/// log2(uStride), on the CPU rather than 500M times a frame in the loop below.
uniform float uStrideMip;
uniform float uMaxSteps;
uniform float uHasParent;
uniform float uEmissiveScale;
uniform vec3 uSky;

const float TAU = 6.28318530718;
/// Seeds sit at texel centres, so back off by half a diagonal to keep the
/// sphere-tracing step conservative.
const float SEED_RADIUS = 0.75;

vec3 mergeParent(vec2 origin, float childDir) {
    vec2 probeF = origin / uParentSpacing - 0.5;
    // Clamp inside the tile so the hardware bilinear tap never bleeds into a
    // neighbouring direction block.
    vec2 local = clamp(probeF, vec2(0.0), uParentProbeCount - 1.0) + 0.5;
    float parentGrid = uDirGrid * 2.0;

    vec3 sum = vec3(0.0);
    for (int k = 0; k < 4; k++) {
        float parentDir = childDir * 4.0 + float(k);
        vec2 tile = vec2(mod(parentDir, parentGrid), floor(parentDir / parentGrid));
        sum += texture(uParent, (tile * uParentProbeCount + local) / uParentTexSize).rgb;
    }
    return sum * 0.25;
}

void main() {
    vec2 texel = floor(vUV * uTexSize);
    vec2 tile = floor(texel / uProbeCount);
    if (tile.x >= uDirGrid || tile.y >= uDirGrid) {
        finalColor = vec4(0.0, 0.0, 0.0, 1.0);
        return;
    }
    vec2 probe = texel - tile * uProbeCount;

    float dirIndex = tile.y * uDirGrid + tile.x;
    float dirCount = uDirGrid * uDirGrid;
    float angle = (dirIndex + 0.5) * TAU / dirCount;
    vec2 dir = vec2(cos(angle), sin(angle));
    vec2 origin = (probe + 0.5) * uSpacing;

    vec3 radiance = vec3(0.0);
    float transmittance = 1.0;
    float t = uIntervalStart;
    bool escaped = false;

    for (int i = 0; i < 64; i++) {
        if (float(i) >= uMaxSteps || t >= uIntervalEnd) break;
        vec2 p = origin + dir * t;
        if (p.x < 0.0 || p.y < 0.0 || p.x >= uSceneSize.x || p.y >= uSceneSize.y) { escaped = true; break; }

        vec2 uv = p / uSceneSize;
        vec2 seed = texture(uSeed, uv).xy;
        float d = seed.x < 0.0 ? 1e6 : max(distance(seed, p) - SEED_RADIUS, 0.0);

        // Anything nearer than one stride counts as medium. A fixed threshold
        // here instead makes the ray crawl: at stride 32 a surface 5px away
        // costs six sub-pixel steps to reach, which is most of the step budget
        // spent on ground the level cannot resolve anyway.
        if (d < 0.5) {
            // Riemann sum over uStride pixels of medium: emission is per pixel of
            // travel, so it scales linearly, absorption compounds.
            radiance += transmittance * textureLod(uEmissive, uv, uStrideMip).rgb * uEmissiveScale * uStride;
            float occ = texture(uOcclusion, uv).a;
            transmittance *= pow(max(1.0 - occ, 0.0), uStride);
            if (transmittance < 0.004) { transmittance = 0.0; break; }
            t += uStride;
        } else {
            t += d;
        }
    }

    if (transmittance > 0.0) {
        if (escaped || uHasParent < 0.5) {
            radiance += transmittance * uSky;
        } else {
            radiance += transmittance * mergeParent(origin, dirIndex);
        }
    }

    finalColor = vec4(radiance, 1.0);
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
 * Resolve cascade 0 to per-pixel irradiance and shade the albedo with it.
 * Rendered straight into the scene graph, so it also does exposure + tone map.
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
uniform sampler2D uCascade0;

uniform vec2 uSceneSize;
uniform vec2 uCascadeTexSize;
uniform vec2 uProbeCount;
uniform float uSpacing;
/**
 * GI pixels the lighting buffers are offset from the albedo: they are rasterised
 * snapped to a coarse grid, so that everything filtering them stays put in the
 * world, while the albedo uses the exact camera. Every lookup into a lighting
 * buffer is shifted by this to land on the world point this fragment shows.
 */
uniform vec2 uGiOffset;
/// The screen, in GI pixels. Smaller than uSceneSize, which the snap pads.
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
    vec2 p = vUV * uViewSize + uGiOffset;
    vec2 giUV = p / uSceneSize;
    vec2 probeF = p / uSpacing - 0.5;
    vec2 local = clamp(probeF, vec2(0.0), uProbeCount - 1.0) + 0.5;

    vec3 irradiance = vec3(0.0);
    for (int d = 0; d < 4; d++) {
        vec2 tile = vec2(mod(float(d), 2.0), floor(float(d) / 2.0));
        irradiance += texture(uCascade0, (tile * uProbeCount + local) / uCascadeTexSize).rgb;
    }
    irradiance *= 0.25;

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
