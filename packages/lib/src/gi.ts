import { Color, Matrix, Mesh, Geometry, RenderTexture, Shader } from 'pixi.js';
import type { ColorSource, Container, Renderer, WebGLRenderer } from 'pixi.js';
import { LightPass, Pass } from './pass';
import { SceneCollector } from './material';
import { CASCADE_FRAG, COMPOSITE_FRAG, JFA_FRAG, SEED_FRAG, VERTEX } from './shaders';
import { buildLevels, cascadeTextureSize, snapQuantum } from './cascades';
import type { CascadeLevel } from './cascades';
import { packLight } from './lights';
import type { LightView } from './lights';
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
     * Fraction of the *logical* size the lighting runs at. On a HiDPI canvas
     * pass `renderer.resolution` to match physical pixels.
     * @default 0.5
     */
    resolution?: number;
    /**
     * Cascade-0 probe spacing, in lighting-resolution pixels.
     *
     * Together with {@link RadianceCascadesOptions.resolution} this decides how
     * sharp the light is: irradiance is sampled every
     * `probeSpacing / resolution` screen pixels and interpolated in between.
     * `resolution: 1, probeSpacing: 1` is pixel-perfect but costs roughly 6x
     * the defaults -- see the README for measurements.
     * @default 2
     */
    probeSpacing?: number;
    /**
     * Number of cascades. Defaults to just enough for the longest ray to cross
     * the screen; lowering it caps how far light travels.
     */
    cascades?: number;
    /**
     * World kept outside the view that still emits and occludes, as a **fraction
     * of the view** on each side. The default `0.5` makes the lit region twice
     * the view on both axes.
     *
     * A fraction rather than a pixel count so it follows the camera: whatever the
     * zoom, the same proportion of extra world is lit, and the buffers never have
     * to be reallocated for it.
     *
     * The probes only ever cover the view -- this widens the *scene the rays
     * march through*, so a torch a little past the edge lights what is on screen
     * instead of popping in once the camera reaches it, and a wall just off-screen
     * keeps casting its shadow inwards. `0` is pure screen-space lighting.
     *
     * Paid for in buffer area on the three world renders and the jump flood --
     * `0.5` is 4x the area of `0` -- while the cascade passes are sized by the
     * view and do not notice. Past the top cascade's reach (about the view
     * diagonal) more margin buys nothing, which is what caps this at `0.5`.
     * @default 0.5
     */
    margin?: number;
    /** Cascade-0 ray length, in lighting-resolution pixels. @default probeSpacing */
    intervalLength?: number;
    /** Radiance for rays that leave the screen without hitting anything. @default 0x000000 */
    sky?: ColorSource;
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
     * How far an emitter's *surface* light reaches, in world pixels -- logical
     * pixels at zoom 1, and scaled with `world`'s own transform after that.
     * Beyond it an occluding pixel gets only {@link RadianceCascadesOptions.occluderAmbient}.
     * @default 256
     */
    occluderLightRange?: number;
    /**
     * How far in front of the scene the emitters sit, in world pixels, when
     * shading a `normalMap`. Small values graze the surface and exaggerate the
     * relief; large values flatten it. Ignored without a normal map.
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

/**
 * Vanilla radiance cascades global illumination for PixiJS.
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

    /** How far an emitter's surface light reaches on occluders, in world pixels. */
    occluderLightRange: number;
    /** Virtual z of the emitters when shading a `normalMap`, in world pixels. */
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

    private readonly _sky = f32(3);
    private readonly _ambient = f32(3);
    private readonly _occluderAmbient = f32(3);
    private readonly _lightView: LightView = { width: 0, height: 0, sx: 1, sy: 1, range: 0, ox: 0, oy: 0 };
    private _background: number[] = [0, 0, 0, 1];

    private readonly _resolution: number;
    private readonly _probeSpacing: number;
    private readonly _intervalLength: number;
    private readonly _cascadeOverride: number | undefined;
    /** Off-view world kept in the buffers, as a fraction of the view per side. */
    private readonly _marginFraction: number;
    /** The same, in GI pixels, once {@link RadianceCascades.resize} knows the view. */
    private _marginX = 0;
    private _marginY = 0;
    /** This frame's camera zoom, read off `world`'s transform. */
    private _zoom = 1;

    /**
     * Texels the lighting buffers are snapped to. See {@link RadianceCascades.resize}.
     */
    private _snapQ = 1;
    /** What this frame's snap pushed the buffers by, in GI pixels. `[0, _snapQ)`. */
    private _residualX = 0;
    private _residualY = 0;

    private _width = 0;
    private _height = 0;
    /** The screen, in GI pixels. The buffers add `_snapQ` and two margins to this. */
    private _viewW = 0;
    private _viewH = 0;
    private _giWidth = 0;
    private _giHeight = 0;
    private _levels: CascadeLevel[] = [];

    private _albedo!: RenderTexture;
    private _emissive!: RenderTexture;
    private _occlusion!: RenderTexture;
    private _normal!: RenderTexture;
    /** The normal buffer holds something that still needs clearing. */
    private _normalDirty = true;
    private _seedA!: RenderTexture;
    private _seedB!: RenderTexture;
    private _cascadeA!: RenderTexture;
    private _cascadeB!: RenderTexture;
    /** Accumulated occluder surface light, at lighting resolution. */
    private _light!: RenderTexture;

    private readonly _seedPass: Pass;
    private readonly _jfaPass: Pass;
    private readonly _cascadePass: Pass;
    private readonly _lightPass: LightPass;

    private _destroyed = false;

    constructor(options: RadianceCascadesOptions) {
        const { renderer, world } = options;
        assertWebGLFloat(renderer);

        this._renderer = renderer;
        this._world = world;
        this._resolution = options.resolution ?? 0.5;
        this._probeSpacing = Math.max(1, Math.round(options.probeSpacing ?? 2));
        this._intervalLength = options.intervalLength ?? this._probeSpacing;
        this._cascadeOverride = options.cascades;
        this._marginFraction = Math.max(0, options.margin ?? 0.5);

        this.strength = options.strength ?? 1;
        this.exposure = options.exposure ?? 1;
        this.emissiveBoost = options.emissiveBoost ?? 1;
        this.toneMap = options.toneMap ?? true;
        this.sky = options.sky ?? 0x000000;
        this.ambient = options.ambient ?? 0x000000;
        this.occluderAmbient = options.occluderAmbient ?? 0x000000;
        this.occluderLightRange = options.occluderLightRange ?? 256;
        this.occluderLightHeight = options.occluderLightHeight ?? 48;
        this.occluderLightStrength = options.occluderLightStrength ?? 1;
        this.background = options.background ?? 0x000000;

        this._seedPass = new Pass('gi-seed', SEED_FRAG, {
            uEmissive: RenderTexture.EMPTY.source,
            uOcclusion: RenderTexture.EMPTY.source,
            seedUniforms: { uSceneSize: { value: f32(2), type: 'vec2<f32>' } },
        });

        this._jfaPass = new Pass('gi-jfa', JFA_FRAG, {
            uSeed: RenderTexture.EMPTY.source,
            jfaUniforms: {
                uSceneSize: { value: f32(2), type: 'vec2<f32>' },
                uStep: { value: 1, type: 'f32' },
            },
        });

        this._cascadePass = new Pass('gi-cascade', CASCADE_FRAG, {
            uEmissive: RenderTexture.EMPTY.source,
            uOcclusion: RenderTexture.EMPTY.source,
            uSeed: RenderTexture.EMPTY.source,
            uParent: RenderTexture.EMPTY.source,
            cascadeUniforms: {
                uSceneSize: { value: f32(2), type: 'vec2<f32>' },
                uTexSize: { value: f32(2), type: 'vec2<f32>' },
                uParentTexSize: { value: f32(2), type: 'vec2<f32>' },
                uProbeCount: { value: f32(2), type: 'vec2<f32>' },
                uParentProbeCount: { value: f32(2), type: 'vec2<f32>' },
                uDirGrid: { value: 2, type: 'f32' },
                uSpacing: { value: 2, type: 'f32' },
                uParentSpacing: { value: 4, type: 'f32' },
                uIntervalStart: { value: 0, type: 'f32' },
                uIntervalEnd: { value: 1, type: 'f32' },
                uStride: { value: 1, type: 'f32' },
                uStrideMip: { value: 0, type: 'f32' },
                uMaxSteps: { value: 16, type: 'f32' },
                uProbeOrigin: { value: f32(2), type: 'vec2<f32>' },
                uHasParent: { value: 0, type: 'f32' },
                uEmissiveScale: { value: 1, type: 'f32' },
                uSky: { value: this._sky, type: 'vec3<f32>' },
            },
        });

        this._lightPass = new LightPass({
            uOcclusion: RenderTexture.EMPTY.source,
            uNormal: RenderTexture.EMPTY.source,
            lightUniforms: {
                uSceneSize: { value: f32(2), type: 'vec2<f32>' },
                uLightRange: { value: 1, type: 'f32' },
                uLightHeight: { value: 1, type: 'f32' },
            },
        });

        const compositeShader = Shader.from({
            gl: { vertex: VERTEX, fragment: COMPOSITE_FRAG, name: 'gi-composite' },
            resources: {
                uAlbedo: RenderTexture.EMPTY.source,
                uEmissive: RenderTexture.EMPTY.source,
                uOcclusion: RenderTexture.EMPTY.source,
                uLight: RenderTexture.EMPTY.source,
                uCascade0: RenderTexture.EMPTY.source,
                compositeUniforms: {
                    uSceneSize: { value: f32(2), type: 'vec2<f32>' },
                    uCascadeTexSize: { value: f32(2), type: 'vec2<f32>' },
                    uProbeCount: { value: f32(2), type: 'vec2<f32>' },
                    uSpacing: { value: 2, type: 'f32' },
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

    /** Radiance for rays that leave the screen. */
    set sky(value: ColorSource) {
        writeRgb(value, this._sky);
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
        return { cascades: this._levels.length, giWidth: this._giWidth, giHeight: this._giHeight };
    }

    /** Reallocate for a new logical size. Cheap enough to call from a resize handler, but not per frame. */
    resize(width: number, height: number): void {
        if (width === this._width && height === this._height) return;
        this._width = Math.max(1, Math.round(width));
        this._height = Math.max(1, Math.round(height));
        this._viewW = Math.max(1, Math.round(this._width * this._resolution));
        this._viewH = Math.max(1, Math.round(this._height * this._resolution));

        // Everything that filters the lighting buffers is aligned to *them*, not
        // to the world: the emissive mip pyramid above all, whose coarsest level
        // averages over a whole top-cascade stride. Rasterise the world at a
        // fractional -- or even a whole-texel -- offset and a torch slides across
        // those cells as the camera moves, which pumps the light over half the
        // screen. Snapping the buffers to a multiple of the coarsest stride pins
        // every one of those filters to fixed world positions instead.
        //
        // The buffers pay for it in size: they are `snapQ` wider and taller than
        // the screen, because the snap leaves them offset from it by up to that
        // much and the composite still has to find every visible pixel inside.
        const probe = buildLevels(
            this._viewW,
            this._viewH,
            this._probeSpacing,
            this._intervalLength,
            this._cascadeOverride,
        );
        this._snapQ = snapQuantum(probe, Math.min(this._viewW, this._viewH));
        // The probe grid covers the view and its snap padding, and nothing more.
        // The buffers then add a margin of world on every side: rays leaving a
        // probe march through it, so off-view emitters and occluders count, but
        // no probe is ever placed out there. That is what keeps the cascade
        // passes -- the expensive ones -- the size they were.
        //
        // A whole number of texels: the margin is a constant shift of the world
        // inside the buffers, so it never moves the probe lattice, but a
        // fractional one would land the world half a texel off the grid the mips
        // average over -- the very thing the snap exists to prevent.
        const probeW = this._viewW + this._snapQ;
        const probeH = this._viewH + this._snapQ;
        this._marginX = Math.round(this._viewW * this._marginFraction);
        this._marginY = Math.round(this._viewH * this._marginFraction);
        this._giWidth = probeW + 2 * this._marginX;
        this._giHeight = probeH + 2 * this._marginY;

        // Same cascade count as the screen asked for: the padding must not push
        // the hierarchy a level deeper, which would change the snap it is for.
        this._levels = buildLevels(
            probeW,
            probeH,
            this._probeSpacing,
            this._intervalLength,
            probe.length,
        );

        const { width: cascadeW, height: cascadeH } = cascadeTextureSize(this._levels);

        this._disposeTargets();

        const gw = this._giWidth;
        const gh = this._giHeight;
        this._albedo = RenderTexture.create({
            width: this._width,
            height: this._height,
            resolution: this._renderer.resolution,
            antialias: false,
            scaleMode: 'linear',
        });
        // Mipmapped: cascade n integrates media in steps of its probe spacing, so
        // it reads the emissive mip that averages over one step. Without it a
        // 4px flame sampled with a 64px step is 16x too bright.
        this._emissive = createTarget(gw, gh, 'rgba16float', 'linear', true);
        // Deliberately not mipped, unlike the emissive buffer. Averaging
        // occlusion over a stride-wide box bleeds a wall's shadow into the empty
        // space beside it, and unlike a bleeding glow that is plainly visible:
        // it darkens whole lit regions.
        this._occlusion = createTarget(gw, gh, 'rgba8unorm', 'nearest');
        this._normal = createTarget(gw, gh, 'rgba8unorm', 'linear');
        this._normalDirty = true;
        // Two channels: the flood only ever writes and reads a seed position, and
        // this buffer is read once per march step, so the two dead channels were
        // half the traffic of the hottest fetch in the library.
        this._seedA = createTarget(gw, gh, 'rg16float', 'nearest');
        this._seedB = createTarget(gw, gh, 'rg16float', 'nearest');
        this._cascadeA = createTarget(cascadeW, cascadeH, 'rgba16float', 'linear');
        this._cascadeB = createTarget(cascadeW, cascadeH, 'rgba16float', 'linear');
        // Linear, so the composite -- which runs at screen resolution -- gets
        // smooth light over the blocky occlusion mask rather than GI-res steps.
        this._light = createTarget(gw, gh, 'rgba16float', 'linear');

        this._seedPass.setTexture('uEmissive', this._emissive.source);
        this._seedPass.setTexture('uOcclusion', this._occlusion.source);
        setVec2(this._seedPass.resources['seedUniforms'].uniforms['uSceneSize'], gw, gh);

        setVec2(this._jfaPass.resources['jfaUniforms'].uniforms['uSceneSize'], gw, gh);

        this._cascadePass.setTexture('uEmissive', this._emissive.source);
        this._cascadePass.setTexture('uOcclusion', this._occlusion.source);
        const cu = this._cascadePass.resources['cascadeUniforms'].uniforms;
        setVec2(cu['uSceneSize'], gw, gh);
        setVec2(cu['uTexSize'], cascadeW, cascadeH);
        setVec2(cu['uParentTexSize'], cascadeW, cascadeH);
        setVec2(cu['uProbeOrigin'], this._marginX, this._marginY);

        this._lightPass.setTexture('uOcclusion', this._occlusion.source);
        this._lightPass.setTexture('uNormal', this._normal.source);
        setVec2(this._lightPass.resources['lightUniforms'].uniforms['uSceneSize'], gw, gh);

        const composite = this.view.shader!.resources;
        setVec2(composite['compositeUniforms'].uniforms['uViewSize'], this._viewW, this._viewH);
        composite['uAlbedo'] = this._albedo.source;
        composite['uEmissive'] = this._emissive.source;
        composite['uOcclusion'] = this._occlusion.source;
        composite['uLight'] = this._light.source;
        const pu = composite['compositeUniforms'].uniforms;
        setVec2(pu['uSceneSize'], gw, gh);
        setVec2(pu['uMargin'], this._marginX, this._marginY);
        setVec2(pu['uCascadeTexSize'], cascadeW, cascadeH);
        const c0 = this._levels[0]!;
        setVec2(pu['uProbeCount'], c0.probeX, c0.probeY);
        pu['uSpacing'] = c0.spacing;

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
        const sx = this._viewW / this._width;
        const sy = this._viewH / this._height;
        m.a *= sx;
        m.c *= sx;
        m.b *= sy;
        m.d *= sy;
        // Onto the snap grid, rounding up so the screen lands inside the buffers
        // and the padding sits past their far edge. Everything that reads them
        // has to follow, or the fix trades one flicker for another: `_residual`
        // is how far the snap pushed them, and both the light pass and the
        // composite add it back.
        const exactX = m.tx * sx;
        const exactY = m.ty * sy;
        m.tx = Math.ceil(exactX / this._snapQ) * this._snapQ;
        m.ty = Math.ceil(exactY / this._snapQ) * this._snapQ;
        this._residualX = m.tx - exactX;
        this._residualY = m.ty - exactY;
        // Then push the whole world in by one margin, so buffer texel 0 is that
        // far *outside* the view and the off-view world lands in the buffers.
        // Probe space is what the residual is measured in, so it stays untouched
        // and everything reading a buffer adds the margin on top.
        m.tx += this._marginX;
        m.ty += this._marginY;

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
            this._emissive.source.updateMipmaps();
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

        profiler?.begin('light');
        this._renderLights();

        let seed!: RenderTexture;
        for (let i = this.repeat['jfa'] ?? 1; i > 0; i--) seed = this._buildDistanceField();

        profiler?.begin('cascade');
        for (let i = this.repeat['cascade'] ?? 1; i > 0; i--) this._renderCascades(seed);
        profiler?.poll();
    }

    /** Jump flood: seed, then halving steps, then one extra pass at 1 to clean up JFA's stragglers. */
    private _buildDistanceField(): RenderTexture {
        const renderer = this._renderer;
        this.profiler?.begin('seed');
        this._seedPass.run(renderer, this._seedA);

        let read = this._seedA;
        let write = this._seedB;
        const uniforms = this._jfaPass.resources['jfaUniforms'].uniforms;

        this.profiler?.begin('jfa');
        let step = 2 ** Math.ceil(Math.log2(Math.max(this._giWidth, this._giHeight))) / 2;
        for (; step >= 1; step /= 2) {
            uniforms['uStep'] = step;
            this._jfaPass.setTexture('uSeed', read.source);
            this._jfaPass.run(renderer, write);
            [read, write] = [write, read];
        }
        uniforms['uStep'] = 1;
        this._jfaPass.setTexture('uSeed', read.source);
        this._jfaPass.run(renderer, write);
        return write;
    }

    private _renderCascades(seed: RenderTexture): void {
        const renderer = this._renderer;
        const uniforms = this._cascadePass.resources['cascadeUniforms'].uniforms;
        uniforms['uEmissiveScale'] = this._collector.maxIntensity;
        this._cascadePass.setTexture('uSeed', seed.source);

        let read = this._cascadeB;
        let write = this._cascadeA;

        for (let n = this._levels.length - 1; n >= 0; n--) {
            const level = this._levels[n]!;
            const parent = this._levels[n + 1];

            setVec2(uniforms['uProbeCount'], level.probeX, level.probeY);
            uniforms['uDirGrid'] = level.dirGrid;
            uniforms['uSpacing'] = level.spacing;
            uniforms['uIntervalStart'] = level.intervalStart;
            uniforms['uIntervalEnd'] = level.intervalEnd;
            uniforms['uStride'] = level.stride;
            uniforms['uStrideMip'] = Math.log2(level.stride);
            uniforms['uMaxSteps'] = level.maxSteps;
            uniforms['uHasParent'] = parent ? 1 : 0;
            if (parent) {
                setVec2(uniforms['uParentProbeCount'], parent.probeX, parent.probeY);
                uniforms['uParentSpacing'] = parent.spacing;
            }

            this._cascadePass.setTexture('uParent', read.source);
            // `repeat.cascade3` doubles just that level; the pass is a pure
            // function of its inputs, so writing the same target twice is a no-op
            // on the picture and shows up only as time.
            for (let i = this.repeat[`cascade${n}`] ?? 1; i > 0; i--) this._cascadePass.run(renderer, write);
            [read, write] = [write, read];
        }

        const composite = this.view.shader!.resources;
        composite['uCascade0'] = read.source;
        const pu = composite['compositeUniforms'].uniforms;
        setVec2(pu['uGiOffset'], this._residualX, this._residualY);
        pu['uStrength'] = this.strength;
        pu['uExposure'] = this.exposure;
        pu['uEmissiveBoost'] = this.emissiveBoost;
        pu['uEmissiveScale'] = this._collector.maxIntensity;
        pu['uToneMap'] = this.toneMap ? 1 : 0;
    }

    /**
     * Accumulate every visible emitter into the occluder light buffer, one
     * instanced quad each.
     *
     * At strength 0 the pass is skipped outright rather than cleared: the
     * composite multiplies the buffer by the same strength, so whatever is left
     * in it contributes nothing.
     */
    private _renderLights(): void {
        this.view.shader!.resources['compositeUniforms'].uniforms['uLightStrength'] =
            this.occluderLightStrength;
        if (this.occluderLightStrength <= 0) return;

        // World units -> GI pixels: the camera zoom, then the lighting resolution.
        // Zoomed in, a torch's surface light reaches further across the screen
        // because it reaches the same distance across the *world*.
        const sx = (this._viewW / this._width) * this._zoom;
        const lu = this._lightPass.resources['lightUniforms'].uniforms;
        lu['uLightRange'] = Math.max(1, this.occluderLightRange * sx);
        lu['uLightHeight'] = Math.max(0.001, this.occluderLightHeight * sx);

        this._lightPass.run(this._renderer, this._light, this._packLights());
    }

    /** Turn this frame's emitters into the light pass' instance buffer. */
    private _packLights(): number {
        const emitters = this._collector.emitters;
        const out = this._lightPass.reserve(emitters.length);
        const view = this._lightView;
        view.width = this._width;
        view.height = this._height;
        view.sx = this._viewW / this._width;
        view.sy = this._viewH / this._height;
        // `bounds` is already on screen, so the cull needs the range there too.
        view.range = this.occluderLightRange * this._zoom;
        view.ox = this._residualX + this._marginX;
        view.oy = this._residualY + this._marginY;

        let n = 0;
        for (let i = 0; i < emitters.length; i++) {
            const { node, material } = emitters[i]!;
            if (packLight(node.getBounds(), material, view, n, out)) n++;
        }
        return n;
    }

    destroy(): void {
        if (this._destroyed) return;
        this._destroyed = true;
        this._seedPass.destroy();
        this._jfaPass.destroy();
        this._cascadePass.destroy();
        this._lightPass.destroy();
        this.view.destroy({ children: true });
        this._disposeTargets();
    }

    private _disposeTargets(): void {
        for (const rt of [
            this._albedo,
            this._emissive,
            this._occlusion,
            this._normal,
            this._seedA,
            this._seedB,
            this._cascadeA,
            this._cascadeB,
            this._light,
        ]) {
            rt?.destroy(true);
        }
    }
}

function createTarget(
    width: number,
    height: number,
    format: 'rgba16float' | 'rgba8unorm' | 'rg16float',
    scaleMode: 'nearest' | 'linear',
    mips = false,
): RenderTexture {
    return RenderTexture.create({
        width,
        height,
        resolution: 1,
        format,
        scaleMode,
        antialias: false,
        autoGenerateMipmaps: mips,
        mipLevelCount: mips ? Math.floor(Math.log2(Math.max(width, height))) + 1 : 1,
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
