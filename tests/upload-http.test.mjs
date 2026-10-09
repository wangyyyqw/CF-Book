import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readJsonResponse, responseError } from '../public/upload-http.js';

test('上传接口返回 HTML 时给出可重试的 JSON 错误', async () => {
  await assert.rejects(
    () => readJsonResponse(new Response('<!DOCTYPE html><html>网关错误</html>', { status: 502 }), '分块 18/49'),
    (error) => {
      assert.match(error.message, /分块 18\/49.*非 JSON.*502/);
      assert.equal(error.retryable, true);
      return true;
    }
  );
});

test('上传接口返回 JSON 错误时保留服务端错误并按状态判断重试', () => {
  const error = responseError(new Response('', { status: 409 }), { error: '分块已存在' }, '上传分块');
  assert.equal(error.message, '分块已存在');
  assert.equal(error.retryable, false);
});
