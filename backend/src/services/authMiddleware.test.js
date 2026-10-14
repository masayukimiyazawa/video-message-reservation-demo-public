import jwt from 'jsonwebtoken';

import { authorize } from './authMiddleware.js';
import { AuthAction, Role } from '../domain/constants.js';

/**
 * 認可ミドルウェア authorize(action) のユニットテスト（Task 9.3 / 要件 5.4）
 *
 * 検証内容:
 *  - Authorization ヘッダなし / 不正トークン → 401
 *  - canAccess が拒否（権限のないスタッフ操作・非所有）→ 403
 *  - canAccess が許可（管理者・所有スタッフ）→ next() 呼び出し
 *
 * jsonwebtoken で本物のトークンを署名し、req/res/next をモックする。
 */

const SECRET = 'test-secret';

/** レスポンスモック。status().json() を記録する。 */
function makeRes() {
  const res = {
    statusCode: undefined,
    body: undefined,
    locals: {},
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
  return res;
}

/** next モック（呼ばれた回数と引数を記録）。 */
function makeNext() {
  const calls = [];
  const next = (...args) => calls.push(args);
  next.calls = calls;
  return next;
}

/** userId/role を含む署名済みトークンで Authorization ヘッダを作る。 */
function bearer(payload, secret = SECRET, options = {}) {
  const token = jwt.sign(payload, secret, options);
  return { authorization: `Bearer ${token}` };
}

describe('authorize ミドルウェア (Task 9.3 / 要件 5.4)', () => {
  test('Authorization ヘッダが無ければ 401', async () => {
    const mw = authorize(AuthAction.MANAGE_RESERVATION, { secret: SECRET });
    const req = { headers: {}, body: {} };
    const res = makeRes();
    const next = makeNext();

    await mw(req, res, next);
    expect(res.statusCode).toBe(401);
    expect(res.body.error).toBe('unauthorized');
    expect(next.calls.length).toBe(0);
  });

  test('不正な署名のトークンは 401', async () => {
    const mw = authorize(AuthAction.MANAGE_RESERVATION, { secret: SECRET });
    const req = {
      headers: bearer({ userId: 'u1', role: Role.ADMINISTRATOR }, 'wrong-secret'),
      body: {},
    };
    const res = makeRes();
    const next = makeNext();

    await mw(req, res, next);
    expect(res.statusCode).toBe(401);
    expect(next.calls.length).toBe(0);
  });

  test('期限切れトークンは 401', async () => {
    const mw = authorize(AuthAction.MANAGE_RESERVATION, { secret: SECRET });
    const req = {
      headers: bearer({ userId: 'u1', role: Role.ADMINISTRATOR }, SECRET, { expiresIn: -10 }),
      body: {},
    };
    const res = makeRes();
    const next = makeNext();

    await mw(req, res, next);
    expect(res.statusCode).toBe(401);
    expect(next.calls.length).toBe(0);
  });

  test('userId/role を欠くトークンは 401', async () => {
    const mw = authorize(AuthAction.MANAGE_RESERVATION, { secret: SECRET });
    const req = { headers: bearer({ foo: 'bar' }, SECRET), body: {} };
    const res = makeRes();
    const next = makeNext();

    await mw(req, res, next);
    expect(res.statusCode).toBe(401);
    expect(next.calls.length).toBe(0);
  });

  test('管理者はすべての操作で next() が呼ばれる（許可）', async () => {
    const mw = authorize(AuthAction.MANAGE_PERMISSIONS, { secret: SECRET });
    const req = {
      headers: bearer({ userId: 'admin-1', role: Role.ADMINISTRATOR }, SECRET),
      body: {},
    };
    const res = makeRes();
    const next = makeNext();

    await mw(req, res, next);
    expect(next.calls.length).toBe(1);
    // next() はエラーなしで呼ばれる。
    expect(next.calls[0][0]).toBeUndefined();
    expect(res.statusCode).toBeUndefined();
    // 認証済みユーザーが添付される。
    expect(req.user).toEqual({ userId: 'admin-1', role: Role.ADMINISTRATOR });
  });

  test('スタッフが自身に割り当てられた予約を操作する場合は許可（next）', async () => {
    const mw = authorize(AuthAction.START_RECORDING, { secret: SECRET });
    const req = {
      headers: bearer({ userId: 'staff-1', role: Role.STAFF }, SECRET),
      // defaultResolveOwnership は body.assignedStaffId を参照する。
      body: { assignedStaffId: 'staff-1' },
    };
    const res = makeRes();
    const next = makeNext();

    await mw(req, res, next);
    expect(next.calls.length).toBe(1);
    expect(res.statusCode).toBeUndefined();
  });

  test('スタッフが他人に割り当てられた予約を操作すると 403（拒否 / 要件 5.4）', async () => {
    const mw = authorize(AuthAction.START_RECORDING, { secret: SECRET });
    const req = {
      headers: bearer({ userId: 'staff-1', role: Role.STAFF }, SECRET),
      body: { assignedStaffId: 'staff-2' },
    };
    const res = makeRes();
    const next = makeNext();

    await mw(req, res, next);
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toBe('forbidden');
    expect(next.calls.length).toBe(0);
  });

  test('所有関係が解決できないスタッフは 403（非所有として拒否）', async () => {
    const mw = authorize(AuthAction.START_RECORDING, { secret: SECRET });
    const req = {
      headers: bearer({ userId: 'staff-1', role: Role.STAFF }, SECRET),
      body: {},
    };
    const res = makeRes();
    const next = makeNext();

    await mw(req, res, next);
    expect(res.statusCode).toBe(403);
    expect(next.calls.length).toBe(0);
  });

  test('res.locals.reservation.assignedStaffId が優先される（上流で予約読込済み）', async () => {
    const mw = authorize(AuthAction.MANAGE_RESERVATION, { secret: SECRET });
    const req = {
      headers: bearer({ userId: 'staff-9', role: Role.STAFF }, SECRET),
      body: { assignedStaffId: 'other' },
    };
    const res = makeRes();
    res.locals.reservation = { assignedStaffId: 'staff-9' };
    const next = makeNext();

    await mw(req, res, next);
    expect(next.calls.length).toBe(1);
    expect(res.statusCode).toBeUndefined();
  });

  test('resolveOwnership が例外を投げると next(err) へ委譲する', async () => {
    const boom = new Error('ownership resolve failed');
    const mw = authorize(AuthAction.MANAGE_RESERVATION, {
      secret: SECRET,
      resolveOwnership: () => { throw boom; },
    });
    const req = {
      headers: bearer({ userId: 'staff-1', role: Role.STAFF }, SECRET),
      body: {},
    };
    const res = makeRes();
    const next = makeNext();

    await mw(req, res, next);
    expect(next.calls.length).toBe(1);
    expect(next.calls[0][0]).toBe(boom);
  });

  test('action が未定義なら生成時に例外を投げる（取りこぼし検出 / 要件 5.4）', () => {
    expect(() => authorize(undefined)).toThrow();
    expect(() => authorize('')).toThrow();
    // 定義済みアクションは生成できる。
    expect(() => authorize(AuthAction.VIEW_RECORDING, { secret: SECRET })).not.toThrow();
  });
});
