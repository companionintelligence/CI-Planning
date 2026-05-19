/**
 * AI TODO Dashboard - Frontend App
 * Now with URL hash routing for deep linking
 */

// State
let files = [];
let currentFile = null;
let currentFilePath = null;
let searchTimeout = null;
let lastSelfWriteAt = 0; // suppress SSE reload after our own PATCH

// DOM elements
const fileTree = document.getElementById('file-tree');
const markdownContent = document.getElementById('markdown-content');
const fileHeader = document.getElementById('file-header');
const currentFileEl = document.getElementById('current-file');
const titleEl = document.getElementById('title');
const statusEl = document.getElementById('status');
const refreshBtn = document.getElementById('refresh-btn');
const editBtn = document.getElementById('edit-btn');
const sidebar = document.getElementById('sidebar');
const mobileMenu = document.getElementById('mobile-menu');
const closeSidebar = document.getElementById('close-sidebar');
const searchInput = document.getElementById('search-input');
const searchClear = document.getElementById('search-clear');
const searchResults = document.getElementById('search-results');

// Initialize
async function init() {
  await loadFiles();
  setupEventSource();
  setupMobileMenu();
  setupSearch();
  setupHashRouting();
  
  refreshBtn.addEventListener('click', loadFiles);
  editBtn.addEventListener('click', openInEditor);
  
  // Handle initial hash
  handleHashChange();
}

// Hash routing - parse and handle URL hash
function setupHashRouting() {
  window.addEventListener('hashchange', handleHashChange);
}

function handleHashChange() {
  const hash = decodeURIComponent(window.location.hash.slice(1)); // Remove #
  if (!hash) return;
  
  // Parse hash: file:path/to/file.md or file:path/to/file.md#heading-id
  const [fileRef, headingId] = hash.split('#');
  
  if (fileRef.startsWith('file:')) {
    const filePath = fileRef.slice(5); // Remove 'file:'
    
    // Find matching file
    const file = files.find(f => 
      f.path === filePath || 
      f.relativePath === filePath ||
      f.path.endsWith(filePath) ||
      `${f.directory}/${f.relativePath}` === filePath
    );
    
    if (file) {
      loadFile(file, headingId);
    } else {
      console.warn('File not found:', filePath);
    }
  } else if (hash) {
    // Just a heading ID - scroll to it
    scrollToHeading(hash);
  }
}

function updateHash(filePath, headingId = null) {
  // Create shareable path (directory/relativePath)
  const file = files.find(f => f.path === filePath);
  if (!file) return;
  
  const shareablePath = `${file.directory}/${file.relativePath}`;
  let newHash = `file:${shareablePath}`;
  
  if (headingId) {
    newHash += `#${headingId}`;
  }
  
  // Update URL without triggering hashchange
  history.replaceState(null, '', `#${encodeURIComponent(newHash)}`);
}

function scrollToHeading(headingId) {
  // Try to find heading by ID or by slugified text
  const heading = document.getElementById(headingId) || 
                  document.querySelector(`[data-heading-id="${headingId}"]`);
  
  if (heading) {
    heading.scrollIntoView({ behavior: 'smooth', block: 'start' });
    heading.classList.add('highlight');
    setTimeout(() => heading.classList.remove('highlight'), 2000);
  }
}

// Slugify heading text for URL-safe IDs
function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, '') // Remove special chars (but keep emoji will be stripped)
    .replace(/\s+/g, '-')      // Spaces to hyphens
    .replace(/-+/g, '-')       // Multiple hyphens to single
    .replace(/^-+|-+$/g, '');  // Trim hyphens
}

// Load file list
async function loadFiles() {
  try {
    statusEl.textContent = 'Loading...';
    const res = await fetch('/api/files');
    const data = await res.json();
    
    files = data.files;
    titleEl.textContent = data.title;
    document.title = data.title;
    
    renderFileTree();
    statusEl.textContent = `${files.length} files`;
    
    // Reload current file if it exists
    if (currentFilePath) {
      const file = files.find(f => f.path === currentFilePath);
      if (file) {
        await loadFile(file);
      }
    }
  } catch (e) {
    statusEl.textContent = 'Error loading files';
    console.error(e);
  }
}

