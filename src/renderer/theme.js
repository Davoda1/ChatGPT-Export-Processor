'use strict';
// Apply the last explicit appearance choice before the first paint.
// This cache contains appearance only; authoritative preferences belong to the app.
(() => {
  let selected = 'system';
  try { selected = localStorage.getItem('processor.appearance') || 'system'; } catch {}
  if (!['system', 'light', 'dark'].includes(selected)) selected = 'system';
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.dataset.theme = selected === 'system' ? (dark ? 'dark' : 'light') : selected;
})();
