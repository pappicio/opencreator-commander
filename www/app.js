(() => {
  const $ = (id) => document.getElementById(id);
  const state = { path: '/', history: [], terminals: [], activeTerminal: null, editPath: null };
  const login = $('login'), app = $('app');

  function toast(message, error = false) {
    const el = $('toast'); el.textContent = message; el.className = 'toast show' + (error ? ' error' : '');
    clearTimeout(toast.timer); toast.timer = setTimeout(() => el.className = 'toast', 2600);
  }
  async function api(url, options = {}) {
    const response = await fetch(url, { credentials: 'same-origin', ...options });
    const type = response.headers.get('content-type') || '';
    if (!response.ok) {
      let message = response.statusText;
      if (type.includes('application/json')) { const data = await response.json(); message = data.error || message; }
      if (response.status === 401) lockApp();
      throw new Error(message);
    }
    return type.includes('application/json') ? response.json() : response;
  }
  function lockApp() {
    state.terminals.forEach(t => { try { t.ws && t.ws.close(); } catch (_) {} });
    state.terminals = []; state.activeTerminal = null;
    app.classList.add('hidden'); login.classList.remove('hidden'); $('password').value = '';
  }
  function restoreSavedCredentials() {
    const username = localStorage.getItem('oc_commander_username') || '';
    const password = localStorage.getItem('oc_commander_password') || '';
    $('username').value = username;
    $('password').value = password;
    $('remember-username').checked = !!username || !!password;
    $('remember-password').checked = !!password;
  }
  $('remember-password').addEventListener('change', (event) => {
    if (event.target.checked) {
      if (!window.confirm("WARNING: The SSH password will be stored unencrypted in this browser local storage. Anyone with access to this browser profile may be able to read it. Continue?")) {
        event.target.checked = false;
        return;
      }
      $('remember-username').checked = true;
    }
  });
  $('remember-username').addEventListener('change', (event) => {
    if (!event.target.checked) $('remember-password').checked = false;
  });
  $('login-form').addEventListener('submit', async (event) => {
    event.preventDefault(); $('login-error').textContent = '';
    const username = $('username').value.trim(), password = $('password').value;
    try {
      await api('/api/login', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({username, password}) });
      if ($('remember-username').checked || $('remember-password').checked) localStorage.setItem('oc_commander_username', username);
      else localStorage.removeItem('oc_commander_username');
      if ($('remember-password').checked) localStorage.setItem('oc_commander_password', password);
      else localStorage.removeItem('oc_commander_password');
      login.classList.add('hidden'); app.classList.remove('hidden'); await loadDirectory('/');
    } catch (error) { $('login-error').textContent = error.message || 'Unable to connect'; }
  });
  $('logout').addEventListener('click', async () => {
    try { await fetch('/api/logout', {method:'POST', credentials:'same-origin'}); } catch (_) {}
    lockApp();
  });
  restoreSavedCredentials();

  document.querySelectorAll('.main-tab').forEach(button => button.addEventListener('click', () => {
    document.querySelectorAll('.main-tab').forEach(b => b.classList.toggle('active', b === button));
    $('explorer-view').classList.toggle('hidden', button.dataset.view !== 'explorer');
    $('terminal-view').classList.toggle('hidden', button.dataset.view !== 'terminal');
    if (button.dataset.view === 'terminal' && !state.terminals.length) createTerminal();
    fitActiveTerminal();
  }));

  function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    const units = ['KB','MB','GB','TB']; let value = bytes / 1024, i = 0;
    while (value >= 1024 && i < units.length - 1) { value /= 1024; i++; }
    return value.toFixed(value >= 10 ? 1 : 2) + ' ' + units[i];
  }
  function formatDate(timestamp) {
    if (!timestamp) return '—';
    try { return new Date(timestamp * 1000).toLocaleString(); } catch (_) { return '—'; }
  }
  function joinPath(base, name) { return (base === '/' ? '' : base.replace(/\/$/, '')) + '/' + name; }
  function renderBreadcrumbs(path) {
    const host = $('breadcrumbs'); host.replaceChildren();
    const parts = path.split('/').filter(Boolean); let current = '';
    const root = document.createElement('button'); root.textContent = '/'; root.addEventListener('click', () => navigate('/')); host.append(root);
    parts.forEach(part => {
      current += '/' + part; const target = current;
      const sep = document.createElement('span'); sep.textContent = '›'; sep.className = 'muted'; host.append(sep);
      const button = document.createElement('button'); button.textContent = part; button.addEventListener('click', () => navigate(target)); host.append(button);
    });
  }
  async function navigate(path) {
    if (path !== state.path) state.history.push(state.path);
    await loadDirectory(path);
  }
  async function loadDirectory(path) {
    try {
      const data = await api('/api/fs/list?path=' + encodeURIComponent(path));
      state.path = data.path; $('path').value = data.path; renderBreadcrumbs(data.path);
      $('file-count').textContent = data.items.length + ' items'; $('current-status').textContent = data.path;
      const body = $('file-list'); body.replaceChildren();
      if (!data.items.length) { const row = document.createElement('tr'); row.innerHTML = '<td colspan="6" class="empty">This folder is empty</td>'; body.append(row); }
      data.items.forEach(item => body.append(makeFileRow(item)));
    } catch (error) { toast(error.message, true); }
  }
  function makeFileRow(item) {
    const row = document.createElement('tr');
    const nameCell = document.createElement('td'); const nameWrap = document.createElement('div'); nameWrap.className = 'file-name';
    const icon = document.createElement('span'); icon.className = 'file-icon'; icon.textContent = item.type === 'directory' ? '▰' : item.type === 'symlink' ? '↗' : '▤';
    const name = document.createElement('button'); name.textContent = item.name; name.title = item.path;
    name.addEventListener('dblclick', () => item.type === 'directory' ? navigate(item.path) : openEditor(item.path));
    name.addEventListener('click', () => { document.querySelectorAll('.file-table tr.selected').forEach(r => r.classList.remove('selected')); row.classList.add('selected'); });
    nameWrap.append(icon, name); nameCell.append(nameWrap);
    const type = document.createElement('td'); type.className = 'muted'; type.textContent = item.type;
    const size = document.createElement('td'); size.className = 'muted'; size.textContent = item.type === 'directory' ? '—' : formatSize(item.size);
    const date = document.createElement('td'); date.className = 'muted'; date.textContent = formatDate(item.mtime);
    const mode = document.createElement('td'); mode.className = 'muted'; mode.textContent = item.mode;
    const actions = document.createElement('td'); const actionWrap = document.createElement('div'); actionWrap.className = 'file-actions';
    if (item.type === 'directory') addAction(actionWrap, 'Open', () => navigate(item.path));
    else { addAction(actionWrap, 'Edit', () => openEditor(item.path)); addAction(actionWrap, 'Download', () => downloadFile(item.path)); }
    addAction(actionWrap, 'Rename', () => renameItem(item.path, item.name));
    addAction(actionWrap, 'Delete', () => deleteItem(item.path, item.name));
    actions.append(actionWrap); row.append(nameCell, type, size, date, mode, actions); return row;
  }
  function addAction(parent, label, callback) { const button = document.createElement('button'); button.textContent = label; button.addEventListener('click', callback); parent.append(button); }
  $('back').addEventListener('click', async () => { const previous = state.history.pop(); if (previous) await loadDirectory(previous); });
  $('up').addEventListener('click', () => navigate(state.path.replace(/\/$/, '').split('/').slice(0, -1).join('/') || '/'));
  $('refresh').addEventListener('click', () => loadDirectory(state.path));
  $('go-path').addEventListener('click', () => navigate($('path').value.trim() || '/'));
  $('path').addEventListener('keydown', e => { if (e.key === 'Enter') navigate($('path').value.trim() || '/'); });
  $('new-folder').addEventListener('click', async () => {
    const name = prompt('New folder name:'); if (!name) return;
    try { await api('/api/fs/mkdir', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({path:state.path,name})}); await loadDirectory(state.path); }
    catch (error) { toast(error.message, true); }
  });
  async function renameItem(path, oldName) {
    const name = prompt('Rename to:', oldName); if (!name || name === oldName) return;
    try { await api('/api/fs/rename', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path,name})}); await loadDirectory(state.path); }
    catch (error) { toast(error.message, true); }
  }
  async function deleteItem(path, name) {
    if (!confirm('Permanently delete "' + name + '"?')) return;
    try { await api('/api/fs/delete', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path})}); await loadDirectory(state.path); }
    catch (error) { toast(error.message, true); }
  }
  async function downloadFile(path) {
    try {
      const response = await api('/api/fs/download?path=' + encodeURIComponent(path));
      const blob = await response.blob(); const url = URL.createObjectURL(blob); const a = document.createElement('a');
      a.href = url; a.download = path.split('/').pop(); document.body.append(a); a.click(); a.remove(); URL.revokeObjectURL(url);
    } catch (error) { toast(error.message, true); }
  }
  $('upload').addEventListener('click', () => $('file-input').click());
  $('file-input').addEventListener('change', async e => { await uploadFiles(Array.from(e.target.files || [])); e.target.value = ''; });
  async function uploadFiles(files) {
    for (const file of files) {
      try {
        const existing = await api('/api/fs/list?path=' + encodeURIComponent(state.path));
        if (existing.items.some(item => item.name === file.name) && !confirm(file.name + ' already exists. Overwrite it?')) continue;
        await api('/api/fs/upload?dir=' + encodeURIComponent(state.path) + '&name=' + encodeURIComponent(file.name), {method:'PUT', body:file});
      } catch (error) { toast(file.name + ': ' + error.message, true); }
    }
    await loadDirectory(state.path); toast('Upload complete');
  }
  const dropZone = $('drop-zone');
  ['dragenter','dragover'].forEach(event => dropZone.addEventListener(event, e => { e.preventDefault(); dropZone.classList.add('dragging'); }));
  ['dragleave','drop'].forEach(event => dropZone.addEventListener(event, e => { e.preventDefault(); if (event === 'drop' || !dropZone.contains(e.relatedTarget)) dropZone.classList.remove('dragging'); }));
  dropZone.addEventListener('drop', e => uploadFiles(Array.from(e.dataTransfer.files || [])));

  async function openEditor(path) {
    try {
      const data = await api('/api/fs/read?path=' + encodeURIComponent(path)); state.editPath = path;
      $('modal-title').textContent = path; $('editor').value = data.content; $('editor-status').textContent = 'UTF-8 · 2 MB limit'; $('modal').classList.remove('hidden');
    } catch (error) { toast(error.message, true); }
  }
  $('modal-close').addEventListener('click', () => $('modal').classList.add('hidden'));
  $('save-file').addEventListener('click', async () => {
    if (!state.editPath) return;
    try { await api('/api/fs/write?path=' + encodeURIComponent(state.editPath), {method:'PUT',headers:{'Content-Type':'text/plain; charset=utf-8'},body:$('editor').value}); $('editor-status').textContent = 'Saved'; toast('File saved'); await loadDirectory(state.path); }
    catch (error) { $('editor-status').textContent = error.message; toast(error.message, true); }
  });

  function createTerminal() {
    if (typeof window.Terminal !== 'function') { toast('Terminal library could not load. Check browser internet access.', true); return; }
    const id = 'term-' + Date.now() + '-' + Math.floor(Math.random() * 10000);
    const terminal = new window.Terminal({cursorBlink:true,convertEol:true,scrollback:5000,fontFamily:'Consolas, "Liberation Mono", monospace',fontSize:13,theme:{background:'#090d12',foreground:'#d7e0ea',cursor:'#e7edf5',green:'#50d890',blue:'#6aaeff'}});
    const pane = document.createElement('div'); pane.className = 'terminal-pane'; pane.id = id;
    $('terminal-host').append(pane); terminal.open(pane);
    const tab = document.createElement('button'); tab.className = 'terminal-tab'; tab.innerHTML = 'SSH <span class="close">×</span>';
    tab.addEventListener('click', e => { if (e.target.classList.contains('close')) { closeTerminal(id); return; } activateTerminal(id); });
    $('terminal-tabs').append(tab);
    const wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(wsProto + '//' + location.host + '/ws/terminal'); ws.binaryType = 'arraybuffer';
    const entry = {id,term:terminal,pane,tab,ws}; state.terminals.push(entry); activateTerminal(id);
    ws.onopen = () => { $('terminal-status').textContent = 'Connected · local shell'; terminal.focus(); sendResize(entry); };
    ws.onmessage = event => terminal.write(typeof event.data === 'string' ? event.data : new Uint8Array(event.data));
    ws.onerror = () => $('terminal-status').textContent = 'Terminal connection error';
    ws.onclose = () => $('terminal-status').textContent = 'Terminal disconnected';
    terminal.onData(data => { if (ws.readyState === WebSocket.OPEN) ws.send(data); });
    terminal.onResize(() => sendResize(entry));
    terminal.writeln('\x1b[1;36mOpenCreator Commander\x1b[0m');
    terminal.writeln('Starting local shell...\r\n');
    return entry;
  }
  function sendResize(entry) { if (entry.ws.readyState === WebSocket.OPEN) entry.ws.send(JSON.stringify({type:'resize',cols:entry.term.cols,rows:entry.term.rows})); }
  function activateTerminal(id) {
    state.activeTerminal = id;
    state.terminals.forEach(t => { t.pane.classList.toggle('active',t.id===id); t.tab.classList.toggle('active',t.id===id); });
    const active = state.terminals.find(t => t.id === id); if (active) { active.term.focus(); sendResize(active); }
  }
  function closeTerminal(id) {
    const index = state.terminals.findIndex(t => t.id === id); if (index < 0) return;
    const item = state.terminals[index]; try { item.ws.close(); item.term.dispose(); } catch (_) {}
    item.pane.remove(); item.tab.remove(); state.terminals.splice(index,1);
    if (state.activeTerminal === id) { state.activeTerminal = null; if (state.terminals.length) activateTerminal(state.terminals[Math.max(0,index-1)].id); }
    if (!state.terminals.length) $('terminal-status').textContent = 'No active terminal';
  }
  function fitActiveTerminal() {
    const item = state.terminals.find(t => t.id === state.activeTerminal); if (!item) return;
    setTimeout(() => { try { item.term.refresh(0, item.term.rows - 1); sendResize(item); } catch (_) {} }, 60);
  }
  $('new-terminal').addEventListener('click', createTerminal);
  $('clear-terminal').addEventListener('click', () => { const item = state.terminals.find(t => t.id === state.activeTerminal); if (item) item.term.clear(); });
  window.addEventListener('resize', fitActiveTerminal);
  $('password').focus();
})();