// Render file tree
function renderFileTree() {
  const grouped = {};
  
  for (const file of files) {
    if (!grouped[file.directory]) {
      grouped[file.directory] = [];
    }
    grouped[file.directory].push(file);
  }
  
  let html = '';
  
  for (const [dir, dirFiles] of Object.entries(grouped)) {
    html += `<div class="directory">
      <div class="directory-name">${dir}</div>`;
    
    for (const file of dirFiles) {
      const isActive = file.path === currentFilePath ? 'active' : '';
      const badge = getTodoBadge(file.todos);
      
      html += `
        <div class="file-item ${isActive}" data-path="${file.path}">
          <span class="file-name">${file.name}</span>
          ${badge}
        </div>`;
    }
    
    html += '</div>';
  }
  
  fileTree.innerHTML = html;
  
  // Add click handlers
  document.querySelectorAll('.file-item').forEach(item => {
    item.addEventListener('click', async () => {
      const path = item.dataset.path;
      const file = files.find(f => f.path === path);
      if (file) {
        await loadFile(file);
        closeSidebarMobile();
      }
    });
  });
}

// Get todo badge HTML
function getTodoBadge(todos) {
  if (!todos || todos.total === 0) {
    return '';
  }
  
  if (todos.unchecked === 0) {
    return `<span class="todo-badge complete">✓ ${todos.total}</span>`;
  }
  
  return `<span class="todo-badge has-todos">${todos.unchecked}/${todos.total}</span>`;
}

// Load a file
async function loadFile(file, scrollToHeadingId = null) {
  try {
    markdownContent.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
    
    const res = await fetch(`/api/file?path=${encodeURIComponent(file.path)}`);
    const data = await res.json();
    
    currentFile = data.content;
    currentFilePath = file.path;
    
    // Update UI
    fileHeader.classList.remove('hidden');
    currentFileEl.textContent = `${file.directory}/${file.relativePath}`;
    
    // Update active state
    document.querySelectorAll('.file-item').forEach(item => {
      item.classList.toggle('active', item.dataset.path === file.path);
    });
    
    // Update URL hash
    updateHash(file.path, scrollToHeadingId);
    
    // Render markdown with interactive checkboxes
    renderMarkdown(currentFile);
    
    // Scroll to heading if specified
    if (scrollToHeadingId) {
      setTimeout(() => scrollToHeading(scrollToHeadingId), 100);
    }
    
  } catch (e) {
    markdownContent.innerHTML = `<div class="welcome"><h2>Error</h2><p>${e.message}</p></div>`;
    console.error(e);
  }
}

