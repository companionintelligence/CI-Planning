/**
 * AI-TODO-Static Server
 * 
 * Serves markdown files with interactive checkbox support
 */

import express from 'express';
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join, basename, dirname, relative, extname } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';
import chokidar from 'chokidar';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load config
const configPath = join(__dirname, 'config.json');
const config = JSON.parse(readFileSync(configPath, 'utf-8'));

// Expand ~ in paths
function expandPath(p) {
  if (p.startsWith('~/')) {
    return join(homedir(), p.slice(2));
  }
  return p;
}

const directories = config.directories.map(expandPath);
const port = config.port || 3847;
const title = config.title || 'AI TODO Dashboard';

// Express app
const app = express();
app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

// SSE clients for live reload
const clients = new Set();

// Get all markdown files from configured directories
function getMarkdownFiles() {
  const files = [];
  
  for (const dir of directories) {
    if (!existsSync(dir)) continue;
    
    const dirName = basename(dir);
    scanDirectory(dir, dir, dirName, files);
  }
  
  return files;
}

function scanDirectory(basePath, currentPath, dirName, files) {
  try {
    const entries = readdirSync(currentPath);
    
    for (const entry of entries) {
      // Skip hidden files/dirs
      if (entry.startsWith('.')) continue;
      
      const fullPath = join(currentPath, entry);
      const stat = statSync(fullPath);
      
      if (stat.isDirectory()) {
        scanDirectory(basePath, fullPath, dirName, files);
      } else if (extname(entry).toLowerCase() === '.md') {
        const relativePath = relative(basePath, fullPath);
        files.push({
          name: entry,
          path: fullPath,
          relativePath,
          directory: dirName,
          modified: stat.mtime.toISOString(),
        });
      }
    }
  } catch (e) {
    console.warn(`Error scanning ${currentPath}:`, e.message);
  }
}

// Count todos in a file
function countTodos(content) {
  const unchecked = (content.match(/- \[ \]/g) || []).length;
  const checked = (content.match(/- \[x\]/gi) || []).length;
  return { unchecked, checked, total: unchecked + checked };
}

// API: List all files
app.get('/api/files', (req, res) => {
  const files = getMarkdownFiles();
  
  // Add todo counts
  const filesWithCounts = files.map(file => {
    try {
      const content = readFileSync(file.path, 'utf-8');
      const todos = countTodos(content);
      return { ...file, todos };
    } catch {
      return { ...file, todos: { unchecked: 0, checked: 0, total: 0 } };
    }
  });
  
  // Sort by directory, then name
  filesWithCounts.sort((a, b) => {
    if (a.directory !== b.directory) return a.directory.localeCompare(b.directory);
    return a.name.localeCompare(b.name);
  });
  
  res.json({ files: filesWithCounts, title });
});

// API: Get file content
app.get('/api/file', (req, res) => {
  const { path: filePath } = req.query;
  
  if (!filePath) {
    return res.status(400).json({ error: 'Path required' });
  }
  
  // Security: ensure path is within allowed directories
  const expandedPath = expandPath(filePath);
  const isAllowed = directories.some(dir => expandedPath.startsWith(dir));
  
  if (!isAllowed) {
    return res.status(403).json({ error: 'Path not allowed' });
  }
  
  try {
    const content = readFileSync(expandedPath, 'utf-8');
    res.json({ content, path: expandedPath });
  } catch (e) {
    res.status(404).json({ error: 'File not found' });
  }
});

// API: Toggle checkbox
app.patch('/api/file', (req, res) => {
  const { path: filePath, line, checked } = req.body;
  
  if (!filePath || line === undefined) {
    return res.status(400).json({ error: 'Path and line required' });
  }
  
  const expandedPath = expandPath(filePath);
  const isAllowed = directories.some(dir => expandedPath.startsWith(dir));
  
  if (!isAllowed) {
    return res.status(403).json({ error: 'Path not allowed' });
  }
  
  try {
    const content = readFileSync(expandedPath, 'utf-8');
    const lines = content.split('\n');
    
    if (line < 0 || line >= lines.length) {
      return res.status(400).json({ error: 'Invalid line number' });
    }
    
    const currentLine = lines[line];
    
    // Toggle checkbox
    if (checked) {
      lines[line] = currentLine.replace(/- \[ \]/, '- [x]');
    } else {
      lines[line] = currentLine.replace(/- \[x\]/i, '- [ ]');
    }
    
    writeFileSync(expandedPath, lines.join('\n'), 'utf-8');
    
    res.json({ success: true, line: lines[line] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// API: Search files and content
app.get('/api/search', (req, res) => {
  const { q } = req.query;
  
  if (!q || q.length < 2) {
    return res.json({ results: [] });
  }
  
  const query = q.toLowerCase();
  const results = [];
  const files = getMarkdownFiles();
  
  for (const file of files) {
    try {
      const content = readFileSync(file.path, 'utf-8');
      const lines = content.split('\n');
      const matches = [];
      
      // Check filename match
      const nameMatch = file.name.toLowerCase().includes(query);
      
      // Check content matches
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes(query)) {
          matches.push({
            line: i + 1,
            text: lines[i].trim().substring(0, 150),
          });
          if (matches.length >= 3) break; // Limit matches per file
        }
      }
      
      if (nameMatch || matches.length > 0) {
        results.push({
          ...file,
          nameMatch,
          matches,
        });
      }
      
      if (results.length >= 20) break; // Limit total results
    } catch (e) {
      // Skip files that can't be read
    }
  }
  
  // Sort: name matches first, then by match count
  results.sort((a, b) => {
    if (a.nameMatch && !b.nameMatch) return -1;
    if (!a.nameMatch && b.nameMatch) return 1;
    return b.matches.length - a.matches.length;
  });
  
  res.json({ results, query: q });
});

// API: Get config
app.get('/api/config', (req, res) => {
  res.json({ directories: config.directories, title });
});

// SSE endpoint for live reload
app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  
  clients.add(res);
  
  req.on('close', () => {
    clients.delete(res);
  });
});

// Notify clients of changes
function notifyClients(event, data) {
  const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) {
    client.write(message);
  }
}

// Watch for file changes
const watcher = chokidar.watch(directories, {
  ignored: /(^|[\/\\])\../,
  persistent: true,
  ignoreInitial: true,
});

watcher.on('change', (path) => {
  if (path.endsWith('.md')) {
    console.log(`File changed: ${path}`);
    notifyClients('fileChange', { path });
  }
});

watcher.on('add', (path) => {
  if (path.endsWith('.md')) {
    notifyClients('fileAdd', { path });
  }
});

watcher.on('unlink', (path) => {
  if (path.endsWith('.md')) {
    notifyClients('fileRemove', { path });
  }
});

// Start server
app.listen(port, () => {
  console.log(`\n🗒️  AI TODO Dashboard running at http://localhost:${port}\n`);
  console.log('Watching directories:');
  directories.forEach(dir => console.log(`  📁 ${dir}`));
  console.log('');
});
