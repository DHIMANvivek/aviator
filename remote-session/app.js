const $ = id => document.getElementById(id);
let job, requestKey, polling = false;
async function request(url, body) {
  const response = await fetch(url, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Request failed: ${response.status}`);
  return data;
}
function fail(error) { $('status').textContent = error.message; }
async function refresh() {
  if (polling) return;
  polling = true;
  try {
    const state = await request('/api/status');
    $('login').hidden = true;
    $('workspace').hidden = false;
    $('status').textContent = `${state.name}: ${state.connected ? 'workspace connected' : 'waiting for workspace connector'}${state.busy ? ' · task running' : ''}`;
    $('submit').disabled = !state.connected || state.busy;
    job = state.job;
    if (job) {
      const result = await request(`/api/jobs/${job}`);
      $('output').textContent = `${result.state}\n\n${result.events.map(e => `[${e.type}] ${e.text}`).join('\n\n')}`;
      $('cancel').disabled = result.state !== 'running';
    }
  } catch (e) { fail(e); }
  finally { polling = false; }
}
$('login').onsubmit = async event => {
  event.preventDefault();
  try { await request('/login', { token: $('token').value }); $('token').value = ''; await refresh(); } catch (e) { fail(e); }
};
$('prompt').oninput = () => { requestKey = undefined; };
$('task').onsubmit = async event => {
  event.preventDefault();
  requestKey ||= crypto.randomUUID();
  try { const result = await request('/api/jobs', { key: requestKey, text: $('prompt').value }); job = result.id; await refresh(); } catch (e) { fail(e); }
};
$('cancel').onclick = async () => { try { if (job) await request(`/api/jobs/${job}/cancel`, {}); await refresh(); } catch (e) { fail(e); } };
$('logout').onclick = async () => { try { await request('/logout', {}); location.reload(); } catch (e) { fail(e); } };
setInterval(refresh, 2500);
refresh();
