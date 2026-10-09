export function nowSec() {
  return Math.floor(Date.now() / 1000);
}

export async function dbAll(env, sql, ...params) {
  return (await env.DB.prepare(sql).bind(...params).all()).results;
}

export async function dbGet(env, sql, ...params) {
  return env.DB.prepare(sql).bind(...params).first();
}

export async function dbRun(env, sql, ...params) {
  return env.DB.prepare(sql).bind(...params).run();
}
