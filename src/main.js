import './style.css';
import { DEFAULT_SHEET_URL, COLUMNS, loadSheet, roomArea, formatDate } from './sheet.js';
import { DAY_NAMES, DEFAULT_WEIGHTS } from './scheduler.js';

const $ = (sel) => document.querySelector(sel);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fold = (s) =>
  String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[đĐÐ]/g, 'd').toLowerCase();
const shortDay = (d) => (d === 8 ? 'CN' : 'T' + d);

const STORE_KEY = 'dkmh:v1';
const COLORS = ['#2457d6', '#d0452f', '#1e8a55', '#8a3fd1', '#c27a00', '#0f8a9c', '#c2357b', '#5b6b00', '#6d4c41', '#3949ab', '#00897b', '#e65100'];

const state = {
  data: null,
  sheets: [],
  gid: '',
  solutions: [],
  courseOrder: [],
  active: 0,
  viewWeek: 0,
};

// ---------- localStorage ----------
function loadStore() {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY)) || {};
  } catch {
    return {};
  }
}
function saveStore() {
  const s = {
    url: $('#sheet-url').value,
    gid: state.gid,
    sel: Object.fromEntries(Object.entries(ms).map(([k, m]) => [k, [...m.selected]])),
    opts: readOpts(),
  };
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(s));
  } catch {
    /* bộ nhớ trình duyệt bị chặn: bỏ qua */
  }
}

// ---------- Multi-select ----------
class MultiSelect {
  constructor(el, { placeholder, chips = false, onChange }) {
    this.el = el;
    this.placeholder = placeholder;
    this.chips = chips;
    this.onChange = onChange;
    this.options = [];
    this.selected = new Set();
    el.classList.add('ms');
    el.innerHTML = `
      <button type="button" class="ms-btn"><span class="sum"></span><span>▾</span></button>
      <div class="ms-pop" hidden>
        <input type="search" class="ms-search" placeholder="Tìm…" />
        <div class="ms-actions">
          <button type="button" class="btn small" data-act="all">Chọn tất cả (đang hiện)</button>
          <button type="button" class="btn small" data-act="none">Bỏ chọn hết</button>
        </div>
        <div class="ms-list"></div>
      </div>
      <div class="chips"></div>`;
    this.btn = el.querySelector('.ms-btn');
    this.pop = el.querySelector('.ms-pop');
    this.search = el.querySelector('.ms-search');
    this.list = el.querySelector('.ms-list');
    this.chipBox = el.querySelector('.chips');

    this.btn.addEventListener('click', () => this.toggle());
    this.search.addEventListener('input', () => this.renderList());
    el.querySelector('[data-act=all]').addEventListener('click', () => {
      this.visible().forEach((o) => this.selected.add(o.value));
      this.changed();
    });
    el.querySelector('[data-act=none]').addEventListener('click', () => {
      this.selected.clear();
      this.changed();
    });
    this.list.addEventListener('change', (e) => {
      const v = e.target.value;
      e.target.checked ? this.selected.add(v) : this.selected.delete(v);
      this.changed(false);
    });
    this.chipBox.addEventListener('click', (e) => {
      const v = e.target.closest('[data-rm]')?.dataset.rm;
      if (v === undefined) return;
      this.selected.delete(v);
      this.changed();
    });
    document.addEventListener('click', (e) => {
      if (!el.contains(e.target)) this.pop.hidden = true;
    });
  }
  toggle() {
    this.pop.hidden = !this.pop.hidden;
    if (!this.pop.hidden) {
      this.renderList();
      this.search.focus();
    }
  }
  setOptions(options) {
    this.options = options;
    const valid = new Set(options.map((o) => o.value));
    for (const v of this.selected) if (!valid.has(v)) this.selected.delete(v);
    this.render();
  }
  setSelected(values) {
    const valid = new Set(this.options.map((o) => o.value));
    this.selected = new Set(values.filter((v) => valid.has(v)));
    this.render();
  }
  visible() {
    const q = fold(this.search.value.trim());
    if (!q) return this.options;
    const words = q.split(/\s+/);
    return this.options.filter((o) => {
      const hay = fold(o.label + ' ' + (o.sub ?? ''));
      return words.every((w) => hay.includes(w));
    });
  }
  changed(rerenderList = true) {
    this.render(rerenderList);
    this.onChange?.();
  }
  render(rerenderList = true) {
    const n = this.selected.size;
    const sum = this.btn.querySelector('.sum');
    if (!n) sum.innerHTML = `<span class="ph">${esc(this.placeholder)}</span>`;
    else if (n <= 3 && !this.chips)
      sum.textContent = this.options.filter((o) => this.selected.has(o.value)).map((o) => o.short ?? o.label).join(', ');
    else sum.textContent = `Đã chọn ${n}`;
    this.chipBox.innerHTML = this.chips
      ? this.options
          .filter((o) => this.selected.has(o.value))
          .map((o) => `<span class="chip">${esc(o.short ?? o.label)}<button type="button" data-rm="${esc(o.value)}" title="Bỏ">×</button></span>`)
          .join('')
      : '';
    if (rerenderList && !this.pop.hidden) this.renderList();
  }
  renderList() {
    let group = null;
    const html = [];
    const vis = this.visible();
    for (const o of vis.slice(0, 600)) {
      if (o.group && o.group !== group) {
        group = o.group;
        html.push(`<div class="ms-group">${esc(group)}</div>`);
      }
      html.push(
        `<label class="ms-opt"><input type="checkbox" value="${esc(o.value)}" ${this.selected.has(o.value) ? 'checked' : ''}/>` +
          `<span>${esc(o.label)}${o.sub ? `<small>${esc(o.sub)}</small>` : ''}</span></label>`,
      );
    }
    if (vis.length > 600) html.push(`<div class="hint" style="padding:6px">…còn ${vis.length - 600} mục, hãy gõ để lọc</div>`);
    if (!vis.length) html.push('<div class="hint" style="padding:6px">Không có mục phù hợp</div>');
    this.list.innerHTML = html.join('');
  }
}

