// State Management
let currentUser = null;
let currentFolderId = null;
let breadcrumbsHistory = [];
let isRegisterMode = false;
let allShares = []; // Alle Shares des Users
let selectedFileIds = [];
let renderedFilesList = [];
// Lets ArrowLeft/ArrowRight (and Space, image-viewer only) step through the image/video
// viewer without closing it — populated right before openImageViewer/openVideoViewer is called.
let viewerMediaList = [];
let viewerMediaIndex = -1;
let viewerIsPublic = false;
let viewerSlug = '';
let lastSelectedId = null; // Für Shift-Auswahl
let viewMode = localStorage.getItem('viewMode') || 'grid';
let gridSizeIndex = parseInt(localStorage.getItem('gridSizeIndex') || '2');
let listSizeIndex = parseInt(localStorage.getItem('listSizeIndex') || '2');
let isEmailConfigured = false;
let clickTimeout = null;
let clickTimeoutFileId = null;

let clipboardFileIds = [];
let clipboardAction = null; // 'copy' or 'cut'

let sortColumn = null; // 'name' | 'type' | 'size' | 'date' | null (server order)
let sortDirection = 'asc'; // 'asc' | 'desc'

// Admin roles cache + permission labels
let adminRolesCache = [];
let adminPermissionKeys = [];
const PERM_LABELS = {
  admin: 'Admin-Zugriff',
  upload: 'Hochladen',
  create_folder: 'Ordner erstellen',
  delete: 'Löschen',
  rename: 'Umbenennen / Verschieben',
  share: 'Freigaben erstellen',
  download: 'Herunterladen',
  edit_files: 'Dateien bearbeiten',
};

// Real-time collaboration state
let collabSocket = null;
let collabUserColor = null;
let collabUserDecorations = {}; // userId -> decoration IDs
let isApplyingRemoteEdit = false;
let autoSaveDebounceTimeout = null;
let myCollabUserId = null;            // identity the server assigned to us
let collabUserColorMap = {};          // userId -> color (authoritative, from server)


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

