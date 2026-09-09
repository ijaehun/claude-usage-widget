'use strict';

/**
 * tray-flyout.js
 *
 * Watches the Windows notification-area overflow flyout — the panel that opens
 * from the taskbar's "show hidden icons" chevron — and reports when it is on
 * screen.
 *
 * Why the docked bar needs to know:
 *
 * The bar is always-on-top so that nothing paints over it. The flyout is a
 * plain NON-topmost window, and a topmost window sits in front of every
 * non-topmost one regardless of the z-order between them, so while the bar
 * holds WS_EX_TOPMOST the flyout can never come forward. It also opens
 * directly over the reserved strip, so this is not theoretical: the flyout is
 * simply hidden behind the bar.
 *
 * Giving up always-on-top for good is not a good trade either. A maximized
 * window stops at the reservation, which puts its bottom edge in the middle of
 * the screen, and Windows draws that window's drop shadow below the edge —
 * straight onto the bar. Measured, focusing such a window took the strip from
 * a flat 243 to a 174..225 gradient across its whole 34px height.
 *
 * So the bar stays topmost and steps aside only while the flyout is actually
 * open. That needs a signal, and there is no notification for it — hence this
 * poll.
 *
 * The interval is the dodge's worst-case latency: until a tick notices, the
 * bar is still covering a flyout that has already opened, which reads as the
 * panel arriving and then being uncovered a moment later. 200ms was visible
 * as exactly that. A tick was measured at 4.53us with the flyout closed, the
 * common case, so 40ms costs 0.011% of one core — the latency is worth far
 * more than the cycles.
 *
 * Windows-only; every entry point is a no-op elsewhere.
 *
 * DEGRADES SAFELY. The flyout is identified by window class, and the class
 * name is a Windows implementation detail that has already changed once
 * between 10 and 11. If none of the known classes exist, `start()` reports
 * unsupported and never fires, and the caller simply stays topmost — the
 * behaviour this module exists to improve on, not something worse.
 */

const POLL_MS = 40;

// SetWindowPos flags: change z-order only.
const SWP_NOSIZE = 0x0001;
const SWP_NOMOVE = 0x0002;
const SWP_NOACTIVATE = 0x0010;

// Win11 hosts the flyout in a XAML island; Win10 used a plain window. Both are
// looked up every tick because the window may not exist until first opened.
const FLYOUT_CLASSES = [
  'TopLevelWindowForOverflowXamlIsland', // Windows 11
  'NotifyIconOverflowWindow',            // Windows 10
];

let koffi = null;
let FindWindowExW = null;
let IsWindowVisible = null;
let SetWindowPos = null;
let loadError = null;

let timer = null;
let lastOpen = false;
let listener = null;
let matchedClass = null;
let barHwnd = 0;

function ensureLoaded() {
  if (FindWindowExW || loadError) return !loadError;
  if (process.platform !== 'win32') {
    loadError = 'not windows';
    return false;
  }
  try {
    koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    // FindWindowEx rather than FindWindow: passing the previous match as
    // hwndChildAfter walks EVERY top-level window of the class. FindWindow
    // returns only the first, and on a multi-monitor setup more than one
    // window of this class exists — picking the wrong one means missing the
    // open flyout entirely. That was observed: two independent watchers using
    // FindWindow disagreed about the same flyout.
    FindWindowExW = user32.func(
      'uintptr_t __stdcall FindWindowExW(uintptr_t hWndParent, uintptr_t hWndChildAfter, str16 lpszClass, str16 lpszWindow)'
    );
    IsWindowVisible = user32.func(
      'bool __stdcall IsWindowVisible(uintptr_t hWnd)'
    );
    SetWindowPos = user32.func(
      'bool __stdcall SetWindowPos(uintptr_t hWnd, uintptr_t hWndInsertAfter, int X, int Y, int cx, int cy, uint32 uFlags)'
    );
    return true;
  } catch (err) {
    loadError = err.message;
    console.error('[TrayFlyout] FFI unavailable, flyout dodging disabled:', err.message);
    return false;
  }
}

