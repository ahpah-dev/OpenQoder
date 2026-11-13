const $ = id => document.getElementById(id);

const defaults = {
  baseUrl: 'http://localhost:20128/v1',
  apiKey: '',
  router: '9router',
  model: '',
  workspaceRoot: '',
  approvalMode: 'ask'
};

let settings = { ...defaults, ...readStore('openqoder-settings', {}) };
let chats = readStore('openqoder-chats', []);
if (!Array.isArray(chats)) chats = [];

let currentId = null;
let busy = false;
let activeAbort = null;
let pendingApprovals = new Map();
let attachments = [];
let workspaceEntries = [];
let searchQuery = '';
let routerConnected = false;

const MAX_AGENT_STEPS = 20;
const READ_ONLY_TOOLS = new Set(['list_files', 'read_file', 'search_files']);

const modal = $('settings-modal');
const workspaceModal = $('workspace-modal');
const imageModal = $('image-modal');
const promptBox = $('prompt');
const modelSelect = $('model-select');
const approvalSelect = $('approval-mode');

const AGENT_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'List files and directories inside the active local workspace folder.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative directory path inside workspace (default ".").' },
          max_depth: { type: 'integer', description: 'Maximum recursion depth (1 to 8, default 4).' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a text file (with line numbers) or an image file (.png, .jpg, .jpeg, .webp, .gif, .bmp) from the active workspace. For images, the visual image content is attached so you can inspect it directly.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative path to the file inside the workspace.' },
          start_line: { type: 'integer', description: 'Optional 1-indexed start line for text files.' },
          end_line: { type: 'integer', description: 'Optional 1-indexed end line for text files.' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_files',
      description: 'Search text or regex patterns across files in the active workspace.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Text or regex pattern to search for.' },
          glob: { type: 'string', description: 'Optional filename or path glob filter (e.g. "*.py" or "src/*.ts").' },
          regex: { type: 'boolean', description: 'Treat query as a regular expression.' },
          case_sensitive: { type: 'boolean', description: 'Perform case-sensitive matching.' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Create or overwrite a file in the active workspace.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative file path inside the workspace.' },
          content: { type: 'string', description: 'Complete file content to write.' }
        },
        required: ['path', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: 'Replace an exact unique text snippet in an existing workspace file.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative path to the existing file.' },
          old_text: { type: 'string', description: 'Exact existing text to replace (must match uniquely).' },
          new_text: { type: 'string', description: 'Replacement text.' }
        },
        required: ['path', 'old_text', 'new_text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'delete_file',
      description: 'Delete a file inside the active workspace.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative path to the file to delete.' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: 'Execute a shell command inside the active workspace directory and inspect stdout, stderr, and exit code.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to execute in the workspace root.' },
          timeout_seconds: { type: 'integer', description: 'Timeout in seconds (1 to 120, default 30).' }
        },
        required: ['command']
      }
    }
  }
];

function readStore(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

function slimForStorage(chatsList) {
  return chatsList.map(chat => ({
    ...chat,
    messages: (chat.messages || []).map(msg => {
      const clone = { ...msg };
      if (Array.isArray(clone.content)) {
        clone.content = clone.content.map(part => {
          if (part?.type === 'image_url' && typeof part.image_url?.url === 'string' && part.image_url.url.length > 60000) {
            return { type: 'text', text: '[Image omitted from persisted browser cache]' };
          }
          return part;
        });
      }
      if (Array.isArray(clone._uiImages)) {
        clone._uiImages = clone._uiImages.map(img => ({
          name: img.name,
          thumbUrl: img.thumbUrl || (img.dataUrl && img.dataUrl.length < 40000 ? img.dataUrl : '')
        }));
      }
      if (Array.isArray(clone._steps)) {
        clone._steps = clone._steps.map(st => {
          const stClone = { ...st };
          if (stClone.imagePreview && stClone.imagePreview.length > 40000) {
            stClone.imagePreview = stClone.thumbUrl || '';
          }
          return stClone;
        });
      }
      if (Array.isArray(clone._snapshots)) {
        clone._snapshots = clone._snapshots.map(s => ({
          ...s,
          previousContent: typeof s.previousContent === 'string' && s.previousContent.length > 30000 ? null : s.previousContent
        }));
      }
      return clone;
    })
  }));
}

function persist() {
  try {
    localStorage.setItem('openqoder-chats', JSON.stringify(slimForStorage(chats)));
  } catch {
    toast('Could not save history: browser storage is full.');
  }
}

function saveSettings() {
  localStorage.setItem('openqoder-settings', JSON.stringify(settings));
}

function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove('show'), 4500);
}

function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, c => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[c]));
}

function current() {
  return chats.find(c => c.id === currentId);
}

function titleOf(chat) {
  return chat?.title || 'New task';
}

function routerDisplayName(router) {
  if (router === 'omniroute') return 'OmniRoute';
  if (router === 'custom') return 'Custom Router';
  return '9Router';
}

function workspaceDisplayName() {
  if (!settings.workspaceRoot) return 'No workspace';
  const parts = settings.workspaceRoot.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || settings.workspaceRoot;
}

function updateStatusBar() {
  const folderEl = $('footer-folder');
  const routerEl = $('footer-router');
  const meterEl = $('footer-meter');
  const meterTextEl = $('footer-meter-text');
  const agentStateEl = $('footer-agent-state');
  const openBtn = $('open-project');

  const wsName = workspaceDisplayName();
  if (folderEl) {
    folderEl.textContent = wsName;
    folderEl.title = settings.workspaceRoot || 'No workspace open';
  }
  if (openBtn) {
    const label = openBtn.querySelector('.project-label');
    if (label) label.textContent = settings.workspaceRoot ? wsName : 'Open workspace folder';
    openBtn.title = settings.workspaceRoot || 'Open workspace folder';
  }
  if (routerEl) {
    let portSuffix = '';
    try {
      const parsed = new URL(settings.baseUrl);
      if (parsed.port) portSuffix = ` · :${parsed.port}`;
    } catch {
      // Ignore partial URL
    }
    routerEl.textContent = `${routerDisplayName(settings.router)}${portSuffix}`;
  }
  if (meterEl && meterTextEl) {
    meterEl.classList.toggle('connected', routerConnected);
    meterTextEl.textContent = routerConnected ? 'Connected' : 'Offline';
  }
  if (agentStateEl) {
    if (busy) agentStateEl.textContent = 'Agent running…';
    else if (settings.workspaceRoot) agentStateEl.textContent = 'Autonomous agent ready';
    else agentStateEl.textContent = 'Vision chat · open folder for tools';
  }
}

function setBusyState(isBusy) {
  busy = isBusy;
  const sendBtn = $('send-button');
  const sendIcon = $('send-icon');
  if (sendBtn && sendIcon) {
    sendBtn.classList.toggle('stop', isBusy);
    sendBtn.type = isBusy ? 'button' : 'submit';
    sendBtn.setAttribute('aria-label', isBusy ? 'Stop agent' : 'Send message');
    sendBtn.title = isBusy ? 'Stop agent' : 'Send message';
    sendIcon.innerHTML = `<use href="${isBusy ? '#i-stop' : '#i-arrow'}"/>`;
  }
  updateStatusBar();
}

