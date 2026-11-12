'use strict';

/**
 * appbar.js
 *
 * Docks a BrowserWindow to a screen edge as a Windows application desktop bar
 * ("appbar") via SHAppBarMessage. A registered appbar owns a strip of the work
 * area: maximized windows stop at its edge instead of running underneath it,
 * which is what separates this from an always-on-top window that merely floats.
 *
 * Deskbands — the old "toolbar inside the taskbar" — were removed in Windows 11
 * and are not an option. Appbars are a separate, still-supported API.
 *
 * Windows-only. Every entry point degrades to a no-op elsewhere so callers do
 * not have to branch on platform.
 *
 * The shell talks back to us through a private window message (ABN_* codes),
 * received via Electron's hookWindowMessage. The important one is ABN_POSCHANGED:
 * the taskbar moved or resized, so we must re-reserve our space.
 *
 * IMPORTANT: an appbar that is not removed leaks its reserved space until the
 * shell notices the window is gone. undock() must run on quit.
 */

const { screen } = require('electron');

// SHAppBarMessage dwMessage values
const ABM_NEW = 0x00000000;
const ABM_REMOVE = 0x00000001;
const ABM_QUERYPOS = 0x00000002;
const ABM_SETPOS = 0x00000003;
const ABM_GETTASKBARPOS = 0x00000005;
const ABM_ACTIVATE = 0x00000006;
const ABM_WINDOWPOSCHANGED = 0x00000009;

// Notification codes delivered through uCallbackMessage's wParam
const ABN_STATECHANGE = 0x0000;
const ABN_POSCHANGED = 0x0001;
const ABN_FULLSCREENAPP = 0x0002;
const ABN_WINDOWARRANGE = 0x0003;

// SetWindowPos flags
const SWP_NOSIZE = 0x0001;
const SWP_NOMOVE = 0x0002;
const SWP_NOZORDER = 0x0004;
const SWP_NOACTIVATE = 0x0010;
const SWP_SHOWWINDOW = 0x0040;
const SWP_NOSENDCHANGING = 0x0400; // skip WM_WINDOWPOSCHANGING, i.e. the work-area clamp

// Screen edges (uEdge)
const ABE_LEFT = 0;
const ABE_TOP = 1;
const ABE_RIGHT = 2;
const ABE_BOTTOM = 3;

const EDGE_NAMES = { left: ABE_LEFT, top: ABE_TOP, right: ABE_RIGHT, bottom: ABE_BOTTOM };

// Private message id the shell will post back to our window. WM_USER range is
// reserved for exactly this kind of per-window protocol.
const WM_APPBAR_CALLBACK = 0x0400 + 0x51;

let koffi = null;
let SHAppBarMessage = null;
let SetWindowPos = null;
let GetWindowRect = null;
let GetForegroundWindow = null;
let MonitorFromWindow = null;
let FindWindowExW = null;
let GetWindow = null;
let IsWindowVisible = null;
let DwmGetFlag = null;
let DwmGetRect = null;
let SetWinEventHook = null;
let UnhookWinEvent = null;
let WinEventProc = null;
let APPBARDATA = null;
let loadError = null;

