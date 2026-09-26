/**
 * 前端统一认证模块（S4-1 多用户体系）。
 * 所有 public 页面引入本文件，通过 window.CNStockAuth 操作登录态与 API 请求。
 */
(function () {
  'use strict';

  const TOKEN_KEY = 'cnstockbot_token';
  const USER_KEY = 'cnstockbot_user';

  let authOverlay = null;
  let authResolve = null;
  let authMode = 'login'; // 'login' | 'register'

  function getToken() {
    return localStorage.getItem(TOKEN_KEY) || '';
  }

  function setToken(token) {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  }

  function getUser() {
    try {
      const raw = localStorage.getItem(USER_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function setUser(user) {
    if (user) localStorage.setItem(USER_KEY, JSON.stringify(user));
    else localStorage.removeItem(USER_KEY);
  }

  function isLoggedIn() {
    return !!getToken();
  }

  function clearToken() {
    setToken('');
    setUser(null);
  }

  function buildOverlay() {
    if (authOverlay) return;
    const el = document.createElement('div');
    el.className = 'auth-overlay';
    el.id = 'cnstock-auth-overlay';
    el.innerHTML = `
      <div class="auth-card">
        <h2 id="cnstock-auth-title">登录</h2>
        <input id="cnstock-auth-username" class="input" type="text" autocomplete="username" placeholder="用户名" />
        <input id="cnstock-auth-password" class="input" type="password" autocomplete="current-password" placeholder="密码" />
        <div class="error" id="cnstock-auth-error"></div>
        <button class="btn btn-primary" id="cnstock-auth-submit">登录</button>
        <button class="btn btn-ghost" id="cnstock-auth-switch">还没有账号？注册</button>
      </div>
    `;
    document.body.appendChild(el);
    authOverlay = el;

    const usernameEl = document.getElementById('cnstock-auth-username');
    const passwordEl = document.getElementById('cnstock-auth-password');
    const errorEl = document.getElementById('cnstock-auth-error');
    const titleEl = document.getElementById('cnstock-auth-title');
    const submitEl = document.getElementById('cnstock-auth-submit');
    const switchEl = document.getElementById('cnstock-auth-switch');

    function setMode(mode) {
      authMode = mode;
      titleEl.textContent = mode === 'login' ? '登录' : '注册';
      submitEl.textContent = mode === 'login' ? '登录' : '注册';
      switchEl.textContent = mode === 'login' ? '还没有账号？注册' : '已有账号？登录';
      errorEl.textContent = '';
    }

    switchEl.onclick = () => setMode(authMode === 'login' ? 'register' : 'login');

    async function submit() {
      const username = usernameEl.value.trim();
      const password = passwordEl.value;
      if (!username || !password) {
        errorEl.textContent = '请输入用户名和密码';
        return;
      }
      submitEl.disabled = true;
      try {
        const endpoint = authMode === 'login' ? '/api/auth/login' : '/api/auth/register';
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password }),
        });
        const data = await res.json();
        if (!res.ok) {
          errorEl.textContent = data.error || '请求失败';
          submitEl.disabled = false;
          return;
        }
        setToken(data.token);
        setUser(data.user);
        el.hidden = true;
        submitEl.disabled = false;
        if (authResolve) { authResolve(data.token); authResolve = null; }
        window.dispatchEvent(new CustomEvent('cnstock:login', { detail: data.user }));
      } catch (e) {
        errorEl.textContent = '网络错误：' + e.message;
        submitEl.disabled = false;
      }
    }

    submitEl.onclick = submit;
    passwordEl.onkeydown = (e) => { if (e.key === 'Enter') submit(); };
    usernameEl.onkeydown = (e) => { if (e.key === 'Enter') passwordEl.focus(); };
  }

  function showAuthOverlay(errorText) {
    buildOverlay();
    authOverlay.hidden = false;
    document.getElementById('cnstock-auth-error').textContent = errorText || '';
    document.getElementById('cnstock-auth-username').focus();
    if (!authResolve) {
      return new Promise((resolve) => { authResolve = resolve; });
    }
    return Promise.resolve(getToken());
  }

  function hideAuthOverlay() {
    if (authOverlay) authOverlay.hidden = true;
  }

  async function ensureToken() {
    const token = getToken();
    if (token) return token;
    return showAuthOverlay();
  }

  async function apiFetch(url, options) {
    const token = await ensureToken();
    options = options || {};
    options.headers = Object.assign({}, options.headers, {
      'Authorization': 'Bearer ' + token,
    });
    const res = await fetch(url, options);
    if (res.status === 401) {
      clearToken();
      await showAuthOverlay('登录已过期，请重新登录');
      return apiFetch(url, options);
    }
    return res;
  }

  async function login(username, password) {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '登录失败');
    setToken(data.token);
    setUser(data.user);
    window.dispatchEvent(new CustomEvent('cnstock:login', { detail: data.user }));
    return data;
  }

  async function register(username, password) {
    const res = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '注册失败');
    setToken(data.token);
    setUser(data.user);
    window.dispatchEvent(new CustomEvent('cnstock:login', { detail: data.user }));
    return data;
  }

  async function logout() {
    const token = getToken();
    if (token) {
      try {
        await fetch('/api/auth/logout', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + token },
        });
      } catch { /* ignore */ }
    }
    clearToken();
    window.dispatchEvent(new CustomEvent('cnstock:logout'));
  }

  window.CNStockAuth = {
    getToken,
    setToken,
    clearToken,
    getUser,
    setUser,
    isLoggedIn,
    showAuthOverlay,
    hideAuthOverlay,
    apiFetch,
    login,
    register,
    logout,
  };
})();
