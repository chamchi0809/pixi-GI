/**
 * The code writer. One instance per (target, stage), so a single graph is walked
 * twice -- once to GLSL, once to WGSL -- and the two are the same program by
 * construction rather than by anyone remembering to edit both.
 *
 * Every non-trivial node is hoisted into a named temporary the first time it is
 * reached, and reused from a cache after that. The generated code therefore
 * reads as straight-line SSA: no expression is ever written twice, and shared
 * subgraphs are shared in the output too.
 *
 * A `Fn` body is written by a child builder that shares the root's function
 * sink, struct registry, and name counter, so a function is emitted once per
 * stage no matter how many call sites it has.
 */
import type { PslProgram } from './compile.ts';
import type { PslNode } from './nodes.ts';
import type { PslStructType, PslTarget, PslType } from './types.ts';
import { declarator } from './types.ts';

export type PslStage = 'vertex' | 'fragment';

const INDENT = '    ';

export class Builder {
    /** Statements written so far, ready to be joined into the function body. */
    readonly lines: string[] = [];

    /** The builder whose header the shared declarations belong to. */
    readonly root: Builder;
    /** Emitted `Fn` definitions, innermost first, ready to go above the entry point. */
    readonly functions: string[];
    /** Struct types reached while writing, so the header can declare them. */
    readonly structs: Map<string, PslStructType>;
    /** Emitted name per `Fn` definition, so each is written once per stage. */
    readonly compiled: Map<object, string | 'pending'>;
    /**
     * Names of the declarations this stage actually reached -- uniform groups,
     * textures, attributes, Pixi's own blocks. The header declares only these, so
     * a vertex stage does not carry the fragment's samplers and GLSL never sees a
     * uniform it has no use for.
     */
    readonly needs: Set<string>;

    private _depth = 1;
    /**
     * One cache per open block, innermost last. A temporary declared inside an
     * `if` is out of scope after it, so its cache entry has to go with the block
     * -- the node is simply re-emitted wherever it is next needed.
     */
    private readonly _scopes: Map<PslNode, string>[] = [new Map()];
    private _next = 0;
    private _nextGlobal = 0;

    constructor(
        /** Where a built-in node registers itself when a graph reaches it. */
        readonly program: PslProgram,
        readonly target: PslTarget,
        readonly stage: PslStage,
        parent?: Builder,
    ) {
        this.root = parent?.root ?? this;
        this.functions = this.root === this ? [] : this.root.functions;
        this.structs = this.root === this ? new Map() : this.root.structs;
        this.compiled = this.root === this ? new Map() : this.root.compiled;
        this.needs = this.root === this ? new Set() : this.root.needs;
    }

    get wgsl(): boolean {
        return this.target === 'wgsl';
    }

    /** A builder for a nested function body, sharing everything the header holds. */
    child(): Builder {
        return new Builder(this.program, this.target, this.stage, this);
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
        this.reopenAt(this._depth + 1);
    }

    /**
     * As {@link reopen}, but at a nesting level this builder has already left --
     * `If().ElseIf().Else()` writes the last block back into the middle of the
     * chain, after the closers below it were spliced out of the way.
     */
    reopenAt(depth: number): void {
        this._depth = depth;
        this._scopes.push(new Map());
    }

    /** The level the next statement is written at. */
    get depth(): number {
        return this._depth;
    }

    /** Put the level back after a splice, without touching the scope stack. */
    setDepth(depth: number): void {
        this._depth = depth;
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
     * A fresh identifier unique across the whole stage -- for function names. Its
     * own counter, so a function's name does not depend on how many temporaries
     * happened to be written before it.
     */
    globalName(prefix: string): string {
        return `${prefix}${this.root._nextGlobal++}`;
    }

    /**
     * Note that a type is in use, so the header declares it. Recursive, because a
     * struct reached only as another struct's member still needs declaring, and
     * before it.
     */
    use(type: PslType): void {
        if (typeof type === 'string') return;
        if (type.kind === 'array') {
            this.use(type.of);
            return;
        }
        if (this.structs.has(type.name)) return;
        for (const member of Object.values(type.members)) this.use(member);
        this.structs.set(type.name, type);
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
        this.use(type);
        const decl = declarator(name, type, this.target);
        this.line(this.wgsl ? `${mutable ? 'var' : 'let'} ${decl} = ${init};` : `${decl} = ${init};`);
    }

    /** A mutable local with no initialiser -- see {@link PslVar}. */
    declareVar(name: string, type: PslType): void {
        this.use(type);
        const decl = declarator(name, type, this.target);
        this.line(this.wgsl ? `var ${decl};` : `${decl};`);
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
