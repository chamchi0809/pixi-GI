import { Color } from 'pixi.js';
import type { BLEND_MODES, ColorSource, Container, Texture } from 'pixi.js';

/**
 * How a display object participates in global illumination.
 *
 * Anything **without** a material is background: it is lit, but it casts no
 * shadow and emits no light.
 */
export interface GIMaterial {
    /**
     * Emitted colour, multiplied by the object's own pixels.
     * Use `0xffffff` to emit the sprite's own colours. Omit to emit nothing.
     */
    emissive?: ColorSource;
    /**
     * Multiplier on {@link GIMaterial.emissive}. Values above 1 are HDR.
     *
     * This is radiance *per lighting-resolution pixel a ray travels through the
     * object*, so a solid caster (`occlusion: 1`) emits it once at its surface,
     * while a glowing volume (`occlusion: 0`) accumulates it over its whole
     * width. Big soft glows therefore want much smaller values than lamps.
     * @default 1
     */
    emissiveIntensity?: number;
    /**
     * How much light this object blocks, 0..1. `0` means light passes straight
     * through (a glowing volume, a decal); `1` is a solid caster.
     * @default 1
     */
    occlusion?: number;
    /**
     * Per-pixel emission. Swapped in for the object's texture during the
     * emission pass, so both its colour and its alpha shape the light.
     */
    emissiveMap?: Texture;
    /**
     * Whether this emitter also feeds the occluder surface light, which
     * approximates it by its **bounding box**. Set `false` for a large sprite
     * whose light really comes from scattered pixels of an
     * {@link GIMaterial.emissiveMap} -- otherwise it reads as one lamp the size
     * of the sprite. The cascades are per-pixel either way.
     * @default true
     */
    occluderLight?: boolean;
    /**
     * Per-pixel occlusion. Swapped in for the object's texture during the
     * occlusion pass; only its **alpha** channel is read.
     */
    occlusionMap?: Texture;
    /**
     * Per-pixel surface normal, OpenGL-style tangent space (+X right, +Y **up**,
     * +Z out of the screen).
     *
     * Only the occluder surface light uses it — the cascades are a 2D
     * simulation and have no notion of a surface facing. Swapped in for the
     * object's texture during the normal pass, so it should be opaque wherever
     * the surface exists; its alpha is the "I have a normal here" mask.
     */
    normalMap?: Texture;
}

/** @internal Normalised form, cached so the per-frame path allocates nothing. */
export interface ResolvedMaterial {
    readonly source: GIMaterial;
    /** 0..255 emissive colour components. */
    readonly r: number;
    readonly g: number;
    readonly b: number;
    readonly intensity: number;
    readonly occlusion: number;
    readonly emits: boolean;
    readonly occluderLight: boolean;
    readonly occludes: boolean;
    readonly emissiveMap: Texture | undefined;
    readonly occlusionMap: Texture | undefined;
    readonly normalMap: Texture | undefined;
}

const MATERIAL = Symbol.for('pixi-radiance.material');

interface Tagged {
    [MATERIAL]?: ResolvedMaterial;
}

function resolve(material: GIMaterial): ResolvedMaterial {
    const intensity = material.emissiveIntensity ?? 1;
    const occlusion = Math.min(Math.max(material.occlusion ?? 1, 0), 1);
    const rgb = material.emissive === undefined ? [0, 0, 0] : new Color(material.emissive).toUint8RgbArray();
    return {
        source: material,
        r: rgb[0] ?? 0,
        g: rgb[1] ?? 0,
        b: rgb[2] ?? 0,
        intensity,
        occlusion,
        emits: material.emissive !== undefined && intensity > 0 && (rgb[0] ?? 0) + (rgb[1] ?? 0) + (rgb[2] ?? 0) > 0,
        occluderLight: material.occluderLight ?? true,
        occludes: occlusion > 0,
        emissiveMap: material.emissiveMap,
        occlusionMap: material.occlusionMap,
        normalMap: material.normalMap,
    };
}

/**
 * Tag a display object as taking part in global illumination.
 *
 * The material covers the object's whole subtree; tag a child to override it
 * for that branch. Call again on the same object to change it.
 */
export function setMaterial(target: Container, material: GIMaterial): void {
    (target as Tagged)[MATERIAL] = resolve(material);
}

/** Read back the material set by {@link setMaterial}, if any. */
export function getMaterial(target: Container): GIMaterial | undefined {
    return (target as Tagged)[MATERIAL]?.source;
}

/** Remove a material, returning the object to plain background. */
export function clearMaterial(target: Container): void {
    delete (target as Tagged)[MATERIAL];
}

// --- internals used by the renderer ------------------------------------------------

/** @internal */
export type GIPass = 'emissive' | 'occlusion' | 'normal';

/** Objects that expose a swappable texture (Sprite, TilingSprite, Mesh, ...). */
interface Texturable extends Container {
    texture: Texture;
}

function isTexturable(node: Container): node is Texturable {
    return 'texture' in node && (node as Texturable).texture !== undefined;
}

/** True for things that actually draw (Sprite, Graphics, Mesh, Text, ...) rather than plain Containers. */
function isRenderable(node: Container): boolean {
    return 'renderPipeId' in node;
}

interface Saved {
    node: Container | null;
    visible: boolean;
    tint: number;
    alpha: number;
    blendMode: BLEND_MODES;
    texture: Texture | undefined;
    scaleX: number;
    scaleY: number;
}