const onFilterChange = () => {
  refreshLopOptions();
  renderCourseSummary();
  saveStore();
};
const ms = {
  course: new MultiSelect($('#f-course'), { placeholder: 'Chọn các môn muốn đăng ký…', chips: true, onChange: onFilterChange }),
  thu: new MultiSelect($('#f-thu'), { placeholder: 'Tất cả các thứ', onChange: onFilterChange }),
  ca: new MultiSelect($('#f-ca'), { placeholder: 'Tất cả các ca', onChange: onFilterChange }),
  room: new MultiSelect($('#f-room'), { placeholder: 'Tất cả phòng', onChange: onFilterChange }),
  ctdt: new MultiSelect($('#f-ctdt'), { placeholder: 'Tất cả CTĐT', onChange: onFilterChange }),
  lop: new MultiSelect($('#f-lop'), { placeholder: 'Không ghim (xét mọi lớp)', chips: true, onChange: onFilterChange }),
};

// ---------- Options & filtering ----------
function readOpts() {
  return {
    onTap: $('#opt-ontap').checked,
    countOnline: $('#opt-online').checked,
    prefBuoi: [...document.querySelectorAll('input[name=buoi]:checked')].map((x) => x.value),
    weights: {
      gap: num('#w-gap', DEFAULT_WEIGHTS.gap),
      days: num('#w-days', DEFAULT_WEIGHTS.days),
      idle: num('#w-idle', DEFAULT_WEIGHTS.idle),
      pref: num('#w-pref', DEFAULT_WEIGHTS.pref),
    },
    topK: Math.min(100, Math.max(1, num('#opt-topk', 20))),
  };
}
function num(sel, def) {
  const v = parseFloat($(sel).value);
  return Number.isFinite(v) && v >= 0 ? v : def;
}
function writeOpts(o = {}) {
  $('#opt-ontap').checked = !!o.onTap;
  $('#opt-online').checked = o.countOnline ?? true;
  document.querySelectorAll('input[name=buoi]').forEach((x) => (x.checked = (o.prefBuoi ?? []).includes(x.value)));
  const w = { ...DEFAULT_WEIGHTS, ...(o.weights ?? {}) };
  $('#w-gap').value = w.gap;
  $('#w-days').value = w.days;
  $('#w-idle').value = w.idle;
  $('#w-pref').value = w.pref;
  $('#opt-topk').value = o.topK ?? 20;
}

const sessionText = (s) => `${shortDay(s.thu)} Ca ${s.ca} · ${s.room || '—'} · tuần ${s.tuan}`;

