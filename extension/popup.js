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
    list.append(li);
  }
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
