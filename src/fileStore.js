// File-backed standings store for the Node server: one JSON per room under `dir`
// (.data/rooms/<CODE>.json, gitignored). Writes are atomic (tmp + rename), so a
// crash mid-write never corrupts a file. See persistence.js for the store contract.

import fs from "node:fs";
import path from "node:path";

export function createFileStore(dir) {
  const fileFor = (code) => path.join(dir, `${code}.json`);
  return {
    read(code) {
      try { return fs.readFileSync(fileFor(code), "utf8"); } catch (_) { return null; }
    },
    write(code, text) {
      fs.mkdirSync(dir, { recursive: true });
      const f = fileFor(code);
      const tmp = `${f}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, text);
      fs.renameSync(tmp, f); // atomic replace on the same filesystem
    },
    remove(code) { fs.unlinkSync(fileFor(code)); },
    list() {
      try { return fs.readdirSync(dir).filter((n) => n.endsWith(".json")).map((n) => n.slice(0, -5)); }
      catch (_) { return []; }
    }
  };
}