/** Lý do một lớp bị loại, hoặc null nếu lớp hợp lệ */
function rejectReason(sec, opts) {
  if (sec.invalid) return 'lịch không đọc được';
  if (sec.onTap && !opts.onTap) return 'lớp ôn tập';
  if (ms.ctdt.selected.size && !ms.ctdt.selected.has(sec.ctdt)) return 'CTĐT';
  for (const s of sec.sessions) {
    if (s.kind === 'exempt') continue;
    if (ms.thu.selected.size && !ms.thu.selected.has(String(s.thu))) return 'thứ';
    if (ms.ca.selected.size && !ms.ca.selected.has(String(s.ca))) return 'ca';
    if (ms.room.selected.size && !ms.room.selected.has('area:' + roomArea(s.room)) && !ms.room.selected.has('room:' + s.room))
      return 'phòng';
  }
  return null;
}

function candidates(course, opts = readOpts()) {
  const pinned = course.sections.filter((s) => ms.lop.selected.has(s.maLop));
  const pool = pinned.length ? pinned : course.sections;
  const kept = [];
  const reasons = {};
  for (const sec of pool) {
    const r = rejectReason(sec, opts);
    if (r) reasons[r] = (reasons[r] ?? 0) + 1;
    else kept.push(sec);
  }
  return { kept, reasons, pinned: pinned.length, total: course.sections.length };
}

function selectedCourses() {
  return [...ms.course.selected].map((c) => state.data.courses.get(c)).filter(Boolean);
}

function refreshLopOptions() {
  if (!state.data) return;
  const opts = [];
  for (const c of selectedCourses())
    for (const sec of c.sections)
      opts.push({
        value: sec.maLop,
        label: `${sec.maLop} — ${c.tenHP}`,
        short: sec.maLop,
        sub: (sec.sessions.length ? sec.sessions.map(sessionText).join(' | ') : 'Không có TKB') + (sec.ctdt ? ` · ${sec.ctdt}` : '') + (sec.onTap ? ' · ôn tập' : ''),
        group: `${c.maHP} – ${c.tenHP}`,
      });
  const before = ms.lop.selected.size;
  ms.lop.setOptions(opts);
  if (ms.lop.selected.size !== before) saveStore();
}

function renderCourseSummary() {
  const box = $('#course-summary');
  const courses = selectedCourses();
  $('#run').disabled = !courses.length;
  if (!courses.length) {
    box.innerHTML = '';
    return;
  }
  const opts = readOpts();
  let tc = 0;
  box.innerHTML =
    courses
      .map((c) => {
        tc += parseInt(c.tc, 10) || 0;
        const { kept, reasons, pinned, total } = candidates(c, opts);
        const why = Object.entries(reasons)
          .map(([k, v]) => `${v} lớp loại do ${k}`)
          .join(', ');
        return `<div class="cs-item ${kept.length ? '' : 'zero'}" title="${esc(why)}">
          <span>${esc(c.maHP)} – ${esc(c.tenHP)}</span>
          <span class="n">${kept.length}/${pinned || total} lớp${pinned ? ' (ghim)' : ''}</span></div>`;
      })
      .join('') + `<div class="hint">Tổng: ${courses.length} môn · ${tc} tín chỉ. Rê chuột lên môn để xem lý do lớp bị loại.</div>`;
}

// ---------- Load sheet ----------
function setStatus(msg, cls = '') {
  const el = $('#status');
  el.className = 'status ' + cls;
  el.textContent = msg;
}

async function doLoad({ nocache = false, gid = state.gid } = {}) {
  const url = $('#sheet-url').value.trim();
  if (!url) return;
  setStatus('Đang tải sheet…');
  $('#run').disabled = true;
  try {
    const t = performance.now();
    const { sheets, gid: g, data } = await loadSheet(url, { gid, nocache });
    state.data = data;
    state.sheets = sheets;
    state.gid = g;
    renderSheetTabs();
    populateFilters();
    renderData();
    renderWarnings();
    clearResults();
    const nSched = [...data.sections.values()].filter((s) => s.sessions.length).length;
    setStatus(
      `Đã đọc ${data.rows.length} dòng · ${data.sections.size} lớp học phần (${nSched} có lịch) · ${data.courses.size} môn` +
        (data.semesterStart != null ? ` · Tuần 1 bắt đầu ${formatDate(data.semesterStart)}` : '') +
        ` · ${Math.round(performance.now() - t)} ms`,
      'ok',
    );
    saveStore();
  } catch (err) {
    setStatus('Lỗi: ' + err.message, 'error');
  }
}

