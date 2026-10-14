import { createSessionPresenceStore } from './sessionPresenceStore.js';

/** 本番と同じ意味論を持つ偽モデル（joinTokenStore のテストと共通形状）。 */
function makeFakeModel(seed = []) {
  const docs = seed.map((d, i) => ({ _id: `id${i}`, connections: [], ...d }));
  const calls = { findOneAndUpdate: [] };

  // MongoDB は「フィールド欠落」を null として等価比較する。
  // 本物の挙動に合わせるため undefined を null に正規化する。
  const norm = (v) => (v === undefined ? null : v);

  const matches = (doc, filter) =>
    Object.entries(filter).every(([key, cond]) => {
      if (cond && typeof cond === 'object') {
        if ('$gt' in cond) return new Date(doc[key]).getTime() > new Date(cond.$gt).getTime();
        if ('$lt' in cond) return new Date(doc[key]).getTime() < new Date(cond.$lt).getTime();
        if ('$ne' in cond) return norm(doc[key]) !== cond.$ne;
        return true;
      }
      return norm(doc[key]) === norm(cond);
    });

  return {
    calls,
    docs,
    findOne(filter) {
      return { lean: async () => docs.find((d) => matches(d, filter)) ?? null };
    },
    findOneAndUpdate(filter, update, options = {}) {
      calls.findOneAndUpdate.push({ filter, update, options });
      let idx = docs.findIndex((d) => matches(d, filter));
      if (idx === -1) {
        if (!options.upsert) {
          return { lean: async () => null };
        }
        const created = { _id: `new${docs.length}`, ...filter, connections: [] };
        docs.push(created);
        idx = docs.length - 1;
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
        doc.connections = doc.connections.filter((c) => !matches(c, update.$pull.connections));
      }
      return { lean: async () => doc };
    },
  };
}

describe('infra sessionPresenceStore (在室状況の永続化)', () => {
  test('addConnection はレコードを新規作成し接続を追加する', async () => {
    const model = makeFakeModel();
    const store = createSessionPresenceStore({ model });
    const joinedAt = new Date('2026-01-01T00:00:00Z');

    const presence = await store.addConnection({
      sessionId: 's1',
      connectionId: 'c1',
      userId: 'admin',
      role: 'administrator',
      joinedAt,
    });

    expect(presence.sessionId).toBe('s1');
    expect(presence.connections).toHaveLength(1);
    expect(presence.openedAt).toEqual(joinedAt);
  });

  test('openedAt は最初の一回だけ入る（2 人目が入っても上書きされない）', async () => {
    const model = makeFakeModel();
    const store = createSessionPresenceStore({ model });
    const first = new Date('2026-01-01T00:00:00Z');
    const second = new Date('2026-01-01T00:05:00Z');

    await store.addConnection({ sessionId: 's1', connectionId: 'c1', joinedAt: first });
    const presence = await store.addConnection({
      sessionId: 's1',
      connectionId: 'c2',
      joinedAt: second,
    });

    expect(presence.openedAt).toEqual(first);
    expect(presence.connections).toHaveLength(2);
  });

  test('openedAt は $min で設定する（null 既定が $min を無効化しないための不変条件）', async () => {
    const model = makeFakeModel();
    const store = createSessionPresenceStore({ model });
    await store.addConnection({
      sessionId: 's1',
      connectionId: 'c1',
      joinedAt: new Date('2026-01-01T00:00:00Z'),
    });

    // $min を使うことで Mongoose の setDefaultsOnInsert は openedAt（schema default: null）を
    // $setOnInsert に載せない。載せてしまうと初回 insert の openedAt が null のまま固定され、
    // $min が「null < Date」で比較されて以後も更新されなくなる。
    const { update } = model.calls.findOneAndUpdate[0];
    expect(update.$min).toEqual({ openedAt: expect.any(Date) });
    expect(update.$set?.openedAt).toBeUndefined();
    expect(update.$setOnInsert?.openedAt).toBeUndefined();
  });

  test('addConnection は userId / role を保持する（管理者とゲストの識別）', async () => {
    const model = makeFakeModel();
    const store = createSessionPresenceStore({ model });
    const joinedAt = new Date('2026-01-01T00:00:00Z');

    await store.addConnection({ sessionId: 's1', connectionId: 'c1', userId: 'admin', role: 'administrator', joinedAt });
    const presence = await store.addConnection({
      sessionId: 's1',
      connectionId: 'c2',
      userId: null,
      role: 'guest',
      joinedAt,
    });

    expect(presence.connections.map((c) => [c.userId, c.role])).toEqual([
      ['admin', 'administrator'],
      [null, 'guest'],
    ]);
  });

  test('removeConnection は該当 ID だけを外す（他の参加者を巻き取らない）', async () => {
    const model = makeFakeModel();
    const store = createSessionPresenceStore({ model });
    const joinedAt = new Date('2026-01-01T00:00:00Z');

    await store.addConnection({ sessionId: 's1', connectionId: 'c1', joinedAt });
    await store.addConnection({ sessionId: 's1', connectionId: 'c2', joinedAt });
    const presence = await store.removeConnection({ sessionId: 's1', connectionId: 'c1' });

    expect(presence.connections).toHaveLength(1);
    expect(presence.connections[0].connectionId).toBe('c2');
  });

  test('存在しない connectionId を外してもレコードは壊れない', async () => {
    const model = makeFakeModel();
    const store = createSessionPresenceStore({ model });
    await store.addConnection({
      sessionId: 's1',
      connectionId: 'c1',
      joinedAt: new Date('2026-01-01T00:00:00Z'),
    });

    const presence = await store.removeConnection({ sessionId: 's1', connectionId: 'ghost' });

    expect(presence.connections).toHaveLength(1);
  });

  test('最後の 1 人が退室すると connections が空になる', async () => {
    const model = makeFakeModel();
    const store = createSessionPresenceStore({ model });
    const joinedAt = new Date('2026-01-01T00:00:00Z');

    await store.addConnection({ sessionId: 's1', connectionId: 'c1', joinedAt });
    const presence = await store.removeConnection({ sessionId: 's1', connectionId: 'c1' });

    expect(presence.connections).toEqual([]);
  });

  test('findBySessionId は在室状況を返す / 無ければ null', async () => {
    const model = makeFakeModel();
    const store = createSessionPresenceStore({ model });

    expect(await store.findBySessionId('nope')).toBeNull();
    await store.addConnection({
      sessionId: 's1',
      connectionId: 'c1',
      joinedAt: new Date('2026-01-01T00:00:00Z'),
    });
    expect((await store.findBySessionId('s1')).sessionId).toBe('s1');
  });

  test('markClosed は closedAt を設定し、2 回目は null（無効化済みをサービス側で判別できる）', async () => {
    const model = makeFakeModel();
    const store = createSessionPresenceStore({ model });
    const joinedAt = new Date('2026-01-01T00:00:00Z');
    const firstClose = new Date('2026-01-01T01:00:00Z');
    const laterClose = new Date('2026-01-01T02:00:00Z');

    await store.addConnection({ sessionId: 's1', connectionId: 'c1', joinedAt });
    const closed = await store.markClosed('s1', firstClose);
    // 2 回目は条件 closedAt: null に一致せず null を返す（冪等・二重処理の防止）
    const again = await store.markClosed('s1', laterClose);

    expect(closed.closedAt).toEqual(firstClose);
    expect(again).toBeNull();
    expect(model.docs[0].closedAt).toEqual(firstClose); // 時刻が上書きされない
    expect(model.calls.findOneAndUpdate.at(-1).filter).toMatchObject({ closedAt: null });
  });
});
