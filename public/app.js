/**
 * Liam's Master Plan — frontend
 * Views: Today | All Todos | Files | Search
 * Hash-based checkbox toggles, SSE live reload, local LLM triage & briefing.
 */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const state = {
  view: 'today',
  files: [],
  filesIndex: new Map(),       // path -> file
  currentFile: null,
  currentContent: null,
  todos: [],
  searchTimer: null,
  fileFilterTimer: null,
  lastSelfWriteAt: 0,
};

// ---------------- Toast ----------------
function toast(msg, kind = 'info') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast ${kind}`;
  setTimeout(() => t.classList.add('hidden'), 2400);
}

// ---------------- Init ----------------
async function init() {
  setupViewSwitcher();
  setupFilters();
  setupSearch();
  setupModals();
  setupMobile();
  setupSSE();

  $('#refresh-btn').onclick = () => { refreshAll(); };
  $('#brief-btn').onclick = () => openBriefing();
  $('#edit-btn').onclick = openInEditor;
  $('#triage-btn').onclick = () => openTriage({ path: state.currentFile?.path });

  await Promise.all([loadFiles(), loadStats(), loadTodos()]);
  renderActiveView();
  handleHashOnLoad();
}

window.addEventListener('hashchange', handleHashOnLoad);

function handleHashOnLoad() {
  const h = decodeURIComponent(location.hash.slice(1));
  if (!h) return;
  const [ref] = h.split('#');
  if (ref.startsWith('file:')) {
    setView('files');
    const wanted = ref.slice(5);
    const f =
      state.filesIndex.get(wanted) ||
      state.files.find(x => x.path.endsWith(wanted) || x.relativePath === wanted || `${x.directory}/${x.relativePath}` === wanted);
    if (f) openFile(f);
  } else if (['today', 'todos', 'files', 'search'].includes(ref)) {
    setView(ref);
  }
}

// ---------------- View switcher ----------------
function setupViewSwitcher() {
  $$('.view-btn').forEach(btn => {
    btn.onclick = () => setView(btn.dataset.view);
  });
}

function setView(name) {
  state.view = name;
  $$('.view-btn').forEach(b => b.classList.toggle('active', b.dataset.view === name));
  $$('.view').forEach(v => v.classList.toggle('hidden', v.id !== `view-${name}`));
  // sidebar sections relevant for view
  $('#filters').style.display = (name === 'todos' || name === 'today') ? '' : 'none';
  $('#files-section').style.display = (name === 'files') ? '' : 'none';
  renderActiveView();
}

function renderActiveView() {
  if (state.view === 'today') renderToday();
  else if (state.view === 'todos') renderTodos();
  else if (state.view === 'files') renderFiles();
  else if (state.view === 'search') $('#search-input').focus();
}

// ---------------- Filters ----------------
function setupFilters() {
  ['change', 'input'].forEach(evt => {
    $('#filters').addEventListener(evt, () => {
      loadTodos().then(() => state.view === 'todos' && renderTodos());
    });
  });

  $('#file-filter').addEventListener('input', e => {
    clearTimeout(state.fileFilterTimer);
    state.fileFilterTimer = setTimeout(() => renderFileTree(e.target.value.trim().toLowerCase()), 120);
  });
}

function readFilters() {
  const status = document.querySelector('input[name="status"]:checked')?.value || 'open';
  const due = $('#filter-overdue').checked ? 'overdue'
            : $('#filter-today').checked ? 'today'
            : $('#filter-week').checked ? 'this_week'
            : '';
  return {
    status,
    due,
    tag: $('#filter-tag').value.trim(),
    q: $('#filter-text').value.trim(),
  };
}

// ---------------- Data loaders ----------------
async function loadFiles() {
  const res = await fetch('/api/files');
  const data = await res.json();
  state.files = data.files;
  state.filesIndex.clear();
  for (const f of state.files) {
    state.filesIndex.set(f.path, f);
    state.filesIndex.set(`${f.directory}/${f.relativePath}`, f);
  }
  document.title = data.title || 'Plan';
  $('#title').textContent = data.title || 'Plan';
  if (state.view === 'files') renderFileTree();
}

async function loadStats() {
  const r = await fetch('/api/stats');
  const s = await r.json();
  $('#stats-pill').textContent = `${s.todos_open} open · ${s.overdue} overdue · ${s.due_today} today`;
}

async function loadTodos() {
  const f = readFilters();
  const params = new URLSearchParams();
  if (f.status === 'open') params.set('open', 'true');
  if (f.status === 'done') params.set('done', 'true');
  if (f.due) params.set('due', f.due);
  if (f.tag) params.set('tag', f.tag.replace(/^#/, ''));
  if (f.q) params.set('q', f.q);
  params.set('limit', '500');
  const r = await fetch('/api/todos?' + params);
  const data = await r.json();
  state.todos = data.todos;
}

async function refreshAll() {
  await Promise.all([loadFiles(), loadStats(), loadTodos()]);
  renderActiveView();
  toast('Refreshed', 'ok');
}

// ---------------- Today view ----------------
function renderToday() {
  const root = $('#view-today');
  const open = state.todos.filter(t => !t.checked);
  const overdue = open.filter(t => t.due_date && t.due_date < todayStr());
  const today = open.filter(t => t.due_date === todayStr());
  const noDue = open.filter(t => !t.due_date);
  const groups = [
    ['Overdue', overdue, 'overdue'],
    ['Due today', today, 'today'],
    ['Open (no due date)', noDue.slice(0, 100), 'nodue'],
  ];
  root.innerHTML = `
    <section class="today-hero">
      <h2>Today · ${todayStr()}</h2>
      <p class="muted">Quick scan of what matters. Use <b>All Todos</b> for filtering across everything.</p>
    </section>
    ${groups.map(([label, list, cls]) => list.length
      ? `<section class="todo-group">
           <h3 class="group-${cls}">${label} <span class="count">${list.length}</span></h3>
           <ul class="todo-list">
             ${list.map(renderTodoLi).join('')}
           </ul>
         </section>`
      : '').join('')}
    ${open.length === 0 ? '<p class="muted">Inbox zero. Nice.</p>' : ''}
  `;
  wireTodoCheckboxes(root);
}

// ---------------- All Todos view ----------------
function renderTodos() {
  const root = $('#view-todos');
  const grouped = new Map();
  for (const t of state.todos) {
    const key = t.heading_path || t.file_path.split('/').slice(-1)[0];
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(t);
  }
  root.innerHTML = `
    <header class="list-header">
      <span>${state.todos.length} todos</span>
      <button id="triage-filtered" class="btn-sm">🧹 Triage these</button>
    </header>
    ${[...grouped.entries()].map(([heading, list]) => `
      <section class="todo-group">
        <h3>${escape(heading)} <span class="count">${list.length}</span></h3>
        <ul class="todo-list">${list.map(renderTodoLi).join('')}</ul>
      </section>`).join('')}
  `;
  wireTodoCheckboxes(root);
  root.querySelector('#triage-filtered').onclick = () => openTriage({ todos: state.todos.slice(0, 60) });
}

function renderTodoLi(t) {
  const due = t.due_date ? `<span class="due ${dueClass(t.due_date)}">${t.due_date}</span>` : '';
  const tags = (t.tags || []).map(g => `<span class="tag">#${escape(g)}</span>`).join('');
  const fname = t.file_path.split('/').slice(-1)[0];
  return `<li class="todo ${t.checked ? 'checked' : ''}" data-hash="${t.hash}" data-path="${escape(t.file_path)}">
    <input type="checkbox" ${t.checked ? 'checked' : ''} data-hash="${t.hash}" data-path="${escape(t.file_path)}">
    <span class="todo-text">${escape(t.plain_text)}</span>
    ${tags}${due}
    <a class="todo-file" href="#${encodeURIComponent('file:' + relForLink(t.file_path))}">${escape(fname)}</a>
  </li>`;
}

