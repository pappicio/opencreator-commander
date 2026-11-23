(() => {
  const $ = (id) => document.getElementById(id);
  const state = { path: '/usr/data/opencreator/', history: [], terminals: [], activeTerminal: null, editPath: null, editProtected: false, warnedProgramDir: false, selectedItem: null };
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
      login.classList.add('hidden'); app.classList.remove('hidden'); await loadDirectory('/usr/data/opencreator/');
      await loadUiSettings();
    } catch (error) { $('login-error').textContent = error.message || 'Unable to connect'; }
  });
  $('logout').addEventListener('click', async () => {
    try { await fetch('/api/logout', {method:'POST', credentials:'same-origin'}); } catch (_) {}
    lockApp();
  });
  restoreSavedCredentials();

  // Restore an existing authenticated session after page reload.
  (async function restoreSession() {
    try {
      await api('/api/session');
      login.classList.add('hidden');
      app.classList.remove('hidden');
      await loadDirectory('/usr/data/opencreator/');
      await loadUiSettings();
    } catch (error) {
      app.classList.add('hidden');
      login.classList.remove('hidden');
    }
  })();

  // Persistent editor window: position and size are stored on the printer.
  const editorCard = document.querySelector('.modal-card');
  let editorGeometry = null;
  let editorPointer = null;

  function clampEditorGeometry(g) {
    const vw = window.innerWidth, vh = window.innerHeight;
    const width = Math.max(420, Math.min(Math.round(g.width), vw - 24));
    const height = Math.max(300, Math.min(Math.round(g.height), vh - 24));
    return {
      width, height,
      x: Math.max(0, Math.min(Math.round(g.x), vw - width)),
      y: Math.max(0, Math.min(Math.round(g.y), vh - height))
    };
  }

  function applyEditorGeometry(g) {
    editorGeometry = clampEditorGeometry(g);
    Object.assign(editorCard.style, {
      left: editorGeometry.x + 'px',
      top: editorGeometry.y + 'px',
      width: editorGeometry.width + 'px',
      height: editorGeometry.height + 'px'
    });
  }

  async function prepareEditorWindow() {
    if (!editorGeometry) {
      try {
        const result = await api('/api/editor-window');
        editorGeometry = result.geometry;
      } catch (_) {}
    }

    if (!editorGeometry) {
      const width = Math.min(1000, window.innerWidth - 40);
      const height = Math.min(760, window.innerHeight - 40);
      editorGeometry = {
        x: Math.round((window.innerWidth - width) / 2),
        y: Math.round((window.innerHeight - height) / 2),
        width, height
      };
    }
    applyEditorGeometry(editorGeometry);
  }

  async function saveEditorWindow() {
    try {
      await api('/api/editor-window', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({geometry: editorGeometry})
      });
    } catch (error) {
      toast('Unable to save editor window settings: ' + error.message, true);
    }
  }

  // Eight resize handles: four edges and four corners.
  ['n','s','e','w','ne','nw','se','sw'].forEach(edge => {
    const handle = document.createElement('div');
    handle.className = 'editor-resize ' + edge;
    handle.dataset.edge = edge;
    editorCard.append(handle);
  });

  editorCard.addEventListener('pointerdown', event => {
    const handle = event.target.closest('.editor-resize');
    const header = event.target.closest('.modal-head');

    if (handle) {
      event.preventDefault();
      event.stopPropagation();
      editorPointer = {
        mode: 'resize',
        edge: handle.dataset.edge,
        startX: event.clientX,
        startY: event.clientY,
        geometry: {...editorGeometry}
      };
    } else if (header && !event.target.closest('button')) {
      event.preventDefault();
      editorPointer = {
        mode: 'move',
        startX: event.clientX,
        startY: event.clientY,
        geometry: {...editorGeometry}
      };
    } else {
      return;
    }
    editorCard.setPointerCapture(event.pointerId);
  });

  editorCard.addEventListener('pointermove', event => {
    if (!editorPointer) return;
    const p = editorPointer;
    const dx = event.clientX - p.startX;
    const dy = event.clientY - p.startY;
    const g = {...p.geometry};

    if (p.mode === 'move') {
      g.x += dx;
      g.y += dy;
    } else {
      const edge = p.edge;
      if (edge.includes('e')) g.width += dx;
      if (edge.includes('s')) g.height += dy;
      if (edge.includes('w')) {
        g.width -= dx;
        g.x += dx;
      }
      if (edge.includes('n')) {
        g.height -= dy;
        g.y += dy;
      }
      if (g.width < 420) {
        if (edge.includes('w')) g.x -= 420 - g.width;
        g.width = 420;
      }
      if (g.height < 300) {
        if (edge.includes('n')) g.y -= 300 - g.height;
        g.height = 300;
      }
    }
    applyEditorGeometry(g);
  });

  editorCard.addEventListener('pointerup', () => {
    if (!editorPointer) return;
    editorPointer = null;
    saveEditorWindow();
  });
  editorCard.addEventListener('pointercancel', () => {
    if (!editorPointer) return;
    editorPointer = null;
    saveEditorWindow();
  });

  window.addEventListener('resize', () => {
    if (!$('modal').classList.contains('hidden') && editorGeometry) {
      applyEditorGeometry(editorGeometry);
    }
  });

  const DEFAULT_UI_SETTINGS = {
    color_rw: '#91a0b2',
    color_ro: '#ffb15c',
    color_system: '#ff9f43',
    font_base: 16,
    font_labels: 14,
    font_buttons: 16
  };
  let uiSettings = {...DEFAULT_UI_SETTINGS};

  function applyUiSettings(settings) {
    const root = document.documentElement;
    root.style.setProperty('--oc-color-rw', settings.color_rw);
    root.style.setProperty('--oc-color-ro', settings.color_ro);
    root.style.setProperty('--oc-color-system', settings.color_system);
    root.style.setProperty('--oc-font-base', settings.font_base + 'px');
    root.style.setProperty('--oc-font-labels', settings.font_labels + 'px');
    root.style.setProperty('--oc-font-buttons', settings.font_buttons + 'px');
  }

  function readSettingsControls() {
    return {
      color_rw: $('setting-color-rw').value,
      color_ro: $('setting-color-ro').value,
      color_system: $('setting-color-system').value,
      font_base: Number($('setting-font-base').value),
      font_labels: Number($('setting-font-labels').value),
      font_buttons: Number($('setting-font-buttons').value)
    };
  }

  function updateSettingsControls(settings) {
    $('setting-color-rw').value = settings.color_rw;
    $('setting-color-ro').value = settings.color_ro;
    $('setting-color-system').value = settings.color_system;
    $('setting-font-base').value = settings.font_base;
    $('setting-font-labels').value = settings.font_labels;
    $('setting-font-buttons').value = settings.font_buttons;
    ['base', 'labels', 'buttons'].forEach(key => {
      $('setting-font-' + key + '-value').textContent = settings['font_' + key] + ' px';
    });
    applyUiSettings(settings);
  }

  async function loadUiSettings() {
    try {
      const data = await api('/api/settings');
      uiSettings = {...DEFAULT_UI_SETTINGS, ...(data.settings || {})};
    } catch (error) {
      uiSettings = {...DEFAULT_UI_SETTINGS};
      toast('Unable to load settings: ' + error.message, true);
    }
    updateSettingsControls(uiSettings);
    $('settings-status').textContent = 'Saved settings loaded';
  }

  ['color-rw', 'color-ro', 'color-system', 'font-base', 'font-labels', 'font-buttons'].forEach(id => {
    $('setting-' + id).addEventListener('input', () => {
      const current = readSettingsControls();
      ['base', 'labels', 'buttons'].forEach(key => {
        $('setting-font-' + key + '-value').textContent = current['font_' + key] + ' px';
      });
      applyUiSettings(current);
      $('settings-status').textContent = 'Unsaved changes';
    });
  });

  $('settings-save').addEventListener('click', async () => {
    const settings = readSettingsControls();
    try {
      const result = await api('/api/settings', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(settings)
      });
      uiSettings = {...DEFAULT_UI_SETTINGS, ...(result.settings || settings)};
      updateSettingsControls(uiSettings);
      $('settings-status').textContent = 'Settings saved';
      toast('Settings saved');
    } catch (error) {
      toast('Unable to save settings: ' + error.message, true);
    }
  });

  $('settings-reset').addEventListener('click', () => {
    updateSettingsControls({...DEFAULT_UI_SETTINGS});
    $('settings-status').textContent = 'Default values — not saved';
  });

  document.querySelectorAll('.main-tab').forEach(button => button.addEventListener('click', () => {
    document.querySelectorAll('.main-tab').forEach(b => b.classList.toggle('active', b === button));
    $('explorer-view').classList.toggle('hidden', button.dataset.view !== 'explorer');
    $('terminal-view').classList.toggle('hidden', button.dataset.view !== 'terminal');
    $('settings-view').classList.toggle('hidden', button.dataset.view !== 'settings');
    if (button.dataset.view === 'terminal' && !state.terminals.length) createTerminal();
    if (button.dataset.view === 'terminal') fitActiveTerminal();
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
      const normalizedPath = String(data.path || path).replace(/\/+$/, '') || '/';
      if (normalizedPath === '/usr/prog' && !state.warnedProgramDir) {
        state.warnedProgramDir = true;
        alert('SYSTEM PROTECTION: /usr/prog contains critical printer startup files. This directory is permanently read-only in OpenCreator Commander.');
      }
      state.path = data.path;
      state.selectedItem = null;
      updateProtectionToolbar();
      hideProtectionMenu();
      const currentProtection = data.protection || {protected:false};
      $('path').value = data.path; renderBreadcrumbs(data.path);
      $('new-folder').disabled = !!currentProtection.protected;
      $('upload').disabled = !!currentProtection.protected;
      $('file-count').textContent = data.items.length + ' items';
      $('current-status').textContent = data.path + (currentProtection.protected ? ' · Read-only protected' : '');
      const body = $('file-list'); body.replaceChildren();
      if (!data.items.length) { const row = document.createElement('tr'); row.innerHTML = '<td colspan="6" class="empty">This folder is empty</td>'; body.append(row); }
      data.items.forEach(item => body.append(makeFileRow(item)));
    } catch (error) { toast(error.message, true); }
  }
  function makeFileRow(item) {
    const row = document.createElement('tr');

    if (item.path === '/usr/prog' && item.type === 'directory') {
      row.classList.add('caution-row');
    }

    if (item.permanent) row.classList.add('permanent-protected-row');
    else if (item.system) row.classList.add('system-protected-row');
    else if (item.protected) row.classList.add('protected-row');

    const nameCell = document.createElement('td');
    const nameWrap = document.createElement('div');
    nameWrap.className = 'file-name';

    const icon = document.createElement('span');
    icon.className = 'file-icon';
    icon.textContent = item.type === 'directory' ? '▰' : item.type === 'symlink' ? '↗' : '▤';

    const status = document.createElement('span');
    status.className = 'protection-badge ' + (
      item.permanent ? 'badge-system' :
      item.protected ? 'badge-ro' : 'badge-rw'
    );
    status.textContent = item.protected ? 'RO' : 'RW';
    status.title = item.permanent
      ? 'Permanently protected system file'
      : item.system
        ? 'System-protected location'
        : item.custom_root
          ? 'Custom read-only protection'
          : item.protected
            ? 'Read-only protection inherited from a parent'
            : 'Writable in Commander';

    const name = document.createElement('button');
    name.textContent = item.name;
    name.title = item.path;

    name.addEventListener('dblclick', () =>
      item.type === 'directory'
        ? navigate(item.path)
        : openEditor(item.path, !!item.protected)
    );

    name.addEventListener('click', () => {
      document.querySelectorAll('.file-table tr.selected').forEach(r => r.classList.remove('selected'));
      row.classList.add('selected');
      state.selectedItem = item;
      updateProtectionToolbar();
    });

    nameWrap.append(icon, status, name);
    nameCell.append(nameWrap);

    const type = document.createElement('td');
    type.className = 'muted';
    type.textContent = item.type;

    const size = document.createElement('td');
    size.className = 'muted';
    size.textContent = item.type === 'directory' ? '—' : formatSize(item.size);

    const date = document.createElement('td');
    date.className = 'muted';
    date.textContent = formatDate(item.mtime);

    const mode = document.createElement('td');
    mode.className = 'muted';
    mode.textContent = item.mode;

    const actions = document.createElement('td');
    const actionWrap = document.createElement('div');
    actionWrap.className = 'file-actions';

    if (item.type === 'directory') addAction(actionWrap, 'Open', () => navigate(item.path));
    else {
      if (!item.protected) addAction(actionWrap, 'Edit', () => openEditor(item.path, false));
      addAction(actionWrap, 'Download', () => downloadFile(item.path));
    }

    if (!item.protected) {
      addAction(actionWrap, 'Rename', () => renameItem(item.path, item.name));
      addAction(actionWrap, 'Delete', () => deleteItem(item.path, item.name, item.type));
    }

    if (!item.system && !item.permanent) {
      if (item.custom_root) addAction(actionWrap, 'Remove protection', () => changeProtection(item.path, false));
      else if (!item.protected) addAction(actionWrap, 'Protect', () => changeProtection(item.path, true));
    }

    actions.append(actionWrap);
    row.append(nameCell, type, size, date, mode, actions);

    row.addEventListener('contextmenu', event => {
      event.preventDefault();
      document.querySelectorAll('.file-table tr.selected').forEach(r => r.classList.remove('selected'));
      row.classList.add('selected');
      state.selectedItem = item;
      updateProtectionToolbar();
      showProtectionMenu(item, event.clientX, event.clientY);
    });

    return row;
  }

  function addAction(parent, label, callback) { const button = document.createElement('button'); button.textContent = label; button.addEventListener('click', callback); parent.append(button); }
  function updateProtectionToolbar() {
    const button = $('protect-selected');
    if (!button) return;

    const item = state.selectedItem;
    if (!item) {
      button.disabled = true;
      button.textContent = 'RO Protect';
      button.title = 'Select a file or folder';
      return;
    }

    if (item.system || item.permanent) {
      button.disabled = true;
      button.textContent = 'RO System';
      button.title = 'System protection cannot be removed';
    } else if (item.custom_root) {
      button.disabled = false;
      button.textContent = 'RO Remove';
      button.title = 'Remove custom read-only protection';
    } else if (item.protected) {
      button.disabled = true;
      button.textContent = 'RO Inherited';
      button.title = 'Protection is inherited from a parent folder';
    } else {
      button.disabled = false;
      button.textContent = 'RO Protect';
      button.title = 'Protect selected file or folder';
    }
  }

  function hideProtectionMenu() {
    const menu = $('protection-menu');
    if (menu) menu.classList.add('hidden');
  }

  function showProtectionMenu(item, x, y) {
    const menu = $('protection-menu');
    menu.replaceChildren();

    let label = 'Protect read-only';
    let enabled = true;
    let enableProtection = true;

    if (item.system || item.permanent) {
      label = 'System protected';
      enabled = false;
      enableProtection = false;
    } else if (item.custom_root) {
      label = 'Remove read-only protection';
      enableProtection = false;
    } else if (item.protected) {
      label = 'Read-only (inherited)';
      enabled = false;
      enableProtection = false;
    }

    const button = document.createElement('button');
    button.textContent = label;
    button.disabled = !enabled;
    button.addEventListener('click', () => {
      hideProtectionMenu();
      changeProtection(item.path, enableProtection);
    });

    menu.append(button);
    menu.classList.remove('hidden');

    const left = Math.max(8, Math.min(x, window.innerWidth - menu.offsetWidth - 8));
    const top = Math.max(8, Math.min(y, window.innerHeight - menu.offsetHeight - 8));
    menu.style.left = left + 'px';
    menu.style.top = top + 'px';
  }

  $('protect-selected').addEventListener('click', () => {
    const item = state.selectedItem;
    if (!item || item.system || item.permanent) return;
    if (item.protected && !item.custom_root) return;
    changeProtection(item.path, !item.custom_root);
  });

  document.addEventListener('click', event => {
    if (!event.target.closest('#protection-menu')) hideProtectionMenu();
  });

  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') hideProtectionMenu();
  });

  async function changeProtection(path, enabled) {
    const action = enabled ? 'protect' : 'unprotect';
    const promptText = enabled
      ? 'Protect this item and all its contents as read-only in Commander?'
      : 'Remove the custom protection from this item?';
    if (!confirm(promptText)) return;
    try {
      await api('/api/fs/' + action, {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({path})
      });
      toast(enabled ? 'Protection enabled' : 'Protection removed');
      await loadDirectory(state.path);
    } catch (error) { toast(error.message, true); }
  }
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
  async function deleteItem(path, name, type) {
    const isDirectory = type === 'directory';

    const message = isDirectory
      ? 'WARNING: You are about to PERMANENTLY DELETE the folder "' + name + '" and ALL its contents, including every subfolder and file.\\n\\nThis operation is UNRECOVERABLE and CANNOT BE UNDONE.\\n\\nAre you absolutely sure?'
      : 'WARNING: You are about to PERMANENTLY DELETE the file "' + name + '".\\n\\nThis operation is UNRECOVERABLE and CANNOT BE UNDONE.\\n\\nAre you absolutely sure?';

    if (!confirm(message)) return;

    try {
      await api('/api/fs/delete', {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({path})
      });
      await loadDirectory(state.path);
    } catch (error) {
      toast(error.message, true);
    }
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

  async function openEditor(path, protectedFile = false) {
    try {
      const data = await api('/api/fs/read?path=' + encodeURIComponent(path));
      const protection = data.protection || {};
      const normalizedPath = String(data.path || path).replace(/\/+$/, '');
      const permanent = !!protection.permanent || normalizedPath === '/usr/prog/app_startup.sh';
      const isProtected = permanent || protectedFile || !!protection.protected;

      state.editPath = data.path || path;
      state.editProtected = isProtected;

      if (permanent) {
        alert('PERMANENT SYSTEM PROTECTION: app_startup.sh is a critical printer startup file. It can only be viewed, never modified through Commander.');
      }

      $('modal-title').textContent = permanent
        ? (data.path || path) + ' · READ ONLY · SYSTEM FILE'
        : (data.path || path) + (isProtected ? ' · READ ONLY' : '');
      $('editor').value = data.content;
      $('editor').readOnly = isProtected;
      $('save-file').disabled = isProtected;
      $('editor-status').textContent = permanent
        ? 'READ ONLY · SYSTEM FILE'
        : isProtected ? 'Read-only protected file' : 'UTF-8 · 2 MB limit';
      await prepareEditorWindow();
      $('modal').classList.remove('hidden');
    } catch (error) { toast(error.message, true); }
  }
  $('modal-close').addEventListener('click', () => {
    $('modal').classList.add('hidden');
    $('editor').readOnly = false;
    $('save-file').disabled = false;
    state.editPath = null; state.editProtected = false;
  });
  $('save-file').addEventListener('click', async () => {
    if (!state.editPath || state.editProtected) return;
    try { await api('/api/fs/write?path=' + encodeURIComponent(state.editPath), {method:'PUT',headers:{'Content-Type':'text/plain; charset=utf-8'},body:$('editor').value}); $('editor-status').textContent = 'Saved'; toast('File saved'); await loadDirectory(state.path); }
    catch (error) { $('editor-status').textContent = error.message; toast(error.message, true); }
  });

  function createTerminal() {
    if (typeof window.Terminal !== 'function') { toast('Terminal library could not load. Check browser internet access.', true); return; }
    const id = 'term-' + Date.now() + '-' + Math.floor(Math.random() * 10000);
    const terminal = new window.Terminal({cursorBlink:true,convertEol:true,scrollback:5000,fontFamily:'Consolas, "Liberation Mono", monospace',fontSize:15,theme:{background:'#090d12',foreground:'#d7e0ea',cursor:'#e7edf5',green:'#50d890',blue:'#6aaeff'}});
    const pane = document.createElement('div'); pane.className = 'terminal-pane'; pane.id = id;
    $('terminal-host').append(pane); terminal.open(pane);
    pane.addEventListener('mousedown', () => terminal.focus());
    pane.addEventListener('click', () => terminal.focus());
    const tab = document.createElement('button'); tab.className = 'terminal-tab'; tab.innerHTML = 'SSH <span class="close">×</span>';
    tab.addEventListener('click', e => { if (e.target.classList.contains('close')) { closeTerminal(id); return; } activateTerminal(id); });
    $('terminal-tabs').append(tab);
    const wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(wsProto + '//' + location.host + '/ws/terminal?cwd=' + encodeURIComponent(state.path)); ws.binaryType = 'arraybuffer';
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
    const active = state.terminals.find(t => t.id === id);
    if (active) {
      active.term.focus();
      sendResize(active);
    }
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
  if ($('username').value.trim()) {
    $('password').focus();
  } else {
    $('username').focus();
  }
})();
