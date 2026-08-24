'use strict';

/**
 * window-fade.js
 *
 * Alpha ramps for BrowserWindows, shared by the widget and the status panel.
 *
 * Driven from the main process on a timer rather than by a CSS transition in
 * the page. Window alpha needs no cooperation from the renderer, so nothing has
 * to survive an IPC round-trip while the window is being torn down — which is
 * exactly when a fade-out runs.
 *
 * Works on the widget's `transparent: true` windows: both transparency and
 * opacity go through the same layered-window path on Windows.
 */

// Animation cadence — roughly one frame at 60Hz.
const TICK_MS = 16;

/**
 * Ramp a window's opacity from one value to another.
 *
 * Resolves early if the window dies mid-fade (the normal case when a dismissal
 * overlaps a quit) or if a newer fade takes over the same window.
 *
 * @param {Electron.BrowserWindow} win
 * @param {number} from 0-1
 * @param {number} to 0-1
 * @param {number} ms duration
 * @returns {Promise<void>}
 */
function fadeWindow(win, from, to, ms) {
  return new Promise((resolve) => {
    if (!win || win.isDestroyed()) return resolve();

    // Two fades can overlap — click the trigger twice quickly and both would be
    // driving the same window's alpha, which shows up as a flicker. Newest
    // wins; older ones notice the token moved and bail.
    const seq = (win.__fadeSeq || 0) + 1;
    win.__fadeSeq = seq;

    win.setOpacity(from);
    const start = Date.now();

    const tick = () => {
      if (!win || win.isDestroyed() || win.__fadeSeq !== seq) return resolve();
      const t = Math.min(1, (Date.now() - start) / ms);
      // Smoothstep — eased at both ends. A plain ease-out spends its first frame
      // dropping halfway, which reads as a snap followed by a lingering ghost
      // rather than a fade; easing the start too is what makes it look gradual.
      const eased = t * t * (3 - 2 * t);
      win.setOpacity(from + (to - from) * eased);
      if (t >= 1) return resolve();
      setTimeout(tick, TICK_MS);
    };
    setTimeout(tick, TICK_MS);
  });
}

module.exports = { fadeWindow };