// Escapes untrusted strings (filenames, usernames, ...) before they're interpolated into
// innerHTML — those values routinely come from other users (shared/uploaded file names, other
// people's display names) and were previously inserted unescaped, allowing stored XSS.
function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatBytes(bytes) {
  bytes = Number(bytes);
  if (!bytes || Number.isNaN(bytes) || bytes <= 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
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
      checkNotesExist();

      appHeader.style.display = 'flex';

      // Weiche Navigation
      const hash = window.location.hash;
      if (hash === '#settings') {
        showView('settings');
      } else if (hash === '#notes') {
        showView('notes');
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
const notesView = document.getElementById('notes-view');

// Restart the subtle fade-in animation on a view container
function playViewEnter(el) {
  if (!el) return;
  el.classList.remove('view-enter');
  void el.offsetWidth; // force reflow so the animation re-triggers
  el.classList.add('view-enter');
  // Klasse nach Ablauf wieder entfernen: eine dauerhaft "gefüllte" Transform-Animation
  // würde sonst einen Containing Block bilden und position:fixed-Kinder (z.B. die
  // Quickactions-Leiste) relativ zu diesem Element statt zum Viewport positionieren.
  el.addEventListener('animationend', () => el.classList.remove('view-enter'), { once: true });
}

function showView(viewName) {
  currentViewName = viewName;
  applyBackgrounds(viewName);

  // Reset every overlay-style view first; each branch below then opens the one it needs.
  settingsView.style.display = 'none';
  settingsView.classList.remove('active');
  if (adminView) {
    adminView.style.display = 'none';
    adminView.classList.remove('active');
  }
  if (notesView) {
    notesView.style.display = 'none';
    notesView.classList.remove('active');
  }

  document.documentElement.classList.toggle('hide-scrollbar', viewName === 'auth');

  if (viewName === 'auth') {
    playViewEnter(authView);
    authView.style.display = 'flex';
    dashboardView.style.display = 'none';
  } else if (viewName === 'dashboard') {
    authView.style.display = 'none';
    playViewEnter(dashboardView);
    dashboardView.style.display = 'flex';
    loadFiles(currentFolderId);
  } else if (viewName === 'settings') {
    authView.style.display = 'none';
    dashboardView.style.display = 'flex';
    settingsView.style.display = 'flex';
    settingsView.classList.add('active');
    loadSettings();
  } else if (viewName === 'notes') {
    authView.style.display = 'none';
    dashboardView.style.display = 'flex';
    if (notesView) {
      notesView.style.display = 'flex';
      notesView.classList.add('active');
    }
    loadNotesPage();
  } else if (viewName === 'admin') {
    if (currentUser && currentUser.role === 'admin') {
      authView.style.display = 'none';
      dashboardView.style.display = 'flex';
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
    } else if (hash === '#notes') {
      showView('notes');
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

// Settings/Admin are opened as an overlay on top of the dashboard, not a real page navigation —
// use replaceState (no new history entry) instead of assigning location.hash (which pushes one).
// Otherwise every open added a "back" stop that could resurface the panel unexpectedly on a
// later, unrelated use of the browser's back button.
function openHashView(hash, viewName) {
  window.history.replaceState(null, '', hash);
  showView(viewName);
}

// Dropdown Navigation Items
const dropdownSettingsBtn = document.getElementById('dropdown-settings-btn');
if (dropdownSettingsBtn) {
  dropdownSettingsBtn.onclick = (e) => {
    e.preventDefault();
    userDropdownMenu.classList.remove('show');
    openHashView('#settings', 'settings');

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

const dropdownNotesBtn = document.getElementById('dropdown-notes-btn');
if (dropdownNotesBtn) {
  dropdownNotesBtn.onclick = (e) => {
    e.preventDefault();
    userDropdownMenu.classList.remove('show');
    openHashView('#notes', 'notes');
  };
}

const dropdownAdminBtn = document.getElementById('dropdown-admin-btn');
if (dropdownAdminBtn) {
  dropdownAdminBtn.onclick = (e) => {
    e.preventDefault();
    userDropdownMenu.classList.remove('show');
    openHashView('#admin', 'admin');
  };
}

function closeSettingsOrAdmin() {
  window.history.replaceState(null, '', '#dashboard');
  showView('dashboard');
}

document.getElementById('back-to-dashboard-btn').onclick = () => {
  closeSettingsOrAdmin();
};

document.getElementById('notes-back-to-dashboard-btn')?.addEventListener('click', () => {
  closeSettingsOrAdmin();
});

document.getElementById('logo-btn').onclick = (e) => {
  e.preventDefault();
  currentFolderId = null;
  breadcrumbsHistory = [];
  clearSelection();
  window.location.hash = '#dashboard';
  showView('dashboard');
};

/* ==========================================================================
   DASHBOARD / FILES EXPLORER LOGIC
   ========================================================================== */
async function loadFiles(folderId = null) {
  try {
    currentFolderId = folderId;

    // Fade out current content
    const grid = document.getElementById('file-grid');
    if (grid && grid.children.length > 0) {
      grid.classList.add('grid-exit');
    }

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
    if (grid) grid.classList.remove('grid-exit');
    renderFiles(files);
    renderBreadcrumbs();
  } catch (err) {
    console.error(err);
    showToast('Fehler beim Laden des Datei-Explorers.');
  }
}

// One-time notes never appear in the regular file grid — they get their own dedicated page
// (reached via the user dropdown), which itself only shows up in that menu while at least one
// note exists.
async function checkNotesExist() {
  const dropdownBtn = document.getElementById('dropdown-notes-btn');
  if (!dropdownBtn) return;
  try {
    const res = await fetch('/api/files/notes');
    if (!res.ok) return;
    const notes = await res.json();
    dropdownBtn.style.display = notes.length > 0 ? '' : 'none';
  } catch (err) {
    console.error('Error checking notes existence:', err);
  }
}

function renderNoteRow(note) {
  const viewsLabel = note.max_downloads
    ? `${note.download_count}/${note.max_downloads} Aufrufe`
    : `${note.download_count} Aufrufe (unbegrenzt)`;
  const expiresLabel = note.expires_at
    ? `läuft ab ${new Date(note.expires_at).toLocaleString('de-DE')}`
    : 'läuft nie ab';
  const row = document.createElement('div');
  row.className = 'note-row';
  row.dataset.id = note.id;
  row.innerHTML = `
    <i data-lucide="${note.is_folder ? 'folder' : 'file-text'}" style="width: 18px; height: 18px; color: #ffaa00; flex-shrink: 0;"></i>
    <div style="flex: 1; min-width: 0;">
      <div style="font-weight: 600; font-size: 0.85rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(note.name)}</div>
      <div style="font-size: 0.75rem; color: var(--color-text-muted);">${viewsLabel} · ${expiresLabel}</div>
    </div>
    <button type="button" class="btn-icon note-copy-link-btn" title="Link kopieren" data-slug="${escapeHtml(note.slug || '')}">
      <i data-lucide="link"></i>
    </button>
    <button type="button" class="btn-icon note-settings-btn" title="Aufrufe/Ablauf bearbeiten">
      <i data-lucide="settings"></i>
    </button>
    <button type="button" class="btn-icon note-delete-btn" title="Löschen" style="color: #ff5555;" data-id="${note.id}">
      <i data-lucide="trash-2"></i>
    </button>
  `;

  row.querySelector('.note-copy-link-btn').onclick = () => {
    const slug = row.querySelector('.note-copy-link-btn').dataset.slug;
    if (!slug) return;
    navigator.clipboard.writeText(`${window.location.origin}/s/${slug}`);
    showToast('Link kopiert.');
  };
  row.querySelector('.note-settings-btn').onclick = async () => {
    if (!note.share_id) { showToast('Keine Freigabe gefunden.'); return; }
    try {
      const r = await fetch('/api/shares');
      allShares = await r.json();
    } catch { showToast('Verbindungsfehler.'); return; }
    openShareEditModal([note.share_id]);
  };
  row.querySelector('.note-delete-btn').onclick = async () => {
    if (!await showConfirmDialog('Einmalnachricht löschen', 'Diese Einmalnachricht wirklich löschen?')) return;
    try {
      const r = await fetch(`/api/files/${note.id}`, { method: 'DELETE' });
      if (r.ok) { showToast('Gelöscht.'); loadNotesPage(); checkNotesExist(); }
      else showToast('Fehler beim Löschen.');
    } catch { showToast('Verbindungsfehler.'); }
  };

  return row;
}

async function loadNotesPage() {
  const list = document.getElementById('notes-page-list');
  const empty = document.getElementById('notes-page-empty');
  if (!list) return;
  list.innerHTML = '';

  try {
    const res = await fetch('/api/files/notes');
    if (!res.ok) return;
    const notes = await res.json();

    empty.style.display = notes.length === 0 ? 'block' : 'none';
    notes.forEach(note => list.appendChild(renderNoteRow(note)));

    lucide.createIcons();
  } catch (err) {
    console.error('Error loading notes page:', err);
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
    clearSelection();
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
        clearSelection();
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

// Welcher Ansichtstyp das Quick-Settings-Menü aktuell offen hat (null = geschlossen)
let quickSettingsOpenKind = null;
let quickSettingsDocListener = null;

// Quick-Settings-Menü schließen und den zugehörigen Dokument-Listener entfernen
function closeQuickSettingsMenu() {
  document.querySelectorAll('.quick-settings-menu').forEach(m => m.remove());
  if (quickSettingsDocListener) {
    document.removeEventListener('click', quickSettingsDocListener);
    quickSettingsDocListener = null;
  }
  quickSettingsOpenKind = null;
}

// Quick-Settings-Menü (Kachelgröße / Listenabstand) – öffnet sich beim erneuten Klick
// auf das aktive Ansichts-Icon in der Toolbar und schließt sich beim erneuten Klick wieder.
function showQuickSettingsMenu(kind, anchorEl) {
  // Erneuter Klick auf denselben (aktiven) Button => Menü umschalten und schließen
  if (quickSettingsOpenKind === kind) {
    closeQuickSettingsMenu();
    return;
  }
  closeQuickSettingsMenu();
  quickSettingsOpenKind = kind;

  const isGrid = kind === 'grid';
  const sizeIndex = isGrid ? gridSizeIndex : listSizeIndex;
  const sizeNames = isGrid
    ? ['Sehr klein', 'Klein', 'Mittel', 'Groß', 'Sehr groß']
    : ['Sehr kompakt', 'Kompakt', 'Normal', 'Bequem', 'Geräumig'];
  const label = isGrid ? 'Kachelgröße' : 'Listenabstand';

  const menu = document.createElement('div');
  menu.className = 'card context-menu quick-settings-menu';
  menu.innerHTML = `
    <div class="quick-settings-row">
      <div class="quick-settings-label-row">
        <span>${label}</span>
        <span class="quick-settings-value">${sizeNames[sizeIndex]}</span>
      </div>
      <input type="range" min="0" max="4" step="1" value="${sizeIndex}" class="quick-settings-slider">
    </div>
  `;

  document.body.appendChild(menu);

  const rect = anchorEl.getBoundingClientRect();
  const menuRect = menu.getBoundingClientRect();
  let left = rect.left;
  if (left + menuRect.width > window.innerWidth - 12) {
    left = window.innerWidth - menuRect.width - 12;
  }
  menu.style.left = `${Math.max(12, left)}px`;
  menu.style.top = `${rect.bottom + 8}px`;

  const slider = menu.querySelector('.quick-settings-slider');
  const valueLabel = menu.querySelector('.quick-settings-value');

  slider.oninput = () => {
    const idx = parseInt(slider.value, 10);
    valueLabel.textContent = sizeNames[idx];
    if (isGrid) {
      gridSizeIndex = idx;
      localStorage.setItem('gridSizeIndex', idx);
    } else {
      listSizeIndex = idx;
      localStorage.setItem('listSizeIndex', idx);
    }
    applyLayoutDensity();
  };

  // Klick außerhalb des Menüs (und nicht auf den Anker-Button) schließt das Menü
  quickSettingsDocListener = (e) => {
    if (!menu.contains(e.target) && e.target !== anchorEl) {
      closeQuickSettingsMenu();
    }
  };
  setTimeout(() => document.addEventListener('click', quickSettingsDocListener), 50);
}

// Category → [label, color]
const FILE_TYPE_MAP = {
  // Ordner
  folder:       ['Ordner',        '#f5a623'],
  // Dokumente
  pdf:          ['PDF',           '#e74c3c'],
  docx:         ['Dokument',      '#2980b9'], doc: ['Dokument','#2980b9'],
  odt:          ['Dokument',      '#2980b9'], rtf: ['Dokument','#2980b9'],
  // Tabellen
  xlsx:         ['Tabelle',       '#27ae60'], xls: ['Tabelle','#27ae60'],
  ods:          ['Tabelle',       '#27ae60'], csv: ['Tabelle','#27ae60'],
  // Präsentationen
  pptx:         ['Präsentation',  '#e67e22'], ppt: ['Präsentation','#e67e22'],
  odp:          ['Präsentation',  '#e67e22'],
  // Bilder
  png:          ['Bild',          '#8e44ad'], jpg: ['Bild','#8e44ad'],
  jpeg:         ['Bild',          '#8e44ad'], gif: ['Bild','#8e44ad'],
  webp:         ['Bild',          '#8e44ad'], svg: ['Bild','#8e44ad'],
  bmp:          ['Bild',          '#8e44ad'], ico: ['Bild','#8e44ad'],
  // RAW-Bilder
  heic:         ['RAW-Bild',      '#6c3483'], heif: ['RAW-Bild','#6c3483'],
  cr2:          ['RAW-Bild',      '#6c3483'], nef:  ['RAW-Bild','#6c3483'],
  dng:          ['RAW-Bild',      '#6c3483'], arw:  ['RAW-Bild','#6c3483'],
  orf:          ['RAW-Bild',      '#6c3483'], rw2:  ['RAW-Bild','#6c3483'],
  pef:          ['RAW-Bild',      '#6c3483'], raf:  ['RAW-Bild','#6c3483'],
  // Video
  mp4:          ['Video',         '#c0392b'], webm: ['Video','#c0392b'],
  mov:          ['Video',         '#c0392b'], avi:  ['Video','#c0392b'],
  mkv:          ['Video',         '#c0392b'], flv:  ['Video','#c0392b'],
  wmv:          ['Video',         '#c0392b'], m4v:  ['Video','#c0392b'],
  // Audio
  mp3:          ['Audio',         '#1abc9c'], wav:  ['Audio','#1abc9c'],
  flac:         ['Audio',         '#1abc9c'], aac:  ['Audio','#1abc9c'],
  m4a:          ['Audio',         '#1abc9c'], ogg:  ['Audio','#1abc9c'],
  // Text & Markdown
  txt:          ['Textdatei',     '#7f8c8d'], md: ['Markdown','#7f8c8d'],
  // Code
  js:           ['JavaScript',    '#f1c40f'], mjs: ['JavaScript','#f1c40f'],
  cjs:          ['JavaScript',    '#f1c40f'], jsx: ['JavaScript','#f1c40f'],
  ts:           ['TypeScript',    '#3498db'], tsx: ['TypeScript','#3498db'],
  html:         ['HTML',          '#e74c3c'], xml: ['XML','#e74c3c'],
  css:          ['CSS',           '#2980b9'], scss: ['CSS','#2980b9'], less: ['CSS','#2980b9'],
  py:           ['Python',        '#3498db'], json: ['JSON','#95a5a6'],
  yaml:         ['YAML',          '#95a5a6'], yml:  ['YAML','#95a5a6'],
  sh:           ['Shell',         '#5b7ba6'], bash: ['Shell','#5b7ba6'],
  php:          ['PHP',           '#8e44ad'], rb: ['Ruby','#c0392b'],
  sql:          ['SQL',           '#16a085'],
  c:            ['C-Code',        '#5b7ba6'], cpp: ['C++','#5b7ba6'],
  h:            ['Header',        '#7f8c8d'], hpp: ['Header','#7f8c8d'],
  cs:           ['C#',            '#27ae60'], go: ['Go','#1abc9c'],
  rs:           ['Rust',          '#e67e22'], java: ['Java','#e74c3c'],
  // Archive
  zip:          ['Archiv',        '#d35400'], tar:  ['Archiv','#d35400'],
  gz:           ['Archiv',        '#d35400'], rar:  ['Archiv','#d35400'],
  '7z':         ['Archiv',        '#d35400'], bz2:  ['Archiv','#d35400'],
  xz:           ['Archiv',        '#d35400'],
  // System/Sonstiges
  iso:          ['ISO-Image',     '#7f8c8d'], apk: ['Android-App','#27ae60'],
  deb:          ['Paket',         '#7f8c8d'], rpm: ['Paket','#7f8c8d'],
  exe:          ['Programm',      '#95a5a6'], msi: ['Programm','#95a5a6'],
  dmg:          ['Programm',      '#95a5a6'],
};

/* ─── Drag Ghost ─── */
let _dragGhost = null;

function createDragGhost(count, iconColor) {
  removeDragGhost();
  const ghost = document.createElement('div');
  ghost.id = 'drag-ghost';

  for (let i = Math.min(count - 1, 2); i >= 1; i--) {
    const back = document.createElement('div');
    back.className = `ghost-card ghost-back-${i}`;
    ghost.appendChild(back);
  }

  const main = document.createElement('div');
  main.className = 'ghost-card ghost-main';
  main.innerHTML = `<i data-lucide="files" style="width:28px;height:28px;color:${iconColor};"></i>`;
  ghost.appendChild(main);

  if (count > 1) {
    const badge = document.createElement('div');
    badge.className = 'ghost-count';
    badge.textContent = count;
    ghost.appendChild(badge);
  }

  document.body.appendChild(ghost);
  _dragGhost = ghost;
  if (typeof lucide !== 'undefined') lucide.createIcons({ el: ghost });
}

function removeDragGhost() {
  if (_dragGhost) {
    _dragGhost.classList.add('ghost-leaving');
    const el = _dragGhost;
    _dragGhost = null;
    setTimeout(() => el.remove(), 220);
  }
}

function getFileTypeLabel(file) {
  if (file.is_folder) return 'Ordner';
  const ext = file.name.split('.').pop().toLowerCase();
  return FILE_TYPE_MAP[ext]?.[0] || (ext ? ext.toUpperCase() : 'Datei');
}

function getFileIconColor(file) {
  if (file.is_folder) return FILE_TYPE_MAP.folder[1];
  const ext = file.name.split('.').pop().toLowerCase();
  return FILE_TYPE_MAP[ext]?.[1] || 'var(--color-accent)';
}

// Compares two files by the currently active sort column; folders and files are mixed together
// (no special folders-first grouping) since the user explicitly picked a column to sort by.
function compareFilesBySort(a, b) {
  let result = 0;
  switch (sortColumn) {
    case 'name':
      result = a.name.localeCompare(b.name, 'de', { sensitivity: 'base' });
      break;
    case 'type':
      // Folders first regardless of their (somewhat arbitrary) type label — falls back to the
      // usual alphabetical type comparison once both sides are folders or both are files. The
      // asc/desc flip below then naturally puts folders last when sorted descending.
      result = (a.is_folder ? 0 : 1) - (b.is_folder ? 0 : 1);
      if (result === 0) {
        result = getFileTypeLabel(a).localeCompare(getFileTypeLabel(b), 'de', { sensitivity: 'base' });
      }
      break;
    case 'size':
      result = (a.size || 0) - (b.size || 0);
      break;
    case 'date':
      result = new Date(a.created_at || 0) - new Date(b.created_at || 0);
      break;
  }
  return sortDirection === 'asc' ? result : -result;
}

// Sets (or toggles asc/desc on) the active sort column and re-renders the current file list.
function setSortColumn(column) {
  if (sortColumn === column) {
    sortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
  } else {
    sortColumn = column;
    sortDirection = 'asc';
  }
  renderFiles(renderedFilesList);
}

// Refreshes the sortable header row: visible only in list view, arrow shown on the active column.
function updateSortHeaderUI() {
  const header = document.getElementById('file-list-header');
  if (header) {
    header.style.display = viewMode === 'list' ? 'flex' : 'none';
    header.querySelectorAll('.flh-col').forEach(btn => {
      if (btn.dataset.sort === sortColumn) {
        btn.classList.add('active');
        btn.setAttribute('data-dir', sortDirection);
      } else {
        btn.classList.remove('active');
        btn.removeAttribute('data-dir');
      }
    });
  }

  const sortBtn = document.getElementById('sort-toggle-btn');
  if (sortBtn) sortBtn.classList.toggle('active', !!sortColumn);

  const openSortMenu = document.querySelector('.sort-menu');
  if (openSortMenu) renderSortMenuItems(openSortMenu);
}

const SORT_MENU_COLUMNS = [
  { key: 'name', label: 'Name' },
  { key: 'type', label: 'Typ' },
  { key: 'size', label: 'Größe' },
  { key: 'date', label: 'Erstellt am' },
];

// (Re)builds the sort dropdown's items so it reflects the current sortColumn/sortDirection.
function renderSortMenuItems(menu) {
  menu.innerHTML = SORT_MENU_COLUMNS.map(col => {
    const isActive = sortColumn === col.key;
    const arrowIcon = isActive && sortDirection === 'desc' ? 'arrow-down' : 'arrow-up';
    return `
      <button type="button" class="btn-menu-item sort-menu-item ${isActive ? 'active' : ''}" data-sort="${col.key}">
        <span>${col.label}</span>
        <i data-lucide="${arrowIcon}" class="sort-menu-arrow" style="opacity: ${isActive ? 1 : 0};"></i>
      </button>
    `;
  }).join('');
  lucide.createIcons();
  menu.querySelectorAll('.sort-menu-item').forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      setSortColumn(btn.dataset.sort);
    };
  });
}

let sortMenuDocListener = null;

function closeSortMenu() {
  document.querySelectorAll('.sort-menu').forEach(m => m.remove());
  if (sortMenuDocListener) {
    document.removeEventListener('click', sortMenuDocListener);
    sortMenuDocListener = null;
  }
}

// Sort dropdown, anchored under the toolbar's sort button — works in both grid and list view.
function showSortMenu(anchorEl) {
  if (document.querySelector('.sort-menu')) {
    closeSortMenu();
    return;
  }
  closeQuickSettingsMenu();

  const menu = document.createElement('div');
  menu.className = 'card context-menu sort-menu';
  document.body.appendChild(menu);
  renderSortMenuItems(menu);

  const rect = anchorEl.getBoundingClientRect();
  const menuRect = menu.getBoundingClientRect();
  let left = rect.left;
  if (left + menuRect.width > window.innerWidth - 12) {
    left = window.innerWidth - menuRect.width - 12;
  }
  menu.style.left = `${Math.max(12, left)}px`;
  menu.style.top = `${rect.bottom + 8}px`;

  sortMenuDocListener = (e) => {
    if (!menu.contains(e.target) && e.target !== anchorEl && !anchorEl.contains(e.target)) {
      closeSortMenu();
    }
  };
  setTimeout(() => document.addEventListener('click', sortMenuDocListener), 50);
}

function renderFiles(files) {
  if (sortColumn) {
    files = [...files].sort(compareFilesBySort);
  }
  renderedFilesList = files;
  updateSortHeaderUI();
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

  files.forEach((file, _fi) => {
    const item = document.createElement('div');
    item.className = 'file-item';
    item.setAttribute('data-id', file.id);
    item.style.setProperty('--fi', _fi);
    item.classList.add('file-item-enter');
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

    const iconColor = getFileIconColor(file);
    const isThumb = isImg || isVid;
    // Kacheln mit echtem Vorschaubild bekommen mehr Platz fürs Bild (siehe .has-thumb CSS)
    if (isThumb) item.classList.add('has-thumb');
    let iconHTML = `<i data-lucide="${iconName}" style="color: ${iconColor};"></i>`;
    if (isThumb) {
      const thumbUrl = `/api/files/thumbnail/${file.id}`;
      iconHTML = `<img src="${thumbUrl}" style="width: 100%; height: 100%; object-fit: cover; border-radius: var(--radius-sm);" onerror="this.style.display='none'; this.nextElementSibling.style.display='block';">
                  <i data-lucide="${iconName}" style="display: none; color: ${iconColor};"></i>`;
    }

    const typeLabel = getFileTypeLabel(file);
    const sizeStr = formatBytes(file.size);
    const dateStr = file.created_at
      ? new Date(file.created_at).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' })
      : '';
    const iconBoxStyle = viewMode === 'list'
      ? 'display: flex; align-items: center; justify-content: center; overflow: hidden; width: 48px; height: 48px;'
      : 'display: flex; align-items: center; justify-content: center; overflow: hidden;';

    item.innerHTML = `
      <div class="file-item-checkbox"></div>
      <div class="file-info-group" style="display: flex; flex-direction: column; flex: 1; min-width: 0; gap: 2px;">
        <div class="file-name" title="${escapeHtml(file.name)}" style="margin: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${escapeHtml(file.name)}</div>
        <div class="file-meta-list" style="display: none; align-items: center; gap: 0.5rem; font-size: 0.75rem; color: var(--color-text-muted);">
          <span class="file-ext-label" style="text-transform: uppercase; font-weight: 600; font-size: 0.7rem; background: rgba(var(--color-accent-rgb), 0.1); color: var(--color-accent); padding: 1px 4px; border-radius: 3px;">${typeLabel}</span>
          <span>•</span>
          <span>${sizeStr}</span>
        </div>
      </div>
      <div class="file-icon ${isThumb ? 'file-icon-thumb' : 'file-icon-placeholder'}" style="${iconBoxStyle} --icon-color: ${iconColor};">${iconHTML}</div>
      <div class="file-type-label" style="color: ${iconColor};">${typeLabel}</div>
      <div class="file-info">${sizeStr}</div>
      <div class="file-date">${dateStr}</div>
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
        clearSelection();
        breadcrumbsHistory.push({ id: file.id, name: file.name });
        loadFiles(file.id);
      } else {
        const ext = file.name.split('.').pop().toLowerCase();
        
        // Define groupings
        const imageExts = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'heic', 'heif', 'cr2', 'nef', 'dng', 'arw', 'orf', 'rw2', 'pef', 'raf'];
        const videoExts = ['mp4', 'webm', 'ogg', 'mov', 'avi', 'mkv', 'flv', 'wmv', 'm4v'];
        const codeExts = ['txt', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'html', 'xml', 'css', 'scss', 'less', 'py', 'json', 'yaml', 'yml', 'c', 'cpp', 'h', 'hpp', 'cs', 'go', 'rs', 'java', 'sh', 'bash', 'md', 'php', 'rb', 'sql'];
        const officeExts = ['docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp'];

        if (imageExts.includes(ext) || videoExts.includes(ext)) {
          viewerMediaList = renderedFilesList.filter(f => !f.is_folder && [...imageExts, ...videoExts].includes(f.name.split('.').pop().toLowerCase()));
          viewerMediaIndex = viewerMediaList.findIndex(f => f.id === file.id);
          viewerIsPublic = false;
          viewerSlug = '';
        }

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

    // Drag & Drop (internal: move into folder)
    item.setAttribute('draggable', 'true');

    item.addEventListener('dragstart', (e) => {
      const ids = selectedFileIds.includes(file.id) ? selectedFileIds : [file.id];
      e.dataTransfer.setData('text/x-mycloud-ids', JSON.stringify(ids));
      e.dataTransfer.effectAllowed = 'move';
      // Suppress native ghost image
      const blank = new Image();
      blank.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAUEBAAAACwAAAAAAQABAAACAkQBADs=';
      e.dataTransfer.setDragImage(blank, 0, 0);
      createDragGhost(ids.length, iconColor);
      item.classList.add('dragging');
    });

    item.addEventListener('dragend', () => {
      item.classList.remove('dragging');
      document.querySelectorAll('.file-item.drag-over').forEach(el => el.classList.remove('drag-over'));
      removeDragGhost();
    });

    if (file.is_folder) {
      item.addEventListener('dragover', (e) => {
        if (e.dataTransfer.types.includes('text/x-mycloud-ids')) {
          e.preventDefault();
          e.stopPropagation();
          e.dataTransfer.dropEffect = 'move';
          item.classList.add('drag-over');
        }
      });

      item.addEventListener('dragleave', (e) => {
        if (!item.contains(e.relatedTarget)) {
          item.classList.remove('drag-over');
        }
      });

      item.addEventListener('drop', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        item.classList.remove('drag-over');
        const raw = e.dataTransfer.getData('text/x-mycloud-ids');
        if (!raw) return;
        const ids = JSON.parse(raw);
        if (ids.includes(file.id)) return;
        try {
          const res = await fetch('/api/files/move-multiple', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fileIds: ids, targetFolderId: file.id })
          });
          if (res.ok) {
            showToast(`${ids.length} Element(e) verschoben!`);
            clearSelection();
            loadFiles(currentFolderId);
          } else {
            const err = await res.json();
            showToast(err.error || 'Fehler beim Verschieben.');
          }
        } catch {
          showToast('Verbindungsfehler beim Verschieben.');
        }
      });
    }

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
    const wasHidden = bar.style.display !== 'flex';
    bar.style.display = 'flex';
    if (wasHidden) {
      bar.classList.remove('bar-enter');
      void bar.offsetWidth;
      bar.classList.add('bar-enter');
    }
    countSpan.textContent = `${selectedFileIds.length} ausgewählt`;
  } else {
    bar.style.display = 'none';
    bar.classList.remove('bar-enter');
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
      label: 'Kopieren',
      icon: 'copy',
      action: () => {
        clipboardFileIds = [...selectedFileIds];
        clipboardAction = 'copy';
        showToast(`${selectedFileIds.length} Element(e) kopiert!`);
      }
    });
    actions.push({
      label: 'Ausschneiden',
      icon: 'scissors',
      action: () => {
        clipboardFileIds = [...selectedFileIds];
        clipboardAction = 'cut';
        showToast(`${selectedFileIds.length} Element(e) ausgeschnitten!`);
      }
    });
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
      label: 'Kopieren',
      icon: 'copy',
      action: () => {
        clipboardFileIds = [file.id];
        clipboardAction = 'copy';
        showToast('1 Element kopiert!');
      }
    });
    actions.push({
      label: 'Ausschneiden',
      icon: 'scissors',
      action: () => {
        clipboardFileIds = [file.id];
        clipboardAction = 'cut';
        showToast('1 Element ausgeschnitten!');
      }
    });

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
// Bound to the whole document (not just #dashboard-view) because the actual page content sits
// in a centered, max-width .container — on any wider viewport there's a real margin of plain
// <body> background on both sides that isn't inside #dashboard-view at all, where a right-click
// used to always fall through to the browser's native menu instead of this one.
document.oncontextmenu = (e) => {
  if (currentViewName !== 'dashboard') return;
  // Excluding the whole <header> used to also swallow right-clicks on the empty space
  // around its controls (e.g. left of the logo), showing the browser's native menu there
  // instead of ours — only the actual interactive controls need to opt out.
  const isHeaderControl = e.target.closest('header') && e.target.closest('button, a, input, select, .user-menu-trigger, .user-dropdown-menu');
  if (e.target.closest('.file-item') || e.target.closest('.settings-layout') || isHeaderControl || e.target.closest('.modal') || e.target.closest('#multi-actions-bar')) {
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
        <span style="font-weight: 500; text-overflow: ellipsis; overflow: hidden; white-space: nowrap; max-width: 200px;" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</span>
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
document.getElementById('multi-copy-btn').onclick = () => {
  if (selectedFileIds.length === 0) return;
  clipboardFileIds = [...selectedFileIds];
  clipboardAction = 'copy';
  showToast(`${selectedFileIds.length} Element(e) kopiert!`);
};
document.getElementById('multi-cut-btn').onclick = () => {
  if (selectedFileIds.length === 0) return;
  clipboardFileIds = [...selectedFileIds];
  clipboardAction = 'cut';
  showToast(`${selectedFileIds.length} Element(e) ausgeschnitten!`);
};
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
  if (e.dataTransfer.types.includes('text/x-mycloud-ids')) return;
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
  if (e.dataTransfer.types.includes('text/x-mycloud-ids')) return;
  dragCounter--;
  if (dragCounter === 0) {
    dragOverlay.style.display = 'none';
  }
});

dashboard.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragCounter = 0;
  dragOverlay.style.display = 'none';

  // Internal drag-and-drop (moving items into folders) is handled by folder items themselves
  if (e.dataTransfer.types.includes('text/x-mycloud-ids')) return;

  const files = e.dataTransfer.files;
  if (files.length === 0) return;

  await uploadMultipleFiles(files);
});

document.addEventListener('dragover', (e) => {
  if (_dragGhost) {
    _dragGhost.style.left = (e.clientX + 14) + 'px';
    _dragGhost.style.top  = (e.clientY + 14) + 'px';
  }
});


/* ==========================================================================
   SHARING MODAL LOGIC
   ========================================================================== */
const shareModal = document.getElementById('share-modal-overlay');
const shareForm = document.getElementById('share-form');
const shareSlugInput = document.getElementById('share-slug');
const shareCanReadCheck = document.getElementById('share-can-read');
const shareCanWriteCheck = document.getElementById('share-can-write');
const shareCanDownloadCheck = document.getElementById('share-can-download');
const shareCanZipCheck = document.getElementById('share-can-zip');
const shareCanCollabCheck = document.getElementById('share-can-collab');
const shareAddMessageCheck = document.getElementById('share-add-message');
const shareMessageInput = document.getElementById('share-message-input');
shareAddMessageCheck.onchange = () => {
  shareMessageInput.style.display = shareAddMessageCheck.checked ? 'block' : 'none';
  if (!shareAddMessageCheck.checked) shareMessageInput.value = '';
};

// Which permission rows apply to the file currently open in the share modal — set by
// openShareModal(), read by updateSharePermissionsUI() so it knows what to restore when
// "Inhalte anzeigen" gets re-checked after being off.
let shareModalApplicability = { canWrite: true, onlyUpload: false, canCollab: false };

// Without read access there's nothing to browse, edit live, or bulk-download as a ZIP — only a
// direct single-file download still makes sense, so every other permission collapses down to
// just that when "Inhalte anzeigen" is off.
function updateSharePermissionsUI() {
  const canRead = shareCanReadCheck.checked;
  const writeRow = shareCanWriteCheck.closest('label');
  const zipRow = shareCanZipCheck.closest('label');
  const onlyUploadContainer = document.getElementById('share-only-upload-container');
  const collabContainer = document.getElementById('share-can-collab-container');

  if (!canRead) {
    if (writeRow) writeRow.style.display = 'none';
    if (zipRow) zipRow.style.display = 'none';
    if (onlyUploadContainer) onlyUploadContainer.style.display = 'none';
    if (collabContainer) collabContainer.style.display = 'none';
    // Remember the pre-collapse zip state so re-enabling "Inhalte anzeigen" doesn't leave it
    // stuck unchecked — write/collab stay off by default instead, since those are the more
    // sensitive permissions and worth a deliberate re-enable.
    if (shareCanZipCheck.dataset.restoreChecked === undefined) {
      shareCanZipCheck.dataset.restoreChecked = shareCanZipCheck.checked ? '1' : '0';
    }
    shareCanWriteCheck.checked = false;
    shareCanZipCheck.checked = false;
    document.getElementById('share-only-upload').checked = false;
    shareCanCollabCheck.checked = false;
  } else {
    if (writeRow) writeRow.style.display = '';
    if (zipRow) zipRow.style.display = '';
    if (onlyUploadContainer) onlyUploadContainer.style.display = shareModalApplicability.onlyUpload ? 'flex' : 'none';
    if (collabContainer) collabContainer.style.display = shareModalApplicability.canCollab ? 'flex' : 'none';
    if (shareCanZipCheck.dataset.restoreChecked !== undefined) {
      shareCanZipCheck.checked = shareCanZipCheck.dataset.restoreChecked === '1';
      delete shareCanZipCheck.dataset.restoreChecked;
    }
  }
}
shareCanReadCheck.onchange = updateSharePermissionsUI;

// Collaborative editing needs write access, so keep the two checkboxes in sync in both
// directions rather than allowing an inconsistent "collab on, write off" combination.
shareCanCollabCheck.onchange = () => {
  if (shareCanCollabCheck.checked) shareCanWriteCheck.checked = true;
};
shareCanWriteCheck.onchange = () => {
  if (!shareCanWriteCheck.checked) shareCanCollabCheck.checked = false;
};
// Wraps a native <select> with a custom button + dropdown menu styled like the rest of the
// app — native <option> lists render with the OS's own light-on-white styling regardless of
// page CSS, which was unreadable against this app's dark theme. The underlying <select> stays
// in the DOM (just hidden) and its value/change-event keep working exactly as before, so every
// existing .value read/write and .onchange handler elsewhere in the code needs no changes.
function styleSelectAsDropdown(select) {
  select.style.display = 'none';
  const wrap = document.createElement('div');
  wrap.style.width = '100%';
  select.insertAdjacentElement('afterend', wrap);

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'custom-select-btn';
  const label = document.createElement('span');
  const chevron = document.createElement('i');
  chevron.setAttribute('data-lucide', 'chevron-down');
  chevron.style.cssText = 'width:14px;height:14px;opacity:0.6;flex-shrink:0;';
  btn.appendChild(label);
  btn.appendChild(chevron);
  wrap.appendChild(btn);
  if (typeof lucide !== 'undefined') lucide.createIcons();

  const syncLabel = () => {
    label.textContent = select.options[select.selectedIndex] ? select.options[select.selectedIndex].textContent : '';
  };
  syncLabel();
  select._syncCustomLabel = syncLabel;

  btn.onclick = (e) => {
    e.stopPropagation();
    if (document.querySelector('.custom-select-menu')) {
      closeCustomSelectMenus();
      return;
    }
    closeCustomSelectMenus();

    const menu = document.createElement('div');
    menu.className = 'card context-menu custom-select-menu';
    menu.innerHTML = Array.from(select.options).map((opt, i) => `
      <button type="button" class="btn-menu-item ${i === select.selectedIndex ? 'active' : ''}" data-index="${i}">
        <span>${escapeHtml(opt.textContent)}</span>
      </button>
    `).join('');
    document.body.appendChild(menu);

    const rect = btn.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    let left = rect.left;
    if (left + menuRect.width > window.innerWidth - 12) left = window.innerWidth - menuRect.width - 12;
    menu.style.left = `${Math.max(12, left)}px`;
    menu.style.top = `${rect.bottom + 6}px`;
    menu.style.width = `${rect.width}px`;

    menu.querySelectorAll('[data-index]').forEach(item => {
      item.onclick = (ev) => {
        ev.stopPropagation();
        select.selectedIndex = parseInt(item.dataset.index, 10);
        syncLabel();
        select.dispatchEvent(new Event('change'));
        closeCustomSelectMenus();
      };
    });

    setTimeout(() => document.addEventListener('click', closeCustomSelectMenus, { once: true }), 50);
  };
}

function closeCustomSelectMenus() {
  document.querySelectorAll('.custom-select-menu, .number-picker').forEach(m => m.remove());
}

const shareExpiryType = document.getElementById('share-expiry-type');
styleSelectAsDropdown(shareExpiryType);

// Scrollable number picker (Apple-picker-wheel-inspired, but in the app's own glass-menu look)
// for the share-link downloads limit, instead of a bare number input.
const NUMBER_PICKER_VALUES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 15, 20, 25, 30, 40, 50, 75, 100, 150, 200, 250, 500, 1000];
const NUMBER_PICKER_OPTION_HEIGHT = 24;

// opts.values overrides the default preset list; opts.unlimitedLabel omitted disables the
// "Unbegrenzt" shortcut button entirely (used for expiry hours/days, which have no such concept).
function openNumberPicker(input, opts = {}) {
  if (document.querySelector('.number-picker')) {
    closeCustomSelectMenus();
    return;
  }
  closeCustomSelectMenus();

  const presetValues = opts.values || NUMBER_PICKER_VALUES;
  const currentVal = input.value ? parseInt(input.value, 10) : null;
  const values = [...presetValues];
  if (currentVal && !values.includes(currentVal)) {
    values.push(currentVal);
    values.sort((a, b) => a - b);
  }

  const menu = document.createElement('div');
  menu.className = 'card context-menu number-picker';
  menu.innerHTML = `
    ${opts.unlimitedLabel ? `<button type="button" class="btn-menu-item number-picker-unlimited">${escapeHtml(opts.unlimitedLabel)}</button>` : ''}
    <div class="number-picker-wheel">
      <div class="number-picker-wheel-pad"></div>
      ${values.map(v => `<div class="number-picker-option" data-value="${v}">${v}</div>`).join('')}
      <div class="number-picker-wheel-pad"></div>
    </div>
  `;
  document.body.appendChild(menu);

  const rect = input.getBoundingClientRect();
  const menuRect = menu.getBoundingClientRect();
  let left = rect.left;
  if (left + menuRect.width > window.innerWidth - 12) left = window.innerWidth - menuRect.width - 12;
  menu.style.left = `${Math.max(12, left)}px`;
  menu.style.top = `${rect.bottom + 6}px`;
  // Deliberately not stretched to the input's own width (unlike .custom-select-menu) — the
  // wheel only ever shows short numbers, so a wide input (e.g. "In wie vielen Stunden...")
  // would otherwise leave the picker looking oversized and mostly empty.

  const wheel = menu.querySelector('.number-picker-wheel');
  const options = Array.from(menu.querySelectorAll('.number-picker-option'));

  const updateSelected = () => {
    const centerIndex = Math.min(options.length - 1, Math.max(0, Math.round(wheel.scrollTop / NUMBER_PICKER_OPTION_HEIGHT)));
    options.forEach((opt, i) => opt.classList.toggle('selected', i === centerIndex));
  };
  wheel.addEventListener('scroll', updateSelected);

  options.forEach((opt, i) => {
    opt.onclick = () => wheel.scrollTo({ top: i * NUMBER_PICKER_OPTION_HEIGHT, behavior: 'smooth' });
  });

  const initialIndex = currentVal ? values.indexOf(currentVal) : -1;
  wheel.scrollTop = initialIndex >= 0 ? initialIndex * NUMBER_PICKER_OPTION_HEIGHT : 0;
  updateSelected();

  const unlimitedBtn = menu.querySelector('.number-picker-unlimited');
  if (unlimitedBtn) {
    unlimitedBtn.onclick = (e) => {
      e.stopPropagation();
      input.value = '';
      menu.remove();
      document.removeEventListener('click', closeHandler);
    };
  }

  const closeHandler = (e) => {
    if (!menu.contains(e.target) && e.target !== input) {
      const centerIndex = Math.round(wheel.scrollTop / NUMBER_PICKER_OPTION_HEIGHT);
      if (options[centerIndex]) input.value = options[centerIndex].dataset.value;
      menu.remove();
      document.removeEventListener('click', closeHandler);
    }
  };
  setTimeout(() => document.addEventListener('click', closeHandler), 50);
}

const shareMaxDownloadsInput = document.getElementById('share-max-downloads');
shareMaxDownloadsInput.onclick = () => openNumberPicker(shareMaxDownloadsInput, { unlimitedLabel: 'Unbegrenzt' });
const shareExpiryHoursInput = document.getElementById('share-expiry-hours');
const shareExpiryDaysInput = document.getElementById('share-expiry-days');
shareExpiryHoursInput.onclick = () => openNumberPicker(shareExpiryHoursInput, { values: [1, 2, 3, 6, 12, 18, 24, 48, 72] });
shareExpiryDaysInput.onclick = () => openNumberPicker(shareExpiryDaysInput, { values: [1, 2, 3, 5, 7, 14, 30, 60, 90] });
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
  shareCanReadCheck.checked = true;
  delete shareCanZipCheck.dataset.restoreChecked;
  shareCanWriteCheck.checked = false;
  shareCanDownloadCheck.checked = true;
  shareCanZipCheck.checked = true;
  shareCanCollabCheck.checked = false;
  if (shareExpiryType) { shareExpiryType.value = 'none'; shareExpiryType._syncCustomLabel?.(); }
  if (shareExpiryHoursInput) shareExpiryHoursInput.value = '';
  if (shareExpiryDaysInput) shareExpiryDaysInput.value = '';
  if (shareExpiryCustomInput) shareExpiryCustomInput.value = '';
  updateShareExpiryUI();
  
  document.getElementById('share-password').value = '';
  document.getElementById('share-max-downloads').value = '';
  document.getElementById('share-only-upload').checked = false;
  shareAddMessageCheck.checked = false;
  shareMessageInput.value = '';
  shareMessageInput.style.display = 'none';
  document.getElementById('share-password-remove-container').style.display = 'none';
  document.getElementById('share-password-remove').checked = false;
  deleteShareBtn.style.display = 'none';
  shareResultSection.style.display = 'none';
  document.getElementById('share-existing-id').value = '';

  // Only Upload Container handle (only makes sense for folders)
  const onlyUploadContainer = document.getElementById('share-only-upload-container');
  const ext = file.name.split('.').pop().toLowerCase();
  const isCode = ['txt', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'html', 'xml', 'css', 'scss', 'less', 'py', 'json', 'yaml', 'yml', 'c', 'cpp', 'h', 'hpp', 'cs', 'go', 'rs', 'java', 'sh', 'bash', 'md', 'php', 'rb', 'sql'].includes(ext);
  const isOffice = ['docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp'].includes(ext);

  // The "can_write" flag means "upload" for folders but "edit & save" for an editable file.
  const writeLabel = document.getElementById('share-can-write-label');
  if (file.is_folder) {
    if (writeLabel) writeLabel.textContent = 'Dateien hochladen';
  } else {
    if (writeLabel) writeLabel.textContent = 'Bearbeiten & Speichern';
  }

  if (!file.is_folder && !isCode && !isOffice) {
    shareCanWriteCheck.checked = false;
    shareCanWriteCheck.disabled = true;
    if (onlyUploadContainer) onlyUploadContainer.style.display = 'none';
  } else {
    shareCanWriteCheck.disabled = false;
    if (onlyUploadContainer) onlyUploadContainer.style.display = file.is_folder ? 'flex' : 'none';
  }

  // Collab Container: relevant for folders (may contain Office/code files), a directly-shared
  // Office file, or a directly-shared code/text file — the code editor supports live
  // collaboration too, not just Office documents.
  const collabContainer = document.getElementById('share-can-collab-container');
  const collabApplies = file.is_folder || isOffice || isCode;
  if (collabContainer) collabContainer.style.display = collabApplies ? 'flex' : 'none';
  shareModalApplicability = { canWrite: !(!file.is_folder && !isCode && !isOffice), onlyUpload: file.is_folder, canCollab: collabApplies };

  // Check if already shared
  try {
    const res = await fetch('/api/shares');
    const shares = await res.json();
    const existing = shares.find(s => s.file_id === file.id);

    if (existing) {
      document.getElementById('share-existing-id').value = existing.id;
      shareSlugInput.value = existing.slug;
      shareCanReadCheck.checked = existing.can_read !== false;
      shareCanWriteCheck.checked = existing.can_write;
      shareCanDownloadCheck.checked = existing.can_download;
      shareCanZipCheck.checked = existing.can_zip;
      shareCanCollabCheck.checked = existing.can_collab;
      if (existing.message) {
        shareAddMessageCheck.checked = true;
        shareMessageInput.value = existing.message;
        shareMessageInput.style.display = 'block';
      }

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
          shareExpiryType._syncCustomLabel?.();
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

  updateSharePermissionsUI();
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
    canRead: shareCanReadCheck.checked,
    canWrite: shareCanWriteCheck.checked,
    canDownload: shareCanDownloadCheck.checked,
    canZip: shareCanZipCheck.checked,
    expiresAt: expiresAt,
    password: document.getElementById('share-password').value || null,
    maxDownloads: document.getElementById('share-max-downloads').value ? parseInt(document.getElementById('share-max-downloads').value) : null,
    onlyUpload: document.getElementById('share-only-upload').checked,
    removePassword: document.getElementById('share-password-remove').checked,
    canCollab: shareCanCollabCheck.checked,
    message: shareAddMessageCheck.checked ? shareMessageInput.value.trim() : null
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
    if (targetSection === 'api-settings') {
      loadApiKeys();
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

/* ─── API-Keys (persönliche Zugangsschlüssel für externe Apps) ─── */
async function loadApiKeys() {
  const container = document.getElementById('api-key-list');
  if (!container) return;

  try {
    const res = await fetch('/api/settings/api-keys');
    const keys = await res.json();

    container.innerHTML = '';
    if (!Array.isArray(keys) || keys.length === 0) {
      container.innerHTML = `<tr><td colspan="5" style="text-align: center; color: var(--color-text-muted);">Noch keine API-Keys erstellt.</td></tr>`;
      return;
    }

    keys.forEach(key => {
      const row = document.createElement('tr');
      const createdText = new Date(key.created_at).toLocaleDateString('de-DE');
      const lastUsedText = key.last_used_at ? new Date(key.last_used_at).toLocaleDateString('de-DE') : 'Nie';

      row.innerHTML = `
        <td style="font-weight: 500;">${key.name}</td>
        <td><code style="font-size: 0.8rem; color: var(--color-text-muted);">${key.key_prefix}…</code></td>
        <td>${createdText}</td>
        <td>${lastUsedText}</td>
        <td>
          <button class="btn-icon btn-action-revoke-key" title="Widerrufen" style="padding: 5px; background: transparent; border: none; color: #ff5555;">
            <i data-lucide="trash-2" style="width: 15px; height: 15px;"></i>
          </button>
        </td>
      `;

      row.querySelector('.btn-action-revoke-key').onclick = async () => {
        if (!await showConfirmDialog('API-Key widerrufen', `Den API-Key "${key.name}" wirklich widerrufen? Apps, die ihn nutzen, verlieren sofort den Zugriff.`)) return;
        try {
          const r = await fetch(`/api/settings/api-keys/${key.id}`, { method: 'DELETE' });
          if (r.ok) {
            showToast('API-Key widerrufen.');
            loadApiKeys();
          } else {
            showToast('Fehler beim Widerrufen des API-Keys.');
          }
        } catch {
          showToast('Verbindungsfehler beim Widerrufen des API-Keys.');
        }
      };

      container.appendChild(row);
    });
    lucide.createIcons();
  } catch (err) {
    console.error('Error loading API keys:', err);
    container.innerHTML = `<tr><td colspan="5" style="text-align: center; color: var(--color-text-muted);">Fehler beim Laden der API-Keys.</td></tr>`;
  }
}

document.getElementById('create-api-key-btn').onclick = async () => {
  const name = await showInputPrompt('Neuer API-Key', 'Gib einen Namen für diesen API-Key ein (z. B. "Mobile App"):', '', 'z. B. Mobile App');
  if (!name || !name.trim()) return;

  try {
    const res = await fetch('/api/settings/api-keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name.trim() })
    });
    if (!res.ok) {
      showToast('Fehler beim Erstellen des API-Keys.');
      return;
    }
    const created = await res.json();
    document.getElementById('api-key-created-value').value = created.key;
    document.getElementById('api-key-created-modal-overlay').classList.add('active');
    lucide.createIcons();
    loadApiKeys();
  } catch {
    showToast('Verbindungsfehler beim Erstellen des API-Keys.');
  }
};

document.getElementById('copy-api-key-created-btn').onclick = async () => {
  const input = document.getElementById('api-key-created-value');
  try {
    await navigator.clipboard.writeText(input.value);
    showToast('API-Key in die Zwischenablage kopiert!');
  } catch {
    input.select();
    document.execCommand('copy');
    showToast('API-Key in die Zwischenablage kopiert!');
  }
};

const closeApiKeyCreatedModal = () => {
  document.getElementById('api-key-created-modal-overlay').classList.remove('active');
  document.getElementById('api-key-created-value').value = '';
};
document.getElementById('close-api-key-created-modal-btn').onclick = closeApiKeyCreatedModal;
document.getElementById('done-api-key-created-btn').onclick = closeApiKeyCreatedModal;

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
    const res = await fetch('/api/settings/password', {
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

      // Background previews (dark + light variants for dashboard & login)
      const setBgPreview = (previewId, removeId, hasImage, url) => {
        const preview = document.getElementById(previewId);
        const remove = document.getElementById(removeId);
        if (!preview || !remove) return;
        if (hasImage) {
          preview.style.backgroundImage = `url('${url}&t=${Date.now()}')`;
          preview.textContent = '';
          remove.style.display = 'inline-flex';
        } else {
          preview.style.backgroundImage = '';
          preview.textContent = 'Kein Bild';
          remove.style.display = 'none';
        }
      };
      setBgPreview('admin-db-bg-preview', 'admin-db-bg-remove', !!conf.dashboard_bg_image, '/api/public/branding/dashboard-bg?');
      setBgPreview('admin-db-bg-light-preview', 'admin-db-bg-light-remove', !!conf.dashboard_bg_image_light, '/api/public/branding/dashboard-bg?variant=light');
      setBgPreview('admin-login-bg-preview', 'admin-login-bg-remove', !!conf.login_bg_image, '/api/public/branding/login-bg?');
      setBgPreview('admin-login-bg-light-preview', 'admin-login-bg-light-remove', !!conf.login_bg_image_light, '/api/public/branding/login-bg?variant=light');

      // Footer
      document.getElementById('admin-footer-enabled').checked = conf.footer_enabled === 'true';
      let footerLinks = [];
      try { footerLinks = JSON.parse(conf.footer_links || '[]'); } catch { footerLinks = []; }
      renderAdminFooterLinks(footerLinks);

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
function renderAdminFooterLinks(links) {
  const container = document.getElementById('admin-footer-links-list');
  container.innerHTML = links.map((link, i) => `
    <div class="admin-footer-link-row" style="display: flex; gap: 0.5rem; align-items: center;">
      <input type="text" class="form-control admin-footer-link-label" data-idx="${i}" placeholder="z. B. Datenschutz" value="${escapeHtml(link.label || '')}" style="flex: 1; padding: 0.5rem;">
      <input type="url" class="form-control admin-footer-link-url" data-idx="${i}" placeholder="https://..." value="${escapeHtml(link.url || '')}" style="flex: 2; padding: 0.5rem;">
      <button type="button" class="btn-icon admin-footer-link-remove" data-idx="${i}" title="Entfernen" style="background: transparent; border: none; color: #ff5555; flex-shrink: 0;">
        <i data-lucide="x"></i>
      </button>
    </div>
  `).join('');
  lucide.createIcons();
  container.querySelectorAll('.admin-footer-link-remove').forEach(btn => {
    btn.onclick = () => {
      const links = readAdminFooterLinks();
      links.splice(parseInt(btn.dataset.idx), 1);
      renderAdminFooterLinks(links);
    };
  });
}

function readAdminFooterLinks() {
  const rows = document.querySelectorAll('#admin-footer-links-list .admin-footer-link-row');
  return Array.from(rows).map(row => ({
    label: row.querySelector('.admin-footer-link-label').value.trim(),
    url: row.querySelector('.admin-footer-link-url').value.trim()
  })).filter(link => link.label && link.url);
}

document.getElementById('admin-footer-add-link-btn').onclick = () => {
  const links = readAdminFooterLinks();
  links.push({ label: '', url: '' });
  renderAdminFooterLinks(links);
};

document.getElementById('admin-branding-form').onsubmit = async (e) => {
  e.preventDefault();
  const payload = {
    cloud_name: document.getElementById('admin-cloud-name').value.trim(),
    cloud_tab_name: document.getElementById('admin-cloud-tab-name').value.trim(),
    custom_color_bg: document.getElementById('admin-color-bg').value,
    custom_color_accent: document.getElementById('admin-color-accent').value,
    footer_enabled: document.getElementById('admin-footer-enabled').checked ? 'true' : 'false',
    footer_links: JSON.stringify(readAdminFooterLinks())
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

// Generic background upload/remove wiring (dark + light variants for dashboard & login)
function wireBgControls(uploadId, removeId, endpoint, variant, label) {
  const query = variant === 'light' ? '?variant=light' : '';
  const uploadEl = document.getElementById(uploadId);
  if (uploadEl) {
    uploadEl.onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const formData = new FormData();
      formData.append('image', file);
      showToast(`Lade ${label} hoch...`);
      try {
        const res = await fetch(`${endpoint}${query}`, { method: 'POST', body: formData });
        if (res.ok) {
          showToast(`${label} erfolgreich hochgeladen.`);
          await loadBranding();
          await loadAdminSettings();
        } else {
          const err = await res.json();
          showToast(err.error || 'Fehler beim Hochladen.');
        }
      } catch (err) {
        showToast('Netzwerkfehler beim Upload.');
      }
      e.target.value = '';
    };
  }

  const removeEl = document.getElementById(removeId);
  if (removeEl) {
    removeEl.onclick = async () => {
      showToast(`Entferne ${label}...`);
      try {
        const res = await fetch(`${endpoint}${query}`, { method: 'DELETE' });
        if (res.ok) {
          showToast(`${label} erfolgreich entfernt.`);
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
}

wireBgControls('admin-db-bg-upload', 'admin-db-bg-remove', '/api/settings/admin/dashboard-bg', 'dark', 'Dashboard-Hintergrund (dunkel)');
wireBgControls('admin-db-bg-light-upload', 'admin-db-bg-light-remove', '/api/settings/admin/dashboard-bg', 'light', 'Dashboard-Hintergrund (hell)');
wireBgControls('admin-login-bg-upload', 'admin-login-bg-remove', '/api/settings/admin/login-bg', 'dark', 'Login-Hintergrund (dunkel)');
wireBgControls('admin-login-bg-light-upload', 'admin-login-bg-light-remove', '/api/settings/admin/login-bg', 'light', 'Login-Hintergrund (hell)');

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
// Load & render the role-management UI, and keep the role cache fresh for selects
// Which roles the admin has manually expanded, by id — collapsed by default so opening the
// panel doesn't dump every permission checkbox for every group on screen at once.
const expandedRoleIds = new Set();
const ADMIN_ROLES_VISIBLE_COUNT = 5;

function renderRoleRow(role) {
  const perms = role.permissions || {};
  const quotaGb = role.storage_quota ? (role.storage_quota / (1024 ** 3)).toFixed(1) : '';
  const usedStr = formatBytes(role.storage_used);
  const quotaStr = role.storage_quota ? formatBytes(role.storage_quota) : 'unbegrenzt';
  const isExpanded = expandedRoleIds.has(role.id);

  const row = document.createElement('div');
  row.className = 'admin-role-row' + (isExpanded ? '' : ' collapsed');
  row.innerHTML = `
    <div class="admin-role-row-head">
      <i data-lucide="chevron-down" class="admin-role-collapse-icon" style="width:16px;height:16px;"></i>
      <span class="admin-role-name">${escapeHtml(role.name)}</span>
      ${role.is_default ? '<span class="role-badge default">Standard</span>' : ''}
      ${role.is_system ? '<span class="role-badge system">System</span>' : ''}
      <span class="role-info">${role.member_count} Mitglied(er) · ${usedStr} / ${quotaStr}</span>
    </div>
    <div class="admin-role-perms">
      ${adminPermissionKeys.map(k => `
        <label>
          <input type="checkbox" data-perm="${k}" ${perms[k] ? 'checked' : ''} ${role.name === 'admin' ? 'disabled' : ''}>
          <span>${escapeHtml(PERM_LABELS[k] || k)}</span>
        </label>`).join('')}
    </div>
    <div class="admin-role-footer">
      <div class="admin-role-quota-field">
        <label>Gruppen-Speicherkontingent (GB, leer = unbegrenzt)</label>
        <input type="number" min="0" step="0.1" class="form-control role-quota-input" value="${quotaGb}" placeholder="unbegrenzt">
      </div>
      <div class="admin-role-weight-field">
        <label>Gewicht</label>
        <input type="number" step="1" class="form-control role-weight-input" value="${role.weight || 0}" title="Höheres Gewicht = weiter oben in der Liste">
      </div>
      <div class="admin-role-actions">
        ${!role.is_default ? '<button class="btn btn-role-default" style="color: var(--color-accent); border-color: rgba(var(--color-accent-rgb),0.3);">Als Standard</button>' : ''}
        <button class="btn btn-primary btn-role-save">Speichern</button>
        ${!role.is_system ? '<button class="btn btn-role-delete" style="color:#ff5555; border-color: rgba(255,0,0,0.25);">Löschen</button>' : ''}
      </div>
    </div>
  `;

  row.querySelector('.admin-role-row-head').onclick = () => {
    row.classList.toggle('collapsed');
    if (row.classList.contains('collapsed')) expandedRoleIds.delete(role.id);
    else expandedRoleIds.add(role.id);
  };

  row.querySelector('.btn-role-save').onclick = async (e) => {
    e.stopPropagation();
    const permissions = {};
    row.querySelectorAll('input[data-perm]').forEach(cb => { permissions[cb.getAttribute('data-perm')] = cb.checked; });
    const qv = row.querySelector('.role-quota-input').value;
    const storageQuota = (qv && parseFloat(qv) > 0) ? Math.round(parseFloat(qv) * (1024 ** 3)) : null;
    const weight = parseInt(row.querySelector('.role-weight-input').value) || 0;
    try {
      const r = await fetch(`/api/settings/admin/roles/${role.id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ permissions, storageQuota, weight }),
      });
      const d = await r.json();
      if (r.ok) { showToast('Rolle gespeichert.'); expandedRoleIds.add(role.id); loadAdminRoles(); }
      else showToast(d.error || 'Fehler beim Speichern.');
    } catch { showToast('Verbindungsfehler.'); }
  };

  const defBtn = row.querySelector('.btn-role-default');
  if (defBtn) defBtn.onclick = async (e) => {
    e.stopPropagation();
    try {
      const r = await fetch(`/api/settings/admin/roles/${role.id}/default`, { method: 'POST' });
      const d = await r.json();
      if (r.ok) { showToast(d.message || 'Standardrolle gesetzt.'); loadAdminRoles(); }
      else showToast(d.error || 'Fehler.');
    } catch { showToast('Verbindungsfehler.'); }
  };

  const delBtn = row.querySelector('.btn-role-delete');
  if (delBtn) delBtn.onclick = async (e) => {
    e.stopPropagation();
    if (!await showConfirmDialog('Rolle löschen', `Rolle "${role.name}" wirklich löschen? Mitglieder werden auf die Standardrolle verschoben.`)) return;
    try {
      const r = await fetch(`/api/settings/admin/roles/${role.id}`, { method: 'DELETE' });
      const d = await r.json();
      if (r.ok) { showToast(d.message || 'Rolle gelöscht.'); loadAdminRoles(); loadAdminUsers(); }
      else showToast(d.error || 'Fehler beim Löschen.');
    } catch { showToast('Verbindungsfehler.'); }
  };

  return row;
}

function openAllRolesModal() {
  const overlay = document.getElementById('all-roles-modal-overlay');
  const list = document.getElementById('all-roles-list');
  if (!overlay || !list) return;
  list.innerHTML = '';
  adminRolesCache.forEach(role => list.appendChild(renderRoleRow(role)));
  overlay.classList.add('active');
  lucide.createIcons();
}

document.getElementById('admin-roles-show-all-btn')?.addEventListener('click', openAllRolesModal);
document.getElementById('close-all-roles-modal-btn')?.addEventListener('click', () => {
  document.getElementById('all-roles-modal-overlay').classList.remove('active');
});

async function loadAdminRoles() {
  try {
    const res = await fetch('/api/settings/admin/roles');
    if (!res.ok) return;
    const data = await res.json();
    // Already ordered by weight DESC from the server; keep that order everywhere it's used.
    adminRolesCache = data.roles || [];
    adminPermissionKeys = data.permissionKeys || Object.keys(PERM_LABELS);

    // Populate the "create user" role select
    const newRoleSelect = document.getElementById('admin-new-role');
    if (newRoleSelect) {
      const prev = newRoleSelect.value;
      newRoleSelect.innerHTML = adminRolesCache
        .map(r => `<option value="${r.name}">${r.name}</option>`).join('');
      if (adminRolesCache.some(r => r.name === prev)) newRoleSelect.value = prev;
      else { const def = adminRolesCache.find(r => r.is_default); if (def) newRoleSelect.value = def.name; }
      if (!newRoleSelect._styledAsDropdown) {
        styleSelectAsDropdown(newRoleSelect);
        newRoleSelect._styledAsDropdown = true;
      }
      newRoleSelect._syncCustomLabel?.();
    }

    const list = document.getElementById('admin-roles-list');
    if (!list) return;
    list.innerHTML = '';

    const visibleRoles = adminRolesCache.slice(0, ADMIN_ROLES_VISIBLE_COUNT);
    visibleRoles.forEach(role => list.appendChild(renderRoleRow(role)));

    const showAllContainer = document.getElementById('admin-roles-show-all-container');
    if (showAllContainer) {
      showAllContainer.style.display = adminRolesCache.length > ADMIN_ROLES_VISIBLE_COUNT ? 'block' : 'none';
    }

    lucide.createIcons();
  } catch (err) {
    console.error('Error loading admin roles:', err);
  }
}

const ADMIN_USERS_VISIBLE_COUNT = 5;

function renderUserRow(user) {
  const row = document.createElement('div');
  row.className = 'admin-user-row';

  const roleOptions = adminRolesCache
    .map(r => `<option value="${escapeHtml(r.name)}" ${r.name === user.role ? 'selected' : ''}>${escapeHtml(r.name)}</option>`).join('');

  const ssoText = user.sso_provider ? `Authentik (${escapeHtml(user.sso_provider)})` : 'Nein';
  const realName = (user.first_name || user.last_name) ? escapeHtml(`${user.first_name || ''} ${user.last_name || ''}`.trim()) : '';
  const emailText = escapeHtml(user.email) || 'Keine E-Mail';
  const lastLoginText = user.last_login_at ? new Date(user.last_login_at).toLocaleString('de-DE') : 'Nie';

  const statusBadge = user.is_active ? '' : ' <span class="badge" style="background: rgba(255, 85, 85, 0.2); color: #ff5555; font-size: 0.72rem; padding: 2px 6px; border-radius: 4px; font-weight: 500;">Gesperrt</span>';
  const failedLoginBadge = user.last_failed_login_at
    ? ` <span class="admin-user-warning-badge"><i data-lucide="alert-triangle"></i> Login fehlgeschlagen</span>`
    : '';
  const lockIcon = user.is_active ? 'lock' : 'unlock';
  const lockTitle = user.is_active ? 'Sperren' : 'Entsperren';

  row.innerHTML = `
    <div class="admin-user-main">
      <div class="admin-user-name">${escapeHtml(user.username)}${statusBadge}${failedLoginBadge}</div>
      ${realName ? `<div class="admin-user-sub">${realName} · ${emailText}</div>` : `<div class="admin-user-sub">${emailText}</div>`}
      <div class="admin-user-sub">Zuletzt online: ${lastLoginText}</div>
    </div>
    <div class="admin-user-meta">
      <div>
        <span class="meta-label">Rolle</span>
        <select class="admin-role-select select-role">${roleOptions}</select>
      </div>
      <div>
        <span class="meta-label">SSO</span>
        <span class="meta-value">${ssoText}</span>
      </div>
      <div>
        <span class="meta-label">Dateien</span>
        <span class="meta-value">${user.file_count}</span>
      </div>
      <div>
        <span class="meta-label">Speicher</span>
        <span class="meta-value" style="display:inline-flex; align-items:center; gap:0.35rem;">
          ${formatBytes(user.storage_used)} / ${user.storage_quota ? formatBytes(user.storage_quota) : 'unbegrenzt'}
          <button class="btn-icon btn-action-edit-quota" style="width:20px;height:20px;padding:0;display:flex;align-items:center;justify-content:center;background:transparent;border:none;color: var(--color-accent);" title="Speicherlimit ändern">
            <i data-lucide="edit-3"></i>
          </button>
        </span>
      </div>
    </div>
    <div class="admin-user-actions">
      <button class="btn-icon btn-action-lock-user" style="color: ${user.is_active ? '#ffaa00' : '#00d2ff'};" title="${lockTitle}"><i data-lucide="${lockIcon}"></i></button>
      <button class="btn-icon btn-action-reset-user" style="color: #00d2ff;" title="Passwort per Mail zurücksetzen" ${isEmailConfigured ? '' : 'disabled'}><i data-lucide="key-round"></i></button>
      <button class="btn-icon btn-action-delete-user" style="color: #ff5555;" title="Benutzer löschen"><i data-lucide="trash-2"></i></button>
    </div>
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
    row.querySelector('.btn-action-lock-user').disabled = true;
    row.querySelector('.btn-action-reset-user').disabled = true;
    row.querySelector('.select-role').disabled = true;
  }

  return row;
}

function openAllUsersModal() {
  const overlay = document.getElementById('all-users-modal-overlay');
  const list = document.getElementById('all-users-list');
  if (!overlay || !list) return;
  list.innerHTML = '';
  adminUsersCache.forEach(user => list.appendChild(renderUserRow(user)));
  overlay.classList.add('active');
  lucide.createIcons();
}

document.getElementById('admin-users-show-all-btn')?.addEventListener('click', openAllUsersModal);
document.getElementById('close-all-users-modal-btn')?.addEventListener('click', () => {
  document.getElementById('all-users-modal-overlay').classList.remove('active');
});

let adminUsersCache = [];

async function loadAdminUsers() {
  try {
    await loadAdminRoles();

    const res = await fetch('/api/settings/admin/users');
    // Already ordered by the server: users with an unresolved failed login attempt first,
    // then alphabetically by username.
    adminUsersCache = await res.json();

    const container = document.getElementById('admin-user-list');
    container.innerHTML = '';

    const visibleUsers = adminUsersCache.slice(0, ADMIN_USERS_VISIBLE_COUNT);
    visibleUsers.forEach(user => container.appendChild(renderUserRow(user)));

    const showAllContainer = document.getElementById('admin-users-show-all-container');
    if (showAllContainer) {
      showAllContainer.style.display = adminUsersCache.length > ADMIN_USERS_VISIBLE_COUNT ? 'block' : 'none';
    }

    lucide.createIcons();
  } catch (err) {
    console.error('Error loading admin users:', err);
  }
}

// Aktuell in der Einstellungs-Übersicht ausgewählte Freigabe-Links
let selectedShareIds = new Set();

// User Geteilte Links auflisten
async function loadUserShares() {
  try {
    const res = await fetch('/api/shares');
    allShares = await res.json();

    // Auswahl auf weiterhin existierende Links beschränken
    const existingIds = new Set(allShares.map(s => s.id));
    selectedShareIds.forEach(id => { if (!existingIds.has(id)) selectedShareIds.delete(id); });

    const container = document.getElementById('user-shares-list');
    container.innerHTML = '';

    if (allShares.length === 0) {
      container.innerHTML = `<tr><td colspan="7" style="text-align: center; color: var(--color-text-muted);">Du hast noch keine Links geteilt.</td></tr>`;
      updateSharesBulkBar();
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
        <td style="text-align: center;"><input type="checkbox" class="checkbox-modern share-row-check" data-id="${share.id}"></td>
        <td style="font-weight: 500;">${share.file_name}</td>
        <td>${typeText}</td>
        <td><a href="/s/${share.slug}" target="_blank" style="color: var(--color-accent); text-decoration: none;">/s/${share.slug}</a></td>
        <td><span style="font-size: 0.8rem; color: var(--color-text-muted);">${permissions.join(', ')}</span></td>
        <td>${expiresText}</td>
        <td style="white-space: nowrap;">
          <button class="btn-icon btn-action-copy-share" title="Link kopieren" style="padding: 5px; background: transparent; border: none; color: var(--color-text-muted);">
            <i data-lucide="link" style="width: 15px; height: 15px;"></i>
          </button>
          <button class="btn-icon btn-action-edit-share" title="Bearbeiten" style="padding: 5px; background: transparent; border: none; color: var(--color-text-muted);">
            <i data-lucide="pencil" style="width: 15px; height: 15px;"></i>
          </button>
          <button class="btn-icon btn-action-delete-share" title="Löschen" style="padding: 5px; background: transparent; border: none; color: #ff5555;">
            <i data-lucide="trash-2" style="width: 15px; height: 15px;"></i>
          </button>
        </td>
      `;

      const checkbox = row.querySelector('.share-row-check');
      checkbox.checked = selectedShareIds.has(share.id);
      checkbox.onchange = () => {
        if (checkbox.checked) selectedShareIds.add(share.id);
        else selectedShareIds.delete(share.id);
        renderSharesSelectionState();
      };

      row.querySelector('.btn-action-copy-share').onclick = () => {
        navigator.clipboard.writeText(`${window.location.origin}/s/${share.slug}`);
        showToast('Link kopiert.');
      };

      row.querySelector('.btn-action-edit-share').onclick = () => openShareEditModal([share.id]);

      row.querySelector('.btn-action-delete-share').onclick = async () => {
        if (!await showConfirmDialog('Freigabe löschen', 'Diesen Freigabelink wirklich löschen?')) return;
        try {
          const r = await fetch(`/api/shares/${share.id}`, { method: 'DELETE' });
          if (r.ok) {
            showToast('Freigabe gelöscht.');
            selectedShareIds.delete(share.id);
            loadUserShares();
          }
        } catch (err) {
          showToast('Fehler beim Löschen.');
        }
      };

      container.appendChild(row);
    });

    renderSharesSelectionState();
    lucide.createIcons();
  } catch (err) {
    console.error('Error loading shares:', err);
  }
}

// Auswahl-Status (Zeilen-Highlights, Checkboxen, Aktionsleiste) ohne erneutes Laden synchronisieren
function renderSharesSelectionState() {
  document.querySelectorAll('.share-row-check').forEach(cb => {
    const id = parseInt(cb.dataset.id);
    cb.checked = selectedShareIds.has(id);
    const tr = cb.closest('tr');
    if (tr) tr.style.background = cb.checked ? 'rgba(var(--color-accent-rgb), 0.08)' : '';
  });
  updateSharesBulkBar();
}

function updateSharesBulkBar() {
  const bar = document.getElementById('shares-bulk-bar');
  if (!bar) return;
  const count = selectedShareIds.size;
  document.getElementById('shares-bulk-count').textContent = `${count} ausgewählt`;
  bar.style.display = count > 0 ? 'flex' : 'none';

  const selectAll = document.getElementById('shares-select-all');
  if (selectAll) {
    const total = allShares.length;
    selectAll.checked = total > 0 && count === total;
    selectAll.indeterminate = count > 0 && count < total;
  }
}

// "Alle auswählen"-Checkbox im Tabellenkopf
const sharesSelectAll = document.getElementById('shares-select-all');
if (sharesSelectAll) {
  sharesSelectAll.onchange = () => {
    if (sharesSelectAll.checked) allShares.forEach(s => selectedShareIds.add(s.id));
    else selectedShareIds.clear();
    renderSharesSelectionState();
  };
}

// Bulk-Aktionsleiste: Löschen
document.getElementById('shares-bulk-delete-btn').onclick = async () => {
  const ids = [...selectedShareIds];
  if (ids.length === 0) return;
  if (!await showConfirmDialog('Freigaben löschen', `${ids.length} Freigabe-Link(s) wirklich löschen?`)) return;
  try {
    const r = await fetch('/api/shares/bulk-delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    });
    if (r.ok) {
      showToast('Freigaben gelöscht.');
      selectedShareIds.clear();
      loadUserShares();
    } else {
      showToast('Fehler beim Löschen.');
    }
  } catch (err) {
    showToast('Fehler beim Löschen.');
  }
};

// Bulk-Aktionsleiste: Bearbeiten
document.getElementById('shares-bulk-edit-btn').onclick = () => {
  const ids = [...selectedShareIds];
  if (ids.length === 0) return;
  openShareEditModal(ids);
};

/* ==========================================================================
   SHARE EDIT MODAL (Einzel- & Mehrfachbearbeitung aus den Einstellungen)
   ========================================================================== */
const shareEditOverlay = document.getElementById('share-edit-modal-overlay');
const shareEditExpiryType = document.getElementById('share-edit-expiry-type');
let shareEditIds = [];

function updateShareEditExpiryUI() {
  const type = shareEditExpiryType.value;
  document.getElementById('share-edit-expiry-hours-container').style.display = type === 'hours' ? 'block' : 'none';
  document.getElementById('share-edit-expiry-days-container').style.display = type === 'days' ? 'block' : 'none';
  document.getElementById('share-edit-expiry-custom-container').style.display = type === 'custom' ? 'block' : 'none';
}
shareEditExpiryType.onchange = updateShareEditExpiryUI;

// Einen Feldbereich (im Bulk-Modus) aktivieren/deaktivieren
function setShareEditFieldsetEnabled(containerId, enabled) {
  const c = document.getElementById(containerId);
  if (!c) return;
  c.style.opacity = enabled ? '1' : '0.4';
  c.style.pointerEvents = enabled ? 'auto' : 'none';
  c.querySelectorAll('input, select').forEach(el => {
    if (el.id === 'share-edit-can-read') return; // bleibt immer deaktiviert
    el.disabled = !enabled;
  });
}

// Ablaufzeitpunkt aus den Modal-Feldern in einen ISO-String (oder null) übersetzen
function collectShareEditExpiry() {
  const type = shareEditExpiryType.value;
  if (type === 'hours' && document.getElementById('share-edit-expiry-hours').value) {
    const d = new Date();
    d.setHours(d.getHours() + parseInt(document.getElementById('share-edit-expiry-hours').value));
    return d.toISOString();
  } else if (type === 'days' && document.getElementById('share-edit-expiry-days').value) {
    const d = new Date();
    d.setDate(d.getDate() + parseInt(document.getElementById('share-edit-expiry-days').value));
    return d.toISOString();
  } else if (type === 'custom' && document.getElementById('share-edit-expiry-custom').value) {
    return new Date(document.getElementById('share-edit-expiry-custom').value).toISOString();
  }
  return null; // "Nie" oder unvollständige Eingabe => Ablauf entfernen
}

function openShareEditModal(ids) {
  shareEditIds = ids;
  const isBulk = ids.length > 1;
  const single = isBulk ? null : allShares.find(s => s.id === ids[0]);
  if (!isBulk && !single) return;

  document.getElementById('share-edit-title').textContent = isBulk ? `${ids.length} Links bearbeiten` : 'Link bearbeiten';
  document.getElementById('share-edit-bulk-hint').style.display = isBulk ? 'block' : 'none';
  document.getElementById('share-edit-slug-group').style.display = isBulk ? 'none' : 'block';
  document.querySelectorAll('.share-edit-apply-toggle').forEach(el => { el.style.display = isBulk ? 'flex' : 'none'; });

  const applyExpiry = document.getElementById('share-edit-apply-expiry');
  const applyPassword = document.getElementById('share-edit-apply-password');
  const applyPerms = document.getElementById('share-edit-apply-perms');
  applyExpiry.checked = false;
  applyPassword.checked = false;
  applyPerms.checked = false;

  const syncGroups = () => {
    setShareEditFieldsetEnabled('share-edit-expiry-fields', !isBulk || applyExpiry.checked);
    setShareEditFieldsetEnabled('share-edit-password-fields', !isBulk || applyPassword.checked);
    setShareEditFieldsetEnabled('share-edit-perms-fields', !isBulk || applyPerms.checked);
  };
  applyExpiry.onchange = syncGroups;
  applyPassword.onchange = syncGroups;
  applyPerms.onchange = syncGroups;

  // Slug
  const prefix = appBrandingUrl || window.location.origin;
  document.getElementById('share-edit-url-prefix').textContent = prefix.endsWith('/') ? `${prefix}s/` : `${prefix}/s/`;
  document.getElementById('share-edit-slug').value = single ? single.slug : '';

  // Ablauf & Limit
  shareEditExpiryType.value = 'none';
  document.getElementById('share-edit-expiry-hours').value = '';
  document.getElementById('share-edit-expiry-days').value = '';
  document.getElementById('share-edit-expiry-custom').value = '';
  document.getElementById('share-edit-max-downloads').value = '';
  if (single) {
    if (single.expires_at) {
      const d = new Date(single.expires_at);
      const pad = n => String(n).padStart(2, '0');
      document.getElementById('share-edit-expiry-custom').value =
        `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
      shareEditExpiryType.value = 'custom';
    }
    if (single.max_downloads) document.getElementById('share-edit-max-downloads').value = single.max_downloads;
  }
  updateShareEditExpiryUI();

  // Passwort
  document.getElementById('share-edit-password').value = '';
  document.getElementById('share-edit-password-remove').checked = false;
  const removeContainer = document.getElementById('share-edit-password-remove-container');
  // Entfernen-Option anzeigen, wenn (einzeln) ein Passwort gesetzt ist, oder generell im Bulk-Modus
  removeContainer.style.display = (isBulk || (single && single.password_hash)) ? 'flex' : 'none';

  // Berechtigungen
  document.getElementById('share-edit-can-download').checked = single ? single.can_download : true;
  document.getElementById('share-edit-can-write').checked = single ? single.can_write : false;
  document.getElementById('share-edit-can-zip').checked = single ? single.can_zip : true;
  document.getElementById('share-edit-only-upload').checked = single ? single.only_upload : false;

  syncGroups();
  shareEditOverlay.classList.add('active');
  lucide.createIcons();
}

document.getElementById('close-share-edit-modal-btn').onclick = () => shareEditOverlay.classList.remove('active');
document.getElementById('cancel-share-edit-btn').onclick = () => shareEditOverlay.classList.remove('active');

document.getElementById('share-edit-form').onsubmit = async (e) => {
  e.preventDefault();
  const isBulk = shareEditIds.length > 1;
  const maxDlVal = document.getElementById('share-edit-max-downloads').value;
  const removePassword = document.getElementById('share-edit-password-remove').checked;
  const passwordVal = document.getElementById('share-edit-password').value;

  if (isBulk) {
    const applyExpiry = document.getElementById('share-edit-apply-expiry').checked;
    const applyPassword = document.getElementById('share-edit-apply-password').checked;
    const applyPerms = document.getElementById('share-edit-apply-perms').checked;

    if (!applyExpiry && !applyPassword && !applyPerms) {
      showToast('Bitte mindestens einen Bereich zum Ändern aktivieren.');
      return;
    }

    const updates = {};
    if (applyExpiry) {
      updates.expiresAt = collectShareEditExpiry();
      updates.maxDownloads = maxDlVal ? parseInt(maxDlVal) : null;
    }
    if (applyPassword) {
      if (removePassword) {
        updates.removePassword = true;
      } else if (passwordVal) {
        updates.password = passwordVal;
      } else {
        showToast('Passwort eingeben oder "Passwortschutz entfernen" wählen.');
        return;
      }
    }
    if (applyPerms) {
      updates.canRead = true;
      updates.canDownload = document.getElementById('share-edit-can-download').checked;
      updates.canWrite = document.getElementById('share-edit-can-write').checked;
      updates.canZip = document.getElementById('share-edit-can-zip').checked;
      updates.onlyUpload = document.getElementById('share-edit-only-upload').checked;
    }

    try {
      const res = await fetch('/api/shares/bulk-update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: shareEditIds, updates }),
      });
      if (res.ok) {
        showToast('Links aktualisiert.');
        shareEditOverlay.classList.remove('active');
        selectedShareIds.clear();
        loadUserShares();
        loadNotesPage();
      } else {
        const err = await res.json();
        showToast(err.error || 'Fehler beim Speichern.');
      }
    } catch (err) {
      showToast('Fehler beim Speichern.');
    }
  } else {
    const payload = {
      customSlug: document.getElementById('share-edit-slug').value.trim(),
      canRead: true,
      canWrite: document.getElementById('share-edit-can-write').checked,
      canDownload: document.getElementById('share-edit-can-download').checked,
      canZip: document.getElementById('share-edit-can-zip').checked,
      onlyUpload: document.getElementById('share-edit-only-upload').checked,
      expiresAt: collectShareEditExpiry(),
      maxDownloads: maxDlVal ? parseInt(maxDlVal) : null,
    };
    if (removePassword) payload.removePassword = true;
    else if (passwordVal) payload.password = passwordVal;

    try {
      const res = await fetch(`/api/shares/${shareEditIds[0]}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        showToast('Link aktualisiert.');
        shareEditOverlay.classList.remove('active');
        loadUserShares();
        loadNotesPage();
      } else {
        const err = await res.json();
        showToast(err.error || 'Fehler beim Speichern.');
      }
    } catch (err) {
      showToast('Fehler beim Speichern.');
    }
  }
};

let brandingCache = null;
let currentViewName = 'auth';

// Determine the theme that is currently active (explicit override or system preference)
function getActiveTheme() {
  const explicit = document.documentElement.getAttribute('data-theme');
  if (explicit === 'light' || explicit === 'dark') return explicit;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyBackgrounds(viewName) {
  if (!brandingCache) return;

  const isDark = getActiveTheme() === 'dark';

  // Clean default body background style properties
  document.body.style.backgroundImage = '';
  document.body.style.backgroundSize = 'cover';
  document.body.style.backgroundPosition = 'center';
  document.body.style.backgroundAttachment = 'fixed';
  document.body.style.backgroundRepeat = 'no-repeat';

  // Custom background colour only overrides the dark theme; light mode keeps its CSS gradient
  if (isDark && brandingCache.customColorBg) {
    document.documentElement.style.setProperty('--color-bg', brandingCache.customColorBg);
  } else {
    document.documentElement.style.removeProperty('--color-bg');
  }

  const orbs = document.getElementById('glowing-orbs-container');

  // Pick the background image for the current view + theme (with fallback to the other variant)
  let hasBg, hasBgLight, baseUrl;
  if (viewName === 'auth') {
    hasBg = brandingCache.hasLoginBg;
    hasBgLight = brandingCache.hasLoginBgLight;
    baseUrl = '/api/public/branding/login-bg';
  } else {
    hasBg = brandingCache.hasDashboardBg;
    hasBgLight = brandingCache.hasDashboardBgLight;
    baseUrl = '/api/public/branding/dashboard-bg';
  }

  let chosen = null;
  if (!isDark) {
    if (hasBgLight) chosen = `${baseUrl}?variant=light&t=${Date.now()}`;
    else if (hasBg) chosen = `${baseUrl}?t=${Date.now()}`;
  } else {
    if (hasBg) chosen = `${baseUrl}?t=${Date.now()}`;
    else if (hasBgLight) chosen = `${baseUrl}?variant=light&t=${Date.now()}`;
  }

  if (chosen) {
    document.body.style.backgroundImage = `url('${chosen}')`;
    if (orbs) orbs.style.display = 'none';
  } else {
    if (orbs) orbs.style.display = 'block';
  }
}

// Re-apply theme-dependent backgrounds when the system colour scheme changes
if (window.matchMedia) {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (brandingCache) applyBackgrounds(currentViewName);
  });
}

