import { err } from './utils/http.js';
import { userFromRequest } from './utils/auth.js';

// 登录前即可访问的接口
const PUBLIC_API = new Set(['/api/auth/login', '/api/auth/logout', '/api/auth/me', '/api/auth/setup']);
const PUBLIC_PAGES = new Set(['/login', '/login.html']);

export async function onRequest(context) {
  const { request, next } = context;
  const url = new URL(request.url);
  const path = url.pathname;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  // 页面 = 无扩展名的 GET 路径或 .html；静态资源（.css/.js/.ico 等）不参与鉴权
  const isAsset = /\.[A-Za-z0-9]+$/.test(path) && !path.endsWith('.html');
  const isDocument = request.method === 'GET' && !path.startsWith('/api') && !isAsset;
  const needsPageAuth = isDocument && !PUBLIC_PAGES.has(path);
  const needsApiAuth =
    path.startsWith('/api') && !isAsset && !path.startsWith('/api/covers/') && !PUBLIC_API.has(path);

  // 静态资源不查库，只在页面与受保护接口上解析登录态
  if (needsPageAuth || needsApiAuth) {
    const user = await userFromRequest(context);
    context.data.user = user;
    if (needsApiAuth && !user) return withCors(err('请先登录', 401));
    if (needsPageAuth && !user) {
      return Response.redirect(new URL('/login', url).toString(), 302);
    }
  }

  try {
    return withCors(await next());
  } catch (error) {
    if (!path.startsWith('/api')) throw error;
    console.error('API 请求未处理异常', error);
    return withCors(err('服务器暂时不可用，请稍后重试', 500));
  }
}

function withCors(response) {
  const headers = new Headers(response.headers);
  corsHeaders().forEach((value, key) => headers.set(key, value));
  return new Response(response.body, { status: response.status, headers });
}

function corsHeaders() {
  return new Headers({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-admin-token, authorization',
    'Access-Control-Max-Age': '86400',
  });
}
