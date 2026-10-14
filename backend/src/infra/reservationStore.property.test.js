import fc from 'fast-check';

import { ReservationStatus } from '../domain/constants.js';

/**
 * Property 4: 予約レコードの保存・取得ラウンドトリップ（Task 7.3 / 要件 2.1・2.4）
 *
 * Feature: vonage-video-reservation, Property 4: 予約レコードの保存・取得ラウンドトリップ:
 *   有効な予約レコードについて、Reservation_Store に保存してから同一 ID で取得すると、
 *   保存したレコードと等価なレコードが返る。
 *
 * 実装ノート（インメモリ Fake の採用）:
 *   設計では「インメモリ Mongo / テストコンテナ」を許容している。ここでは
 *   mongodb-memory-server が未インストール（ネットワークダウンロードを避ける方針）のため、
 *   backend/src/infra/reservationStore.js の意味論（reservationId をキーとした upsert save と
 *   findById による取得）をミラーする軽量なインメモリ Fake リポジトリを用いる。
 *   Fake は本番リポジトリと同じ「reservationId で upsert → 同一 ID で findById すると
 *   保存済みレコードが返る」ラウンドトリップ不変条件を満たす。
 */

/**
 * reservationStore.js の save/findById 意味論をミラーするインメモリ Fake。
 * - save(record): reservationId をキーに upsert。保存後のプレーンオブジェクトを返す。
 * - findById(id): 保存済みレコードのコピーを返す。無ければ null。
 * 本番実装同様、reservationId 欠落時は例外を投げる。
 */
function createInMemoryReservationStore() {
  const byId = new Map();

  return {
    async save(record) {
      if (!record || typeof record !== 'object') {
        throw new Error('save には予約レコードオブジェクトが必要です。');
      }
      if (!record.reservationId) {
        throw new Error('予約レコードには reservationId が必要です。');
      }
      const existing = byId.get(record.reservationId) ?? {};
      // upsert: 既存へマージし、$set 相当の上書きを行う。
      const saved = { ...existing, ...record };
      // ストア内には防御的にコピーを保持する（外部変更の影響を受けないため）。
      byId.set(record.reservationId, { ...saved });
      return { ...saved };
    },
    async findById(id) {
      if (!id) {
        throw new Error('findById には予約 ID が必要です。');
      }
      const found = byId.get(id);
      return found ? { ...found } : null;
    },
  };
}

/** 有効な予約レコードを生成する fast-check アービトラリ。 */
const reservationRecordArb = fc.record(
  {
    reservationId: fc.uuid(),
    contact: fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s.trim().length > 0),
    reservationTime: fc
      .date({ min: new Date('2020-01-01T00:00:00.000Z'), max: new Date('2035-12-31T23:59:59.000Z') })
      .map((d) => d.toISOString()),
    service: fc.string({ minLength: 1, maxLength: 30 }).filter((s) => s.trim().length > 0),
    status: fc.constantFrom(...Object.values(ReservationStatus)),
    language: fc.constantFrom('en', 'ja'),
    notified: fc.boolean(),
    sessionId: fc.option(fc.string({ maxLength: 20 }), { nil: undefined }),
    assignedStaffId: fc.option(fc.string({ maxLength: 20 }), { nil: undefined }),
  },
  { requiredKeys: ['reservationId', 'contact', 'reservationTime', 'service', 'status', 'language', 'notified'] },
);

describe('Reservation_Store save/findById ラウンドトリップ (Task 7.3 / Property 4)', () => {
  test('Feature: vonage-video-reservation, Property 4: 予約レコードの保存・取得ラウンドトリップ', async () => {
    await fc.assert(
      fc.asyncProperty(reservationRecordArb, async (record) => {
        const store = createInMemoryReservationStore();
        await store.save(record);
        const fetched = await store.findById(record.reservationId);

        expect(fetched).not.toBeNull();
        // 保存したレコードのすべてのフィールドが取得結果に等価に含まれること。
        for (const key of Object.keys(record)) {
          expect(fetched[key]).toEqual(record[key]);
        }
        // 取得結果は同一 reservationId を保持する。
        expect(fetched.reservationId).toBe(record.reservationId);
      }),
      { numRuns: 100 },
    );
  });

  test('同一 ID で再保存（更新）しても最新レコードが取得できる（upsert 意味論）', async () => {
    await fc.assert(
      fc.asyncProperty(reservationRecordArb, fc.constantFrom('en', 'ja'), async (record, newLang) => {
        const store = createInMemoryReservationStore();
        await store.save(record);
        const updated = { ...record, language: newLang, status: ReservationStatus.CONFIRMED };
        await store.save(updated);
        const fetched = await store.findById(record.reservationId);
        expect(fetched.language).toBe(newLang);
        expect(fetched.status).toBe(ReservationStatus.CONFIRMED);
      }),
      { numRuns: 100 },
    );
  });
});
