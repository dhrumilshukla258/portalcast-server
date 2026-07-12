import sqlite3 from "sqlite3";
import path from "path";
import fs from "fs";

interface ColumnInfo {
  name: string;
  type: string;
  notnull: number;
  dflt_value: any;
  pk: number;
}

async function getTableColumnsInfo(db: sqlite3.Database, tableName: string, schemaPrefix: string = ""): Promise<ColumnInfo[]> {
  const pragmaQuery = schemaPrefix 
    ? `PRAGMA ${schemaPrefix}.table_info(\`${tableName}\`);` 
    : `PRAGMA table_info(\`${tableName}\`);`;
    
  return new Promise((resolve, reject) => {
    db.all(pragmaQuery, (err, rows: any[]) => {
      if (err) return reject(err);
      resolve(rows.map((row) => ({
        name: row.name,
        type: row.type,
        notnull: row.notnull,
        dflt_value: row.dflt_value,
        pk: row.pk
      })));
    });
  });
}

async function getTables(db: sqlite3.Database): Promise<string[]> {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%';`,
      (err, rows: any[]) => {
        if (err) return reject(err);
        resolve(rows.map((row) => row.name));
      }
    );
  });
}

export async function mergeDatabases(targetPath: string, sourcePath: string): Promise<void> {
  console.log(`Merging ${sourcePath} -> ${targetPath}...`);
  
  if (!fs.existsSync(sourcePath)) {
    console.warn(`⚠️ Source database at ${sourcePath} does not exist. Skipping merge.`);
    return;
  }
  
  if (!fs.existsSync(targetPath)) {
    console.log(`📄 Target database at ${targetPath} does not exist. Initializing as copy of source.`);
    fs.copyFileSync(sourcePath, targetPath);
    return;
  }

  const targetDb = new sqlite3.Database(targetPath);
  const sourceDb = new sqlite3.Database(sourcePath);

  try {
    const targetTables = await getTables(targetDb);
    const sourceTables = await getTables(sourceDb);

    // Find tables that exist in both databases
    const commonTables = targetTables.filter((t) => sourceTables.includes(t));

    // Close sourceDb connection so we can ATTACH it in the targetDb connection
    await new Promise<void>((resolve, reject) => {
      sourceDb.close((err) => (err ? reject(err) : resolve()));
    });

    // ATTACH source database to target database connection
    await new Promise<void>((resolve, reject) => {
      targetDb.run(`ATTACH DATABASE ? AS source_db;`, [sourcePath], (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    for (const table of commonTables) {
      const targetCols = await getTableColumnsInfo(targetDb, table);
      const sourceCols = await getTableColumnsInfo(targetDb, table, "source_db");
      
      const sourceColNames = sourceCols.map(c => c.name);

      const targetColNames: string[] = [];
      const selectExpressions: string[] = [];

      for (const col of targetCols) {
        targetColNames.push(`\`${col.name}\``);

        const existsInSource = sourceColNames.includes(col.name);

        if (existsInSource) {
          // Wrap keys in COALESCE to avoid constraint violations if they are NULL in source
          if (col.name === "profileId" || col.name === "userId") {
            selectExpressions.push(`COALESCE(\`${col.name}\`, 1) AS \`${col.name}\``);
          } else {
            selectExpressions.push(`\`${col.name}\``);
          }
        } else {
          // Column exists in target but is missing from source database
          if (col.name === "profileId") {
            selectExpressions.push(`1 AS \`profileId\``);
          } else if (col.name === "userId") {
            selectExpressions.push(`1 AS \`userId\``);
          } else if (col.dflt_value !== null && col.dflt_value !== undefined) {
            selectExpressions.push(`${col.dflt_value} AS \`${col.name}\``);
          } else if (col.notnull === 1) {
            // Provide sensible fallback based on type to satisfy NOT NULL constraints
            const typeLower = col.type.toLowerCase();
            if (typeLower.includes("int") || typeLower.includes("num") || typeLower.includes("real") || typeLower.includes("float")) {
              selectExpressions.push(`0 AS \`${col.name}\``);
            } else {
              selectExpressions.push(`'' AS \`${col.name}\``);
            }
          } else {
            selectExpressions.push(`NULL AS \`${col.name}\``);
          }
        }
      }

      if (targetColNames.length === 0) {
        console.warn(`⚠️ No columns found for table: ${table}. Skipping.`);
        continue;
      }

      const colsString = targetColNames.join(", ");
      const selectColsString = selectExpressions.join(", ");
      const query = `INSERT OR REPLACE INTO \`${table}\` (${colsString}) SELECT ${selectColsString} FROM source_db.\`${table}\`;`;

      console.log(`🔄 Merging table '${table}' (${targetCols.length} columns target, ${sourceCols.length} source)...`);
      await new Promise<void>((resolve, reject) => {
        targetDb.run(query, (err) => {
          if (err) {
            console.error(`❌ Error merging table ${table}:`, err);
            reject(err);
          } else {
            resolve();
          }
        });
      });
    }

    // DETACH source database
    await new Promise<void>((resolve, reject) => {
      targetDb.run(`DETACH DATABASE source_db;`, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    console.log("✨ Merge complete!");
  } finally {
    await new Promise<void>((resolve) => {
      targetDb.close(() => resolve());
    });
  }
}

// Support running directly via CLI
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.error("Usage: ts-node mergeDatabases.ts <targetPath> <sourcePath>");
    process.exit(1);
  }
  const [target, source] = args;
  mergeDatabases(path.resolve(target), path.resolve(source))
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("Merge execution failed:", err);
      process.exit(1);
    });
}
