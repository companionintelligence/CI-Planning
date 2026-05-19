/**
 * Companion Planning — Stage-1 frontend
 * Views: Today | Todos | Files | Search
 * Adds: PWA (service worker + install prompt), ⌘K command palette,
 * theme toggle, triage accept-suggestion buttons, skeleton loaders.
 */

const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => root.querySelectorAll(s);

const state = {
  view: 'today',
  files: [],
  filesIndex: new Map(),
  currentFile: null,
  currentContent: null,
  todos: [],
  searchTimer: null,
  fileFilterTimer: null,
  lastSelfWriteAt: 0,
  deferredInstall: null,
  theme: localStorage.getItem('cp.theme') || 'auto',
};

// ---------------- View Transition helper ----------------
function viewTransition(fn) {
  if (document.startViewTransition) {
    document.startViewTransition(fn);
  } else {
    fn();
  }
}

// ---------------- Toast ----------------
function toast(msg, kind = 'info', ms = 2400) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast ${kind}`;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add('hidden'), ms);
}

// ---------------- PWA: service worker & install ----------------
function setupPWA() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(e => console.warn('sw failed', e));
  }
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    state.deferredInstall = e;
    $('#install-section').hidden = false;
  });
  $('#install-btn').onclick = async () => {
    if (!state.deferredInstall) return;
    state.deferredInstall.prompt();
    const { outcome } = await state.deferredInstall.userChoice;
    if (outcome === 'accepted') {
      $('#install-section').hidden = true;
      toast('Installed', 'ok');
    }
    state.deferredInstall = null;
  };
  window.addEventListener('appinstalled', () => {
    $('#install-section').hidden = true;
    toast('App installed', 'ok');
  });
}

// ---------------- Theme ----------------
function applyTheme(t) {
  document.body.dataset.theme = t;
  localStorage.setItem('cp.theme', t);
  const meta = document.querySelector('meta[name="theme-color"]:not([media])');
  if (meta) {
    const dark = t === 'dark' || (t === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
    meta.setAttribute('content', dark ? '#0f1115' : '#fafbfc');
  }
}
function cycleTheme() {
  const order = ['auto', 'light', 'dark'];
  const i = order.indexOf(state.theme);
  state.theme = order[(i + 1) % order.length];
  applyTheme(state.theme);
  toast(`Theme: ${state.theme}`, 'info', 1200);
}

// ---------------- Init ----------------
async function init() {
  applyTheme(state.theme);
  setupPWA();
  setupViewSwitcher();
  setupFilters();
  setupSearch();
  setupModals();
  setupMobile();
  setupSSE();
  setupKeybindings();
  setupCommandPalette();

  $('#refresh-btn').onclick = () => { refreshAll(); };
  $('#brief-btn').onclick = () => openBriefing();
  $('#edit-btn').onclick = openInEditor;
  $('#triage-btn').onclick = () => openTriage({ path: state.currentFile?.path });
  $('#theme-btn').onclick = cycleTheme;
  $('#cmdk-btn').onclick = openCommandPalette;

  showSkeletons();
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
    const f = state.filesIndex.get(wanted) ||
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
  if (state.view === name) return;
  state.view = name;
  viewTransition(() => {
    $$('.view-btn').forEach(b => b.classList.toggle('active', b.dataset.view === name));
    $$('.view').forEach(v => v.classList.toggle('hidden', v.id !== `view-${name}`));
    $('#filters').style.display = (name === 'todos' || name === 'today') ? '' : 'none';
    $('#files-section').style.display = (name === 'files') ? '' : 'none';
    renderActiveView();
  });
  if (location.hash !== `#${name}` && !location.hash.startsWith('#file:')) {
    history.replaceState(null, '', `#${name}`);
  }
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
      loadTodos().then(() => (state.view === 'todos' || state.view === 'today') && renderActiveView());
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
  return { status, due, tag: $('#filter-tag').value.trim(), q: $('#filter-text').value.trim() };
}

