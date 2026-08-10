/**
 * Per-stage GPU timing. Opt-in: `gi.profiler = new GpuProfiler(renderer)`.
 *
 * Uses `EXT_disjoint_timer_query_webgl2`, which measures what the GPU actually
 * spent on the commands between `begin` and `end` -- not wall clock, so it is
 * unaffected by vsync or by the CPU running ahead. Chrome hides the extension
 * behind `--enable-webgl-draft-extensions`; {@link GpuProfiler.precise} is
 * `false` when it is missing and the timings fall back to `gl.finish()`
 * bracketing, whose absolute numbers run high but whose ratios still hold.
 *
 * ponytail: WebGPU has no equivalent extension exposed through PixiJS, so there
 * the profiler degrades to plain CPU wall clock -- `precise` is `false` and the
 * numbers include whatever the driver was doing at the time. Swap in
 * `GPUQuerySet` timestamp writes if WebGPU timings ever need to be trusted.
 */
import type { Renderer, WebGLRenderer } from 'pixi.js';

interface TimerExt {
    TIME_ELAPSED_EXT: number;
    GPU_DISJOINT_EXT: number;
}

/** Samples kept per stage. A few seconds at any frame rate fits. */
const WINDOW = 4096;

/** Polls to wait on a stage that is not running before giving up its turn. */
const STALL = 8;

/** Milliseconds a stage took, summarised over the sample window. */
export interface StageStats {
    mean: number;
    median: number;
    p95: number;
    /** Samples the summary is over. */
    n: number;
    /** Mean wall-clock milliseconds the CPU spent issuing the stage. */
    cpu: number;
}

export class GpuProfiler {
    /** `true` when real GPU timer queries are in use rather than the `gl.finish()` fallback. */
    readonly precise: boolean;

    private readonly _gl: WebGL2RenderingContext | null;
    private readonly _ext: TimerExt | null;
    private readonly _samples = new Map<string, number[]>();
    private readonly _cpu = new Map<string, number[]>();
    private readonly _order: string[] = [];
    private readonly _pool: WebGLQuery[] = [];
    private readonly _pending: { name: string; query: WebGLQuery }[] = [];

    private _active: string | null = null;
    private _query: WebGLQuery | null = null;
    private _cpuStart = 0;
    private _wallStart = 0;
    private _discarded = 0;
    /** Index into {@link _order} of the stage whose turn it is to be measured. */
    private _due = 0;
    /** The due stage ran and was measured, so the turn is spent. */
    private _spent = false;
    /** `poll` calls since the due stage last ran, to get past one that never does. */
    private _missed = 0;
    /** The open stage is the one being measured, not merely the one that is open. */
    private _measuring = false;

    constructor(renderer: Renderer) {
        const gl = (renderer as WebGLRenderer).gl as WebGL2RenderingContext | undefined;
        this._gl = gl ?? null;
        this._ext = gl ? (gl.getExtension('EXT_disjoint_timer_query_webgl2') as TimerExt | null) : null;
        this.precise = this._ext !== null;
    }

    /**
     * Start timing a stage. Closes the previous one if it is still open.
     *
     * Only **one** stage is measured per frame, round-robin. Several
     * `TIME_ELAPSED` queries in flight at once do not partition a frame the way
     * you would expect: on ANGLE/Metal each one covers the wall time from its
     * own begin to its own end, so a shared queue stall is counted once per
     * query and the stages sum to well over the frame. Measured alone, a stage
     * gets the whole frame's worth of that noise or none of it, and the mean
     * over a few hundred frames converges on the real cost.
     */
    begin(name: string): void {
        if (this._active) this.end();
        if (!this._samples.has(name)) {
            this._samples.set(name, []);
            this._cpu.set(name, []);
            this._order.push(name);
        }
        this._active = name;
        // Wall time spent issuing the stage, every frame. Free, and the only way
        // to tell a stage that is genuinely GPU-heavy from one whose timer query
        // is just absorbing a CPU gap.
        this._wallStart = performance.now();
        this._measuring = name === this._order[this._due];
        if (!this._measuring) return;

        if (this._ext) {
            const query = this._pool.pop() ?? this._gl!.createQuery()!;
            this._query = query;
            this._gl!.beginQuery(this._ext.TIME_ELAPSED_EXT, query);
        } else {
            this._gl?.finish();
            this._cpuStart = performance.now();
        }
    }

