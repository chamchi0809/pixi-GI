import { Color, Matrix, Mesh, Geometry, RenderTexture, Shader } from 'pixi.js';
import type { ColorSource, Container, Renderer, WebGLRenderer } from 'pixi.js';
import { Pass } from './pass';
import { SceneCollector } from './material';
import { COMPOSITE_FRAG, EXTEND_FRAG, MERGE_FRAG, RESOLVE_FRAG, SEED_FRAG, VERTEX } from './shaders';
import { buildLayout, raysWidth, snapStep } from './cascades';
import type { HrcLayout } from './cascades';
import type { GpuProfiler } from './profile';

/** Options for {@link RadianceCascades}. Everything except `renderer`/`world` has a sane default. */
export interface RadianceCascadesOptions {
    /** The PixiJS renderer. WebGL only -- see the README for why. */
    renderer: Renderer;
    /**
     * Container holding the lit scene. It must **not** be added to the stage;
     * the library renders it itself and gives you {@link RadianceCascades.view}
     * to display instead. Move/scale this container to move the camera.
     */
    world: Container;
    /** Logical size of the lit area. @default the renderer's screen size */
    width?: number;
    /** @default the renderer's screen size */
    height?: number;
    /**
     * Fraction of the *logical* size the lighting runs at, and the only real cost
     * knob: HRC probes every lighting pixel, so this alone decides both how sharp
     * the light is and how much the whole pipeline costs.
     *
     * The buffers are square and a power of two, so what actually matters is
     * `max(width, height) * resolution` -- push it just over 512 and every buffer
     * jumps to 1024 and four times the memory. See the README.
     *
     * It costs sharpness of the *light* only. Below 1 the emission and occlusion
     * are drawn a second time at the logical size, so emitters and occluder edges
     * stay at game resolution however cheap the lighting is -- two more screen-
     * sized buffers and two more passes over the tagged objects.
     * @default 0.5
     */
    resolution?: number;
    /**
     * Number of cascades. Defaults to as many as the buffer can hold, whose top
     * ray already crosses it; lowering it caps how far light travels, at
     * `2^cascades` lighting pixels, and drops two passes per cascade per frustum.
     */
    cascades?: number;
    /**
     * World kept outside the view that still emits and occludes, as a **fraction
     * of the view** on each side. Rays travel through it, so a torch a little
     * past the edge lights what is on screen instead of popping in once the
     * camera reaches it, and a wall just off-screen keeps casting its shadow
     * inwards. `0` is pure screen-space lighting.
     *
     * A fraction rather than a pixel count so it follows the camera: whatever the
     * zoom, the same proportion of extra world is lit, and the buffers never have
     * to be reallocated for it.
     *
     * **Free, but capped.** The buffers are already rounded up to a square power
     * of two, and the margin is the slack that rounding left over -- so asking
     * for more than there is room for is clamped rather than honoured, since
     * honouring it would quadruple the memory. On a 16:9 screen there is a lot of
     * room above and below and very little either side.
     * @default 0.5
     */
    margin?: number;
    /** Flat light added everywhere, so unlit areas are not pure black. @default 0x000000 */
    ambient?: ColorSource;
    /** Multiplier on the computed bounce light. @default 1 */
    strength?: number;
    /** Multiplier applied just before tone mapping. @default 1 */
    exposure?: number;
    /** How brightly emitters render in the final image, on top of the light they cast. @default 1 */
    emissiveBoost?: number;
    /** Reinhard tone mapping, which keeps bright emitters from clipping. @default true */
    toneMap?: boolean;
    /**
     * Flat light added to pixels that *do* occlude. Light travels in the plane,
     * so an occluder's own body blocks it and the visible face of a wall would
     * otherwise be pure black. This is the floor of the occluder surface light;
     * {@link RadianceCascadesOptions.ambient} does the same for everything else.
     * @default 0x000000
     */
    occluderAmbient?: ColorSource;
    /**
     * How far an occluding pixel may look for light, in world pixels -- logical
     * pixels at zoom 1, and scaled with `world`'s own transform after that. It
     * sets which fluence mip the surface light is taken from, so it is really
     * "how deep into a wall does light get"; a pixel that finds none within it
     * gets only {@link RadianceCascadesOptions.occluderAmbient}. Rounded to a
     * power of two.
     * @default 256
     */
    occluderLightRange?: number;
    /**
     * How far in front of the scene the light sits, in world pixels, when shading
     * a `normalMap`. Small values graze the surface and exaggerate the relief;
     * large values flatten it. Ignored without a normal map.
     * @default 48
     */
    occluderLightHeight?: number;
    /**
     * Multiplier on the occluder surface light, so it can be balanced against
     * the cascades without touching any `emissiveIntensity`. `0` disables it,
     * leaving just {@link RadianceCascadesOptions.occluderAmbient}.
     * @default 1
     */
    occluderLightStrength?: number;
    /** Colour behind the world. @default 0x000000 */
    background?: ColorSource;
}