function createThumbnail(dataUrl) {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      try {
        const maxSide = 220;
        const scale = Math.min(1, maxSide / Math.max(img.width || 1, img.height || 1));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', 0.72));
      } catch {
        resolve(dataUrl.length < 40000 ? dataUrl : '');
      }
    };
    img.onerror = () => resolve('');
    img.src = dataUrl;
  });
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Failed to read file.'));
    reader.readAsDataURL(file);
  });
}

async function addBrowserFiles(fileList) {
  const files = [...(fileList || [])];
  if (!files.length) return;
  for (const file of files) {
    const isImage = file.type.startsWith('image/') || /\.(png|jpe?g|webp|gif|bmp)$/i.test(file.name);
    if (isImage) {
      if (file.size > 10 * 1024 * 1024) {
        toast(`Image "${file.name}" exceeds 10 MB limit.`);
        continue;
      }
      try {
        const dataUrl = await readFileAsDataUrl(file);
        const thumbUrl = await createThumbnail(dataUrl);
        attachments.push({
          id: crypto.randomUUID(),
          kind: 'image',
          name: file.name || 'image.png',
          mime: file.type || 'image/png',
          size: file.size,
          dataUrl,
          thumbUrl: thumbUrl || dataUrl
        });
      } catch {
        toast(`Could not read image "${file.name}".`);
      }
    } else {
      if (file.size > 1024 * 1024) {
        toast(`File "${file.name}" exceeds 1 MB text limit.`);
        continue;
      }
      try {
        const content = await file.text();
        attachments.push({
          id: crypto.randomUUID(),
          kind: 'text',
          name: file.name,
          path: file.name,
          size: file.size,
          content
        });
      } catch {
        toast(`Could not read file "${file.name}".`);
      }
    }
  }
  renderAttachments();
}

function renderAttachments() {
  const strip = $('attachment-strip');
  if (!strip) return;
  strip.replaceChildren();
  strip.hidden = attachments.length === 0;
  attachments.forEach(item => {
    const chip = document.createElement('div');
    chip.className = 'attachment-chip' + (item.kind === 'image' ? ' is-image' : '');
    if (item.kind === 'image') {
      const thumb = document.createElement('img');
      thumb.className = 'attachment-thumb';
      thumb.src = item.thumbUrl || item.dataUrl;
      thumb.alt = item.name;
      chip.append(thumb);
    } else {
      const icon = document.createElement('span');
      icon.className = 'attachment-doc-badge';
      icon.innerHTML = '<svg><use href="#i-file-doc"/></svg>';
      chip.append(icon);
    }
    const label = document.createElement('span');
    label.className = 'attachment-chip-name';
    label.textContent = item.path || item.name;
    label.title = item.path || item.name;
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'attachment-chip-remove';
    removeBtn.setAttribute('aria-label', `Remove ${item.name}`);
    removeBtn.innerHTML = '<svg><use href="#i-close"/></svg>';
    removeBtn.onclick = () => {
      attachments = attachments.filter(a => a.id !== item.id);
      renderAttachments();
    };
    chip.append(label, removeBtn);
    strip.append(chip);
  });
}

function openImageLightbox(src, title) {
  if (!src) return;
  $('image-modal-title').textContent = title || 'Image preview';
  $('image-modal-img').src = src;
  imageModal.hidden = false;
}

function closeImageLightbox() {
  imageModal.hidden = true;
  $('image-modal-img').removeAttribute('src');
}

async function workspaceApi(endpoint, payload = {}, signal = undefined) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal
  });
  const data = await response.json();
  if (!response.ok || data.error) {
    throw new Error(errorText(data, 'Workspace request failed.'));
  }
  return data;
}

async function loadWorkspace(rootPath, silent = false) {
  if (!rootPath) return false;
  try {
    const data = await workspaceApi('/api/workspace/info', { workspaceRoot: rootPath, maxDepth: 4 });
    settings.workspaceRoot = data.root;
    saveSettings();
    workspaceEntries = data.entries || [];
    renderFileTree();
    updateStatusBar();
    return true;
  } catch (err) {
    if (!silent) toast(err.message || 'Could not open workspace folder.');
    return false;
  }
}

function renderFileTree() {
  const list = $('file-list');
  if (!list) return;
  list.replaceChildren();
  const files = workspaceEntries.filter(e => e.type === 'file').slice(0, 150);
  files.forEach(entry => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'file-item' + (entry.isImage ? ' is-image' : '');
    btn.title = entry.path;
    btn.innerHTML = `<svg><use href="${entry.isImage ? '#i-image' : '#i-file-doc'}"/></svg><span>${escapeHTML(entry.path)}</span>`;
    btn.onclick = async () => {
      try {
        const res = await workspaceApi('/api/workspace/read', {
          workspaceRoot: settings.workspaceRoot,
          path: entry.path
        });
        if (res.type === 'image') {
          const thumbUrl = await createThumbnail(res.dataUrl);
          attachments.push({
            id: crypto.randomUUID(),
            kind: 'image',
            name: entry.name,
            path: entry.path,
            mime: res.mime,
            size: res.size,
            dataUrl: res.dataUrl,
            thumbUrl: thumbUrl || res.dataUrl
          });
        } else {
          attachments.push({
            id: crypto.randomUUID(),
            kind: 'text',
            name: entry.name,
            path: entry.path,
            content: res.content
          });
        }
        renderAttachments();
        promptBox.focus();
      } catch (err) {
        toast(err.message || `Could not read ${entry.path}.`);
      }
    };
    list.append(btn);
  });
}

async function openProject() {
  try {
    const res = await fetch('/api/workspace/pick', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    }).then(r => r.json());

    if (res.supported && !res.cancelled && res.root) {
      settings.workspaceRoot = res.root;
      saveSettings();
      workspaceEntries = res.entries || [];
      renderFileTree();
      updateStatusBar();
      toast(`Workspace opened: ${res.name}`);
      return;
    }
    if (res.supported && res.cancelled) return;
  } catch {
    // Fallback to path modal
  }
  openWorkspaceModal();
}

function openWorkspaceModal() {
  $('workspace-path-input').value = settings.workspaceRoot || '';
  workspaceModal.hidden = false;
  $('workspace-path-input').focus();
}

function closeWorkspaceModal() {
  workspaceModal.hidden = true;
}

function renderHistory() {
  const list = $('history');
  list.replaceChildren();
  const query = searchQuery.trim().toLowerCase();
  const visibleChats = query
    ? chats.filter(chat => titleOf(chat).toLowerCase().includes(query))
    : chats;

  if (!chats.length) {
    list.innerHTML = '<p class="history-empty">Your conversations will appear here.</p>';
    return;
  }
  if (!visibleChats.length) {
    list.innerHTML = '<p class="history-empty">No matching conversations.</p>';
    return;
  }

  visibleChats.forEach(chat => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'history-item' + (chat.id === currentId ? ' selected' : '');
    button.textContent = titleOf(chat);
    button.title = titleOf(chat);
    button.onclick = () => {
      if (busy) {
        toast('Stop or wait for the active agent run first.');
        return;
      }
      currentId = chat.id;
      render();
      closeSidebarOnMobile();
    };
    list.append(button);
  });
}

