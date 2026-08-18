// mobile-ui.js — shared touch-interaction primitives for the dashboard (index.html/app.js)
// and the public share page (share.html). No bundler exists in this project, so this is a
// plain global-scope script loaded via <script src="/mobile-ui.js"> before the page's own
// script — exactly like the existing lucide/qrcode/etc. includes. Everything here is exposed
// as window.MobileUI and is purely additive: it never touches existing mouse-driven
// onclick/ondblclick/oncontextmenu handlers, so desktop behavior is unaffected.
(function () {
  'use strict';

  // ─── Capability detection ────────────────────────────────────────────────
  // Re-evaluated on every call (not cached) since pointer/viewport can change at runtime
  // (orientation change, a mouse plugged into a tablet, a window resize).
  function isCoarsePointer() {
    return window.matchMedia('(hover: none), (pointer: coarse)').matches;
  }

  function isNarrowViewport() {
    // Mirrors the existing tablet breakpoint already used throughout styles.css (max-width: 768px)
    // so there is exactly one canonical "mobile" width threshold shared between CSS and JS.
    return window.matchMedia('(max-width: 768px)').matches;
  }

  // ─── Touch gestures: single-tap-to-open + long-press-to-select ──────────
  // Additive only for touch pointers (filtered via e.pointerType === 'touch') — mouse and pen
  // input pass through untouched to whatever onclick/ondblclick/oncontextmenu handlers the
  // caller already has wired up.
  function attachTouchGestures(el, opts) {
    const onTap = opts && opts.onTap;
    const onLongPress = opts && opts.onLongPress;
    const longPressMs = (opts && opts.longPressMs) || 500;
    const moveTolerancePx = (opts && opts.moveTolerancePx) || 10;
    // Elements matching this selector (e.g. an existing icon button with its own onclick) get
    // left alone entirely — no preventDefault, no tap/long-press callback — so their native
    // click still fires instead of being suppressed by this gesture layer.
    const ignoreSelector = opts && opts.ignoreSelector;

    let startX = 0;
    let startY = 0;
    let timer = null;
    let longPressFired = false;
    let cancelled = false;
    let ignoredTarget = false;

    function clearTimer() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    }

    el.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'touch') return;
      ignoredTarget = !!(ignoreSelector && e.target.closest(ignoreSelector));
      if (ignoredTarget) return;
      startX = e.clientX;
      startY = e.clientY;
      longPressFired = false;
      cancelled = false;
      clearTimer();
      timer = setTimeout(() => {
        timer = null;
        if (cancelled) return;
        longPressFired = true;
        if (navigator.vibrate) {
          try { navigator.vibrate(10); } catch (err) { /* progressive enhancement only */ }
        }
        if (onLongPress) onLongPress(el, e);
      }, longPressMs);
    }, { passive: true });

    el.addEventListener('pointermove', (e) => {
      if (e.pointerType !== 'touch' || cancelled || ignoredTarget) return;
      const dx = Math.abs(e.clientX - startX);
      const dy = Math.abs(e.clientY - startY);
      if (dx > moveTolerancePx || dy > moveTolerancePx) {
        cancelled = true;
        clearTimer();
      }
    }, { passive: true });

    el.addEventListener('pointerup', (e) => {
      if (e.pointerType !== 'touch' || ignoredTarget) return;
      const firedLongPress = longPressFired;
      clearTimer();
      if (cancelled || firedLongPress) return;
      // Only suppress the synthetic click/dblclick that would otherwise follow this touch
      // sequence when a caller actually supplied onTap — a caller that only wants long-press
      // detection (passing no onTap) leaves the page's existing native click behavior
      // completely untouched, which matters on pages where tap-to-open already works correctly
      // and must not be double-handled or suppressed.
      if (onTap) {
        e.preventDefault();
        onTap(el, e);
      }
    });

    el.addEventListener('pointercancel', () => {
      if (ignoredTarget) return;
      cancelled = true;
      clearTimer();
    });
  }

  // ─── Shared scroll-lock registration ─────────────────────────────────────
  // Both index.html and share.html already run a MutationObserver that scroll-locks the body
  // while any ".modal-overlay" element carries the ".active" class. New overlays created here
  // (bottom sheet, off-canvas drawer backdrop) are created *after* that observer's initial
  // querySelectorAll ran at page load, so each page must explicitly hand the observer this
  // freshly-created element instead of a second, independent scroll-lock implementation being
  // built here.
  let scrollLockObserver = null;
  function registerScrollLockObserver(observer) {
    scrollLockObserver = observer;
  }
  function observeForScrollLock(el) {
    if (scrollLockObserver) scrollLockObserver.observe(el, { attributes: true, attributeFilter: ['class'] });
  }

  // ─── Bottom sheet ─────────────────────────────────────────────────────────
  // Replaces the small anchored .context-menu card on touch/narrow viewports. Reuses the exact
  // same design tokens as .context-menu (--dropdown-bg, --glass-*, --radius-xl) so it is
  // automatically correct across both visual themes and both color schemes with no new
  // theme-specific CSS — see the .mobileui-sheet* rules in styles.css.
  let activeSheet = null;

  function closeBottomSheet() {
    if (!activeSheet) return;
    const { overlay, onClose } = activeSheet;
    overlay.classList.remove('active');
    overlay.classList.add('mobileui-sheet-leaving');
    const cleanup = () => {
      overlay.remove();
      document.removeEventListener('keydown', onKeyDown);
    };
    overlay.addEventListener('transitionend', cleanup, { once: true });
    // Fallback in case transitionend doesn't fire (e.g. element removed before it can)
    setTimeout(cleanup, 300);
    activeSheet = null;
    if (onClose) onClose();
  }

  function onKeyDown(e) {
    if (e.key === 'Escape') closeBottomSheet();
  }

  function openBottomSheet(config) {
    const title = config && config.title;
    const items = (config && config.items) || [];
    const onClose = config && config.onClose;

    // Only one sheet at a time — closing any previously open one keeps behavior predictable
    // if a caller opens a new sheet without the user dismissing the last one first.
    if (activeSheet) closeBottomSheet();

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay mobileui-sheet-overlay';

    const sheet = document.createElement('div');
    sheet.className = 'mobileui-sheet';
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-modal', 'true');

    const handle = document.createElement('div');
    handle.className = 'mobileui-sheet-handle';
    sheet.appendChild(handle);

    if (title) {
      const titleEl = document.createElement('div');
      titleEl.className = 'mobileui-sheet-title';
      titleEl.textContent = title;
      sheet.appendChild(titleEl);
    }

    items.forEach((item) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'mobileui-sheet-item';
      if (item.dangerFlag || item.danger) btn.setAttribute('data-danger', 'true');
      btn.innerHTML = `<i data-lucide="${item.icon}"></i><span>${item.label}</span>`;
      btn.onclick = () => {
        closeBottomSheet();
        if (item.action) item.action();
      };
      sheet.appendChild(btn);
    });

    overlay.appendChild(sheet);
    document.body.appendChild(overlay);
    if (window.lucide) window.lucide.createIcons({ el: sheet });

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeBottomSheet();
    });

    // Swipe-down-to-dismiss on the sheet itself, via the same touch-gesture primitive used for
    // file-item long-press elsewhere — a drag past a threshold closes it.
    let dragStartY = null;
    sheet.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'touch') return;
      dragStartY = e.clientY;
    }, { passive: true });
    sheet.addEventListener('pointerup', (e) => {
      if (e.pointerType !== 'touch' || dragStartY === null) return;
      const dy = e.clientY - dragStartY;
      dragStartY = null;
      if (dy > 80) closeBottomSheet();
    });

    document.addEventListener('keydown', onKeyDown);
    observeForScrollLock(overlay);

    activeSheet = { overlay, onClose };

    // Trigger the slide-up transition on the next frame (element must be in the DOM first).
    requestAnimationFrame(() => {
      requestAnimationFrame(() => overlay.classList.add('active'));
    });
  }

  // ─── Off-canvas nav (Nova sidebar drawer / generic slide-in panel) ───────
  function initOffCanvasNav(config) {
    const sidebarEl = config && config.sidebarEl;
    const triggerEl = config && config.triggerEl;
    const openClass = (config && config.openClass) || 'mobileui-drawer-open';
    // Elements outside sidebarEl that CSS slides in as part of the same visual drawer panel
    // (e.g. Nova's profile/logout card, a separate DOM sibling of the sidebar it's rendered
    // next to) but that aren't reachable through sidebarEl's own click listener below — a tap
    // on a link/button inside one of these closes the drawer exactly like a sidebarEl nav tap
    // does, so a subsequent modal (Settings, ...) isn't left rendering underneath the still-open,
    // higher-z-index drawer.
    const extraCloseEls = (config && config.extraCloseEls) || [];
    if (!sidebarEl || !triggerEl) return;

    let backdrop = null;

    function open() {
      document.documentElement.classList.add(openClass);
      backdrop = document.createElement('div');
      backdrop.className = 'modal-overlay mobileui-drawer-backdrop active';
      document.body.appendChild(backdrop);
      observeForScrollLock(backdrop);
      backdrop.addEventListener('click', close);
      document.addEventListener('keydown', onEsc);
    }

    function close() {
      document.documentElement.classList.remove(openClass);
      if (backdrop) {
        backdrop.remove();
        backdrop = null;
      }
      document.removeEventListener('keydown', onEsc);
    }

    function onEsc(e) {
      if (e.key === 'Escape') close();
    }

    triggerEl.addEventListener('click', () => {
      if (document.documentElement.classList.contains(openClass)) {
        close();
      } else {
        open();
      }
    });

    // Tapping any nav link inside the drawer should close it — otherwise it stays open,
    // covering the newly-navigated-to view, until the user separately taps the backdrop.
    sidebarEl.addEventListener('click', (e) => {
      if (e.target.closest('a, button')) close();
    });
    extraCloseEls.forEach((el) => {
      if (!el) return;
      el.addEventListener('click', (e) => {
        if (e.target.closest('a, button')) close();
      });
    });

    return { open, close };
  }

  window.MobileUI = {
    isCoarsePointer,
    isNarrowViewport,
    attachTouchGestures,
    openBottomSheet,
    closeBottomSheet,
    initOffCanvasNav,
    registerScrollLockObserver
  };
})();