function wireTodoCheckboxes(scope) {
  scope.querySelectorAll('input[type="checkbox"][data-hash]').forEach(cb => {
    cb.addEventListener('change', () => toggleTodo(cb.dataset.path, cb.dataset.hash, cb.checked, cb));
  });
}

async function toggleTodo(path, hash, checked, el) {
  state.lastSelfWriteAt = Date.now();
  try {
    const r = await fetch('/api/file', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, hash, checked }),
    });
    if (!r.ok) throw new Error(await r.text());
    el.closest('.todo')?.classList.toggle('checked', checked);
    loadStats();
    // refresh todos in background so totals stay correct
    loadTodos();
  } catch (e) {
    toast('Toggle failed: ' + e.message, 'error');
    el.checked = !checked;
  }
}

// ---------------- Files view ----------------
function renderFiles() {
  renderFileTree();
}

function renderFileTree(filter = '') {
  const tree = $('#file-tree');
  const groups = new Map();
  for (const f of state.files) {
    if (filter && !(`${f.relativePath} ${f.name}`.toLowerCase().includes(filter))) continue;
    const dir = (f.relativePath.includes('/') ? f.relativePath.split('/').slice(0, -1).join('/') : '(root)');
    if (!groups.has(dir)) groups.set(dir, []);
    groups.get(dir).push(f);
  }
  tree.innerHTML = [...groups.entries()].sort((a,b)=>a[0].localeCompare(b[0])).map(([dir, fs]) => `
    <div class="file-group">
      <div class="file-group-name">${escape(dir)}</div>
      <ul>
        ${fs.map(f => `<li>
          <a href="#${encodeURIComponent('file:' + f.directory + '/' + f.relativePath)}" data-path="${escape(f.path)}">
            ${escape(f.name)} <span class="todo-mini">${f.todos.unchecked}/${f.todos.total}</span>
          </a>
        </li>`).join('')}
      </ul>
    </div>`).join('');
  tree.querySelectorAll('a[data-path]').forEach(a => {
    a.addEventListener('click', e => {
      e.preventDefault();
      const f = state.filesIndex.get(a.dataset.path);
      if (f) {
        history.replaceState(null, '', a.getAttribute('href'));
        openFile(f);
      }
    });
  });
}

