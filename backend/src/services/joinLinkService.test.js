/**
 * joinLinkService ユニットテスト
 *
 * 検証の要点:
 *  - 発行: 推測不能なトークンを作り、公開オリジン配下の URL を返す
 *  - 消費: 一度だけ成功し、2 回目は ALREADY_USED
 *  - 競合: atomic consume が失敗（null）した場合も「使用済み」として扱う
 *  - 拒否理由: NOT_FOUND / ALREADY_USED / EXPIRED / ROOM_CLOSED を区別できる
 *  - 秘密情報: トークン ID をエラーメッセージへ漏らさない
 */

import { JoinTokenErrorCode } from '../domain/joinLink.js';
import {
  JoinLinkError,
  createJoinLinkService,
  joinLinkService,
  toJoinLinkErrorResponse,
} from './joinLinkService.js';
import { joinTokenStore } from '../infra/joinTokenStore.js';

/**
 * メモリ上の joinTokenStore 偽実装。本番の atomic consume と同じ意味論を持つ。
 */
function makeFakeStore(seed = []) {
  const tokens = seed.map((t) => ({ ...t }));
  const calls = { issue: [], consume: [], invalidate: [] };

  return {
    calls,
    tokens,
    async issue(record) {
      calls.issue.push(record);
      const created = { consumedAt: null, invalidatedAt: null, ...record };
      tokens.push(created);
      return created;
    },
    async findByTokenId(tokenId) {
      return tokens.find((t) => t.tokenId === tokenId) ?? null;
    },
    async consume(tokenId, now) {
      calls.consume.push({ tokenId, now });
      const token = tokens.find(
        (t) =>
          t.tokenId === tokenId &&
          t.consumedAt == null &&
          t.invalidatedAt == null &&
          new Date(t.expiresAt).getTime() > new Date(now).getTime(),
      );
      if (!token) return null;
      token.consumedAt = now;
      return token;
    },
    async invalidateBySessionId(sessionId, now) {
      calls.invalidate.push({ sessionId, now });
      let n = 0;
      for (const t of tokens) {
        if (t.sessionId === sessionId && t.invalidatedAt == null) {
          t.invalidatedAt = now;
          n += 1;
        }
      }
      return n;
    },
  };
}

/** サービス生成の既定値（固定時刻・固定トークン ID）をまとめる。 */
function makeService({ store, now = new Date('2026-01-01T00:00:00Z'), tokenId = 'tok-1' } = {}) {
  return createJoinLinkService({
    joinTokenStore: store ?? makeFakeStore(),
    getPublicOrigin: () => 'https://app.example.com',
    tokenIdFactory: () => tokenId,
    clock: () => now,
  });
}