// Render markdown with interactive checkboxes and clickable headings
function renderMarkdown(content) {
  const lines = content.split('\n');
  let html = '';
  let inTodoList = false;
  let todoBuffer = [];
  const seenHeadings = new Map(); // dedupe heading IDs across the whole render

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Check for todo items
    const uncheckedMatch = line.match(/^(\s*)- \[ \] (.*)$/);
    const checkedMatch = line.match(/^(\s*)- \[x\] (.*)$/i);

    if (uncheckedMatch || checkedMatch) {
      if (!inTodoList) {
        // Flush previous content
        if (todoBuffer.length > 0) {
          html += parseMarkdownWithHeadings(todoBuffer.join('\n'), seenHeadings);
          todoBuffer = [];
        }
        inTodoList = true;
      }
      
      const isChecked = !!checkedMatch;
      const text = isChecked ? checkedMatch[2] : uncheckedMatch[2];
      const indent = (isChecked ? checkedMatch[1] : uncheckedMatch[1]).length;
      
      html += `
        <div class="todo-item" style="padding-left: ${indent * 10}px">
          <div class="todo-checkbox ${isChecked ? 'checked' : ''}"
               data-line="${i}"
               data-checked="${isChecked}"
               data-text="${escapeAttr(text)}"></div>
          <span class="todo-text ${isChecked ? 'completed' : ''}">${escapeHtml(text)}</span>
        </div>`;
    } else {
      if (inTodoList) {
        inTodoList = false;
      }
      todoBuffer.push(line);
    }
  }
  
  // Flush remaining content
  if (todoBuffer.length > 0) {
    html += parseMarkdownWithHeadings(todoBuffer.join('\n'), seenHeadings);
  }
  
  markdownContent.innerHTML = html;
  
  // Add checkbox click handlers
  document.querySelectorAll('.todo-checkbox').forEach(checkbox => {
    checkbox.addEventListener('click', async () => {
      const line = parseInt(checkbox.dataset.line);
      const expectedText = checkbox.dataset.text || '';
      const wasChecked = checkbox.dataset.checked === 'true';
      const newChecked = !wasChecked;

      // Optimistic UI
      checkbox.classList.toggle('checked', newChecked);
      checkbox.dataset.checked = newChecked;
      checkbox.nextElementSibling.classList.toggle('completed', newChecked);

      try {
        const res = await fetch('/api/file', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            path: currentFilePath,
            line,
            checked: newChecked,
            expectedText,
          }),
        });

        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || `HTTP ${res.status}`);
        }

        // Suppress the SSE-driven reload we're about to receive for our own write.
        lastSelfWriteAt = Date.now();

        // Update local badge counts and re-render the tree (no server round-trip).
        const file = files.find(f => f.path === currentFilePath);
        if (file && file.todos) {
          if (newChecked) {
            file.todos.unchecked = Math.max(0, file.todos.unchecked - 1);
            file.todos.checked++;
          } else {
            file.todos.unchecked++;
            file.todos.checked = Math.max(0, file.todos.checked - 1);
          }
          renderFileTree();
        }
      } catch (e) {
        // Revert on error
        checkbox.classList.toggle('checked', wasChecked);
        checkbox.dataset.checked = wasChecked;
        checkbox.nextElementSibling.classList.toggle('completed', wasChecked);
        showToast(`Could not update: ${e.message}`);
        console.error(e);
      }
    });
  });
  
  // Add heading click handlers for copying link
  document.querySelectorAll('.heading-anchor').forEach(anchor => {
    anchor.addEventListener('click', (e) => {
      e.preventDefault();
      const headingId = anchor.dataset.headingId;
      updateHash(currentFilePath, headingId);
      
      // Copy to clipboard
      const url = window.location.href;
      navigator.clipboard.writeText(url).then(() => {
        showToast('Link copied to clipboard!');
      }).catch(() => {
        showToast('Link updated in URL bar');
      });
    });
  });
}

// Parse markdown and add IDs to headings. `seen` is a Map<base-id, count> shared
// across all chunks of a single document so duplicate headings get unique IDs.
function parseMarkdownWithHeadings(markdown, seen) {
  let html = marked.parse(markdown);

  html = html.replace(/<(h[1-6])>([^<]+)<\/h[1-6]>/g, (match, tag, text) => {
    const base = slugify(text);
    const count = seen.get(base) || 0;
    seen.set(base, count + 1);
    const headingId = count === 0 ? base : `${base}-${count + 1}`;
    return `<${tag} id="${headingId}" data-heading-id="${headingId}">
      ${text}
      <a class="heading-anchor" href="#${headingId}" data-heading-id="${headingId}" title="Copy link to section">🔗</a>
    </${tag}>`;
  });

  return html;
}

// Show toast notification
function showToast(message) {
  // Remove existing toast
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();
  
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  document.body.appendChild(toast);
  
  setTimeout(() => toast.classList.add('show'), 10);
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 300);
  }, 2000);
}

