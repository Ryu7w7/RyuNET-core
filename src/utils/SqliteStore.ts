// Drop-in replacement for the slice of @seald-io/nedb's Datastore API that
// EamuseIO.ts uses. Backed by a single SQLite file per affiliation, with
// one `documents` table whose data column is a JSON blob. The indexed
// columns (__s collection discriminator, __refid profile owner) cover the
// hot lookups; everything else lands in JSON.
//
// Goals:
//  - Same async method names + shapes (findAsync, findOneAsync,
//    insertAsync, updateAsync, removeAsync, countAsync, ensureIndexAsync,
//    loadDatabaseAsync) so EamuseIO needs only constructor swap.
//  - Same NeDB query / update operator semantics. Implemented in JS
//    against full collection slices pulled by indexed columns; any
//    perf cost is dwarfed by NeDB's "load every record into memory at
//    boot" cost we no longer pay.
//  - findAsync returns a thenable cursor that also supports .sort().
//    skip().limit().execAsync() — both call shapes appear in callers.

// node:sqlite ships with Node 22.5+ (stable in 24) — no native build, no
// Visual Studio. Loaded via require to avoid a compile-time dependency on
// the Node typings exposing it (older @types/node may not declare it).
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
type DatabaseType = InstanceType<typeof DatabaseSync>;

import { randomBytes } from 'crypto';
import { get as lget, set as lset, unset as lunset, isPlainObject, isEqual } from 'lodash';

export interface StoreOptions {
  filename: string;
  timestampData?: boolean;
}

interface RawRow {
  _id: string;
  __s: string | null;
  __refid: string | null;
  createdAt: number | null;
  updatedAt: number | null;
  data: string;
}

type Doc = Record<string, any>;

// =========================================
//                Matching
// =========================================
//
// NeDB-compatible matcher. Walks a query object and returns true iff the
// document satisfies every clause. Supports the full operator set used in
// the asphyxia codebase: $lt $lte $gt $gte $in $nin $ne $eq $regex $exists
// $size $elemMatch, plus the logical operators $or $and $not $where, plus
// dotted-path field access for nested objects.

function matchValue(actual: any, expected: any): boolean {
  if (expected instanceof RegExp) return typeof actual === 'string' && expected.test(actual);
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return false;
    if (actual.length !== expected.length) return false;
    return actual.every((v, i) => isEqual(v, expected[i]));
  }
  if (expected === null || typeof expected !== 'object') {
    if (Array.isArray(actual)) return actual.includes(expected);
    return isEqual(actual, expected);
  }
  return isEqual(actual, expected);
}

function matchOperators(actual: any, ops: Record<string, any>): boolean {
  for (const op of Object.keys(ops)) {
    const opVal = ops[op];
    switch (op) {
      case '$lt':       if (!(actual <  opVal)) return false; break;
      case '$lte':      if (!(actual <= opVal)) return false; break;
      case '$gt':       if (!(actual >  opVal)) return false; break;
      case '$gte':      if (!(actual >= opVal)) return false; break;
      case '$eq':       if (!matchValue(actual, opVal)) return false; break;
      case '$ne':       if (matchValue(actual, opVal)) return false; break;
      case '$in':       if (!Array.isArray(opVal) || !opVal.some(v => matchValue(actual, v))) return false; break;
      case '$nin':      if (Array.isArray(opVal) && opVal.some(v => matchValue(actual, v))) return false; break;
      case '$exists':   if (Boolean(opVal) !== (actual !== undefined)) return false; break;
      case '$regex':    {
        const re = opVal instanceof RegExp ? opVal : new RegExp(opVal);
        if (typeof actual !== 'string' || !re.test(actual)) return false;
        break;
      }
      case '$size':     if (!Array.isArray(actual) || actual.length !== opVal) return false; break;
      case '$elemMatch': {
        if (!Array.isArray(actual)) return false;
        if (!actual.some(item => matchClause(item, opVal))) return false;
        break;
      }
      default:
        // Unknown operator → treat as literal-equality on a sub-object key.
        if (!matchValue(actual?.[op], opVal)) return false;
    }
  }
  return true;
}

// One field clause inside a query: either a literal value, a regexp, or
// an operator object ({ $gt: 5 }, { $in: [...] }). Used for both top-level
// fields and $elemMatch inner clauses.
function matchField(actual: any, clause: any): boolean {
  if (clause instanceof RegExp) return typeof actual === 'string' && clause.test(actual);
  if (isPlainObject(clause)) {
    const keys = Object.keys(clause);
    const allOps = keys.length > 0 && keys.every(k => k.startsWith('$'));
    if (allOps) return matchOperators(actual, clause);
  }
  return matchValue(actual, clause);
}

