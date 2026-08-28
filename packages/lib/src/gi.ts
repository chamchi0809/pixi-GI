import { Color, Matrix, Mesh, Geometry, RenderTexture } from 'pixi.js';
import type { ColorSource, Container, Renderer, Shader, WebGLRenderer } from 'pixi.js';
import { patchRenderer, setTexture } from 'pixi-psl';
import { Pass } from './pass';
import { SceneCollector } from './material';
import {
    compositeShader,
    extendShader,
    mergeShader,
    resolveShader,
    seedShader,
    smoothShader,
    temporalShader,
} from './shaders';
import { buildLayout, raysWidth, snapStep } from './cascades';
import type { HrcLayout } from './cascades';
import type { GpuProfiler } from './profile';

/** Options for {@link RadianceCascades}. Everything except `renderer`/`world` has a sane default. */
export interface RadianceCascadesOptions {
    /** The PixiJS renderer. WebGL or WebGPU -- the shaders compile to both. */
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
     * How many harmonics of the HRC plane lattice to filter out of the light,
     * `0` to `3`.
     *
     * Probes are planes and the merge treats a plane by its parity, so
     * alternating planes carry alternating bias -- one nested grid per cascade,
     * on both axes, which is what makes the pattern read as a Bayer weave rather
     * than as noise. It is periodic and locked to the buffer grid, so each pass
     * *nulls* one period outright instead of blurring it away: `1` takes the
     * 2-pixel checkerboard, `2` the 4-pixel grid with it, `3` the 8-pixel one.
     * Whatever survives that is broad enough to read as light rather than as
     * pattern.
     *
     * A pass is four taps over one buffer, so next to the hierarchy it is free;
     * what it spends is sharpness. The first is a 3x3 tent in lighting pixels
     * and each one after doubles the reach, so `2` and `3` start to soften
     * contact shadows -- reach for `resolution` before reaching for them.
     * @default 1
     */
    smoothing?: number;
    /**
     * How much of last frame's light to keep, `0` to `0.98`. `0`, the default,
     * is off and costs nothing.
     *
     * What is left in the image once `smoothing` has taken the lattice is
     * *temporal*: the cascades resolve from a ray fan that lands on different
     * texels whenever the camera moves under it, so a lit wall shimmers while
     * nothing in the scene moves. No spatial filter reaches that -- it is the
     * light itself moving -- but averaging the field with the frame before it
     * does, which is what this is: an exponential moving average over the
     * resolved fluence, reprojected through the camera so panning and zooming
     * do not smear it.
     *
     * `0.85` is a good place to start; `0.95` is very smooth and starts to lag
     * lights that move slowly enough not to trip the agreement test that keeps
     * real changes -- an explosion, a light switching on -- responsive. Costs
     * one `extent^2` RGBA16F buffer and one fullscreen pass, both only while it
     * is above `0`.
     * @default 0
     */
    temporal?: number;
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
    /** How many plane-lattice harmonics to filter out of the light, `0` to `3`. */
    smoothing: number;
    /** How much of last frame's reprojected light to keep, `0` to `0.98`. `0` is off. */
    temporal: number;

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

    private readonly _ambient = new Float32Array(3);
    private readonly _occluderAmbient = new Float32Array(3);
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
    /**
     * The other end of the smoothing chain's ping-pong -- same size and format
     * as `_fluence`, without the mip chain. Made the first time `smoothing` is
     * nonzero, so a pipeline that never smooths never pays for it.
     */
    private _fluenceScratch: RenderTexture | null = null;
    /**
     * Last frame's resolved fluence, for {@link RadianceCascades.temporal} to
     * average this one against -- the same size, format and mip chain as
     * `_fluence`, because the two swap roles every frame. Made the first time
     * `temporal` is nonzero, so a pipeline that never accumulates never pays
     * for it.
     */
    private _fluencePrev: RenderTexture | null = null;
    /** The GI camera the fluence in `_fluencePrev` was resolved through. */
    private readonly _prevGi = new Matrix();
    /** This buffer's pixels -> last frame's, from those two. Scratch for one frame. */
    private readonly _reproj = new Matrix();

    private readonly _seedPass: Pass;
    private readonly _extendPass: Pass;
    private readonly _mergePass: Pass;
    private readonly _resolvePass: Pass;
    private readonly _smoothPass: Pass;
    private readonly _temporalPass: Pass;

    private _destroyed = false;

