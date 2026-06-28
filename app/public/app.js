// State Management
let currentUser = null;
let currentFolderId = null;
let breadcrumbsHistory = [];
let isRegisterMode = false;
let allShares = []; // Alle Shares des Users
let selectedFileIds = [];
let renderedFilesList = [];
let lastSelectedId = null; // Für Shift-Auswahl
let viewMode = localStorage.getItem('viewMode') || 'grid';
let isEmailConfigured = false;


// DOM Elements
const authView = document.getElementById('auth-view');
const dashboardView = document.getElementById('dashboard-view');
const settingsView = document.getElementById('settings-view');
const appHeader = document.getElementById('app-header');

const toast = document.getElementById('toast');
const toastMessage = document.getElementById('toast-message');

/* ==========================================================================
   TOAST HELPER
   ========================================================================== */
function showToast(message) {
  toastMessage.textContent = message;
  toast.classList.add('show');
  setTimeout(() => {
    toast.classList.remove('show');
  }, 3500);
}

// Global variable for Domain URL configuration
let appBrandingUrl = '';

// Custom input dialog helper using the web modal
function showInputPrompt(title, label, defaultValue = '', placeholder = '') {
  return new Promise((resolve) => {
    const overlay = document.getElementById('input-modal-overlay');
    const form = document.getElementById('input-modal-form');
    const input = document.getElementById('input-modal-field');
    const titleEl = document.getElementById('input-modal-title');
    const labelEl = document.getElementById('input-modal-label');
    const cancelBtn = document.getElementById('cancel-input-modal-btn');
    const closeBtn = document.getElementById('close-input-modal-btn');

    titleEl.textContent = title;
    labelEl.textContent = label;
    input.value = defaultValue;
    input.placeholder = placeholder;

    // Handle password field styling / type change for safety if title contains password
    if (title.toLowerCase().includes('passwort') || label.toLowerCase().includes('passwort')) {
      input.type = 'password';
    } else {
      input.type = 'text';
    }

    overlay.classList.add('active');
    input.focus();

    const cleanup = () => {
      overlay.classList.remove('active');
      form.onsubmit = null;
      cancelBtn.onclick = null;
      closeBtn.onclick = null;
    };

    form.onsubmit = (e) => {
      e.preventDefault();
      const val = input.value.trim();
      cleanup();
      resolve(val);
    };

    cancelBtn.onclick = () => {
      cleanup();
      resolve(null);
    };

    closeBtn.onclick = () => {
      cleanup();
      resolve(null);
    };
  });
}

function formatBytes(bytes) {
  if (bytes === 0 || !bytes) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/* ==========================================================================
   ROUTING
   ========================================================================== */
async function checkAuthStatus() {
  try {
    const res = await fetch('/api/auth/status');
    const data = await res.json();
    
    // SSO Button anzeigen falls aktiv
    const ssoBtn = document.getElementById('sso-login-btn');
    if (data.ssoEnabled) {
      ssoBtn.style.display = 'inline-flex';
    } else {
      ssoBtn.style.display = 'none';
    }

    if (data.loggedIn) {
      currentUser = data.user;
      document.getElementById('nav-username').textContent = currentUser.username;
      
      // Set nav avatar
      document.getElementById('nav-avatar').src = `/api/users/${currentUser.id}/avatar?t=${Date.now()}`;
      
      // Admin Button anzeigen falls Admin
      const adminBtn = document.getElementById('dropdown-admin-btn');
      if (adminBtn) {
        adminBtn.style.display = currentUser.role === 'admin' ? 'flex' : 'none';
      }
      
      appHeader.style.display = 'flex';
      
      // Weiche Navigation
      const hash = window.location.hash;
      if (hash === '#settings') {
        showView('settings');
      } else {
        window.location.hash = '#dashboard';
        showView('dashboard');
      }
    } else {
      currentUser = null;
      appHeader.style.display = 'none';
      
      // First-run Modus (erster Benutzer registriert sich als Admin)
      if (data.firstRun) {
        isRegisterMode = true;
        updateAuthUI(true);
        showToast('Ersteinrichtung: Registriere den ersten Admin-Benutzer.');
      }
      
      showView('auth');
    }
  } catch (err) {
    console.error('Auth check failed:', err);
    showToast('Verbindungsfehler zum Server.');
  }
}

const adminView = document.getElementById('admin-view');

function showView(viewName) {
  authView.style.display = 'none';
  dashboardView.style.display = 'none';
  settingsView.style.display = 'none';
  if (adminView) adminView.style.display = 'none';

  if (viewName === 'auth') {
    authView.style.display = 'flex';
  } else if (viewName === 'dashboard') {
    dashboardView.style.display = 'flex';
    loadFiles(currentFolderId);
  } else if (viewName === 'settings') {
    settingsView.style.display = 'block';
    loadSettings();
  } else if (viewName === 'admin') {
    if (currentUser && currentUser.role === 'admin') {
      if (adminView) adminView.style.display = 'block';
      loadAdminSettings();
    } else {
      window.location.hash = '#dashboard';
      showView('dashboard');
    }
  }
  lucide.createIcons();
}

window.addEventListener('hashchange', () => {
  const hash = window.location.hash;
  if (!currentUser && hash !== '#login') {
    window.location.hash = '#login';
    showView('auth');
  } else if (currentUser) {
    if (hash === '#settings') {
      showView('settings');
    } else if (hash === '#admin') {
      showView('admin');
    } else {
      showView('dashboard');
    }
  }
});

/* ==========================================================================
   AUTHENTICATION LOGIC
   ========================================================================== */
const authForm = document.getElementById('auth-form');
const authSubmitBtn = document.getElementById('auth-submit-btn');
const toggleAuthModeBtn = document.getElementById('toggle-auth-mode');
const forgotPasswordBtn = document.getElementById('forgot-password-btn');

function updateAuthUI(isRegister) {
  isRegisterMode = isRegister;
  const title = document.getElementById('auth-subtitle');
  const label = document.getElementById('username-label');
  const input = document.getElementById('username');

  if (isRegister) {
    title.textContent = 'Erstelle ein neues Konto';
    authSubmitBtn.textContent = 'Registrieren';
    toggleAuthModeBtn.textContent = 'Bereits ein Konto? Anmelden';
    forgotPasswordBtn.style.display = 'none';
    if (label) label.textContent = 'E-Mail-Adresse';
    if (input) input.placeholder = 'z. B. alex@gamerfreak.eu';
  } else {
    title.textContent = 'Willkommen! Bitte melde dich an.';
    authSubmitBtn.textContent = 'Anmelden';
    toggleAuthModeBtn.textContent = 'Noch kein Konto? Registrieren';
    forgotPasswordBtn.style.display = isEmailConfigured ? 'inline-block' : 'none';
    if (label) label.textContent = 'Benutzername oder E-Mail';
    if (input) input.placeholder = 'z. B. alex oder alex@gamerfreak.eu';
  }

  const passkeyBtn = document.getElementById('passkey-login-btn');
  if (passkeyBtn) {
    passkeyBtn.style.display = isRegister ? 'none' : 'flex';
  }
}

toggleAuthModeBtn.onclick = () => {
  updateAuthUI(!isRegisterMode);
};

// Forgot Password Request
forgotPasswordBtn.onclick = async () => {
  const username = await showInputPrompt('Passwort vergessen', 'Bitte gib deinen Benutzernamen oder deine E-Mail-Adresse ein:', '', 'Benutzername oder E-Mail');
  if (!username) return;

  try {
    const res = await fetch('/api/auth/reset-password-request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username }),
    });
    
    const data = await res.json();
    if (res.ok) {
      if (data.devLink) {
        console.log('Dev Reset Link:', data.devLink);
        showToast(`[DEV] Link: ${data.devLink}`);
        // Automatisches Weiterleiten zum Testen des Resets
        const token = new URL(data.devLink).searchParams.get('token');
        handleResetPasswordFlow(token);
      } else {
        showToast(data.message || 'Zurücksetzungs-E-Mail gesendet.');
      }
    } else {
      showToast(data.error);
    }
  } catch (err) {
    showToast('Fehler bei der Anfrage.');
  }
};

