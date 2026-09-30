// Shared by every page: JSON calls to our API, and a toast for messages.
async function api(url, body) {
  const opts = body === undefined
    ? { headers: { 'X-Holotable': '1' } }
    : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Holotable': '1' }, body: JSON.stringify(body) };
  const res = await fetch(url, opts);
  let data = {};
  try { data = await res.json(); } catch (e) { /* not JSON */ }
  if (!res.ok || data.ok === false) {
    if (res.status === 401) { location.href = '/login?next=' + encodeURIComponent(location.pathname); }
    throw new Error(data.error || ('Request failed (' + res.status + ')'));
  }
  return data;
}

let toastTimer = null;
function toast(msg, isError) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.className = 'toast' + (isError ? ' error' : '');
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, isError ? 6000 : 2500);
}

async function changeOwnPassword() {
  const p = prompt('New password for your account (8+ characters):');
  if (!p) return;
  try { const r = await api('/api/users/password', { password: p }); toast(r.message); }
  catch (err) { toast(err.message, true); }
}