// Load Branding configurations dynamically
async function loadBranding() {
  try {
    const res = await fetch('/api/public/branding');
    const data = await res.json();
    
    brandingCache = data;
    appBrandingUrl = data.appUrl || '';

    // Custom background color only applies to the dark theme; light mode keeps its
    // designed gradient (handled in applyBackgrounds()).
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

    // Registration is always allowed for the very first account (bootstrapping the initial
    // admin) even while the setting is off — mirror that here so the button doesn't show on a
    // normal, already-set-up instance with registration disabled.
    const canRegister = data.registrationEnabled || data.hasUsers === false;
    const authDivider = document.getElementById('auth-divider');
    if (toggleAuthModeBtn) toggleAuthModeBtn.style.display = canRegister ? '' : 'none';
    if (authDivider) authDivider.style.display = canRegister ? '' : 'none';
    if (!canRegister && isRegisterMode) updateAuthUI(false);

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

    renderAppFooter(data);
  } catch (err) {
    console.error('Error loading branding:', err);
  }
}

function renderAppFooter(data) {
  let footer = document.getElementById('app-footer');
  if (!data.footerEnabled) {
    if (footer) footer.style.display = 'none';
    return;
  }
  if (!footer) {
    footer = document.createElement('footer');
    footer.id = 'app-footer';
    document.body.appendChild(footer);
  }
  const year = new Date().getFullYear();
  const links = (data.footerLinks || []).map(link => `<a href="${escapeHtml(link.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(link.label)}</a>`).join('');
  footer.innerHTML = `
    ${links}
    <span>&copy; ${year} ${escapeHtml(data.name || 'myCloud')}</span>
    <span class="app-footer-version">v${escapeHtml(data.appVersion || '')}</span>
  `;
  footer.style.display = 'flex';
}

