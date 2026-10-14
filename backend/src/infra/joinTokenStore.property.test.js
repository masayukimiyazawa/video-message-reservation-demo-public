import { createJoinTokenStore } from './joinTokenStore.js';

/**
 * 本番と同じ意味論を持つ偽モデル。
 *  - create: 渡された値を保存し _id を付与する
 *  - findOne: 条件に一致する 1 件を返す
 *  - findOneAndUpdate: 条件に一致すれば更新し、{new:true} なら更新後の値を返す
 *  - updateMany: 条件に一致する BulkWriteResult を返す
 */
function makeFakeModel(seed = []) {
  const docs = seed.map((d, i) => ({ _id: `id${i}`, ...d }));
  const calls = { findOneAndUpdate: [], updateMany: [], create: [] };

  const matches = (doc, filter) =>
    Object.entries(filter).every(([key, cond]) => {
      if (cond && typeof cond === 'object' && '$gt' in cond) {
        return new Date(doc[key]).getTime() > new Date(cond.$gt).getTime();
      }
      return doc[key] === cond;
    });

  const model = {
    calls,
    docs,
    async create(record) {
      calls.create.push(record);
      const created = { _id: `new${docs.length}`, ...record };
      docs.push(created);
      return { toObject: () => created };
    },
    findOne(filter) {
      return { lean: async () => docs.find((d) => matches(d, filter)) ?? null };
    },
    find(filter) {
      return { lean: async () => docs.filter((d) => matches(d, filter)) };
    },
    findOneAndUpdate(filter, update) {
      calls.findOneAndUpdate.push({ filter, update });
      const idx = docs.findIndex((d) => matches(d, filter));
      if (idx === -1) {
        return { lean: async () => null };
      }
      const doc = docs[idx];
      if (update.$set) Object.assign(doc, update.$set);
      if (update.$min) {
        for (const [k, v] of Object.entries(update.$min)) {
          if (doc[k] == null || new Date(v) < new Date(doc[k])) doc[k] = v;
        }
      }
      if (update.$push) doc.connections.push(update.$push.connections);
      if (update.$pull) {
        doc.connections = doc.connections.filter(
          (c) => !matches(c, update.$pull.connections),
        );
      }
      return { lean: async () => doc };
    },
    async updateMany(filter, update) {
      calls.updateMany.push({ filter, update });
      let modified = 0;
      for (const doc of docs) {
        if (matches(doc, filter)) {
          if (doc[Object.keys(update.$set)[0]] == null) modified += 1;
          Object.assign(doc, update.$set);
        }
      }
      return { modifiedCount: modified };
    },
  };

  return model;
}

