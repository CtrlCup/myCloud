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
let gridSizeIndex = parseInt(localStorage.getItem('gridSizeIndex') || '2');
let listSizeIndex = parseInt(localStorage.getItem('listSizeIndex') || '2');
let isEmailConfigured = false;
let clickTimeout = null;
let clickTimeoutFileId = null;

let clipboardFileIds = [];
let clipboardAction = null; // 'copy' or 'cut'

// Real-time collaboration state
let collabSocket = null;
let collabUserColor = null;
let collabUserDecorations = {}; // userId -> decoration IDs
let isApplyingRemoteEdit = false;
let autoSaveDebounceTimeout = null;


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

function showConfirmDialog(title, message) {
  return new Promise((resolve) => {
    const overlay = document.getElementById('custom-confirm-modal-overlay');
    const titleEl = document.getElementById('custom-confirm-title');
    const messageEl = document.getElementById('custom-confirm-message');
    const cancelBtn = document.getElementById('cancel-custom-confirm-btn');
    const submitBtn = document.getElementById('submit-custom-confirm-btn');
    const closeBtn = document.getElementById('close-custom-confirm-btn');

    titleEl.textContent = title || 'Bestätigung erforderlich';
    messageEl.textContent = message || '';

    overlay.classList.add('active');

    const cleanup = (result) => {
      overlay.classList.remove('active');
      cancelBtn.onclick = null;
      submitBtn.onclick = null;
      closeBtn.onclick = null;
      resolve(result);
    };

    cancelBtn.onclick = () => cleanup(false);
    closeBtn.onclick = () => cleanup(false);
    submitBtn.onclick = () => cleanup(true);
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
      updateDisplayNameUI();
      
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
      } else if (hash === '#admin') {
        showView('admin');
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
  currentViewName = viewName;
  applyBackgrounds(viewName);
  if (viewName === 'auth') {
    authView.style.display = 'flex';
    dashboardView.style.display = 'none';
    settingsView.style.display = 'none';
    settingsView.classList.remove('active');
    if (adminView) {
      adminView.style.display = 'none';
      adminView.classList.remove('active');
    }
  } else if (viewName === 'dashboard') {
    authView.style.display = 'none';
    dashboardView.style.display = 'flex';
    settingsView.style.display = 'none';
    settingsView.classList.remove('active');
    if (adminView) {
      adminView.style.display = 'none';
      adminView.classList.remove('active');
    }
    loadFiles(currentFolderId);
  } else if (viewName === 'settings') {
    authView.style.display = 'none';
    dashboardView.style.display = 'flex';
    settingsView.style.display = 'flex';
    settingsView.classList.add('active');
    if (adminView) {
      adminView.style.display = 'none';
      adminView.classList.remove('active');
    }
    loadSettings();
  } else if (viewName === 'admin') {
    if (currentUser && currentUser.role === 'admin') {
      authView.style.display = 'none';
      dashboardView.style.display = 'flex';
      settingsView.style.display = 'none';
      settingsView.classList.remove('active');
      if (adminView) {
        adminView.style.display = 'flex';
        adminView.classList.add('active');
        // Reset to "Design & Branding" tab as default
        document.querySelectorAll('#admin-nav .settings-nav-item').forEach(i => i.classList.remove('active'));
        document.querySelectorAll('#admin-view .settings-section').forEach(s => s.classList.remove('active'));
        const defaultNavItem = document.querySelector('#admin-nav .settings-nav-item[data-section="admin-branding"]');
        const defaultSection = document.getElementById('admin-branding');
        if (defaultNavItem) defaultNavItem.classList.add('active');
        if (defaultSection) defaultSection.classList.add('active');
      }
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
    
    // Switch to account settings section inside settings layout
    document.querySelectorAll('.settings-nav-item').forEach(i => i.classList.remove('active'));
    document.querySelectorAll('.settings-section').forEach(s => s.classList.remove('active'));
    
    const accountTab = document.querySelector('[data-section="account-settings"]');
    const accountSection = document.getElementById('account-settings');
    if (accountTab && accountSection) {
      accountTab.classList.add('active');
      accountSection.classList.add('active');
    }
  };
}

const dropdownAdminBtn = document.getElementById('dropdown-admin-btn');
if (dropdownAdminBtn) {
  dropdownAdminBtn.onclick = (e) => {
    e.preventDefault();
    userDropdownMenu.classList.remove('show');
    window.location.hash = '#admin';
  };
}

function closeSettingsOrAdmin() {
  if (window.history.length > 1) {
    window.history.back();
  } else {
    window.location.hash = '#dashboard';
  }
}

document.getElementById('back-to-dashboard-btn').onclick = () => {
  closeSettingsOrAdmin();
};

document.getElementById('logo-btn').onclick = (e) => {
  e.preventDefault();
  currentFolderId = null;
  breadcrumbsHistory = [];
  window.location.hash = '#dashboard';
  showView('dashboard');
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

function applyLayoutDensity() {
  const grid = document.getElementById('file-grid');
  if (!grid) return;

  grid.classList.remove('grid-xs', 'grid-sm', 'grid-md', 'grid-lg', 'grid-xl');
  grid.classList.remove('list-xs', 'list-sm', 'list-md', 'list-lg', 'list-xl');

  if (viewMode === 'grid') {
    const sizeClasses = ['grid-xs', 'grid-sm', 'grid-md', 'grid-lg', 'grid-xl'];
    grid.classList.add(sizeClasses[gridSizeIndex]);
  } else {
    const sizeClasses = ['list-xs', 'list-sm', 'list-md', 'list-lg', 'list-xl'];
    grid.classList.add(sizeClasses[listSizeIndex]);
  }
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
  applyLayoutDensity();

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
    
    let iconName = 'file';
    if (file.is_folder) {
      iconName = 'folder';
    } else {
      const ext = file.name.split('.').pop().toLowerCase();
      if (['docx', 'doc', 'odt', 'rtf', 'pdf'].includes(ext)) {
        iconName = 'file-text';
      } else if (['xlsx', 'xls', 'ods', 'csv'].includes(ext)) {
        iconName = 'file-spreadsheet';
      } else if (['pptx', 'ppt', 'odp'].includes(ext)) {
        iconName = 'presentation';
      } else if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'heic', 'heif', 'cr2', 'nef', 'dng', 'arw', 'orf', 'rw2', 'pef', 'raf'].includes(ext)) {
        iconName = 'file-image';
      } else if (['mp4', 'webm', 'ogg', 'mov', 'avi', 'mkv', 'flv', 'wmv', 'm4v'].includes(ext)) {
        iconName = 'file-video';
      } else if (['txt', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'html', 'xml', 'css', 'scss', 'less', 'py', 'json', 'yaml', 'yml', 'c', 'cpp', 'h', 'hpp', 'cs', 'go', 'rs', 'java', 'sh', 'bash', 'md', 'php', 'rb', 'sql'].includes(ext)) {
        iconName = 'file-code';
      }
    }

    const ext = file.is_folder ? '' : file.name.split('.').pop().toLowerCase();
    const isImg = !file.is_folder && ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'heic', 'heif', 'cr2', 'nef', 'dng', 'arw', 'orf', 'rw2', 'pef', 'raf'].includes(ext);
    const isVid = !file.is_folder && ['mp4', 'webm', 'ogg', 'mov', 'avi', 'mkv', 'flv', 'wmv', 'm4v'].includes(ext);

    let iconHTML = `<i data-lucide="${iconName}"></i>`;
    if (isImg || isVid) {
      const thumbUrl = `/api/files/thumbnail/${file.id}`;
      iconHTML = `<img src="${thumbUrl}" style="width: 100%; height: 100%; object-fit: cover; border-radius: var(--radius-sm);" onerror="this.style.display='none'; this.nextElementSibling.style.display='block';">
                  <i data-lucide="${iconName}" style="display: none;"></i>`;
    }

    const extVal = file.is_folder ? 'Ordner' : (file.name.split('.').pop().toLowerCase() || 'Datei');
    const sizeStr = formatBytes(file.size);

    item.innerHTML = `
      <div class="file-item-checkbox"></div>
      <div class="file-icon" style="display: flex; align-items: center; justify-content: center; overflow: hidden; width: 40px; height: 40px;">${iconHTML}</div>
      <div style="display: flex; flex-direction: column; flex: 1; min-width: 0; gap: 2px;">
        <div class="file-name" title="${file.name}" style="margin: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${file.name}</div>
        <div class="file-meta-list" style="display: none; align-items: center; gap: 0.5rem; font-size: 0.75rem; color: var(--color-text-muted);">
          <span class="file-ext-label" style="text-transform: uppercase; font-weight: 600; font-size: 0.7rem; background: rgba(var(--color-accent-rgb), 0.1); color: var(--color-accent); padding: 1px 4px; border-radius: 3px;">${extVal}</span>
          <span>•</span>
          <span>${sizeStr}</span>
        </div>
      </div>
      <div class="file-info">${file.is_folder ? 'Ordner' : sizeStr}</div>
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
      
      const ext = file.name.split('.').pop().toLowerCase();
      const officeExts = ['docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp'];

      if (clickTimeout) {
        clearTimeout(clickTimeout);
        clickTimeout = null;
      }

      const runSelection = () => {
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
          // Single click: select only this file (and clear other selections)
          selectedFileIds = [file.id];
          lastSelectedId = file.id;
          updateMultiSelectUI();
        }
      };

      clickTimeoutFileId = file.id;
      clickTimeout = setTimeout(() => {
        runSelection();
        clickTimeout = null;
        clickTimeoutFileId = null;
      }, 200);
    };

    // Double Click handler for Navigation / Opening file
    item.ondblclick = (e) => {
      if (clickTimeout) {
        clearTimeout(clickTimeout);
        clickTimeout = null;
      }
      if (e.target.closest('.btn-action-more') || e.target.closest('.file-actions')) {
        return;
      }

      if (file.is_folder) {
        breadcrumbsHistory.push({ id: file.id, name: file.name });
        loadFiles(file.id);
      } else {
        const ext = file.name.split('.').pop().toLowerCase();
        
        // Define groupings
        const imageExts = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'heic', 'heif', 'cr2', 'nef', 'dng', 'arw', 'orf', 'rw2', 'pef', 'raf'];
        const videoExts = ['mp4', 'webm', 'ogg', 'mov', 'avi', 'mkv', 'flv', 'wmv', 'm4v'];
        const codeExts = ['txt', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'html', 'xml', 'css', 'scss', 'less', 'py', 'json', 'yaml', 'yml', 'c', 'cpp', 'h', 'hpp', 'cs', 'go', 'rs', 'java', 'sh', 'bash', 'md', 'php', 'rb', 'sql'];
        const officeExts = ['docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp'];

        if (imageExts.includes(ext)) {
          openImageViewer(file.id, file.name);
        } else if (videoExts.includes(ext)) {
          openVideoViewer(file.id, file.name);
        } else if (ext === 'pdf') {
          openPdfViewer(file.id, file.name);
        } else if (codeExts.includes(ext)) {
          openCodeEditor(file.id, file.name);
        } else if (officeExts.includes(ext)) {
          openOfficeEditor(file.id, file.name);
        } else {
          window.location.href = `/api/files/download/${file.id}`;
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
if (document.getElementById('new-file-btn')) {
  document.getElementById('new-file-btn').onclick = () => createNewEmptyFile();
}

// Clear selections on empty dashboard background click
if (dashboardView) {
  dashboardView.addEventListener('click', (e) => {
    if (!e.target.closest('.file-item') && !e.target.closest('.toolbar') && !e.target.closest('#multi-actions-bar') && !e.target.closest('.context-menu') && !e.target.closest('.modal')) {
      clearSelection();
    }
  });
}

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

// Custom file creation dialog helper using the select-type modal
function showCreateFilePrompt() {
  return new Promise((resolve) => {
    const overlay = document.getElementById('create-file-modal-overlay');
    const form = document.getElementById('create-file-modal-form');
    const nameInput = document.getElementById('create-file-modal-name');
    const typeSelect = document.getElementById('create-file-modal-type');
    const cancelBtn = document.getElementById('cancel-create-file-modal-btn');
    const closeBtn = document.getElementById('close-create-file-modal-btn');

    nameInput.value = '';
    
    const selectTemplate = (value) => {
      typeSelect.value = value;
      document.querySelectorAll('.template-tile').forEach(tile => {
        if (tile.getAttribute('data-value') === value) {
          tile.classList.add('active');
        } else {
          tile.classList.remove('active');
        }
      });
    };

    // Default selection
    selectTemplate('txt');

    // Add click listeners to tiles
    const tiles = document.querySelectorAll('.template-tile');
    tiles.forEach(tile => {
      tile.onclick = () => {
        selectTemplate(tile.getAttribute('data-value'));
      };
    });

    const knownCodeExts = ['.txt', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.html', '.xml', '.css', '.scss', '.less', '.py', '.json', '.yaml', '.yml', '.c', '.cpp', '.h', '.hpp', '.cs', '.go', '.rs', '.java', '.sh', '.bash', '.md', '.php', '.rb', '.sql'];

    // Auto-detection of extension on typing
    nameInput.oninput = () => {
      const name = nameInput.value.trim();
      const parts = name.split('.');
      if (parts.length > 1) {
        const ext = '.' + parts.pop().toLowerCase();
        if (ext === '.txt') {
          selectTemplate('txt');
        } else if (ext === '.docx') {
          selectTemplate('docx');
        } else if (ext === '.xlsx') {
          selectTemplate('xlsx');
        } else if (ext === '.pptx') {
          selectTemplate('pptx');
        } else if (knownCodeExts.includes(ext)) {
          selectTemplate('codex');
        } else {
          // Extension is not recognized as any of the primary templates -> "Andere" (other)
          selectTemplate('other');
        }
      }
    };

    overlay.classList.add('active');
    nameInput.focus();

    const cleanup = () => {
      overlay.classList.remove('active');
      form.onsubmit = null;
      cancelBtn.onclick = null;
      closeBtn.onclick = null;
      nameInput.oninput = null;
      tiles.forEach(t => t.onclick = null);
    };

    form.onsubmit = (e) => {
      e.preventDefault();
      const name = nameInput.value.trim();
      const type = typeSelect.value;
      cleanup();
      resolve({ name, type });
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

async function createNewEmptyFile() {
  const result = await showCreateFilePrompt();
  if (!result) return;
  const { name, type } = result;

  if (type === 'note') {
    await showCreateNoteModal(name);
    return;
  }

  try {
    const res = await fetch('/api/files/create-empty', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, type, parentId: currentFolderId }),
    });

    if (res.ok) {
      showToast('Datei erfolgreich erstellt.');
      const newFile = await res.json();
      loadFiles(currentFolderId);
      
      const ext = newFile.name.split('.').pop().toLowerCase();
      const codeExts = ['txt', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'html', 'xml', 'css', 'scss', 'less', 'py', 'json', 'yaml', 'yml', 'c', 'cpp', 'h', 'hpp', 'cs', 'go', 'rs', 'java', 'sh', 'bash', 'md', 'php', 'rb', 'sql'];
      const officeExts = ['docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp'];
      
      if (codeExts.includes(ext) || type === 'codex' || type === 'txt') {
        openCodeEditor(newFile.id, newFile.name);
      } else if (officeExts.includes(ext)) {
        openOfficeEditor(newFile.id, newFile.name);
      }
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
  const files = e.target.files;
  if (files.length === 0) return;

  await uploadMultipleFiles(files);
};

const folderUploadInput = document.getElementById('folder-upload-input');
if (folderUploadInput) {
  folderUploadInput.onchange = async (e) => {
    const files = e.target.files;
    if (files.length === 0) return;
    await uploadMultipleFiles(files);
  };
}

// Global Upload Queue State
let currentUploadQueue = [];
let uploadActive = false;
let uploadStartTime = 0;

function uploadSingleFileWithXHR(file, parentId, onProgress, onDone, onError, onCreatedXHR) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    if (onCreatedXHR) {
      onCreatedXHR(xhr);
    }
    const formData = new FormData();
    formData.append('file', file);
    if (parentId) {
      formData.append('parentId', parentId);
    }

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        onProgress(event.loaded, event.total);
      }
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        let response = {};
        try { response = JSON.parse(xhr.responseText); } catch(e){}
        onDone(response);
        resolve(response);
      } else {
        let errorMsg = 'Fehler beim Hochladen.';
        try {
          const err = JSON.parse(xhr.responseText);
          errorMsg = err.error || errorMsg;
        } catch(e){}
        onError(errorMsg);
        reject(new Error(errorMsg));
      }
    };

    xhr.onabort = () => {
      onError('Upload abgebrochen.');
      reject(new Error('Upload abgebrochen.'));
    };

    xhr.onerror = () => {
      onError('Netzwerkfehler.');
      reject(new Error('Netzwerkfehler.'));
    };

    xhr.open('POST', '/api/files/upload');
    xhr.send(formData);
  });
}

function formatTime(sec) {
  if (sec === Infinity || isNaN(sec) || sec < 0) return '--';
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const remainingSec = sec % 60;
  return `${min}m ${remainingSec}s`;
}

function updateUploadUI() {
  const listContainer = document.getElementById('upload-panel-list');
  if (!listContainer) return;

  listContainer.innerHTML = '';

  let totalQueueSize = 0;
  let totalUploaded = 0;
  let doneCount = 0;

  currentUploadQueue.forEach((item, index) => {
    totalQueueSize += item.size;
    if (item.status === 'done') {
      totalUploaded += item.size;
      doneCount++;
    } else if (item.status === 'uploading') {
      totalUploaded += item.uploaded;
    }

    // Create item row
    const row = document.createElement('div');
    row.style.display = 'flex';
    row.style.flexDirection = 'column';
    row.style.gap = '0.25rem';
    row.style.padding = '0.5rem 0';
    row.style.borderBottom = '1px solid var(--color-border)';

    let statusText = 'Wartend...';
    let statusColor = 'var(--color-text-muted)';
    let progressPercent = 0;

    if (item.status === 'uploading') {
      progressPercent = item.size > 0 ? Math.round((item.uploaded / item.size) * 100) : 0;
      statusText = `Lädt hoch... ${progressPercent}%`;
      statusColor = 'var(--color-primary)';
    } else if (item.status === 'done') {
      statusText = 'Hochgeladen';
      statusColor = '#00e676';
    } else if (item.status === 'error') {
      statusText = item.error || 'Fehler';
      statusColor = '#ff5555';
    }

    row.innerHTML = `
      <div style="display: flex; justify-content: space-between; align-items: center; font-size: 0.85rem; gap: 0.5rem;">
        <span style="font-weight: 500; text-overflow: ellipsis; overflow: hidden; white-space: nowrap; max-width: 200px;" title="${item.name}">${item.name}</span>
        <div style="display: flex; align-items: center; gap: 0.5rem; flex-shrink: 0;">
          <span style="font-size: 0.75rem; color: ${statusColor}; font-weight: 500;">${statusText}</span>
          <button class="delete-upload-item-btn" data-index="${index}" style="border: none; background: transparent; cursor: pointer; padding: 0.1rem; display: flex; align-items: center; justify-content: center; opacity: 0.6; transition: opacity 0.2s;" title="Aus Liste entfernen">
            <i data-lucide="x" style="width: 14px; height: 14px; color: var(--color-text);"></i>
          </button>
        </div>
      </div>
      ${item.status === 'uploading' ? `
        <div style="width: 100%; height: 4px; background: var(--color-border); border-radius: 2px; overflow: hidden; margin-top: 0.25rem;">
          <div style="width: ${progressPercent}%; height: 100%; background: var(--color-primary); border-radius: 2px;"></div>
        </div>
      ` : ''}
    `;

    const deleteBtn = row.querySelector('.delete-upload-item-btn');
    if (deleteBtn) {
      deleteBtn.onclick = (e) => {
        e.stopPropagation();
        const idx = parseInt(deleteBtn.getAttribute('data-index'));
        const item = currentUploadQueue[idx];
        if (item) {
          if (item.status === 'uploading' && item.xhr) {
            item.status = 'cancelled';
            try {
              item.xhr.abort();
            } catch (err) {
              console.error('Error aborting upload:', err);
            }
          }
          currentUploadQueue.splice(idx, 1);
        }
        updateUploadUI();
        if (currentUploadQueue.length === 0) {
          const container = document.getElementById('upload-container');
          if (container) container.style.display = 'none';
        } else {
          checkAndTriggerAutoHide();
        }
      };
    }

    listContainer.appendChild(row);
  });

  // Summary counts
  document.getElementById('upload-panel-summary').textContent = `${doneCount} von ${currentUploadQueue.length} Datei(en) fertig`;

  // Total percentage
  const totalPercent = totalQueueSize > 0 ? Math.round((totalUploaded / totalQueueSize) * 100) : 0;
  document.getElementById('upload-panel-percent').textContent = `${totalPercent}%`;
  document.getElementById('upload-panel-progress-bar').style.width = `${totalPercent}%`;

  // Calculate speed and ETA
  const elapsedSeconds = (Date.now() - uploadStartTime) / 1000;
  let speed = 0;
  if (elapsedSeconds > 0) {
    speed = totalUploaded / elapsedSeconds;
  }

  const speedText = document.getElementById('upload-panel-speed');
  if (speedText) {
    speedText.textContent = `${formatBytes(speed)}/s`;
  }

  const etaText = document.getElementById('upload-panel-eta');
  if (etaText) {
    if (totalPercent >= 100) {
      etaText.textContent = 'Abgeschlossen';
    } else if (speed > 0) {
      const remainingBytes = totalQueueSize - totalUploaded;
      const etaSeconds = Math.round(remainingBytes / speed);
      etaText.textContent = `verbleibend: ${formatTime(etaSeconds)}`;
    } else {
      etaText.textContent = 'verbleibend: berechne...';
    }
  }

  // Update Trigger Button
  const text = document.getElementById('upload-status-text');
  const circle = document.getElementById('upload-status-circle');
  const icon = document.getElementById('upload-status-icon');

  if (text && circle && icon) {
    if (uploadActive) {
      text.textContent = `Hochladen... ${totalPercent}%`;
      text.style.color = 'var(--color-text)';
      circle.style.border = '3px solid var(--color-border)';
      circle.style.borderTopColor = 'var(--color-primary)';
      icon.setAttribute('data-lucide', 'upload-cloud');
    } else {
      const errorItems = currentUploadQueue.filter(item => item.status === 'error');
      if (errorItems.length > 0) {
        circle.style.border = '3px solid #ff5555';
        circle.style.borderTopColor = '#ff5555';
        icon.setAttribute('data-lucide', 'alert-circle');
        text.textContent = `${errorItems.length} Fehler`;
        text.style.color = '#ff5555';
      } else {
        circle.style.border = '3px solid #00e676';
        circle.style.borderTopColor = '#00e676';
        icon.setAttribute('data-lucide', 'check');
        text.textContent = 'Fertig';
        text.style.color = '#00e676';
      }
    }
  }

  lucide.createIcons();
}

const resolvedFolderCache = {};

async function resolveFolderSegments(segments, rootParentId) {
  const cacheKey = `${rootParentId}:${segments.join('/')}`;
  if (resolvedFolderCache[cacheKey]) {
    return resolvedFolderCache[cacheKey];
  }

  let currentParentId = rootParentId;
  const currentPathSegments = [];

  for (const segment of segments) {
    currentPathSegments.push(segment);
    const stepKey = `${rootParentId}:${currentPathSegments.join('/')}`;
    
    if (resolvedFolderCache[stepKey]) {
      currentParentId = resolvedFolderCache[stepKey];
      continue;
    }

    // Check if folder already exists in the current directory
    let foundId = null;
    try {
      const checkRes = await fetch(`/api/files/list` + (currentParentId ? `?parentId=${currentParentId}` : ''));
      if (checkRes.ok) {
        const list = await checkRes.json();
        const found = list.find(f => f.is_folder && f.name === segment);
        if (found) {
          foundId = found.id;
        }
      }
    } catch(e) {
      console.error('Error listing directory during segment resolution:', e);
    }

    if (foundId) {
      currentParentId = foundId;
    } else {
      // Create the folder
      try {
        const createRes = await fetch('/api/files/folder', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: segment, parentId: currentParentId })
        });
        if (createRes.ok) {
          const newFolder = await createRes.json();
          currentParentId = newFolder.id;
        } else {
          throw new Error('Failed to create folder segment.');
        }
      } catch(e) {
        console.error('Error creating folder segment:', e);
        break;
      }
    }

    resolvedFolderCache[stepKey] = currentParentId;
  }

  resolvedFolderCache[cacheKey] = currentParentId;
  return currentParentId;
}

async function uploadMultipleFiles(filesList) {
  const trigger = document.getElementById('upload-status-trigger');
  const panel = document.getElementById('upload-details-panel');
  const circle = document.getElementById('upload-status-circle');
  const icon = document.getElementById('upload-status-icon');
  const text = document.getElementById('upload-status-text');

  // Reset trigger state if we're starting a new batch
  if (!uploadActive) {
    currentUploadQueue = [];
    if (circle && icon && text) {
      circle.style.border = '3px solid var(--color-border)';
      circle.style.borderTopColor = 'var(--color-primary)';
      icon.setAttribute('data-lucide', 'upload-cloud');
      text.textContent = 'Hochladen...';
      text.style.color = 'var(--color-text)';
    }
  }

  const newUploads = Array.from(filesList).map(file => ({
    name: file.name,
    size: file.size,
    uploaded: 0,
    status: 'pending',
    error: null,
    fileObj: file
  }));

  currentUploadQueue = currentUploadQueue.concat(newUploads);

  const container = document.getElementById('upload-container');
  if (container) {
    container.style.display = 'block';
    container.style.opacity = '1';
    container.style.transform = 'scale(1)';
    // Start minimized/pill state at bottom right
    container.style.borderRadius = '50px';
    container.style.width = '200px';
    container.style.height = '44px';
  }
  if (trigger) {
    trigger.style.opacity = '1';
    trigger.style.pointerEvents = 'auto';
    trigger.style.zIndex = '2';
  }
  if (panel) {
    panel.style.opacity = '0';
    panel.style.pointerEvents = 'none';
    panel.style.zIndex = '1';
  }

  updateUploadUI();

  if (uploadActive) {
    return;
  }

  uploadActive = true;
  uploadStartTime = Date.now();

  while (uploadActive) {
    const uploadItem = currentUploadQueue.find(item => item.status === 'pending');
    if (!uploadItem) break;

    uploadItem.status = 'uploading';
    updateUploadUI();

    try {
      let uploadParentId = currentFolderId;
      if (uploadItem.fileObj.webkitRelativePath) {
        const pathParts = uploadItem.fileObj.webkitRelativePath.split('/');
        if (pathParts.length > 1) {
          pathParts.pop(); // Remove filename
          uploadParentId = await resolveFolderSegments(pathParts, currentFolderId);
        }
      }

      await uploadSingleFileWithXHR(
        uploadItem.fileObj,
        uploadParentId,
        (loaded, total) => {
          uploadItem.uploaded = loaded;
          updateUploadUI();
        },
        (res) => {
          uploadItem.status = 'done';
          uploadItem.uploaded = uploadItem.size;
          uploadItem.xhr = null;
          updateUploadUI();
        },
        (errMsg) => {
          if (uploadItem.status !== 'cancelled') {
            uploadItem.status = 'error';
            uploadItem.error = errMsg;
          }
          uploadItem.xhr = null;
          updateUploadUI();
        },
        (xhrRef) => {
          uploadItem.xhr = xhrRef;
        }
      );
    } catch (e) {
      if (uploadItem.status !== 'cancelled') {
        uploadItem.status = 'error';
        uploadItem.error = e.message;
      }
      uploadItem.xhr = null;
      updateUploadUI();
    }
  }

  uploadActive = false;
  
  updateUploadUI();
  loadFiles(currentFolderId);
  showToast('Alle Datei-Uploads abgeschlossen!');

  checkAndTriggerAutoHide();
}

function setUploadWidgetState(state) {
  const container = document.getElementById('upload-container');
  const trigger = document.getElementById('upload-status-trigger');
  const panel = document.getElementById('upload-details-panel');
  if (!container || !trigger || !panel) return;

  if (state === 'maximized') {
    // Morph to maximized details view
    trigger.style.opacity = '0';
    trigger.style.pointerEvents = 'none';
    trigger.style.zIndex = '1';
    
    panel.style.opacity = '1';
    panel.style.pointerEvents = 'auto';
    panel.style.zIndex = '2';
    
    // Animate container size and shape
    container.style.borderRadius = '12px';
    container.style.width = '480px';
    container.style.height = '380px';
  } else {
    // Morph to minimized pill view
    panel.style.opacity = '0';
    panel.style.pointerEvents = 'none';
    panel.style.zIndex = '1';
    
    trigger.style.opacity = '1';
    trigger.style.pointerEvents = 'auto';
    trigger.style.zIndex = '2';
    
    // Animate container size and shape
    container.style.borderRadius = '50px';
    container.style.width = '200px';
    container.style.height = '44px';
  }
}

function checkAndTriggerAutoHide() {
  if (uploadActive) return;

  const hasErrors = currentUploadQueue.some(item => item.status === 'error');
  if (hasErrors) {
    // Keep widget open if there is any error
    return;
  }

  // Delay of 3 seconds then hide widget
  setTimeout(() => {
    if (!uploadActive && !currentUploadQueue.some(item => item.status === 'error')) {
      const container = document.getElementById('upload-container');
      if (container) {
        container.style.opacity = '0';
        container.style.transform = 'scale(0.8)';
        setTimeout(() => {
          container.style.display = 'none';
        }, 300);
      }
    }
  }, 3000);
}

// Upload Panel Toggle Event Listeners
const uploadTrigger = document.getElementById('upload-status-trigger');
const closeUploadPanelBtn = document.getElementById('close-upload-panel-btn');

if (uploadTrigger) {
  uploadTrigger.onclick = () => {
    setUploadWidgetState('maximized');
  };
}

if (closeUploadPanelBtn) {
  closeUploadPanelBtn.onclick = (e) => {
    e.stopPropagation();
    setUploadWidgetState('minimized');
  };
}

// Action: Delete Single File
async function deleteFile(file) {
  const confirmMsg = file.is_folder 
    ? `Möchtest du den Ordner "${file.name}" und alle darin enthaltenen Dateien wirklich löschen?`
    : `Möchtest du die Datei "${file.name}" wirklich löschen?`;
    
  if (!await showConfirmDialog('Element löschen', confirmMsg)) return;

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
  if (!await showConfirmDialog('Elemente löschen', `Möchtest du die ${selectedFileIds.length} ausgewählten Elemente wirklich löschen?`)) return;

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

document.getElementById('multi-share-btn').onclick = async () => {
  if (selectedFileIds.length === 0) return;

  const folderName = await showInputPrompt(
    'Ausgewählte Dateien teilen',
    'Um mehrere Dateien zu teilen, wird ein neuer Ordner erstellt, in den die Dateien verschoben werden. Bitte gib einen Namen für den Freigabe-Ordner ein:',
    'Geteilte Auswahl'
  );

  if (!folderName || !folderName.trim()) return;

  try {
    const createRes = await fetch('/api/files/folder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: folderName.trim(),
        parentId: currentFolderId
      })
    });

    if (!createRes.ok) {
      const err = await createRes.json();
      showToast(err.error || 'Fehler beim Erstellen des Ordners.');
      return;
    }

    const targetFolder = await createRes.json();

    const moveRes = await fetch('/api/files/move-multiple', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fileIds: selectedFileIds,
        targetFolderId: targetFolder.id
      })
    });

    if (!moveRes.ok) {
      showToast('Fehler beim Verschieben der Dateien in den Ordner.');
      return;
    }

    clearSelection();
    await loadFiles(currentFolderId);
    openShareModal(targetFolder);
  } catch (err) {
    console.error('Error sharing multiple files:', err);
    showToast('Fehler beim Ausführen der Aktion.');
  }
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

  await uploadMultipleFiles(files);
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
const shareExpiryType = document.getElementById('share-expiry-type');
const shareExpiryHoursInput = document.getElementById('share-expiry-hours');
const shareExpiryDaysInput = document.getElementById('share-expiry-days');
const shareExpiryCustomInput = document.getElementById('share-expiry-custom');
const deleteShareBtn = document.getElementById('delete-share-btn');
const shareResultSection = document.getElementById('share-result-section');
const shareResultInput = document.getElementById('share-result-input');

function updateShareExpiryUI() {
  if (!shareExpiryType) return;
  const type = shareExpiryType.value;
  document.getElementById('share-expiry-hours-container').style.display = type === 'hours' ? 'block' : 'none';
  document.getElementById('share-expiry-days-container').style.display = type === 'days' ? 'block' : 'none';
  document.getElementById('share-expiry-custom-container').style.display = type === 'custom' ? 'block' : 'none';
}

if (shareExpiryType) {
  shareExpiryType.onchange = updateShareExpiryUI;
}

async function openShareModal(file) {
  document.getElementById('share-file-id').value = file.id;
  const prefix = appBrandingUrl || window.location.origin;
  document.getElementById('share-url-prefix').textContent = prefix.endsWith('/') ? `${prefix}s/` : `${prefix}/s/`;
  
  // Set defaults
  shareSlugInput.value = '';
  shareCanWriteCheck.checked = false;
  shareCanDownloadCheck.checked = true;
  shareCanZipCheck.checked = true;
  if (shareExpiryType) shareExpiryType.value = 'none';
  if (shareExpiryHoursInput) shareExpiryHoursInput.value = '';
  if (shareExpiryDaysInput) shareExpiryDaysInput.value = '';
  if (shareExpiryCustomInput) shareExpiryCustomInput.value = '';
  updateShareExpiryUI();
  
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
  const ext = file.name.split('.').pop().toLowerCase();
  const isCode = ['txt', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'html', 'xml', 'css', 'scss', 'less', 'py', 'json', 'yaml', 'yml', 'c', 'cpp', 'h', 'hpp', 'cs', 'go', 'rs', 'java', 'sh', 'bash', 'md', 'php', 'rb', 'sql'].includes(ext);

  if (!file.is_folder && !isCode) {
    shareCanWriteCheck.checked = false;
    shareCanWriteCheck.disabled = true;
    if (onlyUploadContainer) onlyUploadContainer.style.display = 'none';
  } else {
    shareCanWriteCheck.disabled = false;
    if (onlyUploadContainer) onlyUploadContainer.style.display = file.is_folder ? 'flex' : 'none';
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
        const expiryDate = new Date(existing.expires_at);
        const year = expiryDate.getFullYear();
        const month = String(expiryDate.getMonth() + 1).padStart(2, '0');
        const day = String(expiryDate.getDate()).padStart(2, '0');
        const hours = String(expiryDate.getHours()).padStart(2, '0');
        const minutes = String(expiryDate.getMinutes()).padStart(2, '0');
        
        if (shareExpiryCustomInput) {
          shareExpiryCustomInput.value = `${year}-${month}-${day}T${hours}:${minutes}`;
        }
        if (shareExpiryType) {
          shareExpiryType.value = 'custom';
        }
        updateShareExpiryUI();
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
  
  let expiresAt = null;
  if (shareExpiryType) {
    const expType = shareExpiryType.value;
    if (expType === 'hours' && shareExpiryHoursInput.value) {
      const d = new Date();
      d.setHours(d.getHours() + parseInt(shareExpiryHoursInput.value));
      expiresAt = d.toISOString();
    } else if (expType === 'days' && shareExpiryDaysInput.value) {
      const d = new Date();
      d.setDate(d.getDate() + parseInt(shareExpiryDaysInput.value));
      expiresAt = d.toISOString();
    } else if (expType === 'custom' && shareExpiryCustomInput.value) {
      expiresAt = new Date(shareExpiryCustomInput.value).toISOString();
    }
  }

  const payload = {
    fileId: parseInt(fileId),
    customSlug: shareSlugInput.value.trim(),
    canRead: true,
    canWrite: shareCanWriteCheck.checked,
    canDownload: shareCanDownloadCheck.checked,
    canZip: shareCanZipCheck.checked,
    expiresAt: expiresAt,
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

      // Automatically copy generated link to clipboard
      try {
        await navigator.clipboard.writeText(shareResultInput.value);
        showToast(existingId ? 'Freigabe aktualisiert & Link kopiert!' : 'Freigabe-Link erstellt & kopiert!');
      } catch (clipErr) {
        shareResultInput.select();
        document.execCommand('copy');
        showToast(existingId ? 'Freigabe aktualisiert & Link kopiert!' : 'Freigabe-Link erstellt & kopiert!');
      }
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

  if (!await showConfirmDialog('Freigabe aufheben', 'Möchtest du diese Freigabe wirklich aufheben? Der Link wird ungültig.')) return;

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

    if (targetSection === 'storage-settings') {
      loadStorageSettings();
    }
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

    // Set profile inputs
    if (data.user) {
      const emailInput = document.getElementById('settings-email-input');
      if (emailInput) emailInput.value = data.user.email || '';
      
      const firstnameInput = document.getElementById('settings-firstname-input');
      if (firstnameInput) firstnameInput.value = data.user.first_name || '';

      const lastnameInput = document.getElementById('settings-lastname-input');
      if (lastnameInput) lastnameInput.value = data.user.last_name || '';

      const usernameInput = document.getElementById('settings-username-input');
      if (usernameInput) usernameInput.value = data.user.username || '';

      const realnameToggle = document.getElementById('settings-display-realname-toggle');
      if (realnameToggle) realnameToggle.checked = data.user.display_real_name || false;
    }

    // Show/hide 2FA email container based on SMTP config status
    const email2faContainer = document.getElementById('2fa-email-container');
    if (email2faContainer) {
      email2faContainer.style.display = data.emailConfigured ? 'flex' : 'none';
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

    // Load Storage stats
    loadStorageSettings();

  } catch (err) {
    console.error('Settings load error:', err);
    showToast('Fehler beim Laden der Einstellungen.');
  }
}

async function loadStorageSettings() {
  const usedText = document.getElementById('storage-used-text');
  const limitText = document.getElementById('storage-limit-text');
  const progressBar = document.getElementById('storage-progress-bar');
  const detailText = document.getElementById('storage-detail-text');

  if (!usedText || !limitText || !progressBar || !detailText) return;

  try {
    const res = await fetch('/api/users/storage');
    if (!res.ok) throw new Error('Failed to load storage info');
    const data = await res.json();

    const used = data.usedBytes;
    const quota = data.quotaBytes;
    const freeDisk = data.freeDiskBytes;

    usedText.textContent = `${formatBytes(used)} verwendet`;

    if (quota !== null && quota > 0) {
      limitText.textContent = `von ${formatBytes(quota)}`;
      const percentage = Math.min(100, (used / quota) * 100);
      progressBar.style.width = `${percentage}%`;
      
      const free = Math.max(0, quota - used);
      detailText.innerHTML = `
        Du hast <strong>${formatBytes(free)}</strong> freien Speicherplatz von deinem zugeteilten Speicher-Limit.
      `;
      if (percentage > 90) {
        progressBar.style.background = '#ff5555';
      } else if (percentage > 70) {
        progressBar.style.background = '#ffaa00';
      } else {
        progressBar.style.background = 'linear-gradient(90deg, var(--color-accent) 0%, #bd93f9 100%)';
      }
    } else {
      limitText.textContent = 'unbegrenzt';
      progressBar.style.width = '0%';
      detailText.innerHTML = `
        Dein Speicherplatz-Limit ist unbegrenzt.<br>
        Freie Kapazität des Server-Laufwerks: <strong>${formatBytes(freeDisk)}</strong> frei.
      `;
    }
  } catch (err) {
    console.error('Error loading storage settings:', err);
    detailText.textContent = 'Fehler beim Laden der Speicherplatz-Informationen.';
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
      <td style="font-weight: 500;">${pk.name || 'Passkey'} <span style="font-family: monospace; font-size: 0.8rem; color: var(--color-text-muted); font-weight: normal; margin-left: 0.5rem;">(${pk.id.slice(0, 10)}...)</span></td>
      <td>
        <button class="btn btn-action-delete-passkey" style="color: #ff5555; border-color: rgba(255,0,0,0.2); padding: 4px 10px;">
          Löschen
        </button>
      </td>
    `;

    row.querySelector('.btn-action-delete-passkey').onclick = async () => {
      if (!await showConfirmDialog('Passkey löschen', 'Diesen Passkey wirklich löschen?')) return;
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

    const keyName = await showInputPrompt('Passkey benennen', 'Gib einen Namen für diesen Passkey ein (z.B. iPhone, Arbeits-PC):', '', 'Mein Passkey');
    const finalName = (keyName && keyName.trim()) ? keyName.trim() : 'Passkey';

    const verifyRes = await fetch('/api/auth/passkey/register-verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ credential, name: finalName }),
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

      // Colors
      const colorBgVal = conf.custom_color_bg || '#0d0e12';
      const colorAccentVal = conf.custom_color_accent || '#00d2ff';
      document.getElementById('admin-color-bg').value = colorBgVal;
      document.getElementById('admin-color-bg-val').textContent = colorBgVal.toUpperCase();
      document.getElementById('admin-color-accent').value = colorAccentVal;
      document.getElementById('admin-color-accent-val').textContent = colorAccentVal.toUpperCase();

      // Dashboard BG Preview
      const dbBgPreview = document.getElementById('admin-db-bg-preview');
      const dbBgRemove = document.getElementById('admin-db-bg-remove');
      if (conf.dashboard_bg_image) {
        dbBgPreview.style.backgroundImage = `url('/api/public/branding/dashboard-bg?t=${Date.now()}')`;
        dbBgPreview.textContent = '';
        dbBgRemove.style.display = 'inline-flex';
      } else {
        dbBgPreview.style.backgroundImage = '';
        dbBgPreview.textContent = 'Kein Bild';
        dbBgRemove.style.display = 'none';
      }

      // Login BG Preview
      const loginBgPreview = document.getElementById('admin-login-bg-preview');
      const loginBgRemove = document.getElementById('admin-login-bg-remove');
      if (conf.login_bg_image) {
        loginBgPreview.style.backgroundImage = `url('/api/public/branding/login-bg?t=${Date.now()}')`;
        loginBgPreview.textContent = '';
        loginBgRemove.style.display = 'inline-flex';
      } else {
        loginBgPreview.style.backgroundImage = '';
        loginBgPreview.textContent = 'Kein Bild';
        loginBgRemove.style.display = 'none';
      }

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
    cloud_tab_name: document.getElementById('admin-cloud-tab-name').value.trim(),
    custom_color_bg: document.getElementById('admin-color-bg').value,
    custom_color_accent: document.getElementById('admin-color-accent').value
  };
  await saveAdminConfig(payload);
  loadBranding(); // Reload headers & document title instantly
};

// Color pickers value listeners
const colorBgPicker = document.getElementById('admin-color-bg');
const colorAccentPicker = document.getElementById('admin-color-accent');
if (colorBgPicker) {
  colorBgPicker.oninput = (e) => {
    document.getElementById('admin-color-bg-val').textContent = e.target.value.toUpperCase();
  };
}
if (colorAccentPicker) {
  colorAccentPicker.oninput = (e) => {
    document.getElementById('admin-color-accent-val').textContent = e.target.value.toUpperCase();
  };
}

// Dashboard Background Image Upload
const dbBgUpload = document.getElementById('admin-db-bg-upload');
if (dbBgUpload) {
  dbBgUpload.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const formData = new FormData();
    formData.append('image', file);

    showToast('Lade Dashboard-Hintergrundbild hoch...');
    try {
      const res = await fetch('/api/settings/admin/dashboard-bg', {
        method: 'POST',
        body: formData
      });
      if (res.ok) {
        showToast('Dashboard-Hintergrund erfolgreich hochgeladen.');
        await loadBranding();
        await loadAdminSettings();
      } else {
        const err = await res.json();
        showToast(err.error || 'Fehler beim Hochladen.');
      }
    } catch (err) {
      showToast('Netzwerkfehler beim Upload.');
    }
  };
}

// Dashboard Background Image Remove
const dbBgRemove = document.getElementById('admin-db-bg-remove');
if (dbBgRemove) {
  dbBgRemove.onclick = async () => {
    showToast('Entferne Dashboard-Hintergrundbild...');
    try {
      const res = await fetch('/api/settings/admin/dashboard-bg', {
        method: 'DELETE'
      });
      if (res.ok) {
        showToast('Dashboard-Hintergrund erfolgreich entfernt.');
        await loadBranding();
        await loadAdminSettings();
      } else {
        showToast('Fehler beim Entfernen.');
      }
    } catch (err) {
      showToast('Netzwerkfehler.');
    }
  };
}

// Login Background Image Upload
const loginBgUpload = document.getElementById('admin-login-bg-upload');
if (loginBgUpload) {
  loginBgUpload.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const formData = new FormData();
    formData.append('image', file);

    showToast('Lade Login-Hintergrundbild hoch...');
    try {
      const res = await fetch('/api/settings/admin/login-bg', {
        method: 'POST',
        body: formData
      });
      if (res.ok) {
        showToast('Login-Hintergrund erfolgreich hochgeladen.');
        await loadBranding();
        await loadAdminSettings();
      } else {
        const err = await res.json();
        showToast(err.error || 'Fehler beim Hochladen.');
      }
    } catch (err) {
      showToast('Netzwerkfehler beim Upload.');
    }
  };
}

