/**
 * Vonage Messages API Webhook 統合テスト（Task 18.1 / 要件 1.1・1.2・1.4）
 *
 * 受信〜返信の一連の流れを HTTP レベルで代表例により検証する（外部挙動の網羅は目的としない）。
 *
 * 検証対象（エンドツーエンド）:
 *  - WhatsApp 受信メッセージが Webhook ルート（POST /webhooks/inbound-message）に到達し、
 *  - Chatbot_Service が実 nextStep（ドメイン純粋関数）で会話を前進させ、
 *  - 完了時に実 Reservation_System（インメモリ store）へ予約を作成し、
 *  - WhatsApp 確定メッセージ（確定種別）が送信される（whatsAppClient のスパイで確認）。
 *
 * 実装方針:
 *  - HTTP レベルでの検証を行うが、外部依存を避けるため supertest は導入せず、
 *    Node 標準の http モジュールで createApp に対して実 HTTP リクエストを送る。
 *  - 実 nextStep / buildReservationDTO / reservationService（+ インメモリ store）を配線し、
 *    モックするのは外部境界（Vonage WhatsApp 送信）と署名検証ミドルウェアのみ。
 *
 * @module services/chatbot.integration.test
 */

import http from 'node:http';
import { randomUUID } from 'node:crypto';

import express from 'express';

import { createChatbotRouter } from './chatbotRoutes.js';
import { createChatbotService, createInMemoryStateStore } from './chatbotService.js';
import { createReservationService } from './reservationService.js';
import { OutMessageType, ConversationStep, ReservationStatus } from '../domain/constants.js';

/**
 * インメモリの Reservation_Store フェイク。
 * reservationService が用いる save / findById / find / updateStatus を提供する。
 * 実 DB を使わずに validateReservation + checkAvailability + 永続化を通す。
 * @returns {{ save: Function, findById: Function, find: Function, updateStatus: Function, _records: Map }}
 */
function makeInMemoryStore() {
  const records = new Map();
  return {
    _records: records,
    async save(record) {
      records.set(record.reservationId, { ...record });
      return { ...record };
    },
    async findById(id) {
      const r = records.get(id);
      return r ? { ...r } : null;
    },
    async find(_filter = {}) {
      return Array.from(records.values()).map((r) => ({ ...r }));
    },
    async updateStatus(id, status) {
      const r = records.get(id);
      if (!r) return null;
      const updated = { ...r, status };
      records.set(id, updated);
      return { ...updated };
    },
  };
}

/**
 * whatsAppClient のスパイ。送信された OutMessage と宛先・言語を記録する。
 * 外部 Vonage Messages API を呼ばないため実送信は発生しない。
 * @returns {{ client: object, sent: Array<{ outMessage: object, to: string, language: string }>, texts: Array<object> }}
 */
function makeWhatsAppSpy() {
  const sent = [];
  const texts = [];
  return {
    sent,
    texts,
    client: {
      async sendOutMessage(outMessage, { to, language }) {
        sent.push({ outMessage, to, language });
        return { ok: true, response: { message_uuid: `uuid-${sent.length}` } };
      },
      async sendText({ to, text }) {
        texts.push({ to, text });
        return { ok: true, response: { message_uuid: `text-${texts.length}` } };
      },
    },
  };
}

/** 署名検証をバイパスするパススルーミドルウェア（テスト用）。 */
const passThroughVerifyWebhook = (_req, _res, next) => next();

/**
 * createApp を実 HTTP サーバーとして起動し、POST /webhooks/inbound-message に JSON を送る。
 * supertest を使わず Node 標準 http で HTTP レベルの往復を検証する。
 * @param {import('express').Express} app
 * @param {object} body
 * @returns {Promise<{ status: number, json: object }>}
 */
function postInbound(app, body) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const { port } = server.address();
      const payload = JSON.stringify(body);
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          method: 'POST',
          path: '/webhooks/inbound-message',
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(payload),
          },
        },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => {
            server.close(() => {
              resolve({ status: res.statusCode, json: data ? JSON.parse(data) : null });
            });
          });
        },
      );
      req.on('error', (err) => {
        server.close(() => reject(err));
      });
      req.write(payload);
      req.end();
    });
  });
}