function renderSheetTabs() {
  const sel = $('#sheet-tab');
  sel.hidden = state.sheets.length <= 1;
  sel.innerHTML = state.sheets.map((s) => `<option value="${esc(s.gid)}">${esc(s.name)}</option>`).join('');
  sel.value = state.gid;
}

function populateFilters() {
  const { courses, sections } = state.data;
  const keepSel = Object.fromEntries(Object.entries(ms).map(([k, m]) => [k, [...m.selected]]));
  const stored = loadStore().sel ?? {};
  const pick = (k) => (keepSel[k].length ? keepSel[k] : stored[k] ?? []);

  ms.course.setOptions(
    [...courses.values()]
      .sort((a, b) => a.tenHP.localeCompare(b.tenHP, 'vi'))
      .map((c) => ({
        value: c.maHP,
        label: `${c.maHP} – ${c.tenHP}`,
        short: `${c.maHP} – ${c.tenHP}`,
        sub: `${c.sections.length} lớp · ${c.tc || '?'} TC` + (c.sections.every((s) => !s.sessions.length) ? ' · không có TKB' : ''),
      })),
  );
  const allSessions = [...sections.values()].flatMap((s) => s.sessions);
  const uniq = (arr) => [...new Set(arr)];
  ms.thu.setOptions(uniq(allSessions.map((s) => s.thu)).sort((a, b) => a - b).map((d) => ({ value: String(d), label: DAY_NAMES[d], short: shortDay(d) })));
  ms.ca.setOptions(uniq(allSessions.map((s) => s.ca)).sort((a, b) => a - b).map((c) => ({ value: String(c), label: `Ca ${c}` })));
  const rooms = uniq(allSessions.map((s) => s.room).filter(Boolean)).sort();
  const areaLabel = { HTT: 'HTT – học trực tuyến', LMS: 'LMS (không tính trùng)', BTN: 'BTN (không tính trùng)' };
  ms.room.setOptions([
    ...uniq(rooms.map(roomArea)).map((a) => ({ value: 'area:' + a, label: areaLabel[a] ?? `Khu ${a} (tất cả phòng)`, short: a, group: 'Khu' })),
    ...rooms.filter((r) => r !== roomArea(r)).map((r) => ({ value: 'room:' + r, label: r, group: 'Phòng cụ thể' })),
  ]);
  ms.ctdt.setOptions(uniq([...sections.values()].map((s) => s.ctdt).filter(Boolean)).sort().map((c) => ({ value: c, label: c })));

  for (const k of ['course', 'thu', 'ca', 'room', 'ctdt']) ms[k].setSelected(pick(k));
  refreshLopOptions();
  ms.lop.setSelected(pick('lop'));
  renderCourseSummary();
}

// ---------- Solve ----------
let worker = null;
function runSolver() {
  const courses = selectedCourses();
  if (!courses.length) return;
  const opts = readOpts();
  const payload = courses.map((c) => ({ maHP: c.maHP, tenHP: c.tenHP, sections: candidates(c, opts).kept }));
  const empty = payload.filter((c) => !c.sections.length);
  if (empty.length) {
    showHead(
      'error',
      `Không còn lớp nào thỏa bộ lọc cho: <b>${empty.map((c) => esc(`${c.maHP} – ${c.tenHP}`)).join(', ')}</b>. Hãy nới bộ lọc (thứ/ca/phòng/CTĐT/ghim lớp).`,
    );
    $('#solutions').innerHTML = '';
    $('#detail').innerHTML = '';
    return;
  }
  worker?.terminate();
  worker = new Worker(new URL('./scheduler.worker.js', import.meta.url), { type: 'module' });
  showHead('', 'Đang tìm tổ hợp tốt nhất…');
  $('#run').disabled = true;
  worker.onmessage = (e) => {
    $('#run').disabled = false;
    worker.terminate();
    worker = null;
    if (!e.data.ok) return showHead('error', 'Lỗi khi xếp lịch: ' + esc(e.data.error));
    state.courseOrder = courses.map((c) => c.maHP);
    renderResults(e.data.result, payload, opts);
  };
  worker.postMessage({
    courses: payload,
    weights: opts.weights,
    countOnline: opts.countOnline,
    prefBuoi: opts.prefBuoi,
    topK: opts.topK,
    timeLimitMs: 10000,
  });
}