// Login Background Image Remove
const loginBgRemove = document.getElementById('admin-login-bg-remove');
if (loginBgRemove) {
  loginBgRemove.onclick = async () => {
    showToast('Entferne Login-Hintergrundbild...');
    try {
      const res = await fetch('/api/settings/admin/login-bg', {
        method: 'DELETE'
      });
      if (res.ok) {
        showToast('Login-Hintergrund erfolgreich entfernt.');
        await loadBranding();
        await loadAdminSettings();
      } else {
        showToast('Fehler beim Entfernen.');
      }
    } catch (err) {
      showToast('Netzwerkfehler.');
    }
  };
}

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
      row.style.borderBottom = '1px solid var(--color-border)';
      
      const ssoText = user.sso_provider ? `Authentik (${user.sso_provider})` : 'Nein';
      const realName = (user.first_name || user.last_name) ? `${user.first_name || ''} ${user.last_name || ''}`.trim() : '';
      const emailText = user.email || 'Keine E-Mail';
      
      const statusBadge = user.is_active ? '' : ' <span class="badge" style="background: rgba(255, 85, 85, 0.2); color: #ff5555; font-size: 0.75rem; padding: 2px 6px; border-radius: 4px; margin-left: 0.5rem; font-weight: 500;">Gesperrt</span>';
      
      // Determine lock button text/style
      const lockText = user.is_active ? 'Sperren' : 'Entsperren';
      const lockColor = user.is_active ? '#ffaa00' : '#00d2ff';
      const lockBorder = user.is_active ? 'rgba(255,170,0,0.2)' : 'rgba(0,210,255,0.2)';
      
      row.innerHTML = `
        <td style="padding: 1rem 0.5rem;">
          <div style="font-weight: 600; display: flex; align-items: center;">${user.username}${statusBadge}</div>
          ${realName ? `<div style="font-size: 0.8rem; color: var(--color-text-muted); margin-top: 0.15rem;">${realName}</div>` : ''}
          <div style="font-size: 0.8rem; color: var(--color-text-muted); margin-top: 0.15rem;">${emailText}</div>
        </td>
        <td style="padding: 1rem 0.5rem;">
          <select class="form-control select-role" style="padding: 4px 8px; font-size: 0.85rem; width: auto; background: var(--color-surface); cursor: pointer;">
            <option value="user" ${user.role === 'user' ? 'selected' : ''}>User</option>
            <option value="admin" ${user.role === 'admin' ? 'selected' : ''}>Admin</option>
          </select>
        </td>
        <td style="padding: 1rem 0.5rem; font-size: 0.9rem;">${ssoText}</td>
        <td style="padding: 1rem 0.5rem; font-size: 0.9rem;">${user.file_count}</td>
        <td style="padding: 1rem 0.5rem; font-size: 0.9rem;">
          <div style="display: flex; align-items: center; gap: 0.5rem;">
            <span>${formatBytes(user.storage_used)} / ${user.storage_quota ? formatBytes(user.storage_quota) : 'unbegrenzt'}</span>
            <button class="btn btn-icon btn-action-edit-quota" style="padding: 2px; border: none; background: transparent; color: var(--color-accent);" title="Speicherlimit ändern">
              <i data-lucide="edit-3" style="width: 14px; height: 14px;"></i>
            </button>
          </div>
        </td>
        <td style="padding: 1rem 0.5rem; text-align: right;">
          <div style="display: flex; gap: 0.5rem; justify-content: flex-end; align-items: center;">
            <button class="btn btn-action-lock-user" style="color: ${lockColor}; border-color: ${lockBorder}; padding: 4px 8px; font-size: 0.8rem;" title="${lockText}">
              ${lockText}
            </button>
            <button class="btn btn-action-reset-user" style="color: #00d2ff; border-color: rgba(0,210,255,0.2); padding: 4px 8px; font-size: 0.8rem;" title="Passwort per Mail zurücksetzen" ${isEmailConfigured ? '' : 'disabled style="opacity: 0.4;"'}>
              Reset PW
            </button>
            <button class="btn btn-action-delete-user" style="color: #ff5555; border-color: rgba(255,0,0,0.2); padding: 4px 8px; font-size: 0.8rem;" title="Benutzer löschen">
              Löschen
            </button>
          </div>
        </td>
      `;

      // Handle edit quota
      const editQuotaBtn = row.querySelector('.btn-action-edit-quota');
      if (editQuotaBtn) {
        editQuotaBtn.onclick = async () => {
          const currentGb = user.storage_quota ? (user.storage_quota / (1024 * 1024 * 1024)).toFixed(1) : '';
          const inputVal = await showInputPrompt(
            'Speicherlimit festlegen',
            `Speicherplatz-Limit für ${user.username} in Gigabyte (GB). Gib 0 oder leer ein für unbegrenzten Speicherplatz:`,
            currentGb,
            'z. B. 5'
          );
          if (inputVal === null) return; // user cancelled

          let quotaBytes = null;
          const parsed = parseFloat(inputVal.replace(',', '.'));
          if (!isNaN(parsed) && parsed > 0) {
            quotaBytes = Math.round(parsed * 1024 * 1024 * 1024);
          }

          try {
            const r = await fetch(`/api/settings/admin/users/${user.id}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ action: 'quota', quotaBytes }),
            });
            if (r.ok) {
              showToast('Speicherlimit erfolgreich aktualisiert.');
              loadAdminUsers();
            } else {
              const err = await r.json();
              showToast(err.error || 'Fehler beim Aktualisieren des Limits.');
            }
          } catch (err) {
            console.error(err);
            showToast('Verbindungsfehler beim Aktualisieren des Limits.');
          }
        };
      }

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
            loadAdminSettings();
          } else {
            const err = await r.json();
            showToast(err.error);
            loadAdminSettings();
          }
        } catch (err) {
          showToast('Fehler beim Ändern der Rolle.');
        }
      };

      // Handle lock/unlock user status
      row.querySelector('.btn-action-lock-user').onclick = async () => {
        try {
          const r = await fetch(`/api/settings/admin/users/${user.id}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'toggle-status' }),
          });
          const data = await r.json();
          if (r.ok) {
            showToast(data.message || 'Benutzerstatus geändert.');
            loadAdminSettings();
          } else {
            showToast(data.error || 'Fehler beim Ändern des Status.');
          }
        } catch (err) {
          showToast('Verbindungsfehler.');
        }
      };

      // Handle password reset
      row.querySelector('.btn-action-reset-user').onclick = async () => {
        if (!await showConfirmDialog('Passwort zurücksetzen', `Möchtest du das Passwort für "${user.username}" wirklich zurücksetzen? Dem Benutzer wird ein temporäres Passwort per E-Mail gesendet.`)) return;
        showToast('Setze Passwort zurück...');
        try {
          const r = await fetch(`/api/settings/admin/users/${user.id}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'reset-password' }),
          });
          const data = await r.json();
          if (r.ok) {
            showToast('Passwort erfolgreich zurückgesetzt und E-Mail versendet.');
          } else {
            showToast(data.error || 'Fehler beim Zurücksetzen des Passworts.');
          }
        } catch (err) {
          showToast('Verbindungsfehler.');
        }
      };

      // Handle delete user
      row.querySelector('.btn-action-delete-user').onclick = async () => {
        if (!await showConfirmDialog('Benutzer löschen', `Möchtest du den Benutzer "${user.username}" und alle seine Dateien wirklich unwiderruflich löschen?`)) return;
        try {
          const r = await fetch(`/api/settings/admin/users/${user.id}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'delete' }),
          });
          if (r.ok) {
            showToast('Benutzer gelöscht.');
            loadAdminSettings();
          } else {
            const err = await r.json();
            showToast(err.error);
          }
        } catch (err) {
          showToast('Fehler beim Löschen des Benutzers.');
        }
      };

      // Disable actions on current user
      if (user.id === currentUser.id) {
        row.querySelector('.btn-action-delete-user').disabled = true;
        row.querySelector('.btn-action-delete-user').style.opacity = '0.4';
        row.querySelector('.btn-action-lock-user').disabled = true;
        row.querySelector('.btn-action-lock-user').style.opacity = '0.4';
        row.querySelector('.btn-action-reset-user').disabled = true;
        row.querySelector('.btn-action-reset-user').style.opacity = '0.4';
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
        if (!await showConfirmDialog('Freigabe löschen', 'Diesen Freigabelink wirklich löschen?')) return;
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

let brandingCache = null;
let currentViewName = 'auth';

function applyBackgrounds(viewName) {
  if (!brandingCache) return;
  
  // Clean default body background style properties
  document.body.style.backgroundImage = '';
  document.body.style.backgroundSize = 'cover';
  document.body.style.backgroundPosition = 'center';
  document.body.style.backgroundAttachment = 'fixed';
  document.body.style.backgroundRepeat = 'no-repeat';

  if (viewName === 'auth') {
    if (brandingCache.hasLoginBg) {
      document.body.style.backgroundImage = `url('/api/public/branding/login-bg?t=${Date.now()}')`;
    }
  } else {
    if (brandingCache.hasDashboardBg) {
      document.body.style.backgroundImage = `url('/api/public/branding/dashboard-bg?t=${Date.now()}')`;
    }
  }
}

// Load Branding configurations dynamically
async function loadBranding() {
  try {
    const res = await fetch('/api/public/branding');
    const data = await res.json();
    
    brandingCache = data;
    appBrandingUrl = data.appUrl || '';

    // Apply custom colors
    if (data.customColorBg) {
      document.documentElement.style.setProperty('--color-bg', data.customColorBg);
    }
    if (data.customColorAccent) {
      document.documentElement.style.setProperty('--color-accent', data.customColorAccent);
      
      const hexToRgbA = (hex, alpha) => {
        let c;
        if (/^#([A-Fa-f0-9]{3}){1,2}$/.test(hex)) {
          c = hex.substring(1).split('');
          if (c.length === 3) {
            c = [c[0], c[0], c[1], c[1], c[2], c[2]];
          }
          c = '0x' + c.join('');
          return 'rgba(' + [(c >> 16) & 255, (c >> 8) & 255, c & 255].join(',') + ',' + alpha + ')';
        }
        return hex;
      };
      
      document.documentElement.style.setProperty('--color-border', hexToRgbA(data.customColorAccent, 0.2));
      document.documentElement.style.setProperty('--color-border-active', hexToRgbA(data.customColorAccent, 0.8));
    }

    applyBackgrounds(currentViewName);

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
      
      let iconHTML = `<i data-lucide="cloud"></i>`;
      if (data.hasIcon) {
        iconHTML = `<img src="/api/public/branding/icon?t=${Date.now()}" style="width: 32px; height: 32px; object-fit: contain; border-radius: 4px; margin-right: 0.5rem;" alt="Logo">`;
      }
      logo.innerHTML = `${iconHTML} ${prefix}<span>${suffix}</span>`;
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
      if (viewMode === 'grid') {
        gridSizeIndex = (gridSizeIndex + 1) % 5;
        localStorage.setItem('gridSizeIndex', gridSizeIndex);
        const sizeNames = ['Sehr klein', 'Klein', 'Mittel', 'Groß', 'Sehr groß'];
        showToast(`Kachelgröße: ${sizeNames[gridSizeIndex]}`);
      } else {
        viewMode = 'grid';
        localStorage.setItem('viewMode', 'grid');
        updateViewModeButtons();
      }
      renderFiles(renderedFilesList);
    };
    listBtn.onclick = () => {
      if (viewMode === 'list') {
        listSizeIndex = (listSizeIndex + 1) % 5;
        localStorage.setItem('listSizeIndex', listSizeIndex);
        const spacingNames = ['Sehr kompakt', 'Kompakt', 'Normal', 'Bequem', 'Geräumig'];
        showToast(`Listenabstand: ${spacingNames[listSizeIndex]}`);
      } else {
        viewMode = 'list';
        localStorage.setItem('viewMode', 'list');
        updateViewModeButtons();
      }
      renderFiles(renderedFilesList);
    };
  }

  // Admin back button
  const adminBackBtn = document.getElementById('admin-back-to-dashboard-btn');
  if (adminBackBtn) {
    adminBackBtn.onclick = () => {
      closeSettingsOrAdmin();
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

    let { publicUrl, config } = await res.json();

    // Dynamically adjust publicUrl hostname to match the current browser location hostname
    // to prevent cross-origin blocks and network resolution failures (e.g. localhost vs 127.0.0.1 vs IP)
    try {
      const parsedPublicUrl = new URL(publicUrl);
      if (parsedPublicUrl.hostname === 'localhost' || parsedPublicUrl.hostname === '127.0.0.1') {
        const browserUrl = new URL(window.location.href);
        parsedPublicUrl.hostname = browserUrl.hostname;
        publicUrl = parsedPublicUrl.toString().replace(/\/$/, '');
      }
    } catch(e) {
      console.error('Error adjusting EuroOffice publicUrl hostname:', e);
    }

    // Dynamically load EuroOffice Javascript API
    await loadOfficeScript(publicUrl);

    // Title update
    const titleEl = document.getElementById('office-editor-title');
    if (titleEl) {
      titleEl.innerHTML = `<i data-lucide="file-text"></i> ${fileName}`;
      lucide.createIcons();
    }

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
          QRCode.toDataURL(data.otpauthUrl, { width: 200, margin: 1 }, function (err, url) {
            if (err) {
              console.error(err);
              document.getElementById('totp-qr-image').src = '';
            } else {
              document.getElementById('totp-qr-image').src = url;
            }
          });
          document.getElementById('totp-secret-text').textContent = data.secret;
          document.getElementById('totp-confirm-code').value = '';
          totpSetupOverlay.classList.add('active');
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
      if (await showConfirmDialog('2FA deaktivieren', 'Möchtest du 2FA per Authenticator App wirklich deaktivieren?')) {
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
  totpSetupOverlay.classList.remove('active');
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
        totpSetupOverlay.classList.remove('active');
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

// Paste Action trigger
async function triggerPasteAction() {
  if (clipboardFileIds.length === 0 || !clipboardAction) return;

  const url = clipboardAction === 'cut' 
    ? '/api/files/move-multiple' 
    : '/api/files/copy-multiple';

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fileIds: clipboardFileIds,
        targetFolderId: currentFolderId
      })
    });

    if (res.ok) {
      showToast(clipboardAction === 'cut' ? 'Elemente eingefügt (verschoben)!' : 'Elemente dupliziert!');
      if (clipboardAction === 'cut') {
        clipboardFileIds = [];
        clipboardAction = null;
      }
      clearSelection();
      loadFiles(currentFolderId);
    } else {
      const err = await res.json();
      showToast(err.error || 'Fehler beim Einfügen.');
    }
  } catch (err) {
    console.error('Error pasting files:', err);
    showToast('Verbindungsfehler beim Einfügen.');
  }
}