// Escape HTML
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Escape for use inside a double-quoted HTML attribute value
function escapeAttr(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Open current file in default editor
function openInEditor() {
  if (currentFilePath) {
    // Try to open in VS Code or default editor
    // This only works with a helper, so we just show the path
    alert(`Open in your editor:\n\n${currentFilePath}`);
  }
}

// Mobile menu handling
function setupMobileMenu() {
  // Create overlay
  const overlay = document.createElement('div');
  overlay.className = 'sidebar-overlay';
  overlay.id = 'sidebar-overlay';
  document.body.appendChild(overlay);
  
  mobileMenu.addEventListener('click', () => {
    sidebar.classList.add('open');
    overlay.classList.add('show');
  });
  
  closeSidebar.addEventListener('click', closeSidebarMobile);
  overlay.addEventListener('click', closeSidebarMobile);
}

function closeSidebarMobile() {
  sidebar.classList.remove('open');
  document.getElementById('sidebar-overlay').classList.remove('show');
}

// Search functionality
function setupSearch() {
  searchInput.addEventListener('input', (e) => {
    const query = e.target.value.trim();
    
    // Show/hide clear button
    searchClear.classList.toggle('hidden', query.length === 0);
    
    // Debounce search
    clearTimeout(searchTimeout);
    
    if (query.length < 2) {
      searchResults.classList.add('hidden');
      fileTree.classList.remove('hidden');
      return;
    }
    
    searchTimeout = setTimeout(() => performSearch(query), 200);
  });
  
  searchClear.addEventListener('click', () => {
    searchInput.value = '';
    searchClear.classList.add('hidden');
    searchResults.classList.add('hidden');
    fileTree.classList.remove('hidden');
    searchInput.focus();
  });
  
  // Handle escape key
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      searchInput.value = '';
      searchClear.classList.add('hidden');
      searchResults.classList.add('hidden');
      fileTree.classList.remove('hidden');
    }
  });
}

async function performSearch(query) {
  try {
    const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
    const data = await res.json();
    
    renderSearchResults(data.results, query);
  } catch (e) {
    console.error('Search error:', e);
  }
}

function renderSearchResults(results, query) {
  fileTree.classList.add('hidden');
  searchResults.classList.remove('hidden');
  
  if (results.length === 0) {
    searchResults.innerHTML = `<div class="no-results">No results for "${escapeHtml(query)}"</div>`;
    return;
  }
  
  const queryLower = query.toLowerCase();
  
  let html = '';
  for (const result of results) {
    const highlightedName = result.nameMatch 
      ? highlightMatch(result.name, queryLower)
      : escapeHtml(result.name);
    
    html += `
      <div class="search-result" data-path="${result.path}">
        <div class="search-result-title">${highlightedName}</div>
        <div class="search-result-path">${result.directory}/${result.relativePath}</div>`;
    
    if (result.matches.length > 0) {
      html += '<div class="search-result-matches">';
      for (const match of result.matches) {
        const highlightedText = highlightMatch(match.text, queryLower);
        html += `<div class="search-match">L${match.line}: ${highlightedText}</div>`;
      }
      html += '</div>';
    }
    
    html += '</div>';
  }
  
  searchResults.innerHTML = html;
  
  // Add click handlers
  document.querySelectorAll('.search-result').forEach(item => {
    item.addEventListener('click', async () => {
      const path = item.dataset.path;
      const file = files.find(f => f.path === path);
      if (file) {
        await loadFile(file);
        closeSidebarMobile();
      }
    });
  });
}

function highlightMatch(text, query) {
  const escaped = escapeHtml(text);
  const index = escaped.toLowerCase().indexOf(query);
  if (index === -1) return escaped;
  
  const before = escaped.substring(0, index);
  const match = escaped.substring(index, index + query.length);
  const after = escaped.substring(index + query.length);
  
  return `${before}<mark>${match}</mark>${after}`;
}

// Setup Server-Sent Events for live reload
function setupEventSource() {
  const eventSource = new EventSource('/api/events');
  
  eventSource.addEventListener('fileChange', (e) => {
    const data = JSON.parse(e.data);

    // Suppress reload for the change we just made ourselves (~1s window).
    if (Date.now() - lastSelfWriteAt < 1000) return;

    console.log('File changed:', data.path);

    // Reload if it's the current file
    if (data.path === currentFilePath) {
      const file = files.find(f => f.path === currentFilePath);
      if (file) loadFile(file);
    }

    // Refresh file list
    loadFiles();
  });
  
  eventSource.addEventListener('fileAdd', () => {
    loadFiles();
  });
  
  eventSource.addEventListener('fileRemove', (e) => {
    const data = JSON.parse(e.data);
    if (data.path === currentFilePath) {
      currentFilePath = null;
      currentFile = null;
      markdownContent.innerHTML = '<div class="welcome"><h2>File removed</h2></div>';
      fileHeader.classList.add('hidden');
    }
    loadFiles();
  });
  
  eventSource.onerror = () => {
    console.warn('SSE connection lost, will retry...');
  };
}

// Start
init();