function showHead(cls, html) {
  const el = $('#results-head');
  el.className = 'results-head ' + cls;
  el.innerHTML = html;
}

function clearResults() {
  state.solutions = [];
  showHead('', '<div class="empty">Chọn môn học và bấm <b>Xếp thời khóa biểu</b>.</div>');
  $('#solutions').innerHTML = '';
  $('#detail').innerHTML = '';
}

/**
 * Giải thích vì sao phương án tốt nhất vẫn có ngày trống: liệt kê các thứ mà MỌI lớp còn lại
 * của một môn đều phải học (không thể tránh bằng cách đổi lớp).
 */
function explainGaps(payload, opts) {
  const forced = new Map(); // thứ -> [{ course, partial }]
  for (const c of payload) {
    const perSec = c.sections.map((sec) => {
      const weeksByDay = new Map();
      for (const s of sec.sessions) {
        if (s.kind === 'exempt' || (s.kind === 'online' && !opts.countOnline)) continue;
        const set = weeksByDay.get(s.thu) ?? new Set();
        for (const [a, b] of s.weeks) for (let w = a; w <= b; w++) set.add(w);
        weeksByDay.set(s.thu, set);
      }
      return weeksByDay;
    });
    if (!perSec.length) continue;
    for (const d of perSec[0].keys()) {
      if (!perSec.every((m) => m.has(d))) continue;
      const maxWeeks = Math.max(...perSec.map((m) => m.get(d).size));
      if (!forced.has(d)) forced.set(d, []);
      forced.get(d).push({ course: c, weeks: maxWeeks });
    }
  }
  if (!forced.size) return '';
  const items = [...forced.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([d, list]) => {
      const names = list.map((x) => `${esc(x.course.maHP)} ${esc(x.course.tenHP)}${x.weeks < 8 ? ` <span class="m">(chỉ ${x.weeks} tuần)</span>` : ''}`);
      return `<li><b>${DAY_NAMES[d]}</b>: ${names.join(', ')}</li>`;
    })
    .join('');
  return `<div class="explain">Ngày học bắt buộc (mọi lớp còn lại của môn đều học vào thứ này, đổi lớp cũng không tránh được):<ul>${items}</ul></div>`;
}

function renderResults({ solutions, stats, diagnosis }, payload = [], opts = readOpts()) {
  state.solutions = solutions;
  state.active = 0;
  state.viewWeek = 0;
  const courseName = (code) => {
    const c = state.data.courses.get(code);
    return c ? `${c.maHP} – ${c.tenHP}` : code;
  };
  if (!solutions.length) {
    let html = stats.complete
      ? '<b>Không có tổ hợp nào không trùng lịch</b> với các môn và bộ lọc đã chọn.'
      : '<b>Hết thời gian tìm kiếm mà chưa thấy tổ hợp hợp lệ.</b> Hãy thu hẹp bộ lọc hoặc bớt môn.';
    if (diagnosis?.pairs?.length)
      html +=
        '<br>Các cặp môn luôn trùng nhau (mọi lớp đều đụng lịch):<ul>' +
        diagnosis.pairs.map(([a, b]) => `<li>${esc(courseName(a))} ⟷ ${esc(courseName(b))}</li>`).join('') +
        '</ul>';
    else if (stats.complete) html += '<br>Xung đột liên quan đến từ 3 môn trở lên. Thử bỏ bớt 1 môn hoặc nới bộ lọc.';
    showHead('error', html);
    $('#solutions').innerHTML = '';
    $('#detail').innerHTML = '';
    return;
  }
  const groupInfo = stats.groups.map((g) => g.groups).reduce((a, b) => a * b, 1);
  showHead(
    stats.complete ? '' : 'warn',
    `Tìm thấy <b>${solutions.length}</b> phương án tốt nhất — đã duyệt ${stats.leaves.toLocaleString('vi')} tổ hợp không trùng trong ${stats.elapsed} ms` +
      ` (không gian ${groupInfo.toLocaleString('vi')} tổ hợp lịch khác nhau).` +
      (stats.complete
        ? ' Kết quả đã xét <b>toàn bộ</b> tổ hợp nên là tối ưu theo tiêu chí.'
        : ' <b>Hết thời gian trước khi duyệt hết</b> — đây là các phương án tốt nhất tìm được; thu hẹp bộ lọc để chắc chắn tối ưu.') +
      (solutions[0].gaps > 0
        ? `<div class="gap-note">⚠ <b>${stats.complete ? 'Không thể' : 'Chưa tìm được cách'} xếp các ngày học liên tiếp hoàn toàn</b> với các môn/bộ lọc này: ` +
          `phương án tốt nhất vẫn có trung bình ${(solutions[0].gaps / (solutions[0].activeWeeks || 1)).toFixed(1)} ngày trống xen giữa mỗi tuần` +
          `${stats.complete ? ' (đã xét hết mọi tổ hợp không trùng)' : ''}.` +
          explainGaps(payload, opts) +
          '<span class="m">Muốn liên tiếp hơn: thử đổi sang môn tự chọn khác' +
          (opts.countOnline && payload.some((c) => c.sections.some((sec) => sec.sessions.some((x) => x.kind === 'online')))
            ? ', hoặc bỏ tick "Tính buổi học trực tuyến (HTT) là ngày đi học" nếu không cần đến trường các buổi online'
            : '') +
          '.</span></div>'
        : ''),
  );
  renderSolutionList();
  renderDetail();
}