// ---------------- Skeletons ----------------
function showSkeletons() {
  const root = $('#view-today');
  root.innerHTML = `
    <div class="today-hero"><h2 class="skel skel-title"></h2><p class="muted skel skel-line"></p></div>
    ${'<section class="todo-group"><h3 class="skel skel-h"></h3>' +
      '<ul class="todo-list">' +
      Array.from({length: 5}).map(() => '<li class="todo skel-row"><span class="skel skel-line"></span></li>').join('') +
      '</ul></section>'}
  `;
}

// ---------------- Data loaders ----------------
async function loadFiles() {
  try {
    const res = await fetch('/api/files');
    const data = await res.json();
    state.files = data.files;
    state.filesIndex.clear();
    for (const f of state.files) {
      state.filesIndex.set(f.path, f);
      state.filesIndex.set(`${f.directory}/${f.relativePath}`, f);
    }
    document.title = data.title || 'Companion Planning';
    if (state.view === 'files') renderFileTree();
  } catch (e) { toast('Failed to load files', 'error'); }
}
async function loadStats() {
  try {
    const r = await fetch('/api/stats');
    const s = await r.json();
    $('#stats-pill').innerHTML = `<b>${s.todos_open}</b> open · <span class="${s.overdue ? 'danger' : ''}">${s.overdue}</span> overdue · <span class="${s.due_today ? 'warn' : ''}">${s.due_today}</span> today`;
  } catch {}
}
async function loadTodos() {
  try {
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
  } catch { toast('Failed to load todos', 'error'); }
}
async function refreshAll() {
  await Promise.all([loadFiles(), loadStats(), loadTodos()]);
  renderActiveView();
  toast('Refreshed', 'ok', 900);
}

// ---------------- Today ----------------
function renderToday() {
  const root = $('#view-today');
  const open = state.todos.filter(t => !t.checked);
  const overdue = open.filter(t => t.due_date && t.due_date < todayStr());
  const today = open.filter(t => t.due_date === todayStr());
  const noDue = open.filter(t => !t.due_date);
  const groups = [
    ['Overdue', overdue, 'overdue'],
    ['Due today', today, 'today'],
    ['Open (no due date)', noDue.slice(0, 60), 'nodue'],
  ];
  root.innerHTML = `
    <section class="today-hero">
      <h2>Today <span class="muted small">· ${todayStr()}</span></h2>
      <p class="muted">A quick scan of what matters. Press <kbd>⌘</kbd><kbd>K</kbd> for fast access.</p>
    </section>
    ${groups.map(([label, list, cls]) => list.length
      ? `<section class="todo-group">
           <h3 class="group-${cls}">${label} <span class="count">${list.length}</span></h3>
           <ul class="todo-list">${list.map(renderTodoLi).join('')}</ul>
         </section>`
      : '').join('')}
    ${open.length === 0 ? `<div class="empty"><h3>Inbox zero.</h3><p class="muted">Nothing open. Take a walk.</p></div>` : ''}
  `;
  wireTodoCheckboxes(root);
}

