const FIELDS = ['publicUrl', 'token', 'apiUrl'];
const DEFAULTS = { apiUrl: 'http://127.0.0.1:8787', publicUrl: '', token: '', enabled: true };
const $ = (id) => document.getElementById(id);

function setStatus(text, cls = '') {
  $('status').textContent = text;
  $('status').className = cls;
}

function relTime(ts) {
  const s = Math.floor(Date.now() / 1000 - ts);
  if (s < 60) return '방금';
  if (s < 3600) return `${Math.floor(s / 60)}분 전`;
  if (s < 86400) return `${Math.floor(s / 3600)}시간 전`;
  return `${Math.floor(s / 86400)}일 전`;
}

async function loadList() {
  const list = $('list');
  const res = await chrome.runtime.sendMessage({ type: 'getMessages', force: true });
  list.replaceChildren();
  const addEmpty = (text) => {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = text;
    list.append(li);
  };
  $('clearAll').hidden = true;
  if (!res || res.error) return addEmpty(`연결 실패: ${res?.error || '백그라운드 응답 없음'}`);
  if (!res.messages.length) return addEmpty('아직 추적 중인 메일이 없습니다.');
  $('clearAll').hidden = false;
  for (const m of res.messages.slice(0, 30)) {
    const li = document.createElement('li');
    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = '×';
    del.title = '추적 기록 삭제 (이 메일은 더 이상 추적되지 않습니다)';
    del.addEventListener('click', () => deleteMessages({ ids: [m.id] }));
    del.addEventListener('click', (e) => e.stopPropagation());
    const subj = document.createElement('div');
    subj.className = 'subj';
    subj.textContent = m.subject || '(제목 없음)';
    const meta = document.createElement('div');
    meta.className = 'meta';
    const to = m.recipients.length ? m.recipients.join(', ') : '수신자 미확인';
    if (m.open_count > 0) {
      const st = document.createElement('span');
      st.className = 'opened';
      st.textContent = `✓✓ ${m.open_count}회 · ${relTime(m.last_open)}`;
      meta.append(st, ` · ${to}`);
    } else {
      meta.textContent = `✓ 안 읽음 · ${relTime(m.sent_at)} 보냄 · ${to}`;
    }
    li.append(del, subj, meta);
    if (m.open_count > 0) {
      const detail = document.createElement('div');
      detail.className = 'detail';
      detail.hidden = true;
      detail.addEventListener('click', (e) => e.stopPropagation()); // clicks inside the details don't collapse it
      li.classList.add('expandable');
      li.title = '클릭해서 어디서 열었는지 보기';
      li.addEventListener('click', () => toggleDetail(li, detail, m.id));
      li.append(detail);
    }
    list.append(li);
  }
}

// --- Per-message open details ---------------------------------------------

const CLIENT_NAMES = {
  'Gmail (Google image proxy)': 'Gmail 수신자 (Google 프록시)',
  'Yahoo Mail (image proxy)': 'Yahoo 메일 수신자 (프록시)',
  'Outlook (desktop)': 'Outlook 데스크톱',
  'Unknown client': '알 수 없는 기기',
};

function clientName(client) {
  return CLIENT_NAMES[client] || client.replace('Mail app', '메일 앱').replace('Naver app', '네이버 앱');
}