// Match a query clause against a doc-like object. Also used as the
// $elemMatch inner matcher (where `doc` is one array element).
function matchClause(doc: any, query: any): boolean {
  if (!isPlainObject(query)) return false;
  for (const key of Object.keys(query)) {
    const value = query[key];
    if (key === '$or') {
      if (!Array.isArray(value) || !value.some(sub => matchClause(doc, sub))) return false;
    } else if (key === '$and') {
      if (!Array.isArray(value) || !value.every(sub => matchClause(doc, sub))) return false;
    } else if (key === '$not') {
      if (matchClause(doc, value)) return false;
    } else if (key === '$where') {
      try { if (!value.call(doc)) return false; } catch { return false; }
    } else {
      const actual = key.includes('.') ? lget(doc, key) : doc?.[key];
      if (!matchField(actual, value)) return false;
    }
  }
  return true;
}

// =========================================
//                Updates
// =========================================
//
// NeDB-compatible update operator application. Operates on a deep clone
// of the doc; caller persists if the result differs.

function setPath(doc: any, path: string, val: any) {
  if (path.includes('.')) lset(doc, path, val);
  else doc[path] = val;
}

function getPath(doc: any, path: string): any {
  if (path.includes('.')) return lget(doc, path);
  return doc?.[path];
}

function unsetPath(doc: any, path: string) {
  if (path.includes('.')) lunset(doc, path);
  else delete doc[path];
}

function applyUpdate(doc: Doc, update: any): Doc {
  const clone = JSON.parse(JSON.stringify(doc));
  const keys = Object.keys(update);
  const isOpUpdate = keys.length > 0 && keys.every(k => k.startsWith('$'));

  if (!isOpUpdate) {
    // Whole-doc replacement (NeDB semantics): preserve _id, drop everything
    // else, copy in the new fields.
    const preserved = { _id: clone._id };
    return { ...preserved, ...JSON.parse(JSON.stringify(update)) };
  }

  for (const op of keys) {
    const ops = update[op];
    if (!isPlainObject(ops)) continue;
    for (const path of Object.keys(ops)) {
      const opVal = ops[path];
      switch (op) {
        case '$set':
          setPath(clone, path, opVal);
          break;
        case '$unset':
          unsetPath(clone, path);
          break;
        case '$inc': {
          const cur = getPath(clone, path);
          setPath(clone, path, (typeof cur === 'number' ? cur : 0) + Number(opVal));
          break;
        }
        case '$max': {
          const cur = getPath(clone, path);
          if (cur === undefined || opVal > cur) setPath(clone, path, opVal);
          break;
        }
        case '$min': {
          const cur = getPath(clone, path);
          if (cur === undefined || opVal < cur) setPath(clone, path, opVal);
          break;
        }
        case '$push': {
          const cur = getPath(clone, path);
          const arr = Array.isArray(cur) ? cur : [];
          if (isPlainObject(opVal) && Array.isArray(opVal.$each)) {
            arr.push(...opVal.$each);
          } else {
            arr.push(opVal);
          }
          setPath(clone, path, arr);
          break;
        }
        case '$addToSet': {
          const cur = getPath(clone, path);
          const arr = Array.isArray(cur) ? cur : [];
          const add = (v: any) => { if (!arr.some(x => isEqual(x, v))) arr.push(v); };
          if (isPlainObject(opVal) && Array.isArray(opVal.$each)) opVal.$each.forEach(add);
          else add(opVal);
          setPath(clone, path, arr);
          break;
        }
        case '$pop': {
          const cur = getPath(clone, path);
          if (Array.isArray(cur) && cur.length > 0) {
            if (opVal === -1) cur.shift();
            else cur.pop();
            setPath(clone, path, cur);
          }
          break;
        }
        case '$pull': {
          const cur = getPath(clone, path);
          if (Array.isArray(cur)) {
            let next: any[];
            if (isPlainObject(opVal) && Array.isArray((opVal as any).$in)) {
              const banned = (opVal as any).$in;
              next = cur.filter(x => !banned.some((v: any) => isEqual(v, x)));
            } else if (isPlainObject(opVal)) {
              next = cur.filter(x => !matchClause(x, opVal));
            } else {
              next = cur.filter(x => !isEqual(x, opVal));
            }
            setPath(clone, path, next);
          }
          break;
        }
      }
    }
  }
  return clone;
}