async function handleResetPasswordFlow(token) {
  const newPassword = await showInputPrompt('Passwort zurücksetzen', 'Bitte gib dein neues Passwort ein:', '', 'Neues Passwort');
  if (!newPassword) return;

  try {
    const res = await fetch('/api/auth/reset-password-execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, newPassword }),
    });

    const data = await res.json();
    if (res.ok) {
      showToast('Passwort erfolgreich zurückgesetzt. Du kannst dich jetzt anmelden.');
    } else {
      showToast(data.error);
    }
  } catch (err) {
    showToast('Fehler beim Zurücksetzen des Passworts.');
  }
}

// Handle login/register form submission
authForm.onsubmit = async (e) => {
  e.preventDefault();
  const username = document.getElementById('username').value.trim();
  const password = document.getElementById('password').value;

  const endpoint = isRegisterMode ? '/api/auth/register' : '/api/auth/login';
  const payload = isRegisterMode ? { email: username, password } : { username, password };

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const data = await res.json();
    if (res.ok) {
      if (isRegisterMode) {
        if (data.requiresVerification) {
          showToast(data.message || 'Registrierung erfolgreich. Bitte bestätige deine E-Mail.');
          updateAuthUI(false); // In Login-Modus wechseln
        } else {
          showToast('Registrierung erfolgreich!');
          checkAuthStatus();
        }
      } else {
        // Login-Modus
        if (data.requires2FA) {
          const typeStr = data.type === 'totp' ? 'Authenticator App (TOTP)' : 'E-Mail';
          const code = await showInputPrompt('2FA Verifizierung', `Bitte gib den Bestätigungscode deiner ${typeStr} ein:`, '', '6-stelliger Code');
          if (!code) return;

          const verifyRes = await fetch('/api/auth/login/verify-2fa', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code }),
          });

          const verifyData = await verifyRes.json();
          if (verifyRes.ok) {
            showToast('Erfolgreich angemeldet!');
            if (verifyData.user && !verifyData.user.hasCustomUsername) {
              await promptAndSetCustomUsername();
            }
            checkAuthStatus();
          } else {
            showToast(verifyData.error || '2FA Verifizierung fehlgeschlagen.');
          }
        } else {
          showToast('Erfolgreich angemeldet!');
          if (data.user && !data.user.hasCustomUsername) {
            await promptAndSetCustomUsername();
          }
          checkAuthStatus();
        }
      }
    } else {
      showToast(data.error || 'Fehler beim Authentifizieren.');
    }
  } catch (err) {
    showToast('Fehler beim Senden der Daten.');
  }
};

// Helper to prompt and set custom username
async function promptAndSetCustomUsername() {
  let success = false;
  while (!success) {
    const desired = await showInputPrompt('Benutzername festlegen', 'Bitte wähle deinen Wunschnamen für diese Cloud:', '', 'Wunschname');
    if (!desired) {
      showToast('Ein Benutzername ist zwingend erforderlich.');
      continue;
    }

    try {
      const res = await fetch('/api/auth/set-username', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: desired }),
      });
      const data = await res.json();
      if (res.ok) {
        showToast('Benutzername erfolgreich festgelegt!');
        success = true;
      } else {
        showToast(data.error || 'Fehler beim Setzen des Benutzernamens.');
      }
    } catch (e) {
      showToast('Verbindungsfehler beim Setzen des Benutzernamens.');
    }
  }
}

// WebAuthn Passkey Login
document.getElementById('passkey-login-btn').onclick = async () => {
  try {
    // 1. Get options from server
    const optionsRes = await fetch('/api/auth/passkey/login-options', { method: 'POST' });
    if (!optionsRes.ok) {
      throw new Error('Optionen konnten nicht abgerufen werden.');
    }
    const options = await optionsRes.json();

    // 2. Start authentication via browser
    const assertion = await SimpleWebAuthnBrowser.startAuthentication(options);

    // 3. Verify assertion on server
    const verifyRes = await fetch('/api/auth/passkey/login-verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(assertion),
    });

    const verifyData = await verifyRes.json();
    if (verifyRes.ok && verifyData.success) {
      showToast('Mit Passkey erfolgreich angemeldet!');
      checkAuthStatus();
    } else {
      showToast(verifyData.error || 'Passkey-Login fehlgeschlagen.');
    }
  } catch (err) {
    console.error(err);
    showToast('Passkey-Anmeldung abgebrochen oder fehlgeschlagen.');
  }
};

// User Menu Trigger (Toggle Dropdown)
const userMenuTrigger = document.getElementById('user-menu-trigger');
const userDropdownMenu = document.getElementById('user-dropdown-menu');

if (userMenuTrigger && userDropdownMenu) {
  userMenuTrigger.onclick = (e) => {
    e.stopPropagation();
    userDropdownMenu.classList.toggle('show');
  };

  // Close dropdown when clicking anywhere else
  document.addEventListener('click', (e) => {
    if (!userMenuTrigger.contains(e.target) && !userDropdownMenu.contains(e.target)) {
      userDropdownMenu.classList.remove('show');
    }
  });
}

// Standard Logout Button in Dropdown
const dropdownLogoutBtn = document.getElementById('dropdown-logout-btn');
if (dropdownLogoutBtn) {
  dropdownLogoutBtn.onclick = async () => {
    try {
      const res = await fetch('/api/auth/logout', { method: 'POST' });
      if (res.ok) {
        currentUser = null;
        userDropdownMenu.classList.remove('show');
        window.location.hash = '#login';
        checkAuthStatus();
      }
    } catch (err) {
      showToast('Fehler beim Abmelden.');
    }
  };
}

// Dropdown Navigation Items
const dropdownSettingsBtn = document.getElementById('dropdown-settings-btn');
if (dropdownSettingsBtn) {
  dropdownSettingsBtn.onclick = (e) => {
    e.preventDefault();
    userDropdownMenu.classList.remove('show');
    window.location.hash = '#settings';
    
    // Switch to profile section inside settings layout
    document.querySelectorAll('.settings-nav-item').forEach(i => i.classList.remove('active'));
    document.querySelectorAll('.settings-section').forEach(s => s.classList.remove('active'));
    
    const profileTab = document.querySelector('[data-section="profile-settings"]');
    const profileSection = document.getElementById('profile-settings');
    if (profileTab && profileSection) {
      profileTab.classList.add('active');
      profileSection.classList.add('active');
    }
  };
}

const dropdownAdminBtn = document.getElementById('dropdown-admin-btn');
if (dropdownAdminBtn) {
  dropdownAdminBtn.onclick = (e) => {
    e.preventDefault();
    userDropdownMenu.classList.remove('show');
    window.location.hash = '#settings';
    
    // Switch to admin section inside settings layout
    document.querySelectorAll('.settings-nav-item').forEach(i => i.classList.remove('active'));
    document.querySelectorAll('.settings-section').forEach(s => s.classList.remove('active'));
    
    const adminTab = document.querySelector('[data-section="admin-settings"]');
    const adminSection = document.getElementById('admin-settings');
    if (adminTab && adminSection) {
      adminTab.classList.add('active');
      adminSection.classList.add('active');
    }
  };
}

document.getElementById('back-to-dashboard-btn').onclick = () => {
  window.location.hash = '#dashboard';
};

document.getElementById('logo-btn').onclick = (e) => {
  e.preventDefault();
  window.location.hash = '#dashboard';
};

/* ==========================================================================
   DASHBOARD / FILES EXPLORER LOGIC
   ========================================================================== */
async function loadFiles(folderId = null) {
  try {
    currentFolderId = folderId;
    let url = '/api/files/list';
    if (folderId) {
      url += `?parentId=${folderId}`;
    }

    const res = await fetch(url);
    if (!res.ok) {
      if (res.status === 401) {
        checkAuthStatus();
        return;
      }
      throw new Error('Dateien konnten nicht geladen werden.');
    }

    const files = await res.json();
    renderFiles(files);
    renderBreadcrumbs();
  } catch (err) {
    console.error(err);
    showToast('Fehler beim Laden des Datei-Explorers.');
  }
}