// ---------------- Todos ----------------
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
      <span><b>${state.todos.length}</b> todos shown</span>
      <button id="triage-filtered" class="btn-sm primary">🧹 Triage these</button>
    </header>
    ${[...grouped.entries()].map(([heading, list]) => `
      <section class="todo-group">
        <h3>${escape(heading)} <span class="count">${list.length}</span></h3>
        <ul class="todo-list">${list.map(renderTodoLi).join('')}</ul>
      </section>`).join('')}
    ${state.todos.length === 0 ? '<div class="empty"><h3>No matches.</h3><p class="muted">Loosen the filters in the sidebar.</p></div>' : ''}
  `;
  wireTodoCheckboxes(root);
  const btn = root.querySelector('#triage-filtered');
  if (btn) btn.onclick = () => openTriage({ todos: state.todos.slice(0, 60) });
}

function renderTodoLi(t) {
  const due = t.due_date ? `<span class="due ${dueClass(t.due_date)}">${t.due_date}</span>` : '';
  const tags = (t.tags || []).map(g => `<span class="tag">#${escape(g)}</span>`).join('');
  const fname = t.file_path.split('/').slice(-1)[0];
  return `<li class="todo ${t.checked ? 'checked' : ''}" data-hash="${t.hash}" data-path="${escape(t.file_path)}">
    <input type="checkbox" ${t.checked ? 'checked' : ''} data-hash="${t.hash}" data-path="${escape(t.file_path)}" aria-label="Toggle todo">
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
    loadStats(); loadTodos();
  } catch (e) {
    toast('Toggle failed: ' + e.message, 'error');
    if (el) el.checked = !checked;
  }
}

// ---------------- Files ----------------
function renderFiles() { renderFileTree(); }
function renderFileTree(filter = '') {
  const tree = $('#file-tree');
  const groups = new Map();
  for (const f of state.files) {
    if (filter && !(`${f.relativePath} ${f.name}`.toLowerCase().includes(filter))) continue;
    const dir = (f.relativePath.includes('/') ? f.relativePath.split('/').slice(0, -1).join('/') : '(root)');
    if (!groups.has(dir)) groups.set(dir, []);
    groups.get(dir).push(f);
  }
  tree.innerHTML = [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([dir, fs]) => `
    <div class="file-group">
      <div class="file-group-name">${escape(dir)}</div>
      <ul>
        ${fs.map(f => `<li>
          <a href="#${encodeURIComponent('file:' + f.directory + '/' + f.relativePath)}" data-path="${escape(f.path)}">
            <span>${escape(f.name)}</span><span class="todo-mini">${f.todos.unchecked}/${f.todos.total}</span>
          </a>
        </li>`).join('')}
      </ul>
    </div>`).join('');
  tree.querySelectorAll('a[data-path]').forEach(a => {
    a.addEventListener('click', e => {
      e.preventDefault();
      const f = state.filesIndex.get(a.dataset.path);
      if (f) { history.replaceState(null, '', a.getAttribute('href')); openFile(f); }
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
  $('#markdown-content').innerHTML = marked.parse(data.content || '');
  rewriteCheckboxes(data);
}
function rewriteCheckboxes(data) {
  const md = $('#markdown-content');
  const todoMap = new Map(data.todos.map(t => [t.plainText || t.plain_text, t]));
  md.querySelectorAll('li').forEach(li => {
    const input = li.querySelector('input[type="checkbox"]');
    if (!input) return;
    const txt = li.textContent.trim();
    let todo = todoMap.get(txt);
    if (!todo) for (const [k, v] of todoMap) if (txt.startsWith(k) || k.startsWith(txt)) { todo = v; break; }
    if (!todo) return;
    input.disabled = false;
    input.dataset.hash = todo.hash;
    input.dataset.path = data.path;
    input.addEventListener('change', () => toggleTodo(data.path, todo.hash, input.checked, input));
  });
}
function openInEditor() {
  if (!state.currentFile) return;
  window.open('vscode://file' + encodeURI(state.currentFile.path), '_blank');
}

// ---------------- Search ----------------
function setupSearch() {
  $('#search-input').addEventListener('input', () => {
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

// ---------------- LLM modals ----------------
function setupModals() {
  $('#briefing-close').onclick = () => $('#briefing-modal').classList.add('hidden');
  $('#triage-close').onclick = () => $('#triage-modal').classList.add('hidden');
  $$('.modal').forEach(m => m.addEventListener('click', e => { if (e.target === m) m.classList.add('hidden'); }));
}
async function openBriefing() {
  const modal = $('#briefing-modal');
  modal.classList.remove('hidden');
  $('#briefing-body').innerHTML = '<p class="muted">Generating with local LLM (this may take ~30s on first run)…</p>';
  try {
    const r = await fetch('/api/llm/summary', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    if (!r.ok) throw new Error(await r.text());
    const d = await r.json();
    $('#briefing-body').innerHTML = `<p class="muted small">Model: <code>${escape(d.model || '?')}</code></p>
      <div class="prose">${escape(d.text || '').replace(/\n\n/g, '</p><p>').replace(/^/, '<p>') + '</p>'}</div>`;
  } catch (e) {
    $('#briefing-body').innerHTML = `<p class="error">Briefing failed: ${escape(e.message)}.</p><p class="muted">Is Ollama running? <code>ollama serve</code></p>`;
  }
}

async function openTriage({ path, todos } = {}) {
  const modal = $('#triage-modal');
  modal.classList.remove('hidden');
  $('#triage-subtitle').textContent = path ? '· ' + path.split('/').slice(-1)[0] : (todos ? `· ${todos.length} todos` : '· all open');
  $('#triage-body').innerHTML = '<p class="muted">Running local LLM (this may take ~30s on first run)…</p>';
  try {
    const body = path ? { path, limit: 50 } : { limit: 50 };
    const r = await fetch('/api/llm/triage', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(await r.text());
    const d = await r.json();
    if (!d.actions || d.actions.length === 0) {
      $('#triage-body').innerHTML = `<p class="muted">No suggestions. Model: <code>${escape(d.model || '?')}</code></p>${d.raw ? `<details><summary>Raw output</summary><pre>${escape(d.raw.slice(0, 1200))}</pre></details>` : ''}`;
      return;
    }
    renderTriage(d);
  } catch (e) {
    $('#triage-body').innerHTML = `<p class="error">Triage failed: ${escape(e.message)}</p>`;
  }
}

function renderTriage(d) {
  const todosByHash = new Map(state.todos.map(t => [t.hash, t]));
  const rows = d.actions.map(a => {
    const todo = todosByHash.get(a.hash);
    const text = todo ? todo.plain_text : '(unknown — hash may be stale)';
    const fileShort = todo ? todo.file_path.split('/').slice(-1)[0] : '';
    let actionCell = `<b class="cat cat-${escape(a.category || 'keep')}">${escape(a.category || '?')}</b>`;
    if (a.suggested_text) actionCell += `<div class="small">→ ${escape(a.suggested_text)}</div>`;
    if (a.suggested_heading) actionCell += `<div class="small">↪ ${escape(a.suggested_heading)}</div>`;

    let buttons = '';
    if (todo) {
      if (a.category === 'archive' || a.category === 'duplicate') {
        buttons += `<button data-act="complete" data-hash="${a.hash}" class="btn-xs">Mark done</button>`;
      } else if (a.category === 'rewrite' && a.suggested_text) {
        buttons += `<button data-act="rewrite" data-hash="${a.hash}" data-new="${escape(a.suggested_text)}" class="btn-xs">Apply rewrite</button>`;
      }
      buttons += `<button data-act="dismiss" data-hash="${a.hash}" class="btn-xs">Dismiss</button>`;
    }
    return `<tr data-hash="${a.hash}">
      <td>${escape(text)}<div class="small muted">${escape(fileShort)} · ${escape(todo?.heading || '-')}</div></td>
      <td>${actionCell}</td>
      <td class="small">${escape(a.reason || '')}</td>
      <td class="actions">${buttons}</td>
    </tr>`;
  }).join('');
  $('#triage-body').innerHTML = `<p class="muted small">Model: <code>${escape(d.model)}</code> · ${d.actions.length} suggestions</p>
    <table class="triage-table">
      <thead><tr><th>Todo</th><th>Suggestion</th><th>Reason</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  // wire up
  $$('#triage-body button[data-act]').forEach(btn => btn.addEventListener('click', () => applyTriage(btn)));
}