// Keyboard ESC listener & Modal overlay backdrop click listener & Admin toggle auto-save & Desktop Explorer Hotkeys
window.addEventListener('keydown', (e) => {
  // Check if user is typing in an input, textarea, select, or Monaco/Office editor
  const activeTag = document.activeElement ? document.activeElement.tagName.toLowerCase() : '';
  const isInput = activeTag === 'input' || activeTag === 'textarea' || activeTag === 'select' || document.activeElement.closest('.monaco-editor') || document.activeElement.closest('#office-editor-overlay');
  
  if (isInput) {
    // If the search input is focused and Escape is pressed, clear and blur it
    if (e.key === 'Escape' && document.activeElement.id === 'dashboard-search-input') {
      const searchInput = document.getElementById('dashboard-search-input');
      if (searchInput) {
        searchInput.value = '';
        searchInput.blur();
        loadFiles(currentFolderId);
      }
    }
    return;
  }

  // Ctrl + A (Select All)
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
    e.preventDefault();
    selectedFileIds = renderedFilesList.map(f => f.id);
    updateMultiSelectUI();
    return;
  }

  // Ctrl + C (Copy selected file IDs)
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') {
    if (selectedFileIds.length > 0) {
      e.preventDefault();
      clipboardFileIds = [...selectedFileIds];
      clipboardAction = 'copy';
      showToast(`${selectedFileIds.length} Element(e) kopiert!`);
    }
    return;
  }

  // Ctrl + X (Cut selected file IDs)
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'x') {
    if (selectedFileIds.length > 0) {
      e.preventDefault();
      clipboardFileIds = [...selectedFileIds];
      clipboardAction = 'cut';
      showToast(`${selectedFileIds.length} Element(e) ausgeschnitten!`);
    }
    return;
  }

  // Ctrl + V (Paste copied/cut files)
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') {
    if (clipboardFileIds.length > 0 && clipboardAction) {
      e.preventDefault();
      triggerPasteAction();
    }
    return;
  }

  // Ctrl + F (Focus Search)
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
    const searchInput = document.getElementById('dashboard-search-input');
    if (searchInput) {
      e.preventDefault();
      searchInput.focus();
      searchInput.select();
    }
    return;
  }

  // Auto-Search on simple character typing (a-z, A-Z, 0-9)
  if (!e.ctrlKey && !e.altKey && !e.metaKey && e.key.length === 1 && /^[a-zA-Z0-9]$/.test(e.key)) {
    const searchInput = document.getElementById('dashboard-search-input');
    if (searchInput) {
      e.preventDefault();
      searchInput.focus();
      searchInput.value = e.key;
      searchInput.dispatchEvent(new Event('input'));
    }
    return;
  }

  if (e.key === 'Escape') {
    // Check if search input has value, then clear it
    const searchInput = document.getElementById('dashboard-search-input');
    if (searchInput && searchInput.value) {
      searchInput.value = '';
      loadFiles(currentFolderId);
      return;
    }
    // 1. Close Office Editor
    const officeEditor = document.getElementById('office-editor-overlay');
    if (officeEditor && officeEditor.style.display !== 'none') {
      if (docEditorInstance) {
        docEditorInstance.destroyEditor();
        docEditorInstance = null;
      }
      officeEditor.style.display = 'none';
      loadFiles(currentFolderId);
      return;
    }

    // 1b. Close Code Editor, Image Viewer, Video Viewer
    const codeEditor = document.getElementById('code-editor-overlay');
    if (codeEditor && codeEditor.style.display !== 'none') {
      document.getElementById('close-code-editor-btn').click();
      return;
    }
    const imageViewer = document.getElementById('image-viewer-overlay');
    if (imageViewer && imageViewer.style.display !== 'none') {
      document.getElementById('close-image-viewer-btn').click();
      return;
    }
    const videoViewer = document.getElementById('video-viewer-overlay');
    if (videoViewer && videoViewer.style.display !== 'none') {
      document.getElementById('close-video-viewer-btn').click();
      return;
    }
    const pdfViewer = document.getElementById('pdf-viewer-overlay');
    if (pdfViewer && pdfViewer.classList.contains('active')) {
      document.getElementById('close-pdf-viewer-btn').click();
      return;
    }

    // 2. Close other overlays (except the main settings/admin views themselves)
    const activeOverlays = Array.from(document.querySelectorAll('.modal-overlay.active'))
      .filter(o => o.id !== 'settings-view' && o.id !== 'admin-view');
      
    if (activeOverlays.length > 0) {
      activeOverlays.forEach(overlay => {
        overlay.classList.remove('active');
        if (overlay.id === 'totp-setup-overlay') {
          cancelTotpSetup();
        }
      });
      return;
    }

    // 3. Close settings or admin (go back to dashboard)
    if (window.location.hash === '#settings' || window.location.hash === '#admin') {
      closeSettingsOrAdmin();
      return;
    }
  }
});

