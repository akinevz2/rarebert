// ---------------------------------------------------------------------------
// symbols.mjs — central registry of glyphs and ANSI styles used across
// rarebert's terminal output. Import from here instead of inlining escape
// sequences or redefining named constants per module.
// ---------------------------------------------------------------------------

// --- Raw glyphs (visible characters) ---

export const TICK = '✓';
export const STAR = '*';
export const DIAMOND = '◆';
export const WARNING = '⚠';
export const ARROW = '→';

// --- Styled glyphs (glyph wrapped in ANSI codes) ---

export const YELLOW_TICK = `\x1b[33m${TICK}\x1b[0m`;
export const YELLOW_STAR = `\x1b[33m${STAR}\x1b[0m`;
export const GREEN_TICK = `\x1b[32m${TICK}\x1b[0m`;

// --- ANSI style codes ---

export const RESET = '\x1b[0m';
export const BOLD = '\x1b[1m';
export const DIM = '\x1b[2m';
export const BOLD_DIM = '\x1b[1;2m';
export const RED_BOLD = '\x1b[1;31m';
export const YELLOW = '\x1b[33m';
export const GREEN = '\x1b[32m';
export const RED = '\x1b[31m';

// --- Terminal control ---

export const CLEAR_SCREEN = '\x1B[2J\x1B[H';