async function applyTriage(btn) {
  const act = btn.dataset.act;
  const hash = btn.dataset.hash;
  const row = btn.closest('tr');
  const todo = state.todos.find(t => t.hash === hash);
  if (!todo) return;
  btn.disabled = true;
  try {
    if (act === 'complete') {
      const r = await fetch('/api/file', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: todo.file_path, hash, checked: true }),
      });
      if (!r.ok) throw new Error(await r.text());
      row.classList.add('done');
      toast('Marked done', 'ok', 1200);
      loadStats(); loadTodos();
    } else if (act === 'rewrite') {
      // Fetch file, replace exact line text, PUT back
      const fr = await fetch('/api/file?path=' + encodeURIComponent(todo.file_path));
      const fd = await fr.json();
      const newText = btn.dataset.new;
      // Find the line containing the current todo text and rewrite
      const lines = fd.content.split('\n');
      const oldTextPlain = todo.text;
      let replaced = false;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes(oldTextPlain)) {
          lines[i] = lines[i].replace(oldTextPlain, newText);
          replaced = true; break;
        }
      }
      if (!replaced) throw new Error('original text not found');
      const pr = await fetch('/api/file', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: todo.file_path, content: lines.join('\n'), expected_sha256: fd.sha256 }),
      });
      if (!pr.ok) throw new Error(await pr.text());
      row.classList.add('done');
      toast('Rewrote', 'ok', 1200);
      loadStats(); loadTodos();
    } else if (act === 'dismiss') {
      row.classList.add('dismissed');
    }
  } catch (e) {
    btn.disabled = false;
    toast('Apply failed: ' + e.message, 'error');
  }
}