// Theme follows system preferences automatically (no manual override)

/* ==========================================================================
   INITIALIZATION
   ========================================================================== */
window.onload = () => {
  // Clear any previously saved manual theme so system preference takes over
  localStorage.removeItem('theme');
  document.documentElement.removeAttribute('data-theme');

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
    gridBtn.onclick = (e) => {
      e.stopPropagation();
      if (viewMode === 'grid') {
        showQuickSettingsMenu('grid', gridBtn);
      } else {
        closeQuickSettingsMenu();
        viewMode = 'grid';
        localStorage.setItem('viewMode', 'grid');
        updateViewModeButtons();
        renderFiles(renderedFilesList);
      }
    };
    listBtn.onclick = (e) => {
      e.stopPropagation();
      if (viewMode === 'list') {
        showQuickSettingsMenu('list', listBtn);
      } else {
        closeQuickSettingsMenu();
        viewMode = 'list';
        localStorage.setItem('viewMode', 'list');
        updateViewModeButtons();
        renderFiles(renderedFilesList);
      }
    };
  }

  // Sortable list column headers
  document.querySelectorAll('#file-list-header .flh-col').forEach(btn => {
    btn.onclick = () => setSortColumn(btn.dataset.sort);
  });

  // Sort dropdown (also works in grid/tile view, where there is no column header)
  const sortToggleBtn = document.getElementById('sort-toggle-btn');
  if (sortToggleBtn) {
    sortToggleBtn.onclick = (e) => {
      e.stopPropagation();
      showSortMenu(sortToggleBtn);
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
    const officeOverlayEl = document.getElementById('office-editor-overlay');
    officeOverlayEl.style.display = 'block';
    officeOverlayEl.classList.add('active');

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
  const officeOverlayEl = document.getElementById('office-editor-overlay');
  officeOverlayEl.style.display = 'none';
  officeOverlayEl.classList.remove('active');
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

// Dashboard-Suche ein-/ausklappen (modulweit, damit Hotkeys & Setup-Block sie nutzen können)
function expandDashboardSearch(focus = true) {
  const c = document.getElementById('search-container');
  const input = document.getElementById('dashboard-search-input');
  if (c) c.classList.add('search-expanded');
  if (focus && input) setTimeout(() => { input.focus(); input.select(); }, 60);
}
function collapseDashboardSearch(force = false) {
  const c = document.getElementById('search-container');
  const input = document.getElementById('dashboard-search-input');
  if (!c) return;
  // Nur einklappen, wenn keine aktive Sucheingabe vorliegt (außer erzwungen)
  if (!force && input && input.value.trim()) return;
  c.classList.remove('search-expanded');
  if (input) input.blur();
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
        const clearBtn = document.getElementById('search-clear-btn');
        if (clearBtn) clearBtn.style.display = 'none';
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

  // Escape (Clear selection)
  if (e.key === 'Escape' && selectedFileIds.length > 0) {
    clearSelection();
    return;
  }

  // Ctrl + F / Ctrl + S (Suchfeld ausklappen & fokussieren)
  if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'f' || e.key.toLowerCase() === 's')) {
    e.preventDefault();
    expandDashboardSearch(true);
    return;
  }

  // Auto-Search on simple character typing (a-z, A-Z, 0-9)
  if (!e.ctrlKey && !e.altKey && !e.metaKey && e.key.length === 1 && /^[a-zA-Z0-9]$/.test(e.key)) {
    const searchInput = document.getElementById('dashboard-search-input');
    if (searchInput) {
      e.preventDefault();
      expandDashboardSearch(false);
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
    // Collect every currently-open overlay and close ONLY the top-most one,
    // so stacked windows close one layer per ESC press (newest first).
    // Every .modal-overlay has display:flex set unconditionally in its base CSS rule —
    // visibility is toggled via the .active class (opacity/pointer-events), not display —
    // so checking computed display/visibility here always reported "open" for every overlay
    // in the DOM, not just the visible one.
    const isOverlayOpen = (el) => {
      if (!el) return false;
      return el.classList.contains('active');
    };
    const zIndexOf = (el) => {
      const z = parseInt(window.getComputedStyle(el).zIndex, 10);
      return Number.isNaN(z) ? 0 : z;
    };

    const candidates = [];
    const pushIf = (el, close) => { if (isOverlayOpen(el)) candidates.push({ el, close }); };

    const officeEditor = document.getElementById('office-editor-overlay');
    pushIf(officeEditor, () => {
      if (docEditorInstance) { docEditorInstance.destroyEditor(); docEditorInstance = null; }
      officeEditor.style.display = 'none';
      officeEditor.classList.remove('active');
      loadFiles(currentFolderId);
    });
    pushIf(document.getElementById('code-editor-overlay'), () => document.getElementById('close-code-editor-btn').click());
    pushIf(document.getElementById('image-viewer-overlay'), () => document.getElementById('close-image-viewer-btn').click());
    pushIf(document.getElementById('video-viewer-overlay'), () => document.getElementById('close-video-viewer-btn').click());
    pushIf(document.getElementById('pdf-viewer-overlay'), () => document.getElementById('close-pdf-viewer-btn').click());

    // Generic glass modals (share, create-file, totp, confirm, input, …)
    const handledIds = new Set(['settings-view', 'admin-view', 'notes-view', 'office-editor-overlay', 'code-editor-overlay', 'image-viewer-overlay', 'video-viewer-overlay', 'pdf-viewer-overlay']);
    document.querySelectorAll('.modal-overlay.active').forEach(o => {
      if (handledIds.has(o.id)) return;
      pushIf(o, () => {
        o.classList.remove('active');
        if (o.id === 'totp-setup-overlay') cancelTotpSetup();
      });
    });

    if (candidates.length > 0) {
      // Highest z-index wins; sort is stable so later-collected layers win ties
      candidates.sort((a, b) => zIndexOf(a.el) - zIndexOf(b.el));
      candidates[candidates.length - 1].close();
      return;
    }

    // No overlay open → close settings/notes/admin (go back to dashboard)
    if (window.location.hash === '#settings' || window.location.hash === '#notes' || window.location.hash === '#admin') {
      closeSettingsOrAdmin();
      return;
    }
  }
});