function shortTime(ts) {
  return new Date(ts * 1000).toLocaleString('ko-KR', {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

// Group opens by "where": same client + same IP is most likely the same person/device.
// Proxied opens (Gmail) all look alike, so they form a single group regardless of proxy IP.
function groupOpens(opens) {
  const groups = new Map();
  for (const o of opens) {
    const key = o.via_proxy ? o.client : `${o.client}|${o.ip}`;
    const g = groups.get(key) || { client: o.client, ip: o.via_proxy ? null : o.ip, viaProxy: o.via_proxy, times: [] };
    g.times.push(o.ts);
    groups.set(key, g);
  }
  const list = [...groups.values()].sort((a, b) => Math.max(...b.times) - Math.max(...a.times));
  list.forEach((g, i) => (g.letter = String.fromCharCode(65 + (i % 26))));
  return list;
}

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

async function toggleDetail(li, detail, id) {
  if (!detail.hidden) {
    detail.hidden = true;
    li.classList.remove('open');
    return;
  }
  detail.hidden = false;
  li.classList.add('open');
  detail.replaceChildren(el('div', 'muted', '불러오는 중…'));
  const res = await chrome.runtime.sendMessage({ type: 'getOpens', id });
  if (!res || res.error) {
    detail.replaceChildren(el('div', 'err', `불러오기 실패: ${res?.error || '백그라운드 응답 없음'}`));
    return;
  }
  renderDetail(detail, res.opens);
}

function renderDetail(detail, opens) {
  detail.replaceChildren();
  if (!opens.length) {
    detail.append(el('div', 'muted', '열람 기록이 없습니다.'));
    return;
  }
  const groups = groupOpens(opens);
  const letterOf = new Map();
  groups.forEach((g) => g.times.forEach((t) => letterOf.set(t, g)));

  detail.append(el('div', 'detail-title', `열람한 곳 ${groups.length}곳`));
  for (const g of groups) {
    const box = el('div', 'group');
    const head = el('div', 'group-head');
    head.append(el('span', 'letter', g.letter), el('span', 'client', clientName(g.client)));
    const first = Math.min(...g.times);
    const last = Math.max(...g.times);
    const parts = [];
    if (g.ip) parts.push(g.ip);
    parts.push(`${g.times.length}회`);
    parts.push(g.times.length > 1 ? `${shortTime(first)} ~ ${shortTime(last)}` : shortTime(last));
    box.append(head, el('div', 'group-meta', parts.join(' · ')));
    detail.append(box);
  }
  if (groups.some((g) => g.viaProxy)) {
    detail.append(el('div', 'muted note', 'Gmail 수신자는 Google 프록시를 거쳐서, 여러 명이 열어도 한 곳으로 보입니다.'));
  }

  detail.append(el('div', 'detail-title', '최근 열람'));
  const timeline = el('ul', 'timeline');
  for (const o of opens.slice(0, 10)) {
    const g = letterOf.get(o.ts);
    const item = el('li');
    item.append(el('span', 'letter small', g.letter), ` ${shortTime(o.ts)} · ${clientName(o.client)}`);
    timeline.append(item);
  }
  detail.append(timeline);
  if (opens.length > 10) detail.append(el('div', 'muted', `외 ${opens.length - 10}회`));
}

async function deleteMessages(req) {
  const res = await chrome.runtime.sendMessage({ type: 'deleteMessages', ...req });
  if (!res || res.error) setStatus(`삭제 실패: ${res?.error || '백그라운드 응답 없음'}`, 'err');
  loadList();
}

// Popups can't show confirm() reliably, so "delete all" asks for a second click instead.
let clearArmed = null;
function onClearAll() {
  const btn = $('clearAll');
  if (!clearArmed) {
    btn.textContent = '정말 전부 삭제할까요? 한 번 더 클릭';
    btn.classList.add('armed');
    clearArmed = setTimeout(() => {
      clearArmed = null;
      btn.textContent = '전체 삭제';
      btn.classList.remove('armed');
    }, 4000);
    return;
  }
  clearTimeout(clearArmed);
  clearArmed = null;
  btn.textContent = '전체 삭제';
  btn.classList.remove('armed');
  deleteMessages({ all: true });
}

async function init() {
  const cfg = { ...DEFAULTS, ...(await chrome.storage.local.get(Object.keys(DEFAULTS))) };
  FIELDS.forEach((f) => ($(f).value = cfg[f]));
  $('enabled').checked = cfg.enabled;

  $('clearAll').addEventListener('click', onClearAll);
  $('enabled').addEventListener('change', () => chrome.storage.local.set({ enabled: $('enabled').checked }));
  $('save').addEventListener('click', async () => {
    const values = Object.fromEntries(FIELDS.map((f) => [f, $(f).value.trim().replace(/\/+$/, '')]));
    if (values.publicUrl && !/^https?:\/\//.test(values.publicUrl)) {
      return setStatus('공개 URL은 http:// 또는 https:// 로 시작해야 합니다', 'err');
    }
    await chrome.storage.local.set(values);
    setStatus('확인 중…');
    const res = await chrome.runtime.sendMessage({ type: 'ping' });
    if (res?.error) return setStatus(res.error, 'err');
    setStatus(values.publicUrl ? '연결됨' : '연결됨 (공개 URL 필요)', values.publicUrl ? 'ok' : 'err');
    loadList();
  });

  loadList();
}

init();