describe('infra joinTokenStore (ワンタイムリンクの永続化)', () => {
  const expiry = new Date('2026-01-01T02:00:00Z');

  test('issue は未消費・未無効化の状態で保存する', async () => {
    const model = makeFakeModel();
    const store = createJoinTokenStore({ model });

    const created = await store.issue({
      tokenId: 't1',
      reservationId: 'r1',
      sessionId: 's1',
      expiresAt: expiry,
    });

    expect(created).toMatchObject({
      tokenId: 't1',
      reservationId: 'r1',
      sessionId: 's1',
      consumedAt: null,
      invalidatedAt: null,
    });
    expect(model.docs).toHaveLength(1);
  });

  test('findByTokenId は該当トークンを返す / 無ければ null', async () => {
    const model = makeFakeModel([{ tokenId: 't1', sessionId: 's1', expiresAt: expiry }]);
    const store = createJoinTokenStore({ model });

    expect((await store.findByTokenId('t1')).tokenId).toBe('t1');
    expect(await store.findByTokenId('nope')).toBeNull();
  });

  test('consume は未消費トークンだけを下ろす', async () => {
    const model = makeFakeModel([
      { tokenId: 't1', sessionId: 's1', expiresAt: expiry, consumedAt: null, invalidatedAt: null },
    ]);
    const store = createJoinTokenStore({ model });
    const now = new Date('2026-01-01T01:00:00Z');

    const consumed = await store.consume('t1', now);

    expect(consumed.consumedAt).toEqual(now);
    expect(model.docs[0].consumedAt).toEqual(now);
  });

  test('consume の条件に「未消費・未無効化・期限内」が含まれる（二重消費防止）', async () => {
    const model = makeFakeModel();
    const store = createJoinTokenStore({ model });

    await store.consume('t1', new Date('2026-01-01T01:00:00Z'));

    expect(model.calls.findOneAndUpdate[0].filter).toEqual({
      tokenId: 't1',
      consumedAt: null,
      invalidatedAt: null,
      expiresAt: { $gt: new Date('2026-01-01T01:00:00Z') },
    });
  });

  test('2 回目の consume は失敗する（一度だけ有効）', async () => {
    const model = makeFakeModel([
      {
        tokenId: 't1',
        sessionId: 's1',
        expiresAt: expiry,
        consumedAt: new Date('2026-01-01T00:30:00Z'),
        invalidatedAt: null,
      },
    ]);
    const store = createJoinTokenStore({ model });

    const second = await store.consume('t1', new Date('2026-01-01T01:00:00Z'));

    expect(second).toBeNull();
  });

  test('期限切れトークンは consume できない', async () => {
    const model = makeFakeModel([
      {
        tokenId: 't1',
        sessionId: 's1',
        expiresAt: new Date('2025-12-31T00:00:00Z'),
        consumedAt: null,
        invalidatedAt: null,
      },
    ]);
    const store = createJoinTokenStore({ model });

    expect(await store.consume('t1', new Date('2026-01-01T01:00:00Z'))).toBeNull();
  });

  test('invalidateBySessionId はその室の未無効化トークンをまとめて無効化する', async () => {
    const model = makeFakeModel([
      { tokenId: 't1', sessionId: 's1', invalidatedAt: null },
      { tokenId: 't2', sessionId: 's1', invalidatedAt: null },
      { tokenId: 't3', sessionId: 'other', invalidatedAt: null },
      { tokenId: 't4', sessionId: 's1', invalidatedAt: new Date('2025-01-01') },
    ]);
    const store = createJoinTokenStore({ model });
    const now = new Date('2026-01-01T01:00:00Z');

    const count = await store.invalidateBySessionId('s1', now);

    expect(count).toBe(2);
    expect(model.docs[0].invalidatedAt).toEqual(now);
    expect(model.docs[1].invalidatedAt).toEqual(now);
    expect(model.docs[2].invalidatedAt).toBeNull(); // 別セッションは無傷
    expect(model.docs[3].invalidatedAt).toEqual(new Date('2025-01-01')); // 既存のものは保持
  });
});

describe('infra joinTokenStore isSessionInvalidated（室の無効化判定）', () => {
  test('トークンが 1 件も無い場合は false（未使用の室）', async () => {
    const store = createJoinTokenStore({ model: makeFakeModel() });

    expect(await store.isSessionInvalidated('s1')).toBe(false);
  });

  test('全て無効化済みなら true', async () => {
    const model = makeFakeModel([
      { tokenId: 't1', sessionId: 's1', invalidatedAt: new Date('2026-01-01') },
      { tokenId: 't2', sessionId: 's1', invalidatedAt: new Date('2026-01-01') },
    ]);
    const store = createJoinTokenStore({ model });

    expect(await store.isSessionInvalidated('s1')).toBe(true);
  });

  test('1 つでも有効なら false', async () => {
    const model = makeFakeModel([
      { tokenId: 't1', sessionId: 's1', invalidatedAt: new Date('2026-01-01') },
      { tokenId: 't2', sessionId: 's1', invalidatedAt: null },
    ]);
    const store = createJoinTokenStore({ model });

    expect(await store.isSessionInvalidated('s1')).toBe(false);
  });
});