const f32 = (n: number): Float32Array => new Float32Array(n);

/// Fluence -> mean incoming radiance. See RESOLVE_FRAG for why it is pi, not 2pi.
const FLUENCE_NORM = 1 / Math.PI;

/**
 * Holographic radiance cascades global illumination for PixiJS.
 *
 * ```ts
 * const gi = new RadianceCascades({ renderer: app.renderer, world });
 * app.stage.addChild(gi.view);
 * app.ticker.add(() => gi.render());
 * ```
 */
export class RadianceCascades {
    /** Add this to your stage. It draws the lit scene. */
    readonly view: Mesh<Geometry, Shader>;

    /** Multiplier on the computed bounce light. */
    strength: number;
    /** Multiplier applied just before tone mapping. */
    exposure: number;
    /** How brightly emitters render in the final image. */
    emissiveBoost: number;
    /** Reinhard tone mapping. */
    toneMap: boolean;

    /** How far into an occluder light reaches, in world pixels. */
    occluderLightRange: number;
    /** Virtual z of the light when shading a `normalMap`, in world pixels. */
    occluderLightHeight: number;
    /** Multiplier on the occluder surface light. `0` disables it. */
    occluderLightStrength: number;

    /**
     * Set a {@link GpuProfiler} to get per-stage GPU timings. Costs nothing
     * while it is `null`, which is the default.
     */
    profiler: GpuProfiler | null = null;

    /**
     * Measurement only: `{ albedo: 2 }` runs that stage twice a frame. Every
     * stage rewrites its whole target, so the picture is unchanged and the extra
     * wall-clock time is that stage's true cost -- which is how you get a number
     * out of a driver whose timer queries report per command buffer rather than
     * per pass. Leave it empty in real use.
     */
    repeat: Record<string, number> = {};

    private readonly _renderer: Renderer;
    private readonly _world: Container;
    private readonly _collector = new SceneCollector();
    private readonly _giTransform = new Matrix();

    private readonly _ambient = f32(3);
    private readonly _occluderAmbient = f32(3);
    private _background: number[] = [0, 0, 0, 1];

    private readonly _resolution: number;
    private readonly _cascadeOverride: number | undefined;
    /** Off-view world kept in the buffers, as a fraction of the view per side. */
    private readonly _marginFraction: number;
    /** This frame's camera zoom, read off `world`'s transform. */
    private _zoom = 1;

    /** What snapping the buffers onto the lattice pushed them by. `[0, step)`. */
    private _residualX = 0;
    private _residualY = 0;
    /** This frame's occluder-light mip level and light height, in GI pixels. */
    private _lightLod = 1;
    private _lightHeight = 1;

    private _width = 0;
    private _height = 0;
    /** The screen, in GI pixels. The buffers pad this out to a square power of two. */
    private _viewW = 0;
    private _viewH = 0;
    private _layout: HrcLayout = { extent: 0, cascades: 0, marginX: 0, marginY: 0 };

    private _albedo!: RenderTexture;
    private _emissive!: RenderTexture;
    private _occlusion!: RenderTexture;
    private _normal!: RenderTexture;
    /**
     * Emission and occlusion again, at albedo resolution with the albedo's own
     * camera. The composite shows those two as objects rather than as light, so
     * without them a lowered `resolution` would be visible in the final image as
     * blocky emitters and stair-stepped occluder faces. `null` at `resolution >=
     * 1`, where the lighting buffers already carry every pixel the screen has.
     */
    private _emissiveHi: RenderTexture | null = null;
    private _occlusionHi: RenderTexture | null = null;
    /** The normal buffer holds something that still needs clearing. */
    private _normalDirty = true;
    /** Cascade `n`'s rays. Built bottom-up by ray extension, then merged top-down. */
    private _rays: RenderTexture[] = [];
    /** Cones, ping-ponged down the hierarchy by the merge pass. */
    private _coneA!: RenderTexture;
    private _coneB!: RenderTexture;
    /**
     * All four frustums' cascade-0 cones, summed and normalised, premultiplied by
     * free space with the mask in alpha. Mipmapped, which is what the composite
     * dilates into the occluders -- see COMPOSITE_FRAG.
     */
    private _fluence!: RenderTexture;

