// Đọc bảng TKB từ HTML của Google Sheet (pubhtml) -> danh sách buổi học, lớp học phần, môn học.
// Phần logic thuần (buildGrid, parseGrid) không phụ thuộc DOM để test được bằng Node.

export const DEFAULT_SHEET_URL =
  'https://docs.google.com/spreadsheets/d/e/2PACX-1vR8zy-lVDGNeZyfGiMJXQSxIDTZeuh6C93zK0TcRcK5k55NlgyP4-FWAWLNfRT83g/pubhtml';

// Phòng không tính trùng lịch (theo lưu ý của trường trong sheet)
export const NO_CONFLICT_ROOMS = ['LMS', 'BTN'];
export const ONLINE_ROOMS = ['HTT'];

export const COLUMNS = {
  stt: 'STT',
  maLop: 'Mã lớp HP',
  maHP: 'Mã HP',
  tenHP: 'Tên học phần',
  gv: 'Giảng viên',
  tc: 'Số TC',
  lt: 'LT',
  th: 'TH',
  tl: 'TL',
  thu: 'Thứ',
  ca: 'Ca',
  tietCa: 'Tiết/ca',
  phong: 'Phòng',
  tuan: 'Tuần',
  batDau: 'Bắt đầu',
  ketThuc: 'Kết thúc',
  ghiChu: 'Ghi chú',
  ctdt: 'CTĐT',
};
const REQUIRED = ['maLop', 'maHP', 'tenHP', 'thu', 'ca', 'phong', 'tuan'];

// Chuẩn hoá chữ để so khớp tiêu đề: in hoa, bỏ khoảng trắng, Ð (U+00D0) -> Đ
const norm = (s) => s.normalize('NFC').toUpperCase().replace(/Ð/g, 'Đ').replace(/\s+/g, '');

/** Lấy các dòng của <table> từ DOM: [[{text, rowspan, colspan}]] (bỏ cột <th> số dòng của Google). */
export function extractRowsFromTable(table) {
  const rows = [];
  for (const tr of table.querySelectorAll('tbody > tr, :scope > tr')) {
    const cells = [];
    for (const td of tr.children) {
      if (td.tagName !== 'TD') continue;
      const clone = td.cloneNode(true);
      clone.querySelectorAll('br').forEach((br) => br.replaceWith(' '));
      cells.push({
        text: clone.textContent,
        rowspan: +td.getAttribute('rowspan') || 1,
        colspan: +td.getAttribute('colspan') || 1,
      });
    }
    rows.push(cells);
  }
  return rows;
}

/** Dựng lưới chữ nhật, ô gộp (rowspan/colspan) được lặp lại giá trị vào mọi vị trí nó phủ. */
export function buildGrid(rawRows) {
  const grid = [];
  rawRows.forEach((cells, r) => {
    grid[r] ??= [];
    let c = 0;
    for (const cell of cells) {
      while (grid[r][c] !== undefined) c++;
      const text = cell.text.replace(/\s+/g, ' ').trim();
      for (let dr = 0; dr < cell.rowspan; dr++) {
        grid[r + dr] ??= [];
        for (let dc = 0; dc < cell.colspan; dc++) grid[r + dr][c + dc] = text;
      }
      c += cell.colspan;
    }
  });
  const width = Math.max(0, ...grid.map((row) => row.length));
  return grid.map((row) => Array.from({ length: width }, (_, i) => row[i] ?? ''));
}

function findHeader(grid) {
  for (let r = 0; r < grid.length - 1; r++) {
    const cells = grid[r].map(norm);
    if (cells.some((t) => t.includes('LỚPHỌCPHẦN')) && cells.some((t) => t.includes('TÊNHỌCPHẦN'))) return r;
  }
  return -1;
}

function mapColumns(top, sub) {
  const map = {};
  const set = (key, i) => {
    if (map[key] === undefined) map[key] = i;
  };
  top.forEach((t0, i) => {
    const t = norm(t0);
    const s = norm(sub[i] ?? '');
    // Ưu tiên dòng tiêu đề con (SỐ TIẾT -> LT/TH/TL; THỜI KHOÁ BIỂU -> THỨ/CA/...)
    if (s === 'LT') return set('lt', i);
    if (s === 'TH') return set('th', i);
    if (s === 'TL') return set('tl', i);
    if (s === 'THỨ') return set('thu', i);
    if (s.startsWith('CA')) return set('ca', i);
    if (s.includes('TIẾT/CA')) return set('tietCa', i);
    if (s.startsWith('PHÒNG')) return set('phong', i);
    if (s.startsWith('TUẦN')) return set('tuan', i);
    if (t === 'STT') return set('stt', i);
    if (t.includes('LỚPHỌCPHẦN')) return set('maLop', i);
    if (t.includes('TÊNHỌCPHẦN')) return set('tenHP', i);
    if (t.includes('MÃHỌCPHẦN') || t === 'MÃHP') return set('maHP', i);
    if (t.includes('GIẢNGVIÊN')) return set('gv', i);
    if (t.includes('SỐTC') || t.includes('TÍNCHỈ')) return set('tc', i);
    if (t.includes('BẮTĐẦU')) return set('batDau', i);
    if (t.includes('KẾTTHÚC')) return set('ketThuc', i);
    if (t.includes('GHICHÚ')) return set('ghiChu', i);
    if (t.includes('CTĐT') || t.includes('CHƯƠNGTRÌNH')) return set('ctdt', i);
  });
  return map;
}

