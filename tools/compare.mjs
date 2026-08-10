/**
 * Render the demo on both backends under an identical, hand-stepped clock and
 * diff the two frames.
 *
 * The point is that one shader source has to behave the same on WebGL and
 * WebGPU: anything that only shows up on a device -- a WGSL validation error, a
 * uniform landing at the wrong offset, a render target format the pipeline does
 * not agree with -- is invisible to `pnpm check` and shows up here as a black or
 * wrong frame.
 *
 * Determinism comes from three things: `Math.random` is replaced with an LCG
 * before any page script runs, `__gi.step()` drives the ticker by hand at a
 * fixed dt, and both runs get the same window size. What is left is float
 * rounding, which is why the thresholds are ratios and not zero.
 *
 *     node tools/compare.mjs [--scene sand] [--frames 240] [--control] [--page material.html]
 *
 * `--control` renders WebGL twice instead. Same script, same thresholds, and the
 * only thing it can measure is the scene's own run-to-run noise -- so it is what
 * says whether a number the real run produced is a backend difference or not.
 *
 * ponytail: statistics over a whole frame, not per-pixel worst case. A tiny
 * wrong region can hide inside a 900x600 mean, so a failure here is definite
 * while a pass is "nothing big is wrong" -- add a per-block max if that bites.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 8484;
const WIDTH = 900;
const HEIGHT = 600;
const OUT = new URL('../.compare/', import.meta.url);

const args = process.argv.slice(2);
const flag = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : fallback;
};
const SCENE = flag('scene', 'sand');
/** Any page under the demo that presents `__gi` -- see `material.html`. */
const PAGE = flag('page', '');
const FRAMES = Number(flag('frames', 240));
const PAIR = args.includes('--control') ? ['webgl', 'webgl'] : ['webgl', 'webgpu'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Every page gets this before its own scripts, so that neither backend advances
 * by even one frame on its own: `__gi.step()` is then the only thing that moves
 * the simulation, and both runs see exactly the same input.
 *
 * Stubbing rAF is what makes it airtight -- otherwise the frames that run while
 * the page is still booting are however many the machine got through, which is a
 * different number on each backend.
 *
 * The LCG is re-seeded just before the stepped frames, not only at load: booting
 * draws from it too (the sand scene's world seed, asset loading) and *how many*
 * times is timing-dependent, so without this the two runs enter the simulation at
 * different points in the stream and the wizard's spark trail diverges.
 */
const DETERMINISM = `
    let _s;
    globalThis.__reseed = () => { _s = 12345 >>> 0; };
    globalThis.__reseed();
    Math.random = () => (_s = (_s * 1664525 + 1013904223) >>> 0) / 4294967296;
    globalThis.requestAnimationFrame = () => 0;
    globalThis.cancelAnimationFrame = () => {};
`;

async function main() {
    const server = await serve();
    const browser = await launchChrome();
    try {
        const runs = [];
        for (const backend of PAIR) {
            const run = await capture(browser.port, backend);
            runs.push(run);
            console.log(`${`${backend} ${run.gpu ?? ''}`.trim()}: ${run.stats.cascades} cascades, ${run.messages.length} log lines`);
        }
        const report = await analyse(browser.port, runs);
        process.exitCode = verdict(runs, report) ? 0 : 1;
    } finally {
        browser.proc.kill();
        server.kill();
    }
}

/** Renders one backend and returns its PNG plus everything the page said. */
async function capture(port, backend) {
    const page = await newPage(port);
    try {
        await page.send('Page.addScriptToEvaluateOnNewDocument', { source: DETERMINISM });
        await page.send('Emulation.setDeviceMetricsOverride', {
            width: WIDTH,
            height: HEIGHT,
            deviceScaleFactor: 1,
            mobile: false,
        });
        await page.send('Page.navigate', { url: `http://localhost:${PORT}/${PAGE}?backend=${backend}` });

        for (let i = 0; i < 80 && !(await page.eval('!!globalThis.__gi').catch(() => false)); i++) {
            await sleep(250);
        }
        if (!(await page.eval('!!globalThis.__gi').catch(() => false))) {
            throw new Error(`${backend}: the demo never finished booting\n${messages(page.events).join('\n')}`);
        }

        // Scene first: it rebuilds nothing, but it does reset the world. The debug
        // panel has to go too -- it spells out which backend this is, so leaving it
        // in makes the two frames differ over text that is *supposed* to differ.
        await page.eval(`__gi.hud(false); __gi.scene(${JSON.stringify(SCENE)});
            document.querySelector('.tp-dfwv')?.remove(); 1`);
        await page.eval(`__reseed(); __gi.step(${FRAMES}); 1`);
        // The step loop issues the draws; give the GPU a moment to retire them.
        await sleep(400);
        await page.eval('__gi.reset(); 1');

        const shot = await page.send('Page.captureScreenshot', { format: 'png' });
        const report = JSON.parse(await page.eval('JSON.stringify(__gi.report())'));
        return {
            backend,
            png: shot.data,
            gpu: report.gpu,
            stats: report.stats,
            size: report.size,
            messages: messages(page.events).filter((m) => !m.includes('[vite]')),
        };
    } finally {
        await page.close();
    }
}

/**
 * Decoding happens in the browser, which already has a PNG decoder -- so the
 * two frames go back into a page as images and come out as numbers.
 */
async function analyse(port, runs) {
    const page = await newPage(port);
    try {
        // Needs a secure origin for nothing in particular, but keeps devtools happy.
        await page.send('Page.navigate', { url: `http://localhost:${PORT}/` });
        await sleep(300);
        return await page.eval(`(${STATS.toString()})(${JSON.stringify(runs[0].png)}, ${JSON.stringify(runs[1].png)})`);
    } finally {
        await page.close();
    }
}

/** Runs in the page. Returns per-frame statistics and the difference between them. */
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
        let lit = 0;
        const colours = new Set();
        for (let i = 0; i < f.data.length; i += 4) {
            const l = luma(f.data, i);
            sum += l;
            if (l > 0.02) lit++;
            // Coarse buckets: enough to tell a picture from a flat fill.
            colours.add((f.data[i] >> 4) << 8 | (f.data[i + 1] >> 4) << 4 | f.data[i + 2] >> 4);
        }
        const n = f.data.length / 4;
        return { meanLuma: sum / n, litFraction: lit / n, colours: colours.size };
    };

    // Per-channel mean absolute difference, and the worst 16x16 block, which is
    // where a single wrong pass shows up while the whole-frame mean hides it.
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
        // Pixel coordinates, so a failure says where to look in the two PNGs.
        worstBlockAt: [(worstAt % bw) * 16, ((worstAt / bw) | 0) * 16],
    };
};

