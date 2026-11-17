const $ = s => document.querySelector(s);
let repositories = [], selected = null, busy = false;
async function api(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json' } });
  if (response.status === 401) { window.location.replace("/"); throw new Error("Please sign in again."); }
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Request failed');
  return data;
}
function node(tag, text, className) { const el = document.createElement(tag); if (text) el.textContent = text; if (className) el.className = className; return el; }
function notice(message) { $('#notice').textContent = message; $('#notice').hidden = !message; }
function openConnect() { $('#import-error').textContent = ''; $('#connect').showModal(); $('#url').focus(); }
$('#add').onclick = $('#welcome-add').onclick = openConnect;
$('#close').onclick = () => { if (!busy) $('#connect').close(); };
$('#connect').addEventListener('cancel', e => { if (busy) e.preventDefault(); });
async function refresh() {
  repositories = await api('/api/repos'); $('#count').textContent = repositories.length;
  $('#repos').replaceChildren();
  for (const repo of repositories) {
    const button = node('button', '', repo.id === selected ? 'repo active' : 'repo');
    button.append(node('span', '⌁', 'repo-icon'), node('span', repo.name.split('/').pop()));
    button.title = repo.name; button.onclick = () => select(repo.id).catch(e => notice(e.message)); $('#repos').append(button);
  }
}
async function select(id) {
  selected = id; await refresh();
  const repo = repositories.find(r => r.id === id); if (!repo) return;
  $('#welcome').hidden = true; $('#workspace').hidden = false; $('#current').textContent = repo.name;
  $('#repo-title').textContent = repo.name.split('/').pop();
  $('#stats').textContent = `${repo.files} files · ${repo.chunkCount} passages · ${repo.skipped} files skipped · ${repo.commit.slice(0, 7)} · Indexed ${new Date(repo.createdAt).toLocaleDateString()}`;
  const messages = await api(`/api/repos/${id}/messages`);
  if (selected !== id) return;
  $('#messages').replaceChildren(); messages.forEach(renderMessage); $('#starter').hidden = messages.length > 0; $('#question').focus();
}
function renderMessage(message) {
  const article = node('article', '', 'exchange');
  article.append(node('div', 'YOU', 'message-label'), node('h3', message.question), node('div', '◈ CODEATLAS', 'message-label answer-label'), node('p', message.answer, 'answer'));
  if (message.citations.length) {
    article.append(node('div', `SOURCE EVIDENCE · ${message.citations.length}`, 'message-label'));
    message.citations.forEach((source, index) => {
      const details = node('details', '', 'source'); const summary = node('summary', `[${index + 1}] ${source.symbol ? source.symbol + " · " : ""}${source.path}  ·  L${source.startLine}–${source.endLine} · ${source.complete ? "Full " + source.kind : "Excerpt"}`);
      const pre = node('pre'); pre.append(node('code', source.body));
      const link = node('a', 'View on GitHub ↗'); link.href = source.url; link.target = '_blank'; link.rel = 'noopener noreferrer';
      details.append(summary, pre, link); article.append(details);
    });
  }
  $('#messages').append(article); $('#starter').hidden = true;
}
$('#import').onsubmit = async e => {
  e.preventDefault(); if (busy) return; busy = true;
  $('#import-button').disabled = true; $('#progress').hidden = false; $('#import-error').textContent = '';
  try { const repo = await api('/api/repos', { method: 'POST', body: JSON.stringify({ url: $('#url').value.trim() }) }); $('#connect').close(); $('#url').value = ''; await select(repo.id); notice('Repository connected. Your index is ready.'); }
  catch (error) { $('#import-error').textContent = error.message; }
  finally { busy = false; $('#import-button').disabled = false; $('#progress').hidden = true; }
};
$('#ask').onsubmit = async e => {
  e.preventDefault(); const question = $('#question').value.trim(); if (!question || busy || !selected) return;
  busy = true; $('#send').disabled = true; $('#send').textContent = 'Finding evidence…'; notice(''); const id = selected;
  try { const message = await api(`/api/repos/${id}/ask`, { method: 'POST', body: JSON.stringify({ question }) }); if (selected === id) { renderMessage(message); $('#question').value = ''; $('#ask').scrollIntoView({ behavior: 'smooth', block: 'end' }); } }
  catch (error) { notice(error.message); }
  finally { busy = false; $('#send').disabled = false; $('#send').textContent = 'Ask question ↑'; }
};
$('#question').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#ask').requestSubmit(); } });
document.querySelectorAll('.suggestions button').forEach(button => { button.onclick = () => { $('#question').value = button.textContent; $('#question').focus(); }; });
$('#delete').onclick = async () => {
  if (busy || !selected || !confirm('Remove this local index and its question history?')) return;
  try { await api(`/api/repos/${selected}`, { method: 'DELETE', body: '{}' }); selected = null; await refresh(); if (repositories.length) await select(repositories[0].id); else { $('#welcome').hidden = false; $('#workspace').hidden = true; $('#current').textContent = 'Overview'; } notice('Repository removed.'); }
  catch (error) { notice(error.message); }
};
(async () => { try { const health = await api('/api/health'); $('#fleet-link').hidden = !health.fleetEngine; $('#mode').textContent = health.mode === 'model' ? `● ${health.model}` : '● Local evidence mode'; await refresh(); if (repositories.length) await select(repositories[0].id); } catch (error) { notice(error.message); } })();

fetch('/api/account').then(async response => {
  if (!response.ok) return;
  const account = await response.json();
  $('#account-name').textContent = account.name;
  $('#account-email').textContent = account.email;
  $('#account').hidden = false;
}).catch(() => {});