    private readonly _seedPass: Pass;
    private readonly _extendPass: Pass;
    private readonly _mergePass: Pass;
    private readonly _resolvePass: Pass;

    private _destroyed = false;

    constructor(options: RadianceCascadesOptions) {
        const { renderer, world } = options;
        assertWebGLFloat(renderer);

        this._renderer = renderer;
        this._world = world;
        this._resolution = options.resolution ?? 0.5;
        this._cascadeOverride = options.cascades;
        this._marginFraction = Math.max(0, options.margin ?? 0.5);

        this.strength = options.strength ?? 1;
        this.exposure = options.exposure ?? 1;
        this.emissiveBoost = options.emissiveBoost ?? 1;
        this.toneMap = options.toneMap ?? true;
        this.ambient = options.ambient ?? 0x000000;
        this.occluderAmbient = options.occluderAmbient ?? 0x000000;
        this.occluderLightRange = options.occluderLightRange ?? 256;
        this.occluderLightHeight = options.occluderLightHeight ?? 48;
        this.occluderLightStrength = options.occluderLightStrength ?? 1;
        this.background = options.background ?? 0x000000;

        this._seedPass = new Pass('gi-seed', SEED_FRAG, {
            uEmissive: RenderTexture.EMPTY.source,
            uOcclusion: RenderTexture.EMPTY.source,
            seedUniforms: {
                uTexSize: { value: f32(2), type: 'vec2<f32>' },
                uExtent: { value: 1, type: 'f32' },
                uFrustum: { value: 0, type: 'f32' },
                uEmissiveScale: { value: 1, type: 'f32' },
            },
        });

        this._extendPass = new Pass('gi-extend', EXTEND_FRAG, {
            uPrev: RenderTexture.EMPTY.source,
            extendUniforms: {
                uPrevSize: { value: f32(2), type: 'vec2<f32>' },
                uTexSize: { value: f32(2), type: 'vec2<f32>' },
                uInterval: { value: 1, type: 'f32' },
            },
        });

        this._mergePass = new Pass('gi-merge', MERGE_FRAG, {
            uRays: RenderTexture.EMPTY.source,
            uCones: RenderTexture.EMPTY.source,
            mergeUniforms: {
                uRaysSize: { value: f32(2), type: 'vec2<f32>' },
                uConesSize: { value: f32(2), type: 'vec2<f32>' },
                uTexSize: { value: f32(2), type: 'vec2<f32>' },
                uInterval: { value: 1, type: 'f32' },
            },
        });

        // Additive: the four frustums accumulate into one fluence buffer rather
        // than each getting its own for a final four-tap sum.
        this._resolvePass = new Pass(
            'gi-resolve',
            RESOLVE_FRAG,
            {
                uCones: RenderTexture.EMPTY.source,
                uOcclusion: RenderTexture.EMPTY.source,
                resolveUniforms: {
                    uExtent: { value: 1, type: 'f32' },
                    uFrustum: { value: 0, type: 'f32' },
                    uNorm: { value: FLUENCE_NORM, type: 'f32' },
                },
            },
            'add',
        );

        const compositeShader = Shader.from({
            gl: { vertex: VERTEX, fragment: COMPOSITE_FRAG, name: 'gi-composite' },
            resources: {
                uAlbedo: RenderTexture.EMPTY.source,
                uEmissive: RenderTexture.EMPTY.source,
                uOcclusion: RenderTexture.EMPTY.source,
                uNormal: RenderTexture.EMPTY.source,
                uFluence: RenderTexture.EMPTY.source,
                uEmissiveHi: RenderTexture.EMPTY.source,
                uOcclusionHi: RenderTexture.EMPTY.source,
                compositeUniforms: {
                    uUpscale: { value: 0, type: 'f32' },
                    uSceneSize: { value: f32(2), type: 'vec2<f32>' },
                    uViewSize: { value: f32(2), type: 'vec2<f32>' },
                    uGiOffset: { value: f32(2), type: 'vec2<f32>' },
                    uMargin: { value: f32(2), type: 'vec2<f32>' },
                    uStrength: { value: 1, type: 'f32' },
                    uExposure: { value: 1, type: 'f32' },
                    uEmissiveScale: { value: 1, type: 'f32' },
                    uEmissiveBoost: { value: 1, type: 'f32' },
                    uToneMap: { value: 1, type: 'f32' },
                    uAmbient: { value: this._ambient, type: 'vec3<f32>' },
                    uOccluderAmbient: { value: this._occluderAmbient, type: 'vec3<f32>' },
                    uLightStrength: { value: 1, type: 'f32' },
                    uLightLod: { value: 1, type: 'f32' },
                    uLightHeight: { value: 1, type: 'f32' },
                },
            },
        });
        this.view = new Mesh<Geometry, Shader>({
            geometry: new Geometry({
                attributes: { aPosition: [0, 0, 1, 0, 1, 1, 0, 1] },
                indexBuffer: [0, 1, 2, 0, 2, 3],
            }),
            shader: compositeShader,
        });

        this.resize(options.width ?? renderer.screen.width, options.height ?? renderer.screen.height);
    }