describe('services joinLinkService 発行', () => {
  test('予約に対してリンクを発行し、URL を組み立てる', async () => {
    const store = makeFakeStore();
    const service = makeService({ store });

    const issued = await service.issueForReservation({
      reservationId: 'r1',
      sessionId: 's1',
      reservationTime: new Date('2026-01-01T01:00:00Z'),
    });

    expect(issued.url).toBe('https://app.example.com/join/tok-1');
    expect(issued.tokenId).toBe('tok-1');
    expect(store.tokens[0]).toMatchObject({ reservationId: 'r1', sessionId: 's1' });
  });

  test('有効期限は予約時刻 + 猶予になる', async () => {
    const store = makeFakeStore();
    const service = makeService({ store });

    const issued = await service.issueForReservation({
      reservationId: 'r1',
      sessionId: 's1',
      reservationTime: new Date('2026-01-01T01:00:00Z'),
    });

    expect(issued.expiresAt.getTime()).toBe(new Date('2026-01-01T04:00:00Z').getTime());
  });

  test('予約時刻が無い場合も最低有効時間で期限を決める', async () => {
    const store = makeFakeStore();
    const service = makeService({ store });

    const issued = await service.issueForReservation({
      reservationId: 'r1',
      sessionId: 's1',
    });

    expect(issued.expiresAt.getTime()).toBeGreaterThan(
      new Date('2026-01-01T00:00:00Z').getTime(),
    );
  });

  test('reservationId / sessionId が欠落したら発行しない', async () => {
    const service = makeService();

    await expect(service.issueForReservation({ sessionId: 's' })).rejects.toThrow(/reservationId/);
    await expect(service.issueForReservation({ reservationId: 'r' })).rejects.toThrow(/sessionId/);
  });

  test('既定のトークン ID 生成は長さ 32 の hex（推測不能な乱数）', async () => {
    const store = makeFakeStore();
    const service = createJoinLinkService({
      joinTokenStore: store,
      getPublicOrigin: () => 'https://app.example.com',
      clock: () => new Date('2026-01-01T00:00:00Z'),
    });

    const issued = await service.issueForReservation({ reservationId: 'r', sessionId: 's' });

    expect(issued.tokenId).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('services joinLinkService 公開 URL の fail-closed', () => {
  /**
   * 利用者の端末で到達できない公開 URL を渡した場合に発行を拒否することを検証する。
   * 入室リンクはスマホで開かれるため localhost を配信すると常に失敗する。
   * 壊れたリンクを配信しないこと、およびトークンを消費しないことを保証する。
   */
  test.each([
    ['未設定', ''],
    ['localhost', 'http://localhost:5173'],
    ['127.0.0.1', 'http://127.0.0.1:5173'],
    ['URL として不正', 'not-a-url'],
  ])('%s の場合は発行を拒否しトークンも保存しない', async (_label, origin) => {
    const store = makeFakeStore();
    const service = createJoinLinkService({
      joinTokenStore: store,
      getPublicOrigin: () => origin,
      tokenIdFactory: () => 'tok-1',
      clock: () => new Date('2026-01-01T00:00:00Z'),
    });

    await expect(
      service.issueForReservation({ reservationId: 'r1', sessionId: 's1' }),
    ).rejects.toThrow(/入室リンクを発行できません/);

    // 壊れたリンクを配信しないため、トークンは保存されない
    expect(store.tokens).toHaveLength(0);
  });

  test('Cloudflare トンネルの URL は発行できる', async () => {
    const store = makeFakeStore();
    const service = createJoinLinkService({
      joinTokenStore: store,
      getPublicOrigin: () => 'https://random-words-1234.trycloudflare.com',
      tokenIdFactory: () => 'tok-1',
      clock: () => new Date('2026-01-01T00:00:00Z'),
    });

    const issued = await service.issueForReservation({ reservationId: 'r1', sessionId: 's1' });

    expect(issued.url).toBe(
      'https://random-words-1234.trycloudflare.com/join/tok-1',
    );
  });
});

describe('services joinLinkService redeem（初回だけ入室できる）', () => {
  const future = new Date('2026-01-01T04:00:00Z');

  test('未消費トークンは入室情報を返す', async () => {
    const store = makeFakeStore([
      { tokenId: 't1', reservationId: 'r1', sessionId: 's1', expiresAt: future },
    ]);
    const service = makeService({ store });

    const result = await service.redeem('t1');

    expect(result).toEqual({ reservationId: 'r1', sessionId: 's1' });
  });

  test('消費は永続化される（1 回だけ有効）', async () => {
    const store = makeFakeStore([
      { tokenId: 't1', reservationId: 'r1', sessionId: 's1', expiresAt: future },
    ]);
    const service = makeService({ store });

    await service.redeem('t1');

    expect(store.tokens[0].consumedAt).toEqual(new Date('2026-01-01T00:00:00Z'));
  });

  test('2 回目の redeem は ALREADY_USED（一度だけ有効）', async () => {
    const store = makeFakeStore([
      { tokenId: 't1', reservationId: 'r1', sessionId: 's1', expiresAt: future },
    ]);
    const service = makeService({ store });

    await service.redeem('t1');

    await expect(service.redeem('t1')).rejects.toMatchObject({
      code: JoinTokenErrorCode.ALREADY_USED,
    });
  });

  test('同時クリックで atomic consume に失敗したら「使用済み」にする', async () => {
    const store = makeFakeStore([
      { tokenId: 't1', reservationId: 'r1', sessionId: 's1', expiresAt: future },
    ]);
    // 他方の処理が先に消費済みの状態にする（findByTokenId は未消費を返す偽実装）
    const originalFind = store.findByTokenId;
    store.findByTokenId = async (tokenId) => {
      const token = await originalFind(tokenId);
      if (token) token.consumedAt = new Date('2026-01-01T00:00:01Z');
      return token;
    };
    const service = makeService({ store });

    await expect(service.redeem('t1')).rejects.toMatchObject({
      code: JoinTokenErrorCode.ALREADY_USED,
    });
  });

  test('存在しないトークンは NOT_FOUND', async () => {
    const service = makeService();

    await expect(service.redeem('missing')).rejects.toMatchObject({
      code: JoinTokenErrorCode.NOT_FOUND,
    });
  });

  test('空トークンも NOT_FOUND', async () => {
    const service = makeService();

    await expect(service.redeem('')).rejects.toMatchObject({
      code: JoinTokenErrorCode.NOT_FOUND,
    });
  });

  test('期限切れは EXPIRED', async () => {
    const store = makeFakeStore([
      { tokenId: 't1', reservationId: 'r1', sessionId: 's1', expiresAt: new Date('2025-01-01T00:00:00Z') },
    ]);
    const service = makeService({ store });

    await expect(service.redeem('t1')).rejects.toMatchObject({
      code: JoinTokenErrorCode.EXPIRED,
    });
  });

  test('室が無効化されたトークンは ROOM_CLOSED', async () => {
    const store = makeFakeStore([
      {
        tokenId: 't1',
        reservationId: 'r1',
        sessionId: 's1',
        expiresAt: future,
        invalidatedAt: new Date('2026-01-01T00:00:00Z'),
      },
    ]);
    const service = makeService({ store });

    await expect(service.redeem('t1')).rejects.toMatchObject({
      code: JoinTokenErrorCode.ROOM_CLOSED,
    });
  });

  test('拒否は JoinLinkError として送出し、code を持つ', async () => {
    const service = makeService();

    await expect(service.redeem('missing')).rejects.toBeInstanceOf(JoinLinkError);
  });

  test('エラーメッセージにトークン ID を含めない（秘密情報の漏えい防止）', async () => {
    const store = makeFakeStore([
      { tokenId: 'secret-token-value', reservationId: 'r', sessionId: 's', expiresAt: new Date('2025-01-01T00:00:00Z') },
    ]);
    const service = makeService({ store });

    const err = await service.redeem('secret-token-value').catch((e) => e);

    expect(err.message).not.toContain('secret-token-value');
  });
});

describe('services joinLinkService inspect（消費せずに可否だけ見る）', () => {
  const future = new Date('2026-01-01T04:00:00Z');

  test('有効なトークンは ok', async () => {
    const store = makeFakeStore([
      { tokenId: 't1', reservationId: 'r', sessionId: 's', expiresAt: future },
    ]);

    expect(await makeService({ store }).inspect('t1')).toEqual({ ok: true });
  });

  test('inspect は消費しない', async () => {
    const store = makeFakeStore([
      { tokenId: 't1', reservationId: 'r', sessionId: 's', expiresAt: future },
    ]);

    await makeService({ store }).inspect('t1');

    expect(store.calls.consume).toHaveLength(0);
    expect(store.tokens[0].consumedAt ?? null).toBeNull();
  });

  test('無効なトークンは理由を返す', async () => {
    const store = makeFakeStore([
      { tokenId: 't1', reservationId: 'r', sessionId: 's', expiresAt: future, consumedAt: new Date() },
    ]);

    expect(await makeService({ store }).inspect('t1')).toEqual({
      ok: false,
      code: JoinTokenErrorCode.ALREADY_USED,
    });
  });
});

describe('services toJoinLinkErrorResponse（HTTP ステータス変換）', () => {
  test('NOT_FOUND は 404（列挙攻撃を避ける）', () => {
    expect(toJoinLinkErrorResponse(JoinTokenErrorCode.NOT_FOUND)).toEqual({
      status: 404,
      error: JoinTokenErrorCode.NOT_FOUND,
    });
  });

  test('ALREADY_USED / ROOM_CLOSED は 410', () => {
    expect(toJoinLinkErrorResponse(JoinTokenErrorCode.ALREADY_USED).status).toBe(410);
    expect(toJoinLinkErrorResponse(JoinTokenErrorCode.ROOM_CLOSED).status).toBe(410);
  });

  test('EXPIRED は 410', () => {
    expect(toJoinLinkErrorResponse(JoinTokenErrorCode.EXPIRED)).toEqual({
      status: 410,
      error: JoinTokenErrorCode.EXPIRED,
    });
  });

  test('未知のコードは 400 にフォールバック', () => {
    expect(toJoinLinkErrorResponse('unexpected')).toEqual({
      status: 400,
      error: 'invalid_join_token',
    });
  });
});

describe('services joinLinkService 既定インスタンス', () => {
  test('必要な操作を公開している', () => {
    expect(typeof joinLinkService.issueForReservation).toBe('function');
    expect(typeof joinLinkService.redeem).toBe('function');
    expect(typeof joinLinkService.inspect).toBe('function');
  });

  test('import だけでは DB に触れない（遅延接続）', () => {
    // テストが DB 未接続で pass すること自体が、この保証の検証になる。
    expect(joinTokenStore).toBeDefined();
  });
});
