/**
 * 会議室ライフサイクルサービス（アプリケーション層）
 *
 * 役割: Vonage Video の接続イベントを吸収し、「ユーザと管理者の全員が退室したら
 * 会議室を無効化する」というビジネスルールを 1 箇所に集約する。
 *
 * 無効化時に行う処理（順序は依存関係で決まる）:
 *  1. 在室記録から退出した接続を取り除く
 *  2. 全員退室していた場合 (shouldCloseRoom) にのみ、無効化へ進む
 *  3. 無効化の所有権を条件付き更新 (markClosed) で取る
 *  4. その室に残っていた未消費の入室リンクをまとめて無効化する
 *  5. その室に紐づく予約をすべて completed にする
 *
 * なぜ「残存接続の一括切断」を行わないのか:
 *  上記 2 の通過条件は「在室記録が空」であり、通過した時点で記録上の接続は 0 件。
 *  したがってここで切断できる接続は存在せず、無意味な API 呼出しになるだけ。
 *  実在する危険は逆方向で「最後の退出と同時に新規入室が重なって、
 *  その接続が捕捉されないまま残る」ケースである。これは 3 の無効化が
 *  終わった後に届いた入室イベントを弾き、その接続を強制切断することで防ぐ
 *  （handleConnected 参照）。Vonage 側に居るのに記録が無い接続は、
 *  この経路でしか列挙できないため。
 *
 * 冪等性と race 安全性について:
 *  - 2 人が同時に退室して両方とも「空室」と判断しても、`markClosed` が
 *    `closedAt: null` の条件付き更新なので 2 回目以降は no-op になる。
 *    無効化は「最初の 1 回だけ」実行される。
 *  - 無効化後の各処理は個別に例外を握りつぶす。1 つの失敗で
 *    後続の後始末（リンク無効化・予約完了化）がスキップされてはならないため。
 *  - Vonage 側に無い接続を切断しようとした場合 (404 相当) は想定内として無視する。
 */

import { ReservationStatus } from '../domain/constants.js';
import { PresenceEvent, shouldCloseRoom } from '../domain/sessionPresence.js';
import { joinTokenStore } from '../infra/joinTokenStore.js';
import { reservationStore } from '../infra/reservationStore.js';
import { sessionPresenceStore } from '../infra/sessionPresenceStore.js';
import { videoClient } from '../infra/videoClient.js';
import { activeArchiveStore as defaultActiveArchiveStore } from '../infra/activeArchiveStore.js';
import { recordingService as defaultRecordingService } from './recordingService.js';

/**
 * roomLifecycleService を生成する。
 *
 * @param {object} deps
 * @param {object} deps.sessionPresenceStore 在室状況ストア
 * @param {object} deps.joinTokenStore 入室トークンストア
 * @param {object} deps.reservationStore 予約ストア
 * @param {{disconnectClient: (sessionId: string, connectionId: string) => Promise<void>}} deps.videoClient Video クライアント
 * @param {object} [deps.recordingService] 録画サービス（ゲスト入室時の自動録画用）
 * @param {object} [deps.activeArchiveStore] 進行中アーカイブストア（録画停止対象の解決用）
 * @param {() => Date} [deps.clock] 現在時刻
 * @param {(msg: string, meta?: object) => void} [deps.logger] ログ出力
 * @returns {{
 *   handleConnectionEvent: (parsed: object) => Promise<{handled: boolean, closed: boolean}>,
 *   isRoomClosed: (sessionId: string) => Promise<boolean>,
 * }}
 */
