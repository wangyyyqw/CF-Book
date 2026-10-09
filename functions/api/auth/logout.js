import { jsonWithCookies } from '../../utils/http.js';
import { destroySession, readCookie, clearSessionCookie, isSecureRequest, SESSION_COOKIE } from '../../utils/auth.js';

export async function onRequestPost(context) {
  const { request, env } = context;
  await destroySession(env, readCookie(request, SESSION_COOKIE));
  return jsonWithCookies({ ok: true }, [
    clearSessionCookie({ secure: isSecureRequest(request) }),
  ]);
}
