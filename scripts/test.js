// Kiểm tra parser + xét trùng + solver.
// node scripts/test.js <api.json từ proxy> [<sheet.csv export cùng sheet>]
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { buildGrid, parseGrid, parseWeeks } from '../src/sheet.js';
import { sessionsConflict, sectionConflicts, solve, DEFAULT_WEIGHTS } from '../src/scheduler.js';

// --- Trích bảng HTML không cần DOM (đủ cho HTML của Google) ---
function extractRows(html) {
  const decode = (s) =>
    s
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d));
  const body = html.slice(html.indexOf('<tbody'));
  return [...body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map(([, tr]) =>
    [...tr.matchAll(/<td([^>]*)>([\s\S]*?)<\/td>/g)].map(([, attrs, inner]) => ({
      text: decode(inner),
      rowspan: +(attrs.match(/rowspan="(\d+)"/)?.[1] ?? 1),
      colspan: +(attrs.match(/colspan="(\d+)"/)?.[1] ?? 1),
    })),
  );
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') (cur += '"'), i++;
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') row.push(cur), (cur = '');
    else if (ch === '\n') row.push(cur), rows.push(row), (row = []), (cur = '');
    else if (ch !== '\r') cur += ch;
  }
  if (cur || row.length) row.push(cur), rows.push(row);
  return rows;
}

let passed = 0;
const test = (name, fn) => {
  fn();
  passed++;
  console.log('✓', name);
};

// --- Unit test quy tắc ---
const S = (thu, ca, tuan, room = 'LT-A.101') => ({
  thu,
  ca,
  weeks: parseWeeks(tuan),
  kind: ['LMS', 'BTN'].includes(room) ? 'exempt' : room === 'HTT' ? 'online' : 'onsite',
});
test('parseWeeks', () => {
  assert.deepEqual(parseWeeks('1-15'), [[1, 15]]);
  assert.deepEqual(parseWeeks('3'), [[3, 3]]);
  assert.deepEqual(parseWeeks('1-5, 7-9'), [[1, 5], [7, 9]]);
  assert.equal(parseWeeks('x'), null);
});
test('cùng thứ/ca, tuần giao nhau -> trùng', () => assert.ok(sessionsConflict(S(3, 2, '1-15'), S(3, 2, '10-12'))));
test('cùng thứ/ca, tuần rời nhau -> không trùng', () => assert.ok(!sessionsConflict(S(2, 3, '2-3'), S(2, 3, '11-15'))));
test('tuần giáp nhau 1-8 / 8-14 -> trùng tuần 8', () => assert.ok(sessionsConflict(S(4, 1, '1-8'), S(4, 1, '8-14'))));
test('BTN/LMS không tính trùng', () => {
  assert.ok(!sessionsConflict(S(3, 3, '1-15', 'BTN'), S(3, 3, '1-15')));
  assert.ok(!sessionsConflict(S(3, 3, '1-15'), S(3, 3, '1-15', 'LMS')));
});
test('HTT (online) vẫn tính trùng', () => assert.ok(sessionsConflict(S(5, 1, '1-15', 'HTT'), S(5, 1, '2-4'))));
test('khác ca / khác thứ -> không trùng', () => {
  assert.ok(!sessionsConflict(S(3, 2, '1-15'), S(3, 3, '1-15')));
  assert.ok(!sessionsConflict(S(3, 2, '1-15'), S(4, 2, '1-15')));
});

// --- Dữ liệu thật ---
const [apiPath, csvPath] = process.argv.slice(2);
if (!apiPath) {
  console.log(`\n${passed} test qua (bỏ qua test dữ liệu thật: chưa truyền api.json)`);
  process.exit(0);
}
const { html } = JSON.parse(readFileSync(apiPath, 'utf8'));
const data = parseGrid(buildGrid(extractRows(html)));
console.log(`rows=${data.rows.length} sections=${data.sections.size} courses=${data.courses.size} warnings=${data.warnings.length}`);
data.warnings.slice(0, +(process.env.SHOW_WARN ?? 10)).forEach((w) => console.log('  !', w));

