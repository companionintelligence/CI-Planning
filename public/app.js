/**
 * AI TODO Dashboard - Frontend App
 */

// State
let files = [];
let currentFile = null;
let currentFilePath = null;

// DOM elements
const fileTree = document.getElementById('file-tree');
const markdownContent = document.getElementById('markdown-content');
const fileHeader = document.getElementById('file-header');
const currentFileEl = document.getElementById('current-file');
const titleEl = document.getElementById('title');
const statusEl = document.getElementById('status');
const refreshBtn = document.getElementById('refresh-btn');
const editBtn = document.getElementById('edit-btn');

// Initialize
async function init() {
  await loadFiles();
  setupEventSource();
  
  refreshBtn.addEventListener('click', loadFiles);
  editBtn.addEventListener('click', openInEditor);
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
async function loadFile(file) {
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
    
    // Render markdown with interactive checkboxes
    renderMarkdown(currentFile);
    
  } catch (e) {
    markdownContent.innerHTML = `<div class="welcome"><h2>Error</h2><p>${e.message}</p></div>`;
    console.error(e);
  }
}

// Render markdown with interactive checkboxes
function renderMarkdown(content) {
  const lines = content.split('\n');
  let html = '';
  let inTodoList = false;
  let todoBuffer = [];
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    // Check for todo items
    const uncheckedMatch = line.match(/^(\s*)- \[ \] (.*)$/);
    const checkedMatch = line.match(/^(\s*)- \[x\] (.*)$/i);
    
    if (uncheckedMatch || checkedMatch) {
      if (!inTodoList) {
        // Flush previous content
        if (todoBuffer.length > 0) {
          html += marked.parse(todoBuffer.join('\n'));
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
               data-checked="${isChecked}"></div>
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
    html += marked.parse(todoBuffer.join('\n'));
  }
  
  markdownContent.innerHTML = html;
  
  // Add checkbox click handlers
  document.querySelectorAll('.todo-checkbox').forEach(checkbox => {
    checkbox.addEventListener('click', async () => {
      const line = parseInt(checkbox.dataset.line);
      const wasChecked = checkbox.dataset.checked === 'true';
      const newChecked = !wasChecked;
      
      // Optimistic update
      checkbox.classList.toggle('checked', newChecked);
      checkbox.dataset.checked = newChecked;
      checkbox.nextElementSibling.classList.toggle('completed', newChecked);
      
      // Send to server
      try {
        const res = await fetch('/api/file', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            path: currentFilePath,
            line,
            checked: newChecked
          })
        });
        
        if (!res.ok) {
          throw new Error('Failed to update');
        }
        
        // Refresh file list to update badges
        loadFiles();
        
      } catch (e) {
        // Revert on error
        checkbox.classList.toggle('checked', wasChecked);
        checkbox.dataset.checked = wasChecked;
        checkbox.nextElementSibling.classList.toggle('completed', wasChecked);
        console.error(e);
      }
    });
  });
}

// Escape HTML
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Open current file in default editor
function openInEditor() {
  if (currentFilePath) {
    // Try to open in VS Code or default editor
    // This only works with a helper, so we just show the path
    alert(`Open in your editor:\n\n${currentFilePath}`);
  }
}

// Setup Server-Sent Events for live reload
function setupEventSource() {
  const eventSource = new EventSource('/api/events');
  
  eventSource.addEventListener('fileChange', (e) => {
    const data = JSON.parse(e.data);
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