// Close modals when clicking on the blurred backdrop
document.querySelectorAll('.modal-overlay').forEach(overlay => {
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      if (overlay.id === 'settings-view' || overlay.id === 'admin-view' || overlay.id === 'notes-view') {
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

// Custom language-picker dropdown for the code editor toolbar — replaces a native <select>,
// which kept a visible browser focus ring after being opened/closed (it doesn't lose focus just
// because its own popup closed), giving the impression the control was "stuck".
const MONACO_LANGUAGES = [
  { value: 'plaintext', label: 'Plaintext' },
  { value: 'javascript', label: 'JavaScript' },
  { value: 'typescript', label: 'TypeScript' },
  { value: 'html', label: 'HTML' },
  { value: 'css', label: 'CSS' },
  { value: 'scss', label: 'SCSS' },
  { value: 'less', label: 'Less' },
  { value: 'json', label: 'JSON' },
  { value: 'xml', label: 'XML' },
  { value: 'markdown', label: 'Markdown' },
  { value: 'python', label: 'Python' },
  { value: 'java', label: 'Java' },
  { value: 'c', label: 'C' },
  { value: 'cpp', label: 'C++' },
  { value: 'csharp', label: 'C#' },
  { value: 'go', label: 'Go' },
  { value: 'rust', label: 'Rust' },
  { value: 'php', label: 'PHP' },
  { value: 'ruby', label: 'Ruby' },
  { value: 'shell', label: 'Shell' },
  { value: 'sql', label: 'SQL' },
  { value: 'yaml', label: 'YAML' },
  { value: 'dockerfile', label: 'Dockerfile' },
  { value: 'graphql', label: 'GraphQL' },
];

let currentEditorLanguage = 'plaintext';

function setEditorLanguageLabel(value) {
  const opt = MONACO_LANGUAGES.find(o => o.value === value);
  const labelEl = document.getElementById('monaco-lang-btn-label');
  if (labelEl) labelEl.textContent = opt ? opt.label : value;
}

let languageMenuDocListener = null;

function closeLanguageMenu() {
  document.querySelectorAll('.editor-lang-menu').forEach(m => m.remove());
  if (languageMenuDocListener) {
    document.removeEventListener('click', languageMenuDocListener);
    languageMenuDocListener = null;
  }
}

function showLanguageMenu(anchorEl, onSelect) {
  if (document.querySelector('.editor-lang-menu')) {
    closeLanguageMenu();
    return;
  }

  const menu = document.createElement('div');
  menu.className = 'card context-menu editor-lang-menu';
  menu.innerHTML = MONACO_LANGUAGES.map(opt => `
    <button type="button" class="btn-menu-item ${opt.value === currentEditorLanguage ? 'active' : ''}" data-lang="${opt.value}">
      <span>${opt.label}</span>
    </button>
  `).join('');
  document.body.appendChild(menu);

  const rect = anchorEl.getBoundingClientRect();
  const menuRect = menu.getBoundingClientRect();
  let left = rect.left;
  if (left + menuRect.width > window.innerWidth - 12) {
    left = window.innerWidth - menuRect.width - 12;
  }
  menu.style.left = `${Math.max(12, left)}px`;
  menu.style.top = `${rect.bottom + 8}px`;

  menu.querySelectorAll('[data-lang]').forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      currentEditorLanguage = btn.dataset.lang;
      setEditorLanguageLabel(currentEditorLanguage);
      closeLanguageMenu();
      onSelect(currentEditorLanguage);
    };
  });

  languageMenuDocListener = (e) => {
    if (!menu.contains(e.target) && e.target !== anchorEl && !anchorEl.contains(e.target)) {
      closeLanguageMenu();
    }
  };
  setTimeout(() => document.addEventListener('click', languageMenuDocListener), 50);
}