function formatInline(escapedText) {
  return escapedText
    .replace(/`([^`\n]+)`/g, '<code class="md-inline-code">$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
}

function renderProse(rawText) {
  const lines = String(rawText || '').split(/\r?\n/);
  const blocks = [];
  let paragraph = [];
  let listItems = [];

  const flushParagraph = () => {
    if (!paragraph.length) return;
    blocks.push(`<p class="md-paragraph">${paragraph.join('\n')}</p>`);
    paragraph = [];
  };

  const flushList = () => {
    if (!listItems.length) return;
    blocks.push(`<ul class="md-list">${listItems.map(item => `<li>${item}</li>`).join('')}</ul>`);
    listItems = [];
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      flushParagraph();
      flushList();
      continue;
    }
    const headingMatch = trimmed.match(/^(#{1,3})\s+(.+)$/);
    if (headingMatch) {
      flushParagraph();
      flushList();
      blocks.push(`<h3 class="md-heading">${formatInline(escapeHTML(headingMatch[2]))}</h3>`);
      continue;
    }
    const bulletMatch = trimmed.match(/^[-*•]\s+(.+)$/);
    if (bulletMatch) {
      flushParagraph();
      listItems.push(formatInline(escapeHTML(bulletMatch[1])));
      continue;
    }
    flushList();
    paragraph.push(formatInline(escapeHTML(line)));
  }

  flushParagraph();
  flushList();
  return blocks.join('');
}

function splitCodeFences(rawText) {
  const text = String(rawText || '');
  const segments = [];
  const fenceRegex = /```([^\n`]*)\r?\n([\s\S]*?)```/g;
  let lastIndex = 0;
  let match;

  while ((match = fenceRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ type: 'text', value: text.slice(lastIndex, match.index) });
    }
    segments.push({
      type: 'code',
      lang: match[1].trim(),
      code: match[2].replace(/\r?\n$/, '')
    });
    lastIndex = fenceRegex.lastIndex;
  }

  const tail = text.slice(lastIndex);
  const openMatch = tail.match(/```([^\n`]*)\r?\n([\s\S]*)$/);
  if (openMatch) {
    const beforeOpen = tail.slice(0, openMatch.index);
    if (beforeOpen) segments.push({ type: 'text', value: beforeOpen });
    segments.push({ type: 'code', lang: openMatch[1].trim(), code: openMatch[2] });
  } else if (tail) {
    segments.push({ type: 'text', value: tail });
  }
  return segments;
}

function renderDocCard(filePath) {
  const cleanName = filePath.split(/[\\/]/).pop() || filePath;
  const extMatch = cleanName.match(/\.([a-zA-Z0-9]+)$/);
  const extLabel = extMatch ? `${extMatch[1].toUpperCase()} · ${filePath}` : filePath;
  return `<div class="qoder-doc-card"><div class="qoder-doc-icon"><svg><use href="#i-file-doc"/></svg></div><div class="qoder-doc-info"><div class="qoder-doc-name">${escapeHTML(cleanName)}</div><div class="qoder-doc-ext">${escapeHTML(extLabel)}</div></div></div>`;
}

function renderBody(text, codeBlocksOut) {
  const segments = splitCodeFences(text);
  return segments.map(segment => {
    if (segment.type === 'text') return renderProse(segment.value);
    const blockIdx = codeBlocksOut.length;
    codeBlocksOut.push(segment);
    const linesCount = segment.code ? segment.code.split(/\r?\n/).length : 0;
    const langLabel = segment.lang || 'Code snippet';
    return `<div class="qoder-code-card">
      <div class="qoder-code-head">
        <div class="qoder-code-meta">
          <span class="qoder-code-icon"><svg><use href="#i-code"/></svg></span>
          <div class="qoder-code-titles">
            <span class="qoder-code-lang">${escapeHTML(langLabel)}</span>
            <span class="qoder-code-lines">+${linesCount} ${linesCount === 1 ? 'line' : 'lines'}</span>
          </div>
        </div>
        <div class="qoder-code-actions">
          <button type="button" class="qoder-pill-btn" data-copy-code="${blockIdx}">Copy</button>
          <button type="button" class="qoder-pill-btn primary" data-save-code="${blockIdx}">Save</button>
        </div>
      </div>
      <pre><code>${escapeHTML(segment.code)}</code></pre>
    </div>`;
  }).join('');
}

function buildUserMessageNode(message) {
  const el = document.createElement('article');
  el.className = 'message user';
  let displayText = message._displayText;
  let uiDocs = message._uiDocs || [];

  if (displayText === undefined) {
    const raw = typeof message.content === 'string' ? message.content : '';
    const marker = '\n\n📎 ';
    const idx = raw.lastIndexOf(marker);
    if (idx !== -1) {
      displayText = raw.slice(0, idx);
      uiDocs = [raw.slice(idx + marker.length).trim()];
    } else {
      displayText = message.display || raw;
    }
  }

  const docsHtml = uiDocs.map(renderDocCard).join('');
  el.innerHTML = `<div class="avatar">You</div>
    <div class="message-content">
      <div class="message-meta">You</div>
      <div class="message-body">${renderProse(displayText)}${docsHtml}</div>
    </div>`;

  const images = message._uiImages || [];
  if (images.length) {
    const gallery = document.createElement('div');
    gallery.className = 'message-images';
    images.forEach(img => {
      const src = img.dataUrl || img.thumbUrl;
      if (!src) return;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'message-image-btn';
      btn.onclick = () => openImageLightbox(img.dataUrl || img.thumbUrl, img.name);
      const imgEl = document.createElement('img');
      imgEl.src = img.thumbUrl || img.dataUrl;
      imgEl.alt = img.name || 'Attached image';
      const cap = document.createElement('span');
      cap.className = 'message-image-caption';
      cap.textContent = img.name || 'image';
      btn.append(imgEl, cap);
      gallery.append(btn);
    });
    if (gallery.children.length) {
      el.querySelector('.message-body').append(gallery);
    }
  }
  return el;
}

