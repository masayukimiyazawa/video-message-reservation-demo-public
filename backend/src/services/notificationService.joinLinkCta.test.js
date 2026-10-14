/**
 * 入室リンク通知の CTA ボタン回帰テスト
 *
 * 実害の不具合（2 重-cause）:
 *   1) notificationService が `type: 'REPLY_BUTTON'` というリテラル文字列を
 *      書いていたが、OutMessageType.REPLY_BUTTON の値は 'reply_button'。
 *      → toWhatsAppPayload の switch に一致せず default（プレーンテキスト）に落ち、
 *        ボタンが一切付かない本文だけのメッセージが送信されていた。
 *   2) さらに joinUrl が OutMessage のどこにも入っておらず、option に url が無い。
 *      → 仮に reply button として描画されても、タップで URL は開かず
 *        「会議に参加」というテキストがボットへ返信されるだけだった。
 *
 * 検証の要点:
 *   - 手動再通知/10分前リマインダーの outMessage.type が 'cta_url' になる
 *   - 発行した入室 URL が option.url に載る
 *   - 送信ペイロードが WhatsApp cta_url インタラクティブになる
 *   - Sandbox フォールバック時は URL を含むプレーンテキストになる
 *
 * @module services/notificationService.joinLinkCta.test
 */

import { jest } from '@jest/globals';

import {
  createNotificationService,
  RESERVATION_MANUAL_JOIN_LINK_EVENT,
} from './notificationService.js';
import { toWhatsAppPayload } from './whatsAppClient.js';
import { OutMessageType } from '../domain/constants.js';

const RESERVATION = {
  reservationId: 'r-1',
  contact: '819012345678',
  language: 'ja',
  service: 'Consultation',
  sessionId: 'sess-1',
  reservationTime: '2026-10-03T01:30:00.000Z',
};

const JOIN_URL = 'https://example.test/join/tok-abc';

/** 送信された outMessage を捕捉するNotificationService を組み立てる。 */
function makeService() {
  const sent = [];
  const service = createNotificationService({
    joinLinkService: {
      async issueForReservation() {
        return { tokenId: 'tok-abc', url: JOIN_URL };
      },
    },
    sendTenMinReminderWhatsApp: async (_reservation, outMessage) => {
      sent.push(outMessage);
      return { ok: true };
    },
    logger: { error() {} },
  });
  return { service, sent };
}

describe('Notification_Service: 入室リンク通知の CTA ボタン', () => {
  test('手動再通知は cta_url 型で入室 URL をボタンに載せる', async () => {
    const { service, sent } = makeService();

    const result = await service.sendManualJoinLink(RESERVATION);

    expect(result).toEqual({ whatsappSent: true, joinUrl: JOIN_URL });
    expect(sent).toHaveLength(1);

    const outMessage = sent[0];
    // 1) リテラル 'REPLY_BUTTON' ではなく cta_url になっていること
    expect(outMessage.type).toBe(OutMessageType.CTA_URL);
    // 2) 発行した入室 URL がボタンに載っていること
    expect(outMessage.options[0].url).toBe(JOIN_URL);
    expect(outMessage.options[0].title).toBe('会議に参加');
  });

  test('手動再通知の送信ペイロードが WhatsApp cta_url インタラクティブになる', async () => {
    const { service, sent } = makeService();

    await service.sendManualJoinLink(RESERVATION);

    const payload = toWhatsAppPayload(sent[0], {
      to: RESERVATION.contact,
      from: '12025550102',
      language: 'ja',
    });

    expect(payload.message_type).toBe('custom');
    expect(payload.custom.type).toBe('interactive');
    // reply ではなく cta_url であること（タップで URL が開く）
    expect(payload.custom.interactive.type).toBe('cta_url');
    expect(payload.custom.interactive.action).toEqual({
      name: 'cta_url',
      parameters: { display_text: '会議に参加', url: JOIN_URL },
    });
  });

  test('英語予約でも URL 付きで cta_url になる', async () => {
    const { service, sent } = makeService();

    await service.sendManualJoinLink({ ...RESERVATION, language: 'en' });

    const payload = toWhatsAppPayload(sent[0], {
      to: RESERVATION.contact,
      from: '12025550102',
      language: 'en',
    });

    expect(payload.custom.interactive.type).toBe('cta_url');
    expect(payload.custom.interactive.action.parameters).toEqual({
      display_text: 'Join Meeting',
      url: JOIN_URL,
    });
  });

  test('Sandbox フォールバック時は URL を含むプレーンテキストになる', async () => {
    const { service, sent } = makeService();

    await service.sendManualJoinLink(RESERVATION);

    const payload = toWhatsAppPayload(sent[0], {
      to: RESERVATION.contact,
      from: '12025550102',
      language: 'ja',
      interactiveFallbackText: true,
    });

    // ボタンは描画できないため、URL を本文に含めて入室可能にする
    expect(payload.message_type).toBe('text');
    expect(payload.text).toContain(JOIN_URL);
  });

  test('10分前リマインダーも同様に cta_url で入室 URL を載せる', async () => {
    const { service, sent } = makeService();

    await service.notifyTenMinReminder(RESERVATION);

    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe(OutMessageType.CTA_URL);
    expect(sent[0].options[0].url).toBe(JOIN_URL);
  });

  test('手動再通知は Socket.IO の manualJoinLink イベントを送出する', async () => {
    const emit = jest.fn();
    const service = createNotificationService({
      joinLinkService: {
        async issueForReservation() {
          return { tokenId: 'tok-abc', url: JOIN_URL };
        },
      },
      sendTenMinReminderWhatsApp: async () => ({ ok: true }),
      emit,
      logger: { error() {} },
    });

    await service.sendManualJoinLink(RESERVATION);

    // 管理画面の通知パネルに再通知を表示するためのイベントが送出されること
    expect(emit).toHaveBeenCalledWith(
      RESERVATION_MANUAL_JOIN_LINK_EVENT,
      expect.objectContaining({
        reservationId: RESERVATION.reservationId,
        contact: RESERVATION.contact,
        service: RESERVATION.service,
        language: RESERVATION.language,
      }),
    );
  });

  test('発行された joinUrl が API 応答の joinUrl と一致する', async () => {
    const issueForReservation = jest.fn().mockResolvedValue({
      tokenId: 'tok-abc',
      url: JOIN_URL,
    });
    const service = createNotificationService({
      joinLinkService: { issueForReservation },
      sendTenMinReminderWhatsApp: async () => ({ ok: true }),
      logger: { error() {} },
    });

    const result = await service.sendManualJoinLink(RESERVATION);

    // ボタンと API 応答で別の URL を返さないこと（片方だけ古いと入室できない）
    expect(issueForReservation).toHaveBeenCalledTimes(1);
    expect(result.joinUrl).toBe(JOIN_URL);
  });
});