// userId/username come from other collaborators over the WebSocket (the server relays
// whatever a connecting client claims, without validating the format) — sanitize before
// building CSS class selectors / interpolating into a CSS string, or a malicious collaborator
// could break out of the `content: "..."` declaration and inject arbitrary CSS into every
// other participant's page.
function collabClassToken(id) {
  return String(id).replace(/[^a-zA-Z0-9_-]/g, '');
}
function escapeCssString(str) {
  return String(str).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function addCollabUserStyles(userId, color, username) {
  const safeId = collabClassToken(userId);
  const styleId = `collab-styles-${safeId}`;
  let styleEl = document.getElementById(styleId);
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = styleId;
    document.head.appendChild(styleEl);
  }
  styleEl.innerHTML = `
    .collab-selection-${safeId} {
      background-color: ${color}33 !important;
    }
    .collab-cursor-${safeId} {
      border-left: 2px solid ${color} !important;
      margin-left: -1px;
      position: relative;
    }
    .collab-cursor-tooltip-${safeId}::after {
      content: "${escapeCssString(username)}";
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
  const styleEl = document.getElementById(`collab-styles-${collabClassToken(userId)}`);
  if (styleEl) styleEl.remove();
}

function initCollabSocket(fileId, username, userId, isPublic = false, slug = '', isGuest = false) {
  if (collabSocket) {
    collabSocket.close();
    collabSocket = null;
  }

  collabUserDecorations = {};
  collabUserColorMap = {};
  myCollabUserId = userId;

  const wsProto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsHost = window.location.host;

  let wsUrl = `${wsProto}//${wsHost}/api/collab?fileId=${fileId}&username=${encodeURIComponent(username)}&userId=${userId}`;
  if (isGuest) wsUrl += `&guest=1`;
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
        if (data.userId) myCollabUserId = data.userId;
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

        // Prefer the authoritative colour the server assigned to this user
        let color = collabUserColorMap[targetUserId];
        if (!color) {
          const colors = ['#00d2ff', '#ff5555', '#50fa7b', '#ffb86c', '#ff79c6', '#bd93f9', '#f1fa8c', '#8be9fd'];
          let hash = 0;
          for (let i = 0; i < targetUserId.length; i++) {
            hash = targetUserId.charCodeAt(i) + ((hash << 5) - hash);
          }
          color = colors[Math.abs(hash) % colors.length];
        }

        addCollabUserStyles(targetUserId, color, targetUsername);

        const safeTargetId = collabClassToken(targetUserId);
        const decorations = [];
        if (selection && (selection.startLineNumber !== selection.endLineNumber || selection.startColumn !== selection.endColumn)) {
          decorations.push({
            range: new monaco.Range(selection.startLineNumber, selection.startColumn, selection.endLineNumber, selection.endColumn),
            options: {
              className: `collab-selection-${safeTargetId}`,
              hoverMessage: { value: targetUsername }
            }
          });
        }

        if (position) {
          decorations.push({
            range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column),
            options: {
              className: `collab-cursor-${safeTargetId}`,
              afterContentClassName: `collab-cursor-tooltip-${safeTargetId}`,
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

  // Keep the authoritative colour map in sync with the room roster
  if (Array.isArray(users)) {
    users.forEach(u => { if (u.userId) collabUserColorMap[u.userId] = u.color; });
  }

  if (!container || !listEl) return;

  if (!users || users.length <= 1) {
    container.style.display = 'none';
    return;
  }

  container.style.display = 'flex';
  const otherUsers = users.filter(u => u.userId !== myCollabUserId);
  const names = otherUsers.map(u => `<span style="color: ${u.color}; font-weight: bold;">${escapeHtml(u.username)}</span>`);
  listEl.innerHTML = names.length ? `Andere online: ${names.join(', ')}` : 'Nur du';
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

    document.getElementById('code-editor-title').textContent = fileName;
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
      saveBtn.style.display = readOnly ? 'none' : '';
    }

    // "Teilen" is only available in the authenticated app (creating a share requires ownership)
    const shareBtn = document.getElementById('share-code-editor-btn');
    if (shareBtn) {
      shareBtn.style.display = isPublic ? 'none' : '';
      shareBtn.onclick = () => openShareModal({ id: fileId, name: fileName, is_folder: false });
    }

    // "Verlauf" (autosave version history) is likewise authenticated-only
    const historyBtn = document.getElementById('editor-history-btn');
    document.getElementById('editor-history-panel')?.classList.remove('active');
    if (historyBtn) {
      historyBtn.style.display = isPublic ? 'none' : '';
      historyBtn.onclick = () => toggleEditorHistoryPanel(fileId);
    }

    // Click the title to rename in place — authenticated owner only, matching Teilen/Verlauf
    const titleEl = document.getElementById('code-editor-title');
    titleEl.style.cursor = (isPublic || readOnly) ? 'default' : 'text';
    titleEl.onclick = (isPublic || readOnly) ? null : () => startEditorTitleRename(fileId);

    const container = document.getElementById('monaco-editor-container');
    container.innerHTML = '';

    const language = getMonacoLanguage(fileName);

    // Sync language selector
    currentEditorLanguage = language;
    setEditorLanguageLabel(language);
    closeLanguageMenu();

    monacoEditorInstance = monaco.editor.create(container, {
      value: textContent,
      language: language,
      theme: 'vs-dark',
      automaticLayout: true,
      readOnly: readOnly,
      fontSize: 14,
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', Consolas, 'Courier New', monospace",
      fontLigatures: true,
      lineHeight: 22,
      letterSpacing: 0.3,
      minimap: { enabled: true, scale: 1 },
      bracketPairColorization: { enabled: true },
      'semanticHighlighting.enabled': true,
      colorDecorators: true,
      cursorSmoothCaretAnimation: 'on',
      cursorBlinking: 'phase',
      smoothScrolling: true,
      roundedSelection: true,
      renderLineHighlight: 'gutter',
      padding: { top: 12, bottom: 12 },
      // Autocomplete & IntelliSense
      quickSuggestions: { other: true, comments: false, strings: true },
      suggestOnTriggerCharacters: true,
      acceptSuggestionOnEnter: 'on',
      tabCompletion: 'on',
      wordBasedSuggestions: 'matchingDocuments',
      parameterHints: { enabled: true },
      inlineSuggest: { enabled: true },
      snippetSuggestions: 'inline',
      suggest: {
        showKeywords: true,
        showSnippets: true,
        showClasses: true,
        showFunctions: true,
        showVariables: true,
        showModules: true,
        showProperties: true,
        shareSuggestSelections: true,
        insertMode: 'replace',
        filterGraceful: true,
        localityBonus: true,
      },
      // Editor UX
      formatOnPaste: true,
      formatOnType: true,
      autoClosingBrackets: 'always',
      autoClosingQuotes: 'always',
      autoIndent: 'full',
      folding: true,
      foldingHighlight: true,
      showFoldingControls: 'mouseover',
      links: true,
      mouseWheelZoom: true,
      scrollBeyondLastLine: false,
    });

    // Ctrl+S save shortcut inside Monaco
    if (!readOnly) {
      monacoEditorInstance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
        document.getElementById('save-code-editor-btn').click();
      });
    }

    // Language selector handler
    const langBtn = document.getElementById('monaco-lang-btn');
    if (langBtn) {
      langBtn.onclick = (e) => {
        e.stopPropagation();
        showLanguageMenu(langBtn, (value) => {
          const model = monacoEditorInstance.getModel();
          if (model) monaco.editor.setModelLanguage(model, value);
        });
      };
    }

    // Start Collaboration WebSocket
    const isAuthed = (typeof currentUser !== 'undefined' && currentUser);
    const collabUsername = isAuthed ? currentUser.username : '';
    const collabUserId = isAuthed ? `${currentUser.id}` : `guest_${Math.random().toString(36).substring(2, 11)}`;
    initCollabSocket(fileId, collabUsername, collabUserId, isPublic, slug, !isAuthed);

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
          const r = await fetch(saveUrl, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: currentContent })
          });
          if (typeof showEditorSaveStatus === 'function') {
            if (r.ok) showEditorSaveStatus('✓ Auto-Gespeichert');
            else showEditorSaveStatus('Auto-Speichern fehlgeschlagen', true);
          }
        } catch (e) {
          console.error('Autosave error:', e);
          if (typeof showEditorSaveStatus === 'function') showEditorSaveStatus('Verbindungsfehler', true);
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

    const showEditorSaveStatus = (text, isError = false) => {
      const el = document.getElementById('editor-save-status');
      if (!el) return;
      el.textContent = text;
      el.style.color = isError ? '#ff453a' : '#50fa7b';
      el.style.opacity = '1';
      clearTimeout(el._fadeTimer);
      el._fadeTimer = setTimeout(() => { el.style.opacity = '0'; }, 2200);
    };

    if (!readOnly) {
      const doSave = async () => {
        const updatedContent = monacoEditorInstance.getValue();
        const saveStatus = document.getElementById('editor-save-status');
        if (saveStatus) { saveStatus.textContent = '↑ Speichern…'; saveStatus.style.color = 'var(--color-text-muted)'; saveStatus.style.opacity = '1'; }

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
            showEditorSaveStatus('✓ Gespeichert');
          } else {
            const err = await saveRes.json();
            showEditorSaveStatus(err.error || 'Fehler', true);
          }
        } catch {
          showEditorSaveStatus('Verbindungsfehler', true);
        }
      };

      document.getElementById('save-code-editor-btn').onclick = doSave;
    } else {
      const saveBtn = document.getElementById('save-code-editor-btn');
      if (saveBtn) saveBtn.style.display = 'none';
      const kbd = document.querySelector('.editor-kbd');
      if (kbd) kbd.style.display = 'none';
    }
  } catch (err) {
    console.error('Error opening code editor:', err);
    showToast('Code-Editor konnte nicht geladen werden.');
  }
}