function renderToolStepElement(step) {
  const box = document.createElement('div');
  box.className = 'agent-step';

  const head = document.createElement('button');
  head.type = 'button';
  head.className = 'agent-step-head';
  head.setAttribute('aria-expanded', String(!!step.expanded));

  const statusClass = step.status === 'running' || step.status === 'pending'
    ? 'running'
    : step.status === 'error' || step.status === 'rejected'
      ? 'error'
      : 'done';
  const metaClass = step.status === 'error' || step.status === 'rejected' ? 'err' : 'ok';

  head.innerHTML = `<span class="step-status ${statusClass}"></span>
    <span class="step-verb">${escapeHTML(step.verb || step.tool)}</span>
    <span class="step-target">${escapeHTML(step.target || '')}</span>
    <span class="step-meta ${metaClass}">${escapeHTML(step.meta || '')}</span>`;

  const hasBody = !!(step.detail || step.stderr || step.imagePreview || step.diff);
  const body = document.createElement('div');
  body.className = 'agent-step-body';
  body.hidden = !step.expanded;

  if (hasBody) {
    if (step.imagePreview) {
      const wrap = document.createElement('button');
      wrap.type = 'button';
      wrap.className = 'message-image-btn';
      wrap.onclick = () => openImageLightbox(step.imagePreview, step.target || 'Workspace image');
      const im = document.createElement('img');
      im.src = step.imagePreview;
      im.alt = step.target || 'Workspace image';
      wrap.append(im);
      body.append(wrap);
    }
    if (step.detail) {
      const pre = document.createElement('pre');
      pre.textContent = step.detail;
      body.append(pre);
    }
    if (step.stderr) {
      const preErr = document.createElement('pre');
      preErr.className = 'step-stderr';
      preErr.textContent = step.stderr;
      body.append(preErr);
    }
    if (step.diff) {
      const preDiff = document.createElement('pre');
      preDiff.textContent = step.diff;
      body.append(preDiff);
    }
    head.onclick = () => {
      step.expanded = !step.expanded;
      body.hidden = !step.expanded;
      head.setAttribute('aria-expanded', String(step.expanded));
    };
  }

  box.append(head);
  if (hasBody) box.append(body);
  return box;
}

function renderApprovalCard(step) {
  const card = document.createElement('div');
  card.className = 'approval-card';
  card.innerHTML = `<div class="approval-card-head">
      <svg><use href="#i-shield"/></svg>
      <span>Approval required: ${escapeHTML(step.verb)} ${escapeHTML(step.target || '')}</span>
    </div>
    <div class="approval-card-detail">${escapeHTML(step.approvalPreview || '')}</div>
    <div class="approval-card-actions">
      <button type="button" class="qoder-pill-btn primary" data-act="approve">Approve</button>
      <button type="button" class="qoder-pill-btn" data-act="auto">Auto-run session</button>
      <button type="button" class="qoder-pill-btn" data-act="reject">Reject</button>
    </div>`;

  const resolver = pendingApprovals.get(step.id);
  if (resolver) {
    card.querySelector('[data-act="approve"]').onclick = () => resolver('approve');
    card.querySelector('[data-act="auto"]').onclick = () => resolver('auto');
    card.querySelector('[data-act="reject"]').onclick = () => resolver('reject');
  }
  return card;
}

function renderEditedSummaryCard(snapshots) {
  // Deduplicate by file path preserving first snapshot for Undo and latest diff stats
  const byPath = new Map();
  snapshots.forEach(s => {
    const existing = byPath.get(s.path);
    if (!existing) {
      byPath.set(s.path, { ...s });
    } else {
      existing.added += s.added || 0;
      existing.removed += s.removed || 0;
      if (s.diff) existing.diff = s.diff;
    }
  });
  const items = [...byPath.values()];
  if (!items.length) return null;

  const totalAdd = items.reduce((sum, f) => sum + (f.added || 0), 0);
  const totalDel = items.reduce((sum, f) => sum + (f.removed || 0), 0);
  const card = document.createElement('div');
  card.className = 'qoder-edited-card';

  const canUndo = items.some(i => !i.undone && (i.existed === false || typeof i.previousContent === 'string'));
  const allUndone = items.every(i => i.undone);

  card.innerHTML = `<div class="qoder-edited-head">
      <div class="qoder-edited-left">
        <span class="qoder-edited-icon"><svg><use href="#i-file-doc"/></svg></span>
        <div>
          <div class="qoder-edited-title">${allUndone ? 'Reverted' : 'Edited'} ${items.length} ${items.length === 1 ? 'file' : 'files'}</div>
          <div class="qoder-edited-totals"><span class="stat-add">+${totalAdd}</span><span class="stat-del">-${totalDel}</span></div>
        </div>
      </div>
      <div class="qoder-edited-actions">
        <button type="button" class="qoder-pill-btn undo-btn" ${!canUndo ? 'disabled' : ''}>${allUndone ? 'Undone' : 'Undo'}</button>
        <button type="button" class="qoder-pill-btn review-btn">Review</button>
      </div>
    </div>
    <div class="qoder-edited-list">${items.map(f => `<div class="qoder-edited-row">
      <span class="qoder-edited-path">${escapeHTML(f.path)}</span>
      <span class="qoder-edited-diffstats"><span class="stat-add">+${f.added || 0}</span><span class="stat-del">-${f.removed || 0}</span></span>
    </div>`).join('')}</div>
    <div class="qoder-review-drawer" hidden><pre>${escapeHTML(items.map(i => i.diff || `--- ${i.path}`).join('\n'))}</pre></div>`;

  const reviewBtn = card.querySelector('.review-btn');
  const drawer = card.querySelector('.qoder-review-drawer');
  reviewBtn.onclick = () => {
    drawer.hidden = !drawer.hidden;
    reviewBtn.textContent = drawer.hidden ? 'Review' : 'Hide diff';
  };

  const undoBtn = card.querySelector('.undo-btn');
  undoBtn.onclick = async () => {
    if (!settings.workspaceRoot || !canUndo) return;
    try {
      const res = await workspaceApi('/api/workspace/restore', {
        workspaceRoot: settings.workspaceRoot,
        snapshots
      });
      snapshots.forEach(s => { s.undone = true; });
      persist();
      render();
      await loadWorkspace(settings.workspaceRoot, true);
      toast(`Restored ${res.restored.length} file(s).`);
    } catch (err) {
      toast(err.message || 'Could not undo changes.');
    }
  };
  return card;
}

