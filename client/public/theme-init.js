// Theme bootstrap — runs before first paint to avoid a light/dark flash.
// Preference is 'light' | 'dark' | 'system' under localStorage key 'vite-ui-theme';
// 'system' follows the OS scheme, and any missing/invalid value defaults dark
// (dark-first). Kept as its own file (not inline in index.html) so the server's
// Content-Security-Policy can be `script-src 'self'` — see server/src/app.ts.
(function () {
  function prefersDark() {
    return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  }
  var dark = true; // dark-first default when nothing valid is stored
  try {
    var t = localStorage.getItem('vite-ui-theme');
    if (t === 'light') dark = false;
    else if (t === 'dark') dark = true;
    else if (t === 'system') dark = prefersDark();
  } catch (e) { /* localStorage unavailable */ }
  var el = document.documentElement;
  try {
    var colorway = localStorage.getItem('ci-planning-colorway');
    el.dataset.colorway = colorway === 'cool' || colorway === 'collected' ? colorway : 'calm';
  } catch (e) { el.dataset.colorway = 'calm'; }
  el.classList.toggle('dark', dark);
  el.classList.toggle('light', !dark);
  try {
    var textSize = localStorage.getItem('ci-planning-text-size');
    el.dataset.textSize = textSize === 'large' || textSize === 'larger' ? textSize : 'default';
  } catch (e) { el.dataset.textSize = 'default'; }
})();