function startEditorTitleRename(fileId) {
  const titleEl = document.getElementById('code-editor-title');
  const input = document.getElementById('code-editor-title-input');
  if (!titleEl || !input || input.style.display !== 'none') return;

  const originalName = titleEl.textContent;
  input.value = originalName;
  titleEl.style.display = 'none';
  input.style.display = '';
  input.focus();
  // Select just the filename part (before the extension), matching most file managers
  const dotIndex = originalName.lastIndexOf('.');
  input.setSelectionRange(0, dotIndex > 0 ? dotIndex : originalName.length);

  let settled = false;
  const finish = async (commit) => {
    if (settled) return;
    settled = true;
    const newName = input.value.trim();

    if (!commit || !newName || newName === originalName) {
      titleEl.style.display = '';
      input.style.display = 'none';
      return;
    }

    try {
      const r = await fetch(`/api/files/${fileId}/rename`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName }),
      });
      const data = await r.json();
      if (r.ok) {
        titleEl.textContent = data.name;
        currentEditorLanguage = getMonacoLanguage(data.name);
        setEditorLanguageLabel(currentEditorLanguage);
        if (monacoEditorInstance) monaco.editor.setModelLanguage(monacoEditorInstance.getModel(), currentEditorLanguage);
        showToast('Umbenannt.');
        loadFiles(currentFolderId);
      } else {
        titleEl.textContent = originalName;
        showToast(data.error || 'Fehler beim Umbenennen.');
      }
    } catch {
      titleEl.textContent = originalName;
      showToast('Verbindungsfehler.');
    }

    titleEl.style.display = '';
    input.style.display = 'none';
  };

  input.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  };
  input.onblur = () => finish(true);
}

function formatRelativeTime(dateStr) {
  const date = new Date(dateStr);
  const diffMs = Date.now() - date.getTime();
  const diffMin = Math.round(diffMs / 60000);
  if (diffMin < 1) return 'gerade eben';
  if (diffMin < 60) return `vor ${diffMin} Min.`;
  const diffH = Math.round(diffMin / 60);
  if (diffH < 24) return `vor ${diffH} Std.`;
  return date.toLocaleString('de-DE');
}

async function toggleEditorHistoryPanel(fileId) {
  const panel = document.getElementById('editor-history-panel');
  if (!panel) return;
  if (panel.classList.contains('active')) {
    panel.classList.remove('active');
    return;
  }
  panel.classList.add('active');
  await loadEditorHistory(fileId);
}

async function loadEditorHistory(fileId) {
  const list = document.getElementById('editor-history-list');
  if (!list) return;
  list.innerHTML = '<p style="font-size: 0.82rem; color: var(--color-text-muted);">Lade Verlauf...</p>';

  try {
    const res = await fetch(`/api/files/${fileId}/versions`);
    if (!res.ok) { list.innerHTML = '<p style="font-size: 0.82rem; color: var(--color-text-muted);">Verlauf konnte nicht geladen werden.</p>'; return; }
    const versions = await res.json();

    if (versions.length === 0) {
      list.innerHTML = '<p style="font-size: 0.82rem; color: var(--color-text-muted);">Noch keine gespeicherten Versionen. Beim Bearbeiten wird automatisch alle paar Minuten ein Checkpoint angelegt.</p>';
      return;
    }

    list.innerHTML = versions.map(v => `
      <div class="editor-history-entry" data-version-id="${v.id}">
        <div>
          <div class="editor-history-entry-time">${formatRelativeTime(v.created_at)}</div>
          <div class="editor-history-entry-meta">${new Date(v.created_at).toLocaleString('de-DE')} · ${formatBytes(v.size)}</div>
        </div>
        <button type="button" class="editor-history-restore-btn" title="Wiederherstellen">
          <i data-lucide="rotate-ccw"></i>
        </button>
      </div>
    `).join('');

    list.querySelectorAll('.editor-history-entry').forEach((entry, index) => {
      entry.onclick = () => showVersionDiff(fileId, versions, index);

      const btn = entry.querySelector('.editor-history-restore-btn');
      btn.onclick = async (e) => {
        e.stopPropagation();
        const versionId = entry.dataset.versionId;
        if (!await showConfirmDialog('Version wiederherstellen', 'Der aktuelle Inhalt wird durch diese Version ersetzt (der jetzige Stand wird selbst als Checkpoint gesichert).')) return;
        try {
          const r = await fetch(`/api/files/${fileId}/versions/${versionId}/restore`, { method: 'POST' });
          const data = await r.json();
          if (r.ok) {
            if (monacoEditorInstance) monacoEditorInstance.setValue(data.content);
            showToast('Version wiederhergestellt.');
            await loadEditorHistory(fileId);
          } else {
            showToast(data.error || 'Fehler beim Wiederherstellen.');
          }
        } catch {
          showToast('Verbindungsfehler.');
        }
      };
    });

    lucide.createIcons();
  } catch (err) {
    console.error('Error loading editor history:', err);
    list.innerHTML = '<p style="font-size: 0.82rem; color: var(--color-text-muted);">Verlauf konnte nicht geladen werden.</p>';
  }
}

let editorDiffInstance = null;

// Diffs a checkpoint against whatever came right after it — the next-newer checkpoint, or the
// file's current live content if this is the newest one — so the diff always shows exactly
// what changed *since* this checkpoint.
async function showVersionDiff(fileId, versions, index) {
  const overlay = document.getElementById('editor-diff-modal-overlay');
  const container = document.getElementById('editor-diff-container');
  const summary = document.getElementById('editor-diff-summary');
  if (!overlay || !container) return;

  overlay.classList.add('active');
  container.innerHTML = '';
  summary.textContent = 'Lade...';

  try {
    const version = versions[index];
    const olderRes = await fetch(`/api/files/${fileId}/versions/${version.id}`);
    const older = await olderRes.json();

    let newerContent, newerLabel;
    if (index > 0) {
      const newerRes = await fetch(`/api/files/${fileId}/versions/${versions[index - 1].id}`);
      const newer = await newerRes.json();
      newerContent = newer.content;
      newerLabel = formatRelativeTime(versions[index - 1].created_at);
    } else {
      const currentRes = await fetch(`/api/files/content/${fileId}`);
      newerContent = await currentRes.text();
      newerLabel = 'aktueller Stand';
    }

    await loadMonaco();
    const language = getMonacoLanguage(document.getElementById('code-editor-title').textContent);

    if (editorDiffInstance) {
      editorDiffInstance.dispose();
      editorDiffInstance = null;
    }
    editorDiffInstance = monaco.editor.createDiffEditor(container, {
      theme: 'vs-dark',
      readOnly: true,
      automaticLayout: true,
      renderSideBySide: true,
      fontSize: 13,
    });
    const originalModel = monaco.editor.createModel(older.content, language);
    const modifiedModel = monaco.editor.createModel(newerContent, language);
    editorDiffInstance.setModel({ original: originalModel, modified: modifiedModel });

    editorDiffInstance.onDidUpdateDiff(() => {
      const changes = editorDiffInstance.getLineChanges() || [];
      let added = 0, removed = 0;
      changes.forEach(c => {
        if (c.modifiedEndLineNumber > 0) added += (c.modifiedEndLineNumber - c.modifiedStartLineNumber + 1);
        if (c.originalEndLineNumber > 0) removed += (c.originalEndLineNumber - c.originalStartLineNumber + 1);
      });
      summary.innerHTML = `${formatRelativeTime(version.created_at)} → ${newerLabel} · <span style="color:#4ade80;">+${added} Zeilen</span> · <span style="color:#f87171;">-${removed} Zeilen</span>`;
    });
  } catch (err) {
    console.error('Error loading version diff:', err);
    summary.textContent = 'Diff konnte nicht geladen werden.';
  }
}

document.getElementById('close-editor-diff-modal-btn').onclick = () => {
  document.getElementById('editor-diff-modal-overlay').classList.remove('active');
  if (editorDiffInstance) {
    editorDiffInstance.dispose();
    editorDiffInstance = null;
  }
};