function renderBreadcrumbs() {
  const container = document.getElementById('breadcrumbs');
  container.innerHTML = '';

  // Home Breadcrumb
  const homeLink = document.createElement('a');
  homeLink.href = '#';
  homeLink.className = 'breadcrumb-item';
  homeLink.textContent = 'Home';
  homeLink.onclick = (e) => {
    e.preventDefault();
    breadcrumbsHistory = [];
    loadFiles(null);
  };
  container.appendChild(homeLink);

  breadcrumbsHistory.forEach((crumb, index) => {
    const sep = document.createElement('span');
    sep.className = 'breadcrumb-separator';
    sep.textContent = '/';
    container.appendChild(sep);

    if (index === breadcrumbsHistory.length - 1) {
      const activeSpan = document.createElement('span');
      activeSpan.className = 'breadcrumb-current';
      activeSpan.textContent = crumb.name;
      container.appendChild(activeSpan);
    } else {
      const link = document.createElement('a');
      link.href = '#';
      link.className = 'breadcrumb-item';
      link.textContent = crumb.name;
      link.onclick = (e) => {
        e.preventDefault();
        breadcrumbsHistory = breadcrumbsHistory.slice(0, index + 1);
        loadFiles(crumb.id);
      };
      container.appendChild(link);
    }
  });
}

function renderFiles(files) {
  renderedFilesList = files;
  const grid = document.getElementById('file-grid');
  grid.innerHTML = '';

  if (viewMode === 'list') {
    grid.classList.add('list-view');
  } else {
    grid.classList.remove('list-view');
  }

  if (files.length === 0) {
    grid.innerHTML = `<div style="grid-column: 1/-1; text-align: center; color: var(--color-text-muted); padding: 3rem 0;">Dieser Ordner ist leer.</div>`;
    return;
  }

  files.forEach(file => {
    const item = document.createElement('div');
    item.className = 'file-item';
    item.setAttribute('data-id', file.id);
    if (selectedFileIds.includes(file.id)) {
      item.classList.add('selected');
    }
    
    const iconName = file.is_folder ? 'folder' : 'file';

    item.innerHTML = `
      <div class="file-item-checkbox"></div>
      <div class="file-icon"><i data-lucide="${iconName}"></i></div>
      <div class="file-name" title="${file.name}">${file.name}</div>
      <div class="file-info">${file.is_folder ? 'Ordner' : formatBytes(file.size)}</div>
      <div class="file-actions">
        <button class="btn btn-icon btn-action-more" style="padding: 4px; background: var(--color-surface); border-radius: 4px;" title="Optionen">
          <i data-lucide="more-vertical" style="width: 16px; height: 16px;"></i>
        </button>
      </div>
    `;

    // Click handler for Multi-selection and Normal Actions
    item.onclick = (e) => {
      if (e.target.closest('.btn-action-more') || e.target.closest('.file-actions')) {
        return;
      }
      
      const isCheckbox = e.target.closest('.file-item-checkbox');
      const isMultiSelectActive = selectedFileIds.length > 0;
      
      if (isCheckbox || e.ctrlKey || e.metaKey || isMultiSelectActive) {
        e.preventDefault();
        
        if (e.shiftKey && lastSelectedId !== null) {
          // Range selection
          const startIdx = renderedFilesList.findIndex(f => f.id === lastSelectedId);
          const endIdx = renderedFilesList.findIndex(f => f.id === file.id);
          if (startIdx !== -1 && endIdx !== -1) {
            const min = Math.min(startIdx, endIdx);
            const max = Math.max(startIdx, endIdx);
            
            // clear selections between first
            selectedFileIds = [];
            for (let i = min; i <= max; i++) {
              selectedFileIds.push(renderedFilesList[i].id);
            }
          }
        } else {
          // Toggle selection
          const idx = selectedFileIds.indexOf(file.id);
          if (idx === -1) {
            selectedFileIds.push(file.id);
            lastSelectedId = file.id;
          } else {
            selectedFileIds.splice(idx, 1);
            if (lastSelectedId === file.id) {
              lastSelectedId = selectedFileIds[selectedFileIds.length - 1] || null;
            }
          }
        }
        updateMultiSelectUI();
      } else {
        // Normal Action (Navigation/Download)
        if (file.is_folder) {
          breadcrumbsHistory.push({ id: file.id, name: file.name });
          loadFiles(file.id);
        } else {
          const ext = file.name.split('.').pop().toLowerCase();
          const supportedExts = ['docx', 'xlsx', 'pptx', 'txt', 'odt', 'ods', 'odp'];
          if (supportedExts.includes(ext)) {
            openOfficeEditor(file.id, file.name);
          } else {
            window.location.href = `/api/files/download/${file.id}`;
          }
        }
      }
    };

    // Right Click context menu for item
    item.oncontextmenu = (e) => {
      e.preventDefault();
      e.stopPropagation();

      if (!selectedFileIds.includes(file.id)) {
        if (!e.ctrlKey && !e.metaKey) {
          selectedFileIds = [file.id];
        } else {
          selectedFileIds.push(file.id);
        }
        lastSelectedId = file.id;
        updateMultiSelectUI();
      }

      showFileContextMenu(file, e.clientX, e.clientY);
    };

    // Action Menu Button
    item.querySelector('.btn-action-more').onclick = (e) => {
      e.stopPropagation();
      showFileContextMenu(file, e.clientX, e.clientY);
    };

    grid.appendChild(item);
  });
  
  lucide.createIcons();
}

// Multi Selection UI Updates
function updateMultiSelectUI() {
  const bar = document.getElementById('multi-actions-bar');
  const countSpan = document.getElementById('multi-selection-count');
  
  document.querySelectorAll('.file-item').forEach(item => {
    const id = parseInt(item.getAttribute('data-id'));
    if (selectedFileIds.includes(id)) {
      item.classList.add('selected');
    } else {
      item.classList.remove('selected');
    }
  });

  if (selectedFileIds.length > 0) {
    bar.style.display = 'flex';
    countSpan.textContent = `${selectedFileIds.length} Element(e) ausgewählt`;
  } else {
    bar.style.display = 'none';
  }
}

function clearSelection() {
  selectedFileIds = [];
  lastSelectedId = null;
  updateMultiSelectUI();
}

// Item Context Menu
function showFileContextMenu(file, x, y) {
  const existing = document.querySelector('.context-menu');
  if (existing) existing.remove();

  const menu = document.createElement('div');
  menu.className = 'card context-menu';
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;

  const actions = [];

  if (selectedFileIds.length > 1) {
    // Context Actions for Multiple Items
    actions.push({
      label: 'Ausgewählte als ZIP',
      icon: 'file-archive',
      action: () => {
        window.location.href = `/api/files/download-zip-multiple?ids=${selectedFileIds.join(',')}`;
        clearSelection();
      }
    });
    actions.push({
      label: 'Ausgewählte löschen',
      icon: 'trash-2',
      action: () => deleteSelectedFiles()
    });
    actions.push({
      label: 'Auswahl aufheben',
      icon: 'x-square',
      action: () => clearSelection()
    });
  } else {
    // Context Actions for Single Item
    if (!file.is_folder) {
      const ext = file.name.split('.').pop().toLowerCase();
      const supportedExts = ['docx', 'xlsx', 'pptx', 'txt', 'odt', 'ods', 'odp'];
      if (supportedExts.includes(ext)) {
        actions.push({
          label: 'In EuroOffice bearbeiten',
          icon: 'edit-3',
          action: () => openOfficeEditor(file.id, file.name)
        });
      }
      actions.push({
        label: 'Herunterladen',
        icon: 'download',
        action: () => window.location.href = `/api/files/download/${file.id}`
      });
    } else {
      actions.push({
        label: 'Als ZIP laden',
        icon: 'file-archive',
        action: () => window.location.href = `/api/files/download-zip/${file.id}`
      });
    }

    actions.push({
      label: 'Teilen',
      icon: 'share-2',
      action: () => openShareModal(file)
    });

    actions.push({
      label: 'Löschen',
      icon: 'trash-2',
      action: () => deleteFile(file)
    });
  }

  actions.forEach(act => {
    const btn = document.createElement('button');
    btn.className = 'btn-menu-item';
    btn.innerHTML = `<i data-lucide="${act.icon}"></i> ${act.label}`;
    
    if (act.label.includes('löschen') || act.label === 'Löschen') {
      btn.classList.add('delete-action');
    }

    btn.onclick = () => {
      act.action();
      menu.remove();
    };
    menu.appendChild(btn);
  });

  document.body.appendChild(menu);
  lucide.createIcons();

  const closeMenu = (e) => {
    if (!menu.contains(e.target)) {
      menu.remove();
      document.removeEventListener('click', closeMenu);
    }
  };
  setTimeout(() => document.addEventListener('click', closeMenu), 50);
}