// =========================================
//                Cursor
// =========================================
//
// findAsync returns one of these. Awaiting it executes; chaining .sort()
// or .limit() / .skip() builds up a query plan first. .execAsync() and
// .exec() also work for callers that prefer to be explicit.

class Cursor<T extends Doc> implements PromiseLike<T[]> {
  private _sort: Record<string, 1 | -1> | null = null;
  private _limit: number | null = null;
  private _skip: number | null = null;
  constructor(private fetch: () => T[]) {}

  sort(spec: Record<string, 1 | -1>): this { this._sort = spec; return this; }
  limit(n: number): this { this._limit = n; return this; }
  skip(n: number): this { this._skip = n; return this; }

  async exec(): Promise<T[]> {
    let rows = this.fetch();
    if (this._sort) {
      const keys = Object.keys(this._sort);
      rows = rows.slice().sort((a, b) => {
        for (const k of keys) {
          const dir = this._sort![k];
          const av = lget(a, k);
          const bv = lget(b, k);
          if (av < bv) return -1 * dir;
          if (av > bv) return  1 * dir;
        }
        return 0;
      });
    }
    if (this._skip !== null) rows = rows.slice(this._skip);
    if (this._limit !== null) rows = rows.slice(0, this._limit);
    return rows;
  }

  execAsync(): Promise<T[]> { return this.exec(); }

  then<TResult1 = T[], TResult2 = never>(
    onfulfilled?: ((value: T[]) => TResult1 | PromiseLike<TResult1>) | undefined | null,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | undefined | null
  ): PromiseLike<TResult1 | TResult2> {
    return this.exec().then(onfulfilled, onrejected);
  }
}

// =========================================
//                Datastore
// =========================================

export class SqliteStore {
  private db: DatabaseType;
  private filename: string;
  private timestampData: boolean;

  constructor(opts: StoreOptions) {
    this.filename = opts.filename;
    this.timestampData = opts.timestampData !== false;
    this.db = new DatabaseSync(this.filename);
    // WAL gives us concurrent readers + a single writer; durable enough
    // for arcade game state and dramatically faster on bulk score writes
    // than the default rollback journal.
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    // Don't fail fast when a single writer holds the lock during a burst —
    // wait up to 5s (same order as the in-game HTTP timeout) so Asian
    // players on high RTT don't get an instant SQLITE_BUSY.
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec(`
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

    // Add generated columns for the two most-queried JSON fields so SQL
    // can filter and join on them with an index instead of pulling every
    // row into JS. VIRTUAL means SQLite recomputes on read — no extra
    // storage. We swallow "duplicate column name" so re-opening an
    // already-migrated DB is a no-op; the previous PRAGMA table_info
    // check returned empty under node:sqlite's prepare/.all() so it kept
    // re-running the ALTER and crashing on the second boot.
    const addColumnIfMissing = (sql: string) => {
      try {
        this.db.exec(sql);
      } catch (err: any) {
        if (!/duplicate column/i.test(err?.message || '')) throw err;
      }
    };
    addColumnIfMissing(
      `ALTER TABLE documents ADD COLUMN _collection TEXT GENERATED ALWAYS AS (json_extract(data, '$.collection')) VIRTUAL`
    );
    addColumnIfMissing(
      `ALTER TABLE documents ADD COLUMN _mid INTEGER GENERATED ALWAYS AS (CAST(json_extract(data, '$.mid') AS INTEGER)) VIRTUAL`
    );
    addColumnIfMissing(
      `ALTER TABLE documents ADD COLUMN _version INTEGER GENERATED ALWAYS AS (CAST(json_extract(data, '$.version') AS INTEGER)) VIRTUAL`
    );
    // Indexes covering the hot query patterns:
    //   - collection alone  (hiscore scan, nautica list)
    //   - collection + version (hiscore scan narrows to one version)
    //   - refid + collection (load_m: all scores for a player)
    //   - refid + collection + mid (save_m: one score row for a player+song)
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_documents_collection       ON documents(_collection);
      CREATE INDEX IF NOT EXISTS idx_documents_coll_version     ON documents(_collection, _version);
      CREATE INDEX IF NOT EXISTS idx_documents_s_collection     ON documents(__s, _collection);
      CREATE INDEX IF NOT EXISTS idx_documents_refid_collection ON documents(__refid, _collection);
      CREATE INDEX IF NOT EXISTS idx_documents_refid_coll_mid   ON documents(__refid, _collection, _mid);
    `);
  }

