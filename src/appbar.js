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

function onShellNotification(wParam) {
  if (!state) return;
  const code = Number(wParam);
  if (code === ABN_POSCHANGED || code === ABN_WINDOWARRANGE || code === ABN_STATECHANGE) {
    // The taskbar moved, changed size, or another appbar appeared — re-reserve.
    applyBounds(reservePosition());
  } else if (code === ABN_FULLSCREENAPP) {
    // A fullscreen app took over. Nothing to do: leaving the reservation in
    // place is correct, and fighting for z-order here only causes flicker.
  }
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
 * @returns {boolean} true if the appbar was registered
 */
function dock(win, edgeName = 'bottom', thickness = 34) {
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

  state = { win, hwnd, edge, thickness, unhook: null };

  // The shell posts ABN_* codes here. Without this the bar would never notice
  // the taskbar moving and would end up overlapping it.
  win.hookWindowMessage(WM_APPBAR_CALLBACK, (wParam) => {
    try {
      onShellNotification(typeof wParam === 'bigint' ? wParam : Buffer.isBuffer(wParam) ? wParam.readUInt32LE(0) : wParam);
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
  const { hwnd, unhook } = state;
  if (unhook) unhook();
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

module.exports = { dock, undock, forceRemove, isDocked, isSupported, getTaskbarInfo };