// Global Dashboard Background Right Click Menu
document.getElementById('dashboard-view').oncontextmenu = (e) => {
  if (e.target.closest('.file-item') || e.target.closest('.settings-layout') || e.target.closest('header') || e.target.closest('.modal') || e.target.closest('#multi-actions-bar')) {
    return;
  }
  
  e.preventDefault();

  const existing = document.querySelector('.context-menu');
  if (existing) existing.remove();

  const menu = document.createElement('div');
  menu.className = 'card context-menu';
  menu.style.left = `${e.clientX}px`;
  menu.style.top = `${e.clientY}px`;

  const actions = [
    {
      label: 'Neuer Ordner',
      icon: 'folder-plus',
      action: () => createNewFolder()
    },
    {
      label: 'Neue Datei erstellen',
      icon: 'file-plus',
      action: () => createNewEmptyFile()
    },
    {
      label: 'Datei hochladen',
      icon: 'upload',
      action: () => document.getElementById('file-upload-input').click()
    }
  ];

  if (selectedFileIds.length > 0) {
    actions.push({
      label: 'Auswahl aufheben',
      icon: 'x-square',
      action: () => clearSelection()
    });
  }

  actions.forEach(act => {
    const btn = document.createElement('button');
    btn.className = 'btn-menu-item';
    btn.innerHTML = `<i data-lucide="${act.icon}"></i> ${act.label}`;

    btn.onclick = () => {
      act.action();
      menu.remove();
    };
    menu.appendChild(btn);
  });

  document.body.appendChild(menu);
  lucide.createIcons();

  const closeMenu = (e) => {
    if (!menu.contains(e.target)) {
      menu.remove();
      document.removeEventListener('click', closeMenu);
    }
  };
  setTimeout(() => document.addEventListener('click', closeMenu), 50);
};

// Action: Create Folder
document.getElementById('new-folder-btn').onclick = () => createNewFolder();

async function createNewFolder() {
  const name = await showInputPrompt('Neuer Ordner', 'Bitte gib einen Namen für den neuen Ordner ein:', '', 'Ordnername');
  if (!name) return;

  try {
    const res = await fetch('/api/files/folder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, parentId: currentFolderId }),
    });

    if (res.ok) {
      showToast('Ordner erfolgreich erstellt.');
      loadFiles(currentFolderId);
    } else {
      const err = await res.json();
      showToast(err.error);
    }
  } catch (err) {
    showToast('Fehler beim Erstellen des Ordners.');
  }
}

// Action: Create Empty File
async function createNewEmptyFile() {
  const name = await showInputPrompt('Neue Datei erstellen', 'Bitte gib einen Dateinamen ein (z. B. notizen.txt):', '', 'notizen.txt');
  if (!name) return;

  try {
    const res = await fetch('/api/files/create-empty', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, parentId: currentFolderId }),
    });

    if (res.ok) {
      showToast('Leere Datei erfolgreich erstellt.');
      loadFiles(currentFolderId);
    } else {
      const err = await res.json();
      showToast(err.error);
    }
  } catch (err) {
    showToast('Fehler beim Erstellen der Datei.');
  }
}

// Action: Upload File via Click
document.getElementById('file-upload-input').onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  await uploadFile(file);
};

async function uploadFile(file) {
  const formData = new FormData();
  formData.append('file', file);
  if (currentFolderId) {
    formData.append('parentId', currentFolderId);
  }

  showToast('Lade Datei hoch...');

  try {
    const res = await fetch('/api/files/upload', {
      method: 'POST',
      body: formData,
    });

    if (res.ok) {
      showToast(`Datei "${file.name}" erfolgreich hochgeladen!`);
      loadFiles(currentFolderId);
    } else {
      const err = await res.json();
      showToast(err.error);
    }
  } catch (err) {
    showToast('Fehler beim Datei-Upload.');
  }
}

// Action: Delete Single File
async function deleteFile(file) {
  const confirmMsg = file.is_folder 
    ? `Möchtest du den Ordner "${file.name}" und alle darin enthaltenen Dateien wirklich löschen?`
    : `Möchtest du die Datei "${file.name}" wirklich löschen?`;
    
  if (!confirm(confirmMsg)) return;

  try {
    const res = await fetch(`/api/files/${file.id}`, {
      method: 'DELETE',
    });

    if (res.ok) {
      showToast('Element gelöscht.');
      loadFiles(currentFolderId);
    } else {
      const err = await res.json();
      showToast(err.error);
    }
  } catch (err) {
    showToast('Fehler beim Löschen.');
  }
}

// Action: Delete Multiple Selected Files
async function deleteSelectedFiles() {
  if (selectedFileIds.length === 0) return;
  if (!confirm(`Möchtest du die ${selectedFileIds.length} ausgewählten Elemente wirklich löschen?`)) return;

  try {
    const res = await fetch('/api/files/delete-multiple', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: selectedFileIds }),
    });

    if (res.ok) {
      showToast('Ausgewählte Elemente gelöscht.');
      clearSelection();
      loadFiles(currentFolderId);
    } else {
      const err = await res.json();
      showToast(err.error);
    }
  } catch (err) {
    showToast('Fehler beim Löschen.');
  }
}

// Multi Select Bar Event Listeners
document.getElementById('multi-cancel-btn').onclick = () => clearSelection();
document.getElementById('multi-delete-btn').onclick = () => deleteSelectedFiles();
document.getElementById('multi-zip-btn').onclick = () => {
  if (selectedFileIds.length === 0) return;
  window.location.href = `/api/files/download-zip-multiple?ids=${selectedFileIds.join(',')}`;
  clearSelection();
};

// Fullscreen Drag & Drop on Dashboard
const dragOverlay = document.getElementById('drag-overlay');
const dashboard = document.getElementById('dashboard-view');
let dragCounter = 0;

dashboard.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragCounter++;
  if (dragCounter === 1) {
    dragOverlay.style.display = 'flex';
  }
});

dashboard.addEventListener('dragover', (e) => {
  e.preventDefault();
});

dashboard.addEventListener('dragleave', (e) => {
  e.preventDefault();
  dragCounter--;
  if (dragCounter === 0) {
    dragOverlay.style.display = 'none';
  }
});

dashboard.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragCounter = 0;
  dragOverlay.style.display = 'none';

  const files = e.dataTransfer.files;
  if (files.length === 0) return;

  showToast(`Lade ${files.length} Datei(en) hoch...`);
  
  // Sequential Upload
  for (let i = 0; i < files.length; i++) {
    await uploadFile(files[i]);
  }
});


/* ==========================================================================
   SHARING MODAL LOGIC
   ========================================================================== */
