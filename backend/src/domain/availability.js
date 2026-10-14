/**
 * 空き判定ドメインロジック (要件 1.5 / Property 3)
 *
 * 副作用を持たない純粋関数。既存予約集合と希望予約枠を受け取り、
 * 希望枠が既存予約と重複するかどうかを判定する。
 * 重複時は `available: false` と 1 つ以上の非重複な代替候補を返し、
 * 重複しないときのみ `available: true` を返す。
 *
 * @typedef {import('./types.js').Slot} Slot
 * @typedef {import('./types.js').AvailabilityResult} AvailabilityResult
 */

/** 生成する代替候補の最大件数 */
const MAX_ALTERNATIVES = 3;

/**
 * Slot の start/end をミリ秒のエポック数へ正規化する。
 * Date インスタンスと ISO 文字列・数値の双方を受け付ける。
 * @param {Date|string|number} value
 * @returns {number}
 */
function toMillis(value) {
  if (value instanceof Date) return value.getTime();
  return new Date(value).getTime();
}

/**
 * 2 つの区間が重複するか判定する。
 * 区間は半開区間 [start, end) として扱い、端点の接触（前の end == 次の start）は
 * 重複とみなさない。
 * @param {number} aStart
 * @param {number} aEnd
 * @param {number} bStart
 * @param {number} bEnd
 * @returns {boolean}
 */
function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

/**
 * 希望枠が既存予約集合のいずれかと重複するか判定する。
 * @param {number} start
 * @param {number} end
 * @param {Array<{start: number, end: number}>} normalizedExisting
 * @returns {boolean}
 */
function hasConflict(start, end, normalizedExisting) {
  return normalizedExisting.some((slot) => overlaps(start, end, slot.start, slot.end));
}

/**
 * 空き判定 (要件 1.5 / Property 3)
 *
 * 希望枠が既存予約と重複する場合は `available: false` と、
 * 既存予約のいずれとも重複しない代替候補を 1 件以上返す。
 * 重複しない場合は `available: true` と空の代替候補配列を返す。
 *
 * 純粋関数であり、引数を変更せず外部状態にも依存しない。
 *
 * @param {Slot[]} existing - 既存予約枠の集合
 * @param {Slot} requestedSlot - 希望する予約枠
 * @returns {AvailabilityResult} { available, alternatives }
 */
export function checkAvailability(existing, requestedSlot) {
  const existingList = Array.isArray(existing) ? existing : [];
  const normalizedExisting = existingList.map((slot) => ({
    start: toMillis(slot.start),
    end: toMillis(slot.end),
  }));

  const reqStart = toMillis(requestedSlot.start);
  const reqEnd = toMillis(requestedSlot.end);

  if (!hasConflict(reqStart, reqEnd, normalizedExisting)) {
    return { available: true, alternatives: [] };
  }

  const alternatives = generateAlternatives(reqStart, reqEnd, normalizedExisting);
  return { available: false, alternatives };
}

/**
 * 重複しない代替候補を生成する。
 *
 * 希望枠と同じ長さの枠を、希望枠の直後から順に探索し、
 * 既存予約と重複しない枠を最大 MAX_ALTERNATIVES 件収集する。
 * 空き枠が見つかった場合は次の探索開始点をその枠の終端に進める。
 * 必ず 1 件以上の非重複候補を返すことを保証する。
 *
 * @param {number} reqStart
 * @param {number} reqEnd
 * @param {Array<{start: number, end: number}>} normalizedExisting
 * @returns {Slot[]}
 */
function generateAlternatives(reqStart, reqEnd, normalizedExisting) {
  const duration = Math.max(reqEnd - reqStart, 1);
  const alternatives = [];

  // 既存予約を開始時刻順に並べ、その終端を候補開始点の起点とする。
  const sorted = [...normalizedExisting].sort((a, b) => a.start - b.start);
  const conflictEnds = sorted.map((slot) => slot.end);

  // 探索起点候補: 希望枠の終端、および各既存予約の終端。
  const candidateStarts = [reqEnd, ...conflictEnds];

  for (const base of candidateStarts) {
    let start = base;
    // base 起点から順に、重複しない枠を探す。
    for (let i = 0; i < normalizedExisting.length + 1; i += 1) {
      const end = start + duration;
      if (!hasConflict(start, end, normalizedExisting)) {
        addAlternative(alternatives, start, end);
        break;
      }
      // 重複した既存予約の終端まで開始点を進める。
      const blocking = normalizedExisting
        .filter((slot) => overlaps(start, end, slot.start, slot.end))
        .reduce((max, slot) => Math.max(max, slot.end), start);
      start = blocking;
    }
    if (alternatives.length >= MAX_ALTERNATIVES) break;
  }

  // フォールバック: 万一候補が得られなかった場合、
  // すべての既存予約の後方に確実に非重複な枠を 1 件生成する。
  if (alternatives.length === 0) {
    const latestEnd = normalizedExisting.reduce((max, slot) => Math.max(max, slot.end), reqEnd);
    addAlternative(alternatives, latestEnd, latestEnd + duration);
  }

  return alternatives;
}

/**
 * 候補配列へ、Date 化した Slot を重複なく追加する。
 * @param {Slot[]} alternatives
 * @param {number} startMs
 * @param {number} endMs
 */
function addAlternative(alternatives, startMs, endMs) {
  const exists = alternatives.some(
    (slot) => toMillis(slot.start) === startMs && toMillis(slot.end) === endMs,
  );
  if (!exists && alternatives.length < MAX_ALTERNATIVES) {
    alternatives.push({ start: new Date(startMs), end: new Date(endMs) });
  }
}
