/**
 * The nodes themselves, and everything you build a shader out of.
 *
 * The shape is TSL's: a node is an expression, methods on it build bigger
 * expressions, and statements (`If`, `Loop`, `.toVar()`, `.assign()`) run
 * imperatively against the {@link builder} that is currently writing the graph.
 *
 * Nothing here knows about PixiJS -- see `compile.ts` for that.
 */
import { builder } from './builder.ts';
import type { Builder } from './builder.ts';
import type { PslType } from './types.ts';
import { combine, floatLiteral, typeName, width } from './types.ts';

/** Anything accepted where a node is expected. Plain numbers become float literals. */
export type Operand = PslNode | number;

const SIZE: Record<number, PslType> = { 1: 'float', 2: 'vec2', 3: 'vec3', 4: 'vec4' };

export abstract class PslNode {
    abstract readonly type: PslType;
    /**
     * Cheap enough to write out again wherever it is used, so the builder inlines
     * it instead of spending a temporary on it: literals, names, and swizzles of
     * something that is itself already a name.
     */
    readonly trivial: boolean = false;

    /** @internal Write this node as an expression in `b`'s language. */
    abstract emit(b: Builder): string;

    // --- arithmetic ---------------------------------------------------------

    add(...values: Operand[]): PslNode {
        return fold('+', this, values);
    }
    sub(...values: Operand[]): PslNode {
        return fold('-', this, values);
    }
    mul(...values: Operand[]): PslNode {
        return fold('*', this, values);
    }
    div(...values: Operand[]): PslNode {
        return fold('/', this, values);
    }
    /** GLSL's `mod`, i.e. floored. WGSL's `%` truncates instead, so it is written out longhand there. */
    mod(value: Operand): PslNode {
        return mod(this, value);
    }
    negate(): PslNode {
        return new UnaryNode('-', this, this.type);
    }

    // --- comparison ---------------------------------------------------------

    lessThan(value: Operand): PslNode {
        return new OpNode('<', this, node(value), 'bool');
    }
    lessThanEqual(value: Operand): PslNode {
        return new OpNode('<=', this, node(value), 'bool');
    }
    greaterThan(value: Operand): PslNode {
        return new OpNode('>', this, node(value), 'bool');
    }
    greaterThanEqual(value: Operand): PslNode {
        return new OpNode('>=', this, node(value), 'bool');
    }
    /** Whole-value equality: a single bool even for vectors, as GLSL's `==` already gives. */
    equal(value: Operand): PslNode {
        return new EqualNode(this, node(value), false);
    }
    notEqual(value: Operand): PslNode {
        return new EqualNode(this, node(value), true);
    }
    and(value: PslNode): PslNode {
        return new OpNode('&&', this, value, 'bool');
    }
    or(value: PslNode): PslNode {
        return new OpNode('||', this, value, 'bool');
    }
    not(): PslNode {
        return new UnaryNode('!', this, 'bool');
    }

    // --- storage ------------------------------------------------------------

    /** Pin this value into a mutable local, which `.assign()` can then overwrite. */
    toVar(name?: string): PslVar {
        return new PslVar(this, name);
    }

    // Swizzles (`.x`, `.rgb`, `.yx`, ...) are installed on the prototype below.
    declare readonly x: PslNode;
    declare readonly y: PslNode;
    declare readonly z: PslNode;
    declare readonly w: PslNode;
    declare readonly r: PslNode;
    declare readonly g: PslNode;
    declare readonly b: PslNode;
    declare readonly a: PslNode;
    declare readonly xy: PslNode;
    declare readonly yx: PslNode;
    declare readonly rgb: PslNode;
    declare readonly xyz: PslNode;
}

/** Coerce an {@link Operand} to a node. */
export function node(value: Operand): PslNode {
    return typeof value === 'number' ? new ConstNode('float', value) : value;
}

function fold(op: string, first: PslNode, values: Operand[]): PslNode {
    let out = first;
    for (const value of values) out = new OpNode(op, out, node(value));
    return out;
}

// --- node kinds -----------------------------------------------------------------

class ConstNode extends PslNode {
    override readonly trivial = true;

    constructor(
        readonly type: PslType,
        private readonly _value: number,
    ) {
        super();
    }

    emit(): string {
        if (this.type === 'bool') return this._value ? 'true' : 'false';
        if (this.type === 'int') return this._value < 0 ? `(${this._value | 0})` : String(this._value | 0);
        return floatLiteral(this._value);
    }
}

/**
 * A plain name, spelled differently per backend: a GLSL uniform is bare, while
 * the same thing in WGSL is a member of its group's struct.
 */
export class RefNode extends PslNode {
    override readonly trivial = true;

    constructor(
        readonly type: PslType,
        private readonly _glsl: string,
        private readonly _wgsl: string = _glsl,
    ) {
        super();
    }

    emit(b: Builder): string {
        return b.wgsl ? this._wgsl : this._glsl;
    }
}

class OpNode extends PslNode {
    readonly type: PslType;

    constructor(
        private readonly _op: string,
        private readonly _a: PslNode,
        private readonly _b: PslNode,
        type?: PslType,
    ) {
        super();
        this.type = type ?? combine(_a.type, _b.type);
    }

