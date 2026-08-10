/**
 * The nodes themselves, and everything you build a shader out of.
 *
 * The shape is TSL's: a node is an expression, methods on it build bigger
 * expressions, and statements (`If`, `Loop`, `Switch`, `.toVar()`, `.assign()`)
 * run imperatively against the {@link builder} that is currently writing the
 * graph.
 *
 * Nothing here knows about PixiJS -- see `compile.ts` for that.
 */
import { builder, runGraph } from './builder.ts';
import type { Builder } from './builder.ts';
import type { PslArrayType, PslPrimitive, PslStructType, PslType } from './types.ts';
import {
    combine,
    declarator,
    floatLiteral,
    intLiteral,
    isInteger,
    typeName,
    width,
} from './types.ts';

/** Anything accepted where a node is expected. Plain numbers become float literals. */
export type Operand = PslNode | number;

const SIZE: Record<number, PslPrimitive> = { 1: 'float', 2: 'vec2', 3: 'vec3', 4: 'vec4' };

export abstract class PslNode {
    abstract readonly type: PslType;
    /**
     * Cheap enough to write out again wherever it is used, so the builder inlines
     * it instead of spending a temporary on it: literals, names, and swizzles or
     * members of something that is itself already a name.
     */
    readonly trivial: boolean = false;
    /**
     * Whether this can be assigned to. True for a `toVar()` local and for any
     * swizzle, member, or element reached from one.
     */
    readonly lvalue: boolean = false;

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
    /** Floored modulo -- see the free {@link mod}. */
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
    /** Whole-value equality, as GLSL means it, on vectors too. */
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

    // --- access -------------------------------------------------------------

    /** A struct member. The key is checked against the struct's declaration. */
    get<K extends string>(key: K): PslNode {
        const type = this.type;
        if (typeof type === 'string' || type.kind !== 'struct') {
            throw new Error(`[psl] .get('${key}') needs a struct, got ${describe(type)}`);
        }
        const member = type.members[key];
        if (!member) throw new Error(`[psl] struct ${type.name} has no member '${key}'`);
        return new MemberNode(this, key, member);
    }

    /** An array element. A plain number is taken as a literal index; a node must be integer. */
    element(index: Operand): PslNode {
        const type = this.type;
        if (typeof type === 'string' || type.kind !== 'array') {
            throw new Error(`[psl] .element() needs an array, got ${describe(type)}`);
        }
        const subscript = typeof index === 'number' ? int(index) : node(index);
        if (!isInteger(subscript.type)) {
            throw new Error(`[psl] index must be int or uint, got ${describe(subscript.type)}`);
        }
        return new ElementNode(this, subscript, type.of);
    }

    // --- statements ---------------------------------------------------------

    /** Hoist into a mutable local, so `If` bodies can write to it. */
    toVar(name?: string): PslVar {
        return new PslVar(this, name);
    }

    /** Write to a local, or to a swizzle / member / element of one. */
    assign(value: Operand): void {
        if (!this.lvalue) throw new Error(`[psl] ${describe(this.type)} value is not assignable`);
        const b = builder();
        b.line(`${b.expr(this)} = ${b.expr(node(value))};`);
    }
}

/**
 * Swizzles are installed on the prototype for every combination of one set, so
 * the runtime already has `.zw` and `.bgr`; this is what lets TypeScript see
 * them. Mixing the two sets in one key is illegal in both languages and is
 * therefore not offered here either.
 */
type Repeat<T extends string> = T | `${T}${T}` | `${T}${T}${T}` | `${T}${T}${T}${T}`;
export type PslSwizzle = Repeat<'x' | 'y' | 'z' | 'w'> | Repeat<'r' | 'g' | 'b' | 'a'>;
export interface PslNode extends Record<PslSwizzle, PslNode> {}

export function node(value: Operand): PslNode {
    return typeof value === 'number' ? new ConstNode('float', value) : value;
}

function fold(op: string, first: PslNode, values: Operand[]): PslNode {
    let out = first;
    for (const value of values) out = new OpNode(op, out, node(value));
    return out;
}

/** A type, for an error message. */
function describe(type: PslType): string {
    if (typeof type === 'string') return type;
    return type.kind === 'struct' ? `struct ${type.name}` : `array<${describe(type.of)}>`;
}

// --- node kinds -----------------------------------------------------------------

class ConstNode extends PslNode {
    override readonly trivial = true;

    constructor(
        readonly type: PslPrimitive,
        private readonly _value: number,
    ) {
        super();
    }

