import path from "path";
import Database from "better-sqlite3";

// Read-only definitions DB. Words are stored in uppercase (the table's
// PK), so callers can pass any case — the lookup uppercases first.
// Opened once and held for the process lifetime; better-sqlite3 prepared
// statements run in microseconds, so a per-click lookup is cheap.
let lookupStmt = null;

function getStmt() {
  if (lookupStmt) return lookupStmt;
  const dbPath = path.join(process.cwd(), "data", "all.sqlite3");
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  lookupStmt = db.prepare("SELECT def FROM defs WHERE word = ?");
  return lookupStmt;
}

export function lookupDefinition(word) {
  if (typeof word !== "string" || !word) return null;
  const row = getStmt().get(word.toUpperCase());
  return row ? row.def : null;
}
