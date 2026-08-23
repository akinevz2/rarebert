/**
 * Colour-coded logging utility for the OpenAI-compatible server.
 * 
 * Colours:
 *   \x1b[32m GREEN  - success, completion, confirmation
 *   \x1b[33m YELLOW - warnings, events, messages
 *   \x1b[34m BLUE   - info, startup, status
 *   \x1b[35m MAGENTA - middleware, pipeline events
 *   \x1b[36m CYAN   - debugging, details
 *   \x1b[0m   RESET   - reset to default
 *   \x1b[1m BOLD   - bold text
 */

const COLORS = {
    RESET: '\x1b[0m',
    BOLD: '\x1b[1m',
    GREEN: '\x1b[32m',
    YELLOW: '\x1b[33m',
    BLUE: '\x1b[34m',
    MAGENTA: '\x1b[35m',
    CYAN: '\x1b[36m',
};

// Format with colour
export function colour(text: string, color: keyof typeof COLORS): string {
    return `${COLORS[color] || COLORS.RESET}${text}${COLORS.RESET}`;
}

// Short aliases
export function green(text: string) { return colour(text, 'GREEN'); }
export function yellow(text: string) { return colour(text, 'YELLOW'); }
export function blue(text: string) { return colour(text, 'BLUE'); }
export function magenta(text: string) { return colour(text, 'MAGENTA'); }
export function cyan(text: string) { return colour(text, 'CYAN'); }
export function bold(text: string) { return colour(text, 'BOLD'); }

// Log levels
export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'success';

const LevelColors: Record<LogLevel, keyof typeof COLORS> = {
    debug: 'CYAN',
    info: 'BLUE',
    warn: 'YELLOW',
    error: 'YELLOW',  // use yellow for errors (with bold)
    success: 'GREEN',
};

export function shouldLog(level: LogLevel, minLevel: LogLevel = 'info'): boolean {
    const order: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3, success: 4 };
    return order[level] >= order[minLevel];
}

// ---------------------------------------------------------------------------
// Logger class
// ---------------------------------------------------------------------------

export class Logger {
    private level: LogLevel;

    constructor(level: LogLevel = 'info') {
        this.level = level;
    }

    log(level: LogLevel, message: string, ...args: unknown[]): void {
        if (!shouldLog(level, this.level)) return;
        const timestamp = new Date().toISOString().substr(11, 8);
        const color = LevelColors[level];
        const base = `${colour(timestamp, 'CYAN')} [${colour(level.toUpperCase(), color)}]`;
        if (args.length) {
            console.log(base + ' ' + colour(message, color), ...args);
        } else {
            console.log(base + ' ' + colour(message, color));
        }
    }

    debug(message: string, ...args: unknown[]): void { this.log('debug', message, ...args); }
    info(message: string, ...args: unknown[]): void { this.log('info', message, ...args); }
    warn(message: string, ...args: unknown[]): void { this.log('warn', message, ...args); }
    error(message: string, ...args: unknown[]): void { this.log('error', message, ...args); }
    success(message: string, ...args: unknown[]): void { this.log('success', message, ...args); }
}

// Singleton
export const log = new Logger();