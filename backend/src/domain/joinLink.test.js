import {
  JOIN_LINK_GRACE_MS,
  JOIN_LINK_MIN_VALID_MS,
  JOIN_PATH_PREFIX,
  JoinTokenErrorCode,
  buildJoinUrl,
  computeJoinLinkExpiry,
  evaluateJoinToken,
  isJoinTokenUsable,
} from './joinLink.js';

describe('domain joinLink 定数の一致', () => {
  test('joinLink.js の JoinTokenErrorCode は constants.js と同一の値を持つ', async () => {
    const constants = await import('./constants.js');

    // 二重定義の事故を防ぐため、両者が常に一致することを固定する。
    expect(JoinTokenErrorCode).toEqual(constants.JoinTokenErrorCode);
  });
});

describe('domain joinLink (入室 URL の組み立て)', () => {
  test('tokenId を /join/ 配上に乗せた URL を返す', () => {
    const url = buildJoinUrl('https://example.com', 'abc123');

    expect(url).toBe(`https://example.com${JOIN_PATH_PREFIX}abc123`);
  });

  test('origin の末尾スラッシュを二重に付けない', () => {
    expect(buildJoinUrl('https://example.com/', 'tok')).toBe('https://example.com/join/tok');
    expect(buildJoinUrl('https://example.com///', 'tok')).toBe('https://example.com/join/tok');
  });

  test('origin 側だけ不正な値でも例外を投げない', () => {
    expect(() => buildJoinUrl('', 'tok')).not.toThrow();
    expect(() => buildJoinUrl(undefined, 'tok')).not.toThrow();
  });
});

describe('domain computeJoinLinkExpiry (有効期限)', () => {
  const now = new Date('2026-01-01T00:00:00Z');

  test('予約時刻 + 猶予時間になる', () => {
    const reservationTime = new Date('2026-01-01T01:00:00Z');
    const expiry = computeJoinLinkExpiry(reservationTime, now);

    expect(expiry.getTime()).toBe(reservationTime.getTime() + JOIN_LINK_GRACE_MS);
  });

  test('予約時刻が過去でも最低有効時間を残す（即死にしない）', () => {
    // 通知が予定時刻より 5 時間遅れて送られたケース
    const reservationTime = new Date('2025-12-31T19:00:00Z');
    const expiry = computeJoinLinkExpiry(reservationTime, now);

    expect(expiry.getTime()).toBe(now.getTime() + JOIN_LINK_MIN_VALID_MS);
  });

  test('予約時刻が近い場合も「予約時刻 + 猶予」が優先される（遅い方を採用）', () => {
    const reservationTime = new Date('2026-01-01T00:05:00Z');
    const expiry = computeJoinLinkExpiry(reservationTime, now);

    // 予約時刻+3h > now+30分 なので猶予側が勝つ
    expect(expiry.getTime()).toBe(reservationTime.getTime() + JOIN_LINK_GRACE_MS);
  });

  test('予約時刻が不正なら現在時刻 + 猶予で決める', () => {
    const expiry = computeJoinLinkExpiry('not-a-date', now);

    // 予約時刻を now とみなすので now+3h。最低 30 分より長いため猶予側が勝つ
    expect(expiry.getTime()).toBe(now.getTime() + JOIN_LINK_GRACE_MS);
  });

  test('文字列・数値の入力でも同じ結果になる', () => {
    const byDate = computeJoinLinkExpiry('2026-01-01T01:00:00Z', now);
    const byMs = computeJoinLinkExpiry(Date.parse('2026-01-01T01:00:00Z'), now);

    expect(byDate.getTime()).toBe(byMs.getTime());
  });
});

describe('domain isJoinTokenUsable / evaluateJoinToken (利用可否判定)', () => {
  const now = new Date('2026-01-01T00:00:00Z');
  const future = new Date('2026-01-01T02:00:00Z');
  const past = new Date('2025-12-31T23:00:00Z');

  test('未消費・未無効化・期限内のトークンは利用できる', () => {
    const token = { consumedAt: null, invalidatedAt: null, expiresAt: future };

    expect(isJoinTokenUsable(token, now)).toBe(true);
    expect(evaluateJoinToken(token, now)).toEqual({ ok: true });
  });

  test('消費済みは ALREADY_USED', () => {
    const token = { consumedAt: new Date(), invalidatedAt: null, expiresAt: future };

    expect(isJoinTokenUsable(token, now)).toBe(false);
    expect(evaluateJoinToken(token, now)).toEqual({
      ok: false,
      code: JoinTokenErrorCode.ALREADY_USED,
    });
  });

  test('無効化済みは ROOM_CLOSED（消費判定より優先して識別できる）', () => {
    const token = { consumedAt: null, invalidatedAt: new Date(), expiresAt: future };

    expect(evaluateJoinToken(token, now)).toEqual({
      ok: false,
      code: JoinTokenErrorCode.ROOM_CLOSED,
    });
  });

  test('期限切れは EXPIRED（境界のちょうど同じ時刻も不可）', () => {
    expect(evaluateJoinToken({ expiresAt: past }, now).code).toBe(JoinTokenErrorCode.EXPIRED);
    expect(evaluateJoinToken({ expiresAt: now }, now).code).toBe(JoinTokenErrorCode.EXPIRED);
  });

  test('null は NOT_FOUND', () => {
    expect(evaluateJoinToken(null, now)).toEqual({ ok: false, code: JoinTokenErrorCode.NOT_FOUND });
    expect(isJoinTokenUsable(null, now)).toBe(false);
  });

  test('expiresAt 不正は安全側に倒して不可にする', () => {
    expect(evaluateJoinToken({ expiresAt: 'broken' }, now).ok).toBe(false);
  });

  test('判定順序は 消費 > 無効化 > 期限 の順（両方があっても片方のコードを返す）', () => {
    // 消費済みかつ期限切れ → 消費を理由にする（利用者が「使用済み」を見るべき）
    const both = { consumedAt: new Date(), invalidatedAt: null, expiresAt: past };
    expect(evaluateJoinToken(both, now).code).toBe(JoinTokenErrorCode.ALREADY_USED);
  });
});