async function openFile(file) {
  setView('files');
  state.currentFile = file;
  $('#file-header').classList.remove('hidden');
  $('#current-file').textContent = `${file.directory}/${file.relativePath}`;
  $('#markdown-content').innerHTML = '<p class="muted">Loading…</p>';
  const r = await fetch('/api/file?path=' + encodeURIComponent(file.path));
  const data = await r.json();
  state.currentContent = data;
  const html = marked.parse(data.content || '');
  $('#markdown-content').innerHTML = html;
  // Replace GFM checkboxes with our hash-based ones so clicks persist
  rewriteCheckboxes(data);
}

function rewriteCheckboxes(data) {
  const md = $('#markdown-content');
  const lis = md.querySelectorAll('li');
  const todoMap = new Map(data.todos.map(t => [t.plainText || t.plain_text, t]));
  lis.forEach(li => {
    const input = li.querySelector('input[type="checkbox"]');
    if (!input) return;
    const txt = li.textContent.trim();
    // try exact match first, then prefix
    let todo = todoMap.get(txt);
    if (!todo) {
      for (const [k, v] of todoMap) if (txt.startsWith(k) || k.startsWith(txt)) { todo = v; break; }
    }
    if (!todo) return;
    input.disabled = false;
    input.dataset.hash = todo.hash;
    input.dataset.path = data.path;
    input.addEventListener('change', () => toggleTodo(data.path, todo.hash, input.checked, input));
  });
}

function openInEditor() {
  if (!state.currentFile) return;
  // best effort: vscode then default
  const url = 'vscode://file' + encodeURI(state.currentFile.path);
  window.open(url, '_blank');
}

// ---------------- Search view ----------------
function setupSearch() {
  const input = $('#search-input');
  input.addEventListener('input', () => {
    clearTimeout(state.searchTimer);
    state.searchTimer = setTimeout(runSearch, 200);
  });
}

async function runSearch() {
  const q = $('#search-input').value.trim();
  const out = $('#search-results');
  if (q.length < 2) { out.innerHTML = ''; return; }
  out.innerHTML = '<p class="muted">Searching…</p>';
  const r = await fetch('/api/search?q=' + encodeURIComponent(q));
  const data = await r.json();
  if (!data.results.length) { out.innerHTML = '<p class="muted">No hits.</p>'; return; }
  out.innerHTML = data.results.map(h => {
    const name = h.path.split('/').slice(-1)[0];
    const rel = relForLink(h.path);
    return `<div class="hit">
      <a class="hit-title" href="#${encodeURIComponent('file:' + rel)}">${escape(name)}</a>
      <div class="hit-snippet">${h.snippet || ''}</div>
    </div>`;
  }).join('');
}