function buildAssistantTurnNode(turnMessages) {
  const el = document.createElement('article');
  el.className = 'message assistant';
  el.innerHTML = `<div class="avatar"><svg><use href="#i-logo"/></svg></div>
    <div class="message-content">
      <div class="message-meta">OpenQoder</div>
      <div class="message-body"></div>
      <div class="message-tools">
        <button type="button" class="copy-message"><svg><use href="#i-copy"/></svg> Copy</button>
        <button type="button" class="save-code"><svg><use href="#i-save"/></svg> Save first code block</button>
      </div>
    </div>`;

  const bodyEl = el.querySelector('.message-body');
  const allCodeBlocks = [];
  const allTextParts = [];
  const allSnapshots = [];

  turnMessages.forEach(msg => {
    if (msg.role !== 'assistant') return;
    const text = typeof msg.content === 'string' ? msg.content : '';
    if (text.trim()) {
      allTextParts.push(text);
      const proseWrapper = document.createElement('div');
      const localBlocks = [];
      proseWrapper.innerHTML = renderBody(text, localBlocks);
      const offset = allCodeBlocks.length;
      localBlocks.forEach(b => allCodeBlocks.push(b));
      proseWrapper.querySelectorAll('[data-copy-code]').forEach(btn => {
        const idx = Number(btn.dataset.copyCode) + offset;
        btn.onclick = async () => {
          try {
            await navigator.clipboard.writeText(allCodeBlocks[idx].code);
            toast('Code block copied.');
          } catch {
            toast('Could not copy to clipboard.');
          }
        };
      });
      proseWrapper.querySelectorAll('[data-save-code]').forEach(btn => {
        const idx = Number(btn.dataset.saveCode) + offset;
        btn.onclick = () => {
          const blk = allCodeBlocks[idx];
          const ext = blk.lang && /^[a-z0-9]+$/i.test(blk.lang) ? blk.lang.toLowerCase() : 'txt';
          saveCodeBlock(blk.code, `openqoder-snippet.${ext}`);
        };
      });
      bodyEl.append(proseWrapper);
    }

    if (Array.isArray(msg._steps) && msg._steps.length) {
      const stepsWrap = document.createElement('div');
      stepsWrap.className = 'agent-steps';
      msg._steps.forEach(step => {
        if (step.status === 'pending' && pendingApprovals.has(step.id)) {
          stepsWrap.append(renderApprovalCard(step));
        } else {
          stepsWrap.append(renderToolStepElement(step));
        }
      });
      bodyEl.append(stepsWrap);
    }

    if (Array.isArray(msg._snapshots) && msg._snapshots.length) {
      allSnapshots.push(...msg._snapshots);
    }
  });

  if (allSnapshots.length) {
    const editedCard = renderEditedSummaryCard(allSnapshots);
    if (editedCard) bodyEl.append(editedCard);
  }

  const combinedText = allTextParts.join('\n\n');
  if (!combinedText.trim() && !bodyEl.children.length) {
    bodyEl.innerHTML = '<p class="md-paragraph" style="color:var(--muted)">Thinking…</p>';
  }

  el.querySelector('.copy-message').onclick = async () => {
    try {
      await navigator.clipboard.writeText(combinedText);
      toast('Response copied.');
    } catch {
      toast('Could not copy to clipboard.');
    }
  };
  el.querySelector('.save-code').onclick = () => saveCode(combinedText);
  return el;
}

function render() {
  const chat = current();
  $('conversation-title').textContent = titleOf(chat);
  const msgs = chat?.messages || [];
  const hasMessages = msgs.length > 0;
  $('welcome').hidden = hasMessages;
  $('suggestions').hidden = hasMessages;
  $('new-chat').classList.toggle('active', !hasMessages);

  const container = $('messages');
  container.replaceChildren();

  let i = 0;
  while (i < msgs.length) {
    const m = msgs[i];
    if (m.role === 'user' && !m._synthetic) {
      container.append(buildUserMessageNode(m));
      i++;
    } else {
      const turnGroup = [];
      while (i < msgs.length && !(msgs[i].role === 'user' && !msgs[i]._synthetic)) {
        turnGroup.push(msgs[i]);
        i++;
      }
      container.append(buildAssistantTurnNode(turnGroup));
    }
  }

  renderHistory();
  updateStatusBar();
  requestAnimationFrame(() => {
    $('main-scroll').scrollTop = $('main-scroll').scrollHeight;
  });
}

function newChat() {
  if (busy) {
    toast('Stop the running agent before starting a new task.');
    return;
  }
  currentId = null;
  attachments = [];
  renderAttachments();
  render();
  promptBox.focus();
  closeSidebarOnMobile();
}

function openSettings() {
  $('router-preset').value = settings.router;
  $('base-url').value = settings.baseUrl;
  $('api-key').value = settings.apiKey;
  modal.hidden = false;
  $('base-url').focus();
}

function closeSettings() {
  modal.hidden = true;
}

function errorText(data, fallback) {
  return typeof data?.error === 'string'
    ? data.error
    : data?.error?.message || data?.message || fallback;
}

async function loadModels() {
  modelSelect.innerHTML = '<option value="">Loading models…</option>';
  $('connection-label').textContent = 'Connecting…';
  try {
    const response = await fetch('/api/models', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseUrl: settings.baseUrl, apiKey: settings.apiKey })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(errorText(data, 'Could not load models.'));

    const models = Array.isArray(data) ? data : Array.isArray(data.data) ? data.data : [];
    const ids = [...new Set(models.map(m => typeof m === 'string' ? m : m.id).filter(x => typeof x === 'string' && x))]
      .sort((a, b) => a.localeCompare(b));

    modelSelect.replaceChildren(new Option(ids.length ? 'Select a model' : 'No models available', ''));
    ids.forEach(id => modelSelect.add(new Option(id, id)));

    if (ids.includes(settings.model)) modelSelect.value = settings.model;
    else settings.model = '';

    routerConnected = true;
    $('connection-dot').classList.add('connected');
    $('connection-label').textContent = `${routerDisplayName(settings.router)} connected`;
    updateStatusBar();
    if (!ids.length) toast('The router returned no models. Configure a provider in your router.');
    return true;
  } catch (err) {
    routerConnected = false;
    modelSelect.innerHTML = '<option value="">Select a model</option>';
    $('connection-dot').classList.remove('connected');
    $('connection-label').textContent = 'Connect a router';
    updateStatusBar();
    toast(err.message || 'Could not load models.');
    return false;
  }
}

function buildSystemPrompt() {
  if (!settings.workspaceRoot) {
    return 'You are OpenQoder, an autonomous coding and vision assistant. You can inspect attached images and code directly. If the user asks you to inspect, edit, or run commands inside a local repository and no workspace folder is open yet, tell them to click "Open workspace folder" in the sidebar.';
  }
  return `You are OpenQoder, an autonomous coding agent operating in the user's local workspace: ${settings.workspaceRoot}.
You have tools to list files, read text files and image files (read_file supports PNG/JPG/WEBP/GIF/BMP and attaches them visually for you), search across the codebase, edit files cleanly, write new files, and run shell commands/tests.
Guidelines:
- Inspect relevant files before editing them.
- Prefer edit_file for targeted changes and write_file for new files or full rewrites.
- Run tests, linters, or verification commands after making changes whenever appropriate.
- Be concise and report only file paths, symbols, and command outputs you directly observed.`;
}

function toApiMessages(chatMessages) {
  const out = [{ role: 'system', content: buildSystemPrompt() }];
  for (const m of chatMessages) {
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.content });
    } else if (m.role === 'assistant') {
      const msg = { role: 'assistant', content: m.content ?? '' };
      if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
        msg.tool_calls = m.tool_calls;
      }
      if (msg.content || msg.tool_calls) out.push(msg);
    } else if (m.role === 'tool') {
      out.push({ role: 'tool', tool_call_id: m.tool_call_id, content: m.content });
    }
  }
  return out;
}

