/**
 * D1: the read-only mobile dashboard shell. Unauthenticated HTML + inline JS — the user pastes the
 * daemon token ONCE; the page exchanges it (POST /api/dashboard/session) for a short-lived HttpOnly
 * read-only cookie, then polls /api/overview with that cookie. The token never appears in a URL.
 * No build step, no external assets.
 */
export function renderDashboardPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>aisup dashboard</title>
<style>
  :root { color-scheme: dark; }
  body { font: 14px/1.5 -apple-system, system-ui, sans-serif; margin: 0; background: #0b0d10; color: #d7dbe0; }
  header { padding: 12px 16px; background: #14181d; border-bottom: 1px solid #222; font-weight: 600; }
  main { padding: 16px; max-width: 720px; margin: 0 auto; }
  .card { background: #14181d; border: 1px solid #222; border-radius: 8px; padding: 12px 14px; margin-bottom: 12px; }
  .card h2 { margin: 0 0 8px; font-size: 12px; text-transform: uppercase; letter-spacing: .05em; color: #8b929b; }
  .row { display: flex; justify-content: space-between; padding: 2px 0; }
  .muted { color: #8b929b; }
  input, button { font: inherit; padding: 8px 10px; border-radius: 6px; border: 1px solid #333; background: #1b2026; color: #d7dbe0; }
  button { cursor: pointer; }
  #err { color: #ff6b6b; }
  #gate { max-width: 420px; }
</style>
</head>
<body>
<header>aisup <span class="muted">— read-only</span></header>
<main>
  <div id="gate" class="card">
    <h2>Connect</h2>
    <p class="muted">Paste the daemon API token (from <code>~/.aisup/api-token</code>). It is exchanged for a session cookie and never placed in the URL.</p>
    <input id="token" type="password" placeholder="daemon token" autocomplete="off" style="width:100%;box-sizing:border-box">
    <div style="margin-top:8px"><button id="connect">Connect</button> <span id="err"></span></div>
  </div>
  <div id="board" style="display:none">
    <div class="card"><h2>Session</h2><div id="session"></div></div>
    <div class="card"><h2>Accounts</h2><div id="accounts"></div></div>
    <div class="card"><h2>Workers</h2><div id="workers"></div></div>
    <div class="card"><h2>Cost today</h2><div id="cost"></div></div>
    <div class="card"><h2>Recent events</h2><div id="events"></div></div>
    <p class="muted" id="refresh"></p>
  </div>
</main>
<script>
(function () {
  var REFRESH_MS = 5000;
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }); };
  var row = function (a, b) { return '<div class="row"><span>' + esc(a) + '</span><span class="muted">' + esc(b) + '</span></div>'; };

  function render(o) {
    var s = o.session;
    document.getElementById('session').innerHTML = s
      ? row((s.name ? '"' + s.name + '" ' : '') + (s.aisup_session_id || '?'), (s.status || '?') + ' on ' + (s.account || '?'))
      : '<span class="muted">no active session</span>';
    document.getElementById('accounts').innerHTML = (o.accounts || []).map(function (a) {
      var parts = [];
      if (typeof a.score === 'number') parts.push('score ' + a.score.toFixed(0) + '%');
      if (typeof a.five_hour_pct === 'number') parts.push('5h ' + a.five_hour_pct.toFixed(0) + '%');
      if (typeof a.seven_day_pct === 'number') parts.push('7d ' + a.seven_day_pct.toFixed(0) + '%');
      return row(a.name + (a.enabled === false ? ' (disabled)' : ''), (a.state || '?') + (parts.length ? ' · ' + parts.join(', ') : ''));
    }).join('') || '<span class="muted">none</span>';
    var w = o.workers;
    document.getElementById('workers').innerHTML = w
      ? row(w.total + ' total', w.queued + ' queued · ' + w.running + ' running · ' + w.awaiting_approval + ' awaiting')
      : '<span class="muted">disabled</span>';
    document.getElementById('cost').innerHTML = row('total', '$' + (o.cost_today && o.cost_today.total_cost_usd || 0).toFixed(2));
    document.getElementById('events').innerHTML = (o.recent_events || []).slice().reverse().map(function (e) {
      var t = e.ts; try { t = new Date(e.ts).toLocaleTimeString(); } catch (x) {}
      return row(e.event_type + (e.account ? ' [' + e.account + ']' : ''), t);
    }).join('') || '<span class="muted">none</span>';
    document.getElementById('refresh').textContent = 'auto-refreshing every ' + (REFRESH_MS / 1000) + 's';
  }

  var timer = null;
  function poll() {
    fetch('/api/overview', { credentials: 'same-origin' }).then(function (r) {
      if (r.status === 401) { throw new Error('unauthorized'); }
      return r.json();
    }).then(render).catch(function () {
      if (timer) { clearInterval(timer); timer = null; }
      document.getElementById('board').style.display = 'none';
      document.getElementById('gate').style.display = '';
      document.getElementById('err').textContent = 'Session expired — reconnect.';
    });
  }

  function start() {
    document.getElementById('gate').style.display = 'none';
    document.getElementById('board').style.display = '';
    poll();
    timer = setInterval(poll, REFRESH_MS);
  }

  document.getElementById('connect').addEventListener('click', function () {
    var token = document.getElementById('token').value.trim();
    document.getElementById('err').textContent = '';
    fetch('/api/dashboard/session', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: token })
    }).then(function (r) {
      if (!r.ok) { throw new Error('bad token'); }
      document.getElementById('token').value = '';
      start();
    }).catch(function () { document.getElementById('err').textContent = 'Invalid token.'; });
  });

  // If a valid cookie already exists, skip the gate.
  fetch('/api/overview', { credentials: 'same-origin' }).then(function (r) { if (r.ok) { start(); } });
})();
</script>
</body>
</html>`;
}