    /** The container being lit, as passed in. See `enableWorldEvents`. */
    get world(): Container {
        return this._world;
    }

    /** Flat light added everywhere. */
    set ambient(value: ColorSource) {
        writeRgb(value, this._ambient);
    }
    /** Flat light added to occluding pixels, which the cascades cannot reach. */
    set occluderAmbient(value: ColorSource) {
        writeRgb(value, this._occluderAmbient);
    }
    /** Colour behind the world. */
    set background(value: ColorSource) {
        this._background = new Color(value).toArray();
    }

    /** Cascade count, lighting buffer size -- useful for a debug HUD. */
    get stats(): { cascades: number; giWidth: number; giHeight: number } {
        const { cascades, extent } = this._layout;
        return { cascades, giWidth: extent, giHeight: extent };
    }

    /** Reallocate for a new logical size. Cheap enough to call from a resize handler, but not per frame. */
    resize(width: number, height: number): void {
        if (width === this._width && height === this._height) return;
        this._width = Math.max(1, Math.round(width));
        this._height = Math.max(1, Math.round(height));
        this._viewW = Math.max(1, Math.round(this._width * this._resolution));
        this._viewH = Math.max(1, Math.round(this._height * this._resolution));

        // Every lighting buffer is one square power-of-two `extent`: the four
        // frustum passes are the same shader over the same memory with the scene
        // rotated 90 degrees under it, and that rotation swaps x and y. The view
        // sits inside it at `margin`, and whatever the rounding left over is
        // off-view world the rays still travel through.
        this._layout = buildLayout(this._viewW, this._viewH, this._marginFraction, this._cascadeOverride);
        const { extent, cascades, marginX, marginY } = this._layout;

        this._disposeTargets();

        this._albedo = RenderTexture.create({
            width: this._width,
            height: this._height,
            resolution: this._renderer.resolution,
            antialias: false,
            scaleMode: 'linear',
        });
        // Linear so the composite, which reads it at screen resolution for the
        // emitters' own glow, gets a smooth one. The seed pass samples it only at
        // exact texel centres, so the filter never costs it anything.
        this._emissive = createTarget(extent, extent, 'rgba16float', 'linear');
        // Nearest: a filtered occlusion tap would let a wall's shadow bleed into
        // the empty space beside it, which darkens whole lit regions.
        this._occlusion = createTarget(extent, extent, 'rgba8unorm', 'nearest');
        this._normal = createTarget(extent, extent, 'rgba8unorm', 'linear');
        this._normalDirty = true;
        // Same size and resolution as the albedo, so the three line up texel for
        // texel and the composite reads all of them at `vUV`. Float for the
        // emission, which is additive and HDR exactly as in the lighting buffer.
        if (this._resolution < 1) {
            const hi = { width: this._width, height: this._height, resolution: this._renderer.resolution };
            this._emissiveHi = RenderTexture.create({ ...hi, format: 'rgba16float', antialias: false, scaleMode: 'linear' });
            this._occlusionHi = RenderTexture.create({ ...hi, format: 'rgba8unorm', antialias: false, scaleMode: 'linear' });
        }
        // Cascade n's rays: `2^n + 1` per plane, so a little wider than the
        // buffer. All of them are live at once -- extension fills them bottom-up
        // and merging then reads them top-down -- which is what makes this the
        // memory-hungry part of HRC, `extent^2 * (cascades + 2)` texels of it.
        this._rays = [];
        for (let n = 0; n < cascades; n++) {
            this._rays.push(createTarget(raysWidth(extent, n), extent, 'rgba16float', 'nearest'));
        }
        // The merge only ever needs the cascade above, so two buffers suffice.
        this._coneA = createTarget(extent, extent, 'rgba16float', 'nearest');
        this._coneB = createTarget(extent, extent, 'rgba16float', 'nearest');
        // Linear, so the composite -- which runs at screen resolution -- gets
        // smooth light rather than GI-res steps. Mipmapped as well, because the
        // occluder surface light is a mask-weighted mip tap of this buffer.
        this._fluence = createTarget(extent, extent, 'rgba16float', 'linear', true);

        this._seedPass.setTexture('uEmissive', this._emissive.source);
        this._seedPass.setTexture('uOcclusion', this._occlusion.source);
        const su = this._seedPass.resources['seedUniforms'].uniforms;
        su['uExtent'] = extent;
        setVec2(su['uTexSize'], this._rays[0]!.width, extent);

        const mu = this._mergePass.resources['mergeUniforms'].uniforms;
        setVec2(mu['uTexSize'], extent, extent);

        this._resolvePass.resources['resolveUniforms'].uniforms['uExtent'] = extent;
        this._resolvePass.setTexture('uOcclusion', this._occlusion.source);

        const composite = this.view.shader!.resources;
        composite['uAlbedo'] = this._albedo.source;
        composite['uEmissive'] = this._emissive.source;
        composite['uOcclusion'] = this._occlusion.source;
        composite['uNormal'] = this._normal.source;
        composite['uFluence'] = this._fluence.source;
        composite['uEmissiveHi'] = (this._emissiveHi ?? this._emissive).source;
        composite['uOcclusionHi'] = (this._occlusionHi ?? this._occlusion).source;
        const pu = composite['compositeUniforms'].uniforms;
        pu['uUpscale'] = this._emissiveHi ? 1 : 0;
        setVec2(pu['uViewSize'], this._viewW, this._viewH);
        setVec2(pu['uSceneSize'], extent, extent);
        setVec2(pu['uMargin'], marginX, marginY);

        this.view.scale.set(this._width, this._height);
    }

