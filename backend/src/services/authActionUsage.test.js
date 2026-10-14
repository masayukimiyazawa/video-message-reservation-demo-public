import { AuthAction } from '../domain/constants.js';
import { createRecordingRouter, createTranscriptionRouter } from './recordingRoutes.js';
import { createReservationRouter } from './reservationRoutes.js';
import { createSessionRouter } from './sessionRoutes.js';

/**
 * 認可アクションの取りこぼし防止（要件 5.4 / GAP 4 回帰）
 *
 * 各ルーターはエンドポイントに `authorize(AuthAction.XXX)` を適用する。
 * AuthAction に存在しないキーを参照すると `undefined` が渡り、canAccess が
 * 操作種別で判定するようになった将来に「意図せず全許可/全拒否」になる。
 * ルーター生成時に渡された action を捕捉し、すべて定義済みであることを検証する。
 */

const VALID_ACTIONS = new Set(Object.values(AuthAction));

/**
 * authorize をスパイに差し替えてルーターを生成し、渡された action を収集する。
 * ハンドラは実行しないためネットワークや DB には触れない。
 */
function captureActions(buildRouter) {
  const actions = [];
  const authorizeSpy = (action) => {
    actions.push(action);
    return (req, res, next) => next();
  };
  buildRouter(authorizeSpy);
  return actions;
}

describe('認可アクションの取りこぼし防止 (要件 5.4)', () => {
  const routers = [
    ['recording', (authorize) => createRecordingRouter({ authorize })],
    ['transcription', (authorize) => createTranscriptionRouter({ authorize })],
    ['reservation', (authorize) => createReservationRouter({ authorize })],
    ['session', (authorize) => createSessionRouter({ authorize })],
  ];

  test.each(routers)('%s ルーターが参照する AuthAction はすべて定義済み', (_name, build) => {
    const actions = captureActions(build);

    expect(actions.length).toBeGreaterThan(0);
    for (const action of actions) {
      expect(typeof action).toBe('string');
      expect(VALID_ACTIONS.has(action)).toBe(true);
    }
  });

  test('録画の閲覧は VIEW_RECORDING を使用する', () => {
    const actions = captureActions((authorize) => createRecordingRouter({ authorize }));
    expect(actions).toContain(AuthAction.VIEW_RECORDING);
  });
});
