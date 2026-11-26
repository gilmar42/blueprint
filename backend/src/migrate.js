import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execute, one, pool, tenantId, validateConfig } from './common.js';

export async function migrate() {
  validateConfig();
  await execute(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version VARCHAR(255) PRIMARY KEY,
    applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB`);
  const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../internal/platform/migrations');
  const files = (await readdir(migrationsDir)).filter((file) => file.endsWith('.sql')).sort();
  for (const file of files) {
    if (await one('SELECT version FROM schema_migrations WHERE version=?', [file])) continue;
    const sql = await readFile(path.join(migrationsDir, file), 'utf8');
    for (const statement of sql.split(';').map((part) => part.trim()).filter(Boolean)) await execute(statement);
    await execute('INSERT INTO schema_migrations(version) VALUES(?)', [file]);
    console.log(`Applied migration ${file}`);
  }
  await execute("INSERT IGNORE INTO tenants(id,name) VALUES(?,'Workspace local')", [tenantId]);
  console.log('Database migrations applied');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  migrate().then(() => pool.end()).catch(async (error) => { console.error('Migration failed:', error); await pool.end(); process.exit(1); });
}
