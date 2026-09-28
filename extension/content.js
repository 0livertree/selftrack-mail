// Gmail content script: injects the tracking pixel on send, reports self-views, renders ✓/✓✓ badges.
// Gmail enforces Trusted Types, so never use innerHTML here — build DOM with createElement/textContent.

(() => {
  const PIXEL_RE = /\/o\/(mt[A-Za-z0-9]{20})\.gif/;
  const ID_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const cfg = { publicUrl: '', enabled: true };

  chrome.storage.local.get(['publicUrl', 'enabled']).then((v) => Object.assign(cfg, v));
  chrome.storage.onChanged.addListener((changes) => {
    for (const [k, { newValue }] of Object.entries(changes)) if (k in cfg) cfg[k] = newValue;
  });

  async function send(type, data = {}) {
    if (!chrome.runtime?.id) return null; // extension was reloaded; this script is orphaned
    try {
      const res = await chrome.runtime.sendMessage({ type, ...data });
      if (res?.error) console.warn(`[SelfTrack] ${type}:`, res.error);
      return res?.error ? null : res;
    } catch {
      return null;
    }
  }

  function newId() {
    const bytes = crypto.getRandomValues(new Uint8Array(20));
    return 'mt' + Array.from(bytes, (b) => ID_CHARS[b % ID_CHARS.length]).join('');
  }

  const EMAIL_RE = /[\w.+-]+@[\w-]+(\.[\w-]+)+/;

  function ownEmail() {
    const account = document.querySelector('a[aria-label*="@"][href*="accounts.google.com"]');
    const m = document.title.match(EMAIL_RE) || account?.getAttribute('aria-label').match(EMAIL_RE);
    return m ? m[0].toLowerCase() : '';
  }

  // --- Compose: inject pixel on send ------------------------------------------

  function findSendButton(target) {
    const btn = target?.closest?.('[role="button"]');
    if (!btn) return null;
    if (btn.classList.contains('aoO')) return btn;
    const tip = btn.getAttribute('data-tooltip') || btn.getAttribute('aria-label') || '';
    return /(Ctrl|⌘)-?Enter/i.test(tip) ? btn : null;
  }

  // The send button and the body share a small ancestor that doesn't include the subject/recipient
  // fields, so keep climbing until the header fields are in scope, without swallowing another compose.
  function findComposeRoot(el) {
    let root = null;
    for (let n = el; n && n !== document.body; n = n.parentElement) {
      if (n.matches('[role="main"]')) break;
      const editors = n.querySelectorAll('div[g_editable="true"]');
      if (editors.length > 1) break;
      if (editors.length === 1) {
        root = n;
        if (n.matches('[role="dialog"]') || n.querySelector('input[name="subjectbox"], input[name="to"]')) break;
      }
    }
    return root;
  }

  function getRecipients(root, body) {
    const me = ownEmail();
    const found = new Set();
    const add = (v) => {
      v = (v || '').trim().toLowerCase();
      if (v.includes('@') && v !== me) found.add(v);
    };
    root.querySelectorAll('[email], [data-hovercard-id]').forEach((el) => {
      if (!body.contains(el)) add(el.getAttribute('email') || el.getAttribute('data-hovercard-id'));
    });
    root.querySelectorAll('input[name="to"], input[name="cc"], input[name="bcc"]').forEach((input) => {
      input.value.split(',').forEach((part) => add((part.match(/<([^>]+)>/) || [null, part])[1]));
    });
    return [...found];
  }

  function onSend(root) {
    if (!cfg.enabled || !cfg.publicUrl) return;
    const body = root.querySelector('div[g_editable="true"]');
    if (!body) return;

    let id = body.dataset.mtId;
    if (!id) {
      id = newId();
      body.dataset.mtId = id;
      // Drop pixels carried over from quoted earlier messages so they don't double-count.
      body.querySelectorAll('img').forEach((img) => PIXEL_RE.test(img.src) && img.remove());
      const img = document.createElement('img');
      img.src = `${cfg.publicUrl.replace(/\/+$/, '')}/o/${id}.gif`;
      img.width = 1;
      img.height = 1;
      img.alt = '';
      img.setAttribute('style', 'width:1px;height:1px;border:0;');
      body.appendChild(img);
    }

    const subject =
      root.querySelector('input[name="subjectbox"]')?.value ||
      document.querySelector('h2.hP')?.textContent ||
      '';
    send('register', {
      msg: { id, subject: subject.trim(), recipients: getRecipients(root, body), sender: ownEmail() },
    });
  }

  document.addEventListener(
    'mousedown',
    (e) => {
      const btn = findSendButton(e.target);
      const root = btn && findComposeRoot(btn);
      if (root) onSend(root);
    },
    true
  );
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const isShortcut = e.key === 'Enter' && (e.ctrlKey || e.metaKey);
      const target = isShortcut ? e.target : findSendButton(e.target);
      const root = target && findComposeRoot(target);
      if (root) onSend(root);
    },
    true
  );

  // --- Self-view: tell the server I'm the one loading this pixel ----------------

  const seenPixels = new WeakSet();

  function scanSelfView() {
    const ids = new Set();
    document.querySelectorAll('.a3s img').forEach((img) => {
      if (seenPixels.has(img) || img.closest('[g_editable]')) return;
      const m = PIXEL_RE.exec(img.src);
      if (!m) return;
      seenPixels.add(img);
      ids.add(m[1]);
    });
    if (ids.size) send('selfView', { ids: [...ids], viewer: ownEmail() });
  }

  // --- Badges -----------------------------------------------------------------

  function relTime(ts) {
    const s = Math.floor(Date.now() / 1000 - ts);
    if (s < 60) return '방금';
    if (s < 3600) return `${Math.floor(s / 60)}분 전`;
    if (s < 86400) return `${Math.floor(s / 3600)}시간 전`;
    if (s < 86400 * 7) return `${Math.floor(s / 86400)}일 전`;
    return new Date(ts * 1000).toLocaleDateString('ko-KR');
  }

  function fullTime(ts) {
    return new Date(ts * 1000).toLocaleString('ko-KR');
  }

  function renderBadge(el, msg, verbose) {
    const opened = msg.open_count > 0;
    let text;
    if (verbose) {
      text = opened ? `✓✓ ${msg.open_count}회 열람 · 마지막 ${relTime(msg.last_open)}` : '✓ 보냄 · 아직 열람하지 않음';
    } else {
      text = opened ? `✓✓${msg.open_count > 1 ? ' ' + msg.open_count : ''}` : '✓';
    }
    const title = opened
      ? `열람 ${msg.open_count}회\n처음: ${fullTime(msg.first_open)}\n마지막: ${fullTime(msg.last_open)}`
      : `보냄: ${fullTime(msg.sent_at)}\n아직 열람하지 않음`;
    // Only touch the DOM when something changed, so our own writes don't retrigger the observer forever.
    if (el.textContent !== text) el.textContent = text;
    if (el.title !== title) el.title = title;
    if (el.classList.contains('mt-opened') !== opened) el.classList.toggle('mt-opened', opened);
  }

  function normSubject(s) {
    return (s || '')
      .replace(/^\s*((re|fwd?|fw|aw|wg|회신|전달|답장)\s*:\s*)+/i, '')
      .trim()
      .toLowerCase();
  }

  function matchRow(row, messages) {
    const subject = normSubject(row.querySelector('.bog')?.textContent);
    if (!subject) return null;
    const candidates = messages.filter((m) => normSubject(m.subject) === subject);
    if (!candidates.length) return null;
    const emails = [...row.querySelectorAll('[email]')].map((e) => e.getAttribute('email').toLowerCase());
    return candidates.find((m) => m.recipients.some((r) => emails.includes(r))) || candidates[0];
  }

  function renderThreadBadges(byId) {
    document.querySelectorAll('.a3s img').forEach((img) => {
      const m = PIXEL_RE.exec(img.src);
      if (!m || img.closest('[g_editable], .gmail_quote, blockquote')) return;
      const msg = byId.get(m[1]);
      const bodyEl = img.closest('.a3s');
      if (!bodyEl?.parentElement) return;
      let badge = bodyEl.previousElementSibling;
      if (!msg) {
        // deleted from tracking (or unknown to the server): drop any stale badge
        if (badge?.classList.contains('mt-thread-badge')) badge.remove();
        return;
      }
      if (!badge?.classList.contains('mt-thread-badge')) {
        badge = document.createElement('div');
        badge.className = 'mt-badge mt-thread-badge';
        bodyEl.parentElement.insertBefore(badge, bodyEl);
      }
      renderBadge(badge, msg, true);
    });
  }

  function renderListBadges(messages) {
    if (!location.hash.startsWith('#sent')) return;
    document.querySelectorAll('tr.zA').forEach((row) => {
      const msg = matchRow(row, messages);
      let badge = row.querySelector('.mt-list-badge');
      if (!msg) {
        badge?.remove();
        return;
      }
      if (!badge) {
        const anchor = row.querySelector('.y6') || row.querySelector('.bog');
        if (!anchor?.parentElement) return;
        badge = document.createElement('span');
        badge.className = 'mt-badge mt-list-badge';
        anchor.parentElement.insertBefore(badge, anchor);
      }
      renderBadge(badge, msg, false);
    });
  }

  async function scanBadges(force = false) {
    const hasPixels = [...document.querySelectorAll('.a3s img')].some((img) => PIXEL_RE.test(img.src));
    if (!hasPixels && !location.hash.startsWith('#sent')) return;
    const res = await send('getMessages', { force });
    if (!res) return;
    renderThreadBadges(new Map(res.messages.map((m) => [m.id, m])));
    renderListBadges(res.messages);
  }

  // --- Wiring -----------------------------------------------------------------

  let selfTimer, badgeTimer;
  new MutationObserver(() => {
    clearTimeout(selfTimer);
    selfTimer = setTimeout(scanSelfView, 50);
    clearTimeout(badgeTimer);
    badgeTimer = setTimeout(scanBadges, 500);
  }).observe(document.body, { childList: true, subtree: true });

  window.addEventListener('hashchange', () => setTimeout(scanBadges, 300));
  setInterval(() => scanBadges(true), 30_000);
})();