    constructor(options: RadianceCascadesOptions) {
        const { renderer, world } = options;
        assertFloatTargets(renderer);
        patchRenderer(renderer);

        this._renderer = renderer;
        this._world = world;
        this._resolution = options.resolution ?? 0.5;
        this._cascadeOverride = options.cascades;
        this._marginFraction = Math.max(0, options.margin ?? 0.5);

        this.strength = options.strength ?? 1;
        this.exposure = options.exposure ?? 1;
        this.emissiveBoost = options.emissiveBoost ?? 1;
        this.toneMap = options.toneMap ?? true;
        this.smoothing = options.smoothing ?? 1;
        this.temporal = options.temporal ?? 0;
        this.ambient = options.ambient ?? 0x000000;
        this.occluderAmbient = options.occluderAmbient ?? 0x000000;
        this.occluderLightRange = options.occluderLightRange ?? 256;
        this.occluderLightHeight = options.occluderLightHeight ?? 48;
        this.occluderLightStrength = options.occluderLightStrength ?? 1;
        this.background = options.background ?? 0x000000;

        this._seedPass = new Pass(seedShader());
        this._extendPass = new Pass(extendShader());
        this._mergePass = new Pass(mergeShader());
        // Additive: the four frustums accumulate into one fluence buffer rather
        // than each getting its own for a final four-tap sum.
        this._resolvePass = new Pass(resolveShader(), 'add');
        this._smoothPass = new Pass(smoothShader());
        this._temporalPass = new Pass(temporalShader());

        this.view = new Mesh<Geometry, Shader>({
            geometry: new Geometry({
                attributes: { aPosition: [0, 0, 1, 0, 1, 1, 0, 1] },
                indexBuffer: [0, 1, 2, 0, 2, 3],
            }),
            shader: compositeShader(this._ambient, this._occluderAmbient),
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

        // Destroying a bound source emits 'change' with `destroyed`, which makes
        // every BindGroup holding it null its own resources -- and the rebind
        // below would then write into that null. So keep the old targets alive
        // until the new ones are bound, and free them at the end.
        const stale = this._targets();

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
        } else {
            this._emissiveHi = null;
            this._occlusionHi = null;
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

        const composite = this.view.shader!;
        setTexture(composite, 'uAlbedo', this._albedo.source);
        setTexture(composite, 'uEmissive', this._emissive.source);
        setTexture(composite, 'uOcclusion', this._occlusion.source);
        setTexture(composite, 'uNormal', this._normal.source);
        setTexture(composite, 'uFluence', this._fluence.source);
        setTexture(composite, 'uEmissiveHi', (this._emissiveHi ?? this._emissive).source);
        setTexture(composite, 'uOcclusionHi', (this._occlusionHi ?? this._occlusion).source);
        const pu = composite.resources['compositeUniforms'].uniforms;
        pu['uUpscale'] = this._emissiveHi ? 1 : 0;
        setVec2(pu['uViewSize'], this._viewW, this._viewH);
        setVec2(pu['uSceneSize'], extent, extent);
        setVec2(pu['uMargin'], marginX, marginY);

        this.view.scale.set(this._width, this._height);

        // The per-frame slots still point at last frame's buffers, and a bind
        // group holding one when it is destroyed nulls itself -- so repoint them
        // as well before the stale targets go.
        this._extendPass.setTexture('uPrev', this._rays[0]!.source);
        this._mergePass.setTexture('uRays', this._rays[0]!.source);
        this._mergePass.setTexture('uCones', this._coneA.source);
        this._resolvePass.setTexture('uCones', this._coneA.source);
        // The scratch and history buffers are sized off `extent` too, so they go
        // with the rest and are remade at the new size the next time smoothing
        // or temporal accumulation asks for them.
        this._fluenceScratch = null;
        this._fluencePrev = null;
        this._smoothPass.setTexture('uFluence', this._fluence.source);
        this._temporalPass.setTexture('uCurrent', this._fluence.source);
        this._temporalPass.setTexture('uHistory', this._fluence.source);

        for (const rt of stale) rt?.destroy(true);
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
        // The lattice filter ping-pongs between the two fluence buffers and has
        // to finish in `_fluence` -- the one the composite reads, and the only
        // one carrying mips -- so an odd number of passes resolves into the
        // scratch buffer and an even number straight into `_fluence`.
        const smoothing = this._smoothing();
        const keep = this._temporal();
        // Where the resolve and the filter chain have to leave the raw field.
        // Accumulating means it is an *input* to one more pass rather than the
        // frame's answer, so it lands in the scratch and `_fluence` is left
        // holding last frame's answer for that pass to read.
        const end = keep > 0 ? this._fluenceScratch! : this._fluence;
        const spare = keep > 0 ? this._fluencePrev! : this._fluenceScratch!;
        const resolveTarget = smoothing % 2 === 1 ? spare : end;
        profiler?.begin('hrc');
        for (let i = this.repeat['hrc'] ?? 1; i > 0; i--) this._renderCascades(resolveTarget);
        // No `repeat` key: every pass here reads what the one before it wrote, so
        // running the chain twice would filter twice rather than repeat the work.
        if (smoothing > 0) {
            profiler?.begin('smooth');
            this._smooth(smoothing, resolveTarget, resolveTarget === end ? spare : end);
        }
        if (keep > 0) {
            profiler?.begin('temporal');
            this._accumulate(keep, end);
        }
        // The camera the fluence the composite is about to read was resolved
        // through -- next frame's reprojection, and copied whether or not it is
        // accumulating, so turning `temporal` on mid-frame has one to work from.
        this._prevGi.copyFrom(m);
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
     * shared fluence buffer -- `target`, since the smoothing chain decides which
     * of the two that is.
     */
    private _renderCascades(target: RenderTexture): void {
        const renderer = this._renderer;
        const { extent, cascades } = this._layout;

        const su = this._seedPass.resources['seedUniforms'].uniforms;
        su['uEmissiveScale'] = this._collector.maxIntensity;
        const eu = this._extendPass.resources['extendUniforms'].uniforms;
        const mu = this._mergePass.resources['mergeUniforms'].uniforms;
        const ru = this._resolvePass.resources['resolveUniforms'].uniforms;

        // Sub-stage `repeat` keys, read once rather than per pass. Seeding,
        // extending and merging each rewrite their whole target from inputs they
        // do not touch, so running one of them twice leaves the frame identical
        // and the extra time is that sub-stage's own cost -- the same trick
        // `repeat` plays on the top-level stages, one level down. The resolve is
        // the exception: it is additive, so repeating it doubles the light.
        const seedRuns = this.repeat['seed'] ?? 1;
        const extendRuns = this.repeat['extend'] ?? 1;
        const mergeRuns = this.repeat['merge'] ?? 1;

        for (let frustum = 0; frustum < 4; frustum++) {
            su['uFrustum'] = frustum;
            for (let i = seedRuns; i > 0; i--) this._seedPass.run(renderer, this._rays[0]!);

            for (let i = extendRuns; i > 0; i--) {
                for (let n = 1; n < cascades; n++) {
                    const prev = this._rays[n - 1]!;
                    this._extendPass.setTexture('uPrev', prev.source);
                    setVec2(eu['uPrevInv'], 1 / prev.width, 1 / extent);
                    setVec2(eu['uTexSize'], this._rays[n]!.width, extent);
                    eu['uInterval'] = 2 ** n;
                    this._extendPass.run(renderer, this._rays[n]!);
                }
            }

            let read = this._coneB;
            let write = this._coneA;
            for (let i = mergeRuns; i > 0; i--) {
                read = this._coneB;
                write = this._coneA;
                for (let n = cascades - 1; n >= 0; n--) {
                    const rays = this._rays[n]!;
                    this._mergePass.setTexture('uRays', rays.source);
                    setVec2(mu['uRaysInv'], 1 / rays.width, 1 / extent);
                    mu['uInterval'] = 2 ** n;
                    mu['uInvInterval'] = 2 ** -n;
                    // Nothing above the top cascade: a 1x1 texture puts every cone
                    // lookup outside it, which MERGE_FRAG reads as empty.
                    const top = n === cascades - 1;
                    this._mergePass.setTexture('uCones', top ? RenderTexture.EMPTY.source : read.source);
                    const coneInv = top ? 1 : 1 / extent;
                    setVec2(mu['uConesInv'], coneInv, coneInv);
                    this._mergePass.run(renderer, write);
                    [read, write] = [write, read];
                }
            }

            this._resolvePass.setTexture('uCones', read.source);
            ru['uFrustum'] = frustum;
            // Additive, so only the first frustum clears.
            this._resolvePass.run(renderer, target, frustum === 0);
        }
    }

    /**
     * Smoothing passes to run this frame, clamped, and the scratch buffer they
     * need. It is made here rather than in {@link resize} because `smoothing` is
     * a live field: turning it on costs one more `extent^2` RGBA16F buffer, and
     * leaving it at `0` costs nothing at all.
     */
    private _smoothing(): number {
        const passes = Math.max(0, Math.min(MAX_SMOOTHING, Math.round(this.smoothing)));
        if (passes > 0) this._scratch();
        return passes;
    }

    /**
     * History weight for this frame, clamped, and the buffers it needs. Like
     * {@link _smoothing}, this is where the allocation happens because
     * `temporal` is a live field: switching it on costs one more mipmapped
     * `extent^2` RGBA16F buffer plus the scratch, and leaving it at `0` costs
     * nothing at all.
     *
     * Not quite `1`: at `1` the field would be whatever the first frame
     * resolved, for ever.
     */
    private _temporal(): number {
        const keep = Math.max(0, Math.min(MAX_TEMPORAL, this.temporal));
        if (keep > 0 && !this._fluencePrev) {
            const { extent } = this._layout;
            // Mipmapped like `_fluence`: the two swap every frame, so whichever
            // one holds the answer is the one the composite dilates.
            this._fluencePrev = createTarget(extent, extent, 'rgba16float', 'linear', true);
            this._scratch();
        }
        return keep;
    }

    /** The un-mipmapped spare buffer, shared by the filter chain and the accumulation. */
    private _scratch(): RenderTexture {
        const { extent } = this._layout;
        return (this._fluenceScratch ??= createTarget(extent, extent, 'rgba16float', 'linear'));
    }

    /**
     * The lattice filter -- one pass per period, two lighting pixels then four
     * then eight, ping-ponged between the pair of buffers it is handed and
     * finishing in whichever of them the caller wants the field. See
     * {@link smoothShader} for what is being nulled and why it can be.
     */
    private _smooth(passes: number, from: RenderTexture, into: RenderTexture): void {
        const { extent } = this._layout;
        const u = this._smoothPass.resources['smoothUniforms'].uniforms;
        let read = from;
        let write = into;
        for (let i = 0; i < passes; i++) {
            // A quarter of the period this pass nulls: half a texel, then one, then two.
            const tap = 2 ** (i - 1) / extent;
            setVec2(u['uTap'], tap, tap);
            this._smoothPass.setTexture('uFluence', read.source);
            this._smoothPass.run(this._renderer, write);
            [read, write] = [write, read];
        }
    }

    /**
     * Average `current` into the light the last frame resolved, and make the
     * result the buffer the composite reads.
     *
     * The history is the *world*'s light, held in a buffer that is pinned to
     * the camera, so it has to be read through where each pixel used to be:
     * `_reproj` is last frame's camera composed with the inverse of this one's,
     * both of them the transform the buffers were actually rasterised with --
     * lattice snap, margin and all -- so the reprojection is exact rather than
     * a per-frame guess at a camera delta.
     *
     * The two mipmapped buffers then swap: what was just written is this
     * frame's answer and next frame's history, and what the composite was
     * reading becomes the spare. One pass, no copies.
     */
    private _accumulate(keep: number, current: RenderTexture): void {
        const { extent } = this._layout;
        const u = this._temporalPass.resources['temporalUniforms'].uniforms;
        const r = this._reproj.copyFrom(this._giTransform).invert().prepend(this._prevGi);
        u['uKeep'] = keep;
        setVec2(u['uReprojX'], r.a, r.c);
        setVec2(u['uReprojY'], r.b, r.d);
        // The rows are in buffer pixels and the shader works in UV; the linear
        // part is a ratio of the two and carries over untouched.
        setVec2(u['uReprojT'], r.tx / extent, r.ty / extent);
        this._temporalPass.setTexture('uCurrent', current.source);
        this._temporalPass.setTexture('uHistory', this._fluence.source);
        this._temporalPass.run(this._renderer, this._fluencePrev!);
        [this._fluence, this._fluencePrev] = [this._fluencePrev!, this._fluence];
        setTexture(this.view.shader!, 'uFluence', this._fluence.source);
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
        this._smoothPass.destroy();
        this._temporalPass.destroy();
        this.view.destroy({ children: true });
        this._disposeTargets();
    }

    private _targets(): (RenderTexture | null | undefined)[] {
        return [
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
            this._fluenceScratch,
            this._fluencePrev,
        ];
    }

    private _disposeTargets(): void {
        for (const rt of this._targets()) rt?.destroy(true);
        this._rays = [];
        this._emissiveHi = null;
        this._occlusionHi = null;
        this._fluenceScratch = null;
        this._fluencePrev = null;
    }
}

/**
 * Lattice harmonics {@link RadianceCascadesOptions.smoothing} will null: the
 * 2-, 4- and 8-pixel grids. A fourth pass reaches eight lighting pixels either
 * side, by which point it is the light being filtered and not the lattice.
 */
const MAX_SMOOTHING = 3;

/**
 * Ceiling on {@link RadianceCascadesOptions.temporal}. At `1` the average never
 * takes a new sample and the light is whatever the first frame resolved.
 */
const MAX_TEMPORAL = 0.98;

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

/**
 * Every buffer in the pipeline is a half-float render target. WebGPU has those
 * unconditionally; WebGL2 needs an extension, and without it every cascade
 * buffer would silently clamp to 0..1 and the light would flatten.
 */
function assertFloatTargets(renderer: Renderer): void {
    const gl = (renderer as WebGLRenderer).gl as WebGL2RenderingContext | undefined;
    if (gl && !gl.getExtension('EXT_color_buffer_float')) {
        throw new Error(
            'pixi-rcgi requires the WebGL2 EXT_color_buffer_float extension, which this device does not expose.',
        );
    }
}
