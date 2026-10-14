/**
 * Notification_Service（スケジューラ + Socket.IO / 要件 3.1・3.2・3.4）
 *
 * 設計書 Components の Notification_Service に対応する。以下の 2 種類の通知を定期的に送信する：
 *  1. 予約時刻到来通知（reservation:due） - 予約時刻になったとき
 *  2. リマインダー通知（reservation:reminder） - 予約時刻の前（既定 24h/1h 前など）
 *
 * 配線する依存:
 *  - ドメイン: selectDueReservations(reservations, now) … `reservationTime <= now`
 *              かつ `notified === false` の予約を厳密に抽出（要件 3.1・3.2 / Property 6）
 *  - ドメイン: selectReminderReservations(reservations, now, windowMs) … 予約時刻前の
 *              リマインダー対象を抽出（要件 3.1）
 *  - インフラ: Reservation_Store.find / markNotified / markReminderSent … 予約取得と通知済み更新
 *  - インフラ: Socket.IO エミッタ … `reservation:due` / `reservation:reminder` 送出（要件 3.2）
 *  - 外部: WhatsApp 送信関数（Vonage Messages API ラッパ）… 通知メッセージ送信（要件 3.1）
 *
 * 部分的失敗の許容（要件 3.4）:
 *  WhatsApp 送信が失敗した場合でも失敗を記録した上で、Socket.IO による画面通知の送出は
 *  継続する。いずれか一方でも通知が試行された予約は `notified = true` / `reminderSent = true` に
 *  更新し、次回ポーリングでの二重通知を防ぐ。
 *
 * スケジューラの起動方針:
 *  本モジュールのインポート時には node-cron を自動起動しない（副作用回避）。
 *  エントリーポイント（index.js）が `startNotificationScheduler` /
 *  `startReminderScheduler` を明示的に呼び出してスケジュールを開始する。
 *
 * 依存はすべて注入可能にし、ユニットテストで Socket.IO エミッタと
 * WhatsApp 送信のモックを差し込んで挙動を検証できるようにする。
 *
 * @typedef {import('../domain/types.js').Reservation} Reservation
 */

import cron from 'node-cron';

import env from '../config/env.js';
import { selectDueReservations } from '../domain/selectDueReservations.js';
import { selectReminderReservations } from '../domain/selectReminderReservations.js';
import { reservationStore as defaultStore } from '../infra/reservationStore.js';
import { joinLinkService as defaultJoinLinkService } from './joinLinkService.js';
import { formatDateTime } from '../domain/conversation.js';
import { OutMessageType } from '../domain/constants.js';

/** Admin_UI へ画面通知を届けるための Socket.IO イベント名（要件 3.2・3.3）。 */
export const RESERVATION_DUE_EVENT = 'reservation:due';
/** リマインダー通知用の Socket.IO イベント名。 */
export const RESERVATION_REMINDER_EVENT = 'reservation:reminder';
/** 管理者による手動再通知（ジョインリンク再送）用の Socket.IO イベント名。 */
export const RESERVATION_MANUAL_JOIN_LINK_EVENT = 'reservation:manualJoinLink';

/**
 * 既定の WhatsApp 送信関数（未配線時のフォールバック）。
 *
 * 実際の Vonage Messages API 連携（Chatbot_Service / Task 10.x で用意される
 * メッセージクライアント）が注入されるまでの安全なプレースホルダ。呼び出されると
 * 失敗として扱えるよう例外を送出し、要件 3.4 の「WhatsApp 送信失敗時も画面通知を継続」
 * を実運用前でも観測可能にする。
 *
 * @param {Reservation} _reservation
 * @returns {Promise<never>}
 */
async function unconfiguredSendWhatsApp(_reservation) {
  throw new Error(
    'WhatsApp 送信関数が未設定です。Notification_Service に sendWhatsApp を注入してください。',
  );
}

/**
 * 既定のリマインダー WhatsApp 送信関数（未配線時のフォールバック）。
 *
 * @param {Reservation} _reservation
 * @returns {Promise<never>}
 */
async function unconfiguredSendReminderWhatsApp(_reservation) {
  throw new Error(
    'リマインダー WhatsApp 送信関数が未設定です。Notification_Service に sendReminderWhatsApp を注入してください。',
  );
}

