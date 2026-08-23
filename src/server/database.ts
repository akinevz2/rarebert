/**
 * SQLite persistence layer for the OpenAI-compatible server.
 *
 * Uses `node:sqlite` (`DatabaseSync`) — no external npm dependency.
 * The schema is independent from `lib/core.mjs`'s `Store` class; this
 * module is self-contained and may not import anything from `lib/`.
 *
 * Tables:
 *   classified_messages  — binary classification results from introspection
 *   bash_command_patterns — tokenised bash commands available for short-circuit
 *   server_config         — key/value server configuration
 */

import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import type { ClassificationResult, BashCommandPattern } from './types.ts';

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DATA_DIR =
    process.env.XDG_DATA_HOME
        ? path.join(process.env.XDG_DATA_HOME, 'rarebert')
        : path.join(os.homedir(), '.local', 'share', 'rarebert');

const DEFAULT_DB_PATH = path.join(DATA_DIR, 'server.db');

// ---------------------------------------------------------------------------
// Database class
// ---------------------------------------------------------------------------

export class Database {
    private db: DatabaseSync | null = null;
    private readonly dbPath: string;

    constructor(dbPath: string = DEFAULT_DB_PATH) {
        this.dbPath = dbPath;
    }

    // ---- lifecycle --------------------------------------------------------

    /** Lazily open the database and create tables if missing. */
    private conn(): DatabaseSync {
        if (this.db) return this.db;
        const dir = path.dirname(this.dbPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        this.db = new DatabaseSync(this.dbPath);
        this.db.exec('PRAGMA journal_mode = WAL');
        this.init();
        return this.db;
    }

    /** Create the schema if it doesn't already exist. */
    private init(): void {
        const db = this.conn();
        db.exec(`
            CREATE TABLE IF NOT EXISTS classified_messages (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                message         TEXT    NOT NULL,
                is_bash_command INTEGER NOT NULL,
                raw_response    TEXT    NOT NULL,
                classified_at   INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS bash_command_patterns (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                pattern         TEXT    NOT NULL UNIQUE,
                tokens          TEXT    NOT NULL,
                source_message  TEXT    NOT NULL,
                created_at      INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_bcp_tokens
                ON bash_command_patterns(tokens);

            CREATE TABLE IF NOT EXISTS server_config (
                key   TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
        `);
    }

    /** Close the database connection. */
    close(): void {
        if (this.db) {
            this.db.close();
            this.db = null;
        }
    }

    // ---- classified_messages ---------------------------------------------

    /** Persist a classification result. */
    saveClassification(result: ClassificationResult): void {
        const db = this.conn();
        db.prepare(
            `INSERT INTO classified_messages
                (message, is_bash_command, raw_response, classified_at)
             VALUES (?, ?, ?, ?)`,
        ).run(
            result.message,
            result.isBashCommand ? 1 : 0,
            result.rawResponse,
            result.classifiedAt,
        );
    }

    /** Retrieve recent classifications (newest first). */
    getRecentClassifications(limit = 100): ClassificationResult[] {
        const db = this.conn();
        const rows = db
            .prepare(
                `SELECT message, is_bash_command, raw_response, classified_at
                 FROM classified_messages
                 ORDER BY classified_at DESC
                 LIMIT ?`,
            )
            .all(limit) as Array<{
                message: string;
                is_bash_command: number;
                raw_response: string;
                classified_at: number;
            }>;
        return rows.map((r) => ({
            message: r.message,
            isBashCommand: r.is_bash_command === 1,
            rawResponse: r.raw_response,
            classifiedAt: r.classified_at,
        }));
    }

    // ---- bash_command_patterns -------------------------------------------

    /** Persist a tokenised bash-command pattern. */
    savePattern(pattern: BashCommandPattern): void {
        const db = this.conn();
        db.prepare(
            `INSERT OR REPLACE INTO bash_command_patterns
                (pattern, tokens, source_message, created_at)
             VALUES (?, ?, ?, ?)`,
        ).run(
            pattern.pattern,
            JSON.stringify(pattern.tokens),
            pattern.sourceMessage,
            pattern.createdAt,
        );
    }

    /** Return all stored patterns. */
    getAllPatterns(): BashCommandPattern[] {
        const db = this.conn();
        const rows = db
            .prepare(
                `SELECT id, pattern, tokens, source_message, created_at
                 FROM bash_command_patterns
                 ORDER BY created_at DESC`,
            )
            .all() as Array<{
                id: number;
                pattern: string;
                tokens: string;
                source_message: string;
                created_at: number;
            }>;
        return rows.map((r) => ({
            id: r.id,
            pattern: r.pattern,
            tokens: JSON.parse(r.tokens) as string[],
            sourceMessage: r.source_message,
            createdAt: r.created_at,
        }));
    }

    /**
     * Find patterns whose token array is a prefix of `tokens`.
     * E.g. stored `["ls"]` matches incoming `["ls", "-la"]`.
     */
    matchPatterns(tokens: string[]): BashCommandPattern[] {
        const all = this.getAllPatterns();
        return all.filter((p) => {
            if (p.tokens.length > tokens.length) return false;
            return p.tokens.every((t, i) => t === tokens[i]);
        });
    }

    /** Delete a pattern by id. */
    deletePattern(id: number): void {
        const db = this.conn();
        db.prepare('DELETE FROM bash_command_patterns WHERE id = ?').run(id);
    }

    // ---- server_config ----------------------------------------------------

    getConfig(key: string): string | null {
        const db = this.conn();
        const row = db
            .prepare('SELECT value FROM server_config WHERE key = ?')
            .get(key) as { value: string } | undefined;
        return row ? row.value : null;
    }

    setConfig(key: string, value: string): void {
        const db = this.conn();
        db.prepare(
            `INSERT OR REPLACE INTO server_config (key, value) VALUES (?, ?)`,
        ).run(key, value);
    }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

export const database = new Database();
export default database;
