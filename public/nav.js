import { api, loadMe, escapeHtml } from '/api.js';

// 顶栏右侧的账号区，各页面只需放一个 <div id="user-area"></div>
const area = document.getElementById('user-area');

loadMe().then((data) => {
  if (!area) return;
  const user = data?.user;
  if (!user) {
    area.innerHTML = '<a class="user-link" href="/login">登录</a>';
    return;
  }
  const isAdmin = user.role === 'admin';
  const name = escapeHtml(user.display_name || user.username);
  area.innerHTML = `
    ${isAdmin ? '<a class="user-link" href="/users">账号管理</a>' : ''}
    <span class="user-name">${name}</span>
    <button id="user-logout" class="user-logout" type="button">退出登录</button>`;
  document.getElementById('user-logout').addEventListener('click', async () => {
    await api('/api/auth/logout', { method: 'POST' });
    location.href = '/login';
  });
  document.querySelector('.library-menu-list')?.addEventListener('click', (event) => {
    if (event.target.closest('a')) area.closest('.library-menu')?.removeAttribute('open');
  });
});