/**
 * 何も送出しない既定の Socket.IO エミッタ（未配線時のフォールバック）。
 * @param {string} _event
 * @param {*} _payload
 * @returns {void}
 */
function noopEmit(_event, _payload) {
  // Socket.IO 未配線時は何もしない（起動順序に依存しないため安全）。
}

/**
 * Notification_Service を生成する。
 *
 * @param {object} [deps]
 * @param {typeof defaultStore} [deps.store] Reservation_Store リポジトリ
 * @param {(event: string, payload: *) => void} [deps.emit]
 *        Socket.IO 送出関数（例: `io.emit.bind(io)`）。テストではモックを注入。
 * @param {(reservation: Reservation) => Promise<*>} [deps.sendWhatsApp]
 *        WhatsApp 通知送信関数（Vonage Messages API ラッパ）。テストではモックを注入。
 * @param {{ error: Function, info?: Function }} [deps.logger] ロガー
 * @param {() => Date} [deps.clock] 現在時刻取得関数（テスト時に固定可能）
 * @param {string} [deps.cronExpression] node-cron のスケジュール式
 * @returns {{
 *   pollDueReservations: () => Promise<{ processed: number, notified: number, whatsappFailures: number }>,
 *   notify: (reservation: Reservation) => Promise<{ whatsappSent: boolean }>,
 *   startNotificationScheduler: () => import('node-cron').ScheduledTask,
 * }}
 */
