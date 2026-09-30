'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { Pool } = require('pg');

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  try {
    const dir = path.resolve(__dirname, '..', 'migrations');
    const files = (await fs.readdir(dir)).filter((x) => x.endsWith('.sql')).sort();
    for (const file of files) {
      const sql = await fs.readFile(path.join(dir, file), 'utf8');
      await pool.query(sql);
      process.stdout.write(`applied ${file}\n`);
    }
  } finally {
    await pool.end();
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
