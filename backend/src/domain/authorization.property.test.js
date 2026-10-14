import fc from 'fast-check';
import { canAccess } from './authorization.js';
import { Role, AuthAction } from './constants.js';

/**
 * Feature: vonage-video-reservation, Property 7: 認可判定はロールと所有関係に整合する
 *
 * For any ロール・操作・所有関係の組について、canAccess は管理者にはすべての操作を許可し、
 * スタッフには自身に割り当てられた予約に対する操作のみを許可し、それ以外はすべて拒否する。
 *
 * Validates: Requirements 5.1, 5.2, 5.3, 5.4
 */

const ACTIONS = Object.values(AuthAction);

/** ロール: 既知（administrator/staff）＋未知ロール */
const roleArb = fc.oneof(
  fc.constantFrom(Role.ADMINISTRATOR, Role.STAFF),
  fc.constantFrom('guest', 'anonymous', '', 'ADMIN'),
);

const actionArb = fc.oneof(fc.constantFrom(...ACTIONS), fc.string());

/** 所有関係: userId / assignedStaffId が一致・不一致・欠落を取りうる */
const ownershipArb = fc.oneof(
  fc.constant(undefined),
  fc.constant(null),
  fc.record({
    userId: fc.oneof(fc.string(), fc.constant(undefined)),
    assignedStaffId: fc.oneof(fc.string(), fc.constant(undefined)),
  }),
  // 一致するケースを意図的に多く生成する
  fc.string({ minLength: 1 }).map((id) => ({ userId: id, assignedStaffId: id })),
);

/** テスト側の独立な期待値計算 */
function owns(ownership) {
  if (ownership === null || typeof ownership !== 'object') return false;
  const { userId, assignedStaffId } = ownership;
  if (typeof userId !== 'string' || userId.length === 0) return false;
  if (typeof assignedStaffId !== 'string' || assignedStaffId.length === 0) return false;
  return userId === assignedStaffId;
}

function expectedAccess(role, ownership) {
  if (role === Role.ADMINISTRATOR) return true;
  if (role === Role.STAFF) return owns(ownership);
  return false;
}

describe('Property 7: 認可判定はロールと所有関係に整合する (要件 5.1-5.4)', () => {
  test('canAccess はロール・所有関係の規則と厳密に一致する', () => {
    fc.assert(
      fc.property(roleArb, actionArb, ownershipArb, (role, action, ownership) => {
        expect(canAccess(role, action, ownership)).toBe(expectedAccess(role, ownership));
      }),
      { numRuns: 400 },
    );
  });

  test('管理者は任意の操作・所有関係で常に許可される', () => {
    fc.assert(
      fc.property(actionArb, ownershipArb, (action, ownership) => {
        expect(canAccess(Role.ADMINISTRATOR, action, ownership)).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  test('スタッフは所有時のみ許可、非所有では拒否される', () => {
    fc.assert(
      fc.property(actionArb, fc.string({ minLength: 1 }), fc.string({ minLength: 1 }), (action, a, b) => {
        const ownedResult = canAccess(Role.STAFF, action, { userId: a, assignedStaffId: a });
        expect(ownedResult).toBe(true);

        const notOwned = canAccess(Role.STAFF, action, { userId: a, assignedStaffId: `${b}#` });
        // a と `${b}#` は決して一致しない
        expect(notOwned).toBe(false);
      }),
      { numRuns: 200 },
    );
  });

  test('未知ロールは常に拒否される', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('guest', 'anonymous', 'ADMIN', ''),
        actionArb,
        ownershipArb,
        (role, action, ownership) => {
          expect(canAccess(role, action, ownership)).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });
});
