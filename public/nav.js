import { api, loadMe } from '/api.js';

// 顶栏右侧的账号区，各页面只需放一个 <div id="user-area"></div>
const area = document.getElementById('user-area');

const theme = document.getElementById('theme-toggle');
if (theme) {
  const dark = localStorage.getItem('cf-book-theme') === 'dark';
  document.body.classList.toggle('library-dark', dark);
  theme.textContent = dark ? '浅色' : '暗色';
  theme.setAttribute('aria-label', dark ? '切换到浅色模式' : '切换到暗色模式');
  theme.addEventListener('click', () => {
    const enabled = document.body.classList.toggle('library-dark');
    localStorage.setItem('cf-book-theme', enabled ? 'dark' : 'light');
    theme.textContent = enabled ? '浅色' : '暗色';
    theme.setAttribute('aria-label', enabled ? '切换到浅色模式' : '切换到暗色模式');
  });
}

document.querySelector('.library-menu-list')?.addEventListener('click', (event) => {
  if (event.target.closest('a, button:not(#theme-toggle)')) {
    event.currentTarget.closest('.library-menu')?.removeAttribute('open');
  }
});

document.addEventListener('click', (event) => {
  const menu = document.querySelector('.library-menu');
  if (menu?.open && !menu.contains(event.target)) menu.removeAttribute('open');
});

loadMe().then((data) => {
  if (!area) return;
  const user = data?.user;
  if (!user) {
    area.innerHTML = '<a class="user-link" href="/login">登录</a>';
    return;
  }
  const isAdmin = user.role === 'admin';
  area.innerHTML = `
    ${isAdmin ? '<a class="user-link" href="/users">账号管理</a>' : ''}
    <button id="user-logout" class="user-logout" type="button">退出登录</button>`;
  document.getElementById('user-logout').addEventListener('click', async () => {
    await api('/api/auth/logout', { method: 'POST' });
    location.href = '/login';
  });
});