// Close modals when clicking on the blurred backdrop
document.querySelectorAll('.modal-overlay').forEach(overlay => {
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      if (overlay.id === 'settings-view' || overlay.id === 'admin-view') {
        closeSettingsOrAdmin();
      } else if (overlay.id === 'office-editor-overlay') {
        // Do not close office editor on backdrop click
      } else {
        overlay.classList.remove('active');
        if (overlay.id === 'totp-setup-overlay') {
          cancelTotpSetup();
        }
      }
    }
  });
});

// Auto-save admin configuration toggles on change
const adminRegToggle = document.getElementById('admin-reg-enabled');
if (adminRegToggle) {
  adminRegToggle.onchange = async () => {
    const payload = {
      registration_enabled: adminRegToggle.checked ? 'true' : 'false'
    };
    await saveAdminConfig(payload);
  };
}

const adminSsoToggle = document.getElementById('admin-sso-enabled');
if (adminSsoToggle) {
  adminSsoToggle.onchange = async () => {
    const payload = {
      sso_enabled: adminSsoToggle.checked ? 'true' : 'false'
    };
    await saveAdminConfig(payload);
  };
}

// ==========================================================================
// CODE EDITOR, IMAGE VIEWER, AND VIDEO VIEWER LOGIC
// ==========================================================================

