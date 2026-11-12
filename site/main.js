// Point the download buttons at the build for the visitor's OS.
(function () {
  var BASE = 'https://github.com/patch-hq/patch/releases/latest/download/';
  var BUILDS = {
    mac: { label: 'Download for Mac', file: 'Patch-mac-arm64.dmg' },
    linux: { label: 'Download for Linux', file: 'Patch-linux-x86_64.AppImage' },
    android: { label: 'Download for Android', file: 'Patch-android.apk' },
  };
  var UNAVAILABLE = { ios: 'Not on iPhone yet', windows: 'Not on Windows' };

  function detect() {
    var ua = navigator.userAgent || '';
    var platform =
      (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '';
    if (/android/i.test(ua)) return 'android';
    if (/iphone|ipad|ipod/i.test(ua)) return 'ios';
    // iPadOS reports itself as a Mac; a touch screen gives it away.
    if (/mac/i.test(platform) || /macintosh/i.test(ua)) {
      return navigator.maxTouchPoints > 1 ? 'ios' : 'mac';
    }
    if (/win/i.test(platform) || /windows/i.test(ua)) return 'windows';
    if (/linux|x11|cros/i.test(platform + ' ' + ua)) return 'linux';
    return null;
  }

  var os = detect();
  document.documentElement.dataset.os = os || 'unknown';
  var build = os && BUILDS[os];
  document.querySelectorAll('[data-download]').forEach(function (a) {
    if (build) {
      a.textContent = build.label;
      a.href = BASE + build.file;
      a.dataset.file = build.file;
    } else {
      a.textContent = 'Choose a platform';
      a.href = '#platforms';
    }
  });
  if (!build) {
    var all = document.querySelector('[data-all-platforms]');
    if (all) all.hidden = true;
  }
  if (os) {
    var row = document.querySelector('.platforms [data-os="' + os + '"]');
    if (row) row.classList.add('current');
  }
  var note = document.querySelector('[data-detected]');
  if (note && os && UNAVAILABLE[os]) {
    note.textContent = UNAVAILABLE[os];
    note.hidden = false;
  }

  // Download sizes, from the release the links above resolve to. A failed
  // lookup leaves the sizes off and says why in the console.
  fetch('https://api.github.com/repos/patch-hq/patch/releases/latest')
    .then(function (r) {
      if (!r.ok) throw new Error('GitHub answered ' + r.status);
      return r.json();
    })
    .then(function (release) {
      var sizes = {};
      release.assets.forEach(function (asset) {
        sizes[asset.name] = asset.size;
      });
      function mb(name) {
        if (!sizes[name]) throw new Error('the latest release has no ' + name);
        return Math.round(sizes[name] / 1e6) + ' MB';
      }
      document.querySelectorAll('[data-size]').forEach(function (el) {
        el.textContent = ' · ' + mb(el.dataset.size);
      });
      document.querySelectorAll('[data-download][data-file]').forEach(function (a) {
        var size = document.createElement('span');
        size.className = 'btn-size';
        size.textContent = mb(a.dataset.file);
        a.appendChild(size);
      });
    })
    .catch(function (err) {
      console.error('Patch: download sizes unavailable:', err);
    });

  document.querySelectorAll('[data-copy]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var text = document.getElementById(btn.dataset.copy).textContent;
      navigator.clipboard.writeText(text).then(
        function () {
          btn.textContent = 'Copied';
          setTimeout(function () {
            btn.textContent = 'Copy';
          }, 1600);
        },
        function () {
          btn.textContent = 'Copy failed';
        },
      );
    });
  });
})();
