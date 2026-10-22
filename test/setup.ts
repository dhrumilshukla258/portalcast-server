// Loaded before every test file (package.json "test"): the server's data folder (database,
// generated secret.key, snapshot files) goes to a fresh temporary folder, never the repository.
import fs from "fs";
import os from "os";
import path from "path";

if (!process.env.SQLITE_DB_PATH) process.env.SQLITE_DB_PATH = fs.mkdtempSync(path.join(os.tmpdir(), "pc-test-data-"));