function renderSolutionList() {
  const days = [2, 3, 4, 5, 6, 7];
  if (state.solutions.some((s) => s.pattern.includes(8))) days.push(8);
  $('#solutions').innerHTML = state.solutions
    .map((s, i) => {
      const aw = s.activeWeeks || 1;
      return `<button class="sol ${i === state.active ? 'active' : ''}" data-i="${i}">
        <span class="rank">#${i + 1}</span> <span class="meta">điểm ${s.score}</span>
        <div class="days">${days.map((d) => `<span class="d ${s.pattern.includes(d) ? 'on' : ''}">${shortDay(d)}</span>`).join('')}</div>
        <div class="meta">Trung bình mỗi tuần: ${(s.days / aw).toFixed(1)} ngày học · ${(s.gaps / aw).toFixed(1)} ngày trống xen giữa
        · ${(s.idle / aw).toFixed(1)} ca trống${s.pref ? ` · lệch buổi: ${s.pref}` : ''}</div>
      </button>`;
    })
    .join('');
}

function weekDates(w) {
  const s = state.data.semesterStart;
  if (s == null) return '';
  return `${formatDate(s + (w - 1) * 7).slice(0, 5)}–${formatDate(s + (w - 1) * 7 + 6).slice(0, 5)}`;
}

function renderDetail() {
  const sol = state.solutions[state.active];
  if (!sol) return;
  const { sections, courses } = state.data;
  const picks = sol.picks.map((p, i) => ({
    ...p,
    color: COLORS[i % COLORS.length],
    course: courses.get(p.maHP),
    sec: sections.get(p.maLops[0]),
  }));

  let maxWeek = 1;
  let maxCa = 4;
  let hasSun = false;
  for (const p of picks)
    for (const s of p.sec.sessions) {
      maxWeek = Math.max(maxWeek, ...s.weeks.map((w) => w[1]));
      maxCa = Math.max(maxCa, s.ca);
      if (s.thu === 8) hasSun = true;
    }
  const days = [2, 3, 4, 5, 6, 7, ...(hasSun ? [8] : [])];
  const w = state.viewWeek;
  const inWeek = (s) => !w || s.weeks.some(([a, b]) => a <= w && w <= b);

  const cell = (d, ca) =>
    picks
      .flatMap((p) =>
        p.sec.sessions
          .filter((s) => s.thu === d && s.ca === ca && inWeek(s))
          .map(
            (s) => `<div class="ev ${s.kind === 'exempt' ? 'exempt' : ''}" style="border-color:${p.color};background:${p.color}14">
              <b>${esc(p.course.tenHP)}</b>
              <span class="m">${esc(p.sec.maLop)} · ${esc(s.room || '—')}${s.tiet ? ` · ${s.tiet} tiết` : ''}</span><br>
              <span class="m">Tuần ${esc(s.tuan)}</span>${s.kind === 'exempt' ? ' <span class="m">(không tính trùng)</span>' : ''}
              ${s.mismatchNote ? `<span class="flag" title="${esc(s.mismatchNote)}"> ⚠</span>` : ''}
            </div>`,
          ),
      )
      .join('');

  const weekOpts = ['<option value="0">Tất cả các tuần</option>']
    .concat(Array.from({ length: maxWeek }, (_, i) => `<option value="${i + 1}">Tuần ${i + 1} ${weekDates(i + 1) && `(${weekDates(i + 1)})`}</option>`))
    .join('');

  const unscheduled = picks.filter((p) => !p.sec.sessions.length);
  let tc = 0;
  const regRows = picks
    .map((p, i) => {
      tc += parseInt(p.course.tc, 10) || 0;
      const alts = p.maLops.slice(1).map((m) => {
        const s = sections.get(m);
        return `<span class="code" title="${esc((s.sessions.map((x) => x.room).join(', ') || '') + (s.ctdt ? ' · ' + s.ctdt : ''))}">${esc(m)}</span>`;
      });
      return `<tr>
        <td>${i + 1}</td>
        <td><span class="sw" style="background:${p.color}"></span><span class="code">${esc(p.maHP)}</span></td>
        <td>${esc(p.course.tenHP)}${p.sec.onTap ? '<span class="tag">ôn tập</span>' : ''}</td>
        <td>${esc(p.course.tc)}</td>
        <td><b class="code">${esc(p.sec.maLop)}</b>${alts.length ? `<div class="alt">Lớp cùng lịch: ${alts.join(', ')}</div>` : ''}</td>
        <td>${p.sec.sessions.length ? p.sec.sessions.map((s) => esc(sessionText(s)) + (s.mismatchNote ? ` <span class="tag warn" title="${esc(s.mismatchNote)}">⚠ ngày/tuần lệch</span>` : '')).join('<br>') : '<span class="tag">Không có TKB</span>'}</td>
        <td>${esc(p.sec.ctdt)}</td>
      </tr>`;
    })
    .join('');

  $('#detail').innerHTML = `
    <div class="detail-head">
      <h3>Phương án #${state.active + 1} · đi học ${sol.pattern.map(shortDay).join(', ') || '—'}</h3>
      <select id="view-week">${weekOpts}</select>
    </div>
    <div class="grid-wrap">
      <table class="tkb">
        <thead><tr><th></th>${days.map((d) => `<th>${DAY_NAMES[d]}</th>`).join('')}</tr></thead>
        <tbody>${Array.from({ length: maxCa }, (_, i) => i + 1)
          .map((ca) => `<tr><th>Ca ${ca}</th>${days.map((d) => `<td>${cell(d, ca)}</td>`).join('')}</tr>`)
          .join('')}</tbody>
      </table>
    </div>
    ${unscheduled.length ? `<p class="hint">Không có TKB (không xét trùng): ${unscheduled.map((p) => esc(p.course.tenHP)).join(', ')}</p>` : ''}
    <div class="reg">
      <div class="detail-head">
        <h3>Danh sách lớp học phần cần đăng ký (${picks.length} môn · ${tc} TC)</h3>
        <div>
          <button class="btn" id="copy-codes">Copy mã lớp HP</button>
          <button class="btn" id="copy-table">Copy bảng</button>
        </div>
      </div>
      <table>
        <thead><tr><th>#</th><th>Mã HP</th><th>Tên học phần</th><th>TC</th><th>Mã lớp HP</th><th>Lịch học</th><th>CTĐT</th></tr></thead>
        <tbody>${regRows}</tbody>
      </table>
      <p class="hint">"Lớp cùng lịch" là các lớp có lịch học y hệt — dùng thay thế nếu lớp chính hết chỗ.</p>
    </div>`;
  $('#view-week').value = String(w);

  $('#copy-codes').onclick = (e) => copy(picks.map((p) => p.sec.maLop).join('\n'), e.target);
  $('#copy-table').onclick = (e) =>
    copy(
      ['Mã HP\tTên học phần\tTC\tMã lớp HP\tLớp cùng lịch\tLịch học']
        .concat(
          picks.map((p) =>
            [p.maHP, p.course.tenHP, p.course.tc, p.sec.maLop, p.maLops.slice(1).join(', '), p.sec.sessions.map(sessionText).join(' | ')].join('\t'),
          ),
        )
        .join('\n'),
      e.target,
    );
}

