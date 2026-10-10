import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onRequestGet } from '../functions/api/library/facets.js';
import { createD1 } from './helpers/d1.mjs';

test('书库分面接口一次返回当前账号可见的标签和书架', async () => {
  const DB = createD1();
  DB.exec(`INSERT INTO users (id, username, display_name, password_hash, role, disabled, created_at, updated_at)
    VALUES ('u1', 'admin', '管理员', 'x', 'admin', 0, 0, 0);
    INSERT INTO shelves (id, name, scope, owner, created_by, created_at, updated_at)
    VALUES ('s1', '待读', 'personal', 'admin', 'admin', 0, 0);`);
  const response = await onRequestGet({
    env: { DB },
    request: new Request('https://example.com/api/library/facets'),
    data: { user: { username: 'admin', role: 'admin' } },
  });
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.equal(data.ok, true);
  assert.ok(Array.isArray(data.tags.dimensions));
  assert.equal(data.shelves[0].id, 's1');
});