    end(): void {
        if (!this._active) return;
        const name = this._active;
        this._active = null;
        this._pushTo(this._cpu, name, performance.now() - this._wallStart);
        if (!this._measuring) return;
        this._measuring = false;
        this._spent = true;

        if (this._ext) {
            this._gl!.endQuery(this._ext.TIME_ELAPSED_EXT);
            this._pending.push({ name, query: this._query! });
            this._query = null;
        } else {
            this._gl?.finish();
            this._push(name, performance.now() - this._cpuStart);
        }
    }

    /**
     * Call once at the end of the frame. Drains whatever results the GPU has
     * finished; queries are read back a few frames late, which is exactly why
     * this does not stall the pipeline the way `gl.finish()` does.
     *
     * Calling it more than once a frame is allowed and costs only the drain. The
     * turn passes to the next stage when the stage whose turn it was has
     * actually been measured, never merely because a poll came round. Left to
     * step per call it would advance by however many times the host polls --
     * with six stages and two polls a frame the odd-indexed ones never come up
     * at all, and read as free rather than as unmeasured. A stage that stops
     * running entirely (a conditional pass switched off) would stall the turn
     * for good, so after {@link STALL} fruitless polls it is skipped.
     */
    poll(): void {
        this.end();
        if (this._spent || ++this._missed > STALL) {
            this._spent = false;
            this._missed = 0;
            this._due = (this._due + 1) % this._order.length;
        }
        if (!this._ext) return;

        const gl = this._gl!;
        // A disjoint means the GPU was preempted and every in-flight result is
        // meaningless. Drop the batch rather than record a phantom spike.
        const disjoint = gl.getParameter(this._ext.GPU_DISJOINT_EXT) as boolean;

        let done = 0;
        while (done < this._pending.length) {
            const { name, query } = this._pending[done]!;
            if (!gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) break;
            if (disjoint) this._discarded++;
            else this._push(name, (gl.getQueryParameter(query, gl.QUERY_RESULT) as number) / 1e6);
            this._pool.push(query);
            done++;
        }
        if (done > 0) this._pending.splice(0, done);
    }

    /** Per-stage summary, in the order the stages were first seen. */
    report(): Record<string, StageStats> {
        const out: Record<string, StageStats> = {};
        for (const name of this._order) {
            const list = this._samples.get(name)!;
            if (list.length === 0) continue;
            const sorted = [...list].sort((a, b) => a - b);
            let sum = 0;
            for (const value of sorted) sum += value;
            const cpu = this._cpu.get(name)!;
            let cpuSum = 0;
            for (const value of cpu) cpuSum += value;
            out[name] = {
                mean: sum / sorted.length,
                median: sorted[sorted.length >> 1]!,
                p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]!,
                n: sorted.length,
                cpu: cpu.length === 0 ? 0 : cpuSum / cpu.length,
            };
        }
        return out;
    }

    /** Samples thrown away because the GPU reported a disjoint. */
    get discarded(): number {
        return this._discarded;
    }

    /** Drop every sample, e.g. after a quality switch or a warm-up period. */
    reset(): void {
        for (const list of this._samples.values()) list.length = 0;
        for (const list of this._cpu.values()) list.length = 0;
        this._discarded = 0;
    }

    destroy(): void {
        for (const query of this._pool) this._gl?.deleteQuery(query);
        for (const { query } of this._pending) this._gl?.deleteQuery(query);
        this._pool.length = 0;
        this._pending.length = 0;
    }

    private _push(name: string, value: number): void {
        this._pushTo(this._samples, name, value);
    }

    private _pushTo(into: Map<string, number[]>, name: string, value: number): void {
        const list = into.get(name);
        if (!list) return;
        list.push(value);
        if (list.length > WINDOW) list.shift();
    }
}