/**
 * 実機 Vonage Messages API（WhatsApp）inbound のインタラクティブ選択ペイロードを組み立てる。
 * 実データではボタン/リスト選択は トップレベル `message_type: "reply"` として届き、
 * 選択値は トップレベル `reply.id` に入る（例 `reply: { id: "consultation" }`）。
 * @param {string} from 送信者 WhatsApp 番号
 * @param {string} id 選択された選択肢 ID（例 'consultation' / 'day_1' / 'slot_1030'）
 * @param {('en'|'ja')} language
 * @param {string} [title] 選択肢の表示名（無ければ id を流用）
 * @returns {object}
 */
function makeReplyPayload(from, id, language, title) {
  return {
    from,
    channel: 'whatsapp',
    message_type: 'reply',
    reply: { id, title: title ?? id },
    language,
  };
}

/**
 * 実機 Vonage Messages API（WhatsApp）inbound のテキストメッセージペイロードを組み立てる。
 * 実データではテキストは トップレベル `message_type: "text"` と `text` で届く。
 * @param {string} from
 * @param {string} text
 * @param {('en'|'ja')} language
 * @returns {object}
 */
function makeTextPayload(from, text, language) {
  return { from, channel: 'whatsapp', message_type: 'text', text, language };
}

/**
 * 単一送信者について、予約完了までの受信メッセージ列を順次 Webhook へ送る。
 *
 * 実機 Vonage の形状で入力を与える:
 *  - サービス/日付/時刻の選択は インタラクティブ reply（`message_type: 'reply'`,
 *    `reply.id`）で送る。
 *  - 予約開始・確定はテキスト（`message_type: 'text'`, `text`）で送る。
 * これにより Chatbot_Service の extractInputValue が実データから選択値を正しく拾えるかを
 * エンドツーエンドで検証する。
 *
 * @param {import('express').Express} app
 * @param {string} from 送信者 WhatsApp 番号
 * @param {string} slotId SELECT_TIME で送るスロット ID（例 'slot_1030'）
 * @param {('en'|'ja')} language
 * @returns {Promise<Array<{ status: number, json: object }>>} 各ターンの応答
 */
async function driveConversationToCompletion(app, from, slotId, language) {
  // START → SELECT_SERVICE → SELECT_DATE → SELECT_TIME → CONFIRM → COMPLETED
  const bodies = [
    makeTextPayload(from, '予約', language), // START: 予約開始（テキスト）
    makeReplyPayload(from, 'consultation', language, 'Consultation'), // サービス選択（reply）
    makeReplyPayload(from, 'day_1', language, 'Day 1'), // 日付選択（reply）
    makeReplyPayload(from, slotId, language), // 時刻選択（reply）
    makeTextPayload(from, 'はい', language), // 確定（テキスト）
  ];
  const responses = [];
  for (const body of bodies) {
    // eslint-disable-next-line no-await-in-loop
    responses.push(await postInbound(app, body));
  }
  return responses;
}