function ensureLoaded() {
  if (SHAppBarMessage || loadError) return !loadError;
  if (process.platform !== 'win32') {
    loadError = 'not windows';
    return false;
  }
  try {
    koffi = require('koffi');
    const RECT = koffi.struct('APPBAR_RECT', {
      left: 'long', top: 'long', right: 'long', bottom: 'long',
    });
    // x64 layout: cbSize(4) + pad(4) + hWnd(8) + uCallbackMessage(4) + uEdge(4)
    // + RECT(16) + lParam(8) = 48 bytes. koffi computes this; the size is
    // asserted below because a mismatch would corrupt the shell's view of it.
    APPBARDATA = koffi.struct('APPBARDATA', {
      cbSize: 'uint32',
      hWnd: 'uintptr_t',
      uCallbackMessage: 'uint32',
      uEdge: 'uint32',
      rc: RECT,
      lParam: 'int64',
    });
    const expected = process.arch === 'x64' || process.arch === 'arm64' ? 48 : 36;
    if (koffi.sizeof(APPBARDATA) !== expected) {
      throw new Error(`APPBARDATA size ${koffi.sizeof(APPBARDATA)}, expected ${expected}`);
    }
    const shell32 = koffi.load('shell32.dll');
    SHAppBarMessage = shell32.func(
      'uintptr_t __stdcall SHAppBarMessage(uint32 dwMessage, _Inout_ APPBARDATA *pData)'
    );
    // Electron's setBounds goes through Chromium, which clamps a top-level
    // window back inside the work area — including the strip this appbar just
    // reserved, since a reservation is by definition outside the work area.
    // Positioning the HWND directly is how a real appbar places itself.
    const user32 = koffi.load('user32.dll');
    SetWindowPos = user32.func(
      'bool __stdcall SetWindowPos(uintptr_t hWnd, uintptr_t hWndInsertAfter, int X, int Y, int cx, int cy, uint32 uFlags)'
    );
    GetWindowRect = user32.func(
      'bool __stdcall GetWindowRect(uintptr_t hWnd, _Out_ APPBAR_RECT *lpRect)'
    );
    GetForegroundWindow = user32.func('uintptr_t __stdcall GetForegroundWindow()');
    MonitorFromWindow = user32.func('uintptr_t __stdcall MonitorFromWindow(uintptr_t hWnd, uint32 dwFlags)');
    FindWindowExW = user32.func(
      'uintptr_t __stdcall FindWindowExW(uintptr_t hWndParent, uintptr_t hWndChildAfter, str16 lpszClass, str16 lpszWindow)'
    );
    GetWindow = user32.func('uintptr_t __stdcall GetWindow(uintptr_t hWnd, uint32 uCmd)');
    IsWindowVisible = user32.func('bool __stdcall IsWindowVisible(uintptr_t hWnd)');
    const dwmapi = koffi.load('dwmapi.dll');
    DwmGetFlag = dwmapi.func('int32 __stdcall DwmGetWindowAttribute(uintptr_t hWnd, uint32 attr, _Out_ uint32 *value, uint32 size)');
    DwmGetRect = dwmapi.func('int32 __stdcall DwmGetWindowAttribute(uintptr_t hWnd, uint32 attr, _Out_ APPBAR_RECT *value, uint32 size)');
    WinEventProc = koffi.proto('void __stdcall WinEventProc(uintptr_t hHook, uint32 event, uintptr_t hwnd, int32 idObject, int32 idChild, uint32 idThread, uint32 time)');
    SetWinEventHook = user32.func('uintptr_t __stdcall SetWinEventHook(uint32 eventMin, uint32 eventMax, uintptr_t hmod, WinEventProc *fn, uint32 pid, uint32 tid, uint32 flags)');
    UnhookWinEvent = user32.func('bool __stdcall UnhookWinEvent(uintptr_t hHook)');
    return true;
  } catch (err) {
    loadError = err.message;
    console.error('[AppBar] FFI unavailable, docking disabled:', err.message);
    return false;
  }
}

// --- Live state -------------------------------------------------------------

let state = null; // { win, hwnd, edge, thickness, unhook }
let applying = false; // guards the notify -> reposition -> notify loop
let lastRc = null;    // strip most recently granted by the shell
let placed = null;    // physical rect we last asked the OS for

function newData(hwnd, extra = {}) {
  return Object.assign({
    cbSize: koffi.sizeof(APPBARDATA),
    hWnd: hwnd,
    uCallbackMessage: 0,
    uEdge: 0,
    rc: { left: 0, top: 0, right: 0, bottom: 0 },
    lParam: 0,
  }, extra);
}

/** HWND as a plain integer, read out of Electron's native handle buffer. */
function hwndOf(win) {
  const buf = win.getNativeWindowHandle();
  // Windows hands out small handle values in practice, so Number is exact here
  // and avoids threading BigInt through every APPBARDATA literal.
  return buf.length === 8 ? Number(buf.readBigUInt64LE(0)) : buf.readUInt32LE(0);
}

/**
 * Physical-pixel bounds of the display the window sits on. The shell speaks
 * physical pixels; Electron's setBounds speaks DIP, so the two are converted
 * at the boundary rather than mixed.
 */
function displayPhysicalBounds(win) {
  const display = screen.getDisplayMatching(win.getBounds());
  const { x, y, width, height } = display.bounds;
  const scale = display.scaleFactor || 1;
  return {
    left: Math.round(x * scale),
    top: Math.round(y * scale),
    right: Math.round((x + width) * scale),
    bottom: Math.round((y + height) * scale),
    scale,
  };
}

/**
 * Propose the strip we want, let the shell veto/adjust it, then claim it.
 * The shell moves our proposal clear of anything already docked (the taskbar,
 * most importantly), and we re-apply our thickness to whatever it hands back.
 */
