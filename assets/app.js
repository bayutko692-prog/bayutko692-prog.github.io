/* MaskPhish — web port
 * 100% client-side. No backend, no analytics, no telemetry.
 * The target URL is sent directly from the browser to the shortener.
 */
(function () {
  'use strict';

  /* ------------------------------------------------------------------ *
   * Shortener providers.
   * Every provider supports a CUSTOM ALIAS, which is what makes this
   * work without a backend: the browser picks the alias up-front, so it
   * already knows the final short URL before the request is even sent.
   * The create request is then fired with mode:'no-cors' (a simple GET,
   * no preflight) and the response body is simply ignored.
   * ------------------------------------------------------------------ */
  var PROVIDERS = [
    { id: 'is.gd', host: 'is.gd',   create: 'https://is.gd/create.php' },
    { id: 'v.gd',  host: 'v.gd',    create: 'https://v.gd/create.php' },
    { id: 'da.gd', host: 'da.gd',   create: 'https://da.gd/shorturl' }
  ];

  var ALIAS_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';
  var MAX_ALIAS_ATTEMPTS = 3;   // per provider
  var MAX_PROVIDERS = 2;        // is.gd then v.gd
  var VERIFY_TRIES = 6;
  var VERIFY_DELAY = 900;       // ms
  var HIST_KEY = 'maskphish.history.v1';

  /* ---------------------------- helpers ---------------------------- */

  function $(id) { return document.getElementById(id); }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function randAlias(n) {
    var out = '', bytes = new Uint8Array(n), i;
    if (window.crypto && window.crypto.getRandomValues) {
      window.crypto.getRandomValues(bytes);
    } else {
      for (i = 0; i < n; i++) bytes[i] = Math.floor(Math.random() * 256);
    }
    for (i = 0; i < n; i++) out += ALIAS_CHARS[bytes[i] % ALIAS_CHARS.length];
    return out;
  }

  function normalizeHttpUrl(raw) {
    var v = String(raw || '').trim();
    if (!v) return null;
    if (!/^https?:\/\//i.test(v)) v = 'https://' + v;
    try {
      var u = new URL(v);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
      return u;
    } catch (e) { return null; }
  }

  function setStatus(msg, kind) {
    var el = $('status');
    el.textContent = msg || '';
    el.className = 'status' + (kind ? ' ' + kind : '');
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* --------------------- the actual masking ------------------------- */

  /**
   * Build the masked URL exactly the way the original maskphish.sh does:
   *   <mask-domain>[-<words>]@<short-host>/<alias>
   * The segment before '@' is URL user-info, so browsers display only
   * the real host while the string itself reads like the mask domain.
   */
  function buildMaskedUrl(maskRaw, words, host, alias) {
    var mask = String(maskRaw).trim().replace(/\/+$/, '');
    if (words) mask += '-' + words;
    return mask + '@' + host + '/' + alias;
  }

  /**
   * Create a short URL with a chosen alias. Fire-and-forget: the request
   * is sent, the body is ignored (cross-origin, no CORS headers on the
   * shortener — hence no-cors mode).
   */
  function createShort(provider, alias, targetUrl) {
    // encodeURIComponent on the target fixes the classic maskphish bug
    // where "?a=1&b=2" got truncated at the '&'.
    var qs = 'format=simple&shorturl=' + encodeURIComponent(alias) +
              '&url=' + encodeURIComponent(targetUrl);
    var sep = provider.create.indexOf('?') === -1 ? '?' : '&';
    var url = provider.create + sep + qs;

    return fetch(url, { mode: 'no-cors', cache: 'no-store', credentials: 'omit' })
      .then(function () { return true; })
      .catch(function () { return false; });
  }

  /**
   * Confirm the alias actually resolves.
   * With mode:'no-cors' + redirect:'manual' the browser hands back an
   * opaque-redirect filtered response (type 'opaqueredirect') when the
   * short URL exists and redirects, and a plain opaque response (type
   * 'opaque') when it 404s. The response TYPE is what tells them apart.
   */
  function verifyAlias(host, alias) {
    var url = 'https://' + host + '/' + alias;
    return fetch(url, { mode: 'no-cors', redirect: 'manual', cache: 'no-store' })
      .then(function (res) { return res.type === 'opaqueredirect' || res.type === 'opaque-redirect'; })
      .catch(function () { return false; });
  }

  function tryProvider(provider, targetUrl, customAlias, onProgress) {
    var attempts = customAlias ? 1 : MAX_ALIAS_ATTEMPTS;

    function attempt(i) {
      var alias = customAlias || ('m' + randAlias(8));
      onProgress('Creating short link on ' + provider.id + ' …');

      return createShort(provider, alias, targetUrl).then(function (sent) {
        if (!sent) throw new Error('network');

        return waitForAlias(provider, alias);
      }).then(function (ok) {
        if (ok) return { alias: alias, host: provider.host };
        if (i + 1 < attempts) {
          return sleep(400).then(function () { return attempt(i + 1); });
        }
        throw new Error('not-created');
      });
    }

    return attempt(0);
  }

  function waitForAlias(provider, alias) {
    var tries = 0;
    function poll() {
      return verifyAlias(provider.host, alias).then(function (ok) {
        if (ok) return true;
        tries++;
        if (tries >= VERIFY_TRIES) return false;
        return sleep(VERIFY_DELAY).then(poll);
      });
    }
    return poll();
  }

  /* ----------------------------- history ----------------------------- */

  function loadHistory() {
    try {
      var raw = localStorage.getItem(HIST_KEY);
      var arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  }

  function saveHistory(list) {
    try { localStorage.setItem(HIST_KEY, JSON.stringify(list.slice(0, 40))); } catch (e) {}
  }

  function renderHistory() {
    var list = loadHistory(), ul = $('history');
    $('histCount').textContent = list.length ? '(' + list.length + ')' : '';
    $('histEmpty').style.display = list.length ? 'none' : 'block';
    ul.innerHTML = list.map(function (h) {
      return '<li>' +
        '<div class="hist-url">' + escapeHtml(h.masked) + '</div>' +
        '<div class="hist-meta">' +
          '<span>' + escapeHtml(new Date(h.ts).toLocaleString()) + '</span>' +
          '<span>→ ' + escapeHtml(h.target) + '</span>' +
          '<a href="' + escapeHtml(h.raw) + '" target="_blank" rel="noopener noreferrer">short ↗</a>' +
        '</div>' +
      '</li>';
    }).join('');
  }

  /* ------------------------------- UI -------------------------------- */

  function bindPresets(containerId, inputId) {
    var box = $(containerId);
    if (!box) return;
    box.addEventListener('click', function (e) {
      var b = e.target.closest('.chip');
      if (!b) return;
      var input = $(inputId);
      if (b.dataset.mask !== undefined) input.value = b.dataset.mask;
      if (b.dataset.words !== undefined) input.value = b.dataset.words;
      input.focus();
    });
  }

  function showResult(masked, raw, target, host, alias) {
    $('resultPanel').classList.remove('hidden');
    $('outUrl').value = masked;
    $('openBtn').href = masked;
    $('rawBtn').href = raw;
    $('outMeta').innerHTML =
      'short link → <a href="' + escapeHtml(raw) + '" target="_blank" rel="noopener noreferrer" style="color:var(--cyan)">' +
      escapeHtml(raw) + '</a> &nbsp;·&nbsp; provider <strong>' + escapeHtml(host) +
      '</strong> &nbsp;·&nbsp; alias <strong>' + escapeHtml(alias) + '</strong>';

    var at = masked.indexOf('@');
    if (at > -1) {
      $('fakeUrl').innerHTML =
        '<span class="u">' + escapeHtml(masked.slice(0, at + 1)) + '</span>' +
        '<span class="p">' + escapeHtml(masked.slice(at + 1)) + '</span>';
    } else {
      $('fakeUrl').textContent = masked;
    }

    $('resultPanel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function doMask(ev) {
    ev.preventDefault();

    var targetRaw = $('target').value;
    var maskRaw = $('mask').value;
    var words = $('words').value.trim();
    var custom = $('custom').value.trim().toLowerCase();

    var target = normalizeHttpUrl(targetRaw);
    if (!target) {
      setStatus('✗ Invalid target URL — it must start with http:// or https://', 'err');
      return;
    }
    var mask = normalizeHttpUrl(maskRaw);
    if (!mask) {
      setStatus('✗ Invalid masking domain — it must start with http:// or https://', 'err');
      return;
    }
    if (words && /\s/.test(words)) {
      setStatus('✗ Social engineering words must not contain spaces — use "-" instead', 'err');
      return;
    }
    if (custom && !/^[a-z0-9_]+$/.test(custom)) {
      setStatus('✗ Custom alias may only contain a-z, 0-9 and underscore', 'err');
      return;
    }

    var btn = $('goBtn');
    btn.disabled = true;
    btn.classList.add('loading');
    setStatus('Working …', '');

    var providers = PROVIDERS.slice(0, MAX_PROVIDERS);
    var i = 0;

    function next() {
      if (i >= providers.length) {
        btn.disabled = false;
        btn.classList.remove('loading');
        setStatus('✗ Could not create the short link. The shortener may be rate-limiting, or it rejected the target URL. Try again in a moment.', 'err');
        return;
      }
      var p = providers[i++];
      tryProvider(p, target.href, custom, function (msg) { setStatus(msg, ''); })
        .then(function (res) {
          var raw = 'https://' + res.host + '/' + res.alias;
          var masked = buildMaskedUrl(maskRaw, words, res.host, res.alias);
          showResult(masked, raw, target.href, res.host, res.alias);

          var list = loadHistory();
          list.unshift({ masked: masked, raw: raw, target: target.href, ts: Date.now() });
          saveHistory(list);
          renderHistory();

          btn.disabled = false;
          btn.classList.remove('loading');
          setStatus('✓ Done — masked URL generated and verified.', 'ok');
        })
        .catch(function () { next(); });
    }

    next();
  }

  function copyOut() {
    var field = $('outUrl');
    var btn = $('copyBtn');
    function done(ok) {
      btn.textContent = ok ? 'Copied' : 'Failed';
      btn.classList.add('done');
      setTimeout(function () { btn.textContent = 'Copy'; btn.classList.remove('done'); }, 1600);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(field.value).then(function () { done(true); }, function () { done(false); });
    } else {
      field.removeAttribute('readonly');
      field.select();
      field.setSelectionRange(0, 99999);
      try { done(document.execCommand('copy')); } catch (e) { done(false); }
      field.setAttribute('readonly', '');
    }
  }

  /* ------------------------------- init ------------------------------ */

  function init() {
    bindPresets('maskPresets', 'mask');
    bindPresets('wordPresets', 'words');
    $('maskForm').addEventListener('submit', doMask);
    $('copyBtn').addEventListener('click', copyOut);
    $('newBtn').addEventListener('click', function () {
      $('resultPanel').classList.add('hidden');
      $('status').textContent = '';
      $('target').focus();
    });
    $('clearHist').addEventListener('click', function () {
      saveHistory([]);
      renderHistory();
    });
    renderHistory();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