async function copy(text, btn) {
  const old = btn.textContent;
  try {
    await navigator.clipboard.writeText(text);
    btn.textContent = 'Đã copy ✓';
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    btn.textContent = 'Đã copy ✓';
  }
  setTimeout(() => (btn.textContent = old), 1500);
}

// ---------- Data / warnings tabs ----------
let dataPage = 0;
const PAGE = 200;
function renderData() {
  const rows = state.data?.rows ?? [];
  const q = fold($('#data-search').value.trim());
  const words = q ? q.split(/\s+/) : [];
  const keys = Object.keys(COLUMNS);
  const filtered = words.length ? rows.filter((r) => words.every((w) => fold(keys.map((k) => r[k]).join(' ')).includes(w))) : rows;
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE));
  dataPage = Math.min(dataPage, pages - 1);
  $('#data-count').textContent = `(${rows.length})`;
  $('#data-info').textContent = `${filtered.length} dòng`;
  $('#data-table').innerHTML =
    `<thead><tr>${keys.map((k) => `<th>${esc(COLUMNS[k])}</th>`).join('')}</tr></thead><tbody>` +
    filtered
      .slice(dataPage * PAGE, (dataPage + 1) * PAGE)
      .map((r) => `<tr>${keys.map((k) => `<td class="${k === 'tenHP' ? 'name' : ''}">${esc(r[k])}</td>`).join('')}</tr>`)
      .join('') +
    '</tbody>';
  $('#data-pager').innerHTML =
    pages > 1
      ? `<button class="btn small" data-p="${dataPage - 1}" ${dataPage ? '' : 'disabled'}>‹</button>
         <span>Trang ${dataPage + 1}/${pages}</span>
         <button class="btn small" data-p="${dataPage + 1}" ${dataPage < pages - 1 ? '' : 'disabled'}>›</button>`
      : '';
}

