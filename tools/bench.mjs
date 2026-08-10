/**
 * Benchmark + regression harness for the GI pipeline.
 *
 * Drives the demo in headless Chrome under the same hand-stepped, seeded clock
 * `compare.mjs` uses, then records two things per run:
 *
 *  - `stages`: the GpuProfiler's timer-query numbers, which is what "faster"
 *    actually means here -- `hrc` is the whole cascade hierarchy.
 *  - a PNG of the final frame, so a speed-up that changed the picture is caught
 *    rather than celebrated.
 *
 *     node tools/bench.mjs --label before
 *     node tools/bench.mjs --label after --against before
 *
 * The comparison is the same statistics `compare.mjs` uses for its two backends,
 * pointed at two revisions of one backend instead.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    `${process.env.LOCALAPPDATA}/Google/Chrome/Application/chrome.exe`,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find((p) => existsSync(p));
const PORT = 8485;
const WIDTH = 900;
const HEIGHT = 600;
const OUT = new URL('../.bench/', import.meta.url);

const args = process.argv.slice(2);
const flag = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : fallback;
};
const LABEL = flag('label', 'run');
const AGAINST = flag('against', '');
const SCENE = flag('scene', 'sand');
const BACKEND = flag('backend', 'webgl');
const RESOLUTION = Number(flag('resolution', 0.5));
/** 0 = as many cascades as the buffer holds. */
const CASCADES = Number(flag('cascades', 0));
/** `--repeat merge=2` runs that sub-stage twice; the delta is its own cost. */
const REPEAT = Object.fromEntries(
    (flag('repeat', '') ? flag('repeat', '').split(',') : []).map((s) => {
        const [k, v] = s.split('=');
        return [k, Number(v ?? 2)];
    }),
);
const WARMUP = Number(flag('warmup', 120));
const FRAMES = Number(flag('frames', 900));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DETERMINISM = `
    let _s;
    globalThis.__reseed = () => { _s = 12345 >>> 0; };
    globalThis.__reseed();
    Math.random = () => (_s = (_s * 1664525 + 1013904223) >>> 0) / 4294967296;
    globalThis.requestAnimationFrame = () => 0;
    globalThis.cancelAnimationFrame = () => {};
`;

async function main() {
    if (!CHROME) throw new Error('no Chrome found');
    const server = await serve();
    const browser = await launchChrome();
    try {
        const run = await capture(browser.port);
        mkdirSync(OUT, { recursive: true });
        writeFileSync(new URL(`${LABEL}.png`, OUT), Buffer.from(run.png, 'base64'));
        const { png, ...meta } = run;
        writeFileSync(new URL(`${LABEL}.json`, OUT), JSON.stringify(meta, null, 2));
        report(run);

        if (AGAINST) {
            const base = JSON.parse(readFileSync(new URL(`${AGAINST}.json`, OUT), 'utf8'));
            const basePng = readFileSync(new URL(`${AGAINST}.png`, OUT)).toString('base64');
            const diff = await analyse(browser.port, basePng, run.png);
            compare(base, meta, diff);
        }
    } finally {
        browser.proc.kill();
        server.kill();
    }
}

async function capture(port) {
    const page = await newPage(port);
    try {
        await page.send('Page.addScriptToEvaluateOnNewDocument', { source: DETERMINISM });
        await page.send('Emulation.setDeviceMetricsOverride', {
            width: WIDTH,
            height: HEIGHT,
            deviceScaleFactor: 1,
            mobile: false,
        });
        await page.send('Page.navigate', { url: `http://localhost:${PORT}/?backend=${BACKEND}` });

        for (let i = 0; i < 120 && !(await page.eval('!!globalThis.__gi').catch(() => false)); i++) {
            await sleep(250);
        }
        if (!(await page.eval('!!globalThis.__gi').catch(() => false))) {
            throw new Error(`the demo never booted\n${messages(page.events).join('\n')}`);
        }

        await page.eval(`__gi.hud(false); __gi.scene(${JSON.stringify(SCENE)});
            document.querySelector('.tp-dfwv')?.remove(); 1`);
        await page.eval(`__gi.quality(${RESOLUTION}, ${CASCADES}); __gi.repeat(${JSON.stringify(REPEAT)}); 1`);

        // Warm up: shader compiles, texture uploads and the first few frames of
        // the scene's own settling are not what is being measured.
        await page.eval(`__reseed(); __gi.step(${WARMUP}); 1`);
        await sleep(300);
        await page.eval('__gi.reset(); 1');

        // The measured window. Stepped in chunks with a yield between them, so
        // the GPU actually retires work instead of the whole run queueing up
        // behind one script task and the timer queries draining at the end.
        const CHUNK = 60;
        const wall = [];
        for (let done = 0; done < FRAMES; done += CHUNK) {
            wall.push(await page.eval(`(() => { const t = performance.now();
                __gi.step(${Math.min(CHUNK, FRAMES - done)}); return performance.now() - t; })()`));
            await sleep(16);
        }
        await sleep(400);

        const shot = await page.send('Page.captureScreenshot', { format: 'png' });
        const out = JSON.parse(await page.eval('JSON.stringify(__gi.report())'));
        // The round-robin only samples one stage per rotation, so a stage that
        // never comes up reads as "free" rather than "unmeasured". Surfacing the
        // rotation order is what tells the two apart.
        out.order = await page.eval('JSON.stringify(__gi.instance().profiler._order)');
        return {
            label: LABEL,
            scene: SCENE,
            backend: BACKEND,
            resolution: RESOLUTION,
            frames: FRAMES,
            png: shot.data,
            gpu: out.gpu,
            precise: out.precise,
            discarded: out.discarded,
            stats: out.stats,
            size: out.size,
            stages: out.stages,
            order: out.order,
            giCpuMs: out.giCpuMs,
            /** Wall ms per frame over the stepped run -- CPU submit plus whatever back-pressure. */
            wallMs: wall.reduce((a, b) => a + b, 0) / FRAMES,
            messages: messages(page.events).filter((m) => !m.includes('[vite]')),
        };
    } finally {
        await page.close();
    }
}

