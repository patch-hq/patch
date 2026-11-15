// Point the download buttons at the build for the visitor's OS.
(function () {
  var BASE = 'https://github.com/patch-hq/patch/releases/latest/download/';
  var BUILDS = {
    mac: { label: 'Download for Mac', file: 'Patch-mac-arm64.dmg' },
    linux: { label: 'Download for Linux', file: 'Patch-linux-x86_64.AppImage' },
  };
  // What to do once each file has downloaded, shown after its link is clicked.
  var NEXT = {
    'Patch-mac-arm64.dmg': 'Open the disk image and drag Patch to Applications.',
    'Patch-mac-arm64.zip': 'Open the zip and drag Patch to Applications.',
    'Patch-linux-x86_64.AppImage': 'Make the AppImage executable, then open it.',
    'Patch-android.apk': 'Open the downloaded file to install Patch.',
  };
  var UNAVAILABLE = {
    ios: 'Download it on a Mac or Linux computer, or install it on your own server.',
    windows: 'No Windows app yet. Install Patch on your own server instead.',
  };

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
      // Phones, Windows and anything unrecognised pick from the list below.
      a.hidden = true;
    }
  });
  // Without a build for this device, the hero points to Get started instead.
  document.querySelectorAll('[data-no-build]').forEach(function (a) {
    a.hidden = Boolean(build);
  });
  document.querySelectorAll('[data-build-only]').forEach(function (a) {
    a.hidden = !build;
  });
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

  // After a download starts, one line on what to do with the file, under every
  // download button so it is beside whichever was clicked.
  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('a[href^="' + BASE + '"]');
    if (!a) return;
    var line = NEXT[a.getAttribute('href').slice(BASE.length)];
    if (!line) return;
    document.querySelectorAll('[data-next]').forEach(function (p) {
      p.textContent = line;
      p.hidden = false;
    });
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

  // "and more", and "See everything": a button that shows the panel it names.
  document.querySelectorAll('[data-more], [data-see-all]').forEach(function (btn) {
    var panel = document.getElementById(btn.getAttribute('aria-controls'));
    btn.addEventListener('click', function () {
      var open = btn.getAttribute('aria-expanded') !== 'true';
      btn.setAttribute('aria-expanded', String(open));
      panel.hidden = !open;
      if (btn.hasAttribute('data-see-all')) btn.textContent = open ? 'Show less' : 'See everything';
    });
  });

  // The clips: the light or dark recording to match the page, loaded only when
  // one comes near the screen, playing only while it is on it. With reduced
  // motion they stay on their poster.
  var dark = window.matchMedia('(prefers-color-scheme: dark)');
  var still = window.matchMedia('(prefers-reduced-motion: reduce)');
  var narrow = window.matchMedia('(max-width: 640px)');
  var videos = Array.prototype.slice.call(document.querySelectorAll('video[data-video]'));

  function theme() {
    return dark.matches ? 'dark' : 'light';
  }

  function dress(video, withSources) {
    // Phones get a smaller cut of each clip; some are cropped to what matters.
    var phone = narrow.matches;
    var name = 'vid/' + video.dataset.video + '-' + theme() + (phone ? '-phone' : '');
    video.style.aspectRatio = (phone && video.dataset.phoneRatio) || '';
    video.poster = name + '-poster.webp';
    if (!withSources) return;
    if (video.dataset.loaded === name) return;
    video.dataset.loaded = name;
    // H.264 only: every browser plays it, and Chrome failed to decode the VP9
    // WebM versions intermittently on this page.
    video.src = name + '.mp4';
  }

  videos.forEach(function (v) {
    dress(v, false);
    v.addEventListener(
      'error',
      function () {
        console.error('Patch: clip failed to load:', v.dataset.video);
      },
      true,
    );
  });

  var onScreen = new Set();
  function update(video) {
    if (still.matches || !onScreen.has(video)) {
      video.pause();
      return;
    }
    dress(video, true);
    var playing = video.play();
    if (playing && playing.catch) {
      playing.catch(function (err) {
        // Scrolling past before it starts pauses it first: not a failure.
        if (err.name === 'AbortError') return;
        console.error('Patch: clip would not play:', video.dataset.video, err);
      });
    }
  }

  var seen = new IntersectionObserver(
    function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) onScreen.add(e.target);
        else onScreen.delete(e.target);
        update(e.target);
      });
    },
    { threshold: 0.35 },
  );
  videos.forEach(function (v) {
    seen.observe(v);
  });
  function redress() {
    videos.forEach(function (v) {
      dress(v, Boolean(v.dataset.loaded));
      update(v);
    });
  }
  dark.addEventListener('change', redress);
  narrow.addEventListener('change', redress);
  still.addEventListener('change', redress);
})();