function renderWarnings() {
  const w = state.data?.warnings ?? [];
  $('#warn-count').textContent = w.length ? `(${w.length})` : '';
  $('#warn-list').innerHTML = w.length
    ? `<p class="hint" style="margin:0 0 8px -20px">Các dòng dưới đây trong sheet có dữ liệu không nhất quán. Khi ngày bắt đầu/kết thúc lệch với cột tuần, app xét trùng theo <b>cả hai</b> để không bỏ sót trùng lịch.</p>` +
      w.map((x) => `<li>${esc(x)}</li>`).join('')
    : '<li>Không có cảnh báo.</li>';
}

// ---------- Events ----------
$('#sheet-form').addEventListener('submit', (e) => {
  e.preventDefault();
  state.gid = '';
  doLoad();
});
$('#reload').addEventListener('click', () => doLoad({ nocache: true }));
$('#reset-url').addEventListener('click', () => {
  $('#sheet-url').value = DEFAULT_SHEET_URL;
  state.gid = '';
  doLoad();
});
$('#sheet-tab').addEventListener('change', (e) => doLoad({ gid: e.target.value }));
$('#run').addEventListener('click', runSolver);
$('#solutions').addEventListener('click', (e) => {
  const b = e.target.closest('.sol');
  if (!b) return;
  state.active = +b.dataset.i;
  state.viewWeek = 0;
  renderSolutionList();
  renderDetail();
});
$('#detail').addEventListener('change', (e) => {
  if (e.target.id !== 'view-week') return;
  state.viewWeek = +e.target.value;
  renderDetail();
});
document.querySelectorAll('#opt-ontap, #opt-online, input[name=buoi], .weights input').forEach((el) => el.addEventListener('change', onFilterChange));
document.querySelectorAll('.tab').forEach((t) =>
  t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === t));
    document.querySelectorAll('.tab-panel').forEach((p) => (p.hidden = p.id !== 'tab-' + t.dataset.tab));
  }),
);
$('#data-search').addEventListener('input', () => {
  dataPage = 0;
  renderData();
});
$('#data-pager').addEventListener('click', (e) => {
  const p = e.target.closest('[data-p]');
  if (!p || p.disabled) return;
  dataPage = +p.dataset.p;
  renderData();
});

// ---------- Init ----------
const stored = loadStore();
$('#sheet-url').value = stored.url || DEFAULT_SHEET_URL;
state.gid = stored.gid || '';
writeOpts(stored.opts);
clearResults();
doLoad();
