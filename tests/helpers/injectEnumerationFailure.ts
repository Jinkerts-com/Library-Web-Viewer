// Bun --preload used by subprocess tests: makes the item enumeration query of
// scripts/generate_thumbnails.ts fail deterministically (a SQLite failure is hard to
// provoke otherwise because db.ts creates the schema at import).
import { Database } from "bun:sqlite";

const originalQuery = Database.prototype.query;
Database.prototype.query = function (this: Database, sql: string) {
    if (/FROM items/i.test(sql) && /^\s*SELECT id, name/i.test(sql)) throw new Error("injected enumeration failure");
    return originalQuery.call(this, sql);
} as typeof Database.prototype.query;
