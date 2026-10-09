import { api, loadMe } from '/api.js';

const $ = (id) => document.getElementById(id);
const form = $('auth-form');
const submitBtn = $('auth-submit');
const msgEl = $('auth-msg');

let mode = 'login';

function showMessage(text) {
  msgEl.textContent = text;
}

function applyMode(next) {
  mode = next;
  const setup = next === 'setup';
  $('auth-title').textContent = setup ? '创建管理员账号' : '登录书库';
  $('auth-sub').textContent = setup ? '首次使用，先建一个管理员账号' : '请输入账号继续';
  $('display-name-field').hidden = !setup;
  $('service-token-field').hidden = !setup;
  submitBtn.textContent = setup ? '创建并进入' : '登录';
  $('password').setAttribute('autocomplete', setup ? 'new-password' : 'current-password');
}

async function init() {
  const data = await loadMe();
  if (data?.user) {
    location.replace('/library');
    return;
  }
  applyMode(data?.needsSetup ? 'setup' : 'login');
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  submitBtn.disabled = true;
  showMessage('');

  const payload = {
    username: $('username').value.trim(),
    password: $('password').value,
  };
  if (mode === 'setup') payload.displayName = $('display-name').value.trim();

  try {
    const headers = { 'Content-Type': 'application/json' };
    if (mode === 'setup') headers['x-admin-token'] = $('service-token').value.trim();
    const res = await api(mode === 'setup' ? '/api/auth/setup' : '/api/auth/login', {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
    const result = await res.json().catch(() => ({}));
    if (!res.ok || !result.ok) {
      showMessage(result.error || `操作失败（${res.status}）`);
      return;
    }
    location.replace('/library');
  } catch (e) {
    showMessage(`网络错误：${e.message}`);
  } finally {
    submitBtn.disabled = false;
  }
});

init();