export function createNotificationService(deps = {}) {
  const store = deps.store ?? defaultStore;
  const emit = deps.emit ?? noopEmit;
  const sendWhatsApp = deps.sendWhatsApp ?? unconfiguredSendWhatsApp;
  const sendReminderWhatsApp = deps.sendReminderWhatsApp ?? unconfiguredSendReminderWhatsApp;
  const sendTenMinReminderWhatsApp = deps.sendTenMinReminderWhatsApp ?? unconfiguredSendReminderWhatsApp;
  const joinLinkService = deps.joinLinkService ?? defaultJoinLinkService;
  const logger = deps.logger ?? console;
  const clock = deps.clock ?? (() => new Date());
  const cronExpression = deps.cronExpression ?? env.notificationCron;
  const reminderCronExpression = deps.reminderCronExpression ?? env.notificationReminderCron;
  const reminderWindowMs = deps.reminderWindowMs ?? env.notificationReminderWindowMs;
  const tenMinReminderCronExpression = deps.tenMinReminderCronExpression ?? env.notificationTenMinReminderCron;
  const tenMinReminderWindowMs = deps.tenMinReminderWindowMs ?? env.notificationTenMinReminderWindowMs;

  /**
   * 単一の到来予約について通知を送出する（要件 3.1・3.2・3.4）。
   *
   * 手順:
   *  1. WhatsApp 通知を送信する。失敗しても例外を握りつぶし、失敗として記録する。
   *  2. WhatsApp の成否に関わらず、Socket.IO `reservation:due` を送出する（部分的失敗の許容）。
   *
   * `notified` の更新は呼び出し元（pollDueReservations）が行う。
   *
   * @param {Reservation} reservation 到来した予約
   * @returns {Promise<{ whatsappSent: boolean }>}
   */
  async function notify(reservation) {
    let whatsappSent = false;

    // 1. WhatsApp 通知送信（失敗は記録し、後続の画面通知は継続する / 要件 3.4）
    try {
      await sendWhatsApp(reservation);
      whatsappSent = true;
    } catch (err) {
      logger.error(
        `[Notification_Service] WhatsApp 通知の送信に失敗しました (reservationId=${reservation?.reservationId}):`,
        err,
      );
    }

    // 2. Socket.IO 画面通知イベントの送出（WhatsApp 成否に関わらず継続 / 要件 3.2・3.4）
    try {
      emit(RESERVATION_DUE_EVENT, {
        reservationId: reservation?.reservationId,
        contact: reservation?.contact,
        reservationTime: reservation?.reservationTime,
        service: reservation?.service,
        language: reservation?.language,
        assignedStaffId: reservation?.assignedStaffId,
      });
    } catch (err) {
      logger.error(
        `[Notification_Service] 画面通知イベントの送出に失敗しました (reservationId=${reservation?.reservationId}):`,
        err,
      );
    }

    return { whatsappSent };
  }

  /**
   * 単一の予約についてリマインダー通知を送出する（要件 3.1・3.4）。
   *
   * 手順:
   *  1. WhatsApp リマインダー通知を送信する。失敗しても例外を握りつぶし、失敗として記録する。
   *  2. WhatsApp の成否に関わらず、Socket.IO `reservation:reminder` を送出する（部分的失敗の許容）。
   *
   * `reminderSent` の更新は呼び出し元（pollReminderReservations）が行う。
   *
   * @param {Reservation} reservation リマインダー対象の予約
   * @returns {Promise<{ whatsappSent: boolean }>}
   */
  async function notifyReminder(reservation) {
    let whatsappSent = false;

    // 1. WhatsApp リマインダー通知送信（失敗は記録し、後続の画面通知は継続する / 要件 3.4）
    try {
      await sendReminderWhatsApp(reservation);
      whatsappSent = true;
    } catch (err) {
      logger.error(
        `[Notification_Service] WhatsApp リマインダー通知の送信に失敗しました (reservationId=${reservation?.reservationId}):`,
        err,
      );
    }

    // 2. Socket.IO 画面通知イベントの送出（WhatsApp 成否に関わらず継続 / 要件 3.4）
    try {
      emit(RESERVATION_REMINDER_EVENT, {
        reservationId: reservation?.reservationId,
        contact: reservation?.contact,
        reservationTime: reservation?.reservationTime,
        service: reservation?.service,
        language: reservation?.language,
        assignedStaffId: reservation?.assignedStaffId,
      });
    } catch (err) {
      logger.error(
        `[Notification_Service] リマインダー画面通知イベントの送出に失敗しました (reservationId=${reservation?.reservationId}):`,
        err,
      );
    }

    return { whatsappSent };
  }

  /**
   * リマインダー対象予約をポーリングして通知を送出する（要件 3.1・3.4）。
   *
   * 手順:
   *  1. 10分前リマインダー未送信（tenMinReminderSent !== true）かつ確定済みの予約候補を取得する。
   *  2. selectReminderReservations でウィンドウ内のものを厳密に抽出する。
   *  3. 各予約について notifyReminder を実行（WhatsApp + Socket.IO）。
   *  4. tenMinReminderSent を true に更新して二重通知を防ぐ。更新失敗は記録し処理を継続する。
   *
   * 予約 1 件の処理失敗が他の予約の処理を止めないよう、各予約を独立に扱う。
   *
   * @returns {Promise<{ processed: number, reminded: number, whatsappFailures: number }>}
   */
  async function pollReminderReservations() {
    let candidates;
    try {
      // リマインダー未送信かつ確定済みの予約のみを対象に取得（負荷軽減）。
      candidates = await store.find({
        reminderSent: { $ne: true },
        status: 'confirmed',
      });
    } catch (err) {
      logger.error('[Notification_Service] リマインダー対象予約の取得に失敗しました:', err);
      return { processed: 0, reminded: 0, whatsappFailures: 0 };
    }

    const now = clock();
    const due = selectReminderReservations(candidates, now, reminderWindowMs);

    let remindedCount = 0;
    let whatsappFailures = 0;

    for (const reservation of due) {
      const { whatsappSent } = await notifyReminder(reservation);
      if (!whatsappSent) {
        whatsappFailures += 1;
      }

      // リマインダー送信済みフラグを更新。失敗しても他予約の処理は継続する。
      try {
        await store.markReminderSent(reservation.reservationId);
        remindedCount += 1;
      } catch (err) {
        logger.error(
          `[Notification_Service] リマインダー送信済みフラグの更新に失敗しました (reservationId=${reservation?.reservationId}):`,
          err,
        );
      }
    }

    return { processed: due.length, reminded: remindedCount, whatsappFailures };
  }

  /**
   * 到来予約をポーリングして通知を送出する（要件 3.1・3.2・3.4）。
   *
   * 手順:
   *  1. 未通知（notified !== true）の予約候補を Reservation_Store から取得する。
   *  2. selectDueReservations で `reservationTime <= now` かつ未通知のものを厳密に抽出する。
   *  3. 各予約について notify を実行（WhatsApp + Socket.IO）。
   *  4. notified を true に更新して二重通知を防ぐ。更新失敗は記録し処理を継続する。
   *
   * 予約 1 件の処理失敗が他の予約の処理を止めないよう、各予約を独立に扱う。
   *
   * @returns {Promise<{ processed: number, notified: number, whatsappFailures: number }>}
   */
  async function pollDueReservations() {
    let candidates;
    try {
      // 未通知の予約のみを対象に取得（負荷軽減）。厳密な期限判定はドメイン関数に委ねる。
      candidates = await store.find({ notified: { $ne: true } });
    } catch (err) {
      logger.error('[Notification_Service] 未通知予約の取得に失敗しました:', err);
      return { processed: 0, notified: 0, whatsappFailures: 0 };
    }

    const now = clock();
    const due = selectDueReservations(candidates, now);

    let notifiedCount = 0;
    let whatsappFailures = 0;

    for (const reservation of due) {
      const { whatsappSent } = await notify(reservation);
      if (!whatsappSent) {
        whatsappFailures += 1;
      }

      // 通知済みフラグを更新（要件 3.2）。失敗しても他予約の処理は継続する。
      try {
        await store.markNotified(reservation.reservationId);
        notifiedCount += 1;
      } catch (err) {
        logger.error(
          `[Notification_Service] 通知済みフラグの更新に失敗しました (reservationId=${reservation?.reservationId}):`,
          err,
        );
      }
    }

    return { processed: due.length, notified: notifiedCount, whatsappFailures };
  }

  /**
   * node-cron で pollDueReservations を定期実行するスケジューラを開始する。
   *
   * 本関数は明示的に呼び出されたときのみスケジュールを登録する（インポート時の
   * 副作用は持たない）。エントリーポイント（index.js / Task 13.1）から呼び出す想定。
   *
   * @returns {import('node-cron').ScheduledTask} 登録済みタスク（停止制御に利用可能）
   */
  function startNotificationScheduler() {
    const task = cron.schedule(cronExpression, () => {
      pollDueReservations().catch((err) => {
        logger.error('[Notification_Service] pollDueReservations の実行に失敗しました:', err);
      });
    });
    logger.info?.(`[Notification_Service] スケジューラを開始しました (cron="${cronExpression}")`);
    return task;
  }

  /**
   * node-cron で pollReminderReservations を定期実行するリマインダースケジューラを開始する。
   *
   * 本関数は明示的に呼び出されたときのみスケジュールを登録する（インポート時の
   * 副作用は持たない）。エントリーポイント（index.js）から呼び出す想定。
   *
   * @returns {import('node-cron').ScheduledTask} 登録済みタスク（停止制御に利用可能）
   */
  function startReminderScheduler() {
    const task = cron.schedule(reminderCronExpression, () => {
      pollReminderReservations().catch((err) => {
        logger.error('[Notification_Service] pollReminderReservations の実行に失敗しました:', err);
      });
    });
    logger.info?.(`[Notification_Service] リマインダースケジューラを開始しました (cron="${reminderCronExpression}", windowMs=${reminderWindowMs})`);
    return task;
  }

  /**
   * 10分前リマインダー通知用のジョインボタン付きメッセージを作成する。
   *
   * @param {Reservation} reservation
   * @returns {Promise<{ outMessage: object, joinUrl: string }>}
   */
  async function buildTenMinReminderMessage(reservation) {
    const { tokenId, url: joinUrl } = await joinLinkService.issueForReservation({
      reservationId: reservation.reservationId,
      sessionId: reservation.sessionId,
      reservationTime: reservation.reservationTime,
    });

    const lang = reservation.language === 'ja' ? 'ja' : 'en';
    const time = reservation.reservationTime ? formatDateTime(reservation.reservationTime, lang) : '';
    const serviceTitle = reservation.service;

    const text = lang === 'ja'
      ? `まもなくご予約のお時間です（${serviceTitle}）。\n日時: ${time}\n下の「会議に参加」ボタンを押してご参加ください。\n※このリンクは一度だけ有効です。`
      : `Your reservation (${serviceTitle}) is starting soon.\nTime: ${time}\nTap the "Join Meeting" button below to join.\n※This link is one-time only.`;

    const joinButtonTitle = lang === 'ja' ? '会議に参加' : 'Join Meeting';

    // 入室ボタンはタップで URL を開く CTA にする。reply button だと
    // 「会議に参加」というテキストがボットへ返信されるだけで入室できない。
    const outMessage = {
      type: OutMessageType.CTA_URL,
      text,
      options: [
        { id: `join_${reservation.reservationId}`, title: joinButtonTitle, url: joinUrl },
      ],
    };

    return { outMessage, joinUrl };
  }

  /**
   * 手動送信用のジョインリンクメッセージを作成する（管理者用）。
   *
   * @param {Reservation} reservation
   * @returns {Promise<{ outMessage: object, joinUrl: string }>}
   */
  async function buildManualJoinMessage(reservation) {
    const { tokenId, url: joinUrl } = await joinLinkService.issueForReservation({
      reservationId: reservation.reservationId,
      sessionId: reservation.sessionId,
      reservationTime: reservation.reservationTime,
    });

    const lang = reservation.language === 'ja' ? 'ja' : 'en';
    const time = reservation.reservationTime ? formatDateTime(reservation.reservationTime, lang) : '';
    const serviceTitle = reservation.service;

    const text = lang === 'ja'
      ? `管理者からのご案内です。\nご予約（${reservation.service}）のお時間です。\n日時: ${time}\n下の「会議に参加」ボタンを押してご参加ください。\n※このリンクは一度だけ有効です。`
      : `This is a notification from the administrator.\nYour reservation (${serviceTitle}) is starting.\nTime: ${time}\nTap the "Join Meeting" button below to join.\n※This link is one-time only.`;

    const joinButtonTitle = lang === 'ja' ? '会議に参加' : 'Join Meeting';

    // 入室ボタンはタップで URL を開く CTA にする。reply button だと
    // 「会議に参加」というテキストがボットへ返信されるだけで入室できない。
    const outMessage = {
      type: OutMessageType.CTA_URL,
      text,
      options: [
        { id: `join_${reservation.reservationId}`, title: joinButtonTitle, url: joinUrl },
      ],
    };

    return { outMessage, joinUrl };
  }

  /**
   * 10分前リマインダー通知を単一予約に送信する（要件 3.1・3.4）。
   *
   * @param {Reservation} reservation リマインダー対象の予約
   * @returns {Promise<{ whatsappSent: boolean }>}
   */
  async function notifyTenMinReminder(reservation) {
    let whatsappSent = false;

    try {
      const { outMessage, joinUrl } = await buildTenMinReminderMessage(reservation);
      await sendTenMinReminderWhatsApp(reservation, outMessage);
      whatsappSent = true;
    } catch (err) {
      logger.error(
        `[Notification_Service] 10分前リマインダー WhatsApp 送信に失敗 (reservationId=${reservation?.reservationId}):`,
        err,
      );
    }

    // Socket.IO 画面通知も送出
    try {
      emit('reservation:tenMinReminder', {
        reservationId: reservation?.reservationId,
        contact: reservation?.contact,
        reservationTime: reservation?.reservationTime,
        service: reservation?.service,
        language: reservation?.language,
        assignedStaffId: reservation?.assignedStaffId,
      });
    } catch (err) {
      logger.error(
        `[Notification_Service] 10分前リマインダー画面通知の送出に失敗 (reservationId=${reservation?.reservationId}):`,
        err,
      );
    }

    return { whatsappSent };
  }

  /**
   * 管理者による手動ジョインリンク送信（管理画面から呼び出し）。
   *
   * @param {Reservation} reservation
   * @returns {Promise<{ whatsappSent: boolean, joinUrl: string }>}
   */
  async function sendManualJoinLink(reservation) {
    let whatsappSent = false;
    let joinUrl = '';

    try {
      const { outMessage, joinUrl } = await buildManualJoinMessage(reservation);
      await sendTenMinReminderWhatsApp(reservation, outMessage);
      whatsappSent = true;

      // 管理画面の通知パネルに再通知を表示するための Socket.IO イベントを送出
      try {
        emit(RESERVATION_MANUAL_JOIN_LINK_EVENT, {
          reservationId: reservation?.reservationId,
          contact: reservation?.contact,
          reservationTime: reservation?.reservationTime,
          service: reservation?.service,
          language: reservation?.language,
          assignedStaffId: reservation?.assignedStaffId,
        });
      } catch (emitErr) {
        logger.error(
          `[Notification_Service] 手動再通知イベントの送出に失敗 (reservationId=${reservation?.reservationId}):`,
          emitErr,
        );
      }

      return { whatsappSent, joinUrl };
    } catch (err) {
      logger.error(
        `[Notification_Service] 手動ジョインリンク送信失敗 (reservationId=${reservation?.reservationId}):`,
        err,
      );
      return { whatsappSent: false, joinUrl: '' };
    }
  }

  /**
   * 10分前リマインダー対象予約をポーリングして通知を送出する。
   *
   * 対象: 確定済み・リマインダー未送信・予約時刻10分前（ウィンドウ内）の予約
   *
   * @returns {Promise<{ processed: number, reminded: number, whatsappFailures: number }>}
   */
  async function pollTenMinReminderReservations() {
    let candidates;
    try {
      // リマインダー未送信かつ確定済みの予約のみを対象に取得（負荷軽減）。
      candidates = await store.find({
        tenMinReminderSent: { $ne: true },
        status: 'confirmed',
      });
    } catch (err) {
      logger.error('[Notification_Service] 10分前リマインダー対象予約の取得に失敗しました:', err);
      return { processed: 0, reminded: 0, whatsappFailures: 0 };
    }

    const now = clock();
    // 24時間前リマインダーと共有せず tenMinReminderSent で判定する。
    // 共有すると 24時間前リマインダーが先に送信済みになり、
    // 開催10分前の通知が永久に送られなくなる。
    const due = selectReminderReservations(
      candidates,
      now,
      tenMinReminderWindowMs,
      'tenMinReminderSent',
    );

    let remindedCount = 0;
    let whatsappFailures = 0;

    for (const reservation of due) {
      const { whatsappSent } = await notifyTenMinReminder(reservation);
      if (!whatsappSent) {
        whatsappFailures += 1;
      }

      // 10分前リマインダー送信済みフラグを更新。失敗しても他予約の処理は継続する。
      try {
        await store.markTenMinReminderSent(reservation.reservationId);
        remindedCount += 1;
      } catch (err) {
        logger.error(
          `[Notification_Service] 10分前リマインダー送信済みフラグの更新に失敗 (reservationId=${reservation?.reservationId}):`,
          err,
        );
      }
    }

    return { processed: due.length, reminded: remindedCount, whatsappFailures };
  }

  /**
   * node-cron で pollTenMinReminderReservations を定期実行するスケジューラを開始する。
   *
   * 本関数は明示的に呼び出されたときのみスケジュールを登録する（インポート時の
   * 副作用は持たない）。エントリーポイント（index.js）から呼び出す想定。
   *
   * @returns {import('node-cron').ScheduledTask} 登録済みタスク（停止制御に利用可能）
   */
  function startTenMinReminderScheduler() {
    const task = cron.schedule(tenMinReminderCronExpression, () => {
      pollTenMinReminderReservations().catch((err) => {
        logger.error('[Notification_Service] pollTenMinReminderReservations の実行に失敗しました:', err);
      });
    });
    logger.info?.(`[Notification_Service] 10分前リマインダースケジューラを開始しました (cron="${tenMinReminderCronExpression}", windowMs=${tenMinReminderWindowMs})`);
    return task;
  }

  return {
    pollDueReservations,
    notify,
    startNotificationScheduler,
    pollReminderReservations,
    notifyReminder,
    startReminderScheduler,
    pollTenMinReminderReservations,
    notifyTenMinReminder,
    startTenMinReminderScheduler,
    sendManualJoinLink,
  };
}

/**
 * 既定の依存で構成した Notification_Service インスタンス。
 * 実際の Socket.IO エミッタと WhatsApp 送信関数は起動時に別途注入する構成を推奨する
 * （このインスタンスは未配線のフォールバックを用いるため、WhatsApp 送信は失敗扱いとなる）。
 */
export const notificationService = createNotificationService();

export default notificationService;