    /**
     * Run the lighting for this frame. Call it before PixiJS renders the stage
     * (e.g. `app.ticker.add(() => gi.render(), null, UPDATE_PRIORITY.HIGH)`).
     */
    render(): void {
        if (this._destroyed) return;
        const renderer = this._renderer;
        const world = this._world;
        const profiler = this.profiler;

        this._collector.collect(world);

        profiler?.begin('albedo');
        for (let i = this.repeat['albedo'] ?? 1; i > 0; i--) {
            renderer.render({ container: world, target: this._albedo, clear: true, clearColor: this._background });
        }

        world.updateLocalTransform();
        const m = this._giTransform;
        m.copyFrom(world.localTransform);
        // Camera zoom, as the linear scale of the world transform. Everything the
        // cascades touch is already in buffer pixels and scales with the world by
        // itself; the occluder surface light is the exception, because its range
        // and height are given in world units, so this is what carries the zoom
        // over to it.
        this._zoom = Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) || 1;
        this._measureLight();
        const sx = this._viewW / this._width;
        const sy = this._viewH / this._height;
        m.a *= sx;
        m.c *= sx;
        m.b *= sy;
        m.d *= sy;
        // Onto the lattice. Every ray in the hierarchy starts and ends on a texel
        // centre, so a world rasterised half a texel off would slide across the
        // ray fan as the camera moves and pump the light over half the screen.
        // Everything that reads a buffer has to follow, or the fix trades one
        // flicker for another: `_residual` is how far the snap pushed the world,
        // and the composite adds it back.
        const step = snapStep(this._lightLod, this._layout.marginX, this._layout.marginY);
        const exactX = m.tx * sx;
        const exactY = m.ty * sy;
        m.tx = Math.ceil(exactX / step) * step;
        m.ty = Math.ceil(exactY / step) * step;
        this._residualX = m.tx - exactX;
        this._residualY = m.ty - exactY;
        // Then push the whole world in by one margin, so buffer texel 0 is that
        // far *outside* the view and the off-view world lands in the buffers.
        // The residual is measured in view space, so it stays untouched and
        // everything reading a buffer adds the margin on top.
        m.tx += this._layout.marginX;
        m.ty += this._layout.marginY;

