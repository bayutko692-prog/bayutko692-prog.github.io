/* MaskPhish — web port
 * 100% client-side. No backend, no analytics, no telemetry.
 * The target URL is sent directly from the browser to the shortener.
 */
(function () {
  'use strict';

  /* ------------------------------------------------------------------ *
   * Shortener providers.
   *
   * Both is.gd and v.gd expose a JSON endpoint that sends
   * "access-control-allow-origin: *", so the browser can call it with a
   * normal CORS request and actually READ the result. That gives us:
   *   - the real short URL (no guessing)
   *   - a structured error message when the target is rejected
   *   - optional custom aliases
   *
   * The JSON endpoint is used instead of format=simple because the
   * simple endpoint sends no CORS headers at all.
   * ------------------------------------------------------------------ */
  var PROVIDERS = [
    { id: 'is.gd', host: 'is.gd', create: 'https://is.gd/create.php' },
    { id: 'v.gd',  host: 'v.gd',  create: 'https://v.gd/create.php'  }
  ];

  var ALIAS_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';
  var MAX_ALIAS_ATTEMPTS = 3;   // per provider
  var MAX_PROVIDERS = 2;        // is.gd then v.gd
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
   * Build the masked URL the way the original maskphish.sh does:
   *   <mask-domain>[-<words>]@<short-host>/<alias>
   * The segment before '@' is URL user-info, so browsers display only
   * the real host while the string itself reads like the mask domain.
   *
   * One hardening over the original: the mask is reduced to its ORIGIN
   * for the user-info part. A path in the mask domain would otherwise
   * break the URL, because the first '/' starts the path and the '@'
   * would land in the wrong segment.
   */
  function buildMaskedUrl(maskRaw, words, host, alias) {
    var mask = String(maskRaw).trim().replace(/\/+$/, '');
    var path = '';
    var m = mask.match(/^([a-z][a-z0-9+.-]*:\/\/[^/?#]+)([^?#]*)/i);
    if (m) {
      mask = m[1];
      path = m[2] || '';
    }
    if (words) mask += '-' + words;
    return mask + '@' + host + '/' + alias + path;
  }

  /**
   * Create a short URL and read the result.
   *
   * The JSON endpoint returns either
   *   { "shorturl": "https://is.gd/xxxxx" }
   * or
   *   { "errorcode": N, "errormessage": "..." }
   *
   * The target URL is URL-encoded, which is what fixes the classic
   * maskphish bug where "?user=test&pass=123" got truncated at the '&'.
   */
  function createShort(provider, alias, targetUrl) {
    var qs = 'format=json&url=' + encodeURIComponent(targetUrl);
    if (alias) qs += '&shorturl=' + encodeURIComponent(alias);

    return fetch(provider.create + '?' + qs, {
      method: 'GET',
      mode: 'cors',
      cache: 'no-store',
      credentials: 'omit',
      headers: { 'Accept': 'application/json' }
    })
      .then(function (res) {
        return res.text().then(function (txt) {
          var data;
          try { data = JSON.parse(txt); }
          catch (e) { throw new Error('Unexpected response from ' + provider.id); }
          if (data && data.errormessage) throw new Error(data.errormessage);
          if (!data || !data.shorturl) throw new Error('Unexpected response from ' + provider.id);
          // normalise: { shorturl: "https://is.gd/abc" }
          var m = String(data.shorturl).match(/^https?:\/\/([^\/]+)\/(.+)$/);
          if (!m) throw new Error('Unexpected response from ' + provider.id);
          return { host: m[1], alias: m[2] };
        });
      });
  }

  /**
   * Confirm the short URL really exists.
   *
   * The shortener's own JSON endpoint is the oracle: asking for an alias
   * that is already taken comes back with errorcode 2 ("...already
   * exists..."), while a free alias comes back with a fresh shorturl.
   * So a successful create can be independently confirmed from the
   * browser, using the same CORS-enabled endpoint.
   */
  function verifyAlias(provider, alias) {
    var qs = 'format=json&shorturl=' + encodeURIComponent(alias) +
              '&url=' + encodeURIComponent('https://example.com/verify');

    return fetch(provider.create + '?' + qs, {
      mode: 'cors', cache: 'no-store', credentials: 'omit',
      headers: { 'Accept': 'application/json' }
    })
      .then(function (res) { return res.text(); })
      .then(function (txt) {
        var data;
        try { data = JSON.parse(txt); } catch (e) { return false; }
        if (!data) return false;
        if (data.errorcode === 2 && /already exists/i.test(data.errormessage || '')) return true;
        return false;
      })
      .catch(function () { return false; });
  }

  function tryProvider(provider, targetUrl, customAlias, onProgress) {
    var attempts = customAlias ? 1 : MAX_ALIAS_ATTEMPTS;

    function attempt(i) {
      var alias = customAlias || ('m' + randAlias(8));
      onProgress('Creating short link on ' + provider.id + ' …');

      return createShort(provider, alias, targetUrl).then(function (res) {
        // The provider echoes the alias it actually used. If we did not ask
        // for a specific alias it returns its own random one.
        return { alias: res.alias, host: res.host };
      }).catch(function (err) {
        // "already exists" -> retry with a fresh alias.
        var msg = (err && err.message) || 'failed';
        if (i + 1 < attempts && /already exists/i.test(msg)) {
          onProgress('Alias taken, retrying on ' + provider.id + ' …');
          return sleep(400).then(function () { return attempt(i + 1); });
        }
        throw err;
      });    }

    return attempt(0);
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
    // The words land in the user-info segment, so strip characters that
    // would break the URL structure ('@', '/', '?', '#', whitespace).
    if (words) {
      var cleaned = words.replace(/[@/?#\s\\<>"']/g, '').replace(/^-+|-+$/g, '');
      if (!cleaned) {
        setStatus('✗ Social engineering words contained no usable characters', 'err');
        return;
      }
      words = cleaned;
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
    var lastError = '';

    function next() {
      if (i >= providers.length) {
        btn.disabled = false;
        btn.classList.remove('loading');
        setStatus('✗ ' + (lastError || 'Could not create the short link. The shortener may be rate-limiting, or it rejected the target URL. Try again in a moment.'), 'err');
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

          // Independently confirm the alias exists, then report honestly.
          setStatus('Verifying the short link …', '');
          return verifyAlias(p, res.alias).then(function (ok) {
            setStatus(ok
              ? '✓ Done — masked URL generated and verified.'
              : '✓ Done — masked URL generated (could not confirm the alias, but it was accepted by ' + p.id + ').',
              ok ? 'ok' : 'warn');
          });
        })
        .catch(function (err) {
          lastError = (err && err.message) ? 'Shortener said: ' + err.message : lastError;
          // A rejected target URL will fail on every provider — stop early.
          if (/valid URL|doesn't seem to be of a type|may only contain/i.test(lastError)) {
            btn.disabled = false;
            btn.classList.remove('loading');
            setStatus('✗ ' + lastError, 'err');
            return;
          }
          next();
        });
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
