'use strict';

// Minimal Supabase client (Auth + REST) over fetch, no SDK.
// The publishable key is meant to ship in client code: the data is protected by
// row-level security, which only lets the allow-listed owner read or add rows.
const Cloud = (() => {
  const BASE = 'https://mrkxcfrbmndrlobyjsty.supabase.co';
  const KEY = 'sb_publishable_PyfrQnGsUIFZkBeYPRiNCA_d3TM_2Fo';
  const AUTH_KEY = 'calcolo.v1.auth';

  let auth = readAuth();
  let refreshing = null;

  function readAuth() {
    try { return JSON.parse(localStorage.getItem(AUTH_KEY) || 'null'); } catch { return null; }
  }
  function writeAuth(value) {
    auth = value;
    try {
      if (value) localStorage.setItem(AUTH_KEY, JSON.stringify(value));
      else localStorage.removeItem(AUTH_KEY);
    } catch { /* storage unavailable: the session lasts until the app closes */ }
  }
  function fromTokenResponse(data) {
    return {
      access: data.access_token,
      refresh: data.refresh_token,
      expiresAt: Date.now() + Math.max(0, (data.expires_in || 3600) - 60) * 1000,
      email: (data.user && data.user.email) || (auth && auth.email) || '',
    };
  }

  async function errorFrom(response) {
    const data = await response.json().catch(() => ({}));
    const error = new Error(data.error_description || data.msg || data.message || `HTTP ${response.status}`);
    error.status = response.status;
    error.code = data.error_code || data.code || data.error || '';
    return error;
  }

  async function tokenRequest(grant, body) {
    const response = await fetch(`${BASE}/auth/v1/token?grant_type=${grant}`, {
      method: 'POST',
      headers: { apikey: KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw await errorFrom(response);
    return response.json();
  }

  async function signIn(email, password) {
    writeAuth(fromTokenResponse(await tokenRequest('password', { email, password })));
  }

  // One refresh at a time: Supabase rotates refresh tokens, so parallel refreshes would fail.
  async function accessToken() {
    if (!auth) throw Object.assign(new Error('Non hai effettuato l\'accesso.'), { status: 401 });
    if (Date.now() < auth.expiresAt) return auth.access;
    if (!refreshing) {
      refreshing = tokenRequest('refresh_token', { refresh_token: auth.refresh })
        .then((data) => writeAuth(fromTokenResponse(data)))
        .catch((error) => {
          // A rejected refresh token means the login is over; a network error does not.
          if (error.status >= 400 && error.status < 500) writeAuth(null);
          throw error;
        })
        .finally(() => { refreshing = null; });
    }
    await refreshing;
    return auth.access;
  }

  async function signOut() {
    const previous = auth;
    writeAuth(null);
    if (!previous) return;
    try {
      await fetch(`${BASE}/auth/v1/logout`, {
        method: 'POST',
        headers: { apikey: KEY, Authorization: `Bearer ${previous.access}` },
      });
    } catch { /* offline: the token simply expires */ }
  }

  async function rest(path, options = {}) {
    const token = await accessToken();
    const response = await fetch(`${BASE}/rest/v1/${path}`, {
      ...options,
      headers: {
        apikey: KEY,
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
    });
    if (!response.ok) throw await errorFrom(response);
    return response;
  }

  // Idempotent: rows already on the server (same id) are skipped.
  async function upload(rows) {
    if (!rows.length) return;
    await rest('sessions?on_conflict=id', {
      method: 'POST',
      headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' },
      body: JSON.stringify(rows),
    });
  }

  async function download() {
    const response = await rest('sessions?select=id,preset,score,played_at,slow,source&order=played_at.asc&limit=10000');
    return response.json();
  }

  return {
    signIn,
    signOut,
    upload,
    download,
    get signedIn() { return Boolean(auth); },
    get email() { return auth ? auth.email : ''; },
  };
})();