        profiler?.begin('emissive');
        this._collector.apply('emissive');
        for (let i = this.repeat['emissive'] ?? 1; i > 0; i--) {
            renderer.render({
                container: world,
                target: this._emissive,
                transform: m,
                clear: true,
                clearColor: [0, 0, 0, 0],
            });
        }
        // No `transform`: the albedo's camera, so the composite reads it at vUV.
        if (this._emissiveHi) {
            renderer.render({ container: world, target: this._emissiveHi, clear: true, clearColor: [0, 0, 0, 0] });
        }
        this._collector.restore();

        profiler?.begin('occlusion');
        this._collector.apply('occlusion');
        renderer.render({
            container: world,
            target: this._occlusion,
            transform: m,
            clear: true,
            clearColor: [0, 0, 0, 0],
        });
        if (this._occlusionHi) {
            renderer.render({ container: world, target: this._occlusionHi, clear: true, clearColor: [0, 0, 0, 0] });
        }
        this._collector.restore();

        // A fourth pass over the world is only worth it once someone sets a
        // normal map. The dirty flag buys one last pass to wipe the buffer when
        // the last one goes away.
        if (this._collector.hasNormals || this._normalDirty) {
            profiler?.begin('normal');
            this._normalDirty = this._collector.hasNormals;
            this._collector.apply('normal');
            renderer.render({
                container: world,
                target: this._normal,
                transform: m,
                clear: true,
                clearColor: [0, 0, 0, 0],
            });
            this._collector.restore();
        }

        // One stage for the whole hierarchy, not one per pass: it runs 4*(2N+1)
        // times a frame, and `begin` records a sample each time, so per-pass
        // timings would be dominated by the query overhead they are measuring.
        profiler?.begin('hrc');
        for (let i = this.repeat['hrc'] ?? 1; i > 0; i--) this._renderCascades();
        // The occluder surface light is a mip tap of the fluence, so the chain has
        // to be rebuilt after the resolve. One 512^2 RGBA16F reduction.
        this._fluence.source.updateMipmaps();

        const pu = this.view.shader!.resources['compositeUniforms'].uniforms;
        setVec2(pu['uGiOffset'], this._residualX, this._residualY);
        pu['uStrength'] = this.strength;
        pu['uExposure'] = this.exposure;
        pu['uEmissiveBoost'] = this.emissiveBoost;
        pu['uEmissiveScale'] = this._collector.maxIntensity;
        pu['uToneMap'] = this.toneMap ? 1 : 0;
        pu['uLightStrength'] = this.occluderLightStrength;
        pu['uLightLod'] = this._lightLod;
        pu['uLightHeight'] = this._lightHeight;

        // Rendering with a `transform` swaps it into the world's render group and
        // leaves it there, so after the lighting passes `world.worldTransform` --
        // and every child's, which is derived from it -- is the GI camera, margin
        // and lattice snap included. Anything that reads a world transform back
        // (hit testing, `toLocal`, `getGlobalPosition`) would get that instead of
        // the game's camera, and which one depends on `resolution` and whether
        // anything has a normal map. One matrix copy makes it always the game's.
        world.renderGroup?.worldTransform.copyFrom(world.localTransform);

