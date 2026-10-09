import { json } from '../../utils/http.js';
import { userFromRequest, countUsers } from '../../utils/auth.js';

export async function onRequestGet(context) {
  const { env } = context;
  const needsSetup = (await countUsers(env)) === 0;
  const user = needsSetup ? null : await userFromRequest(context);
  return json({ ok: true, needsSetup, user });
}