// ---------------- LLM ----------------
function setupModals() {
  $('#briefing-close').onclick = () => $('#briefing-modal').classList.add('hidden');
  $('#triage-close').onclick = () => $('#triage-modal').classList.add('hidden');
  $$('.modal').forEach(m => m.addEventListener('click', e => { if (e.target === m) m.classList.add('hidden'); }));
}

async function openBriefing() {
  const modal = $('#briefing-modal');
  modal.classList.remove('hidden');
  $('#briefing-body').textContent = 'Generating with local LLM…';
  try {
    const r = await fetch('/api/llm/summary', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    if (!r.ok) throw new Error(await r.text());
    const d = await r.json();
    $('#briefing-body').innerHTML = `<p class="muted">Model: ${escape(d.model || 'unknown')}</p><div class="prose">${escape(d.text || '').replace(/\n\n/g, '</p><p>').replace(/^/, '<p>') + '</p>'}</div>`;
  } catch (e) {
    $('#briefing-body').innerHTML = `<p class="error">Briefing failed: ${escape(e.message)}.</p><p class="muted">Is Ollama running? <code>ollama serve</code></p>`;
  }
}

async function openTriage({ path, todos } = {}) {
  const modal = $('#triage-modal');
  modal.classList.remove('hidden');
  $('#triage-subtitle').textContent = path ? path.split('/').slice(-1)[0] : `${todos?.length || 'all'} todos`;
  $('#triage-body').innerHTML = '<p class="muted">Running local LLM…</p>';
  try {
    const body = path ? { path, limit: 50 } : { limit: 50 };
    const r = await fetch('/api/llm/triage', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(await r.text());
    const d = await r.json();
    if (!d.actions || d.actions.length === 0) {
      $('#triage-body').innerHTML = `<p class="muted">No suggestions returned. Model: ${escape(d.model || '?')}</p>${d.raw ? `<pre>${escape(d.raw.slice(0,500))}</pre>` : ''}`;
      return;
    }
    $('#triage-body').innerHTML = `<p class="muted">Model: ${escape(d.model)} · ${d.actions.length} suggestions</p>
      <table class="triage-table">
        <thead><tr><th>Hash</th><th>Action</th><th>Reason</th></tr></thead>
        <tbody>
          ${d.actions.map(a => `<tr><td><code>${escape(a.hash || '')}</code></td>
            <td><b>${escape(a.category || '?')}</b>${a.suggested_text ? `<br><small>→ ${escape(a.suggested_text)}</small>` : ''}${a.suggested_heading ? `<br><small>↪ ${escape(a.suggested_heading)}</small>` : ''}</td>
            <td>${escape(a.reason || '')}</td></tr>`).join('')}
        </tbody>
      </table>
      <p class="muted">Suggestions never apply automatically. Click a row to act manually (coming soon).</p>`;
  } catch (e) {
    $('#triage-body').innerHTML = `<p class="error">Triage failed: ${escape(e.message)}</p>`;
  }
}

// ---------------- SSE live reload ----------------
function setupSSE() {
  if (!window.EventSource) return;
  const es = new EventSource('/api/events');
  const debounce = (fn, ms) => { let t; return () => { clearTimeout(t); t = setTimeout(fn, ms); }; };
  const refresh = debounce(async () => {
    if (Date.now() - state.lastSelfWriteAt < 1500) return;
    await Promise.all([loadFiles(), loadStats(), loadTodos()]);
    renderActiveView();
  }, 350);
  es.addEventListener('fileChange', refresh);
  es.addEventListener('fileAdd', refresh);
  es.addEventListener('fileRemove', refresh);
}

// ---------------- Mobile ----------------
function setupMobile() {
  $('#mobile-menu').onclick = () => $('#sidebar').classList.toggle('open');
}

// ---------------- Utilities ----------------
function escape(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function todayStr() { return new Date().toISOString().slice(0, 10); }
function dueClass(d) {
  if (!d) return '';
  const today = todayStr();
  if (d < today) return 'overdue';
  if (d === today) return 'today';
  return '';
}
function relForLink(p) {
  const f = state.filesIndex.get(p);
  return f ? `${f.directory}/${f.relativePath}` : p;
}

init().catch(e => { console.error(e); toast('Init failed: ' + e.message, 'error'); });
