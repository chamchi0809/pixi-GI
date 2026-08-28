import { Application, Container, Text, UPDATE_PRIORITY } from "pixi.js";
import { GpuProfiler, RadianceCascades, enableWorldEvents } from "pixi-rcgi";
import { Pane } from "tweakpane";
import { createPlatformerScene } from "./platformer";
import { createSandScene } from "./sand/scene";
import type { Scene } from "./scene";

/** `preference` is fixed at `Application.init`, so switching backends means a reload. */
const BACKEND_KEY = "gi.backend";

async function main(): Promise<void> {
  // `?backend=` wins, so the CDP harness can pick one without touching storage.
  const query = new URLSearchParams(location.search).get("backend");
  const backend = (query ?? localStorage.getItem(BACKEND_KEY)) === "webgpu" ? "webgpu" : "webgl";
  const app = new Application();
  await app.init({
    preference: backend,
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

  // `resolution` and `cascades` are fixed at construction (they decide every
  // buffer size), so changing either means a new instance. Everything else is a
  // runtime setter, so switching *scenes* does not.
  const params = {
    backend,
    scene: 0,
    gi: true,
    hud: true,
    resolution: 0.25,
    /** 0 = as many cascades as the buffer holds. */
    cascades: 0,
    smoothing: 1,
    temporal: 0,
    exposure: 0.95,
    zoom: 1,
  };

  const makeGI = (): RadianceCascades =>
    new RadianceCascades({
      renderer: app.renderer,
      world,
      resolution: params.resolution,
      ...(params.cascades > 0 ? { cascades: params.cascades } : {}),
      smoothing: params.smoothing,
      temporal: params.temporal,
      strength: params.gi ? 1 : 0,
      exposure: params.exposure,
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
    index = params.scene = next;
    const scene = scenes[index]!;
    scene.active = true;
    world.removeChildren();
    world.addChild(scene.root);
    world.position.set(0, 0);

    // Walls are outside the cascades, so they get their own model: a dark
    // floor plus direct falloff from every emitter. Each scene wants its own.
    const l = scene.lighting;
    gi.ambient = params.gi ? l.ambient : l.ambientOff;
    gi.occluderAmbient = l.occluderAmbient;
    gi.occluderLightRange = l.occluderLightRange;
    gi.occluderLightHeight = l.occluderLightHeight;
    gi.occluderLightStrength = l.occluderLightStrength;
    gi.background = l.background;
    gi.emissiveBoost = l.emissiveBoost;
  };
  applyScene(0);
  app.stage.addChild(gi.view);
  // The world is off-stage, so pointers reach it only through the view.
  let detachEvents = enableWorldEvents(gi);

  /** Only for `resolution`/`cascades`; every other knob is a setter on the instance. */
  const rebuild = (): void => {
    detachEvents();
    gi.destroy();
    gi = makeGI();
    gi.profiler = profiler;
    applyScene(index);
    app.stage.addChildAt(gi.view, 0);
    detachEvents = enableWorldEvents(gi);
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

  const pane = new Pane({ title: "debug" });
  pane
    .addBinding(params, "backend", { options: { webgl: "webgl", webgpu: "webgpu" } })
    .on("change", (e) => {
      if (e.value === backend) return;
      localStorage.setItem(BACKEND_KEY, e.value);
      location.reload();
    });
  pane
    .addBinding(params, "scene", {
      options: Object.fromEntries(scenes.map((s, i) => [s.name, i])),
    })
    .on("change", (e) => {
      if (e.value !== index) applyScene(e.value);
    });
  pane.addBinding(params, "gi", { label: "global illumination" }).on("change", (e) => {
    gi.strength = e.value ? 1 : 0;
    const l = scenes[index]!.lighting;
    gi.ambient = e.value ? l.ambient : l.ambientOff;
  });
  pane.addBinding(params, "hud").on("change", (e) => {
    hud.visible = e.value;
  });
  pane
    .addBinding(params, "resolution", { min: 0.1, max: 1, step: 0.05 })
    .on("change", (e) => {
      if (e.last) rebuild();
    });
  pane
    // The cap is the buffer's own top level; above it `cascades` is clamped, so
    // the slider would silently stop moving the image.
    .addBinding(params, "cascades", { min: 0, max: 11, step: 1, label: "cascades (0=auto)" })
    .on("change", (e) => {
      if (e.last) rebuild();
    });
  // A runtime setter, unlike the two above it: the passes it adds read and write
  // buffers that already exist.
  pane
    .addBinding(params, "smoothing", { min: 0, max: 3, step: 1 })
    .on("change", (e) => {
      gi.smoothing = e.value;
    });
  // Also live: the first nonzero value allocates the history buffer, and from
  // there it is one number in a blend.
  pane
    .addBinding(params, "temporal", { min: 0, max: 0.98, step: 0.01 })
    .on("change", (e) => {
      gi.temporal = e.value;
    });
  pane.addBinding(params, "exposure", { min: 0.1, max: 4, step: 0.01 }).on("change", (e) => {
    gi.exposure = e.value;
  });
  pane.addBinding(params, "zoom", { min: 0.5, max: 3, step: 0.05 });
  hud.visible = params.hud;

  app.ticker.add(
    (ticker) => {
      const dt = Math.min(ticker.deltaMS / 1000, 1 / 30);
      const scene = scenes[index]!;
      const view = app.renderer.screen;
      // Zoom lives on the GI world, which is where the lighting reads the camera
      // from. A camera-less scene fits itself to whatever view it is given, so it
      // has to be told the *unzoomed* size -- shrink it too and the refit cancels
      // the zoom out -- and then centred, since the scale grows it from 0,0.
      const scale = params.zoom;
      world.scale.set(scale);
      const t0 = performance.now();
      const camera = scene.camera;
      const fit = camera ? scale : 1;
      scene.update(dt, view.width / fit, view.height / fit);
      if (camera) world.position.set(camera.x * scale, camera.y * scale);
      else world.position.set((view.width * (1 - scale)) / 2, (view.height * (1 - scale)) / 2);
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
      // Assigning `text` re-rasterises the canvas and re-uploads the texture, so
      // a hidden HUD must not be updated -- it is not free just because it is
      // invisible, and it would show up in any profile taken with it off.
      if (!hud.visible) return;
      hud.text = [
        `${s.cascades} cascades @ ${s.giWidth}x${s.giHeight}    zoom ${scale.toFixed(2)}x    ${ticker.FPS.toFixed(0)} fps`,
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

  /** Wall clock until `step` takes over. */
  let clock = performance.now();

  // Driven over CDP by the scripts in `tools/`. Harmless in normal use.
  const gl = (app.renderer as { gl?: WebGL2RenderingContext }).gl;
  const info = gl?.getExtension("WEBGL_debug_renderer_info");
  (globalThis as Record<string, unknown>)["__gi"] = {
    world,
    /** Live handle, so a probe can poke a setter without one knob per experiment. */
    instance: () => gi,
    quality: (resolution: number, cascades = 0) => {
      params.resolution = resolution;
      params.cascades = cascades;
      rebuild();
      pane.refresh();
    },
    scene: (name: string) => {
      const next = scenes.findIndex((s) => s.name === name);
      if (next >= 0 && next !== index) applyScene(next);
      pane.refresh();
      return scenes[index]!.name;
    },
    hud: (on: boolean) => {
      hud.visible = params.hud = on;
      pane.refresh();
    },
    /**
     * Take the clock off the wall: stop the ticker and advance it by hand, so a
     * given frame count is the same simulation on any machine or backend.
     */
    // A whole number of milliseconds from zero, so that every delta the ticker
    // computes is exactly `dt`: off a wall-clock baseline the subtraction lands a
    // few ulps out, and a scene's fixed-step accumulator turns that into a whole
    // step more or less of simulation.
    step: (frames = 1, dt = 16) => {
      app.ticker.stop();
      clock = app.ticker.lastTime = 0;
      for (let i = 0; i < frames; i++) app.ticker.update((clock += dt));
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
      resolution: params.resolution,
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
