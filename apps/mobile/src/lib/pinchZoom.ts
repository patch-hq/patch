// Injected into the artifact and Pad WebViews so pages that ship a fixed
// viewport (or user-scalable=no) can still be pinch-zoomed. Runs before the
// page content loads and again on load, since a page may add its own meta late.
export const PINCH_ZOOM_JS = `(function () {
  var CONTENT = 'width=device-width, initial-scale=1, minimum-scale=1, maximum-scale=10, user-scalable=yes';
  function apply() {
    var m = document.querySelector('meta[name="viewport"]');
    if (!m) {
      m = document.createElement('meta');
      m.name = 'viewport';
      (document.head || document.documentElement).appendChild(m);
    }
    if (m.getAttribute('content') !== CONTENT) m.setAttribute('content', CONTENT);
  }
  apply();
  document.addEventListener('DOMContentLoaded', apply);
  window.addEventListener('load', apply);
})(); true;`;