document.getElementById('close-code-editor-btn').onclick = () => {
  closeLanguageMenu();
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

function formatDuration(seconds) {
  if (!seconds || !isFinite(seconds)) return null;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

function renderViewerInfoPanel(file, extra) {
  const rows = [
    ['Name', file.name],
    ['Größe', formatBytes(file.size)],
    ['Typ', file.mime_type || '–'],
  ];
  if (file.created_at) rows.push(['Erstellt am', new Date(file.created_at).toLocaleString('de-DE')]);
  if (extra.resolution) rows.push(['Auflösung', extra.resolution]);
  if (extra.duration) rows.push(['Dauer', extra.duration]);
  if (file.exif?.camera) rows.push(['Kamera', file.exif.camera]);
  if (file.exif?.lens) rows.push(['Objektiv', file.exif.lens]);
  return `<h4>Informationen</h4><dl>${rows.map(([k, v]) => `<div><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(String(v))}</dd></div>`).join('')}</dl>`;
}

async function toggleViewerInfoPanel(panel, fileId, isPublic, slug, getExtra) {
  if (panel.classList.contains('active')) {
    panel.classList.remove('active');
    return;
  }
  panel.innerHTML = '<h4>Informationen</h4><div style="opacity:0.6;font-size:0.85rem;">Lade...</div>';
  panel.classList.add('active');
  try {
    const url = isPublic ? `/api/public/shares/${slug}/meta/${fileId}` : `/api/files/${fileId}`;
    const res = await fetch(url);
    const file = await res.json();
    if (!res.ok) throw new Error(file.error || 'Fehler beim Laden');
    panel.innerHTML = renderViewerInfoPanel(file, getExtra ? getExtra() : {});
  } catch (err) {
    panel.innerHTML = '<h4>Informationen</h4><div style="opacity:0.6;font-size:0.85rem;">Konnte nicht geladen werden.</div>';
  }
}

async function openImageViewer(fileId, fileName, isPublic = false, slug = '') {
  const overlay = document.getElementById('image-viewer-overlay');
  const img = document.getElementById('image-viewer-img');
  const loading = document.getElementById('image-viewer-loading');
  const title = document.getElementById('image-viewer-title');

  title.innerHTML = `<i data-lucide="image"></i> ${escapeHtml(fileName)}`;
  updateViewerNavButtons('image');
  lucide.createIcons();

  const infoPanel = document.getElementById('image-viewer-info-panel');
  infoPanel.classList.remove('active');
  document.getElementById('image-viewer-info-btn').onclick = () => toggleViewerInfoPanel(infoPanel, fileId, isPublic, slug, () => ({
    resolution: img.naturalWidth && img.naturalHeight ? `${img.naturalWidth} × ${img.naturalHeight}px` : null
  }));

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

  document.getElementById('image-viewer-download-btn').onclick = () => { window.location.href = downloadUrl; };

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

  title.innerHTML = `<i data-lucide="video"></i> ${escapeHtml(fileName)}`;
  updateViewerNavButtons('video');
  lucide.createIcons();

  const infoPanel = document.getElementById('video-viewer-info-panel');
  infoPanel.classList.remove('active');
  document.getElementById('video-viewer-info-btn').onclick = () => toggleViewerInfoPanel(infoPanel, fileId, isPublic, slug, () => ({
    resolution: player.videoWidth && player.videoHeight ? `${player.videoWidth} × ${player.videoHeight}px` : null,
    duration: formatDuration(player.duration)
  }));

  const sourceUrl = isPublic
    ? `/api/public/shares/${slug}/download/${fileId}`
    : `/api/files/download/${fileId}`;

  document.getElementById('video-viewer-download-btn').onclick = () => { window.location.href = sourceUrl; };

  player.src = sourceUrl;
  overlay.classList.add('active');
}

document.getElementById('close-video-viewer-btn').onclick = () => {
  document.getElementById('video-viewer-overlay').classList.remove('active');
  const player = document.getElementById('video-viewer-player');
  player.pause();
  player.src = '';
};

const VIEWER_IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'heic', 'heif', 'cr2', 'nef', 'dng', 'arw', 'orf', 'rw2', 'pef', 'raf'];
const VIEWER_VIDEO_EXTS = ['mp4', 'webm', 'ogg', 'mov', 'avi', 'mkv', 'flv', 'wmv', 'm4v'];

function updateViewerNavButtons(prefix) {
  const prevBtn = document.getElementById(`${prefix}-viewer-prev-btn`);
  const nextBtn = document.getElementById(`${prefix}-viewer-next-btn`);
  if (!prevBtn || !nextBtn) return;
  const hasPrev = viewerMediaIndex > 0;
  const hasNext = viewerMediaIndex !== -1 && viewerMediaIndex < viewerMediaList.length - 1;
  prevBtn.style.display = hasPrev ? 'flex' : 'none';
  nextBtn.style.display = hasNext ? 'flex' : 'none';
  prevBtn.onclick = () => navigateViewer(-1);
  nextBtn.onclick = () => navigateViewer(1);
}

function navigateViewer(direction) {
  if (viewerMediaList.length === 0 || viewerMediaIndex === -1) return;
  const newIndex = viewerMediaIndex + direction;
  if (newIndex < 0 || newIndex >= viewerMediaList.length) return;
  viewerMediaIndex = newIndex;
  const next = viewerMediaList[newIndex];
  const ext = next.name.split('.').pop().toLowerCase();

  const imageOverlay = document.getElementById('image-viewer-overlay');
  const videoOverlay = document.getElementById('video-viewer-overlay');
  if (VIEWER_IMAGE_EXTS.includes(ext)) {
    if (videoOverlay.classList.contains('active')) document.getElementById('close-video-viewer-btn').click();
    openImageViewer(next.id, next.name, viewerIsPublic, viewerSlug);
  } else if (VIEWER_VIDEO_EXTS.includes(ext)) {
    if (imageOverlay.classList.contains('active')) document.getElementById('close-image-viewer-btn').click();
    openVideoViewer(next.id, next.name, viewerIsPublic, viewerSlug);
  }
}

document.addEventListener('keydown', (e) => {
  const imageOverlay = document.getElementById('image-viewer-overlay');
  const videoOverlay = document.getElementById('video-viewer-overlay');
  const imageActive = imageOverlay.classList.contains('active');
  const videoActive = videoOverlay.classList.contains('active');
  if (!imageActive && !videoActive) return;

  if (e.key === 'ArrowRight') { e.preventDefault(); navigateViewer(1); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); navigateViewer(-1); }
  else if (e.key === ' ' && imageActive) {
    // Space only advances in the image viewer — in the video viewer it's the native
    // play/pause shortcut, which takes priority.
    e.preventDefault();
    navigateViewer(1);
  }
});

// pdfjs-dist only ships the library + the reusable PDFViewer component on npm (not the
// prebuilt viewer.html app, which Mozilla only distributes as a separate GitHub release ZIP) —
// so the two-page/spread view here is built directly on top of PDFViewer's own documented
// spreadMode property (0=none, 1=odd, 2=even) rather than embedding a full prebuilt app.
let pdfjsLib = null;
let pdfjsViewerLib = null;
let currentPdfViewer = null;
let currentPdfLoadingTask = null;

async function loadPdfJsLibs() {
  if (!pdfjsLib) {
    pdfjsLib = await import('/pdfjs/build/pdf.mjs');
    pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdfjs/build/pdf.worker.mjs';
  }
  if (!pdfjsViewerLib) {
    pdfjsViewerLib = await import('/pdfjs/web/pdf_viewer.mjs');
  }
  return { pdfjsLib, pdfjsViewerLib };
}

async function openPdfViewer(fileId, fileName, isPublic = false, slug = '') {
  const overlay = document.getElementById('pdf-viewer-overlay');
  const title = document.getElementById('pdf-viewer-title');

  title.innerHTML = `<i data-lucide="file-text"></i> ${escapeHtml(fileName)}`;
  lucide.createIcons();

  overlay.style.display = 'flex';
  overlay.classList.add('active');

  const sourceUrl = isPublic
    ? `/api/public/shares/${slug}/download/${fileId}?inline=true`
    : `/api/files/download/${fileId}?inline=true`;

  const container = document.getElementById('pdf-viewer-container');
  const inner = document.getElementById('pdf-viewer-inner');
  inner.innerHTML = '';
  document.querySelectorAll('#pdf-layout-toggle .pdf-layout-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.spread === '0'));

  try {
    const { pdfjsLib, pdfjsViewerLib } = await loadPdfJsLibs();

    if (currentPdfLoadingTask) {
      try { await currentPdfLoadingTask.destroy(); } catch {}
      currentPdfLoadingTask = null;
    }

    const eventBus = new pdfjsViewerLib.EventBus();
    const linkService = new pdfjsViewerLib.PDFLinkService({ eventBus });
    const pdfViewer = new pdfjsViewerLib.PDFViewer({ container, viewer: inner, eventBus, linkService });
    linkService.setViewer(pdfViewer);
    currentPdfViewer = pdfViewer;

    eventBus.on('pagesinit', () => {
      pdfViewer.currentScaleValue = 'page-width';
    });

    const loadingTask = pdfjsLib.getDocument(sourceUrl);
    currentPdfLoadingTask = loadingTask;
    const pdfDocument = await loadingTask.promise;
    pdfViewer.setDocument(pdfDocument);
    linkService.setDocument(pdfDocument);
  } catch (err) {
    console.error('PDF viewer error:', err);
    showToast('Fehler beim Laden der PDF-Datei.');
  }
}

document.querySelectorAll('#pdf-layout-toggle .pdf-layout-btn').forEach(btn => {
  btn.onclick = () => {
    if (!currentPdfViewer) return;
    document.querySelectorAll('#pdf-layout-toggle .pdf-layout-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentPdfViewer.spreadMode = parseInt(btn.dataset.spread, 10);
  };
});

// "page-fit" scales the page so both its height and width fit entirely inside the viewport —
// exactly the "match the displayed height/width ratio" fit the user asked for.
document.getElementById('pdf-fit-page-btn').onclick = () => {
  if (!currentPdfViewer) return;
  currentPdfViewer.currentScaleValue = 'page-fit';
};

// Space/→ = next page, ← = previous page, exactly one PDF page per press regardless of zoom or
// spread mode — nextPage()/previousPage() are PDFViewer's own page-stepping methods, so the
// step size always matches whatever this particular PDF's page size actually is.
document.addEventListener('keydown', (e) => {
  const overlay = document.getElementById('pdf-viewer-overlay');
  if (!overlay.classList.contains('active') || !currentPdfViewer) return;
  if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
  if (e.key === ' ' || e.key === 'ArrowRight') {
    e.preventDefault();
    currentPdfViewer.nextPage();
  } else if (e.key === 'ArrowLeft') {
    e.preventDefault();
    currentPdfViewer.previousPage();
  }
});

document.getElementById('close-pdf-viewer-btn').onclick = () => {
  const overlay = document.getElementById('pdf-viewer-overlay');
  overlay.classList.remove('active');
  overlay.style.display = 'none';
  document.getElementById('pdf-viewer-inner').innerHTML = '';
  if (currentPdfLoadingTask) {
    currentPdfLoadingTask.destroy().catch(() => {});
    currentPdfLoadingTask = null;
  }
  currentPdfViewer = null;
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

// Create a new role
const adminCreateRoleForm = document.getElementById('admin-create-role-form');
if (adminCreateRoleForm) {
  adminCreateRoleForm.onsubmit = async (e) => {
    e.preventDefault();
    const nameInput = document.getElementById('admin-new-role-name');
    const name = nameInput.value.trim();
    if (!name) return;
    try {
      const res = await fetch('/api/settings/admin/roles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // New roles start with sensible baseline permissions (everything except admin)
        body: JSON.stringify({ name, permissions: { upload: true, create_folder: true, delete: true, rename: true, share: true, download: true, edit_files: true, admin: false } })
      });
      const data = await res.json();
      if (res.ok) {
        showToast(`Rolle "${data.name}" erstellt.`);
        nameInput.value = '';
        loadAdminRoles();
      } else {
        showToast(data.error || 'Fehler beim Anlegen der Rolle.');
      }
    } catch {
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
    const dropzone = document.getElementById('create-note-dropzone');
    const fileInput = document.getElementById('create-note-file-input');
    const attachmentList = document.getElementById('create-note-attachment-list');

    nameInput.value = defaultName ? (defaultName.endsWith('.txt') ? defaultName : defaultName + '.txt') : 'Einmalnotiz.txt';
    contentInput.value = '';
    maxViewsInput.value = 1;
    expiresSelect.value = '24'; // 24 hours default

    let attachments = [];
    const renderAttachments = () => {
      attachmentList.innerHTML = attachments.map((f, i) => `
        <div style="display: flex; align-items: center; gap: 0.5rem; font-size: 0.8rem; background: rgba(255,255,255,0.04); border-radius: var(--radius-sm); padding: 0.4rem 0.6rem;">
          <i data-lucide="file" style="width: 14px; height: 14px; color: var(--color-text-muted); flex-shrink: 0;"></i>
          <span style="flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(f.name)}</span>
          <span style="color: var(--color-text-muted);">${formatBytes(f.size)}</span>
          <button type="button" class="btn-icon remove-attachment-btn" data-index="${i}" style="width: 22px; height: 22px;"><i data-lucide="x" style="width: 14px; height: 14px;"></i></button>
        </div>
      `).join('');
      attachmentList.querySelectorAll('.remove-attachment-btn').forEach(btn => {
        btn.onclick = () => { attachments.splice(parseInt(btn.dataset.index), 1); renderAttachments(); };
      });
      lucide.createIcons();
    };
    attachments = [];
    renderAttachments();

    dropzone.onclick = () => fileInput.click();
    fileInput.onchange = () => { attachments.push(...fileInput.files); fileInput.value = ''; renderAttachments(); };
    dropzone.ondragover = (e) => { e.preventDefault(); dropzone.classList.add('drag-over'); };
    dropzone.ondragleave = () => dropzone.classList.remove('drag-over');
    dropzone.ondrop = (e) => {
      e.preventDefault();
      dropzone.classList.remove('drag-over');
      attachments.push(...e.dataTransfer.files);
      renderAttachments();
    };

    overlay.classList.add('active');
    contentInput.focus();

    const cleanup = () => {
      overlay.classList.remove('active');
      form.onsubmit = null;
      cancelBtn.onclick = null;
      closeBtn.onclick = null;
      dropzone.onclick = null;
      dropzone.ondragover = null;
      dropzone.ondragleave = null;
      dropzone.ondrop = null;
      fileInput.onchange = null;
    };

    form.onsubmit = async (e) => {
      e.preventDefault();
      const formData = new FormData();
      formData.append('name', nameInput.value.trim());
      formData.append('content', contentInput.value);
      formData.append('maxViews', parseInt(maxViewsInput.value) || 1);
      formData.append('expiresHours', parseInt(expiresSelect.value) || 24);
      formData.append('parentId', currentFolderId || '');
      attachments.forEach(f => formData.append('attachments', f));

      showToast('Erstelle Einmalnotiz...');
      cleanup();

      try {
        const res = await fetch('/api/files/create-note', {
          method: 'POST',
          body: formData
        });

        const data = await res.json();
        if (res.ok) {
          showToast('Einmalnotiz erfolgreich erstellt.');
          loadFiles(currentFolderId);
          checkNotesExist();
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

  linkInput.value = link;
  overlay.classList.add('active');

  const cleanup = () => {
    overlay.classList.remove('active');
    copyBtn.onclick = null;
    closeBtn.onclick = null;
  };

  copyBtn.onclick = () => {
    linkInput.select();
    document.execCommand('copy');
    showToast('Link in Zwischenablage kopiert!');
  };

  closeBtn.onclick = cleanup;
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

  const searchClearBtn = document.getElementById('search-clear-btn');

  const updateSearchClearBtn = () => {
    if (searchClearBtn) {
      searchClearBtn.style.display = searchInput.value.length > 0 ? 'flex' : 'none';
    }
  };

  if (searchClearBtn) {
    searchClearBtn.onclick = () => {
      searchInput.value = '';
      updateSearchClearBtn();
      loadFiles(currentFolderId);
      searchInput.focus();
    };
  }

  searchInput.oninput = () => {
    updateSearchClearBtn();
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(triggerSearch, 300);
  };

  searchInput.addEventListener('keydown', (e) => {
    // Strg + Leertaste => Intelligente (Tiefen-)Suche umschalten
    if (e.ctrlKey && (e.code === 'Space' || e.key === ' ')) {
      e.preventDefault();
      e.stopPropagation();
      searchDeepCheck.checked = !searchDeepCheck.checked;
      searchDeepCheck.dispatchEvent(new Event('change'));
      showToast(searchDeepCheck.checked ? 'Intelligente Suche aktiviert' : 'Intelligente Suche deaktiviert');
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      clearTimeout(searchTimeout);
      triggerSearch();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      searchInput.value = '';
      updateSearchClearBtn();
      loadFiles(currentFolderId);
      collapseDashboardSearch(true); // erzwungen einklappen (blur inklusive)
    }
  });

  searchDeepCheck.onchange = () => {
    if (searchInput.value.trim()) {
      triggerSearch();
    }
  };

  // Lupe-Button: Suchfeld umschalten (aus-/einklappen)
  const searchContainer = document.getElementById('search-container');
  const searchToggleBtn = document.getElementById('search-toggle-btn');
  if (searchToggleBtn) {
    searchToggleBtn.onclick = (e) => {
      e.stopPropagation();
      if (searchContainer && searchContainer.classList.contains('search-expanded')) {
        collapseDashboardSearch(); // nur einklappen, wenn leer
      } else {
        expandDashboardSearch(true);
      }
    };
  }

  // Klick außerhalb des Suchfelds klappt es ein (sofern kein Suchtext vorhanden)
  document.addEventListener('click', (e) => {
    if (!searchContainer || !searchContainer.classList.contains('search-expanded')) return;
    if (!searchContainer.contains(e.target)) collapseDashboardSearch();
  });
}
