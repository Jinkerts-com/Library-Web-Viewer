import type { Database } from "bun:sqlite";

/**
 * Creates/migrates the `items` table. Additive only: safe to run against an
 * existing installation. Has no knowledge of where the database lives.
 */
export function ensureSchema(db: Database, log: (msg: string) => void = () => { }) {
    db.run(`CREATE TABLE IF NOT EXISTS items (
      id TEXT PRIMARY KEY,
      name TEXT,
      ext TEXT,
      size INTEGER,
      modificationTime INTEGER,
      btime INTEGER,
      width INTEGER,
      height INTEGER,
      tags TEXT,
      folders TEXT,
      description TEXT,
      palettes TEXT,
      star INTEGER,
      duration REAL,
      isDeleted INTEGER,
      last_scanned INTEGER
    )`);

    try {
        db.run("ALTER TABLE items ADD COLUMN description TEXT");
        log("Migration: Added 'description' column.");
    } catch (e) {
    }

    try {
        db.run("ALTER TABLE items ADD COLUMN palettes TEXT");
        log("Migration: Added 'palettes' column.");
    } catch (e) {
    }

    // Columns that back sorting options; when any is newly added, existing
    // rows lack values, so reset last_scanned to force a full re-scan
    let needsRescan = false;
    for (const colDef of ["btime INTEGER", "star INTEGER", "duration REAL", "isDeleted INTEGER"]) {
        try {
            db.run(`ALTER TABLE items ADD COLUMN ${colDef}`);
            log(`Migration: Added '${colDef.split(' ')[0]}' column.`);
            needsRescan = true;
        } catch (e) {
        }
    }
    if (needsRescan) {
        db.run("UPDATE items SET last_scanned = 0");
        console.log("Schema updated with new sort columns; items will be refreshed on next scan.");
    }

    db.run(`CREATE INDEX IF NOT EXISTS idx_mod_time ON items(modificationTime)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_btime ON items(btime)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_name ON items(name)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_description ON items(description)`);
    log("Indices ensured.");
}