const shareModal = document.getElementById('share-modal-overlay');
const shareForm = document.getElementById('share-form');
const shareSlugInput = document.getElementById('share-slug');
const shareCanWriteCheck = document.getElementById('share-can-write');
const shareCanDownloadCheck = document.getElementById('share-can-download');
const shareCanZipCheck = document.getElementById('share-can-zip');
const shareExpiresInput = document.getElementById('share-expires');
const deleteShareBtn = document.getElementById('delete-share-btn');
const shareResultSection = document.getElementById('share-result-section');
const shareResultInput = document.getElementById('share-result-input');

async function openShareModal(file) {
  document.getElementById('share-file-id').value = file.id;
  const prefix = appBrandingUrl || window.location.origin;
  document.getElementById('share-url-prefix').textContent = prefix.endsWith('/') ? `${prefix}s/` : `${prefix}/s/`;
  
  // Set defaults
  shareSlugInput.value = '';
  shareCanWriteCheck.checked = false;
  shareCanDownloadCheck.checked = true;
  shareCanZipCheck.checked = true;
  shareExpiresInput.value = '';
  document.getElementById('share-password').value = '';
  document.getElementById('share-max-downloads').value = '';
  document.getElementById('share-only-upload').checked = false;
  document.getElementById('share-password-remove-container').style.display = 'none';
  document.getElementById('share-password-remove').checked = false;
  deleteShareBtn.style.display = 'none';
  shareResultSection.style.display = 'none';
  document.getElementById('share-existing-id').value = '';

  // Only Upload Container handle (only makes sense for folders)
  const onlyUploadContainer = document.getElementById('share-only-upload-container');
  if (!file.is_folder) {
    shareCanWriteCheck.checked = false;
    shareCanWriteCheck.disabled = true;
    if (onlyUploadContainer) onlyUploadContainer.style.display = 'none';
  } else {
    shareCanWriteCheck.disabled = false;
    if (onlyUploadContainer) onlyUploadContainer.style.display = 'flex';
  }

  // Check if already shared
  try {
    const res = await fetch('/api/shares');
    const shares = await res.json();
    const existing = shares.find(s => s.file_id === file.id);

    if (existing) {
      document.getElementById('share-existing-id').value = existing.id;
      shareSlugInput.value = existing.slug;
      shareCanWriteCheck.checked = existing.can_write;
      shareCanDownloadCheck.checked = existing.can_download;
      shareCanZipCheck.checked = existing.can_zip;
      
      if (existing.expires_at) {
        const diffTime = Math.abs(new Date(existing.expires_at) - new Date());
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
        shareExpiresInput.value = diffDays;
      }

      if (existing.password_hash) {
        document.getElementById('share-password-remove-container').style.display = 'flex';
      }

      if (existing.max_downloads) {
        document.getElementById('share-max-downloads').value = existing.max_downloads;
      }

      document.getElementById('share-only-upload').checked = existing.only_upload;
      
      deleteShareBtn.style.display = 'inline-flex';
      displayGeneratedLink(existing.slug);
    }
  } catch (err) {
    console.error('Error checking existing share:', err);
  }

  shareModal.classList.add('active');
  lucide.createIcons();
}

function displayGeneratedLink(slug) {
  const prefix = appBrandingUrl || window.location.origin;
  const base = prefix.endsWith('/') ? prefix : `${prefix}/`;
  const fullUrl = `${base}s/${slug}`;
  shareResultInput.value = fullUrl;
  shareResultSection.style.display = 'block';
}

document.getElementById('close-share-modal-btn').onclick = () => {
  shareModal.classList.remove('active');
};

// Copy Share Link to Clipboard
document.getElementById('copy-share-link-btn').onclick = () => {
  shareResultInput.select();
  document.execCommand('copy');
  showToast('Link in die Zwischenablage kopiert!');
};

// Submit Share Form (Create or Update)
shareForm.onsubmit = async (e) => {
  e.preventDefault();
  const fileId = document.getElementById('share-file-id').value;
  const existingId = document.getElementById('share-existing-id').value;
  
  const payload = {
    fileId: parseInt(fileId),
    customSlug: shareSlugInput.value.trim(),
    canRead: true,
    canWrite: shareCanWriteCheck.checked,
    canDownload: shareCanDownloadCheck.checked,
    canZip: shareCanZipCheck.checked,
    expiresDays: shareExpiresInput.value ? parseInt(shareExpiresInput.value) : null,
    password: document.getElementById('share-password').value || null,
    maxDownloads: document.getElementById('share-max-downloads').value ? parseInt(document.getElementById('share-max-downloads').value) : null,
    onlyUpload: document.getElementById('share-only-upload').checked,
    removePassword: document.getElementById('share-password-remove').checked
  };

  const url = existingId ? `/api/shares/${existingId}` : '/api/shares';
  const method = existingId ? 'PUT' : 'POST';

  try {
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const data = await res.json();
    if (res.ok) {
      showToast(existingId ? 'Freigabe aktualisiert!' : 'Freigabe-Link erstellt!');
      document.getElementById('share-existing-id').value = data.id;
      deleteShareBtn.style.display = 'inline-flex';
      
      // Update password remove state
      if (data.password_hash) {
        document.getElementById('share-password-remove-container').style.display = 'flex';
      } else {
        document.getElementById('share-password-remove-container').style.display = 'none';
        document.getElementById('share-password-remove').checked = false;
      }
      document.getElementById('share-password').value = ''; // clear input

      displayGeneratedLink(data.slug);
    } else {
      showToast(data.error);
    }
  } catch (err) {
    showToast('Fehler beim Speichern der Freigabe.');
  }
};

// Delete share
deleteShareBtn.onclick = async () => {
  const existingId = document.getElementById('share-existing-id').value;
  if (!existingId) return;

  if (!confirm('Möchtest du diese Freigabe wirklich aufheben? Der Link wird ungültig.')) return;

  try {
    const res = await fetch(`/api/shares/${existingId}`, {
      method: 'DELETE',
    });

    if (res.ok) {
      showToast('Freigabe aufgehoben.');
      shareModal.classList.remove('active');
      loadFiles(currentFolderId);
    } else {
      const err = await res.json();
      showToast(err.error);
    }
  } catch (err) {
    showToast('Fehler beim Aufheben der Freigabe.');
  }
};

/* ==========================================================================
   SETTINGS & ADMIN LOGIC
   ========================================================================== */
// Sidebar navigation inside Settings
document.querySelectorAll('#settings-nav .settings-nav-item').forEach(item => {
  item.onclick = () => {
    document.querySelectorAll('#settings-nav .settings-nav-item').forEach(i => i.classList.remove('active'));
    document.querySelectorAll('#settings-view .settings-section').forEach(s => s.classList.remove('active'));
    
    item.classList.add('active');
    const targetSection = item.getAttribute('data-section');
    document.getElementById(targetSection).classList.add('active');
  };
});

// Sidebar navigation inside Admin
document.querySelectorAll('#admin-nav .settings-nav-item').forEach(item => {
  item.onclick = () => {
    document.querySelectorAll('#admin-nav .settings-nav-item').forEach(i => i.classList.remove('active'));
    document.querySelectorAll('#admin-view .settings-section').forEach(s => s.classList.remove('active'));
    
    item.classList.add('active');
    const targetSection = item.getAttribute('data-section');
    document.getElementById(targetSection).classList.add('active');
  };
});

async function loadSettings() {
  try {
    const res = await fetch('/api/settings');
    const data = await res.json();

    // Set email input
    const emailInput = document.getElementById('settings-email-input');
    if (emailInput && data.user) {
      emailInput.value = data.user.email || '';
    }

    // Set 2FA checkboxes
    const emailToggle = document.getElementById('2fa-email-toggle');
    if (emailToggle && data.user) {
      emailToggle.checked = data.user.two_factor_email || false;
    }
    const totpToggle = document.getElementById('2fa-totp-toggle');
    if (totpToggle && data.user) {
      totpToggle.checked = data.user.two_factor_totp || false;
    }

    // Set settings avatar preview
    const previewImg = document.getElementById('settings-avatar-preview');
    if (previewImg && currentUser) {
      previewImg.src = `/api/users/${currentUser.id}/avatar?t=${Date.now()}`;
    }

    // Render passkeys
    renderPasskeyList(data.passkeys);

    // Load Geteilte Links List
    loadUserShares();

  } catch (err) {
    console.error('Settings load error:', err);
    showToast('Fehler beim Laden der Einstellungen.');
  }
}