let monacoLoaded = false;

function loadMonaco() {
  return new Promise((resolve, reject) => {
    if (monacoLoaded) return resolve();
    if (typeof require === 'undefined') {
      const script = document.createElement('script');
      script.src = 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.39.0/min/vs/loader.min.js';
      script.onload = () => {
        require.config({ paths: { 'vs': 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.39.0/min/vs' }});
        require(['vs/editor/editor.main'], () => {
          monacoLoaded = true;
          resolve();
        });
      };
      script.onerror = () => reject(new Error('Monaco editor could not be loaded.'));
      document.head.appendChild(script);
    } else {
      require.config({ paths: { 'vs': 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.39.0/min/vs' }});
      require(['vs/editor/editor.main'], () => {
        monacoLoaded = true;
        resolve();
      });
    }
  });
}

function getMonacoLanguage(fileName) {
  const ext = fileName.split('.').pop().toLowerCase();
  const mapping = {
    'txt': 'plaintext',
    'js': 'javascript', 'mjs': 'javascript', 'cjs': 'javascript', 'jsx': 'javascript',
    'ts': 'typescript', 'tsx': 'typescript',
    'html': 'html', 'xml': 'xml', 'svg': 'xml',
    'css': 'css', 'scss': 'scss', 'less': 'less',
    'py': 'python',
    'json': 'json',
    'yaml': 'yaml', 'yml': 'yaml',
    'c': 'c',
    'cpp': 'cpp', 'h': 'cpp', 'hpp': 'cpp',
    'cs': 'csharp',
    'go': 'go',
    'rs': 'rust',
    'java': 'java',
    'sh': 'shell', 'bash': 'shell',
    'md': 'markdown',
    'php': 'php',
    'rb': 'ruby',
    'sql': 'sql'
  };
  return mapping[ext] || 'plaintext';
}

function addCollabUserStyles(userId, color, username) {
  const styleId = `collab-styles-${userId}`;
  let styleEl = document.getElementById(styleId);
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = styleId;
    document.head.appendChild(styleEl);
  }
  styleEl.innerHTML = `
    .collab-selection-${userId} {
      background-color: ${color}33 !important;
    }
    .collab-cursor-${userId} {
      border-left: 2px solid ${color} !important;
      margin-left: -1px;
      position: relative;
    }
    .collab-cursor-tooltip-${userId}::after {
      content: "${username}";
      position: absolute;
      top: -14px;
      left: 2px;
      background: ${color};
      color: #fff;
      font-size: 9px;
      font-weight: bold;
      padding: 1px 3px;
      border-radius: 2px;
      white-space: nowrap;
      pointer-events: none;
      opacity: 0.8;
      z-index: 10;
    }
  `;
}

function removeCollabUserStyles(userId) {
  const styleEl = document.getElementById(`collab-styles-${userId}`);
  if (styleEl) styleEl.remove();
}

function initCollabSocket(fileId, username, userId, isPublic = false, slug = '') {
  if (collabSocket) {
    collabSocket.close();
    collabSocket = null;
  }

  collabUserDecorations = {};

  const wsProto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsHost = window.location.host;
  
  let wsUrl = `${wsProto}//${wsHost}/api/collab?fileId=${fileId}&username=${encodeURIComponent(username)}&userId=${userId}`;
  if (isPublic) {
    wsUrl += `&slug=${slug}`;
  }

  collabSocket = new WebSocket(wsUrl);

  collabSocket.onopen = () => {
    console.log('Collaboration WebSocket connected.');
  };

  collabSocket.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);

      if (data.type === 'init') {
        collabUserColor = data.color;
        updateCollabUsersListUI(data.users);
      } else if (data.type === 'user_joined') {
        updateCollabUsersListUI(data.users);
        showToast(`${data.username} hat den Editor betreten.`);
      } else if (data.type === 'user_left') {
        updateCollabUsersListUI(data.users);
        showToast(`${data.username} hat den Editor verlassen.`);
        if (collabUserDecorations[data.userId]) {
          if (monacoEditorInstance) {
            monacoEditorInstance.deltaDecorations(collabUserDecorations[data.userId], []);
          }
          delete collabUserDecorations[data.userId];
        }
        removeCollabUserStyles(data.userId);
      } else if (data.type === 'edit') {
        if (!monacoEditorInstance) return;
        isApplyingRemoteEdit = true;
        const model = monacoEditorInstance.getModel();
        const edits = data.changes.map(change => ({
          range: new monaco.Range(
            change.range.startLineNumber,
            change.range.startColumn,
            change.range.endLineNumber,
            change.range.endColumn
          ),
          text: change.text,
          forceMoveMarkers: true
        }));
        model.applyEdits(edits);
        isApplyingRemoteEdit = false;
      } else if (data.type === 'cursor') {
        if (!monacoEditorInstance) return;
        
        const targetUserId = data.userId;
        const targetUsername = data.username;
        const position = data.position;
        const selection = data.selection;

        let color = '#00d2ff';
        const clientStyle = document.getElementById(`collab-styles-${targetUserId}`);
        if (clientStyle) {
          const match = clientStyle.innerHTML.match(/border-left: 2px solid (#[a-fA-F0-9]+)/);
          if (match) color = match[1];
        } else {
          // Find matching user from room to fetch color
          // We'll hash color just like server if style is new
          const colors = ['#00d2ff', '#ff5555', '#50fa7b', '#ffb86c', '#ff79c6', '#bd93f9', '#f1fa8c', '#8be9fd'];
          let hash = 0;
          for (let i = 0; i < targetUserId.length; i++) {
            hash = targetUserId.charCodeAt(i) + ((hash << 5) - hash);
          }
          color = colors[Math.abs(hash) % colors.length];
        }

        addCollabUserStyles(targetUserId, color, targetUsername);

        const decorations = [];
        if (selection && (selection.startLineNumber !== selection.endLineNumber || selection.startColumn !== selection.endColumn)) {
          decorations.push({
            range: new monaco.Range(selection.startLineNumber, selection.startColumn, selection.endLineNumber, selection.endColumn),
            options: {
              className: `collab-selection-${targetUserId}`,
              hoverMessage: { value: targetUsername }
            }
          });
        }

        if (position) {
          decorations.push({
            range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column),
            options: {
              className: `collab-cursor-${targetUserId}`,
              afterContentClassName: `collab-cursor-tooltip-${targetUserId}`,
              hoverMessage: { value: targetUsername }
            }
          });
        }

        const oldDecs = collabUserDecorations[targetUserId] || [];
        collabUserDecorations[targetUserId] = monacoEditorInstance.deltaDecorations(oldDecs, decorations);
      }
    } catch (err) {
      console.error('Error handling collaborative WS message:', err);
    }
  };

  collabSocket.onclose = () => {
    console.log('Collaboration WebSocket disconnected.');
  };
}

function updateCollabUsersListUI(users) {
  const container = document.getElementById('collab-users-container');
  const listEl = document.getElementById('collab-users-list');
  if (!container || !listEl) return;

  if (!users || users.length <= 1) {
    container.style.display = 'none';
    return;
  }

  container.style.display = 'flex';
  const currentUsername = (typeof currentUser !== 'undefined' && currentUser) ? currentUser.username : 'Visitor';
  const otherUsers = users.filter(u => u.username !== currentUsername);
  const names = otherUsers.map(u => `<span style="color: ${u.color}; font-weight: bold;">${u.username}</span>`);
  listEl.innerHTML = `Andere online: ${names.join(', ')}`;
}

let currentEditingFileId = null;

async function openCodeEditor(fileId, fileName, isPublic = false, slug = '') {
  showToast('Lade Code-Editor...');
  currentEditingFileId = fileId;

  try {
    const url = isPublic 
      ? `/api/public/shares/${slug}/content/${fileId}`
      : `/api/files/content/${fileId}`;
      
    const res = await fetch(url);
    if (!res.ok) {
      const err = await res.json();
      showToast(err.error || 'Fehler beim Laden des Datei-Inhalts.');
      return;
    }
    const textContent = await res.text();

    await loadMonaco();

    document.getElementById('code-editor-title').innerHTML = `<i data-lucide="file-code"></i> ${fileName}`;
    lucide.createIcons();

    document.getElementById('code-editor-overlay').classList.add('active');
    const collabContainer = document.getElementById('collab-users-container');
    if (collabContainer) {
      collabContainer.style.display = 'none';
    }

    let readOnly = false;
    if (isPublic && shareConfig && !shareConfig.can_write) {
      readOnly = true;
    }
    
    const saveBtn = document.getElementById('save-code-editor-btn');
    if (saveBtn) {
      saveBtn.style.display = readOnly ? 'none' : 'block';
    }

    const container = document.getElementById('monaco-editor-container');
    container.innerHTML = ''; // Clear previous

    const language = getMonacoLanguage(fileName);
    
    monacoEditorInstance = monaco.editor.create(container, {
      value: textContent,
      language: language,
      theme: 'vs-dark',
      automaticLayout: true,
      readOnly: readOnly,
      fontSize: 14,
      minimap: { enabled: true },
      bracketPairColorization: {
        enabled: true
      },
      'semanticHighlighting.enabled': true,
      colorDecorators: true
    });

    // Start Collaboration WebSocket
    const collabUsername = (typeof currentUser !== 'undefined' && currentUser) ? currentUser.username : ('Gast_' + Math.floor(Math.random() * 900 + 100));
    const collabUserId = (typeof currentUser !== 'undefined' && currentUser) ? `${currentUser.id}` : `guest_${Math.random().toString(36).substring(2, 11)}`;
    initCollabSocket(fileId, collabUsername, collabUserId, isPublic, slug);

    // Send edits to other collaborators in real-time on keypress/change
    monacoEditorInstance.onDidChangeModelContent((event) => {
      if (isApplyingRemoteEdit) return;
      if (collabSocket && collabSocket.readyState === WebSocket.OPEN) {
        collabSocket.send(JSON.stringify({
          type: 'edit',
          changes: event.changes
        }));
      }

      // 1.5s Debounced Auto-save to the database (so users don't have to keep clicking save!)
      if (autoSaveDebounceTimeout) {
        clearTimeout(autoSaveDebounceTimeout);
      }
      autoSaveDebounceTimeout = setTimeout(async () => {
        if (!monacoEditorInstance || readOnly) return;
        const currentContent = monacoEditorInstance.getValue();
        try {
          const saveUrl = isPublic 
            ? `/api/public/shares/${slug}/content/${fileId}`
            : `/api/files/content/${fileId}`;
          await fetch(saveUrl, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: currentContent })
          });
        } catch (e) {
          console.error('Autosave error:', e);
        }
      }, 1500);
    });

    // Send cursor position & selection to other collaborators in real-time
    const sendCursorUpdate = () => {
      if (isApplyingRemoteEdit) return;
      if (collabSocket && collabSocket.readyState === WebSocket.OPEN) {
        collabSocket.send(JSON.stringify({
          type: 'cursor',
          position: monacoEditorInstance.getPosition(),
          selection: monacoEditorInstance.getSelection()
        }));
      }
    };

    monacoEditorInstance.onDidChangeCursorPosition(sendCursorUpdate);
    monacoEditorInstance.onDidChangeCursorSelection(sendCursorUpdate);

    if (!readOnly) {
      document.getElementById('save-code-editor-btn').onclick = async () => {
        const updatedContent = monacoEditorInstance.getValue();
        showToast('Speichere Datei...');
        
        try {
          const saveUrl = isPublic 
            ? `/api/public/shares/${slug}/content/${fileId}`
            : `/api/files/content/${fileId}`;
            
          const saveRes = await fetch(saveUrl, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: updatedContent })
          });

          if (saveRes.ok) {
            showToast('Datei erfolgreich gespeichert.');
          } else {
            const err = await saveRes.json();
            showToast(err.error || 'Fehler beim Speichern.');
          }
        } catch (err) {
          showToast('Verbindungsfehler beim Speichern.');
        }
      };
    }
  } catch (err) {
    console.error('Error opening code editor:', err);
    showToast('Code-Editor konnte nicht geladen werden.');
  }
}