  // No-op equivalents — present so EamuseIO calls them without changes.
  async loadDatabaseAsync(): Promise<void> { /* opened in constructor */ }
  async ensureIndexAsync(_opts: { fieldName: string }): Promise<void> { /* see __s/__refid covered indices above */ }

  // Manual transaction wrapper. better-sqlite3 had a friendly `db.transaction(fn)`
  // helper; node:sqlite doesn't, so we BEGIN/COMMIT around the body and roll
  // back on any throw. Synchronous-only, which is fine since our writers
  // never await inside a transaction.
  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      try { this.db.exec('ROLLBACK'); } catch { /* ignore secondary failure */ }
      throw err;
    }
  }

  // =========================================
  //                Reads
  // =========================================

  // Build the SQL prefilter for indexed columns. Anything more complex is
  // applied in JS against the rows we pull. The aim is "fetch the smallest
  // slice that's correct" — narrow on __s and __refid when the query
  // pins them, else table-scan (acceptable; collections are small).
  private prefilter(query: any): { sql: string; params: any[] } {
    const wheres: string[] = [];
    const params: any[] = [];
    if (query && isPlainObject(query)) {
      const s = query.__s;
      if (typeof s === 'string') { wheres.push('__s = ?'); params.push(s); }
      const r = query.__refid;
      if (typeof r === 'string') { wheres.push('__refid = ?'); params.push(r); }
      const id = query._id;
      if (typeof id === 'string') { wheres.push('_id = ?'); params.push(id); }
      // Generated column filters — these hit indexes and avoid JS-side scanning
      const coll = query.collection;
      if (typeof coll === 'string') { wheres.push('_collection = ?'); params.push(coll); }
      const mid = query.mid;
      if (typeof mid === 'number') { wheres.push('_mid = ?'); params.push(mid); }
      const version = query.version;
      if (typeof version === 'number') { wheres.push('_version = ?'); params.push(version); }
    }
    return {
      sql: wheres.length ? ' WHERE ' + wheres.join(' AND ') : '',
      params,
    };
  }

  // Pull candidate rows (SQL-narrowed by indexed cols) and JS-filter the
  // remainder. Hydrates `data` JSON into a single doc object that also
  // carries `_id`/`__s`/`__refid`/`createdAt`/`updatedAt` for matching.
  private fetchMatching(query: any): Doc[] {
    const { sql, params } = this.prefilter(query);
    const stmt = this.db.prepare(`SELECT _id, __s, __refid, createdAt, updatedAt, data FROM documents${sql}`);
    const rows = stmt.all(...params) as unknown as RawRow[];
    const out: Doc[] = [];
    for (const r of rows) {
      let parsed: Doc;
      try { parsed = JSON.parse(r.data); } catch { continue; }
      const doc: Doc = {
        ...parsed,
        _id: r._id,
        __s: r.__s ?? parsed.__s ?? undefined,
        __refid: r.__refid ?? parsed.__refid ?? undefined,
      };
      // NeDB exposes timestamps as Date objects when timestampData is on;
      // mirror that so callers' `new Date(doc.createdAt)` / sort behavior
      // matches the old store exactly.
      if (this.timestampData) {
        if (r.createdAt != null) doc.createdAt = new Date(r.createdAt);
        else if (parsed.createdAt != null) doc.createdAt = new Date(parsed.createdAt);
        if (r.updatedAt != null) doc.updatedAt = new Date(r.updatedAt);
        else if (parsed.updatedAt != null) doc.updatedAt = new Date(parsed.updatedAt);
      }
      if (doc.__s === undefined) delete doc.__s;
      if (doc.__refid === undefined) delete doc.__refid;
      if (matchClause(doc, query)) out.push(doc);
    }
    return out;
  }

  findAsync<T = Doc>(query: any, _projection?: any): Cursor<T> {
    return new Cursor<T>(() => this.fetchMatching(query) as T[]);
  }

  async findOneAsync<T = Doc>(query: any, _projection?: any): Promise<T | null> {
    const docs = this.fetchMatching(query);
    return (docs.length > 0 ? (docs[0] as T) : null) as any;
  }

  async countAsync(query: any): Promise<number> {
    return this.fetchMatching(query).length;
  }

  // =========================================
  //                Writes
  // =========================================

  async insertAsync<T = Doc>(rawDoc: any): Promise<T> {
    const now = Date.now();
    const doc: Doc = { ...rawDoc };
    if (!doc._id) doc._id = generateId();
    if (this.timestampData) {
      if (doc.createdAt === undefined) doc.createdAt = new Date(now).toISOString();
      if (doc.updatedAt === undefined) doc.updatedAt = new Date(now).toISOString();
    }
    const __s = typeof doc.__s === 'string' ? doc.__s : null;
    const __refid = typeof doc.__refid === 'string' ? doc.__refid : null;
    const ts = parseTs(doc.createdAt) ?? now;
    const uts = parseTs(doc.updatedAt) ?? ts;

    // Persist payload sans the columns we promote — keeps the JSON tight.
    const persist: Doc = { ...doc };
    delete persist._id; delete persist.__s; delete persist.__refid;
    delete persist.createdAt; delete persist.updatedAt;

    this.db.prepare(`INSERT INTO documents (_id, __s, __refid, createdAt, updatedAt, data) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(doc._id, __s, __refid, ts, uts, JSON.stringify(persist));
    return doc as T;
  }

  // Update behavior matches NeDB:
  //   - Without `multi`, only the first match is updated.
  //   - With `upsert`, no match → insert from query+update.
  //   - `returnUpdatedDocs: true` → returns the updated doc(s); else a count.
  async updateAsync<T = Doc>(
    query: any,
    update: any,
    options: { upsert?: boolean; multi?: boolean; returnUpdatedDocs?: boolean } = {}
  ): Promise<any> {
    const matched = this.fetchMatching(query);
    const targets = options.multi ? matched : matched.slice(0, 1);

    if (targets.length === 0) {
      if (options.upsert) {
        // NeDB upsert: start with the literal-equality fields from the query,
        // then apply the update. Operator updates on a non-existent doc end
        // up creating a doc whose only fields are the query equalities + the
        // update operators' results; matches NeDB's behavior.
        const seed: Doc = {};
        for (const k of Object.keys(query)) {
          const v = query[k];
          if (k.startsWith('$')) continue;
          if (isPlainObject(v) || v instanceof RegExp) continue; // operators / regexps don't seed
          seed[k] = v;
        }
        const upd = applyUpdate(seed, update);
        const inserted = await this.insertAsync(upd);
        return options.returnUpdatedDocs ? [inserted] : 1;
      }
      return options.returnUpdatedDocs ? [] : 0;
    }

    const updated: Doc[] = [];
    const updateStmt = this.db.prepare(
      `UPDATE documents SET __s = ?, __refid = ?, createdAt = ?, updatedAt = ?, data = ? WHERE _id = ?`
    );
    this.transaction(() => {
      for (const doc of targets) {
        const next = applyUpdate(doc, update);
        if (this.timestampData) next.updatedAt = new Date().toISOString();
        const __s = typeof next.__s === 'string' ? next.__s : null;
        const __refid = typeof next.__refid === 'string' ? next.__refid : null;
        const cts = parseTs(next.createdAt) ?? null;
        const uts = parseTs(next.updatedAt) ?? Date.now();

        const persist: Doc = { ...next };
        delete persist._id; delete persist.__s; delete persist.__refid;
        delete persist.createdAt; delete persist.updatedAt;

        updateStmt.run(__s, __refid, cts, uts, JSON.stringify(persist), doc._id);
        updated.push(next);
      }
    });

    return options.returnUpdatedDocs ? (options.multi ? updated : updated[0]) : updated.length;
  }

  async removeAsync(query: any, options: { multi?: boolean } = {}): Promise<number> {
    const matched = this.fetchMatching(query);
    const targets = options.multi ? matched : matched.slice(0, 1);
    if (targets.length === 0) return 0;
    const stmt = this.db.prepare(`DELETE FROM documents WHERE _id = ?`);
    this.transaction(() => {
      for (const d of targets) stmt.run(d._id);
    });
    return targets.length;
  }
}

// =========================================
//                Helpers
// =========================================

function generateId(): string {
  // 16 hex chars — opaque to plugins, similar density to NeDB's 16-char
  // alphanum id.
  return randomBytes(8).toString('hex').toUpperCase();
}

function parseTs(v: any): number | null {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return isNaN(t) ? null : t;
  }
  return null;
}
