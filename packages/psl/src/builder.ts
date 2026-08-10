/**
 * The code writer. One instance per (target, stage), so a single graph is walked
 * twice -- once to GLSL, once to WGSL -- and the two are the same program by
 * construction rather than by anyone remembering to edit both.
 *
 * Every non-trivial node is hoisted into a named temporary the first time it is
 * reached, and reused from a cache after that. The generated code therefore
 * reads as straight-line SSA: no expression is ever written twice, and shared
 * subgraphs are shared in the output too.
 */
import type { PslNode } from './nodes.ts';
import type { PslTarget, PslType } from './types.ts';
import { typeName } from './types.ts';

export type PslStage = 'vertex' | 'fragment';

const INDENT = '    ';

export class Builder {
    /** Statements written so far, ready to be joined into the function body. */
    readonly lines: string[] = [];

    private _depth = 1;
    /**
     * One cache per open block, innermost last. A temporary declared inside an
     * `if` is out of scope after it, so its cache entry has to go with the block
     * -- the node is simply re-emitted wherever it is next needed.
     */
    private readonly _scopes: Map<PslNode, string>[] = [new Map()];
    private _next = 0;

    constructor(
        readonly target: PslTarget,
        readonly stage: PslStage,
    ) {}

    get wgsl(): boolean {
        return this.target === 'wgsl';
    }

    line(text: string): number {
        return this.lines.push(INDENT.repeat(this._depth) + text) - 1;
    }

    /** Write a block opener and step inside it. */
    open(header: string): void {
        this.line(header);
        this.reopen();
    }

    /** Step inside a block whose opener is already written -- see `If().Else()`. */
    reopen(): void {
        this._depth++;
        this._scopes.push(new Map());
    }

    /** Close the innermost block. Returns the line index of the closer. */
    close(footer = '}'): number {
        this._scopes.pop();
        this._depth--;
        return this.line(footer);
    }

    /** A fresh identifier, unique within the function being written. */
    name(prefix = 'v'): string {
        return `${prefix}${this._next++}`;
    }

    /**
     * Write `node` out if it has not been written in scope already, and return
     * the expression that reads its value back.
     */
    expr(node: PslNode): string {
        for (let i = this._scopes.length - 1; i >= 0; i--) {
            const hit = this._scopes[i]!.get(node);
            if (hit !== undefined) return hit;
        }
        const source = node.emit(this);
        if (node.trivial) return source;
        const name = this.name();
        this.declare(name, node.type, source, false);
        this._scopes[this._scopes.length - 1]!.set(node, name);
        return name;
    }

    /** A local declaration. WGSL infers nothing here on purpose -- explicit types catch graph bugs at compile time. */
    declare(name: string, type: PslType, init: string, mutable: boolean): void {
        this.line(
            this.wgsl
                ? `${mutable ? 'var' : 'let'} ${name} : ${typeName(type, 'wgsl')} = ${init};`
                : `${typeName(type, 'glsl')} ${name} = ${init};`,
        );
    }
}

/**
 * The builder the graph function is currently running under.
 *
 * Statements (`If`, `Loop`, `.toVar()`, `.assign()`) are emitted as the graph
 * function executes rather than collected into a tree, so they need to know
 * where to write. Same trick TSL uses, and the reason a graph function must not
 * be called outside {@link runGraph}.
 */
let current: Builder | null = null;

export function runGraph<T>(target: Builder, fn: () => T): T {
    const previous = current;
    current = target;
    try {
        return fn();
    } finally {
        current = previous;
    }
}

export function builder(): Builder {
    if (!current) {
        throw new Error('[psl] statements are only valid inside a shader graph function');
    }
    return current;
}