// Render User Passkeys
function renderPasskeyList(passkeys) {
  const container = document.getElementById('passkey-list');
  if (!container) return;
  container.innerHTML = '';

  if (passkeys.length === 0) {
    container.innerHTML = `<tr><td colspan="3" style="text-align: center; color: var(--color-text-muted);">Keine Passkeys registriert.</td></tr>`;
    return;
  }

  passkeys.forEach(pk => {
    const row = document.createElement('tr');
    
    const date = new Date(pk.created_at).toLocaleDateString('de-DE', {
      day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'
    });

    row.innerHTML = `
      <td>${date}</td>
      <td style="font-family: monospace;">${pk.id.slice(0, 15)}...</td>
      <td>
        <button class="btn btn-action-delete-passkey" style="color: #ff5555; border-color: rgba(255,0,0,0.2); padding: 4px 10px;">
          Löschen
        </button>
      </td>
    `;

    row.querySelector('.btn-action-delete-passkey').onclick = async () => {
      if (!confirm('Diesen Passkey wirklich löschen?')) return;
      try {
        const res = await fetch(`/api/settings/passkeys/${pk.id}`, { method: 'DELETE' });
        if (res.ok) {
          showToast('Passkey gelöscht.');
          loadSettings();
        }
      } catch (err) {
        showToast('Fehler beim Löschen des Passkeys.');
      }
    };

    container.appendChild(row);
  });
}

// Register new Passkey
document.getElementById('register-passkey-btn').onclick = async () => {
  try {
    const optionsRes = await fetch('/api/auth/passkey/register-options', { method: 'POST' });
    if (!optionsRes.ok) throw new Error('Registrierungsoptionen konnten nicht geholt werden.');
    const options = await optionsRes.json();

    const credential = await SimpleWebAuthnBrowser.startRegistration(options);

    const verifyRes = await fetch('/api/auth/passkey/register-verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(credential),
    });

    const verifyData = await verifyRes.json();
    if (verifyRes.ok && verifyData.success) {
      showToast('Passkey erfolgreich registriert!');
      loadSettings();
    } else {
      showToast(verifyData.error || 'Passkey-Registrierung fehlgeschlagen.');
    }
  } catch (err) {
    console.error(err);
    showToast('Registrierung abgebrochen oder nicht unterstützt.');
  }
};

// Change Password Form Submit
document.getElementById('change-password-form').onsubmit = async (e) => {
  e.preventDefault();
  const currentPassword = document.getElementById('current-password').value;
  const newPassword = document.getElementById('new-password').value;

  try {
    const res = await fetch('/api/settings/profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword, newPassword }),
    });

    const data = await res.json();
    if (res.ok) {
      showToast('Passwort erfolgreich geändert.');
      document.getElementById('change-password-form').reset();
    } else {
      showToast(data.error);
    }
  } catch (err) {
    showToast('Fehler beim Ändern des Passworts.');
  }
};

// Change Email Form Submit
const changeEmailForm = document.getElementById('change-email-form');
if (changeEmailForm) {
  changeEmailForm.onsubmit = async (e) => {
    e.preventDefault();
    const email = document.getElementById('settings-email-input').value.trim();

    try {
      const res = await fetch('/api/settings/email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });

      const data = await res.json();
      if (res.ok) {
        showToast('E-Mail-Adresse erfolgreich gespeichert.');
        loadSettings();
      } else {
        showToast(data.error);
      }
    } catch (err) {
      showToast('Fehler beim Ändern der E-Mail-Adresse.');
    }
  };
}

async function loadAdminSettings() {
  try {
    const res = await fetch('/api/settings');
    const data = await res.json();

    if (currentUser.role === 'admin' && data.adminConfig) {
      const conf = data.adminConfig;
      
      // Branding Sektion befüllen
      document.getElementById('admin-cloud-name').value = conf.cloud_name || 'myCloud';
      document.getElementById('admin-cloud-tab-name').value = conf.cloud_tab_name || 'myCloud';
      document.getElementById('admin-icon-preview').src = `/api/public/branding/icon?t=${Date.now()}`;

      // Systemeinstellungen befüllen
      document.getElementById('admin-reg-enabled').checked = conf.registration_enabled === 'true';
      document.getElementById('admin-sso-enabled').checked = conf.sso_enabled === 'true';
      document.getElementById('admin-sso-issuer').value = conf.sso_issuer_url || '';
      document.getElementById('admin-sso-client-id').value = conf.sso_client_id || '';
      document.getElementById('admin-sso-client-secret').value = conf.sso_client_secret_configured ? '__placeholder__' : '';
      document.getElementById('admin-sso-redirect').value = `${window.location.origin}/auth/sso/callback`;
      
      // SMTP befüllen
      document.getElementById('admin-smtp-host').value = conf.email_smtp_host || '';
      document.getElementById('admin-smtp-port').value = conf.email_smtp_port || '';
      document.getElementById('admin-smtp-user').value = conf.email_smtp_user || '';
      document.getElementById('admin-smtp-pass').value = conf.email_smtp_pass_configured ? '__placeholder__' : '';
      document.getElementById('admin-smtp-from').value = conf.email_from || 'noreply@mycloud.local';

      // Load Users List
      loadAdminUsers();
    }
  } catch (err) {
    console.error('Admin settings load error:', err);
    showToast('Fehler beim Laden der Admin-Einstellungen.');
  }
}

// Help method to save admin config payload
async function saveAdminConfig(payload) {
  try {
    const res = await fetch('/api/settings/admin/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (res.ok) {
      showToast('Konfiguration erfolgreich gespeichert.');
      loadAdminSettings();
    } else {
      const err = await res.json();
      showToast(err.error || 'Fehler beim Speichern.');
    }
  } catch (err) {
    showToast('Verbindungsfehler beim Speichern.');
  }
}

// Submit Forms inside Admin View
document.getElementById('admin-branding-form').onsubmit = async (e) => {
  e.preventDefault();
  const payload = {
    cloud_name: document.getElementById('admin-cloud-name').value.trim(),
    cloud_tab_name: document.getElementById('admin-cloud-tab-name').value.trim()
  };
  await saveAdminConfig(payload);
  loadBranding(); // Reload headers & document title instantly
};

document.getElementById('admin-system-form').onsubmit = async (e) => {
  e.preventDefault();
  const secretInput = document.getElementById('admin-sso-client-secret').value;
  const payload = {
    registration_enabled: document.getElementById('admin-reg-enabled').checked ? 'true' : 'false',
    sso_enabled: document.getElementById('admin-sso-enabled').checked ? 'true' : 'false',
    sso_issuer_url: document.getElementById('admin-sso-issuer').value.trim(),
    sso_client_id: document.getElementById('admin-sso-client-id').value.trim(),
    sso_client_secret: secretInput === '__placeholder__' ? '__placeholder__' : secretInput
  };
  await saveAdminConfig(payload);
};

document.getElementById('admin-smtp-form').onsubmit = async (e) => {
  e.preventDefault();
  const smtpPassInput = document.getElementById('admin-smtp-pass').value;
  const payload = {
    email_smtp_host: document.getElementById('admin-smtp-host').value.trim(),
    email_smtp_port: document.getElementById('admin-smtp-port').value.trim(),
    email_smtp_user: document.getElementById('admin-smtp-user').value.trim(),
    email_smtp_pass: smtpPassInput === '__placeholder__' ? '__placeholder__' : smtpPassInput,
    email_from: document.getElementById('admin-smtp-from').value.trim(),
  };
  await saveAdminConfig(payload);
};

// Admin Cloud Icon Upload Listener
const adminIconInput = document.getElementById('admin-icon-upload-input');
if (adminIconInput) {
  adminIconInput.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const formData = new FormData();
    formData.append('icon', file);

    showToast('Lade Cloud-Icon hoch...');

    try {
      const res = await fetch('/api/settings/admin/icon', {
        method: 'POST',
        body: formData,
      });

      const data = await res.json();
      if (res.ok) {
        showToast('Cloud-Icon erfolgreich geändert!');
        loadAdminSettings();
        loadBranding(); // Reload headers & document title instantly
      } else {
        showToast(data.error || 'Fehler beim Hochladen.');
      }
    } catch (err) {
      showToast('Verbindungsfehler beim Icon-Upload.');
    }
  };
}