// ---------------- SSE ----------------
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

// ---------------- Keybindings ----------------
function setupKeybindings() {
  document.addEventListener('keydown', (e) => {
    const cmd = e.metaKey || e.ctrlKey;
    if (cmd && e.key === 'k') { e.preventDefault(); openCommandPalette(); return; }
    // Ignore if typing in an input/textarea/contenteditable
    if (isTextInput(document.activeElement)) return;
    if (e.key === '?') { e.preventDefault(); showShortcutHelp(); return; }
    if (e.key === '/') { e.preventDefault(); setView('search'); $('#search-input').focus(); return; }
    if (e.key === 'g') { keybindings._g = true; setTimeout(() => keybindings._g = false, 800); return; }
    if (keybindings._g) {
      if (e.key === 't') { setView('today'); keybindings._g = false; }
      else if (e.key === 'a') { setView('todos'); keybindings._g = false; }
      else if (e.key === 'f') { setView('files'); keybindings._g = false; }
      else if (e.key === 's') { setView('search'); keybindings._g = false; }
    }
  });
}
const keybindings = { _g: false };
function isTextInput(el) {
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable;
}

function showShortcutHelp() {
  toast('⌘K palette · / search · g+t Today · g+a Todos · g+f Files', 'info', 3500);
}

// ---------------- Command palette ----------------
const cmdkActions = [
  { name: 'Go: Today',     id: 'cmd.today',    run: () => setView('today') },
  { name: 'Go: Todos',     id: 'cmd.todos',    run: () => setView('todos') },
  { name: 'Go: Files',     id: 'cmd.files',    run: () => setView('files') },
  { name: 'Go: Search',    id: 'cmd.search',   run: () => { setView('search'); $('#search-input').focus(); } },
  { name: 'Run: Daily briefing (LLM)',  id: 'cmd.brief',  run: () => openBriefing() },
  { name: 'Run: Triage current file',   id: 'cmd.triage', run: () => openTriage({ path: state.currentFile?.path }) },
  { name: 'Refresh data',  id: 'cmd.refresh',  run: () => refreshAll() },
  { name: 'Toggle theme',  id: 'cmd.theme',    run: () => cycleTheme() },
  { name: 'Show keyboard shortcuts', id: 'cmd.help', run: () => showShortcutHelp() },
];

