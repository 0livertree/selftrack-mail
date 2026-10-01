// Service worker: talks to the local server, caches message stats, polls for new opens.

const DEFAULTS = { apiUrl: 'http://127.0.0.1:8787', publicUrl: '', token: '', enabled: true };
const CACHE_TTL = 15_000;
let cache = { at: 0, messages: [] };

async function getConfig() {
  return { ...DEFAULTS, ...(await chrome.storage.local.get(Object.keys(DEFAULTS))) };
}

async function api(path, { method = 'GET', body } = {}) {
  const cfg = await getConfig();
  if (!cfg.token) throw new Error('서버 토큰이 설정되지 않았습니다');
  const res = await fetch(cfg.apiUrl.replace(/\/+$/, '') + path, {
    method,
    headers: { 'X-MT-Token': cfg.token, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`서버 오류 ${res.status}`);
  return res.json();
}

async function getMessages(force = false) {
  if (!force && Date.now() - cache.at < CACHE_TTL) return cache.messages;
  const { messages } = await api('/api/messages?limit=300');
  cache = { at: Date.now(), messages };
  return messages;
}

const handlers = {
  async register({ msg }) {
    await api('/api/messages', { method: 'POST', body: msg });
    cache.at = 0;
    return { ok: true };
  },
  async selfView({ ids, viewer }) {
    await api('/api/self-view', { method: 'POST', body: { ids, viewer } });
    return { ok: true };
  },
  async deleteMessages({ ids, all }) {
    const res = await api('/api/messages/delete', { method: 'POST', body: all ? { all: true } : { ids } });
    cache.at = 0;
    return res;
  },
  async getOpens({ id }) {
    return api(`/api/message-opens?id=${encodeURIComponent(id)}`);
  },
  async getMessages({ force }) {
    return { messages: await getMessages(force) };
  },
  async ping() {
    await api('/api/opens');
    return { ok: true };
  },
};

chrome.runtime.onMessage.addListener((req, _sender, sendResponse) => {
  const handler = handlers[req?.type];
  if (!handler) return false;
  handler(req)
    .then(sendResponse)
    .catch((err) => sendResponse({ error: err.message }));
  return true;
});

// --- Open notifications ---------------------------------------------------

function formatRecipients(list) {
  if (!list?.length) return '수신자';
  return list.length > 1 ? `${list[0]} 외 ${list.length - 1}명` : list[0];
}

async function pollOpens() {
  const { enabled, token } = await getConfig();
  if (!enabled || !token) return;
  const { openCursor } = await chrome.storage.local.get('openCursor');
  try {
    if (openCursor === undefined) {
      // First run: start from the latest open instead of notifying the whole history.
      const { latest } = await api('/api/opens');
      await chrome.storage.local.set({ openCursor: latest });
      return;
    }
    const { opens } = await api(`/api/opens?after=${openCursor}`);
    if (!opens.length) return;
    for (const o of opens) {
      chrome.notifications.create(`open-${o.id}`, {
        type: 'basic',
        iconUrl: 'icons/icon128.png',
        title: `메일이 열렸습니다 · ${formatRecipients(o.recipients)}`,
        message: o.subject || '(제목 없음)',
        priority: 1,
      });
    }
    await chrome.storage.local.set({ openCursor: opens[opens.length - 1].id });
    cache.at = 0;
  } catch (err) {
    console.warn('[SelfTrack] poll failed:', err.message);
  }
}

chrome.notifications.onClicked.addListener(async (id) => {
  chrome.notifications.clear(id);
  const [tab] = await chrome.tabs.query({ url: 'https://mail.google.com/*' });
  if (tab) {
    chrome.tabs.update(tab.id, { active: true });
    chrome.windows.update(tab.windowId, { focused: true });
  }
});

chrome.alarms.create('poll', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => a.name === 'poll' && pollOpens());
chrome.runtime.onStartup.addListener(pollOpens);
chrome.runtime.onInstalled.addListener(pollOpens);