    emit(): string {
        if (this.type === 'bool') return this._value ? 'true' : 'false';
        if (isInteger(this.type)) return intLiteral(this._value, this.type === 'uint');
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
        b.use(this.type);
        return `${typeName(this.type, b.target)}(${this._args.map((arg) => b.expr(arg)).join(', ')})`;
    }
}

class SwizzleNode extends PslNode {
    // The source is hoisted, so this is only ever `name.rgb` -- free to repeat.
    override readonly trivial = true;
    override readonly lvalue: boolean;
    readonly type: PslPrimitive;

    constructor(
        private readonly _source: PslNode,
        private readonly _key: string,
    ) {
        super();
        this.type = SIZE[_key.length]!;
        this.lvalue = _source.lvalue;
    }

    emit(b: Builder): string {
        return `${b.expr(this._source)}.${this._key}`;
    }
}

class MemberNode extends PslNode {
    override readonly trivial = true;
    override readonly lvalue: boolean;

    constructor(
        private readonly _source: PslNode,
        private readonly _key: string,
        readonly type: PslType,
    ) {
        super();
        this.lvalue = _source.lvalue;
    }

    emit(b: Builder): string {
        return `${b.expr(this._source)}.${this._key}`;
    }
}

class ElementNode extends PslNode {
    override readonly trivial = true;
    override readonly lvalue: boolean;

    constructor(
        private readonly _source: PslNode,
        private readonly _index: PslNode,
        readonly type: PslType,
    ) {
        super();
        this.lvalue = _source.lvalue;
    }