    emit(b: Builder): string {
        // Always parenthesised. Both languages agree on precedence, but the
        // output is generated, not read, so there is nothing to gain by trusting it.
        return `(${b.expr(this._a)} ${this._op} ${b.expr(this._b)})`;
    }
}

class UnaryNode extends PslNode {
    constructor(
        private readonly _op: string,
        private readonly _value: PslNode,
        readonly type: PslType,
    ) {
        super();
    }

    emit(b: Builder): string {
        return `${this._op}(${b.expr(this._value)})`;
    }
}

/**
 * GLSL's `==` on vectors is a single bool; WGSL's is component-wise. `all` /
 * `any` restore the GLSL meaning, which is the one every call site wants.
 */
class EqualNode extends PslNode {
    readonly type = 'bool' as const;

    constructor(
        private readonly _a: PslNode,
        private readonly _b: PslNode,
        private readonly _negated: boolean,
    ) {
        super();
    }

    emit(b: Builder): string {
        const compare = `${b.expr(this._a)} ${this._negated ? '!=' : '=='} ${b.expr(this._b)}`;
        if (b.wgsl && width(this._a.type) > 0) return `${this._negated ? 'any' : 'all'}(${compare})`;
        return `(${compare})`;
    }
}

class CallNode extends PslNode {
    constructor(
        readonly type: PslType,
        private readonly _args: PslNode[],
        private readonly _glsl: (args: string[]) => string,
        private readonly _wgsl: (args: string[]) => string,
    ) {
        super();
    }

    emit(b: Builder): string {
        const args = this._args.map((arg) => b.expr(arg));
        return b.wgsl ? this._wgsl(args) : this._glsl(args);
    }
}

class ConstructNode extends PslNode {
    constructor(
        readonly type: PslType,
        private readonly _args: PslNode[],
    ) {
        super();
    }

    emit(b: Builder): string {
        return `${typeName(this.type, b.target)}(${this._args.map((arg) => b.expr(arg)).join(', ')})`;
    }
}

class SwizzleNode extends PslNode {
    // The source is hoisted, so this is only ever `name.rgb` -- free to repeat.
    override readonly trivial = true;
    readonly type: PslType;

    constructor(
        private readonly _source: PslNode,
        private readonly _key: string,
    ) {
        super();
        this.type = SIZE[_key.length]!;
    }

    emit(b: Builder): string {
        return `${b.expr(this._source)}.${this._key}`;
    }
}

class SelectNode extends PslNode {
    readonly type: PslType;

    constructor(
        private readonly _condition: PslNode,
        private readonly _then: PslNode,
        private readonly _otherwise: PslNode,
    ) {
        super();
        this.type = _then.type;
    }

    emit(b: Builder): string {
        // Both operands are evaluated either way in both languages, which is why
        // this is a value and `If` is a statement. Reach for `If` when a branch
        // is expensive enough that skipping it is the point.
        const c = b.expr(this._condition);
        const t = b.expr(this._then);
        const f = b.expr(this._otherwise);
        return b.wgsl ? `select(${f}, ${t}, ${c})` : `(${c} ? ${t} : ${f})`;
    }
}

/** A mutable local. Declared where it is created, so create it inside the block that owns it. */
export class PslVar extends PslNode {
    override readonly trivial = true;
    readonly type: PslType;

    private readonly _name: string;

    constructor(init: PslNode, name?: string) {
        super();
        const b = builder();
        this.type = init.type;
        this._name = name ?? b.name('m');
        b.declare(this._name, this.type, b.expr(init), true);
    }

    emit(): string {
        return this._name;
    }

    assign(value: Operand): void {
        const b = builder();
        b.line(`${this._name} = ${b.expr(node(value))};`);
    }
}

// --- constructors ---------------------------------------------------------------

export function bool(value: boolean): PslNode {
    return new ConstNode('bool', value ? 1 : 0);
}
export function int(value: number): PslNode {
    return new ConstNode('int', value);
}
export function float(value: Operand): PslNode {
    return typeof value === 'number' ? new ConstNode('float', value) : value;
}
export function vec2(...args: Operand[]): PslNode {
    return new ConstructNode('vec2', args.map(node));
}
export function vec3(...args: Operand[]): PslNode {
    return new ConstructNode('vec3', args.map(node));
}
export function vec4(...args: Operand[]): PslNode {
    return new ConstructNode('vec4', args.map(node));
}

// --- built-in functions ---------------------------------------------------------

const list = (args: string[]): string => args.join(', ');
const same =
    (name: string) =>
    (args: string[]): string =>
        `${name}(${list(args)})`;

/** A built-in that is spelled and typed identically in both languages. */
function builtin(name: string, type: (args: PslNode[]) => PslType) {
    const render = same(name);
    return (...args: Operand[]): PslNode => {
        const nodes = args.map(node);
        return new CallNode(type(nodes), nodes, render, render);
    };
}

const first = (args: PslNode[]): PslType => args[0]!.type;
const last = (args: PslNode[]): PslType => args[args.length - 1]!.type;
const scalar = (): PslType => 'float';