export function createRoomLifecycleService({
  sessionPresenceStore,
  joinTokenStore,
  reservationStore,
  videoClient,
  recordingService = defaultRecordingService,
  activeArchiveStore = defaultActiveArchiveStore,
  clock = () => new Date(),
  logger = () => {},
}) {
  // sessionId -> archiveId の対応は共有ストア（activeArchiveStore）が保持する。
  // 自動録画（ゲスト入室）と手動録画（管理画面）の両経路が登録するため、
  // 会議終了時に経路に依らず進行中の録画を停止できる。

  /**
   * 接続イベントを処理する。
   *
   * @param {{event: string, sessionId: string, connectionId: string, userId?: string|null, role?: string|null}} parsed parseConnectionEvent の結果
   * @returns {Promise<{handled: boolean, closed: boolean}>} handled はイベントを処理したか、closed は室を無効化したか
   */
  async function handleConnectionEvent(parsed) {
    if (parsed?.event === PresenceEvent.CONNECTED) {
      return { handled: true, closed: false, ...(await handleConnected(parsed)) };
    }

    if (parsed?.event === PresenceEvent.DISCONNECTED) {
      return { handled: true, closed: await handleDisconnect(parsed) };
    }

    // streamCreated など、接続の出入りに無関係なイベントは無視する。
    return { handled: false, closed: false };
  }

  /**
   * 退出イベントを処理し、必要なら室を無効化する。
   * @param {{sessionId: string, connectionId: string}} parsed
   * @returns {Promise<boolean>} 室を無効化したなら true
   */
  async function handleDisconnect(parsed) {
    const { sessionId, connectionId } = parsed;

    // 1. 退出した接続を在室記録から取り除く。
    const presence = await sessionPresenceStore.removeConnection({ sessionId, connectionId });

    // 2. 判定。記録が無い（null）や「まだ誰も入ったことない」なら何もしない。
    if (!shouldCloseRoom(presence)) {
      return false;
    }

    // 3. closedAt を条件付き更新して無効化の所有権を取る（最初の 1 回だけ成功する）。
    const closed = await sessionPresenceStore.markClosed(sessionId, clock());
    if (!closed) {
      // 既に別の処理が無効化済み。二重処理しない。
      return false;
    }

    // 4. **録画中なら停止する（会議終了時に確実に録画を止める）**。
    //    自動録画・手動録画のいずれも共有ストアに登録されている（要件 10）。
    const archiveId = await activeArchiveStore.get(sessionId);
    if (archiveId) {
      await runSafely('録画の停止', { sessionId, archiveId }, async () => {
        const result = await recordingService.stopRecording(archiveId);
        if (result.ok) {
          logger('会議終了に伴う録画停止成功', { sessionId, archiveId });
        } else {
          logger('会議終了に伴う録画停止失敗', { sessionId, archiveId, error: result.message });
        }
      });
      activeArchiveStore.delete(sessionId);
    }

    // 5. その室の未消費リンクを無効化する。
    await runSafely('入室リンクの無効化', { sessionId }, () =>
      joinTokenStore.invalidateBySessionId(sessionId, clock()),
    );

    // 5. その室に紐づく予約をすべて completed にする。
    await runSafely('予約の完了化', { sessionId }, async () => {
      const reservations = await reservationStore.findBySessionId(sessionId);
      for (const reservation of reservations ?? []) {
        // 既に完了/キャンセル済みのものは触らない。
        if (
          reservation.status === ReservationStatus.COMPLETED ||
          reservation.status === ReservationStatus.CANCELLED
        ) {
          continue;
        }
        await reservationStore.updateStatus(reservation.reservationId, ReservationStatus.COMPLETED);
      }
    });

    logger('会議室を無効化しました', { sessionId });
    return true;
  }

/**
 * 入室イベントを処理する。
 *
 * 無効化済みの室に入室しようとした接続は記録へ追加せず、
 * Vonage 側から強制切断する。これが「全員退室後の残存接続を断开する」要件の
 * 実効経路であり、最後の退出と同時に入室が重なった競合を塞ぐ。
 *
 * ゲスト（ユーザー）が入室した場合、録画と文字起こしを自動開始する。
 *
 * @param {{sessionId: string, connectionId: string, userId?: string|null, role?: string|null}} parsed
 * @returns {Promise<{rejected: boolean}>} rejected は無効化済み室への入室だったか
 */
async function handleConnected(parsed) {
  const { sessionId, connectionId, userId, role } = parsed;

  if (await isRoomClosed(sessionId)) {
    await runSafely('無効化済み室の接続切断', { sessionId, connectionId }, () =>
      videoClient.disconnectClient(sessionId, connectionId),
    );
    logger('無効化済みの室への入室を拒否しました', { sessionId, connectionId });
    return { rejected: true };
  }

  await sessionPresenceStore.addConnection({
    sessionId,
    connectionId,
    userId,
    role,
    joinedAt: clock(),
  });

  // ゲスト（エンドユーザー）が入室したら録画＋文字起こしを自動開始
  if (role === 'guest') {
    logger('ゲスト入室を検知、自動録画＋文字起こしを開始', { sessionId, connectionId });
    // この sessionId に紐づく予約を検索し、reservationId と言語を録画に引き継ぐ。
    // 予約が特定できればその予約の対応言語を文字起こしへ反映し、無ければ日本語を既定とする。
    let reservationId = null;
    let language = 'ja';
    try {
      const reservations = await reservationStore.findBySessionId(sessionId);
      const reservation = reservations?.[0];
      if (reservation) {
        reservationId = reservation.reservationId ?? null;
        if (reservation.language === 'en') {
          language = 'en';
        }
      }
    } catch (err) {
      logger('予約検索に失敗（録画メタデータに reservationId を含められません）', { sessionId, error: err?.message });
    }
    await runSafely('自動録画開始', { sessionId }, async () => {
      const result = await recordingService.startRecording({
        sessionId,
        withTranscription: true,
        language, // 予約の対応言語（未指定時は 'ja'）
        reservationId, // 録画メタデータに reservationId を含める
      });
      if (result.ok) {
        const archiveId = result.archive?.id;
        if (archiveId) {
          // 会議終了時に停止できるよう進行中アーカイブとして登録する。
          // （recordingService も登録するが、注入された実装でも確実に機能させる）
          activeArchiveStore.set(sessionId, archiveId);
        }
        logger('自動録画開始成功', { sessionId, archiveId });
      } else {
        logger('自動録画開始失敗', { sessionId, error: result.message });
      }
    });
  }

  return { rejected: false };
}

  /**
   * 無効化後の後始末を実行し、失敗しても例外を握りつぶして後続へ進める。
   *
   * なぜ握りつぶすのか: 室は既に `closedAt` 付きで無効化済みであり、
   * ここで例外を送出すると webhook 応答が 500 になるうえ、後始末が
   * 中断されて「予約が completed にならない」等の不整合が残る。
   * 失敗はログに記録し、冪等な処理のため再送来で回復できる。
   *
   * @template T
   * @param {string} label エラーログに用いる処理名
   * @param {object} meta ログ用のメタ情報
   * @param {() => Promise<T>} fn 実行する処理
   * @returns {Promise<T|undefined>} 失敗時は undefined
   */
  async function runSafely(label, meta, fn) {
    try {
      return await fn();
    } catch (err) {
      logger(`${label}に失敗しました（続行）`, { ...meta, reason: err?.message });
      return undefined;
    }
  }

  /**
   * その室が無効化済みかどうかを返す（入室前の拒否判定に使う）。
   *
   * 在室記録が無くても判定できるよう、入室トークン側（この室に紐づくトークンが
   * すべて無効化されているか）も確認する。両方の記録が無い場合は false
   * （未使用の室とみなす。予約の有無は別の_layers で保証される）。
   *
   * @param {string} sessionId
   * @returns {Promise<boolean>}
   */
  async function isRoomClosed(sessionId) {
    const presence = await sessionPresenceStore.findBySessionId(sessionId);
    if (presence?.closedAt != null) {
      return true;
    }
    // 在室記録が無い場合のみ、トークン側の無効化記録で補う。
    // （記録があるなら、markClosed との整合性より在室記録を信頼する）
    if (presence == null) {
      return joinTokenStore.isSessionInvalidated(sessionId);
    }
    return false;
  }

  return Object.freeze({ handleConnectionEvent, isRoomClosed });
}

/**
 * 実ストア・実 Video クライアントで構築した既定の会議室ライフサイクルサービス。
 *
 * 各ストアは既定で実 MongoDB を参照するが、接続は mongoConnection の遅延接続に任せる。
 * したがって import 時に副作用は発生しない（DB アクセスは初回利用時のみ）。
 */
export const roomLifecycleService = createRoomLifecycleService({
  sessionPresenceStore,
  joinTokenStore,
  reservationStore,
  videoClient,
  logger: (msg, meta) => {
    // eslint-disable-next-line no-console
    console.log(`[roomLifecycle] ${msg}`, meta ?? '');
  },
});

export default roomLifecycleService;