/** Thresholds are the whole test; everything above just produces numbers. */
function verdict(runs, report) {
    const fails = [];
    const note = (ok, text) => {
        console.log(`${ok ? '  ok' : 'FAIL'}  ${text}`);
        if (!ok) fails.push(text);
    };
    if (report.error) {
        note(false, report.error);
        return false;
    }
    console.log(`\n${report.size[0]}x${report.size[1]}`);
    runs.forEach((run, i) => {
        const f = report.frames[i];
        const label = `${run.backend}${PAIR[0] === PAIR[1] ? ` #${i + 1}` : ''}`;
        const shown = `${label}: luma ${f.meanLuma.toFixed(4)}, lit ${(f.litFraction * 100).toFixed(1)}%, ${f.colours} colours`;
        // A black frame is the failure this whole script exists to catch.
        note(f.meanLuma > 0.01 && f.litFraction > 0.05 && f.colours > 40, shown);
        const bad = run.messages.filter((m) => /\[error|\[exception|\[warning:rendering/.test(m));
        note(bad.length === 0, `${label}: ${bad.length} error/warning lines${bad.length ? `\n      ${bad.join('\n      ')}` : ''}`);
    });
    // Float rounding and mip filtering differ a little between the two, and both
    // scenes step reproducibly, so the bar is tight: `--control` reads 0.000% and the
    // two backends currently disagree by 0.013% in their worst block.
    note(report.meanDiff < 0.005, `mean difference ${(report.meanDiff * 100).toFixed(3)}%`);
    note(
        report.worstBlockDiff < 0.02,
        `worst 16x16 block ${(report.worstBlockDiff * 100).toFixed(3)}% at ${report.worstBlockAt.join(',')}`,
    );

    mkdirSync(OUT, { recursive: true });
    runs.forEach((run, i) => {
        writeFileSync(new URL(`${run.backend}${PAIR[0] === PAIR[1] ? `-${i + 1}` : ''}.png`, OUT), Buffer.from(run.png, 'base64'));
    });
    console.log(`\nframes written to ${OUT.pathname}`);
    console.log(fails.length ? `\n${fails.length} check(s) failed` : '\nthe two frames agree');
    return fails.length === 0;
}

// --- plumbing ---------------------------------------------------------------

function serve() {
    const proc = spawn('../../node_modules/.bin/vite', ['--port', String(PORT), '--strictPort'], {
        cwd: new URL('../packages/demo/', import.meta.url).pathname,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    return new Promise((res, rej) => {
        const done = setTimeout(() => rej(new Error('vite did not start')), 20000);
        proc.stdout.on('data', (d) => {
            if (String(d).includes('ready in')) {
                clearTimeout(done);
                res(proc);
            }
        });
        proc.on('error', rej);
    });
}

async function launchChrome() {
    const port = 9500 + (process.pid % 200);
    const proc = spawn(CHROME, [
        '--headless=new',
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${mkdtempSync(join(tmpdir(), 'gi-compare-'))}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--hide-scrollbars',
        '--mute-audio',
        `--window-size=${WIDTH},${HEIGHT}`,
        // Headless exposes WebGPU only with this, and only on a secure origin --
        // which is why everything below runs on localhost rather than a file URL.
        '--enable-unsafe-webgpu',
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

/** Console output, uncaught errors and browser log entries, as flat strings. */
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