export const abs = builtin('abs', first);
export const floor = builtin('floor', first);
export const ceil = builtin('ceil', first);
export const fract = builtin('fract', first);
export const sign = builtin('sign', first);
export const sqrt = builtin('sqrt', first);
export const exp2 = builtin('exp2', first);
export const log2 = builtin('log2', first);
export const sin = builtin('sin', first);
export const cos = builtin('cos', first);
export const normalize = builtin('normalize', first);
export const min = builtin('min', (args) => combine(args[0]!.type, args[1]!.type));
export const max = builtin('max', (args) => combine(args[0]!.type, args[1]!.type));
export const pow = builtin('pow', first);
export const clamp = builtin('clamp', first);
export const mix = builtin('mix', first);
export const smoothstep = builtin('smoothstep', last);
/** `step(edge, x)`, whose result follows `x` -- as in GLSL, where the edge may be a scalar. */
export const step = builtin('step', last);
export const dot = builtin('dot', scalar);
export const length = builtin('length', scalar);

/** `atan(y, x)` in GLSL, `atan2(y, x)` in WGSL. */
export function atan2(y: Operand, x: Operand): PslNode {
    const args = [node(y), node(x)];
    return new CallNode('float', args, same('atan'), same('atan2'));
}

/**
 * Floored modulo, i.e. GLSL's `mod`. WGSL's `%` follows the sign of the
 * dividend, so it is not the same function and cannot be used here.
 */
export function mod(a: Operand, b: Operand): PslNode {
    const args = [node(a), node(b)];
    return new CallNode(
        combine(args[0]!.type, args[1]!.type),
        args,
        same('mod'),
        ([x, y]) => `(${x} - ${y} * floor(${x} / ${y}))`,
    );
}

/** A value chosen by a condition. Both sides are evaluated; use {@link If} when that matters. */
export function select(condition: PslNode, then: Operand, otherwise: Operand): PslNode {
    return new SelectNode(condition, node(then), node(otherwise));
}

// --- statements -----------------------------------------------------------------

/** Returned by {@link If} so a branch can be chained. Call `.Else()` immediately or not at all. */
export class PslBranch {
    constructor(
        private readonly _builder: Builder,
        private readonly _closer: number,
    ) {}

    Else(body: () => void): void {
        const b = this._builder;
        // Rewrite the `}` we just wrote rather than emitting a second statement,
        // so the two blocks really are one if/else and not two ifs.
        b.lines[this._closer] = `${b.lines[this._closer]!} else {`;
        b.reopen();
        body();
        b.close('}');
    }
}

export function If(condition: PslNode, body: () => void): PslBranch {
    const b = builder();
    b.open(`if (${b.expr(condition)}) {`);
    body();
    return new PslBranch(b, b.close('}'));
}

export interface PslLoopOptions {
    start: Operand;
    /** Inclusive, as GLSL's `l <= end`. May be a uniform. */
    end: Operand;
    /** @default 1 */
    step?: Operand;
}

/**
 * A counted float loop -- `for (l = start; l <= end; l += step)`.
 *
 * Float rather than int because that is what a shader loop over mip levels or
 * ray indices actually wants, and it keeps the two backends' arithmetic
 * identical without any casts.
 */
export function Loop(options: PslLoopOptions, body: (index: PslNode) => void): void {
    const b = builder();
    // Hoisted before the loop, so the bounds are loop-invariant in the output too.
    const start = b.expr(node(options.start));
    const end = b.expr(node(options.end));
    const step = b.expr(node(options.step ?? 1));
    const i = b.name('i');
    b.open(
        b.wgsl
            ? `for (var ${i} : f32 = ${start}; ${i} <= ${end}; ${i} = ${i} + ${step}) {`
            : `for (float ${i} = ${start}; ${i} <= ${end}; ${i} += ${step}) {`,
    );
    body(new RefNode('float', i));
    b.close('}');
}

/**
 * Wrap a graph fragment as a reusable function.
 *
 * PSL functions are plain TypeScript functions and are inlined at every call
 * site; `Fn` exists so graphs read like TSL and so the intent is obvious. There
 * is no separate emitted function, which is why recursion is not a thing and
 * `out` parameters are just extra return values.
 */
export function Fn<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
    return fn;
}

// --- swizzles -------------------------------------------------------------------

/**
 * `.x` / `.rgb` / `.yx` and friends, on the prototype so every node has them.
 * Both languages accept the `xyzw` and `rgba` sets with the same meaning; PSL
 * does not mix the two in one key, which neither language allows either.
 */
for (const set of ['xyzw', 'rgba']) {
    const keys: string[] = [''];
    for (let length = 0; length < 4; length++) {
        const next: string[] = [];
        for (const prefix of keys) {
            if (prefix) next.push(prefix);
            for (const component of set) next.push(prefix + component);
        }
        keys.length = 0;
        keys.push(...next);
    }
    for (const key of new Set(keys)) {
        if (!key) continue;
        Object.defineProperty(PslNode.prototype, key, {
            get(this: PslNode) {
                return new SwizzleNode(this, key);
            },
        });
    }
}
