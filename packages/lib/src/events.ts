import { EventBoundary, Point } from 'pixi.js';
import type { FederatedMouseEvent } from 'pixi.js';
import type { RadianceCascades } from './gi';

/**
 * The types the boundary has mappings for and that {@link RadianceCascades.view}
 * can actually receive. `click` / `pointertap` / `pointerenter` are synthesised
 * downstream by the boundary itself, so forwarding them would double them up.
 */
const FORWARDED = [
    'pointerdown',
    'pointermove',
    'pointerup',
    'pointerupoutside',
    'pointerover',
    'pointerout',
    'wheel',
] as const;

/**
 * Make the world container interactive again.
 *
 * PixiJS hit-tests from whatever it rendered last, which is the stage -- and the
 * world is deliberately *not* on the stage, so nothing in it would ever see a
 * pointer. This puts a second {@link EventBoundary} over the world and feeds it
 * the events that land on {@link RadianceCascades.view}, which covers exactly
 * the pixels the world was drawn into. From there `eventMode`, `cursor`,
 * `click`, `pointerenter`, `hitArea` and the rest behave as they always do.
 *
 * ```ts
 * const detach = enableWorldEvents(gi);
 * sprite.eventMode = 'static';
 * sprite.on('pointertap', () => ...);
 * ```
 *
 * UI on the stage *above* `gi.view` keeps swallowing pointers before the world
 * ever sees them, which is what you want.
 *
 * @returns a function that unsubscribes. Call it before {@link RadianceCascades.destroy}.
 */
export function enableWorldEvents(gi: RadianceCascades): () => void {
    const view = gi.view;
    const boundary = new EventBoundary(gi.world);
    const local = new Point();
    const wasEventMode = view.eventMode ?? 'passive';
    const wasCursor = view.cursor ?? 'inherit';

    view.eventMode = 'static';

    const forward = (e: FederatedMouseEvent): void => {
        // The boundary hit-tests against `world`'s own transform, so it wants
        // coordinates in the space the world was rendered into -- the albedo
        // buffer, which is the view's unit quad blown up to the logical size.
        // Undoing the view's transform and reapplying its scale is the identity
        // for a view sitting at the stage origin, and the correction for one
        // that has been moved, letterboxed or scaled.
        view.worldTransform.applyInverse(e.global, local);
        const { x, y } = e.global;
        e.global.set(local.x * view.scale.x, local.y * view.scale.y);
        boundary.mapEvent(e);
        // The upstream event is still bubbling up the stage after us, and it is
        // pooled, so it goes back exactly as it came in.
        e.global.set(x, y);
        // The event system applies the *root* boundary's cursor after we return,
        // and it takes it from the target it hit -- which is the view. Handing it
        // up this way is what makes `cursor` on a world sprite work.
        if (e.type === 'pointermove') view.cursor = boundary.cursor;
    };

    for (const type of FORWARDED) view.on(type as 'pointerdown', forward);

    return () => {
        for (const type of FORWARDED) view.off(type as 'pointerdown', forward);
        view.eventMode = wasEventMode;
        view.cursor = wasCursor;
    };
}
