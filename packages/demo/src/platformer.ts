import { Assets, type Texture } from 'pixi.js';
import type { Scene } from './scene';
import { keyOf } from './keys';
import { buildLevel, LEVEL_HEIGHT, LEVEL_WIDTH, type LevelTextures } from './level';
import { Player, type Input } from './player';
import { bevelNormal, grateMask } from './textures';

const TILE_FILES = [
    'stoneCenter',
    'brickWall',
    'grassMid',
    'grassCenter',
    'box',
    'tochLit',
    'liquidLavaTop_mid',
    'window',
] as const;
const ITEM_FILES = ['gemBlue', 'gemRed', 'coinGold', 'star', 'plant'] as const;
const PLAYER_FILES = ['p1_stand', 'p1_jump', 'p1_duck'] as const;

async function loadTextures(): Promise<Record<string, Texture>> {
    const manifest: Record<string, string> = {};
    for (const n of TILE_FILES) manifest[n] = `assets/tiles/${n}.png`;
    for (const n of ITEM_FILES) manifest[n] = `assets/items/${n}.png`;
    for (const n of PLAYER_FILES) manifest[n] = `assets/player/${n}.png`;
    for (let i = 1; i <= 11; i++) {
        const id = String(i).padStart(2, '0');
        manifest[`walk${id}`] = `assets/player/p1_walk${id}.png`;
    }
    Assets.addBundle('demo', manifest);
    return Assets.loadBundle('demo') as Promise<Record<string, Texture>>;
}

export async function createPlatformerScene(): Promise<Scene> {
    const tex = await loadTextures();

    const levelTextures: LevelTextures = {
        stoneCenter: tex['stoneCenter']!,
        brickWall: tex['brickWall']!,
        grassMid: tex['grassMid']!,
        grassCenter: tex['grassCenter']!,
        box: tex['box']!,
        torch: tex['tochLit']!,
        lavaTop: tex['liquidLavaTop_mid']!,
        window: tex['window']!,
        gemBlue: tex['gemBlue']!,
        gemRed: tex['gemRed']!,
        coin: tex['coinGold']!,
        star: tex['star']!,
        plant: tex['plant']!,
        grate: grateMask(),
        bevel: bevelNormal(),
    };

    const level = buildLevel(levelTextures);
    const player = new Player(level, {
        stand: tex['p1_stand']!,
        jump: tex['p1_jump']!,
        duck: tex['p1_duck']!,
        walk: Array.from({ length: 11 }, (_, i) => tex[`walk${String(i + 1).padStart(2, '0')}`]!),
    });
    level.root.addChild(player.view);

    const keys = new Set<string>();
    const input: Input = { left: false, right: false, down: false, jump: false };
    const sync = (): void => {
        input.left = keys.has('arrowleft') || keys.has('a');
        input.right = keys.has('arrowright') || keys.has('d');
        input.down = keys.has('arrowdown') || keys.has('s');
        input.jump = keys.has(' ') || keys.has('arrowup') || keys.has('w');
    };
    const clear = (): void => {
        keys.clear();
        sync();
    };
    addEventListener('keydown', (e) => {
        if (!scene.active) return;
        const k = keyOf(e);
        keys.add(k);
        if ([' ', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) {
            e.preventDefault();
        }
        sync();
    });
    addEventListener('keyup', (e) => {
        keys.delete(keyOf(e));
        sync();
    });
    addEventListener('blur', clear);

    const scene: Scene = {
        name: 'platformer',
        // The level scrolls by `scene.camera`, which `main` puts on the GI world.
        root: level.root,
        active: false,
        camera: { x: 0, y: 0 },
        lighting: {
            ambient: 0x0a0d14,
            ambientOff: 0xb4bcc8,
            occluderAmbient: 0x141821,
            occluderLightRange: 320,
            occluderLightHeight: 44,
            occluderLightStrength: 1,
            background: 0x05060a,
            emissiveBoost: 1,
        },
        update(dt, width, height) {
            if (!scene.active) clear();
            player.update(dt, input);
            scene.camera!.x = clamp(width / 2 - player.view.x, Math.min(0, width - LEVEL_WIDTH), 0);
            scene.camera!.y = clamp(height / 2 - player.view.y, Math.min(0, height - LEVEL_HEIGHT), 0);
        },
        status: () => ['move: A/D or ←/→    jump/double jump: space/W    duck: S    click a torch to snuff it'],
    };
    return scene;
}

function clamp(v: number, lo: number, hi: number): number {
    return Math.min(Math.max(v, lo), hi);
}
