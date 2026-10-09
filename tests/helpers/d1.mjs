import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

// 用真实 SQLite 模拟 Cloudflare D1 的调用面，
// 这样接口测试跑的是真 SQL，能顺带发现列名、JOIN、分页这类问题。
export function createD1() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(join(ROOT, 'schema.sql'), 'utf8'));

  return {
    exec(sql) {
      db.exec(sql);
    },
    prepare(sql) {
      const statement = {
        params: [],
        bind(...params) {
          statement.params = params;
          return statement;
        },
        async first() {
          const row = db.prepare(sql).get(...statement.params);
          return row === undefined ? null : row;
        },
        async all() {
          return { results: db.prepare(sql).all(...statement.params) };
        },
        async run() {
          const info = db.prepare(sql).run(...statement.params);
          return { meta: { changes: Number(info.changes) } };
        },
      };
      return statement;
    },
    async batch(statements) {
      return Promise.all(statements.map((s) => s.run()));
    },
  };
}

export function seedUser(db, { id, username, displayName = username, role = 'member' }) {
  db.exec(
    `INSERT INTO users (id, username, display_name, password_hash, role, disabled, created_at, updated_at)
     VALUES ('${id}', '${username}', '${displayName}', 'x', '${role}', 0, 0, 0)`
  );
}