/** "1-15" | "3" | "1-5,7-9" -> [[1,15]] ... ; null nếu không đọc được */
export function parseWeeks(s) {
  const t = String(s ?? '').replace(/\s+/g, '');
  if (!t) return null;
  const out = [];
  for (const part of t.split(/[,;]/)) {
    const m = part.match(/^(\d+)(?:-(\d+))?$/);
    if (!m) return null;
    const a = +m[1];
    const b = m[2] ? +m[2] : a;
    if (b < a) return null;
    out.push([a, b]);
  }
  return out;
}

function mergeRanges(ranges) {
  const sorted = ranges.map((r) => [...r]).sort((x, y) => x[0] - y[0]);
  const out = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]);
    else out.push(r);
  }
  return out;
}

/** "dd/mm/yyyy" -> số ngày kể từ epoch (UTC), null nếu trống */
export function parseDate(s) {
  const m = String(s ?? '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  return Math.round(Date.UTC(+m[3], +m[2] - 1, +m[1]) / 86400000);
}

export function formatDate(days) {
  const d = new Date(days * 86400000);
  return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`;
}

export function roomKind(room) {
  const r = room.trim().toUpperCase();
  if (NO_CONFLICT_ROOMS.includes(r)) return 'exempt';
  if (ONLINE_ROOMS.includes(r)) return 'online';
  return 'onsite';
}

/** Khu phòng: "LT-B.204" -> "LT", "HTT" -> "HTT" */
export const roomArea = (room) => room.split('-')[0].trim();

/**
 * Lưới -> { rows, sections, courses, warnings, semesterStart }
 * rows: mọi dòng dữ liệu gốc (đủ cột) để hiển thị đối chiếu.
 */
export function parseGrid(grid) {
  const h = findHeader(grid);
  if (h < 0) throw new Error('Không tìm thấy dòng tiêu đề (cần có cột "Mã lớp học phần" và "Tên học phần").');
  const col = mapColumns(grid[h], grid[h + 1] ?? []);
  const missing = REQUIRED.filter((k) => col[k] === undefined);
  if (missing.length) throw new Error('Thiếu cột: ' + missing.map((k) => COLUMNS[k]).join(', '));

  const get = (row, k) => (col[k] === undefined ? '' : row[col[k]] ?? '');
  const warnings = [];
  const rows = [];
  const sections = new Map();

  for (let r = h + 1; r < grid.length; r++) {
    const g = grid[r];
    const maLop = get(g, 'maLop').replace(/\s/g, '');
    if (!/^\d{6,}$/.test(maLop)) continue; // dòng tiêu đề con / chú thích / trống
    const rec = { line: r + 1 };
    for (const k of Object.keys(COLUMNS)) rec[k] = get(g, k);
    rec.maLop = maLop;
    rec.maHP = rec.maHP.replace(/\s/g, '');
    rows.push(rec);

    let sec = sections.get(maLop);
    if (!sec) {
      sec = {
        maLop,
        maHP: rec.maHP,
        tenHP: rec.tenHP,
        gv: new Set(),
        tc: rec.tc,
        ctdt: rec.ctdt,
        ghiChu: rec.ghiChu,
        onTap: /ôn tập/i.test(rec.ghiChu),
        sessions: [],
        unscheduled: false,
      };
      sections.set(maLop, sec);
    } else if (sec.maHP !== rec.maHP) {
      warnings.push(`Dòng ${rec.line}: lớp ${maLop} có mã HP khác nhau (${sec.maHP} / ${rec.maHP})`);
    }
    if (rec.gv) sec.gv.add(rec.gv);
    if (rec.ghiChu && !sec.ghiChu) sec.ghiChu = rec.ghiChu;
    if (/ôn tập/i.test(rec.ghiChu)) sec.onTap = true;

    const hasTime = rec.thu || rec.ca || rec.tuan;
    if (!hasTime) {
      sec.unscheduled = true;
      continue;
    }
    const thu = /^(cn|chủ nhật)$/i.test(rec.thu) ? 8 : parseInt(rec.thu, 10);
    const caM = rec.ca.match(/(\d+)/);
    const weeks = parseWeeks(rec.tuan);
    if (!(thu >= 2 && thu <= 8) || !caM || !weeks) {
      warnings.push(`Dòng ${rec.line}: lớp ${maLop} có lịch không đọc được (thứ "${rec.thu}", ca "${rec.ca}", tuần "${rec.tuan}") — lớp này bị loại khỏi xếp lịch`);
      sec.invalid = true;
      continue;
    }
    sec.sessions.push({
      thu,
      ca: +caM[1],
      tiet: parseInt(rec.tietCa, 10) || null,
      room: rec.phong,
      kind: roomKind(rec.phong),
      weeks,
      tuan: rec.tuan,
      start: parseDate(rec.batDau),
      end: parseDate(rec.ketThuc),
      line: rec.line,
    });
  }

  // Lớp có cả dòng có lịch lẫn dòng trống lịch: coi là có lịch (dòng trống chỉ là ghi chú)
  for (const sec of sections.values()) {
    if (sec.sessions.length) sec.unscheduled = false;
    sec.gv = [...sec.gv].join(', ');
  }

  const semesterStart = inferSemesterStart(sections, warnings);

  const courses = new Map();
  for (const sec of sections.values()) {
    let c = courses.get(sec.maHP);
    if (!c) {
      c = { maHP: sec.maHP, tenHP: sec.tenHP, tc: sec.tc, sections: [] };
      courses.set(sec.maHP, c);
    }
    c.sections.push(sec);
  }

  return { rows, sections, courses, warnings, semesterStart };
}

/**
 * Suy ra thứ 2 của tuần 1 từ (ngày bắt đầu, thứ, tuần bắt đầu) của các buổi, rồi kiểm tra
 * ngày bắt đầu/kết thúc của từng buổi có khớp với cột tuần không (để việc xét trùng theo tuần là đáng tin).
 */
function inferSemesterStart(sections, warnings) {
  const votes = new Map();
  const all = [...sections.values()].flatMap((s) => s.sessions);
  for (const s of all) {
    if (s.start == null) continue;
    const monday = s.start - (s.thu - 2) - (s.weeks[0][0] - 1) * 7;
    votes.set(monday, (votes.get(monday) ?? 0) + 1);
  }
  if (!votes.size) return null;
  const start = [...votes.entries()].sort((a, b) => b[1] - a[1])[0][0];
  for (const s of all) {
    const first = s.weeks[0][0];
    const last = s.weeks[s.weeks.length - 1][1];
    const expStart = start + (first - 1) * 7 + (s.thu - 2);
    const expEnd = start + (last - 1) * 7 + (s.thu - 2);
    if ((s.start != null && s.start !== expStart) || (s.end != null && s.end !== expEnd)) {
      s.dateMismatch = true;
      // Không rõ cột nào đúng -> xét trùng theo hợp của cả hai để không bỏ sót trùng lịch thật
      const weekOf = (d) => Math.floor((d - start) / 7) + 1;
      const a = s.start != null ? weekOf(s.start) : first;
      const b = s.end != null ? weekOf(s.end) : last;
      let note = 'chỉ xét theo cột tuần (ngày không hợp lệ)';
      if (a >= 1 && b >= a && b <= last + 26) {
        s.weeks = mergeRanges([...s.weeks, [a, b]]);
        note = `xét trùng theo cả tuần ${s.weeks.map((w) => (w[0] === w[1] ? w[0] : w.join('-'))).join(',')}`;
      }
      s.mismatchNote = `Sheet ghi tuần ${s.tuan} nhưng ngày ${s.start != null ? formatDate(s.start) : '?'}–${s.end != null ? formatDate(s.end) : '?'}; ${note}`;
      warnings.push(`Dòng ${s.line}: ${s.mismatchNote}`);
    }
  }
  return start;
}

/** Gọi proxy, trả về { sheets, gid, data } */
export async function loadSheet(url, { gid = '', nocache = false } = {}) {
  const qs = new URLSearchParams({ url });
  if (gid) qs.set('gid', gid);
  if (nocache) qs.set('nocache', '1');
  const res = await fetch('/api/sheet.php?' + qs);
  let body;
  try {
    body = await res.json();
  } catch {
    throw new Error(`Proxy lỗi (HTTP ${res.status})`);
  }
  if (!res.ok || body.error) throw new Error(body.error || `HTTP ${res.status}`);
  const doc = new DOMParser().parseFromString(body.html, 'text/html');
  const table = doc.querySelector('table');
  if (!table) throw new Error('Không tìm thấy bảng trong sheet');
  const data = parseGrid(buildGrid(extractRowsFromTable(table)));
  return { sheets: body.sheets, gid: body.gid, data };
}