document.getElementById('close-code-editor-btn').onclick = () => {
  if (collabSocket) {
    collabSocket.close();
    collabSocket = null;
  }
  if (autoSaveDebounceTimeout) {
    clearTimeout(autoSaveDebounceTimeout);
    autoSaveDebounceTimeout = null;
  }
  document.querySelectorAll('[id^="collab-styles-"]').forEach(el => el.remove());

  if (monacoEditorInstance) {
    monacoEditorInstance.dispose();
    monacoEditorInstance = null;
  }
  document.getElementById('code-editor-overlay').classList.remove('active');
  if (typeof loadFiles === 'function') {
    loadFiles(currentFolderId);
  } else {
    loadShareData(currentFolderId);
  }
};

let heicLibLoaded = false;
function loadHeicLib() {
  return new Promise((resolve, reject) => {
    if (heicLibLoaded) return resolve();
    const script = document.createElement('script');
    script.src = 'https://cdnjs.cloudflare.com/ajax/libs/heic2any/0.0.4/heic2any.min.js';
    script.onload = () => {
      heicLibLoaded = true;
      resolve();
    };
    script.onerror = () => reject(new Error('heic2any failed to load.'));
    document.head.appendChild(script);
  });
}

let currentImageObjectUrl = null;

async function openImageViewer(fileId, fileName, isPublic = false, slug = '') {
  const overlay = document.getElementById('image-viewer-overlay');
  const img = document.getElementById('image-viewer-img');
  const loading = document.getElementById('image-viewer-loading');
  const title = document.getElementById('image-viewer-title');

  title.innerHTML = `<i data-lucide="image"></i> ${fileName}`;
  lucide.createIcons();
  
  img.style.display = 'none';
  loading.style.display = 'flex';
  overlay.classList.add('active');

  if (currentImageObjectUrl) {
    URL.revokeObjectURL(currentImageObjectUrl);
    currentImageObjectUrl = null;
  }

  const downloadUrl = isPublic 
    ? `/api/public/shares/${slug}/download/${fileId}`
    : `/api/files/download/${fileId}`;

  const ext = fileName.split('.').pop().toLowerCase();
  
  try {
    if (['heic', 'heif'].includes(ext)) {
      const response = await fetch(downloadUrl);
      if (!response.ok) throw new Error('Failed to fetch image file.');
      const blob = await response.blob();
      
      await loadHeicLib();
      const convertedBlob = await heic2any({
        blob,
        toType: 'image/jpeg',
        quality: 0.8
      });
      
      currentImageObjectUrl = URL.createObjectURL(convertedBlob);
      img.src = currentImageObjectUrl;
    } else if (['cr2', 'nef', 'dng', 'arw', 'orf', 'rw2', 'pef', 'raf'].includes(ext)) {
      const thumbUrl = isPublic
        ? `/api/public/shares/${slug}/thumbnail/${fileId}`
        : `/api/files/thumbnail/${fileId}`;
      img.src = thumbUrl;
    } else {
      img.src = downloadUrl;
    }

    img.onload = () => {
      loading.style.display = 'none';
      img.style.display = 'block';
    };
    img.onerror = () => {
      loading.style.display = 'none';
      title.innerHTML = `<i data-lucide="alert-circle" style="color: #ff5555;"></i> Fehler beim Laden des Bildes`;
      lucide.createIcons();
    };
  } catch (err) {
    console.error('Image viewer error:', err);
    loading.style.display = 'none';
    title.innerHTML = `<i data-lucide="alert-circle" style="color: #ff5555;"></i> Fehler beim Laden des Bildes`;
    lucide.createIcons();
  }
}

