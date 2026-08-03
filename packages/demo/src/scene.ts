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
    update(dt: number, width: number, height: number): void;
    /** HUD lines, shown under the shared controls. */
    status(): string[];
}
