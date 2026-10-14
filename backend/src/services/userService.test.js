import { BCRYPT_SALT_ROUNDS, UserCreationError, createUserService } from './userService.js';
import { Role } from '../domain/constants.js';

/** テスト用の平文パスワード。サービス層の実コードと同じ最小長を満たす。 */
const PASSWORD = 'correct-horse-1';

/**
 * 意味論を検証する Fake:
 *  - insertUser は受け取った record を保存し、userId 重複時は Mongo の
 *    unique インデックス違反と同じ { code: 11000 } を投げる。
 *  - hashPassword は bcrypt と同じ "$2b$<cost>$..." 形式の文字列を返す。
 *  - どちらも jest.fn を使わず、呼び出し回数を自分で数える（このプロジェクトの慣習）。
 */
function makeFake({ duplicateUserIds = [] } = {}) {
  const saved = [];
  const hashCalls = [];
  const insertUser = async (record) => {
    if (duplicateUserIds.includes(record.userId)) {
      const err = new Error('E11000 duplicate key error');
      err.code = 11000;
      throw err;
    }
    saved.push(record);
    return { userId: record.userId, role: record.role };
  };
  const hashPassword = async (password) => {
    hashCalls.push(password);
    return `$2b$${BCRYPT_SALT_ROUNDS}$fake$${password.length}`;
  };
  return {
    saved,
    hashCalls,
    insertUser,
    hashPassword,
    service: createUserService({ insertUser, hashPassword }),
  };
}

describe('services userService (ユーザー作成 / 要件 5.1)', () => {
  test('平文をハッシュ化して userId を保存し、戻り値にハッシュを含めない', async () => {
    const fake = makeFake();

    const created = await fake.service.createUser({
      userId: 'admin',
      role: Role.ADMINISTRATOR,
      password: PASSWORD,
    });

    expect(created).toEqual({ userId: 'admin', role: 'administrator' });
    expect(fake.saved).toHaveLength(1);
    expect(fake.saved[0]).toEqual({
      userId: 'admin',
      role: 'administrator',
      passwordHash: `$2b$${BCRYPT_SALT_ROUNDS}$fake$${PASSWORD.length}`,
    });
    // 戻り値・保存値のどこにも平文が現れない
    expect(JSON.stringify(created)).not.toContain(PASSWORD);
    expect(JSON.stringify(fake.saved)).not.toContain(PASSWORD);
  });

  test('平文をそのまま保存しない（ハッシュ化関数を必ず通す）', async () => {
    const fake = makeFake();

    await fake.service.createUser({
      userId: 'staff1',
      role: Role.STAFF,
      password: PASSWORD,
    });

    expect(fake.hashCalls).toEqual([PASSWORD]);
  });

  test('入力不正は永続化せず INVALID_USER_INPUT で拒否する', async () => {
    const fake = makeFake();

    await expect(
      fake.service.createUser({ userId: '', role: 'root', password: 'short' }),
    ).rejects.toMatchObject({ name: 'UserCreationError', code: 'INVALID_USER_INPUT' });

    expect(fake.saved).toHaveLength(0);
    expect(fake.hashCalls).toHaveLength(0);
  });

  test('userId 重複は DUPLICATE_USER_ID に翻訳する', async () => {
    const fake = makeFake({ duplicateUserIds: ['admin'] });

    await expect(
      fake.service.createUser({
        userId: 'admin',
        role: Role.ADMINISTRATOR,
        password: PASSWORD,
      }),
    ).rejects.toMatchObject({ name: 'UserCreationError', code: 'DUPLICATE_USER_ID' });
  });

  test('重複エラー以外の永続化エラーはそのまま伝播する', async () => {
    const boom = new Error('connection lost');
    const service = createUserService({
      insertUser: async () => {
        throw boom;
      },
      hashPassword: async (p) => `hash-${p}`,
    });

    await expect(
      service.createUser({ userId: 'admin', role: Role.ADMINISTRATOR, password: PASSWORD }),
    ).rejects.toBe(boom);
  });

  test('hashPassword が失敗した場合は挿入しない', async () => {
    const insertCalls = [];
    const service = createUserService({
      insertUser: async (record) => {
        insertCalls.push(record);
        return { userId: record.userId, role: record.role };
      },
      hashPassword: async () => {
        throw new Error('bcrypt failure');
      },
    });

    await expect(
      service.createUser({ userId: 'admin', role: Role.ADMINISTRATOR, password: PASSWORD }),
    ).rejects.toThrow('bcrypt failure');
    expect(insertCalls).toHaveLength(0);
  });

  test('staff ロールも作成できる（ROLES 内の値なら受理）', async () => {
    const fake = makeFake();

    const created = await fake.service.createUser({
      userId: 'staff-001',
      role: Role.STAFF,
      password: PASSWORD,
    });

    expect(created.role).toBe('staff');
  });

  test('UserCreationError は既定 code を持つ', () => {
    const err = new UserCreationError('boom');

    expect(err.code).toBe('USER_CREATE_FAILED');
    expect(err.name).toBe('UserCreationError');
  });
});

