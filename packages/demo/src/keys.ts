/**
 * `e.key` is whatever the IME says: with a Korean layout active WASD arrives as
 * 'ㅁ'/'ㅈ' or, mid-composition, as 'Process'. `e.code` is the physical key and
 * ignores the IME entirely, so the demo reads that and falls back to `e.key`
 * for anything the map does not cover.
 */
const CODES: Record<string, string> = {
    Space: ' ',
    Tab: 'tab',
    ArrowUp: 'arrowup',
    ArrowDown: 'arrowdown',
    ArrowLeft: 'arrowleft',
    ArrowRight: 'arrowright',
    BracketLeft: '[',
    BracketRight: ']',
    Minus: '-',
    Equal: '=',
};

export function keyOf(e: KeyboardEvent): string {
    const c = e.code;
    // ponytail: physical positions, so a Dvorak/AZERTY user gets QWERTY placement.
    // Remap here if anyone complains.
    if (c.startsWith('Key')) return c.slice(3).toLowerCase();
    if (c.startsWith('Digit')) return c.slice(5);
    if (c.startsWith('Numpad')) return c.slice(6).toLowerCase();
    return CODES[c] ?? (e.key || '').toLowerCase();
}
