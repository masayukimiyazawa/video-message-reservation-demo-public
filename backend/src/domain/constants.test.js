import {
  ReservationStatus,
  RESERVATION_STATUSES,
  SupportedLanguage,
  SUPPORTED_LANGUAGES,
  Role,
  AuthAction,
} from './constants.js';

describe('domain constants (Task 1 foundation)', () => {
  test('予約状態 enum は 4 状態を持つ', () => {
    expect(RESERVATION_STATUSES).toEqual([
      ReservationStatus.PENDING,
      ReservationStatus.CONFIRMED,
      ReservationStatus.CANCELLED,
      ReservationStatus.COMPLETED,
    ]);
  });

  test('対応言語は { en, ja } のみ (要件 6.4)', () => {
    expect(SUPPORTED_LANGUAGES).toEqual(['en', 'ja']);
    expect(SupportedLanguage.EN).toBe('en');
    expect(SupportedLanguage.JA).toBe('ja');
  });

  test('ロールは管理者/スタッフ (要件 5)', () => {
    expect(Role.ADMINISTRATOR).toBe('administrator');
    expect(Role.STAFF).toBe('staff');
  });

  test('録画の閲覧アクションが定義されている (要件 5.2 / 7)', () => {
    // ルートが参照する AuthAction が undefined のままだと認可が黙って素通りする。
    expect(AuthAction.VIEW_RECORDING).toBe('view_recording');
    // 文字列値の重複が無いこと（取り違え防止）。
    const values = Object.values(AuthAction);
    expect(new Set(values).size).toBe(values.length);
  });

  test('定数オブジェクトは凍結され不変である', () => {
    expect(Object.isFrozen(ReservationStatus)).toBe(true);
    expect(Object.isFrozen(SupportedLanguage)).toBe(true);
  });
});
