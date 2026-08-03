import type { Container } from 'pixi.js';

/** The GI settings a scene wants. All of these are runtime-mutable on the instance. */
export interface SceneLighting {
    /** Flat light everywhere the cascades reach. Second value is used when GI is off. */
    ambient: number;
    ambientOff: number;
    occluderAmbient: number;
    occluderLightRange: number;
    occluderLightHeight: number;
    occluderLightStrength: number;
    background: number;
    emissiveBoost: number;
}

/** One switchable demo. `main.ts` owns the GI; a scene owns its world and its input. */
export interface Scene {
    readonly name: string;
    /** Handed to the GI as its world. Never added to the stage.  */
    readonly root: Container;
    readonly lighting: SceneLighting;
    /** Scenes gate their own listeners on this rather than binding/unbinding. */
    active: boolean;
    /**
     * Camera offset in world pixels, updated by `update`. `main` scales it by the
     * zoom and puts it on the GI world rather than letting the scene scroll its
     * own root: the lighting has to know the camera to keep its probe lattice
     * pinned to the world, and it reads it from the world transform. Omit it to
     * stay at 0,0 -- and to opt out of the zoom, which needs a camera to be
     * meaningful.
     */
    readonly camera?: { x: number; y: number };
    /** `width`/`height` are the visible area in *world* pixels, i.e. after the zoom. */
    update(dt: number, width: number, height: number): void;
    /** HUD lines, shown under the shared controls. */
    status(): string[];
}