async function callModelOnce(apiMessages, tools, assistantMsg, signal) {
  const payload = {
    baseUrl: settings.baseUrl,
    apiKey: settings.apiKey,
    model: modelSelect.value,
    messages: apiMessages,
    stream: true
  };
  if (tools && tools.length) {
    payload.tools = tools;
    payload.tool_choice = 'auto';
  }

  const response = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal
  });

  if (!response.ok) {
    let data;
    try { data = await response.json(); } catch {}
    const msg = errorText(data, `Router returned HTTP ${response.status}.`);
    const err = new Error(msg);
    err.status = response.status;
    throw err;
  }

  const type = response.headers.get('content-type') || '';
  if (type.includes('text/event-stream')) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const toolMap = new Map();

    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        try {
          const chunk = JSON.parse(data);
          if (chunk.error) throw new Error(errorText(chunk, 'Router stream failed.'));
          const delta = chunk.choices?.[0]?.delta;
          if (!delta) continue;
          if (typeof delta.content === 'string') {
            assistantMsg.content += delta.content;
          }
          if (Array.isArray(delta.tool_calls)) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;
              const entry = toolMap.get(idx) || {
                id: tc.id || `call_${crypto.randomUUID().slice(0, 8)}`,
                type: 'function',
                function: { name: '', arguments: '' }
              };
              if (tc.id) entry.id = tc.id;
              if (tc.function?.name) entry.function.name += tc.function.name;
              if (tc.function?.arguments) entry.function.arguments += tc.function.arguments;
              toolMap.set(idx, entry);
            }
            assistantMsg.tool_calls = [...toolMap.entries()]
              .sort((a, b) => a[0] - b[0])
              .map(e => e[1]);
          }
        } catch (e) {
          if (e instanceof SyntaxError) continue;
          throw e;
        }
      }
      render();
      if (done) break;
    }
  } else {
    const data = await response.json();
    if (data.error) throw new Error(errorText(data, 'Router request failed.'));
    const msg = data.choices?.[0]?.message || {};
    assistantMsg.content = msg.content || '';
    if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
      assistantMsg.tool_calls = msg.tool_calls;
    }
    render();
  }
}

function requestApproval(step, signal) {
  return new Promise(resolve => {
    const onAbort = () => {
      pendingApprovals.delete(step.id);
      resolve('reject');
    };
    if (signal.aborted) return resolve('reject');
    signal.addEventListener('abort', onAbort, { once: true });

    pendingApprovals.set(step.id, choice => {
      signal.removeEventListener('abort', onAbort);
      pendingApprovals.delete(step.id);
      if (choice === 'auto') {
        settings.approvalMode = 'auto';
        approvalSelect.value = 'auto';
        approvalSelect.dispatchEvent(new Event('change', { bubbles: true }));
        saveSettings();
      }
      resolve(choice);
    });
    render();
  });
}

function describeToolAction(toolName, args) {
  switch (toolName) {
    case 'list_files':
      return { verb: 'Listed files', target: args.path || '.' };
    case 'read_file':
      return { verb: 'Read', target: args.path || '' };
    case 'search_files':
      return { verb: 'Searched', target: `"${args.query || ''}"` };
    case 'write_file':
      return { verb: 'Write', target: args.path || '', preview: (args.content || '').slice(0, 1200) };
    case 'edit_file':
      return { verb: 'Edit', target: args.path || '', preview: `- ${args.old_text || ''}\n+ ${args.new_text || ''}` };
    case 'delete_file':
      return { verb: 'Delete', target: args.path || '', preview: `Delete file ${args.path || ''}` };
    case 'run_command':
      return { verb: 'Run', target: args.command || '', preview: args.command || '' };
    default:
      return { verb: toolName, target: '' };
  }
}

async function executeAgentTool(toolName, args, step, signal, snapshots, pendingImages) {
  if (!settings.workspaceRoot) {
    throw new Error('No workspace folder is open. Ask the user to open a workspace folder first.');
  }
  const root = settings.workspaceRoot;

  if (toolName === 'list_files') {
    const res = await workspaceApi('/api/workspace/info', {
      workspaceRoot: root,
      path: args.path || '.',
      maxDepth: args.max_depth || 4
    }, signal);
    const listText = (res.entries || []).map(e => `${e.type === 'dir' ? '[dir]' : '[file]'} ${e.path}`).join('\n');
    step.meta = `${res.entries.length} items`;
    step.detail = listText;
    return { ok: true, count: res.entries.length, entries: res.entries.map(e => ({ path: e.path, type: e.type })) };
  }

  if (toolName === 'read_file') {
    const res = await workspaceApi('/api/workspace/read', {
      workspaceRoot: root,
      path: args.path,
      startLine: args.start_line,
      endLine: args.end_line
    }, signal);
    if (res.type === 'image') {
      const thumb = await createThumbnail(res.dataUrl);
      step.verb = 'Read image';
      step.meta = res.mime;
      step.imagePreview = res.dataUrl;
      step.thumbUrl = thumb || res.dataUrl;
      pendingImages.push({ path: res.path, dataUrl: res.dataUrl });
      return {
        ok: true,
        type: 'image',
        path: res.path,
        mime: res.mime,
        size: res.size,
        note: 'Image loaded and attached in the next user message for visual inspection.'
      };
    }
    step.meta = `L${res.startLine}-${res.endLine} / ${res.totalLines}`;
    step.detail = res.content;
    return res;
  }

  if (toolName === 'search_files') {
    const res = await workspaceApi('/api/workspace/search', {
      workspaceRoot: root,
      query: args.query,
      glob: args.glob,
      regex: !!args.regex,
      caseSensitive: !!args.case_sensitive
    }, signal);
    step.meta = `${res.matches.length} ${res.matches.length === 1 ? 'match' : 'matches'}`;
    step.detail = res.matches.map(m => `${m.path}:${m.line}: ${m.text}`).join('\n');
    return res;
  }

  if (toolName === 'write_file') {
    const res = await workspaceApi('/api/workspace/write', {
      workspaceRoot: root,
      path: args.path,
      content: args.content
    }, signal);
    step.verb = res.existed ? 'Updated' : 'Created';
    step.meta = `+${res.added} -${res.removed}`;
    step.diff = res.diff;
    snapshots.push({
      path: res.path,
      existed: res.existed,
      previousContent: res.previousContent,
      added: res.added,
      removed: res.removed,
      diff: res.diff
    });
    await loadWorkspace(root, true);
    return { ok: true, path: res.path, existed: res.existed, added: res.added, removed: res.removed };
  }

  if (toolName === 'edit_file') {
    const res = await workspaceApi('/api/workspace/edit', {
      workspaceRoot: root,
      path: args.path,
      oldText: args.old_text,
      newText: args.new_text
    }, signal);
    step.verb = 'Edited';
    step.meta = `+${res.added} -${res.removed}`;
    step.diff = res.diff;
    snapshots.push({
      path: res.path,
      existed: true,
      previousContent: res.previousContent,
      added: res.added,
      removed: res.removed,
      diff: res.diff
    });
    await loadWorkspace(root, true);
    return { ok: true, path: res.path, added: res.added, removed: res.removed };
  }

  if (toolName === 'delete_file') {
    const res = await workspaceApi('/api/workspace/delete', {
      workspaceRoot: root,
      path: args.path
    }, signal);
    step.verb = 'Deleted';
    step.meta = `-${res.removed}`;
    step.diff = res.diff;
    snapshots.push({
      path: res.path,
      existed: true,
      previousContent: res.previousContent,
      added: 0,
      removed: res.removed,
      diff: res.diff
    });
    await loadWorkspace(root, true);
    return { ok: true, path: res.path, removed: res.removed };
  }

  if (toolName === 'run_command') {
    const res = await workspaceApi('/api/workspace/exec', {
      workspaceRoot: root,
      command: args.command,
      timeoutSeconds: args.timeout_seconds || 30
    }, signal);
    step.verb = 'Ran';
    step.meta = res.timedOut ? 'Timed out' : `Exit ${res.exitCode} · ${res.durationMs}ms`;
    step.detail = res.stdout || '(no stdout)';
    step.stderr = res.stderr || '';
    if (res.exitCode !== 0 || res.timedOut) {
      step.status = 'error';
      step.expanded = true;
    }
    return res;
  }

  throw new Error(`Unknown tool: ${toolName}`);
}

