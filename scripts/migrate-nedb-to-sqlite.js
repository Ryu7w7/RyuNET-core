#!/usr/bin/env node
//
// Convert a savedata directory of legacy NeDB `.db` files (line-delimited
// JSON) into the new SQLite format written by SqliteStore. Each input file
// is replaced in place; the original is preserved with a `.nedb.bak`
// suffix so a rollback is one rename away.
//
// Usage (recommended — picks up the experimental flag automatically):
//   npm run migrate-nedb -- [savedata-dir]
//
// Or directly:
//   node --experimental-sqlite scripts/migrate-nedb-to-sqlite.js [savedata-dir]
//
// Defaults to ./savedata. Idempotent: files already in SQLite format are
// skipped, files already migrated (a sibling `.nedb.bak` exists) are
// skipped. Requires Node 22.5+ for the built-in node:sqlite module
// (stable in 24, experimental in 22.5+/23 — the flag silences the warning).

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { randomBytes } = require('crypto');

const dir = process.argv[2] || path.join(process.cwd(), 'savedata');
if (!fs.existsSync(dir)) {
  console.error(`savedata dir not found: ${dir}`);
  process.exit(1);
}

function isSqliteFile(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(16);
    const n = fs.readSync(fd, buf, 0, 16, 0);
    fs.closeSync(fd);
    if (n < 15) return false;
    return buf.toString('ascii', 0, 15) === 'SQLite format 3';
  } catch {
    return false;
  }
}

// NeDB's reviver for $$date markers. Its native model.js does this plus a
// few other quirks (e.g. unescaping $-prefixed keys), but for actual
// plugin data the only one we hit in practice is dates.
function reviveDates(_key, value) {
  if (value && typeof value === 'object' && typeof value.$$date === 'number') {
    return new Date(value.$$date);
  }
  return value;
}

function parseTs(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return isNaN(t) ? null : t;
  }
  return null;
}

function migrateFile(srcPath) {
  const filename = path.basename(srcPath);

  if (isSqliteFile(srcPath)) {
    console.log(`  skip ${filename} (already SQLite)`);
    return { skipped: true };
  }

  const backup = srcPath + '.nedb.bak';
  if (fs.existsSync(backup)) {
    console.log(`  skip ${filename} (backup ${path.basename(backup)} already exists — looks already migrated)`);
    return { skipped: true };
  }

  console.log(`  migrating ${filename}...`);
  // Parse NDJSON into an in-memory dict so deletes (`{ $$deleted: true }`
  // tombstones) and re-inserts (same _id appearing again — NeDB's append
  // log) collapse to a single live record per _id, matching how NeDB
  // re-builds state at load time.
  const live = new Map();
  const text = fs.readFileSync(srcPath, 'utf8');
  let lineNo = 0;
  let dropped = 0;
  for (const raw of text.split('\n')) {
    lineNo++;
    const line = raw.trim();
    if (!line) continue;
    let doc;
    try { doc = JSON.parse(line, reviveDates); }
    catch { dropped++; continue; }
    if (!doc || typeof doc !== 'object') continue;
    if (doc.$$indexCreated || doc.$$indexRemoved) continue;
    if (!doc._id) {
      // Index assertions and other meta lines may lack _id; ignore.
      continue;
    }
    if (doc.$$deleted) {
      live.delete(doc._id);
      continue;
    }
    live.set(doc._id, doc);
  }

  // Write to a temporary SQLite file, then swap it in. Avoids a partially
  // converted .db if anything goes sideways.
  const tmp = srcPath + '.sqlite.tmp';
  if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  const db = new DatabaseSync(tmp);
  try {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec(`
      CREATE TABLE IF NOT EXISTS documents (
        _id        TEXT PRIMARY KEY,
        __s        TEXT,
        __refid    TEXT,
        createdAt  INTEGER,
        updatedAt  INTEGER,
        data       TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_documents_s        ON documents(__s);
      CREATE INDEX IF NOT EXISTS idx_documents_refid    ON documents(__refid);
      CREATE INDEX IF NOT EXISTS idx_documents_s_refid  ON documents(__s, __refid);
    `);

    const insert = db.prepare(`INSERT INTO documents (_id, __s, __refid, createdAt, updatedAt, data) VALUES (?, ?, ?, ?, ?, ?)`);
    db.exec('BEGIN');
    try {
      for (const doc of live.values()) {
        const _id = String(doc._id || randomBytes(8).toString('hex').toUpperCase());
        const __s = typeof doc.__s === 'string' ? doc.__s : null;
        const __refid = typeof doc.__refid === 'string' ? doc.__refid : null;
        const createdAt = parseTs(doc.createdAt);
        const updatedAt = parseTs(doc.updatedAt) ?? createdAt;
        const persist = { ...doc };
        delete persist._id;
        delete persist.__s;
        delete persist.__refid;
        delete persist.createdAt;
        delete persist.updatedAt;
        // Re-encode any Date values as ISO strings inside the JSON blob.
        // The hot timestamps are promoted to typed columns above; anything
        // else we just pass through the JSON path so it round-trips.
        insert.run(_id, __s, __refid, createdAt, updatedAt, JSON.stringify(persist, (k, v) => {
          if (v instanceof Date) return v.toISOString();
          return v;
        }));
      }
      db.exec('COMMIT');
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch { /* ignore */ }
      throw err;
    }

    db.close();
  } catch (err) {
    try { db.close(); } catch { /* ignore */ }
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    throw err;
  }

  // Atomic-ish swap: rename original out of the way, then drop the new
  // file in. If the second rename fails (Windows AV / indexer briefly
  // holding handles), retry a few times before bailing — and if the
  // retries don't clear it, restore the original from .nedb.bak so the
  // caller is left with the same state they started with.
  fs.renameSync(srcPath, backup);
  let lastErr;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.renameSync(tmp, srcPath);
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
      // Windows EBUSY/EPERM: brief sleep then retry.
      const wait = 100 * (attempt + 1);
      const end = Date.now() + wait;
      while (Date.now() < end) { /* spin */ }
    }
  }
  if (lastErr) {
    try { fs.renameSync(backup, srcPath); } catch { /* leave backup in place */ }
    throw lastErr;
  }

  return {
    migrated: true,
    docs: live.size,
    droppedLines: dropped,
    backup,
  };
}

console.log(`Migrating savedata in ${dir}`);
const entries = fs.readdirSync(dir);
let total = 0;
let migrated = 0;
let skipped = 0;
for (const name of entries) {
  if (!name.endsWith('.db')) continue;
  if (name.endsWith('.bak')) continue;
  total++;
  const full = path.join(dir, name);
  try {
    const r = migrateFile(full);
    if (r.migrated) {
      migrated++;
      console.log(`    ok: ${r.docs} doc(s) migrated; legacy file kept at ${path.basename(r.backup)}`);
    } else {
      skipped++;
    }
  } catch (err) {
    console.error(`    FAILED ${name}: ${err.message}`);
    process.exitCode = 1;
  }
}
console.log(`Done. ${migrated} migrated, ${skipped} skipped (of ${total} .db files).`);