describe('Vonage Messages API Webhook 統合テスト (Task 18.1 / 要件 1.1・1.2・1.4)', () => {
  /**
   * 完全な会話を配線したテスト用アプリを構築する。
   * @param {('en'|'ja')} [language]
   */
  function buildApp({ clock } = {}) {
    const store = makeInMemoryStore();
    // videoClient をモック（Vonage API 呼び出し不要で session を返せるようにする）
    const mockVideoClient = {
      async createSession() {
        return { sessionId: 'mock-session-' + randomUUID() };
      },
    };
    const reservationService = createReservationService({
      store,
      logger: { error: () => {}, info: () => {} },
      videoClient: mockVideoClient,
    });
    const { client: whatsAppClient, sent } = makeWhatsAppSpy();
    // joinLinkService をモック（MongoDB 不要で入室リンクを発行できるようにする）
    const mockJoinLinkService = {
      async issueForReservation({ reservationId, sessionId, reservationTime }) {
        return { url: `https://example.test/join/${reservationId}-${sessionId}` };
      },
    };
    const chatbotService = createChatbotService({
      reservationService,
      whatsAppClient,
      joinLinkService: mockJoinLinkService,
      stateStore: createInMemoryStateStore(),
      logger: { error: () => {}, info: () => {} },
      ...(clock ? { clock } : {}),
    });
    const chatbotRouter = createChatbotRouter({
      chatbotService,
      verifyWebhook: passThroughVerifyWebhook,
    });
    // createApp は /webhooks に「実 whatsAppClient に配線された既定 chatbotRouter」を
    // マウントし、chatbot ルーターの注入口を持たない。同一パスへ後から重ねても既定側が
    // 先にレスポンスを返してしまうため、ここでは Chatbot Webhook のみを載せた最小 express を
    // 構築する。ルート（chatbotRoutes）・chatbotService・nextStep・buildReservationDTO・
    // reservationService は実物を通すため、統合フローの検証としては十分。
    const app = express();
    app.use(express.json());
    app.use('/webhooks', chatbotRouter);
    return { app, store, sent };
  }

  test('代表例1(en): 実データ形状（message_type:reply）で受信→会話進行→予約作成→確定メッセージ送信の一連が成立する', async () => {
    // 固定クロックを注入し、slot_1030 → 10:30 が決定的に解決されることを検証する。
    const clock = () => new Date('2025-06-10T00:00:00Z');
    const { app, store, sent } = buildApp({ clock });
    const from = '12025550101';

    // 時刻は実データのスロット ID（slot_1030）で選択させる。
    const responses = await driveConversationToCompletion(app, from, 'slot_1030', 'en');

    // デバッグ用：最終ターンの内容を出力
    console.log('DEBUG finalTurn:', JSON.stringify(responses[responses.length - 1], null, 2));

    // すべてのターンが HTTP 200 で受領される（Webhook 受領完了）。
    for (const r of responses) {
      expect(r.status).toBe(200);
    }

    // 中間ターン（START〜CONFIRM 直前）は次状態を返す（要件 1.1）。
    const startTurn = responses[0];
    expect(startTurn.json.ok).toBe(true);
    expect(startTurn.json.nextState.step).toBe(ConversationStep.SELECT_SERVICE);

    // 最終ターンは予約作成成功を返す（要件 1.2・1.3）。
    const finalTurn = responses[responses.length - 1];
    expect(finalTurn.json.ok).toBe(true);
    expect(finalTurn.json.reservation).toBeDefined();
    expect(finalTurn.json.reservation.contact).toBe(from);
    // reply.id から抽出された 'consultation' が文字列として保存される（[object Object] にならない）。
    expect(finalTurn.json.reservation.service).toBe('consultation');
    expect(typeof finalTurn.json.reservation.service).toBe('string');
    expect(finalTurn.json.reservation.language).toBe('en');
    // 会話完了時点で確定メッセージを送るため、ステータスは CONFIRMED になる（事前リマインダー対象のため）。
    expect(finalTurn.json.reservation.status).toBe(ReservationStatus.CONFIRMED);

    // 予約が実際に store に永続化されている（要件 1.3）。
    const persisted = await store.find({});
    expect(persisted).toHaveLength(1);
    expect(persisted[0].contact).toBe(from);
    // day_1（基準日当日）+ slot_1030（10:30 JST = 01:30 UTC）。slot は JST 表記として扱われ UTC に変換される。
    const reservedAt = new Date(persisted[0].reservationTime);
    expect(reservedAt.toISOString()).toBe('2025-06-10T01:30:00.000Z');
    expect(reservedAt.getUTCMinutes()).toBe(30);
    expect(reservedAt.getUTCFullYear()).not.toBe(2000);

    // 確定メッセージ（CONFIRMATION 種別）が en で送信された（要件 1.4）。
    const confirmation = sent.find((s) => s.outMessage.type === OutMessageType.CONFIRMATION);
    expect(confirmation).toBeDefined();
    expect(confirmation.to).toBe(from);
    expect(confirmation.language).toBe('en');

    // 会話冒頭ではインタラクティブメッセージ（reply button）が送信されている（要件 1.1）。
    const firstInteractive = sent[0];
    expect(firstInteractive.outMessage.type).toBe(OutMessageType.REPLY_BUTTON);
    expect(Array.isArray(firstInteractive.outMessage.options)).toBe(true);
  });

  test('代表例2(ja): 実データ形状の日本語会話でも予約作成と確定メッセージ送信が言語一致で成立する', async () => {
    const clock = () => new Date('2025-06-10T00:00:00Z');
    const { app, store, sent } = buildApp({ clock });
    const from = '+818012345678';

    const responses = await driveConversationToCompletion(app, from, 'slot_1400', 'ja');

    const finalTurn = responses[responses.length - 1];
    expect(finalTurn.status).toBe(200);
    expect(finalTurn.json.ok).toBe(true);
    expect(finalTurn.json.reservation.language).toBe('ja');
    // reply.id 由来のサービスが文字列で保存される。
    expect(finalTurn.json.reservation.service).toBe('consultation');

    const persisted = await store.find({});
    expect(persisted).toHaveLength(1);
    expect(persisted[0].contact).toBe(from);
    // slot_1400 → 14:00 JST = 05:00 UTC。slot は JST 表記として扱われ UTC に変換される。
    expect(new Date(persisted[0].reservationTime).toISOString()).toBe('2025-06-10T05:00:00.000Z');

    // 確定メッセージが ja で送信された（要件 1.4・6.3 の言語一致）。
    const confirmation = sent.find((s) => s.outMessage.type === OutMessageType.CONFIRMATION);
    expect(confirmation).toBeDefined();
    expect(confirmation.language).toBe('ja');
  });

  test('代表例3: 予約枠重複時は確定を送らず予約不可＋代替候補(list)を返信する（要件 1.5）', async () => {
    // 固定クロック + 同一スロット選択で同一時刻の重複を再現する。
    const clock = () => new Date('2025-06-10T00:00:00Z');
    const { app, store, sent } = buildApp({ clock });
    const slotId = 'slot_0900';

    // 先に同一時刻の予約を 1 件作成しておく（枠を占有させる）。
    await driveConversationToCompletion(app, '+15550000001', slotId, 'en');
    const beforeCount = (await store.find({})).length;
    expect(beforeCount).toBe(1);

    // 別の送信者が同一時刻を希望 → 重複により slot_unavailable になる。
    const sentBefore = sent.length;
    const responses = await driveConversationToCompletion(app, '+15550000002', slotId, 'en');

    const finalTurn = responses[responses.length - 1];
    expect(finalTurn.status).toBe(200);
    expect(finalTurn.json.ok).toBe(false);
    expect(finalTurn.json.code).toBe('slot_unavailable');

    // 予約は増えていない（重複は保存されない）。
    expect((await store.find({})).length).toBe(1);

    // 代替候補（list 種別）が返信され、確定メッセージは送られていない。
    const newlySent = sent.slice(sentBefore);
    const listMsg = newlySent.find((s) => s.outMessage.type === OutMessageType.LIST);
    expect(listMsg).toBeDefined();
    expect(Array.isArray(listMsg.outMessage.options)).toBe(true);
    const confirmation = newlySent.find((s) => s.outMessage.type === OutMessageType.CONFIRMATION);
    expect(confirmation).toBeUndefined();
  });

  test('代表例4: 実運用の day_N/slot_HHMM 選択でも注入クロックの年で予約が作成される（年 2000 バグ回帰防止・要件 1.2）', async () => {
    // 固定クロックを注入し、reservationTime が決定的に解決されることを検証する。
    const clock = () => new Date('2025-06-10T00:00:00Z');
    const { app, store } = buildApp({ clock });
    const from = '+15559990000';

    // インタラクティブ選択（day_N / slot_HHMM）で会話を完了まで進める。
    const inputs = [undefined, 'consultation', 'day_2', 'slot_0900', 'confirm'];
    const responses = [];
    for (const value of inputs) {
      const body = { from, language: 'en' };
      if (value !== undefined) body.text = value;
      // eslint-disable-next-line no-await-in-loop
      responses.push(await postInbound(app, body));
    }

    const finalTurn = responses[responses.length - 1];
    expect(finalTurn.status).toBe(200);
    expect(finalTurn.json.ok).toBe(true);

    const persisted = await store.find({});
    expect(persisted).toHaveLength(1);

    const reservedAt = new Date(persisted[0].reservationTime);
    expect(Number.isNaN(reservedAt.getTime())).toBe(false);
    // 注入クロックの年（2025）で解決され、固定基準の年 2000 にはならない。
    expect(reservedAt.getUTCFullYear()).toBe(2025);
    expect(reservedAt.getUTCFullYear()).not.toBe(2000);
    // day_2 = 基準日 +1 日、slot_0900 = 09:00 JST = 00:00 UTC。slot は JST 表記として扱われ UTC に変換される。
    expect(reservedAt.toISOString()).toBe('2025-06-11T00:00:00.000Z');
  });
});