        profiler?.poll();
    }

    /**
     * The holographic hierarchy, four times over -- once per 90-degree frustum,
     * with the scene rotated under a fixed right-facing memory layout.
     *
     * Per frustum: seed cascade 0's one-pixel rays off the scene (the only pass
     * that reads it at all), extend them pairwise up to cascade `N-1`, then merge
     * back down into cones, and add that frustum's quarter of the sky into the
     * shared fluence buffer.
     */
    private _renderCascades(): void {
        const renderer = this._renderer;
        const { extent, cascades } = this._layout;

        const su = this._seedPass.resources['seedUniforms'].uniforms;
        su['uEmissiveScale'] = this._collector.maxIntensity;
        const eu = this._extendPass.resources['extendUniforms'].uniforms;
        const mu = this._mergePass.resources['mergeUniforms'].uniforms;
        const ru = this._resolvePass.resources['resolveUniforms'].uniforms;

        for (let frustum = 0; frustum < 4; frustum++) {
            su['uFrustum'] = frustum;
            this._seedPass.run(renderer, this._rays[0]!);

            for (let n = 1; n < cascades; n++) {
                const prev = this._rays[n - 1]!;
                this._extendPass.setTexture('uPrev', prev.source);
                setVec2(eu['uPrevSize'], prev.width, extent);
                setVec2(eu['uTexSize'], this._rays[n]!.width, extent);
                eu['uInterval'] = 2 ** n;
                this._extendPass.run(renderer, this._rays[n]!);
            }

            let read = this._coneB;
            let write = this._coneA;
            for (let n = cascades - 1; n >= 0; n--) {
                const rays = this._rays[n]!;
                this._mergePass.setTexture('uRays', rays.source);
                setVec2(mu['uRaysSize'], rays.width, extent);
                mu['uInterval'] = 2 ** n;
                // Nothing above the top cascade: a 1x1 texture puts every cone
                // lookup outside it, which MERGE_FRAG reads as empty.
                const top = n === cascades - 1;
                this._mergePass.setTexture('uCones', top ? RenderTexture.EMPTY.source : read.source);
                setVec2(mu['uConesSize'], top ? 1 : extent, top ? 1 : extent);
                this._mergePass.run(renderer, write);
                [read, write] = [write, read];
            }

            this._resolvePass.setTexture('uCones', read.source);
            ru['uFrustum'] = frustum;
            // Additive, so only the first frustum clears.
            this._resolvePass.run(renderer, this._fluence, frustum === 0);
        }
    }

    /**
     * The occluder surface light in GI pixels, from knobs given in world units.
     *
     * `occluderLightRange` becomes the coarsest fluence mip the composite sums,
     * so the knob keeps its meaning (how far light gets into an occluder). Capped
     * at the top of the chain, and at least level 1, since level 0 is the
     * occluder's own black pixel.
     */
    private _measureLight(): void {
        // World units -> GI pixels: the camera zoom, then the lighting resolution.
        const sx = (this._viewW / this._width) * this._zoom;
        const lod = Math.round(Math.log2(Math.max(2, this.occluderLightRange * sx)));
        this._lightLod = Math.min(Math.log2(this._layout.extent), Math.max(1, lod));
        this._lightHeight = Math.max(0.001, this.occluderLightHeight * sx);
    }


    destroy(): void {
        if (this._destroyed) return;
        this._destroyed = true;
        this._seedPass.destroy();
        this._extendPass.destroy();
        this._mergePass.destroy();
        this._resolvePass.destroy();
        this.view.destroy({ children: true });
        this._disposeTargets();
    }

    private _disposeTargets(): void {
        for (const rt of [
            this._albedo,
            this._emissive,
            this._occlusion,
            this._normal,
            this._emissiveHi,
            this._occlusionHi,
            ...this._rays,
            this._coneA,
            this._coneB,
            this._fluence,
        ]) {
            rt?.destroy(true);
        }
        this._rays = [];
        this._emissiveHi = null;
        this._occlusionHi = null;
    }
}

function createTarget(
    width: number,
    height: number,
    format: 'rgba16float' | 'rgba8unorm',
    scaleMode: 'nearest' | 'linear',
    autoGenerateMipmaps = false,
): RenderTexture {
    return RenderTexture.create({
        width,
        height,
        resolution: 1,
        format,
        scaleMode,
        antialias: false,
        autoGenerateMipmaps,
    });
}

function setVec2(target: Float32Array, x: number, y: number): void {
    target[0] = x;
    target[1] = y;
}

function writeRgb(value: ColorSource, target: Float32Array): void {
    const rgb = new Color(value).toArray();
    target[0] = rgb[0] ?? 0;
    target[1] = rgb[1] ?? 0;
    target[2] = rgb[2] ?? 0;
}

function assertWebGLFloat(renderer: Renderer): void {
    const gl = (renderer as WebGLRenderer).gl as WebGL2RenderingContext | undefined;
    if (!gl) {
        throw new Error(
            'pixi-rcgi requires the WebGL renderer. Create your app with `preference: "webgl"`.',
        );
    }
    if (!gl.getExtension('EXT_color_buffer_float')) {
        throw new Error(
            'pixi-rcgi requires the WebGL2 EXT_color_buffer_float extension, which this device does not expose.',
        );
    }
}
