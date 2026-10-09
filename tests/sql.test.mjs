import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function jsFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...jsFiles(full));
    else if (name.endsWith('.js')) out.push(full);
  }
  return out;
}

// 挑出可独立执行的 SQL 字面量：列名/表名/占位符不匹配在 prepare 阶段就会暴露，不需要真的连库
function sqlStatements(source) {
  const found = [];
  const literal = /`([^`]*)`/g;
  let match;
  while ((match = literal.exec(source))) {
    const sql = match[1];
    // 带 ${} 插值的是拼装片段，单独 prepare 没有意义，跳过
    if (sql.includes('${')) continue;
    if (/\b(INSERT INTO|UPDATE\s+\w+\s+SET|SELECT\b|DELETE FROM)\b/i.test(sql)) found.push(sql);
  }
  return found;
}

test('所有 SQL 都能在真实 SQLite 上 prepare 成功（表结构、列名与占位符一致）', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(join(ROOT, 'schema.sql'), 'utf8'));

  const failures = [];
  let checked = 0;
  for (const file of jsFiles(join(ROOT, 'functions'))) {
    for (const sql of sqlStatements(readFileSync(file, 'utf8'))) {
      checked += 1;
      try {
        db.prepare(sql);
      } catch (e) {
        failures.push(`${file.slice(ROOT.length + 1)}: ${e.message}`);
      }
    }
  }

  // 下限只用来发现扫描器失灵（比如正则被改坏），不是精确计数
  assert.ok(checked >= 12, `应至少扫描到 12 条 SQL 语句，实际 ${checked}`);
  assert.deepEqual(failures, [], `以下 SQL 无法准备：\n${failures.join('\n')}`);
});
