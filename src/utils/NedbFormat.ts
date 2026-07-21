// Minimal NeDB on-disk format helpers — NDJSON one doc per line, with
// Date objects encoded as { $$date: <ms epoch> } so they round-trip.
//
// We keep this in tree because:
//   1. The savedata migration export endpoint (src/webui/index.ts) needs to
//      emit files that import cleanly into other (still-NeDB) Asphyxia
//      servers, so the wire format has to match NeDB's own serialize().
//   2. The migration script reads legacy savedata files in the same format.

export function serializeDoc(obj: any): string {
  return JSON.stringify(obj, function (key, value) {
    if (typeof value === 'function') return undefined;
    if (value === undefined) return undefined;
    if (value === null) return null;
    // `this[key]` exposes the original (pre-toJSON) value, which is how
    // we detect a Date despite JSON.stringify having already converted it
    // to an ISO string by the time the replacer sees `value`.
    const raw = (this as any)[key];
    if (raw && typeof raw.getTime === 'function' && !isNaN(raw.getTime())) {
      return { $$date: raw.getTime() };
    }
    return value;
  });
}

export function deserializeDoc(line: string): any {
  return JSON.parse(line, function (_key, value) {
    if (value && typeof value === 'object' && typeof value.$$date === 'number') {
      return new Date(value.$$date);
    }
    return value;
  });
}