if (csvPath) {
  test('khớp từng dòng với CSV export', () => {
    const csv = parseCsv(readFileSync(csvPath, 'utf8'));
    const h = csv.findIndex((r) => r[0] === 'STT');
    const csvRows = csv.slice(h + 2).filter((r) => /^\d{6,}$/.test((r[1] ?? '').trim()));
    assert.equal(data.rows.length, csvRows.length);
    const keys = ['stt', 'maLop', 'maHP', 'tenHP', 'gv', 'tc', 'lt', 'th', 'tl', 'thu', 'ca', 'tietCa', 'phong', 'tuan', 'batDau', 'ketThuc', 'ghiChu', 'ctdt'];
    csvRows.forEach((r, i) => {
      keys.forEach((k, j) => {
        const want = (r[j] ?? '').replace(/\s+/g, ' ').trim();
        const got = k === 'maLop' || k === 'maHP' ? data.rows[i][k] : data.rows[i][k];
        assert.equal(got, k === 'maLop' || k === 'maHP' ? want.replace(/\s/g, '') : want, `dòng ${i} cột ${k}`);
      });
    });
  });
}

// --- Solver so với brute-force ---
function evalBrute(secs) {
  // tính điểm độc lập với solver, theo cùng định nghĩa
  const occ = new Map();
  for (const sec of secs)
    for (const s of sec.sessions) {
      if (s.kind === 'exempt') continue;
      for (const [a, b] of s.weeks)
        for (let w = a; w <= b; w++) {
          const k = `${w}|${s.thu}`;
          if (!occ.has(k)) occ.set(k, new Set());
          occ.get(k).add(s.ca);
        }
    }
  const byWeek = new Map();
  for (const [k, cas] of occ) {
    const [w, d] = k.split('|').map(Number);
    if (!byWeek.has(w)) byWeek.set(w, []);
    byWeek.get(w).push([d, cas]);
  }
  let gaps = 0, days = 0, idle = 0;
  for (const list of byWeek.values()) {
    const ds = list.map((x) => x[0]);
    days += ds.length;
    gaps += Math.max(...ds) - Math.min(...ds) + 1 - ds.length;
    for (const [, cas] of list) idle += Math.max(...cas) - Math.min(...cas) + 1 - cas.size;
  }
  const W = DEFAULT_WEIGHTS;
  return W.gap * gaps + W.days * days + W.idle * idle;
}

function brute(courses) {
  let bestScore = Infinity, count = 0;
  const rec = (i, picked) => {
    if (i === courses.length) {
      count++;
      bestScore = Math.min(bestScore, evalBrute(picked));
      return;
    }
    for (const sec of courses[i].sections) {
      if (picked.some((p) => sectionConflicts(p, sec).length)) continue;
      rec(i + 1, [...picked, sec]);
    }
  };
  rec(0, []);
  return { bestScore, count };
}

const scheduled = [...data.courses.values()].filter((c) => c.sections.every((s) => s.sessions.length && !s.invalid && !s.onTap));
let rng = 12345;
const rand = () => ((rng = (rng * 1103515245 + 12345) % 2147483648) / 2147483648);
test('solver tối ưu = brute-force (40 bộ môn ngẫu nhiên)', () => {
  for (let t = 0; t < 40; t++) {
    const k = 3 + Math.floor(rand() * 4);
    const pick = [];
    while (pick.length < k) {
      const c = scheduled[Math.floor(rand() * scheduled.length)];
      if (!pick.includes(c) && c.sections.length <= 12) pick.push(c);
    }
    const b = brute(pick);
    const r = solve({ courses: pick, topK: 5, timeLimitMs: 60000 });
    if (b.count === 0) {
      assert.equal(r.solutions.length, 0);
      continue;
    }
    assert.ok(r.stats.complete);
    assert.equal(r.solutions[0].score, b.bestScore, `bộ ${pick.map((c) => c.maHP)}`);
    // mọi phương án trả về đều không trùng
    for (const sol of r.solutions) {
      const secs = sol.picks.map((p) => data.sections.get(p.maLops[0]));
      for (let i = 0; i < secs.length; i++)
        for (let j = i + 1; j < secs.length; j++) assert.equal(sectionConflicts(secs[i], secs[j]).length, 0);
      // các lớp tương đương phải có cùng lịch
      for (const p of sol.picks)
        for (const m of p.maLops) assert.equal(evalBrute([data.sections.get(m)]), evalBrute([data.sections.get(p.maLops[0])]));
    }
  }
});

console.log(`\n${passed} test qua`);
