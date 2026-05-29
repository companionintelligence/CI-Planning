// Reactive store using Svelte 5 runes.

const API = '';  // proxied in dev, served from same origin in prod

// Local-time YYYY-MM-DD. `toISOString().slice(0,10)` returns the UTC date —
// which is wrong in the evening for Pacific/Eastern users (shows tomorrow).
function todayStr() { return new Date().toLocaleDateString('en-CA'); }
function addDaysStr(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toLocaleDateString('en-CA');
}

class Store {
  view = $state('today');
  files = $state([]);
  todos = $state([]);
  stats = $state({ todos_open: 0, todos_done: 0, overdue: 0, due_today: 0, files: 0 });
  llm = $state({ available: false, models: [] });
  activeFilePath = $state(null);
  filters = $state({ status: 'open', due: '', tag: '', q: '' });
  loading = $state(false);
  toast = $state({ msg: '', kind: 'info', visible: false });
  // V4
  lookahead = $state({ days: [], weeks: 3, workday_minutes: 480 });
  suggestions = $state([]);
  calendar = $state({ available: false, provider: null });

  filesByPath = $derived.by(() => {
    const m = new Map();
    for (const f of this.files) m.set(f.path, f);
    return m;
  });

  showToast(msg, kind = 'info', ms = 2200) {
    this.toast = { msg, kind, visible: true };
    clearTimeout(this._toastT);
    this._toastT = setTimeout(() => { this.toast = { ...this.toast, visible: false }; }, ms);
  }

  async refresh() {
    this.loading = true;
    try {
      const [s, f, t, l] = await Promise.all([
        fetch(`${API}/api/stats`).then(r => r.json()),
        fetch(`${API}/api/files`).then(r => r.json()),
        this._fetchTodos(),
        fetch(`${API}/api/llm/status`).then(r => r.json()).catch(() => ({ available: false })),
      ]);
      this.stats = s;
      this.files = f.files;
      this.todos = t;
      this.llm = l;
    } finally {
      this.loading = false;
    }
  }

  async _fetchTodos() {
    const p = new URLSearchParams();
    if (this.filters.status === 'open') p.set('open', 'true');
    if (this.filters.status === 'done') p.set('done', 'true');
    if (this.filters.due) p.set('due', this.filters.due);
    if (this.filters.tag) p.set('tag', this.filters.tag.replace(/^#/, ''));
    if (this.filters.q) p.set('q', this.filters.q);
    p.set('limit', '500');
    const r = await fetch(`${API}/api/todos?${p}`);
    const d = await r.json();
    return d.todos;
  }
  async reloadTodos() { this.todos = await this._fetchTodos(); }

  openFile(path) { this.activeFilePath = path; }

  async toggle(todo, checked) {
    try {
      const r = await fetch(`${API}/api/file`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: todo.file_path, hash: todo.hash, checked }),
      });
      if (!r.ok) throw new Error(await r.text());
      todo.checked = checked;
      this.reloadTodos();
      this.refreshStats();
    } catch (e) {
      this.showToast('Toggle failed: ' + e.message, 'error');
    }
  }

  async refreshStats() {
    const s = await fetch(`${API}/api/stats`).then(r => r.json()).catch(() => null);
    if (s) this.stats = s;
  }

  // ============ V4: lookahead + suggestions + estimates ============

  async loadLookahead(weeks = 3, workdayMinutes = 480) {
    const r = await fetch(`${API}/api/lookahead?weeks=${weeks}&workday_minutes=${workdayMinutes}`);
    const d = await r.json();
    this.lookahead = d;
    return d;
  }

  async loadSuggestions(status = 'pending') {
    const r = await fetch(`${API}/api/suggestions?status=${status}`);
    const d = await r.json();
    this.suggestions = d.items;
    return d.items;
  }

  async acceptSuggestion(id) {
    const r = await fetch(`${API}/api/suggestion/${id}/accept`, { method: 'POST' });
    if (!r.ok) throw new Error(await r.text());
    await this.loadSuggestions();
    this.refresh();
    this.showToast('Accepted', 'success');
  }

  async dismissSuggestion(id) {
    const r = await fetch(`${API}/api/suggestion/${id}/dismiss`, { method: 'POST' });
    if (!r.ok) throw new Error(await r.text());
    await this.loadSuggestions();
    this.showToast('Dismissed', 'info');
  }

  async setEstimate(hash, minutes) {
    const r = await fetch(`${API}/api/task/estimate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hash, minutes }),
    });
    if (!r.ok) throw new Error(await r.text());
    this.reloadTodos();
    this.showToast(`${minutes}m estimate set`, 'success');
  }

  async extractFromFile(path) {
    const r = await fetch(`${API}/api/extract`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    });
    const d = await r.json();
    if (!r.ok) {
      this.showToast(d.error || 'Extract failed', 'error');
      return null;
    }
    this.showToast(`Extracted ${d.inserted}`, 'success');
    await this.loadSuggestions();
    return d;
  }

  async loadCalendarStatus() {
    const r = await fetch(`${API}/api/calendar/status`);
    const d = await r.json();
    this.calendar = d;
    return d;
  }

  async findSlots(durationMinutes, startDate, endDate) {
    const p = new URLSearchParams({ duration_minutes: String(durationMinutes) });
    if (startDate) p.set('start_date', startDate);
    if (endDate) p.set('end_date', endDate);
    const r = await fetch(`${API}/api/calendar/slots?${p}`);
    const d = await r.json();
    return d.slots || [];
  }

  async scheduleTask(hash, date, startTime, durationMinutes, title) {
    const body = { todo_hash: hash, date, start_time: startTime, duration_minutes: durationMinutes };
    if (title) body.title = title;
    const r = await fetch(`${API}/api/calendar/schedule`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      throw new Error(d.error || 'Schedule failed');
    }
    this.showToast(`Scheduled ${date} ${startTime}`, 'success');
    return r.json();
  }

  groupedToday() {
    const today = todayStr();
    const weekEnd = addDaysStr(7);
    const open = this.todos.filter(t => !t.checked);
    return {
      overdue:  open.filter(t => t.due_date && t.due_date < today),
      today:    open.filter(t => t.due_date === today),
      thisWeek: open.filter(t => t.due_date && t.due_date > today && t.due_date <= weekEnd),
      nodue:    open.filter(t => !t.due_date).slice(0, 60),
    };
  }
  todayStr = todayStr;
}

export const store = new Store();