/**
 * Swap in a map texture without changing the object's footprint -- a 128px glow
 * used as the emissive map of a 64px sprite must still cover 64px.
 */
function swapTexture(node: Texturable, map: Texture): void {
    const current = node.texture;
    node.texture = map;
    node.scale.set((node.scale.x * current.width) / map.width, (node.scale.y * current.height) / map.height);
}

/**
 * @internal
 * Walks the world once per frame, then replays the result for each GI pass.
 *
 * The passes work by temporarily overriding `tint` / `alpha` / `blendMode` /
 * `texture` on tagged objects and hiding everything else, so the library can
 * reuse the user's existing scene graph instead of asking for a duplicate one.
 */
export class SceneCollector {
    private readonly _participants: { node: Container; material: ResolvedMaterial }[] = [];
    private readonly _background: Container[] = [];
    private readonly _saved: Saved[] = [];

    /** Highest emissive intensity in the scene; the emission buffer is normalised by it. */
    maxIntensity = 1;

    /** The emitting leaves, for the occluder surface light's point-light list. */
    readonly emitters: { node: Container; material: ResolvedMaterial }[] = [];

    /** False when nothing in the scene has a normal map, so the normal pass can be skipped. */
    hasNormals = false;

    collect(root: Container): void {
        this._participants.length = 0;
        this._background.length = 0;
        this.emitters.length = 0;
        this.maxIntensity = 1;
        this.hasNormals = false;
        this._walk(root, undefined, true);
    }

    /**
     * A material set on a container applies to its whole subtree, but the
     * overrides only ever land on the leaves that actually draw -- that way we
     * never have to reason about how tint or blend mode inherit.
     */
    private _walk(node: Container, inherited: ResolvedMaterial | undefined, isRoot: boolean): boolean {
        if (!node.visible) return false;

        const material = (node as Tagged)[MATERIAL] ?? inherited;
        let keep = false;

        if (material && isRenderable(node)) {
            this._participants.push({ node, material });
            if (material.emits) {
                if (material.intensity > this.maxIntensity) this.maxIntensity = material.intensity;
                if (material.occluderLight) this.emitters.push({ node, material });
            }
            if (material.normalMap) this.hasNormals = true;
            keep = true;
        }

        const children = node.children;
        for (let i = 0; i < children.length; i++) {
            if (this._walk(children[i]!, material, false)) keep = true;
        }

        if (!keep && !isRoot) this._background.push(node);
        return keep;
    }

    /** Apply the overrides for `pass`. Must be paired with {@link restore}. */
    apply(pass: GIPass): void {
        const scale = 1 / this.maxIntensity;

        for (let i = 0; i < this._background.length; i++) {
            const node = this._background[i]!;
            this._save(node);
            node.visible = false;
        }

        for (let i = 0; i < this._participants.length; i++) {
            const { node, material } = this._participants[i]!;
            this._save(node);

            if (pass === 'emissive') {
                if (!material.emits) {
                    node.visible = false;
                    continue;
                }
                // Intensity is folded into the 8-bit tint and undone by
                // `uEmissiveScale`, so relative HDR intensities are quantised.
                const k = material.intensity * scale;
                node.tint =
                    ((material.r * k) << 16) | ((material.g * k) << 8) | (material.b * k);
                node.alpha = 1;
                node.blendMode = 'add';
                if (material.emissiveMap && isTexturable(node)) swapTexture(node, material.emissiveMap);
            } else if (pass === 'normal') {
                // Un-mapped objects stay out of the buffer entirely; the shader
                // reads its alpha as "is there a normal here".
                if (!material.normalMap || !isTexturable(node)) {
                    node.visible = false;
                    continue;
                }
                node.tint = 0xffffff;
                node.alpha = 1;
                node.blendMode = 'normal';
                swapTexture(node, material.normalMap);
            } else {
                if (!material.occludes) {
                    node.visible = false;
                    continue;
                }
                node.tint = 0x000000;
                node.alpha = material.occlusion;
                node.blendMode = 'normal';
                if (material.occlusionMap && isTexturable(node)) swapTexture(node, material.occlusionMap);
            }
        }
    }

    restore(): void {
        for (let i = this._savedCount - 1; i >= 0; i--) {
            const s = this._saved[i]!;
            const node = s.node!;
            node.visible = s.visible;
            node.tint = s.tint;
            node.alpha = s.alpha;
            node.blendMode = s.blendMode;
            if (s.texture !== undefined) {
                (node as Texturable).texture = s.texture;
                node.scale.set(s.scaleX, s.scaleY);
            }
            s.node = null;
            s.texture = undefined;
        }
        this._savedCount = 0;
    }

    // ponytail: pooled records -- this runs for every node, every pass, every frame.
    private _savedCount = 0;

    private _save(node: Container): void {
        let s = this._saved[this._savedCount];
        if (!s) {
            s = {
                node: null,
                visible: true,
                tint: 0,
                alpha: 1,
                blendMode: 'normal',
                texture: undefined,
                scaleX: 1,
                scaleY: 1,
            };
            this._saved.push(s);
        }
        this._savedCount++;
        s.node = node;
        s.visible = node.visible;
        s.tint = node.tint;
        s.alpha = node.alpha;
        s.blendMode = node.blendMode;
        s.texture = isTexturable(node) ? node.texture : undefined;
        s.scaleX = node.scale.x;
        s.scaleY = node.scale.y;
    }
}