document.getElementById('close-image-viewer-btn').onclick = () => {
  document.getElementById('image-viewer-overlay').classList.remove('active');
  const img = document.getElementById('image-viewer-img');
  img.src = '';
  if (currentImageObjectUrl) {
    URL.revokeObjectURL(currentImageObjectUrl);
    currentImageObjectUrl = null;
  }
};

function openVideoViewer(fileId, fileName, isPublic = false, slug = '') {
  const overlay = document.getElementById('video-viewer-overlay');
  const player = document.getElementById('video-viewer-player');
  const title = document.getElementById('video-viewer-title');

  title.innerHTML = `<i data-lucide="video"></i> ${fileName}`;
  lucide.createIcons();

  const sourceUrl = isPublic 
    ? `/api/public/shares/${slug}/download/${fileId}`
    : `/api/files/download/${fileId}`;

  player.src = sourceUrl;
  overlay.classList.add('active');
}

document.getElementById('close-video-viewer-btn').onclick = () => {
  document.getElementById('video-viewer-overlay').classList.remove('active');
  const player = document.getElementById('video-viewer-player');
  player.pause();
  player.src = '';
};

function openPdfViewer(fileId, fileName, isPublic = false, slug = '') {
  const overlay = document.getElementById('pdf-viewer-overlay');
  const iframe = document.getElementById('pdf-viewer-iframe');
  const title = document.getElementById('pdf-viewer-title');

  title.innerHTML = `<i data-lucide="file-text"></i> ${fileName}`;
  lucide.createIcons();

  const sourceUrl = isPublic 
    ? `/api/public/shares/${slug}/download/${fileId}`
    : `/api/files/download/${fileId}`;

  iframe.src = sourceUrl;
  overlay.style.display = 'flex';
  overlay.classList.add('active');
}