function reservePosition() {
  if (!state) return null;
  const { hwnd, edge, thickness, win } = state;
  const screenRect = displayPhysicalBounds(win);
  const px = Math.round(thickness * screenRect.scale);

  const rc = { left: screenRect.left, top: screenRect.top, right: screenRect.right, bottom: screenRect.bottom };
  if (edge === ABE_TOP) rc.bottom = rc.top + px;
  else if (edge === ABE_BOTTOM) rc.top = rc.bottom - px;
  else if (edge === ABE_LEFT) rc.right = rc.left + px;
  else if (edge === ABE_RIGHT) rc.left = rc.right - px;

  const data = newData(hwnd, { uEdge: edge, rc });
  SHAppBarMessage(ABM_QUERYPOS, data);

  // QUERYPOS only pushes the edge we are docking against; the opposite edge is
  // ours to set, so restore the requested thickness against the adjusted side.
  if (edge === ABE_TOP) data.rc.bottom = data.rc.top + px;
  else if (edge === ABE_BOTTOM) data.rc.top = data.rc.bottom - px;
  else if (edge === ABE_LEFT) data.rc.right = data.rc.left + px;
  else if (edge === ABE_RIGHT) data.rc.left = data.rc.right - px;

  SHAppBarMessage(ABM_SETPOS, data);
  return data.rc;
}

/**
 * Place the window on the strip the shell granted us.
 *
 * This deliberately bypasses win.setBounds(): Chromium clamps a top-level
 * window into the work area, and the reserved strip sits outside the work area
 * by construction, so setBounds lands the bar 64px too high every time.
 * SetWindowPos with SWP_NOSENDCHANGING skips that clamp.
 *
 * A frameless window's OS rect is taller than its visible rect (Windows keeps
 * an invisible resize border), so the difference is measured once and folded
 * into the placement — otherwise the visible bar sits inset from the strip.
 */
function applyBounds(rc) {
  if (!state || !rc || applying) return;
  const { win, hwnd } = state;
  applying = true;
  try {
    // Measure the gap between what Electron reports and what the OS sees, so
    // the visible content — not the invisible border box — fills the strip.
    const osRect = { left: 0, top: 0, right: 0, bottom: 0 };
    let insetX = 0;
    let insetY = 0;
    if (GetWindowRect(hwnd, osRect)) {
      const dip = win.getBounds();
      const scale = screen.getDisplayMatching(dip).scaleFactor || 1;
      insetX = ((osRect.right - osRect.left) - Math.round(dip.width * scale)) / 2;
      insetY = (osRect.bottom - osRect.top) - Math.round(dip.height * scale);
    }

    const x = Math.round(rc.left - insetX);
    const y = Math.round(rc.top);
    const cx = Math.round((rc.right - rc.left) + insetX * 2);
    const cy = Math.round((rc.bottom - rc.top) + insetY);

    lastRc = rc;
    placed = { x, y, cx, cy };
    SetWindowPos(hwnd, 0, x, y, cx, cy,
      SWP_NOZORDER | SWP_NOACTIVATE | SWP_SHOWWINDOW | SWP_NOSENDCHANGING);
  } finally {
    applying = false;
  }
}

/**
 * Put the window back on the strip if something moved it.
 *
 * Chromium is not aware of the SetWindowPos placement, so it periodically
 * restores the window to the geometry it thinks is current — most visibly
 * after each usage fetch, which re-asserts always-on-top. Comparing against
 * the rect we actually asked for keeps this from turning into a feedback loop:
 * if the window is already where it belongs, nothing happens.
 */
function reassertPlacement() {
  if (!state || !placed || applying) return;
  const now = { left: 0, top: 0, right: 0, bottom: 0 };
  if (!GetWindowRect(state.hwnd, now)) return;
  const drifted = now.left !== placed.x
    || now.top !== placed.y
    || (now.right - now.left) !== placed.cx
    || (now.bottom - now.top) !== placed.cy;
  if (!drifted) return;
  applying = true;
  try {
    SetWindowPos(state.hwnd, 0, placed.x, placed.y, placed.cx, placed.cy,
      SWP_NOZORDER | SWP_NOACTIVATE | SWP_SHOWWINDOW | SWP_NOSENDCHANGING);
  } finally {
    applying = false;
  }
}

function onShellNotification(wParam, opening) {
  if (!state) return;
  const code = Number(wParam);
  if (code === ABN_POSCHANGED || code === ABN_WINDOWARRANGE || code === ABN_STATECHANGE) {
    // The taskbar moved, changed size, or another appbar appeared — re-reserve.
    applyBounds(reservePosition());
  } else if (code === ABN_FULLSCREENAPP) {
    // A fullscreen app opened (lParam nonzero) or closed. The reservation stays;
    // only z-order changes, and main.js owns that.
    if (state.onFullscreen) state.onFullscreen(opening);
  }
}

