/**
 * The type vocabulary PSL shares between the two backends.
 *
 * Every entry has an exact equivalent in GLSL 300 es and in WGSL. Nothing here
 * is 16-bit, so the two backends compute bit-for-bit the same thing on the same
 * hardware. Structs and arrays are composed rather than named in the union, so a
 * type is either one of the primitive spellings or a description of a shape.
 */
export type PslPrimitive =
    | 'bool'
    | 'int'
    | 'uint'
    | 'float'
    | 'vec2'
    | 'vec3'
    | 'vec4'
    | 'mat3'
    | 'mat4';

export interface PslStructType {
    readonly kind: 'struct';
    /** Shared by both languages, and unique per shader -- see `struct()`. */
    readonly name: string;
    /** In declaration order: it is the memory layout, not just a lookup table. */
    readonly members: Readonly<Record<string, PslType>>;
}

export interface PslArrayType {
    readonly kind: 'array';
    readonly of: PslType;
    readonly length: number;
}

export type PslType = PslPrimitive | PslStructType | PslArrayType;

/** Which language a {@link PslNode} is being written out as. */
export type PslTarget = 'glsl' | 'wgsl';

const GLSL: Record<PslPrimitive, string> = {
    bool: 'bool',
    int: 'int',
    uint: 'uint',
    float: 'float',
    vec2: 'vec2',
    vec3: 'vec3',
    vec4: 'vec4',
    mat3: 'mat3',
    mat4: 'mat4',
};

const WGSL: Record<PslPrimitive, string> = {
    bool: 'bool',
    int: 'i32',
    uint: 'u32',
    float: 'f32',
    vec2: 'vec2<f32>',
    vec3: 'vec3<f32>',
    vec4: 'vec4<f32>',
    mat3: 'mat3x3<f32>',
    mat4: 'mat4x4<f32>',
};

/** PixiJS' own uniform type strings are WGSL spellings, whichever renderer is live. */
export function typeName(type: PslType, target: PslTarget): string {
    if (typeof type === 'string') return target === 'wgsl' ? WGSL[type] : GLSL[type];
    if (type.kind === 'struct') return type.name;
    // For an array this is the constructor spelling; declarations go through
    // `declarator`, because GLSL puts the size after the *name* there.
    return target === 'wgsl'
        ? `array<${typeName(type.of, target)}, ${type.length}>`
        : `${typeName(type.of, target)}[${type.length}]`;
}

/** One declared name: `n : T` in WGSL, `T n` in GLSL, `T n[k]` for a GLSL array. */
export function declarator(name: string, type: PslType, target: PslTarget): string {
    if (target === 'wgsl') return `${name} : ${typeName(type, 'wgsl')}`;
    if (typeof type === 'object' && type.kind === 'array') {
        return `${typeName(type.of, 'glsl')} ${name}[${type.length}]`;
    }
    return `${typeName(type, 'glsl')} ${name}`;
}

/** Components in a vector; `0` for everything else, which is all callers need. */
export function width(type: PslType): number {
    return type === 'vec2' ? 2 : type === 'vec3' ? 3 : type === 'vec4' ? 4 : 0;
}

export function isMatrix(type: PslType): boolean {
    return type === 'mat3' || type === 'mat4';
}

/** Integers index and switch; floats and vectors do not. */
export function isInteger(type: PslType): boolean {
    return type === 'int' || type === 'uint';
}

/**
 * Result type of `a op b`.
 *
 * Both languages promote a scalar against a vector, and a matrix against a
 * vector gives the *vector* back. Structs and arrays have no operators, so the
 * left type simply stands.
 */
export function combine(a: PslType, b: PslType): PslType {
    if (typeof a !== 'string' || typeof b !== 'string') return a;
    if (isMatrix(a)) return width(b) > 0 ? b : a;
    if (isMatrix(b)) return width(a) > 0 ? a : b;
    return width(a) >= width(b) ? a : b;
}

/** A literal, written so that both languages read it as a float. */
export function floatLiteral(value: number): string {
    if (!Number.isFinite(value)) throw new Error(`[psl] ${value} is not a writable literal`);
    const text = Number.isInteger(value) ? value.toFixed(1) : String(value);
    // Unary minus binds looser than swizzling and member access in both
    // languages, so a negative literal has to carry its own parentheses.
    return value < 0 ? `(${text})` : text;
}

/** An integer literal. `u` is the unsigned suffix in both languages. */
export function intLiteral(value: number, unsigned: boolean): string {
    const text = `${value | 0}${unsigned ? 'u' : ''}`;
    return value < 0 ? `(${text})` : text;
}