    emit(b: Builder): string {
        return `${b.expr(this._source)}[${b.expr(this._index)}]`;
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
    override readonly lvalue = true;
    readonly type: PslType;

    private readonly _name: string;

    /**
     * `{ type }` instead of a node declares it without an initialiser -- for a
     * struct or array filled in member by member. WGSL zero-initialises those,
     * GLSL leaves them undefined, so write before you read.
     */
    constructor(init: PslNode | { type: PslType }, name?: string) {
        super();
        const b = builder();
        this.type = init.type;
        this._name = name ?? b.name('m');
        if (init instanceof PslNode) b.declare(this._name, this.type, b.expr(init), true);
        else b.declareVar(this._name, this.type);
    }

    emit(): string {
        return this._name;
    }
}

// --- constructors ---------------------------------------------------------------

export function bool(value: boolean): PslNode {
    return new ConstNode('bool', value ? 1 : 0);
}

export function int(value: Operand): PslNode {
    return typeof value === 'number' ? new ConstNode('int', value) : new ConstructNode('int', [value]);
}

/** An unsigned integer. `1u` in both languages; `u32` in WGSL, `uint` in GLSL. */
export function uint(value: Operand): PslNode {
    return typeof value === 'number' ? new ConstNode('uint', value) : new ConstructNode('uint', [value]);
}

export function float(value: Operand): PslNode {
    return typeof value === 'number' ? new ConstNode('float', value) : new ConstructNode('float', [value]);
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

/** Column-major, as both languages read matrix constructor arguments. */
export function mat3(...args: Operand[]): PslNode {
    return new ConstructNode('mat3', args.map(node));
}

export function mat4(...args: Operand[]): PslNode {
    return new ConstructNode('mat4', args.map(node));
}

// --- structs and arrays ---------------------------------------------------------

/** What {@link struct} returns: a constructor that also carries the type. */
export interface PslStruct<M extends Record<string, PslType>> {
    (values: { [K in keyof M]: Operand }): PslNode;
    readonly type: PslStructType;
    /** An uninitialised mutable local of this type, for filling member by member. */
    var(name?: string): PslVar;
}

/**
 * Declare a struct type. The name is shared by both languages and is declared in
 * the shader header the first time a value of the type is written.
 *
 * Member order is the memory layout, so a struct used in a uniform block would
 * also have to match Pixi's own packing -- which is why {@link PslProgram.uniforms}
 * takes flat members only. Locals, function parameters, and return values are
 * where these earn their keep.
 */
export function struct<const M extends Record<string, PslType>>(
    name: string,
    members: M,
): PslStruct<M> {
    const type: PslStructType = { kind: 'struct', name, members };
    const keys = Object.keys(members);
    const make = (values: { [K in keyof M]: Operand }): PslNode =>
        new ConstructNode(
            type,
            keys.map((key) => node(values[key as keyof M])),
        );
    return Object.assign(make, {
        type,
        var: (varName?: string): PslVar => new PslVar({ type }, varName),
    }) as PslStruct<M>;
}

/** An array type, for `Fn` signatures and `arrayVar`. */
export function arrayOf(of: PslType, length: number): PslArrayType {
    return { kind: 'array', of, length };
}

/** A fixed-size array value. Every element must have the same type. */
export function array(...values: Operand[]): PslNode {
    if (values.length === 0) throw new Error('[psl] array() needs at least one element');
    const nodes = values.map(node);
    return new ConstructNode(arrayOf(nodes[0]!.type, nodes.length), nodes);
}

/**
 * A mutable array local, zero-length-safe and without listing an initialiser --
 * the usual shape for a scratch buffer a `Loop` fills in.
 *
 * ponytail: like `struct().var()`, WGSL zero-initialises and GLSL does not, so
 * write before you read. Passing an initialiser would mean spelling out N
 * elements; use `array(...).toVar()` when that is what you actually want.
 */
export function arrayVar(of: PslType, length: number, name?: string): PslVar {
    return new PslVar({ type: arrayOf(of, length) }, name);
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
/** One-argument `atan`, i.e. the principal branch. Cheaper than {@link atan2}, which has quadrants to sort out. */
export const atan = builtin('atan', first);
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

/** Returned by {@link If} so a branch can be chained. Call `.Else()` / `.ElseIf()` immediately or not at all. */
export class PslBranch {
    constructor(
        private readonly _builder: Builder,
        /** Line index of this block's `}`, the line an `else` is grafted onto. */
        private readonly _closer: number,
        /** Level the block's body was written at, to write the else body level with it. */
        private readonly _depth: number,
        /** Enclosing closers written after ours, from the else-if links above. */
        private readonly _trailing: number,
    ) {}

    Else(body: () => void): void {
        const b = this._builder;
        if (b.lines.length !== this._closer + 1 + this._trailing) {
            throw new Error('[psl] Else()/ElseIf() must follow their If() immediately');
        }
        // Lift the enclosing `}`s out of the way, rewrite our own into `} else {`
        // -- so the two blocks really are one if/else and not two ifs -- write the
        // body back inside, then put the enclosing closers back.
        const trailing = b.lines.splice(this._closer + 1);
        b.lines[this._closer] = `${b.lines[this._closer]!} else {`;
        b.reopenAt(this._depth);
        body();
        b.close('}');
        b.lines.push(...trailing);
        b.setDepth(this._depth - 1 - this._trailing);
    }

    /**
     * ponytail: an else-if is an `if` nested in the `else`, because the chained
     * condition may need temporaries and those have to be written *before* the
     * `if` -- which, on a rewritten closer line, is not a place that exists. The
     * output nests one level per link; the semantics are the same either way.
     */
    ElseIf(condition: PslNode, body: () => void): PslBranch {
        let inner: PslBranch | undefined;
        this.Else(() => {
            inner = If(condition, body);
        });
        const { _closer, _depth } = inner!;
        return new PslBranch(this._builder, _closer, _depth, this._trailing + 1);
    }
}

export function If(condition: PslNode, body: () => void): PslBranch {
    const b = builder();
    b.open(`if (${b.expr(condition)}) {`);
    body();
    const depth = b.depth;
    return new PslBranch(b, b.close('}'), depth, 0);
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
 * identical without any casts. Use {@link Break} and {@link Continue} inside.
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

/** Leave the innermost `Loop` or `Switch` case. Same keyword in both languages. */
export function Break(): void {
    builder().line('break;');
}

/** Skip to the innermost `Loop`'s next iteration. Same keyword in both languages. */
export function Continue(): void {
    builder().line('continue;');
}

/**
 * Throw the fragment away. Same keyword in both languages, and fragment-only in
 * both -- WGSL rejects it in a vertex shader, so PSL does too rather than
 * letting the driver report it.
 */
export function Discard(): void {
    const b = builder();
    if (b.stage !== 'fragment') throw new Error('[psl] Discard() is only valid in the fragment stage');
    b.line('discard;');
}

/** Collects the cases of a {@link Switch}. */
export class PslSwitch {
    /** @internal */
    hasDefault = false;

    constructor(
        private readonly _builder: Builder,
        private readonly _unsigned: boolean,
    ) {}

    /** One or more selector values sharing a body. There is no fall-through in either language. */
    Case(match: number | number[], body: () => void): this {
        const b = this._builder;
        const values = (Array.isArray(match) ? match : [match]).map((v) => intLiteral(v, this._unsigned));
        if (values.length === 0) throw new Error('[psl] Case() needs at least one selector value');
        // WGSL lists the values on one `case`; GLSL stacks empty labels instead.
        b.open(b.wgsl ? `case ${values.join(', ')}: {` : `${values.map((v) => `case ${v}:`).join(' ')} {`);
        body();
        b.line('break;');
        b.close('}');
        return this;
    }

    Default(body: () => void): this {
        const b = this._builder;
        this.hasDefault = true;
        b.open('default: {');
        body();
        b.line('break;');
        b.close('}');
        return this;
    }
}

/**
 * A switch on an integer selector.
 *
 * WGSL requires a `default` clause and PSL enforces it, because a GLSL switch
 * that happens to cover every value is still a WGSL error -- one shader source
 * has to be legal in both.
 */
export function Switch(value: Operand, cases: (s: PslSwitch) => void): void {
    const b = builder();
    const selector = node(value);
    if (!isInteger(selector.type)) {
        throw new Error('[psl] Switch() needs an int or uint selector; wrap a float in int()');
    }
    const expr = b.expr(selector);
    b.open(`switch (${expr}) {`);
    const s = new PslSwitch(b, selector.type === 'uint');
    cases(s);
    if (!s.hasDefault) throw new Error('[psl] Switch() needs a Default() case -- WGSL requires one');
    b.close('}');
}

// --- functions ------------------------------------------------------------------

interface FnDef {
    readonly params: readonly PslType[];
    readonly returns: PslType;
    readonly body: (...args: PslNode[]) => Operand;
}

class CallFnNode extends PslNode {
    constructor(
        private readonly _def: FnDef,
        private readonly _args: PslNode[],
    ) {
        super();
    }

    get type(): PslType {
        return this._def.returns;
    }

    emit(b: Builder): string {
        const name = define(b, this._def);
        return `${name}(${this._args.map((arg) => b.expr(arg)).join(', ')})`;
    }
}

/**
 * Emit a function definition, once per stage, and return its name.
 *
 * The body is written by a child builder that shares the root's function sink,
 * so a function called from another function is defined before it -- which GLSL
 * requires and WGSL does not care about.
 */
function define(b: Builder, def: FnDef): string {
    const hit = b.compiled.get(def);
    if (hit === 'pending') {
        throw new Error('[psl] an Fn cannot call itself: neither GLSL nor WGSL allows recursion');
    }
    if (hit !== undefined) return hit;
    b.compiled.set(def, 'pending');

    const name = b.globalName('fn');
    const inner = b.child();
    const params = def.params.map((type, i) => {
        b.use(type);
        return new RefNode(type, `p${i}`);
    });
    b.use(def.returns);
    const result = runGraph(inner, () => inner.expr(node(def.body(...params))));
    const signature = def.params.map((type, i) => declarator(`p${i}`, type, b.target)).join(', ');
    const head = b.wgsl
        ? `fn ${name}(${signature}) -> ${typeName(def.returns, 'wgsl')} {`
        : `${typeName(def.returns, 'glsl')} ${name}(${signature}) {`;
    b.functions.push([head, ...inner.lines, `    return ${result};`, '}'].join('\n'));

    b.compiled.set(def, name);
    return name;
}

/**
 * Wrap a graph fragment as a function.
 *
 * Given a signature, it becomes a real function in both languages, emitted once
 * per stage and called at every site -- so a big helper used in a loop costs one
 * definition instead of N copies:
 *
 *     const luma = Fn(['vec3'], 'float', (c) => dot(c, vec3(0.2126, 0.7152, 0.0722)));
 *     luma(colour) // -> fn0(v3)
 *
 * Called with just a function it stays what it always was: a plain TypeScript
 * function, inlined at every call site, free to take and return anything.
 *
 * ponytail: parameters are by value and there is exactly one return value. `out`
 * parameters would need a mutable-reference concept in the node graph; return a
 * `struct` instead, which both languages copy just as cheaply.
 */
export function Fn<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R;
export function Fn<const P extends readonly PslType[]>(
    params: P,
    returns: PslType,
    body: (...args: { [K in keyof P]: PslNode }) => Operand,
): (...args: Operand[]) => PslNode;
export function Fn(
    first_: unknown,
    returns?: PslType,
    body?: (...args: PslNode[]) => Operand,
): unknown {
    if (typeof first_ === 'function') return first_;
    const def: FnDef = { params: first_ as readonly PslType[], returns: returns!, body: body! };
    return (...args: Operand[]): PslNode => {
        if (args.length !== def.params.length) {
            throw new Error(`[psl] this Fn takes ${def.params.length} arguments, got ${args.length}`);
        }
        return new CallFnNode(def, args.map(node));
    };
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
