/**
 * The type vocabulary PSL shares between the two backends.
 *
 * Deliberately small: this is what a 2D shader needs, and every entry has an
 * exact equivalent in both GLSL 300 es and WGSL. Nothing here is 16-bit, so the
 * two backends compute bit-for-bit the same thing on the same hardware.
 */
export type PslType = 'bool' | 'int' | 'float' | 'vec2' | 'vec3' | 'vec4' | 'mat3';

/** Which language a {@link PslNode} is being written out as. */
export type PslTarget = 'glsl' | 'wgsl';

const GLSL: Record<PslType, string> = {
    bool: 'bool',
    int: 'int',
    float: 'float',
    vec2: 'vec2',
    vec3: 'vec3',
    vec4: 'vec4',
    mat3: 'mat3',
};

const WGSL: Record<PslType, string> = {
    bool: 'bool',
    int: 'i32',
    float: 'f32',
    vec2: 'vec2<f32>',
    vec3: 'vec3<f32>',
    vec4: 'vec4<f32>',
    mat3: 'mat3x3<f32>',
};

/** PixiJS' own uniform type strings are WGSL spellings, whichever renderer is live. */
export function typeName(type: PslType, target: PslTarget): string {
    return target === 'wgsl' ? WGSL[type] : GLSL[type];
}

/** Components in a type; `0` for scalars and matrices, which is all callers need. */
export function width(type: PslType): number {
    return type === 'vec2' ? 2 : type === 'vec3' ? 3 : type === 'vec4' ? 4 : 0;
}

/**
 * Result type of `a op b`.
 *
 * Both languages promote a scalar against a vector and a matrix against a
 * vector, so the wider operand wins -- except for `mat3 * vec3`, where the
 * *narrower* one is the result.
 */
export function combine(a: PslType, b: PslType): PslType {
    if (a === 'mat3') return b === 'mat3' ? 'mat3' : b;
    if (b === 'mat3') return a;
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