/** True while the overflow flyout is on screen. */
function isOpen() {
  if (!ensureLoaded()) return false;
  for (const cls of FLYOUT_CLASSES) {
    let hwnd = 0;
    try {
      // Walk every window of the class; any visible one means it is open.
      // The bound is paranoia against a driver that never terminates the walk.
      for (let i = 0; i < 32; i++) {
        hwnd = FindWindowExW(0, hwnd, cls, null);
        if (!hwnd) break;
        matchedClass = cls;
        if (IsWindowVisible(hwnd)) return true;
      }
    } catch {
      continue;
    }
  }
  return false;
}

/** HWND of the flyout window that is currently on screen, or 0. */
function openHwnd() {
  if (!ensureLoaded()) return 0;
  for (const cls of FLYOUT_CLASSES) {
    let hwnd = 0;
    try {
      for (let i = 0; i < 32; i++) {
        hwnd = FindWindowExW(0, hwnd, cls, null);
        if (!hwnd) break;
        if (IsWindowVisible(hwnd)) return hwnd;
      }
    } catch {
      continue;
    }
  }
  return 0;
}

/**
 * Put `barHwnd` immediately behind the open flyout.
 *
 * Clearing the topmost flag is NOT enough on its own, and this is the whole
 * reason this function exists. SetWindowPos(HWND_NOTOPMOST) — which is what
 * setAlwaysOnTop(false) issues — moves the window to the FRONT of the
 * non-topmost band, not to where it happens to belong. Measured: a topmost bar
 * at z=79 with an ordinary window at z=105 landed at z=101 after giving up
 * topmost, still ahead of it. The bar went on covering the flyout exactly as
 * before, which is what made the first attempt at this look like a no-op.
 *
 * Inserting after the flyout HWND is deliberate, rather than HWND_BOTTOM: the
 * bottom of the z-order is below the desktop shell windows, which would make
 * the bar vanish outright for as long as the flyout is up.
 *
 * @returns {boolean} true if a flyout was found and the bar was placed.
 */
function stepAside(barHwnd) {
  if (!ensureLoaded() || !barHwnd) return false;
  const fly = openHwnd();
  if (!fly) return false;
  try {
    return !!SetWindowPos(barHwnd, fly, 0, 0, 0, 0,
      SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
  } catch {
    return false;
  }
}

/**
 * Begin watching. `onChange(open)` fires only on transitions, never on every
 * tick, so the caller can treat it as an edge.
 *
 * @param {(open: boolean) => void} onChange
 * @param {number} hwnd HWND of the bar, re-placed behind the flyout on every
 *   tick it stays open. Re-placing matters because the flyout window is not
 *   persistent — it is created and destroyed around each use — so a placement
 *   made once against one HWND does not hold for its replacement.
 * @returns {boolean} false when the platform or the FFI cannot support this,
 *   in which case onChange is never called.
 */
function start(onChange, hwnd) {
  if (!ensureLoaded()) return false;
  stop();
  listener = onChange;
  barHwnd = hwnd || 0;
  lastOpen = false;
  timer = setInterval(() => {
    let open;
    try {
      open = isOpen();
    } catch (err) {
      // A transient failure must not kill the watch, but it must not leave the
      // caller stuck out of the way either: report closed and carry on.
      open = false;
    }
    if (open === lastOpen) {
      // Hold the position rather than re-issuing setAlwaysOnTop, which would
      // bounce us back to the front of the non-topmost band every tick.
      if (open) stepAside(barHwnd);
      return;
    }
    lastOpen = open;
    if (listener) listener(open);
  }, POLL_MS);
  if (timer.unref) timer.unref();
  return true;
}

/** Stop watching. Reports closed first if we were mid-dodge, so the caller is
 * never left stepped aside with nothing coming to put it back. */
function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (lastOpen && listener) {
    lastOpen = false;
    listener(false);
  }
  listener = null;
  barHwnd = 0;
}

/** Which class actually matched, for the debug log. Null until one is seen. */
function matched() {
  return matchedClass;
}

module.exports = { start, stop, isOpen, openHwnd, stepAside, matched };