function report(run) {
    console.log(`\n${run.label}: ${run.gpu}`);
    console.log(`${run.size.join('x')} @ ${run.resolution}  ->  ${run.stats.cascades} cascades @ ${run.stats.giWidth}px`);
    console.log(`timer queries: ${run.precise ? 'precise' : 'gl.finish() fallback'}, ${run.discarded} discarded`);
    let total = 0;
    for (const [name, s] of Object.entries(run.stages)) {
        total += s.median;
        console.log(`  ${name.padEnd(10)} ${s.median.toFixed(3)} ms  (mean ${s.mean.toFixed(3)}, p95 ${s.p95.toFixed(3)}, n=${s.n})`);
    }
    console.log(`  ${'TOTAL'.padEnd(10)} ${total.toFixed(3)} ms`);
    console.log(`  wall       ${run.wallMs.toFixed(3)} ms/frame    gi cpu ${run.giCpuMs.median.toFixed(3)} ms`);
    const bad = run.messages.filter((m) => /\[error|\[exception|\[warning:rendering/.test(m));
    if (bad.length) console.log(`\n${bad.length} error line(s):\n  ${bad.join('\n  ')}`);
}

function compare(base, now, diff) {
    console.log(`\n=== ${now.label} vs ${base.label} ===`);
    const names = new Set([...Object.keys(base.stages), ...Object.keys(now.stages)]);
    let bt = 0;
    let nt = 0;
    for (const name of names) {
        const b = base.stages[name]?.median ?? 0;
        const n = now.stages[name]?.median ?? 0;
        bt += b;
        nt += n;
        console.log(`  ${name.padEnd(10)} ${b.toFixed(3)} -> ${n.toFixed(3)} ms   ${speed(b, n)}`);
    }
    console.log(`  ${'TOTAL'.padEnd(10)} ${bt.toFixed(3)} -> ${nt.toFixed(3)} ms   ${speed(bt, nt)}`);
    console.log(`  ${'wall'.padEnd(10)} ${base.wallMs.toFixed(3)} -> ${now.wallMs.toFixed(3)} ms   ${speed(base.wallMs, now.wallMs)}`);

    console.log('\nimage:');
    if (diff.error) {
        console.log(`  FAIL ${diff.error}`);
        process.exitCode = 1;
        return;
    }
    const ok = diff.meanDiff < 0.0005 && diff.worstBlockDiff < 0.01;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} mean ${(diff.meanDiff * 100).toFixed(4)}%, worst 16x16 block ` +
        `${(diff.worstBlockDiff * 100).toFixed(4)}% at ${diff.worstBlockAt.join(',')}`);
    console.log(`  luma ${diff.frames[0].meanLuma.toFixed(5)} -> ${diff.frames[1].meanLuma.toFixed(5)}`);
    if (!ok) process.exitCode = 1;
}

const speed = (before, after) =>
    after <= 0 || before <= 0 ? '' : `${(before / after).toFixed(2)}x ${before / after >= 1 ? 'faster' : 'SLOWER'}`;

async function analyse(port, aPng, bPng) {
    const page = await newPage(port);
    try {
        await page.send('Page.navigate', { url: `http://localhost:${PORT}/` });
        await sleep(300);
        return await page.eval(`(${STATS.toString()})(${JSON.stringify(aPng)}, ${JSON.stringify(bPng)})`);
    } finally {
        await page.close();
    }
}

const STATS = async (aB64, bB64) => {
    const load = async (b64) => {
        const img = new Image();
        img.src = `data:image/png;base64,${b64}`;
        await img.decode();
        const canvas = new OffscreenCanvas(img.width, img.height);
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0);
        return { data: ctx.getImageData(0, 0, img.width, img.height).data, w: img.width, h: img.height };
    };
    const a = await load(aB64);
    const b = await load(bB64);
    if (a.w !== b.w || a.h !== b.h) return { error: `size ${a.w}x${a.h} vs ${b.w}x${b.h}` };

    const luma = (d, i) => (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
    const frame = (f) => {
        let sum = 0;
        for (let i = 0; i < f.data.length; i += 4) sum += luma(f.data, i);
        return { meanLuma: sum / (f.data.length / 4) };
    };

    let diff = 0;
    let worst = 0;
    const bw = Math.ceil(a.w / 16);
    const blocks = new Float64Array(bw * Math.ceil(a.h / 16));
    const counts = new Float64Array(blocks.length);
    for (let y = 0; y < a.h; y++) {
        for (let x = 0; x < a.w; x++) {
            const i = (y * a.w + x) * 4;
            const d = (Math.abs(a.data[i] - b.data[i])
                + Math.abs(a.data[i + 1] - b.data[i + 1])
                + Math.abs(a.data[i + 2] - b.data[i + 2])) / (3 * 255);
            diff += d;
            const bi = (y >> 4) * bw + (x >> 4);
            blocks[bi] += d;
            counts[bi]++;
        }
    }
    let worstAt = 0;
    for (let i = 0; i < blocks.length; i++) {
        if (blocks[i] / counts[i] <= worst) continue;
        worst = blocks[i] / counts[i];
        worstAt = i;
    }
    return {
        size: [a.w, a.h],
        frames: [frame(a), frame(b)],
        meanDiff: diff / (a.w * a.h),
        worstBlockDiff: worst,
        worstBlockAt: [(worstAt % bw) * 16, ((worstAt / bw) | 0) * 16],
    };
};

// --- plumbing ---------------------------------------------------------------

function serve() {
    // Node on the entry script rather than the `.bin` shim: a shell wrapper on
    // Windows swallows the kill and leaves the port held for the next run.
    const bin = new URL('../node_modules/vite/bin/vite.js', import.meta.url);
    const proc = spawn(process.execPath, [decodeURI(bin.pathname).replace(/^\//, ''), '--port', String(PORT), '--strictPort'], {
        cwd: decodeURI(new URL('../packages/demo/', import.meta.url).pathname).replace(/^\//, ''),
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    return new Promise((res, rej) => {
        const done = setTimeout(() => rej(new Error('vite did not start')), 30000);
        proc.stdout.on('data', (d) => {
            if (String(d).includes('ready in')) {
                clearTimeout(done);
                res(proc);
            }
        });
        proc.stderr.on('data', (d) => process.stderr.write(String(d)));
        proc.on('error', rej);
    });
}

async function launchChrome() {
    const port = 9700 + (process.pid % 200);
    const proc = spawn(CHROME, [
        '--headless=new',
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${mkdtempSync(join(tmpdir(), 'gi-bench-'))}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--hide-scrollbars',
        '--mute-audio',
        `--window-size=${WIDTH},${HEIGHT}`,
        // Real GPU, no frame pacing, and the draft extension the profiler's
        // timer queries live behind.
        '--enable-webgl-draft-extensions',
        '--enable-unsafe-webgpu',
        '--disable-gpu-vsync',
        '--disable-frame-rate-limit',
        '--ignore-gpu-blocklist',
        '--enable-gpu-rasterization',
        'about:blank',
    ], { stdio: 'ignore' });
    for (let i = 0; i < 100; i++) {
        try {
            if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) return { proc, port };
        } catch {
            await sleep(100);
        }
    }
    proc.kill();
    throw new Error('chrome did not open a debug port');
}

async function newPage(port) {
    const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
        ws.onopen = res;
        ws.onerror = rej;
    });
    let id = 0;
    const pending = new Map();
    const events = [];
    ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.id === undefined) return events.push(msg);
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) p.rej(new Error(msg.error.message));
        else p.res(msg.result);
    };
    const send = (method, params = {}) =>
        new Promise((res, rej) => {
            const n = ++id;
            pending.set(n, { res, rej });
            ws.send(JSON.stringify({ id: n, method, params }));
        });
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Log.enable');
    return {
        send,
        events,
        close: async () => {
            ws.close();
            await fetch(`http://127.0.0.1:${port}/json/close/${target.id}`);
        },
        async eval(expression) {
            const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
            if (r.exceptionDetails) {
                throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
            }
            return r.result.value;
        },
    };
}

function messages(events) {
    const out = [];
    for (const e of events) {
        if (e.method === 'Runtime.consoleAPICalled') {
            out.push(`[${e.params.type}] ${e.params.args.map((a) => a.value ?? a.description ?? '').join(' ')}`);
        } else if (e.method === 'Runtime.exceptionThrown') {
            out.push(`[exception] ${e.params.exceptionDetails.exception?.description ?? e.params.exceptionDetails.text}`);
        } else if (e.method === 'Log.entryAdded') {
            out.push(`[${e.params.entry.level}:${e.params.entry.source}] ${e.params.entry.text}`);
        }
    }
    return out;
}

await main();
