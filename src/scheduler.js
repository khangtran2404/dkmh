// Xét trùng lịch + tìm tổ hợp TKB tốt nhất. Thuần JS, dùng được trong Worker và Node.
//
// Quy tắc trùng: hai buổi trùng khi cùng thứ, cùng ca, có ít nhất 1 tuần chung,
// và không buổi nào ở phòng LMS/BTN (theo lưu ý của trường).

export const DAY_NAMES = { 2: 'Thứ 2', 3: 'Thứ 3', 4: 'Thứ 4', 5: 'Thứ 5', 6: 'Thứ 6', 7: 'Thứ 7', 8: 'CN' };
export const BUOI = { 1: 'sang', 2: 'sang', 3: 'chieu', 4: 'chieu', 5: 'toi' };

export const DEFAULT_WEIGHTS = { gap: 100, days: 10, idle: 3, pref: 1 };

const weeksOverlap = (a, b) => a.some(([a1, a2]) => b.some(([b1, b2]) => a1 <= b2 && b1 <= a2));

export function sessionsConflict(s, t) {
  return (
    s.kind !== 'exempt' &&
    t.kind !== 'exempt' &&
    s.thu === t.thu &&
    s.ca === t.ca &&
    weeksOverlap(s.weeks, t.weeks)
  );
}

/** Danh sách cặp buổi trùng giữa hai lớp (rỗng = không trùng) */
export function sectionConflicts(a, b) {
  const out = [];
  for (const s of a.sessions) for (const t of b.sessions) if (sessionsConflict(s, t)) out.push([s, t]);
  return out;
}

// Chữ ký lịch học: các lớp cùng môn có cùng chữ ký là tương đương nhau khi xếp lịch
const signature = (sec) =>
  sec.sessions
    .map((s) => `${s.thu}|${s.ca}|${s.weeks.map((w) => w.join('-')).join(',')}|${s.kind}`)
    .sort()
    .join(';');

function weekList(weeks, maxWeek) {
  const out = [];
  for (const [a, b] of weeks) for (let w = a; w <= Math.min(b, maxWeek); w++) out.push(w);
  return out;
}

/**
 * input: { courses: [{maHP, tenHP, sections:[...]}], weights, countOnline, prefBuoi, topK, timeLimitMs }
 * Mỗi section phải đã qua bộ lọc. Trả về { solutions, stats, diagnosis }.
 */