async function sendMessage(event) {
  event.preventDefault();
  if (busy) {
    activeAbort?.abort();
    return;
  }

  const text = promptBox.value.trim();
  if (!text && !attachments.length) return;
  if (!modelSelect.value) {
    toast('Connect your router and select a model first.');
    openSettings();
    return;
  }

  const currentAttachments = [...attachments];
  const imageAttachments = currentAttachments.filter(a => a.kind === 'image');
  const textAttachments = currentAttachments.filter(a => a.kind === 'text');

  const textFilesBlock = textAttachments
    .map(f => `\n\nAttached file: ${f.path || f.name}\n\`\`\`\n${f.content}\n\`\`\``)
    .join('');

  const combinedText = (text || 'Please inspect the attached item(s).') + textFilesBlock;
  const apiContent = imageAttachments.length
    ? [
        { type: 'text', text: combinedText },
        ...imageAttachments.map(img => ({ type: 'image_url', image_url: { url: img.dataUrl } }))
      ]
    : combinedText;

  if (!current()) {
    currentId = crypto.randomUUID();
    const titleSeed = text || currentAttachments.map(a => a.name).join(', ');
    chats.unshift({ id: currentId, title: titleSeed.slice(0, 55), messages: [] });
  }

  const chat = current();
  chat.messages.push({
    role: 'user',
    content: apiContent,
    _displayText: text || (imageAttachments.length ? 'Inspect attached image(s)' : ''),
    _uiDocs: textAttachments.map(f => f.path || f.name),
    _uiImages: imageAttachments.map(img => ({
      name: img.name,
      dataUrl: img.dataUrl,
      thumbUrl: img.thumbUrl
    }))
  });

  promptBox.value = '';
  promptBox.style.height = '';
  attachments = [];
  renderAttachments();

  activeAbort = new AbortController();
  setBusyState(true);
  render();

  let useTools = !!settings.workspaceRoot;

  try {
    for (let stepIdx = 0; stepIdx < MAX_AGENT_STEPS; stepIdx++) {
      if (activeAbort.signal.aborted) break;

      const assistantMsg = {
        role: 'assistant',
        content: '',
        _steps: [],
        _snapshots: []
      };
      chat.messages.push(assistantMsg);
      render();

      const apiMessages = toApiMessages(chat.messages.slice(0, -1));
      try {
        await callModelOnce(apiMessages, useTools ? AGENT_TOOLS : null, assistantMsg, activeAbort.signal);
      } catch (err) {
        if (err.name === 'AbortError') {
          if (!assistantMsg.content && !assistantMsg._steps.length) chat.messages.pop();
          break;
        }
        if (useTools && err.status === 400 && /tool/i.test(err.message)) {
          useTools = false;
          toast('Selected model does not support tools; continuing in chat/vision mode.');
          await callModelOnce(apiMessages, null, assistantMsg, activeAbort.signal);
        } else {
          if (!assistantMsg.content && !assistantMsg._steps.length) chat.messages.pop();
          throw err;
        }
      }

      const calls = assistantMsg.tool_calls;
      if (!calls || !calls.length) {
        if (!assistantMsg.content) {
          chat.messages.pop();
          throw new Error('The router returned an empty response.');
        }
        persist();
        break;
      }

      const pendingImages = [];
      for (const tc of calls) {
        if (activeAbort.signal.aborted) break;
        const toolName = tc.function?.name || '';
        let args = {};
        try {
          args = JSON.parse(tc.function?.arguments || '{}');
        } catch {
          args = {};
        }

        const desc = describeToolAction(toolName, args);
        const step = {
          id: tc.id || crypto.randomUUID(),
          tool: toolName,
          verb: desc.verb,
          target: desc.target,
          approvalPreview: desc.preview,
          status: 'running',
          meta: 'Running…',
          expanded: false
        };
        assistantMsg._steps.push(step);
        render();

        const isMutating = !READ_ONLY_TOOLS.has(toolName);
        if (isMutating && settings.approvalMode === 'readonly') {
          step.status = 'rejected';
          step.meta = 'Read-only';
          chat.messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: JSON.stringify({ ok: false, error: 'Blocked because OpenQoder is in Read-only mode.' })
          });
          render();
          continue;
        }

        if (isMutating && settings.approvalMode === 'ask') {
          step.status = 'pending';
          step.meta = 'Needs approval';
          const decision = await requestApproval(step, activeAbort.signal);
          if (decision === 'reject') {
            step.status = 'rejected';
            step.meta = 'Rejected';
            chat.messages.push({
              role: 'tool',
              tool_call_id: tc.id,
              content: JSON.stringify({ ok: false, error: 'User rejected this tool action.' })
            });
            render();
            continue;
          }
          step.status = 'running';
          step.meta = 'Running…';
          render();
        }

        try {
          const result = await executeAgentTool(
            toolName,
            args,
            step,
            activeAbort.signal,
            assistantMsg._snapshots,
            pendingImages
          );
          if (step.status === 'running') step.status = 'done';
          chat.messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: JSON.stringify(result)
          });
        } catch (toolErr) {
          step.status = 'error';
          step.meta = 'Error';
          step.detail = toolErr.message || 'Tool execution failed.';
          step.expanded = true;
          chat.messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: JSON.stringify({ ok: false, error: toolErr.message || 'Tool execution failed.' })
          });
        }
        render();
      }

      if (pendingImages.length) {
        chat.messages.push({
          role: 'user',
          _synthetic: true,
          content: [
            {
              type: 'text',
              text: `Workspace image(s) loaded from read_file (${pendingImages.map(i => i.path).join(', ')}):`
            },
            ...pendingImages.map(i => ({ type: 'image_url', image_url: { url: i.dataUrl } }))
          ]
        });
      }
      persist();
    }
  } catch (err) {
    if (err.name !== 'AbortError') {
      persist();
      toast(err.message || 'Could not complete agent turn.');
    }
  } finally {
    activeAbort = null;
    pendingApprovals.clear();
    setBusyState(false);
    persist();
    render();
    promptBox.focus();
  }
}