function setupCommandPalette() {
  const input = $('#cmdk-input');
  input.addEventListener('input', renderCmdkList);
  input.addEventListener('keydown', onCmdkKey);
  $('#cmdk').addEventListener('click', (e) => { if (e.target.id === 'cmdk') closeCommandPalette(); });
}
function openCommandPalette() {
  $('#cmdk').classList.remove('hidden');
  const input = $('#cmdk-input');
  input.value = '';
  cmdkState.selected = 0;
  renderCmdkList();
  setTimeout(() => input.focus(), 10);
}
function closeCommandPalette() {
  $('#cmdk').classList.add('hidden');
}
const cmdkState = { selected: 0, items: [] };
function renderCmdkList() {
  const q = $('#cmdk-input').value.trim().toLowerCase();
  let items = [];

  // 1) commands
  let cmds = cmdkActions;
  if (q && !q.startsWith('?')) cmds = cmds.filter(c => c.name.toLowerCase().includes(q));
  items.push(...cmds.map(c => ({ kind: 'cmd', label: c.name, hint: 'command', run: c.run })));

  // 2) files
  if (q.length >= 1) {
    const needle = q.replace(/^[#@>/]/, '');
    const files = state.files
      .filter(f => f.relativePath.toLowerCase().includes(needle))
      .slice(0, 10);
    items.push(...files.map(f => ({
      kind: 'file', label: f.relativePath, hint: `${f.todos.unchecked} open`,
      run: () => { closeCommandPalette(); openFile(f); }
    })));
  }

  // 3) todos
  if (q.length >= 2) {
    const needle = q.toLowerCase();
    const todos = state.todos
      .filter(t => t.plain_text.toLowerCase().includes(needle))
      .slice(0, 10);
    items.push(...todos.map(t => ({
      kind: 'todo', label: t.plain_text, hint: t.file_path.split('/').slice(-1)[0],
      run: async () => {
        closeCommandPalette();
        await toggleTodo(t.file_path, t.hash, !t.checked, { closest: () => null, checked: !t.checked });
      }
    })));
  }

  cmdkState.items = items;
  if (cmdkState.selected >= items.length) cmdkState.selected = 0;
  const list = $('#cmdk-list');
  list.innerHTML = items.map((it, i) => `
    <div class="cmdk-row ${i === cmdkState.selected ? 'selected' : ''}" data-i="${i}" role="option" aria-selected="${i === cmdkState.selected}">
      <span class="cmdk-kind k-${it.kind}">${it.kind}</span>
      <span class="cmdk-label">${escape(it.label)}</span>
      <span class="cmdk-hint">${escape(it.hint)}</span>
    </div>
  `).join('') || '<div class="cmdk-empty">No matches.</div>';
  list.querySelectorAll('.cmdk-row').forEach(r => r.addEventListener('click', () => activateCmdk(parseInt(r.dataset.i, 10))));
}
function onCmdkKey(e) {
  if (e.key === 'Escape') { e.preventDefault(); closeCommandPalette(); return; }
  if (e.key === 'ArrowDown') { e.preventDefault(); cmdkState.selected = Math.min(cmdkState.selected + 1, cmdkState.items.length - 1); renderCmdkList(); return; }
  if (e.key === 'ArrowUp')   { e.preventDefault(); cmdkState.selected = Math.max(cmdkState.selected - 1, 0); renderCmdkList(); return; }
  if (e.key === 'Enter')     { e.preventDefault(); activateCmdk(cmdkState.selected); return; }
}
function activateCmdk(i) {
  const it = cmdkState.items[i];
  if (it) it.run();
}

// ---------------- Utilities ----------------
function escape(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function todayStr() { return new Date().toISOString().slice(0, 10); }
function dueClass(d) { if (!d) return ''; const t = todayStr(); return d < t ? 'overdue' : d === t ? 'today' : ''; }
function relForLink(p) { const f = state.filesIndex.get(p); return f ? `${f.directory}/${f.relativePath}` : p; }

init().catch(e => { console.error(e); toast('Init failed: ' + e.message, 'error'); });