export function solve(input) {
  const {
    courses,
    weights = DEFAULT_WEIGHTS,
    countOnline = true,
    prefBuoi = [],
    topK = 20,
    timeLimitMs = 8000,
  } = input;
  const t0 = Date.now();

  let maxWeek = 1;
  for (const c of courses)
    for (const sec of c.sections) for (const s of sec.sessions) for (const [, b] of s.weeks) maxWeek = Math.max(maxWeek, b);
  const DAYS = 9; // index thứ 2..8
  const cellCount = (maxWeek + 1) * DAYS;

  // 1) Gom lớp tương đương thành nhóm
  const empty = courses.filter((c) => c.sections.length === 0);
  if (empty.length) {
    return {
      solutions: [],
      stats: { elapsed: 0, leaves: 0, complete: true },
      diagnosis: { emptyCourses: empty.map((c) => c.maHP), pairs: [] },
    };
  }

  const groupsByCourse = courses.map((c, ci) => {
    const bySig = new Map();
    for (const sec of c.sections) {
      const sig = signature(sec);
      if (!bySig.has(sig)) bySig.set(sig, []);
      bySig.get(sig).push(sec);
    }
    return [...bySig.values()].map((secs) => {
      const sessions = secs[0].sessions;
      // ô (tuần, thứ) -> bitmask ca, dùng để chấm điểm
      const occ = new Map();
      let prefMiss = 0;
      for (const s of sessions) {
        if (s.kind === 'exempt' || (s.kind === 'online' && !countOnline)) continue;
        for (const w of weekList(s.weeks, maxWeek)) {
          const k = w * DAYS + s.thu;
          occ.set(k, (occ.get(k) ?? 0) | (1 << s.ca));
          if (prefBuoi.length && !prefBuoi.includes(BUOI[s.ca])) prefMiss++;
        }
      }
      return { course: ci, sections: secs, sessions, occKeys: [...occ.keys()], occVals: [...occ.values()], prefMiss };
    });
  });

  // 2) Ma trận trùng giữa mọi cặp nhóm
  const all = groupsByCourse.flat();
  all.forEach((g, i) => (g.id = i));
  const n = all.length;
  const conflict = new Uint8Array(n * n);
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++) {
      if (all[i].course === all[j].course) continue;
      if (sectionConflicts(all[i], all[j]).length) conflict[i * n + j] = conflict[j * n + i] = 1;
    }

  // Môn ít lựa chọn xếp trước; trong môn, nhóm ít ngày học xếp trước để sớm có lời giải tốt
  const order = groupsByCourse
    .map((gs, ci) => ({ ci, gs: [...gs].sort((a, b) => a.occKeys.length - b.occKeys.length) }))
    .sort((a, b) => a.gs.length - b.gs.length);
  const depthN = order.length;

  // 3) Backtracking + branch-and-bound
  const cells = new Uint8Array(cellCount); // bitmask ca theo (tuần, thứ)
  const cellCnt = new Uint16Array(cellCount); // số nhóm đang dùng ô (để gỡ khi quay lui)
  const cellsByCa = Array.from({ length: cellCount }, () => new Uint8Array(8)); // đếm theo từng ca
  const chosen = new Array(depthN);
  let daysUsed = 0; // tổng (tuần, thứ) có học — đơn điệu tăng => dùng làm cận dưới
  let prefTotal = 0;
  const best = [];
  let leaves = 0;
  let nodes = 0;
  let timedOut = false;

  const worst = () => (best.length < topK ? Infinity : best[best.length - 1].score);

  function add(g, sign) {
    for (let i = 0; i < g.occKeys.length; i++) {
      const k = g.occKeys[i];
      const mask = g.occVals[i];
      const counts = cellsByCa[k];
      if (sign > 0) {
        if (cellCnt[k]++ === 0) daysUsed++;
        for (let ca = 0; ca < 8; ca++) if (mask & (1 << ca)) counts[ca]++;
      } else {
        if (--cellCnt[k] === 0) daysUsed--;
        for (let ca = 0; ca < 8; ca++) if (mask & (1 << ca)) counts[ca]--;
      }
      let m = 0;
      for (let ca = 0; ca < 8; ca++) if (counts[ca]) m |= 1 << ca;
      cells[k] = m;
    }
    prefTotal += sign * g.prefMiss;
  }

  function evaluate() {
    let gaps = 0;
    let days = 0;
    let idle = 0;
    let activeWeeks = 0;
    const pattern = new Set();
    for (let w = 1; w <= maxWeek; w++) {
      let lo = 99;
      let hi = -1;
      let cnt = 0;
      for (let d = 2; d < DAYS; d++) {
        const m = cells[w * DAYS + d];
        if (!m) continue;
        cnt++;
        pattern.add(d);
        if (d < lo) lo = d;
        if (d > hi) hi = d;
        const first = 31 - Math.clz32(m & -m);
        const last = 31 - Math.clz32(m);
        let bits = 0;
        for (let x = m; x; x &= x - 1) bits++;
        idle += last - first + 1 - bits;
      }
      if (cnt) {
        activeWeeks++;
        days += cnt;
        gaps += hi - lo + 1 - cnt;
      }
    }
    const score = weights.gap * gaps + weights.days * days + weights.idle * idle + weights.pref * prefTotal;
    return { score, gaps, days, idle, pref: prefTotal, activeWeeks, pattern: [...pattern].sort((a, b) => a - b) };
  }

  function dfs(depth) {
    if (timedOut) return;
    if ((++nodes & 1023) === 0 && Date.now() - t0 > timeLimitMs) {
      timedOut = true;
      return;
    }
    if (depth === depthN) {
      leaves++;
      const ev = evaluate();
      if (ev.score >= worst()) return;
      const sol = { ...ev, groups: chosen.slice() };
      let i = best.length;
      best.push(sol);
      while (i > 0 && best[i - 1].score > sol.score) {
        best[i] = best[i - 1];
        i--;
      }
      best[i] = sol;
      if (best.length > topK) best.pop();
      return;
    }
    for (const g of order[depth].gs) {
      let ok = true;
      for (let d = 0; d < depth; d++)
        if (conflict[g.id * n + chosen[d].id]) {
          ok = false;
          break;
        }
      if (!ok) continue;
      add(g, 1);
      // Cận dưới: số ngày học chỉ tăng thêm khi xếp tiếp
      if (weights.days * daysUsed + weights.pref * prefTotal < worst()) {
        chosen[depth] = g;
        dfs(depth + 1);
      }
      add(g, -1);
      if (timedOut) return;
    }
  }
  dfs(0);

  const solutions = best.map((s) => ({
    score: s.score,
    gaps: s.gaps,
    days: s.days,
    idle: s.idle,
    pref: s.pref,
    activeWeeks: s.activeWeeks,
    pattern: s.pattern,
    // theo đúng thứ tự môn người dùng chọn
    picks: [...s.groups]
      .sort((a, b) => a.course - b.course)
      .map((g) => ({ maHP: courses[g.course].maHP, maLops: g.sections.map((x) => x.maLop) })),
  }));

  let diagnosis = null;
  if (!solutions.length && !timedOut) {
    // Cặp môn mà mọi lựa chọn đều trùng nhau
    const pairs = [];
    for (let a = 0; a < groupsByCourse.length; a++)
      for (let b = a + 1; b < groupsByCourse.length; b++) {
        const allClash = groupsByCourse[a].every((ga) => groupsByCourse[b].every((gb) => conflict[ga.id * n + gb.id]));
        if (allClash) pairs.push([courses[a].maHP, courses[b].maHP]);
      }
    diagnosis = { emptyCourses: [], pairs };
  }

  return {
    solutions,
    stats: {
      elapsed: Date.now() - t0,
      leaves,
      nodes,
      complete: !timedOut,
      groups: groupsByCourse.map((gs, i) => ({ maHP: courses[i].maHP, groups: gs.length, sections: courses[i].sections.length })),
    },
    diagnosis,
  };
}
