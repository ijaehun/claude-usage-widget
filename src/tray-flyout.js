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
 * poll. The work per tick is a FindWindow plus an IsWindowVisible, both
 * O(microseconds), which is why 200ms is affordable.
 *
 * Windows-only; every entry point is a no-op elsewhere.
 *
 * DEGRADES SAFELY. The flyout is identified by window class, and the class
 * name is a Windows implementation detail that has already changed once
 * between 10 and 11. If none of the known classes exist, `start()` reports
 * unsupported and never fires, and the caller simply stays topmost — the
 * behaviour this module exists to improve on, not something worse.
 */

const POLL_MS = 200;

// Win11 hosts the flyout in a XAML island; Win10 used a plain window. Both are
// looked up every tick because the window may not exist until first opened.
const FLYOUT_CLASSES = [
  'TopLevelWindowForOverflowXamlIsland', // Windows 11
  'NotifyIconOverflowWindow',            // Windows 10
];

let koffi = null;
let FindWindowExW = null;
let IsWindowVisible = null;
let loadError = null;

let timer = null;
let lastOpen = false;
let listener = null;
let matchedClass = null;

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

/**
 * Begin watching. `onChange(open)` fires only on transitions, never on every
 * tick, so the caller can treat it as an edge.
 *
 * @param {(open: boolean) => void} onChange
 * @returns {boolean} false when the platform or the FFI cannot support this,
 *   in which case onChange is never called.
 */
function start(onChange) {
  if (!ensureLoaded()) return false;
  stop();
  listener = onChange;
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
    if (open === lastOpen) return;
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
}

/** Which class actually matched, for the debug log. Null until one is seen. */
function matched() {
  return matchedClass;
}

module.exports = { start, stop, isOpen, matched };