// Admin Test SMTP
document.getElementById('test-smtp-btn').onclick = async () => {
  const to = document.getElementById('admin-smtp-test-recipient').value.trim();
  if (!to) {
    showToast('Bitte gib einen Test-Empfänger ein.');
    return;
  }

  showToast('Sende Test-E-Mail...');

  try {
    const res = await fetch('/api/settings/admin/test-smtp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to }),
    });

    const data = await res.json();
    if (res.ok) {
      showToast('Test-E-Mail erfolgreich versendet!');
    } else {
      showToast(`SMTP Fehler: ${data.error}`);
    }
  } catch (err) {
    showToast('SMTP Test fehlgeschlagen.');
  }
};

// Admin: Load Users List
async function loadAdminUsers() {
  try {
    const res = await fetch('/api/settings/admin/users');
    const users = await res.json();

    const container = document.getElementById('admin-user-list');
    container.innerHTML = '';

    users.forEach(user => {
      const row = document.createElement('tr');
      const ssoText = user.sso_provider ? `Authentik (${user.sso_provider})` : 'Nein';
      
      row.innerHTML = `
        <td>${user.username}</td>
        <td>
          <select class="form-control select-role" style="padding: 2px 6px; font-size: 0.85rem; width: auto; background: var(--color-surface);">
            <option value="user" ${user.role === 'user' ? 'selected' : ''}>User</option>
            <option value="admin" ${user.role === 'admin' ? 'selected' : ''}>Admin</option>
          </select>
        </td>
        <td>${ssoText}</td>
        <td>${user.file_count}</td>
        <td>${formatBytes(user.storage_used)}</td>
        <td>
          <button class="btn btn-action-delete-user" style="color: #ff5555; border-color: rgba(255,0,0,0.2); padding: 4px 10px;">
            Löschen
          </button>
        </td>
      `;

      // Handle role change
      row.querySelector('.select-role').onchange = async (e) => {
        const newRole = e.target.value;
        try {
          const r = await fetch(`/api/settings/admin/users/${user.id}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'role', role: newRole }),
          });
          if (r.ok) {
            showToast('Benutzerrolle geändert.');
          } else {
            const err = await r.json();
            showToast(err.error);
            loadSettings(); // Rollback UI state
          }
        } catch (err) {
          showToast('Fehler beim Ändern der Rolle.');
        }
      };

      // Handle delete user
      row.querySelector('.btn-action-delete-user').onclick = async () => {
        if (!confirm(`Möchtest du den Benutzer "${user.username}" und alle seine Dateien wirklich unwiderruflich löschen?`)) return;
        try {
          const r = await fetch(`/api/settings/admin/users/${user.id}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'delete' }),
          });
          if (r.ok) {
            showToast('Benutzer gelöscht.');
            loadSettings();
          } else {
            const err = await r.json();
            showToast(err.error);
          }
        } catch (err) {
          showToast('Fehler beim Löschen des Benutzers.');
        }
      };

      // Disable delete on current user
      if (user.id === currentUser.id) {
        row.querySelector('.btn-action-delete-user').disabled = true;
        row.querySelector('.btn-action-delete-user').style.opacity = '0.5';
        row.querySelector('.select-role').disabled = true;
      }

      container.appendChild(row);
    });
  } catch (err) {
    console.error('Error loading admin users:', err);
  }
}

// User Geteilte Links auflisten
async function loadUserShares() {
  try {
    const res = await fetch('/api/shares');
    allShares = await res.json();

    const container = document.getElementById('user-shares-list');
    container.innerHTML = '';

    if (allShares.length === 0) {
      container.innerHTML = `<tr><td colspan="6" style="text-align: center; color: var(--color-text-muted);">Du hast noch keine Links geteilt.</td></tr>`;
      return;
    }

    allShares.forEach(share => {
      const row = document.createElement('tr');
      const typeText = share.is_folder ? 'Ordner' : 'Datei';
      const expiresText = share.expires_at 
        ? new Date(share.expires_at).toLocaleDateString('de-DE') 
        : 'Nie';

      const permissions = [];
      if (share.can_read) permissions.push('Read');
      if (share.can_write) permissions.push('Write');
      if (share.can_download) permissions.push('Download');
      if (share.can_zip) permissions.push('ZIP');

      row.innerHTML = `
        <td style="font-weight: 500;">${share.file_name}</td>
        <td>${typeText}</td>
        <td><a href="/s/${share.slug}" target="_blank" style="color: var(--color-accent); text-decoration: none;">/s/${share.slug}</a></td>
        <td><span style="font-size: 0.8rem; color: var(--color-text-muted);">${permissions.join(', ')}</span></td>
        <td>${expiresText}</td>
        <td>
          <button class="btn btn-action-delete-share" style="color: #ff5555; border-color: rgba(255,0,0,0.2); padding: 4px 10px;">
            Löschen
          </button>
        </td>
      `;

      row.querySelector('.btn-action-delete-share').onclick = async () => {
        if (!confirm('Diesen Freigabelink wirklich löschen?')) return;
        try {
          const r = await fetch(`/api/shares/${share.id}`, { method: 'DELETE' });
          if (r.ok) {
            showToast('Freigabe gelöscht.');
            loadSettings();
          }
        } catch (err) {
          showToast('Fehler beim Löschen.');
        }
      };

      container.appendChild(row);
    });
  } catch (err) {
    console.error('Error loading shares:', err);
  }
}

// Load Branding configurations dynamically
async function loadBranding() {
  try {
    const res = await fetch('/api/public/branding');
    const data = await res.json();
    
    appBrandingUrl = data.appUrl || '';

    // Update Document Title
    document.title = data.tabName || 'myCloud';

    // Toggle forgot password link visibility based on SMTP configuration & test status
    isEmailConfigured = data.emailConfigured || false;
    const forgotPasswordContainer = document.getElementById('forgot-password-container');
    if (forgotPasswordContainer) {
      forgotPasswordContainer.style.display = isEmailConfigured ? 'block' : 'none';
    }

    // Update Header and Login logos
    const logoTexts = document.querySelectorAll('.logo');
    logoTexts.forEach(logo => {
      const name = data.name || 'myCloud';
      const prefix = name.length > 2 ? name.slice(0, 2) : name;
      const suffix = name.length > 2 ? name.slice(2) : '';
      logo.innerHTML = `<i data-lucide="cloud"></i> ${prefix}<span>${suffix}</span>`;
    });
    lucide.createIcons();

    // Update Favicon link
    let favicon = document.querySelector('link[rel="icon"]');
    if (!favicon) {
      favicon = document.createElement('link');
      favicon.rel = 'icon';
      document.head.appendChild(favicon);
    }
    if (data.hasIcon) {
      favicon.href = `/api/public/branding/icon?t=${Date.now()}`;
    } else {
      favicon.href = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" fill="%2300d2ff"><path d="M75,45 C75,32 64,22 50,22 C40,22 31,28 27,37 C25,36 23,36 21,36 C10,36 2,44 2,55 C2,66 10,74 21,74 L75,74 C85,74 93,66 93,55 C93,45 85,37 75,37 C75,37 75,45 75,45 Z"/></svg>';
    }
  } catch (err) {
    console.error('Error loading branding:', err);
  }
}

/* ==========================================================================
   INITIALIZATION
   ========================================================================== */