/**
 * setUserPassword 用 Fake。upsertUserPassword は「既存があれば文書を、
 * なければ null」を返す（本番の findOneAndUpdate と同じ意味論）。
 */
function makeResetFake({ existing = [] } = {}) {
  const upserted = [];
  const inserted = [];
  const hashCalls = [];

  const store = existing.map((u) => ({ ...u }));

  const upsertUserPassword = async ({ userId, passwordHash }) => {
    upserted.push({ userId, passwordHash });
    const found = store.find((u) => u.userId === userId);
    if (!found) {
      return null;
    }
    found.passwordHash = passwordHash;
    return { userId: found.userId, role: found.role };
  };

  const insertUser = async (record) => {
    inserted.push(record);
    store.push({ ...record });
    return { userId: record.userId, role: record.role };
  };

  const hashPassword = async (password) => {
    hashCalls.push(password);
    return `$2b$${BCRYPT_SALT_ROUNDS}$fake$${password.length}`;
  };

  return {
    store,
    upserted,
    inserted,
    hashCalls,
    service: createUserService({ insertUser, hashPassword, upsertUserPassword }),
  };
}

describe('services userService setUserPassword (パスワード再設定)', () => {
  test('既存ユーザーのパスワードだけを差し替える（ロールは保持）', async () => {
    const fake = makeResetFake({
      existing: [{ userId: 'admin', role: Role.ADMINISTRATOR, passwordHash: 'old-hash' }],
    });

    const result = await fake.service.setUserPassword({ userId: 'admin', password: PASSWORD });

    expect(result).toEqual({ created: false, user: { userId: 'admin', role: 'administrator' } });
    expect(fake.upserted).toEqual([
      { userId: 'admin', passwordHash: `$2b$${BCRYPT_SALT_ROUNDS}$fake$${PASSWORD.length}` },
    ]);
    // role は更新対象に含まれない（権限を勝手に持ち上げない）
    expect(fake.store[0].role).toBe(Role.ADMINISTRATOR);
    expect(fake.inserted).toHaveLength(0);
  });

  test('旧ハッシュは上書きされ、平文はどこにも残らない', async () => {
    const fake = makeResetFake({
      existing: [{ userId: 'admin', role: Role.ADMINISTRATOR, passwordHash: 'old-hash' }],
    });

    await fake.service.setUserPassword({ userId: 'admin', password: PASSWORD });

    expect(fake.store[0].passwordHash).not.toBe('old-hash');
    expect(JSON.stringify(fake.store)).not.toContain(PASSWORD);
    expect(JSON.stringify(fake.upserted)).not.toContain(PASSWORD);
  });

  test('既存が居なければ administrator として新規作成し created=true を返す', async () => {
    const fake = makeResetFake({ existing: [] });

    const result = await fake.service.setUserPassword({ userId: 'newadmin', password: PASSWORD });

    expect(result).toEqual({
      created: true,
      user: { userId: 'newadmin', role: Role.ADMINISTRATOR },
    });
    expect(fake.inserted).toHaveLength(1);
    expect(fake.inserted[0].passwordHash).not.toContain(PASSWORD);
  });

  test('userId 欠落・空白付き・短いパスワードは保存せず拒否する', async () => {
    const fake = makeResetFake();

    for (const input of [
      { password: PASSWORD },
      { userId: ' admin', password: PASSWORD },
      { userId: 'admin' },
      { userId: 'admin', password: 'short' },
    ]) {
      await expect(fake.service.setUserPassword(input)).rejects.toMatchObject({
        code: 'INVALID_USER_INPUT',
      });
    }

    expect(fake.upserted).toHaveLength(0);
    expect(fake.inserted).toHaveLength(0);
    expect(fake.hashCalls).toHaveLength(0);
  });

  test('update と create の競合は DUPLICATE_USER_ID になる', async () => {
    const service = createUserService({
      upsertUserPassword: async () => null,
      insertUser: async () => {
        const err = new Error('E11000 duplicate key error');
        err.code = 11000;
        throw err;
      },
      hashPassword: async (p) => `hash-${p}`,
    });

    await expect(
      service.setUserPassword({ userId: 'admin', password: PASSWORD }),
    ).rejects.toMatchObject({ name: 'UserCreationError', code: 'DUPLICATE_USER_ID' });
  });

  test('永続化エラーはそのまま伝播する', async () => {
    const boom = new Error('connection lost');
    const service = createUserService({
      upsertUserPassword: async () => {
        throw boom;
      },
      hashPassword: async (p) => `hash-${p}`,
    });

    await expect(service.setUserPassword({ userId: 'admin', password: PASSWORD })).rejects.toBe(
      boom,
    );
  });
});