async function saveCodeBlock(code, suggestedName = 'openqoder-code.txt') {
  if (!window.showSaveFilePicker) {
    toast('Saving files requires a supported Chromium browser.');
    return;
  }
  try {
    const handle = await window.showSaveFilePicker({ suggestedName });
    const writable = await handle.createWritable();
    await writable.write(code);
    await writable.close();
    toast('Code saved to the selected file.');
  } catch (err) {
    if (err.name !== 'AbortError') toast('Could not save the file.');
  }
}

async function saveCode(content) {
  const matches = [...String(content || '').matchAll(/```[^\n`]*\r?\n([\s\S]*?)```/g)];
  const code = matches[0]?.[1];
  if (!code) {
    toast('No fenced code block was found in this response.');
    return;
  }
  await saveCodeBlock(code, 'openqoder-code.txt');
}

function closeSidebarOnMobile() {
  if (innerWidth <= 760) $('sidebar').classList.add('collapsed');
}

function toggleSearch(forceState) {
  const wrap = $('sidebar-search-wrap');
  const input = $('sidebar-search');
  const btn = $('search-button');
  const show = typeof forceState === 'boolean' ? forceState : wrap.hidden;
  wrap.hidden = !show;
  btn.setAttribute('aria-expanded', String(show));
  if (show) {
    input.focus();
  } else {
    searchQuery = '';
    input.value = '';
    $('clear-search').hidden = true;
    renderHistory();
  }
}

// Event bindings
$('new-chat').onclick = newChat;
$('settings-button').onclick = openSettings;
$('top-settings').onclick = openSettings;
$('welcome-connect').onclick = openSettings;
$('close-settings').onclick = closeSettings;
$('cancel-settings').onclick = closeSettings;
modal.onclick = e => { if (e.target === modal) closeSettings(); };

$('close-workspace-modal').onclick = closeWorkspaceModal;
$('cancel-workspace-modal').onclick = closeWorkspaceModal;
workspaceModal.onclick = e => { if (e.target === workspaceModal) closeWorkspaceModal(); };
$('browse-workspace-native').onclick = async () => {
  closeWorkspaceModal();
  await openProject();
};
$('workspace-form').onsubmit = async e => {
  e.preventDefault();
  const pathVal = $('workspace-path-input').value.trim();
  if (!pathVal) return;
  const ok = await loadWorkspace(pathVal, false);
  if (ok) {
    closeWorkspaceModal();
    toast(`Workspace opened: ${workspaceDisplayName()}`);
  }
};

$('close-image-modal').onclick = closeImageLightbox;
imageModal.onclick = e => { if (e.target === imageModal) closeImageLightbox(); };

$('router-preset').onchange = e => {
  if (e.target.value !== 'custom') $('base-url').value = 'http://localhost:20128/v1';
};

$('settings-form').onsubmit = async e => {
  e.preventDefault();
  settings = {
    ...settings,
    router: $('router-preset').value,
    baseUrl: $('base-url').value.trim().replace(/\/$/, ''),
    apiKey: $('api-key').value
  };
  saveSettings();
  closeSettings();
  await loadModels();
};

modelSelect.onchange = () => {
  settings.model = modelSelect.value;
  saveSettings();
};

approvalSelect.value = settings.approvalMode || 'ask';
approvalSelect.onchange = () => {
  settings.approvalMode = approvalSelect.value;
  saveSettings();
};

$('refresh-models').onclick = loadModels;
$('composer').onsubmit = sendMessage;

promptBox.onkeydown = e => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    if (!busy) $('composer').requestSubmit();
  }
};

promptBox.oninput = () => {
  promptBox.style.height = 'auto';
  promptBox.style.height = Math.min(promptBox.scrollHeight, 200) + 'px';
};

promptBox.addEventListener('paste', async e => {
  const items = [...(e.clipboardData?.items || [])];
  const imageFiles = items
    .filter(item => item.kind === 'file' && item.type.startsWith('image/'))
    .map(item => item.getAsFile())
    .filter(Boolean);
  if (imageFiles.length) {
    e.preventDefault();
    await addBrowserFiles(imageFiles);
    toast(`Attached ${imageFiles.length} image(s) from clipboard.`);
  }
});

const composerEl = $('composer');
composerEl.addEventListener('dragover', e => {
  e.preventDefault();
  composerEl.classList.add('drag-over');
});
composerEl.addEventListener('dragleave', () => {
  composerEl.classList.remove('drag-over');
});
composerEl.addEventListener('drop', async e => {
  e.preventDefault();
  composerEl.classList.remove('drag-over');
  if (e.dataTransfer?.files?.length) {
    await addBrowserFiles(e.dataTransfer.files);
  }
});

$('composer-attach').onclick = () => $('file-picker').click();
$('file-picker').onchange = async e => {
  if (e.target.files?.length) {
    await addBrowserFiles(e.target.files);
    e.target.value = '';
  }
};

$('sidebar-open').onclick = () => $('sidebar').classList.toggle('collapsed');
$('sidebar-close').onclick = () => $('sidebar').classList.add('collapsed');
$('open-project').onclick = openProject;
$('composer-project').onclick = openProject;
$('nav-projects').onclick = openProject;
$('mode-project-btn').onclick = openProject;
$('welcome-project').onclick = openProject;
$('edit-workspace-btn').onclick = openWorkspaceModal;
$('refresh-workspace').onclick = () => {
  if (settings.workspaceRoot) loadWorkspace(settings.workspaceRoot, false);
  else openWorkspaceModal();
};

$('clear-chats').onclick = () => {
  if (busy) {
    toast('Stop the running agent first.');
    return;
  }
  if (chats.length && confirm('Delete all local conversations?')) {
    chats = [];
    currentId = null;
    persist();
    render();
  }
};

$('search-button').onclick = () => toggleSearch();
$('sidebar-search').oninput = e => {
  searchQuery = e.target.value;
  $('clear-search').hidden = !searchQuery;
  renderHistory();
};
$('clear-search').onclick = () => {
  searchQuery = '';
  $('sidebar-search').value = '';
  $('clear-search').hidden = true;
  renderHistory();
  $('sidebar-search').focus();
};
$('sidebar-search').onkeydown = e => {
  if (e.key === 'Escape') {
    e.stopPropagation();
    toggleSearch(false);
  }
};

document.querySelectorAll('[data-prompt]').forEach(b => {
  b.onclick = () => {
    promptBox.value = b.dataset.prompt;
    promptBox.focus();
  };
});

document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    newChat();
  }
  if (e.key === 'Escape') {
    if (!imageModal.hidden) closeImageLightbox();
    else if (!workspaceModal.hidden) closeWorkspaceModal();
    else if (!modal.hidden) closeSettings();
  }
});

if (innerWidth <= 760) $('sidebar').classList.add('collapsed');
render();
if (settings.model) loadModels();
if (settings.workspaceRoot) loadWorkspace(settings.workspaceRoot, true);