/**
 * The foreground window, if it is on the bar's monitor — the fullscreen app
 * when ABN_FULLSCREENAPP has just said one opened. 0 otherwise, so fullscreen
 * video on the other monitor leaves the bar alone.
 */
function fullscreenWindowOnBarMonitor() {
  if (!state) return 0;
  try {
    const fg = Number(GetForegroundWindow());
    if (!fg || fg === state.hwnd) return 0;
    const MONITOR_DEFAULTTONEAREST = 2;
    return Number(MonitorFromWindow(fg, MONITOR_DEFAULTTONEAREST))
      === Number(MonitorFromWindow(state.hwnd, MONITOR_DEFAULTTONEAREST)) ? fg : 0;
  } catch {
    return 0;
  }
}

/** Put the bar directly behind `hwnd` in the z-order. */
function placeBehind(hwnd) {
  if (!state || !hwnd) return false;
  try {
    return !!SetWindowPos(state.hwnd, hwnd, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
  } catch {
    return false;
  }
}

function taskbarOnBarMonitor() {
  const MONITOR_DEFAULTTONEAREST = 2;
  const mon = Number(MonitorFromWindow(state.hwnd, MONITOR_DEFAULTTONEAREST));
  for (const cls of ['Shell_TrayWnd', 'Shell_SecondaryTrayWnd']) {
    let h = 0;
    while ((h = Number(FindWindowExW(0, h, cls, null)))) {
      if (Number(MonitorFromWindow(h, MONITOR_DEFAULTTONEAREST)) === mon) return h;
    }
  }
  return 0;
}

// Visible frame (no invisible resize border) of a shown, uncloaked window.
function visibleFrame(h) {
  const DWMWA_EXTENDED_FRAME_BOUNDS = 9, DWMWA_CLOAKED = 14;
  if (!IsWindowVisible(h)) return null;
  const cloaked = [0];
  if (DwmGetFlag(h, DWMWA_CLOAKED, cloaked, 4) === 0 && cloaked[0]) return null;
  const r = {};
  return DwmGetRect(h, DWMWA_EXTENDED_FRAME_BOUNDS, r, 16) === 0 ? r : null;
}

/**
 * Stack the bar the way the taskbar looks: behind a window only while that
 * window is in front of the taskbar AND covers the bar (e.g. dragged down over
 * it); in front otherwise. Plainly sitting behind the taskbar is not enough —
 * windows Windows puts in front of the taskbar often end right at the bar's
 * top edge, and their drop shadow lands on the bar.
 * `dragged` is a window being moved right now, which counts as covering.
 */
function settleZOrder(dragged = 0) {
  if (!state) return;
  try {
    const tb = taskbarOnBarMonitor();
    const bar = {};
    if (!tb || !GetWindowRect(state.hwnd, bar)) return;
    const GW_HWNDPREV = 3;
    let cover = 0;
    for (let h = Number(GetWindow(tb, GW_HWNDPREV)), i = 0; h && i < 1000; h = Number(GetWindow(h, GW_HWNDPREV)), i++) {
      if (h === state.hwnd) continue;
      const r = h === dragged ? bar : visibleFrame(h);
      if (r && r.left < bar.right && r.right > bar.left && r.top < bar.bottom && r.bottom > bar.top) cover = h;
    }
    state.covered = !!cover;
    placeBehind(cover || -1); // -1 = HWND_TOPMOST
  } catch {}
}

/** Whether settleZOrder() put the bar behind a window on purpose. */
function isCovered() {
  return !!(state && state.covered);
}

// --- Public API -------------------------------------------------------------

/** Whether docking is possible on this machine. */
function isSupported() {
  return ensureLoaded();
}

function isDocked() {
  return !!state;
}

/**
 * Dock `win` to a screen edge.
 * @param {BrowserWindow} win
 * @param {'top'|'bottom'|'left'|'right'} edgeName
 * @param {number} thickness Bar size in DIP (height for top/bottom).
 * @param {(opening: boolean) => void} [onFullscreen] ABN_FULLSCREENAPP handler.
 * @param {(dragged: number) => void} [onZOrder] Called when the foreground changes or a window drag starts/ends.
 * @returns {boolean} true if the appbar was registered
 */
function dock(win, edgeName = 'bottom', thickness = 34, onFullscreen = null, onZOrder = null) {
  if (!ensureLoaded()) return false;
  if (state) undock();

  const edge = EDGE_NAMES[edgeName];
  if (edge === undefined) throw new Error(`unknown edge: ${edgeName}`);

  const hwnd = hwndOf(win);
  const data = newData(hwnd, { uCallbackMessage: WM_APPBAR_CALLBACK });
  const ok = SHAppBarMessage(ABM_NEW, data);
  if (!ok) {
    console.error('[AppBar] ABM_NEW rejected by the shell');
    return false;
  }

  state = { win, hwnd, edge, thickness, onFullscreen, unhook: null };

  // The shell posts ABN_* codes here. Without this the bar would never notice
  // the taskbar moving and would end up overlapping it.
  win.hookWindowMessage(WM_APPBAR_CALLBACK, (wParam, lParam) => {
    try {
      onShellNotification(typeof wParam === 'bigint' ? wParam : Buffer.isBuffer(wParam) ? wParam.readUInt32LE(0) : wParam,
        Buffer.isBuffer(lParam) ? lParam.some((b) => b !== 0) : !!lParam);
    } catch (err) {
      console.error('[AppBar] notification handler failed:', err.message);
    }
  });
  // Chromium restores its own idea of the window geometry on resize/move, so
  // watch those and snap back. The listeners are removed on undock.
  const onDrift = () => reassertPlacement();
  win.on('resize', onDrift);
  win.on('move', onDrift);

  state.unhook = () => {
    try { win.unhookWindowMessage(WM_APPBAR_CALLBACK); } catch { /* window may be gone */ }
    try { win.removeListener('resize', onDrift); } catch { /* window may be gone */ }
    try { win.removeListener('move', onDrift); } catch { /* window may be gone */ }
  };

  applyBounds(reservePosition());

  // Windows reorders windows against the taskbar when the foreground changes,
  // and a dragged window can slide over the bar. The shell reports both, so
  // the bar's z-order is settled exactly then instead of on a timer.
  if (onZOrder) {
    try {
      const EVENT_SYSTEM_FOREGROUND = 3, EVENT_SYSTEM_MOVESIZESTART = 0x0A, EVENT_SYSTEM_MOVESIZEEND = 0x0B;
      const WINEVENT_SKIPOWNPROCESS = 2;
      const cb = koffi.register((hook, event, hwnd) => onZOrder(event === EVENT_SYSTEM_MOVESIZESTART ? Number(hwnd) : 0),
        koffi.pointer(WinEventProc));
      const hooks = [
        SetWinEventHook(EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND, 0, cb, 0, 0, WINEVENT_SKIPOWNPROCESS),
        SetWinEventHook(EVENT_SYSTEM_MOVESIZESTART, EVENT_SYSTEM_MOVESIZEEND, 0, cb, 0, 0, WINEVENT_SKIPOWNPROCESS),
      ];
      state.foregroundHook = () => { hooks.forEach((h) => UnhookWinEvent(h)); koffi.unregister(cb); };
    } catch (err) {
      console.error('[AppBar] z-order hooks failed:', err.message);
    }
  }

  // Tell the shell the window is live so it participates in z-order correctly.
  SHAppBarMessage(ABM_ACTIVATE, newData(hwnd, { lParam: 1 }));
  SHAppBarMessage(ABM_WINDOWPOSCHANGED, newData(hwnd));

  // A closed window that never unregisters leaks the reserved strip.
  win.once('closed', () => { if (state && state.win === win) forceRemove(); });
  return true;
}

/** Release the reserved space and restore the window to a normal floating one. */
function undock() {
  if (!state) return;
  const { hwnd, unhook, foregroundHook } = state;
  if (unhook) unhook();
  if (foregroundHook) foregroundHook();
  try {
    SHAppBarMessage(ABM_REMOVE, newData(hwnd));
  } catch (err) {
    console.error('[AppBar] ABM_REMOVE failed:', err.message);
  }
  state = null;
  lastRc = null;
  placed = null;
}

/** undock() without touching the (already destroyed) window. */
function forceRemove() {
  if (!state) return;
  if (state.foregroundHook) state.foregroundHook();
  try {
    SHAppBarMessage(ABM_REMOVE, newData(state.hwnd));
  } catch { /* nothing left to do */ }
  state = null;
  lastRc = null;
  placed = null;
}

/** Where the taskbar currently is — useful for choosing a sensible edge. */
function getTaskbarInfo() {
  if (!ensureLoaded()) return null;
  const data = newData(0);
  const ok = SHAppBarMessage(ABM_GETTASKBARPOS, data);
  if (!ok) return null;
  const names = ['left', 'top', 'right', 'bottom'];
  return { edge: names[data.uEdge] || 'bottom', rect: data.rc };
}

module.exports = {
  dock, undock, forceRemove, isDocked, isSupported, getTaskbarInfo,
  fullscreenWindowOnBarMonitor, placeBehind, settleZOrder, isCovered,
};
