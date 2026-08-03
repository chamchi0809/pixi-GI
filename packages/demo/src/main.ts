import { Application, Container, Text, UPDATE_PRIORITY } from "pixi.js";
import { GpuProfiler, RadianceCascades } from "pixi-rcgi";
import { keyOf } from "./keys";
import { createPlatformerScene } from "./platformer";
import { createSandScene } from "./sand/scene";
import type { Scene } from "./scene";

async function main(): Promise<void> {
  const app = new Application();
  await app.init({
    preference: "webgl",
    background: 0x05060a,
    antialias: false,
    resizeTo: window,
    resolution: Math.min(globalThis.devicePixelRatio || 1, 2),
    autoDensity: true,
  });
  document.body.appendChild(app.canvas);

  const scenes: Scene[] = [
    createSandScene(app.canvas),
    await createPlatformerScene(),
  ];
  let index = 0;

  // The world is NOT added to the stage -- the GI renders it and gives us `view`.
  // Only the active scene's root lives in here.
  const world = new Container();

  // `resolution` / `probeSpacing` are fixed at construction (they decide every
  // buffer size), so switching quality means a new instance. Everything else is
  // a runtime setter, so switching *scenes* does not.
  const QUALITY = [
    { name: "pixel", resolution: 1, probeSpacing: 1 },
    { name: "sharp", resolution: 1, probeSpacing: 2 },
    { name: "fast", resolution: 0.5, probeSpacing: 2 },
  ] as const;
  let quality = 2; // "fast"
  let giEnabled = true;
  let showDebug = true;
  let exposure = 0.95;

  const makeGI = (): RadianceCascades =>
    new RadianceCascades({
      renderer: app.renderer,
      world,
      resolution: QUALITY[quality]!.resolution,
      probeSpacing: QUALITY[quality]!.probeSpacing,
      sky: 0x000000,
      strength: giEnabled ? 1 : 0,
      exposure,
    });

  let gi = makeGI();
  const profiler = new GpuProfiler(app.renderer);
  gi.profiler = profiler;
  /** Wall-clock frame times, for the headroom number the stage timings cannot give. */
  const frames: number[] = [];
  /** CPU time in the scene simulation and in issuing the GI, kept apart. */
  const cpu = { sim: [] as number[], gi: [] as number[] };

  const applyScene = (next: number): void => {
    scenes[index]!.active = false;
    index = next;
    const scene = scenes[index]!;
    scene.active = true;
    world.removeChildren();
    world.addChild(scene.root);
    world.position.set(0, 0);

    // Walls are outside the cascades, so they get their own model: a dark
    // floor plus direct falloff from every emitter. Each scene wants its own.
    const l = scene.lighting;
    gi.ambient = giEnabled ? l.ambient : l.ambientOff;
    gi.occluderAmbient = l.occluderAmbient;
    gi.occluderLightRange = l.occluderLightRange;
    gi.occluderLightHeight = l.occluderLightHeight;
    gi.occluderLightStrength = l.occluderLightStrength;
    gi.background = l.background;
    gi.emissiveBoost = l.emissiveBoost;
  };
  applyScene(0);
  app.stage.addChild(gi.view);

  const setQuality = (next: number): void => {
    quality = next;
    gi.destroy();
    gi = makeGI();
    gi.profiler = profiler;
    applyScene(index);
    app.stage.addChildAt(gi.view, 0);
    profiler.reset();
    frames.length = 0;
  };

  const hud = new Text({
    text: "",
    style: {
      fill: 0xdfe6f2,
      fontFamily: "monospace",
      fontSize: 13,
      lineHeight: 18,
    },
  });
  hud.position.set(12, 10);
  app.stage.addChild(hud);

  const keys = new Set<string>();
  let wasPressed = new Set<string>();
  addEventListener("keydown", (e) => {
    if (e.code === "Tab") e.preventDefault(); // it switches demos, not focus
    keys.add(keyOf(e));
  });
  addEventListener("keyup", (e) => keys.delete(keyOf(e)));
  addEventListener("blur", () => keys.clear());
  const tapped = (key: string): boolean =>
    keys.has(key) && !wasPressed.has(key);

  app.ticker.add(
    (ticker) => {
      const dt = Math.min(ticker.deltaMS / 1000, 1 / 30);
      const scene = scenes[index]!;

      if (tapped("tab")) applyScene((index + 1) % scenes.length);
      if (tapped("g")) {
        giEnabled = !giEnabled;
        gi.strength = giEnabled ? 1 : 0;
        gi.ambient = giEnabled
          ? scene.lighting.ambient
          : scene.lighting.ambientOff;
      }
      if (tapped("h")) showDebug = !showDebug;
      if (tapped("q")) setQuality((quality + 1) % QUALITY.length);
      if (keys.has("[")) exposure = Math.max(0.1, exposure - dt * 1.5);
      if (keys.has("]")) exposure = Math.min(4, exposure + dt * 1.5);
      gi.exposure = exposure;
      wasPressed = new Set(keys);

      const view = app.renderer.screen;
      const t0 = performance.now();
      scenes[index]!.update(dt, view.width, view.height);
      const camera = scenes[index]!.camera;
      if (camera) world.position.set(camera.x, camera.y);
      const t1 = performance.now();
      gi.resize(view.width, view.height);
      gi.render();
      cpu.sim.push(t1 - t0);
      cpu.gi.push(performance.now() - t1);
      if (cpu.sim.length > 4096) {
        cpu.sim.shift();
        cpu.gi.shift();
      }
      // gi.render() closed its last stage; this one covers the composite, which
      // PixiJS draws at UPDATE_PRIORITY.LOW, and is closed at UTILITY below.
      profiler.begin("composite");
      frames.push(ticker.deltaMS);
      if (frames.length > 4096) frames.shift();

      const s = gi.stats;
      hud.visible = showDebug;
      // Assigning `text` re-rasterises the canvas and re-uploads the texture, so
      // a hidden HUD must not be updated -- it is not free just because it is
      // invisible, and it would show up in any profile taken with H pressed.
      if (!showDebug) return;
      hud.text = [
        `TAB: demo [${scene.name}]    G: global illumination [${giEnabled ? "on" : "off"}]    [ ] exposure ${exposure.toFixed(2)}    H: hide`,
        `Q: quality [${QUALITY[quality]!.name}]    ${s.cascades} cascades @ ${s.giWidth}x${s.giHeight}    ${ticker.FPS.toFixed(0)} fps`,
        ...scene.status(),
      ].join("\n");
    },
    null,
    UPDATE_PRIORITY.HIGH,
  );

  // Runs after PixiJS' own render (UPDATE_PRIORITY.LOW), so it closes the
  // composite timing and drains whatever the GPU has finished.
  app.ticker.add(
    () => {
      profiler.end();
      profiler.poll();
    },
    null,
    UPDATE_PRIORITY.UTILITY,
  );

  // Driven over CDP by `tools/profile.mjs`. Harmless in normal use.
  const gl = (app.renderer as { gl?: WebGL2RenderingContext }).gl;
  const info = gl?.getExtension("WEBGL_debug_renderer_info");
  (globalThis as Record<string, unknown>)["__gi"] = {
    quality: (name: string) => {
      const next = QUALITY.findIndex((q) => q.name === name);
      if (next >= 0 && next !== quality) setQuality(next);
      return QUALITY[quality]!.name;
    },
    scene: (name: string) => {
      const next = scenes.findIndex((s) => s.name === name);
      if (next >= 0 && next !== index) applyScene(next);
      return scenes[index]!.name;
    },
    hud: (on: boolean) => {
      showDebug = on;
    },
    reset: () => {
      profiler.reset();
      frames.length = 0;
      cpu.sim.length = 0;
      cpu.gi.length = 0;
    },
    repeat: (map: Record<string, number>) => {
      gi.repeat = map;
    },
    /** Hiding the view drops the composite draw; the frame-time delta is its cost. */
    composite: (on: boolean) => {
      gi.view.visible = on;
    },
    report: () => ({
      gpu: info ? gl?.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl?.getParameter(gl.RENDERER),
      precise: profiler.precise,
      discarded: profiler.discarded,
      quality: QUALITY[quality]!.name,
      scene: scenes[index]!.name,
      size: [app.renderer.screen.width, app.renderer.screen.height],
      stats: gi.stats,
      stages: profiler.report(),
      frameMs: summarise(frames),
      simMs: summarise(cpu.sim),
      giCpuMs: summarise(cpu.gi),
    }),
  };
}

function summarise(values: number[]): { mean: number; median: number; p95: number; n: number } {
  if (values.length === 0) return { mean: 0, median: 0, p95: 0, n: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    mean: sum / sorted.length,
    median: sorted[sorted.length >> 1]!,
    p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]!,
    n: sorted.length,
  };
}

main().catch((error: unknown) => {
  const box = document.getElementById("error");
  if (box) {
    box.style.display = "grid";
    box.textContent = String(
      error instanceof Error ? (error.stack ?? error.message) : error,
    );
  }
  console.error(error);
});
