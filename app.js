const $ = id => document.getElementById(id);
const defaults = { baseUrl: 'http://localhost:20128/v1', apiKey: '', router: '9router', model: '' };
let settings = { ...defaults, ...readStore('openqoder-settings', {}) };
let chats = readStore('openqoder-chats', []);
if (!Array.isArray(chats)) chats = [];
let currentId = null;
let busy = false;
let selectedFile = null;
let projectHandle = null;
let searchQuery = '';
let routerConnected = false;

const modal = $('settings-modal');
const promptBox = $('prompt');
const modelSelect = $('model-select');

function readStore(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

function persist() {
  try {
    localStorage.setItem('openqoder-chats', JSON.stringify(chats));
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

function updateStatusBar() {
  const folderEl = $('footer-folder');
  const routerEl = $('footer-router');
  const meterEl = $('footer-meter');
  const meterTextEl = $('footer-meter-text');

  if (folderEl) {
    folderEl.textContent = projectHandle ? projectHandle.name : 'No folder open';
  }
  if (routerEl) {
    let portSuffix = '';
    try {
      const parsed = new URL(settings.baseUrl);
      if (parsed.port) portSuffix = ` · :${parsed.port}`;
    } catch {
      // Ignore invalid URL while typing
    }
    routerEl.textContent = `${routerDisplayName(settings.router)}${portSuffix}`;
  }
  if (meterEl && meterTextEl) {
    meterEl.classList.toggle('connected', routerConnected);
    meterTextEl.textContent = routerConnected ? 'Connected' : 'Offline';
  }
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
        toast('Wait for the response to finish.');
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
  const lines = rawText.split(/\r?\n/);
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

  for (const rawLine of lines) {
    const line = rawLine;
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
    segments.push({
      type: 'code',
      lang: openMatch[1].trim(),
      code: openMatch[2]
    });
  } else if (tail) {
    segments.push({ type: 'text', value: tail });
  }

  return segments;
}

function renderDocCard(filePath) {
  const cleanName = filePath.split('/').pop() || filePath;
  const extMatch = cleanName.match(/\.([a-zA-Z0-9]+)$/);
  const extLabel = extMatch ? `${extMatch[1].toUpperCase()} · ${filePath}` : filePath;
  return `<div class="qoder-doc-card"><div class="qoder-doc-icon"><svg><use href="#i-file-doc"/></svg></div><div class="qoder-doc-info"><div class="qoder-doc-name">${escapeHTML(cleanName)}</div><div class="qoder-doc-ext">${escapeHTML(extLabel)}</div></div></div>`;
}

function renderBody(text, isUser, codeBlocksOut) {
  if (isUser) {
    const marker = '\n\n📎 ';
    const idx = String(text).lastIndexOf(marker);
    if (idx !== -1) {
      const promptPart = String(text).slice(0, idx);
      const filePart = String(text).slice(idx + marker.length).trim();
      return `${renderProse(promptPart)}${renderDocCard(filePart)}`;
    }
    return renderProse(text);
  }

  const segments = splitCodeFences(text);
  return segments.map(segment => {
    if (segment.type === 'text') {
      return renderProse(segment.value);
    }
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

function messageNode(message) {
  const el = document.createElement('article');
  el.className = 'message ' + message.role;
  const isUser = message.role === 'user';
  const codeBlocks = [];
  const bodyHTML = renderBody(message.display || message.content || '', isUser, codeBlocks);

  el.innerHTML = `<div class="avatar">${isUser ? 'You' : '<svg><use href="#i-logo"/></svg>'}</div>
    <div class="message-content">
      <div class="message-meta">${isUser ? 'You' : 'OpenQoder'}</div>
      <div class="message-body">${bodyHTML}</div>
      ${!isUser ? '<div class="message-tools"><button type="button" class="copy-message"><svg><use href="#i-copy"/></svg> Copy</button><button type="button" class="save-code"><svg><use href="#i-save"/></svg> Save first code block</button></div>' : ''}
    </div>`;

  if (!isUser) {
    el.querySelector('.copy-message').onclick = async () => {
      try {
        await navigator.clipboard.writeText(message.content);
        toast('Response copied.');
      } catch {
        toast('Could not copy to clipboard.');
      }
    };
    el.querySelector('.save-code').onclick = () => saveCode(message.content);

    el.querySelectorAll('[data-copy-code]').forEach(btn => {
      btn.onclick = async () => {
        const block = codeBlocks[Number(btn.dataset.copyCode)];
        if (!block) return;
        try {
          await navigator.clipboard.writeText(block.code);
          toast('Code block copied.');
        } catch {
          toast('Could not copy to clipboard.');
        }
      };
    });

    el.querySelectorAll('[data-save-code]').forEach(btn => {
      btn.onclick = () => {
        const block = codeBlocks[Number(btn.dataset.saveCode)];
        if (!block) return;
        const ext = block.lang && /^[a-z0-9]+$/i.test(block.lang) ? block.lang.toLowerCase() : 'txt';
        saveCodeBlock(block.code, `openqoder-snippet.${ext}`);
      };
    });
  }
  return el;
}

function render() {
  const chat = current();
  $('conversation-title').textContent = titleOf(chat);
  const hasMessages = !!chat?.messages?.length;
  $('welcome').hidden = hasMessages;
  $('suggestions').hidden = hasMessages;
  $('new-chat').classList.toggle('active', !hasMessages);

  const container = $('messages');
  container.replaceChildren();
  (chat?.messages || []).forEach(m => container.append(messageNode(m)));
  renderHistory();
  updateStatusBar();
  requestAnimationFrame(() => {
    $('main-scroll').scrollTop = $('main-scroll').scrollHeight;
  });
}

function newChat() {
  if (busy) {
    toast('Wait for the response to finish.');
    return;
  }
  currentId = null;
  selectedFile = null;
  renderAttachment();
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

async function sendMessage(event) {
  event.preventDefault();
  const text = promptBox.value.trim();
  if (!text || busy) return;
  if (!modelSelect.value) {
    toast('Connect your router and select a model first.');
    openSettings();
    return;
  }

  let fileContent = '';
  if (selectedFile) {
    try {
      const file = await selectedFile.handle.getFile();
      if (file.size > 200000) {
        toast('Please choose a file under 200 KB.');
        return;
      }
      fileContent = `\n\nAttached file: ${selectedFile.path}\n\`\`\`\n${await file.text()}\n\`\`\``;
    } catch {
      toast('Could not read the selected file. Reopen the project folder.');
      return;
    }
  }

  if (!current()) {
    currentId = crypto.randomUUID();
    chats.unshift({ id: currentId, title: text.slice(0, 55), messages: [] });
  }

  const chat = current();
  chat.messages.push({
    role: 'user',
    content: text + fileContent,
    display: text + (selectedFile ? `\n\n📎 ${selectedFile.path}` : '')
  });

  promptBox.value = '';
  promptBox.style.height = '';
  selectedFile = null;
  renderAttachment();
  busy = true;
  $('send-button').disabled = true;
  render();

  const assistant = { role: 'assistant', content: '' };
  chat.messages.push(assistant);
  render();

  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        baseUrl: settings.baseUrl,
        apiKey: settings.apiKey,
        model: modelSelect.value,
        messages: chat.messages.filter(m => m.content).map(({ role, content }) => ({ role, content })),
        stream: true
      })
    });

    if (!response.ok) {
      let data;
      try { data = await response.json(); } catch {}
      throw new Error(errorText(data, `Router returned HTTP ${response.status}.`));
    }

    const type = response.headers.get('content-type') || '';
    if (type.includes('text/event-stream')) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
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
            const delta = chunk.choices?.[0]?.delta?.content;
            if (typeof delta === 'string') assistant.content += delta;
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
      assistant.content = data.choices?.[0]?.message?.content || '';
    }

    if (!assistant.content) throw new Error('The router returned an empty response.');
    persist();
  } catch (err) {
    chat.messages.pop();
    persist();
    toast(err.message || 'Could not get a response.');
  } finally {
    busy = false;
    $('send-button').disabled = false;
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
  const matches = [...content.matchAll(/```[^\n`]*\r?\n([\s\S]*?)```/g)];
  const code = matches[0]?.[1];
  if (!code) {
    toast('No fenced code block was found in this response.');
    return;
  }
  await saveCodeBlock(code, 'openqoder-code.txt');
}

async function openProject() {
  if (!window.showDirectoryPicker) {
    toast('Project folders require Chrome or Edge on a local connection.');
    return;
  }
  try {
    projectHandle = await window.showDirectoryPicker({ mode: 'read' });
    selectedFile = null;
    renderAttachment();
    $('open-project').innerHTML = `<svg><use href="#i-folder"/></svg><span class="project-label">${escapeHTML(projectHandle.name)}</span>`;
    $('file-list').replaceChildren();
    updateStatusBar();

    let count = 0;
    async function walk(dir, prefix, depth) {
      for await (const [name, handle] of dir.entries()) {
        if (name.startsWith('.') || ['node_modules', 'dist', 'build', '__pycache__'].includes(name)) continue;
        const path = prefix + name;
        if (handle.kind === 'directory' && depth < 3) {
          await walk(handle, path + '/', depth + 1);
        } else if (handle.kind === 'file' && count < 150) {
          count++;
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'file-item';
          button.textContent = path;
          button.title = path;
          button.onclick = () => {
            selectedFile = { handle, path };
            document.querySelectorAll('.file-item').forEach(x => x.classList.remove('selected'));
            button.classList.add('selected');
            renderAttachment();
            promptBox.focus();
          };
          $('file-list').append(button);
        }
      }
    }

    await walk(projectHandle, '', 0);
    if (!count) toast('No files found in this folder.');
  } catch (err) {
    if (err.name !== 'AbortError') toast('Could not open that folder.');
  }
}

function renderAttachment() {
  $('attachment').hidden = !selectedFile;
  $('attachment-name').textContent = selectedFile ? selectedFile.path : '';
  if (!selectedFile) {
    document.querySelectorAll('.file-item').forEach(x => x.classList.remove('selected'));
  }
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

$('new-chat').onclick = newChat;
$('settings-button').onclick = openSettings;
$('top-settings').onclick = openSettings;
$('welcome-connect').onclick = openSettings;
$('close-settings').onclick = closeSettings;
$('cancel-settings').onclick = closeSettings;
modal.onclick = e => {
  if (e.target === modal) closeSettings();
};

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

$('refresh-models').onclick = loadModels;
$('composer').onsubmit = sendMessage;

promptBox.onkeydown = e => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    $('composer').requestSubmit();
  }
};

promptBox.oninput = () => {
  promptBox.style.height = 'auto';
  promptBox.style.height = Math.min(promptBox.scrollHeight, 200) + 'px';
};

$('sidebar-open').onclick = () => $('sidebar').classList.toggle('collapsed');
$('sidebar-close').onclick = () => $('sidebar').classList.add('collapsed');
$('open-project').onclick = openProject;
$('composer-project').onclick = openProject;
$('nav-projects').onclick = openProject;
$('mode-project-btn').onclick = openProject;
$('welcome-project').onclick = openProject;
$('remove-attachment').onclick = () => {
  selectedFile = null;
  renderAttachment();
};

$('clear-chats').onclick = () => {
  if (busy) {
    toast('Wait for the response to finish.');
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
  if (e.key === 'Escape' && !modal.hidden) closeSettings();
});

if (innerWidth <= 760) $('sidebar').classList.add('collapsed');
render();
if (settings.model) loadModels();