window.onload = () => {
  // Load branding info
  loadBranding();

  // Check reset password URL param
  const urlParams = new URLSearchParams(window.location.search);
  const resetToken = urlParams.get('token');
  if (resetToken) {
    window.history.replaceState({}, document.title, "/");
    handleResetPasswordFlow(resetToken);
  }

  checkAuthStatus();

  // Layout View Mode Switcher
  const gridBtn = document.getElementById('view-grid-btn');
  const listBtn = document.getElementById('view-list-btn');

  const updateViewModeButtons = () => {
    if (viewMode === 'list') {
      listBtn.classList.add('active');
      gridBtn.classList.remove('active');
    } else {
      gridBtn.classList.add('active');
      listBtn.classList.remove('active');
    }
  };

  if (gridBtn && listBtn) {
    updateViewModeButtons();
    gridBtn.onclick = () => {
      viewMode = 'grid';
      localStorage.setItem('viewMode', 'grid');
      updateViewModeButtons();
      renderFiles(renderedFilesList);
    };
    listBtn.onclick = () => {
      viewMode = 'list';
      localStorage.setItem('viewMode', 'list');
      updateViewModeButtons();
      renderFiles(renderedFilesList);
    };
  }

  // Admin back button
  const adminBackBtn = document.getElementById('admin-back-to-dashboard-btn');
  if (adminBackBtn) {
    adminBackBtn.onclick = () => {
      window.location.hash = '#dashboard';
    };
  }

  // Avatar Upload Listener
  const avatarInput = document.getElementById('avatar-upload-input');
  if (avatarInput) {
    avatarInput.onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;

      const formData = new FormData();
      formData.append('avatar', file);

      showToast('Lade Profilbild hoch...');

      try {
        const res = await fetch('/api/settings/avatar', {
          method: 'POST',
          body: formData,
        });

        const data = await res.json();
        if (res.ok) {
          showToast('Profilbild erfolgreich geändert!');
          // Cache busting forcing browser image reload
          const t = Date.now();
          document.getElementById('nav-avatar').src = `/api/users/${currentUser.id}/avatar?t=${t}`;
          document.getElementById('settings-avatar-preview').src = `/api/users/${currentUser.id}/avatar?t=${t}`;
        } else {
          showToast(data.error || 'Fehler beim Hochladen.');
        }
      } catch (err) {
        showToast('Verbindungsfehler beim Avatar-Upload.');
      }
    };
  }
};

// EuroOffice Editor logic
let docEditorInstance = null;

function loadOfficeScript(publicUrl) {
  return new Promise((resolve, reject) => {
    if (window.DocsAPI) return resolve();
    const script = document.createElement('script');
    script.src = `${publicUrl}/web-apps/apps/api/documents/api.js`;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("EuroOffice Script konnte nicht geladen werden."));
    document.head.appendChild(script);
  });
}

async function openOfficeEditor(fileId, fileName) {
  showToast('Bereite Office-Editor vor...');

  try {
    const res = await fetch(`/api/eurooffice/config/${fileId}`);
    if (!res.ok) {
      const err = await res.json();
      showToast(err.error || 'Fehler beim Laden der Office-Konfiguration.');
      return;
    }

    const { publicUrl, config } = await res.json();

    // Dynamically load EuroOffice Javascript API
    await loadOfficeScript(publicUrl);

    // Title update
    document.getElementById('office-editor-title').innerHTML = `<i data-lucide="file-text"></i> ${fileName}`;
    lucide.createIcons();

    // Clear previous editor
    const container = document.getElementById('office-iframe-container');
    container.innerHTML = '<div id="office-iframe-placeholder" style="width:100%; height:100%;"></div>';

    // Show editor UI overlay
    document.getElementById('office-editor-overlay').style.display = 'block';

    // Initialize DocsAPI Editor
    docEditorInstance = new DocsAPI.DocEditor("office-iframe-placeholder", config);

  } catch (err) {
    console.error('Error opening office editor:', err);
    showToast('EuroOffice Server ist momentan nicht erreichbar.');
  }
}

// Close and save Office Editor
document.getElementById('close-office-editor-btn').onclick = () => {
  if (docEditorInstance) {
    docEditorInstance.destroyEditor();
    docEditorInstance = null;
  }
  document.getElementById('office-editor-overlay').style.display = 'none';
  // Reload files to reflect changes
  loadFiles(currentFolderId);
};

// 2FA Setup & Toggle logic
const email2faToggle = document.getElementById('2fa-email-toggle');
if (email2faToggle) {
  email2faToggle.onchange = async () => {
    const enabled = email2faToggle.checked;
    try {
      const res = await fetch('/api/settings/2fa/email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      const data = await res.json();
      if (!res.ok) {
        showToast(data.error || 'Fehler beim Ändern des E-Mail-2FA-Status.');
        email2faToggle.checked = !enabled; // Reset checkbox state
      } else {
        showToast(enabled ? 'E-Mail-2FA erfolgreich aktiviert.' : 'E-Mail-2FA deaktiviert.');
      }
    } catch (e) {
      showToast('Netzwerkfehler.');
      email2faToggle.checked = !enabled;
    }
  };
}

const totp2faToggle = document.getElementById('2fa-totp-toggle');
const totpSetupOverlay = document.getElementById('totp-setup-overlay');
const closeTotpBtn = document.getElementById('close-totp-setup-btn');
const cancelTotpBtn = document.getElementById('cancel-totp-setup-btn');
const totpForm = document.getElementById('totp-confirm-form');

if (totp2faToggle) {
  totp2faToggle.onchange = async () => {
    const enabled = totp2faToggle.checked;
    
    if (enabled) {
      // Trigger setup
      try {
        const res = await fetch('/api/settings/2fa/totp/setup', { method: 'POST' });
        const data = await res.json();
        if (res.ok) {
          document.getElementById('totp-qr-image').src = data.qrCodeUrl;
          document.getElementById('totp-secret-text').textContent = data.secret;
          document.getElementById('totp-confirm-code').value = '';
          totpSetupOverlay.style.display = 'block';
        } else {
          showToast(data.error || 'Fehler beim Setup.');
          totp2faToggle.checked = false;
        }
      } catch (e) {
        showToast('Netzwerkfehler beim TOTP-Setup.');
        totp2faToggle.checked = false;
      }
    } else {
      // Disable
      if (confirm('Möchtest du 2FA per Authenticator App wirklich deaktivieren?')) {
        try {
          const res = await fetch('/api/settings/2fa/totp/disable', { method: 'POST' });
          if (res.ok) {
            showToast('Authenticator-2FA deaktiviert.');
          } else {
            showToast('Fehler beim Deaktivieren.');
            totp2faToggle.checked = true;
          }
        } catch (e) {
          showToast('Netzwerkfehler.');
          totp2faToggle.checked = true;
        }
      } else {
        totp2faToggle.checked = true;
      }
    }
  };
}

// Close/Cancel TOTP setup
const cancelTotpSetup = () => {
  totpSetupOverlay.style.display = 'none';
  if (totp2faToggle) totp2faToggle.checked = false;
};

if (closeTotpBtn) closeTotpBtn.onclick = cancelTotpSetup;
if (cancelTotpBtn) cancelTotpBtn.onclick = cancelTotpSetup;

if (totpForm) {
  totpForm.onsubmit = async (e) => {
    e.preventDefault();
    const code = document.getElementById('totp-confirm-code').value.trim();
    
    try {
      const res = await fetch('/api/settings/2fa/totp/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code })
      });

      const data = await res.json();
      if (res.ok) {
        showToast('Authenticator App erfolgreich verknüpft!');
        totpSetupOverlay.style.display = 'none';
        if (totp2faToggle) totp2faToggle.checked = true;
      } else {
        showToast(data.error || 'Bestätigung fehlgeschlagen. Überprüfe den Code.');
        totp2faToggle.checked = false;
      }
    } catch (e) {
      showToast('Verbindungsfehler.');
      totp2faToggle.checked = false;
    }
  };
}
