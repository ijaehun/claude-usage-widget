'use strict';

/**
 * status-panel.js
 *
 * The click-toggled detail popup for the service-status indicator.
 *
 * Why a separate BrowserWindow at all: while docked, the main window is only
 * BAR_HEIGHT (34px) tall, so a panel cannot be drawn inside it. Growing the
 * window is not an option either — every geometry-mutating path no-ops while
 * docked, and fighting the appbar reservation is exactly the mess `appbar.js`
 * exists to avoid. A second window sidesteps all of it, and the same window
 * then serves the widget and compact views so there is only one panel to
 * maintain.
 *
 * Created on open and destroyed on close, rather than kept hidden. A parked
 * BrowserWindow costs a renderer process for the app's whole lifetime, which
 * would undo a chunk of the resource trimming this fork exists for; the panel
 * is an occasional thing. If the ~100ms open ever feels slow, keeping it alive
 * is a change to `close()` alone.
 */

const { BrowserWindow, screen } = require('electron');
const path = require('path');
const { fadeWindow } = require('./window-fade');

const PANEL_WIDTH = 296;
// Space between the anchor element and the panel edge.
const GAP = 6;
// Bounds for the measured content height, so a broken measurement cannot
// produce a 1px sliver or a full-screen window.
const MIN_HEIGHT = 90;
const MAX_HEIGHT = 460;
// A click on the indicator while the panel is open arrives *after* the panel's
// own blur has already closed it. Without this guard the pair reads as
// close-then-open and the panel never appears to toggle off.
const REOPEN_GUARD_MS = 250;

// Fade durations. Short on the way in so the panel still feels like it answers
// the click instantly, a touch longer on the way out because a dismissal is
// the part that reads as abrupt when it is instant.
const FADE_IN_MS = 110;
const FADE_OUT_MS = 160;

let panel = null;
let closedAt = 0;

function isOpen() {
  return !!panel && !panel.isDestroyed();
}

/**
 * Screen rect for the panel, given where the indicator is.
 *
 * The anchor arrives in the parent window's CSS pixels. Electron works in
 * DIPs throughout on Windows, and the widget never sets a zoom factor, so
 * CSS px and the parent's content bounds share one coordinate space — no
 * scaleFactor arithmetic, which is what makes this correct on the 125%
 * secondary display too.
 */
function placement(parentWindow, anchor, height) {
  const pb = parentWindow.getContentBounds();
  const ax = pb.x + anchor.x;
  const ay = pb.y + anchor.y;

  const area = screen.getDisplayNearestPoint({ x: Math.round(ax), y: Math.round(ay) }).workArea;

  let x = Math.round(ax + anchor.width / 2 - PANEL_WIDTH / 2);
  x = Math.max(area.x, Math.min(x, area.x + area.width - PANEL_WIDTH));

  // Above the anchor by preference. A docked bar sits outside the work area by
  // definition, so "above" is where the room always is; the flip below covers
  // the widget sitting near the top of the screen.
  let y = Math.round(ay - height - GAP);
  if (y < area.y) y = Math.round(ay + anchor.height + GAP);
  y = Math.max(area.y, Math.min(y, area.y + area.height - height));

  return { x, y, width: PANEL_WIDTH, height };
}

/**
 * Show the panel anchored to an element in the parent window.
 * @param {BrowserWindow} parentWindow
 * @param {{x: number, y: number, width: number, height: number}} anchor - in parent CSS px
 * @param {'light'|'dark'} theme
 */
async function open(parentWindow, anchor, theme) {
  if (!parentWindow || parentWindow.isDestroyed()) return;
  close();

  panel = new BrowserWindow({
    // Owned by the widget window. That is the Windows idiom for a popup: it
    // stays above its owner, and it cannot outlive it — which is what stops an
    // orphaned panel from holding the process open.
    parent: parentWindow,
    width: PANEL_WIDTH,
    height: MIN_HEIGHT,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, '..', 'preload-status.js'),
    },
  });

  // Above the main window, which is itself always-on-top. The pop-up-menu
  // level is what the shell uses for exactly this kind of transient surface.
  panel.setAlwaysOnTop(true, 'pop-up-menu');

  const local = panel;
  local.on('blur', () => {
    // Clicking anywhere else dismisses it — the behaviour every other popup on
    // the desktop has.
    dismiss();
  });
  local.on('closed', () => {
    if (panel === local) panel = null;
  });

  const url = `file://${path.join(__dirname, 'renderer', 'status-panel.html')}` +
    `?theme=${theme === 'light' ? 'light' : 'dark'}`;
  await local.loadURL(url);
  if (local.isDestroyed()) return;

  // The panel's height depends on how many incidents there are, so it is
  // measured rather than guessed, and applied before the first paint the user
  // sees — a popup that resizes after appearing reads as a glitch.
  //
  // Measured behind window.__panelReady, not on load: the page fills itself
  // from an async IPC read, and `loadURL` resolves before that lands. Measuring
  // any earlier reads the height of an empty shell.
  let height = MIN_HEIGHT;
  try {
    const measured = await local.webContents.executeJavaScript(
      'window.__panelReady.then(() => document.getElementById("panel").getBoundingClientRect().height)'
    );
    if (Number.isFinite(measured) && measured > 0) {
      height = Math.round(Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, measured)));
    }
  } catch {
    // Keep MIN_HEIGHT — a panel slightly too short still beats no panel.
  }
  if (local.isDestroyed()) return;

  local.setBounds(placement(parentWindow, anchor, height));
  // Shown fully transparent, so the window appears via the fade rather than
  // popping in at full opacity for one frame first.
  local.setOpacity(0);
  local.show();
  // The main window is itself always-on-top; moveTop puts the panel above it
  // rather than trusting creation order for the z-order.
  local.moveTop();
  local.focus();
  await fadeWindow(local, 0, 1, FADE_IN_MS);
}

/**
 * Tear the panel down immediately. For the teardown paths — quit, the parent
 * window closing, the anchor about to move — where waiting on an animation
 * would mean holding up a process that is trying to exit.
 */
function close() {
  if (isOpen()) {
    const local = panel;
    panel = null;
    local.destroy();
  } else {
    panel = null;
  }
}

/**
 * Fade out, then tear down. This is the user-facing close: blur, a second click
 * on the indicator, Esc, or following the link.
 *
 * `panel` is detached up front, so for every purpose that matters — isOpen(),
 * the next toggle — the panel is already gone while the pixels are still on
 * their way out. Input is dropped for the same reason: a window mid-dismissal
 * must not answer a click.
 */
function dismiss() {
  if (!isOpen()) {
    panel = null;
    return;
  }
  const local = panel;
  panel = null;
  closedAt = Date.now();
  local.setIgnoreMouseEvents(true);
  fadeWindow(local, local.getOpacity(), 0, FADE_OUT_MS).then(() => {
    if (!local.isDestroyed()) local.destroy();
  });
}

/**
 * Open, or close if it is already showing. Returns whether the panel is open
 * afterwards, so the renderer can reflect the state on the indicator.
 */
async function toggle(parentWindow, anchor, theme) {
  if (isOpen()) {
    dismiss();
    return false;
  }
  // Distinguish a real second click from the click that just dismissed the
  // panel via blur.
  if (Date.now() - closedAt < REOPEN_GUARD_MS) return false;
  await open(parentWindow, anchor, theme);
  return isOpen();
}

module.exports = { toggle, close, dismiss, isOpen };
