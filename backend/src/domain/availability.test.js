import { checkAvailability } from './availability.js';

/**
 * checkAvailability の例・エッジケースのユニットテスト (要件 1.5 / Property 3)
 * プロパティテスト (Task 3.3) はこれを補完する。
 */

/** ヘルパ: ISO 文字列から Slot を作る */
const slot = (start, end) => ({ start, end });

// 基準となる 1 時間枠
const base = slot('2025-01-01T10:00:00.000Z', '2025-01-01T11:00:00.000Z');

/** 代替候補がいずれの既存予約とも重複しないことを検証 */
function noneOverlap(alternatives, existing) {
  const toMs = (v) => new Date(v).getTime();
  return alternatives.every((alt) =>
    existing.every(
      (ex) => toMs(alt.start) >= toMs(ex.end) || toMs(alt.end) <= toMs(ex.start),
    ),
  );
}

describe('checkAvailability (Task 3.1 / 要件 1.5)', () => {
  test('既存予約が空なら available: true・代替なし', () => {
    const result = checkAvailability([], base);
    expect(result.available).toBe(true);
    expect(result.alternatives).toEqual([]);
  });

  test('既存予約と重複しなければ available: true', () => {
    const existing = [slot('2025-01-01T08:00:00.000Z', '2025-01-01T09:00:00.000Z')];
    const result = checkAvailability(existing, base);
    expect(result.available).toBe(true);
    expect(result.alternatives).toEqual([]);
  });

  test('端点が接触するだけ（前の end == 希望 start）は重複としない', () => {
    const existing = [slot('2025-01-01T09:00:00.000Z', '2025-01-01T10:00:00.000Z')];
    const result = checkAvailability(existing, base);
    expect(result.available).toBe(true);
  });

  test('完全に重複する場合 available: false と 1 件以上の代替を返す', () => {
    const existing = [base];
    const result = checkAvailability(existing, base);
    expect(result.available).toBe(false);
    expect(result.alternatives.length).toBeGreaterThanOrEqual(1);
    expect(noneOverlap(result.alternatives, existing)).toBe(true);
  });

  test('部分的に重複する場合も available: false と非重複代替を返す', () => {
    const existing = [slot('2025-01-01T10:30:00.000Z', '2025-01-01T11:30:00.000Z')];
    const result = checkAvailability(existing, base);
    expect(result.available).toBe(false);
    expect(result.alternatives.length).toBeGreaterThanOrEqual(1);
    expect(noneOverlap(result.alternatives, existing)).toBe(true);
  });

  test('連続する既存予約でも隙間の後方に非重複代替を見つける', () => {
    const existing = [
      slot('2025-01-01T10:00:00.000Z', '2025-01-01T11:00:00.000Z'),
      slot('2025-01-01T11:00:00.000Z', '2025-01-01T12:00:00.000Z'),
      slot('2025-01-01T12:00:00.000Z', '2025-01-01T13:00:00.000Z'),
    ];
    const result = checkAvailability(existing, base);
    expect(result.available).toBe(false);
    expect(result.alternatives.length).toBeGreaterThanOrEqual(1);
    expect(noneOverlap(result.alternatives, existing)).toBe(true);
  });

  test('Date インスタンス入力も受け付ける', () => {
    const existing = [
      slot(new Date('2025-01-01T10:00:00.000Z'), new Date('2025-01-01T11:00:00.000Z')),
    ];
    const requested = slot(
      new Date('2025-01-01T10:00:00.000Z'),
      new Date('2025-01-01T11:00:00.000Z'),
    );
    const result = checkAvailability(existing, requested);
    expect(result.available).toBe(false);
    expect(result.alternatives.length).toBeGreaterThanOrEqual(1);
    expect(noneOverlap(result.alternatives, existing)).toBe(true);
  });

  test('引数の既存配列を変更しない（純粋性）', () => {
    const existing = [base];
    const snapshot = JSON.stringify(existing);
    checkAvailability(existing, base);
    expect(JSON.stringify(existing)).toBe(snapshot);
  });
});