document.getElementById('close-pdf-viewer-btn').onclick = () => {
  const overlay = document.getElementById('pdf-viewer-overlay');
  overlay.classList.remove('active');
  overlay.style.display = 'none';
  document.getElementById('pdf-viewer-iframe').src = '';
};

// Backdrop click close for new overlays
['code-editor-overlay', 'image-viewer-overlay', 'video-viewer-overlay', 'pdf-viewer-overlay'].forEach(id => {
  const overlay = document.getElementById(id);
  if (overlay) {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        if (id === 'code-editor-overlay') {
          // Do not close code editor on background click
        } else if (id === 'image-viewer-overlay') {
          document.getElementById('close-image-viewer-btn').click();
        } else if (id === 'video-viewer-overlay') {
          document.getElementById('close-video-viewer-btn').click();
        } else if (id === 'pdf-viewer-overlay') {
          document.getElementById('close-pdf-viewer-btn').click();
        }
      }
    });
  }
});

// Unified display name helper
function updateDisplayNameUI() {
  if (currentUser) {
    const displayName = (currentUser.display_real_name && (currentUser.first_name || currentUser.last_name)) 
      ? `${currentUser.first_name || ''} ${currentUser.last_name || ''}`.trim() 
      : currentUser.username;
    const navUsername = document.getElementById('nav-username');
    if (navUsername) {
      navUsername.textContent = displayName;
    }
  }
}

// User Profile form submission handler
const editProfileForm = document.getElementById('edit-profile-form');
if (editProfileForm) {
  editProfileForm.onsubmit = async (e) => {
    e.preventDefault();
    const payload = {
      first_name: document.getElementById('settings-firstname-input').value.trim(),
      last_name: document.getElementById('settings-lastname-input').value.trim(),
      username: document.getElementById('settings-username-input').value.trim(),
      email: document.getElementById('settings-email-input').value.trim(),
      display_real_name: document.getElementById('settings-display-realname-toggle').checked
    };
    
    try {
      const res = await fetch('/api/settings/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (res.ok) {
        showToast('Profil erfolgreich aktualisiert.');
        currentUser = data.user;
        updateDisplayNameUI();
      } else {
        showToast(data.error || 'Fehler beim Aktualisieren des Profils.');
      }
    } catch (e) {
      showToast('Netzwerkfehler.');
    }
  };
}

// Auto-save display realname toggle on change
const displayRealnameToggle = document.getElementById('settings-display-realname-toggle');
if (displayRealnameToggle) {
  displayRealnameToggle.onchange = async () => {
    const editProfileForm = document.getElementById('edit-profile-form');
    if (editProfileForm && typeof editProfileForm.onsubmit === 'function') {
      const fakeEvent = { preventDefault: () => {} };
      await editProfileForm.onsubmit(fakeEvent);
    }
  };
}

// Admin form submission for new user creation
const adminCreateUserForm = document.getElementById('admin-create-user-form');
if (adminCreateUserForm) {
  adminCreateUserForm.onsubmit = async (e) => {
    e.preventDefault();
    const username = document.getElementById('admin-new-username').value.trim();
    const email = document.getElementById('admin-new-email').value.trim();
    const password = document.getElementById('admin-new-password').value.trim();
    const role = document.getElementById('admin-new-role').value;

    try {
      const res = await fetch('/api/settings/admin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, email, password, role })
      });
      const data = await res.json();
      if (res.ok) {
        showToast(`Benutzer "${username}" erfolgreich erstellt.`);
        document.getElementById('admin-new-username').value = '';
        document.getElementById('admin-new-email').value = '';
        document.getElementById('admin-new-password').value = '';
        loadAdminSettings(); // Refresh list
      } else {
        showToast(data.error || 'Fehler beim Erstellen des Benutzers.');
      }
    } catch (e) {
      showToast('Netzwerkfehler.');
    }
  };
}

function showCreateNoteModal(defaultName) {
  return new Promise((resolve) => {
    const overlay = document.getElementById('create-note-modal-overlay');
    const form = document.getElementById('create-note-form');
    const nameInput = document.getElementById('create-note-name');
    const contentInput = document.getElementById('create-note-content');
    const maxViewsInput = document.getElementById('create-note-max-views');
    const expiresSelect = document.getElementById('create-note-expires');
    const cancelBtn = document.getElementById('cancel-create-note-btn');
    const closeBtn = document.getElementById('close-create-note-btn');

    nameInput.value = defaultName ? (defaultName.endsWith('.txt') ? defaultName : defaultName + '.txt') : 'Einmalnotiz.txt';
    contentInput.value = '';
    maxViewsInput.value = 1;
    expiresSelect.value = '24'; // 24 hours default

    overlay.classList.add('active');
    contentInput.focus();

    const cleanup = () => {
      overlay.classList.remove('active');
      form.onsubmit = null;
      cancelBtn.onclick = null;
      closeBtn.onclick = null;
    };

    form.onsubmit = async (e) => {
      e.preventDefault();
      const payload = {
        name: nameInput.value.trim(),
        content: contentInput.value,
        maxViews: parseInt(maxViewsInput.value) || 1,
        expiresHours: parseInt(expiresSelect.value) || 24,
        parentId: currentFolderId
      };

      showToast('Erstelle Einmalnotiz...');
      cleanup();

      try {
        const res = await fetch('/api/files/create-note', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });

        const data = await res.json();
        if (res.ok) {
          showToast('Einmalnotiz erfolgreich erstellt.');
          loadFiles(currentFolderId);
          showNoteResultModal(data.shareLink);
        } else {
          showToast(data.error || 'Fehler beim Erstellen der Notiz.');
        }
      } catch (err) {
        showToast('Netzwerkfehler beim Erstellen der Notiz.');
      }
      resolve();
    };

    cancelBtn.onclick = () => { cleanup(); resolve(); };
    closeBtn.onclick = () => { cleanup(); resolve(); };
  });
}

function showNoteResultModal(link) {
  const overlay = document.getElementById('note-result-modal-overlay');
  const linkInput = document.getElementById('note-result-link-input');
  const copyBtn = document.getElementById('copy-note-link-btn');
  const closeBtn = document.getElementById('close-note-result-btn');
  const confirmBtn = document.getElementById('confirm-note-result-btn');

  linkInput.value = link;
  overlay.classList.add('active');

  const cleanup = () => {
    overlay.classList.remove('active');
    copyBtn.onclick = null;
    closeBtn.onclick = null;
    confirmBtn.onclick = null;
  };

  copyBtn.onclick = () => {
    linkInput.select();
    document.execCommand('copy');
    showToast('Link in Zwischenablage kopiert!');
  };

  closeBtn.onclick = cleanup;
  confirmBtn.onclick = cleanup;
}

// Plus dropdown menu toggler
const plusMenuBtn = document.getElementById('plus-menu-btn');
const plusDropdownMenu = document.getElementById('plus-dropdown-menu');
if (plusMenuBtn && plusDropdownMenu) {
  plusMenuBtn.onclick = (e) => {
    e.stopPropagation();
    const isVisible = plusDropdownMenu.style.display === 'block';
    plusDropdownMenu.style.display = isVisible ? 'none' : 'block';
  };

  document.addEventListener('click', (e) => {
    if (!e.target.closest('#plus-dropdown-menu') && e.target !== plusMenuBtn) {
      plusDropdownMenu.style.display = 'none';
    }
  });
}

// Disable background scrolling when any modal is open
function checkModalsScrollLock() {
  const overlays = document.querySelectorAll('.modal-overlay');
  let anyOpen = false;
  overlays.forEach(overlay => {
    const isClassActive = overlay.classList.contains('active');
    const isStyleVisible = overlay.style.display && overlay.style.display !== 'none';
    if (isClassActive || isStyleVisible) {
      anyOpen = true;
    }
  });

  if (anyOpen) {
    document.body.style.overflow = 'hidden';
    document.documentElement.style.overflow = 'hidden';
  } else {
    document.body.style.overflow = '';
    document.documentElement.style.overflow = '';
  }
}

// Watch for changes to .modal-overlay class attributes or style attributes
const modalObserver = new MutationObserver(() => {
  checkModalsScrollLock();
});

document.querySelectorAll('.modal-overlay').forEach(overlay => {
  modalObserver.observe(overlay, { attributes: true, attributeFilter: ['class', 'style'] });
});

// Run initially
checkModalsScrollLock();

// Debounced Dashboard Search (Name and Deep Content/OCR Search)
let searchTimeout = null;
const searchInput = document.getElementById('dashboard-search-input');
const searchDeepCheck = document.getElementById('dashboard-search-deep');

if (searchInput && searchDeepCheck) {
  const triggerSearch = async () => {
    const query = searchInput.value.trim();
    if (!query) {
      loadFiles(currentFolderId);
      return;
    }

    try {
      const isDeep = searchDeepCheck.checked;
      const res = await fetch(`/api/files/search?q=${encodeURIComponent(query)}&deep=${isDeep}`);
      if (res.ok) {
        const files = await res.json();
        renderFiles(files);
        
        // Render search breadcrumbs path
        const breadcrumbsContainer = document.getElementById('breadcrumbs');
        breadcrumbsContainer.innerHTML = '';
        
        const homeLink = document.createElement('a');
        homeLink.href = '#';
        homeLink.className = 'breadcrumb-item';
        homeLink.textContent = 'Zurück';
        homeLink.onclick = (e) => {
          e.preventDefault();
          searchInput.value = '';
          loadFiles(currentFolderId);
        };
        breadcrumbsContainer.appendChild(homeLink);

        const sep = document.createElement('span');
        sep.className = 'breadcrumb-separator';
        sep.textContent = '/';
        breadcrumbsContainer.appendChild(sep);

        const searchLabel = document.createElement('span');
        searchLabel.className = 'breadcrumb-current';
        searchLabel.innerHTML = `Suchergebnisse für "${query}" ${isDeep ? '<b>(Tiefensuche)</b>' : ''}`;
        breadcrumbsContainer.appendChild(searchLabel);
      }
    } catch (err) {
      console.error('Search error:', err);
    }
  };

  searchInput.oninput = () => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(triggerSearch, 300);
  };

  searchDeepCheck.onchange = () => {
    if (searchInput.value.trim()) {
      triggerSearch();
    }
  };
}
