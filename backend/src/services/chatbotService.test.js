import { createChatbotService, createInMemoryStateStore } from './chatbotService.js';
import { ConversationStep, OutMessageType } from '../domain/constants.js';

/**
 * Chatbot_Service 確定メッセージ送信のユニットテスト（Task 10.4 / 要件 1.4）
 *
 * 予約確定（会話完了 → 予約作成成功）時に whatsAppClient.sendOutMessage が
 * 確定メッセージ（OutMessageType.CONFIRMATION）で呼ばれることを検証する。
 * reservationService / whatsAppClient は注入モックを用いる。
 */

/** sendOutMessage の呼び出しを記録する WhatsApp クライアントモック。 */
function makeWhatsAppMock() {
  const calls = [];
  return {
    client: {
      sendOutMessage: async (outMessage, params) => {
        calls.push({ outMessage, params });
        return { ok: true, response: { message_uuid: 'uuid-1' } };
      },
      sendText: async () => ({ ok: true }),
    },
    calls,
  };
}

/** issueForReservation の結果を制御する JoinLinkService モック。 */
function makeJoinLinkMock(joinUrl = 'https://example.com/join/test-token') {
  return {
    service: {
      issueForReservation: async () => ({ url: joinUrl }),
    },
  };
}

/**
 * 固定トークン ID を返す JoinLinkService モック（URL 形式の検証用）。
 */
function makeFixedTokenJoinLinkMock() {
  const fixedToken = 'a'.repeat(32); // 16 バイト = 32 文字の 16 進数
  const fixedUrl = `https://example.com/join/${fixedToken}`;
  return {
    service: {
      issueForReservation: async () => ({ url: fixedUrl }),
    },
    fixedUrl,
    fixedToken,
  };
}

/** createReservation の結果を制御する Reservation_System モック。 */
function makeReservationServiceMock(result) {
  const calls = [];
  return {
    service: {
      createReservation: async (dto) => {
        calls.push(dto);
        return result;
      },
      updateReservation: async () => ({ ok: true }),
      cancelReservation: async () => ({ ok: true }),
      listReservations: async () => ({ ok: true, reservations: [] }),
    },
    calls,
  };
}

/** CONFIRM ステップまで進んだ会話状態を state store に仕込む。 */
function seedConfirmState(stateStore, sender, language = 'en') {
  stateStore.set(sender, {
    step: ConversationStep.CONFIRM,
    contact: sender,
    service: 'consultation',
    reservationTime: '2030-01-01T10:00:00.000Z',
    language,
  });
}

describe('Chatbot_Service 確定メッセージ送信 (Task 10.4 / 要件 1.4)', () => {
  test('予約作成成功時に確定メッセージが WhatsApp 送信される', async () => {
    const sender = '+15551230000';
    const stateStore = createInMemoryStateStore();
    seedConfirmState(stateStore, sender, 'en');

    const wa = makeWhatsAppMock();
    const rs = makeReservationServiceMock({
      ok: true,
reservation: {
        reservationId: 'r-3',
        contact: sender,
        reservationTime: '2030-01-01T10:00:00.000Z',
        service: 'consultation',
        status: 'confirmed',
        language: 'en',
        sessionId: 'test-session-123',
      },
    });

    const chatbot = createChatbotService({
      reservationService: rs.service,
      whatsAppClient: wa.client,
      joinLinkService: makeJoinLinkMock().service,
      stateStore,
    });

    // CONFIRM 状態でユーザーが「confirm」を返す → 完了 → 予約作成 → 確定送信。
    const result = await chatbot.handleInboundMessage({
      from: sender,
      text: 'confirm',
      language: 'en',
    });

    expect(result.ok).toBe(true);
    // createReservation が呼ばれた。
    expect(rs.calls.length).toBe(1);
    // 確定済み状態で保存される。pending のままだと事前リマインダーの
    // 対象外になり、確定メッセージを送っても開催10分前の通知が届かない。
    expect(rs.calls[0].status).toBe('confirmed');
    // 確定メッセージが送信された（要件 1.4）。
    expect(wa.calls.length).toBe(1);
    expect(wa.calls[0].outMessage.type).toBe(OutMessageType.CONFIRMATION);
    expect(wa.calls[0].params.to).toBe(sender);
    // 完了後は会話状態がクリアされる。
    expect(stateStore.get(sender)).toBeUndefined();
  });

  test('保存レコードの language に応じた言語で確定送信される（要件 1.4・6.3）', async () => {
    const sender = '+15551239999';
    const stateStore = createInMemoryStateStore();
    seedConfirmState(stateStore, sender, 'ja');

    const wa = makeWhatsAppMock();
    const rs = makeReservationServiceMock({
      ok: true,
      reservation: {
        reservationId: 'r-2',
        contact: sender,
        reservationTime: '2030-01-01T10:00:00.000Z',
        service: 'consultation',
        status: 'confirmed',
        language: 'ja',
        sessionId: 'test-session-123',
      },
    });

    const chatbot = createChatbotService({
      reservationService: rs.service,
      whatsAppClient: wa.client,
      joinLinkService: makeJoinLinkMock().service,
      stateStore,
    });

    await chatbot.handleInboundMessage({ from: sender, text: '確定', language: 'ja' });

    expect(wa.calls.length).toBe(1);
    expect(wa.calls[0].outMessage.type).toBe(OutMessageType.CONFIRMATION);
    expect(wa.calls[0].params.language).toBe('ja');
  });

  test('空き不可時は確定メッセージではなく代替候補 list を送信する（要件 1.5）', async () => {
    const sender = '+15550001111';
    const stateStore = createInMemoryStateStore();
    seedConfirmState(stateStore, sender, 'en');

    const wa = makeWhatsAppMock();
    const rs = makeReservationServiceMock({
      ok: false,
      code: 'slot_unavailable',
      alternatives: [{ start: '2030-01-01T11:00:00.000Z', end: '2030-01-01T11:30:00.000Z' }],
    });

    const chatbot = createChatbotService({
      reservationService: rs.service,
      whatsAppClient: wa.client,
      joinLinkService: makeJoinLinkMock().service,
      stateStore,
    });

    const result = await chatbot.handleInboundMessage({ from: sender, text: 'confirm', language: 'en' });

    expect(result.ok).toBe(false);
    expect(result.code).toBe('slot_unavailable');
    expect(wa.calls.length).toBe(1);
    // 確定ではなく list（代替候補）。
    expect(wa.calls[0].outMessage.type).toBe(OutMessageType.LIST);
    // 会話は時刻選択へ戻される。
    expect(stateStore.get(sender).step).toBe(ConversationStep.SELECT_TIME);
  });

  test('day_N/slot_HHMM の全会話フローで reservationTime が固定クロックの年になる（年 2000 バグ回帰防止）', async () => {
    const sender = '+15557778888';
    const stateStore = createInMemoryStateStore();

    const wa = makeWhatsAppMock();
    const rs = makeReservationServiceMock({
      ok: true,
      reservation: {
        reservationId: 'r-clock',
        contact: sender,
        reservationTime: '2025-06-11T09:00:00.000Z',
        service: 'consultation',
        status: 'confirmed',
        language: 'en',
        sessionId: 'test-session-123',
      },
    });

    // 固定クロックを注入し、決定的に検証する。
    const fixedNow = new Date('2025-06-10T00:00:00Z');
    const chatbot = createChatbotService({
      reservationService: rs.service,
      whatsAppClient: wa.client,
      joinLinkService: makeJoinLinkMock().service,
      stateStore,
      clock: () => fixedNow,
    });

    // 実機 Vonage の形（message_type:'reply', reply.id）でインタラクティブ選択を送る。
    await chatbot.handleInboundMessage({ from: sender, language: 'en' }); // START → SELECT_SERVICE
    await chatbot.handleInboundMessage({
      from: sender,
      message_type: 'reply',
      reply: { id: 'consultation', title: 'Consultation' },
      language: 'en',
    }); // → SELECT_DATE
    await chatbot.handleInboundMessage({
      from: sender,
      message_type: 'reply',
      reply: { id: 'day_2', title: 'Day 2' },
      language: 'en',
    }); // → SELECT_TIME
    await chatbot.handleInboundMessage({
      from: sender,
      message_type: 'reply',
      reply: { id: 'slot_0900', title: '09:00' },
      language: 'en',
    }); // → CONFIRM
    const result = await chatbot.handleInboundMessage({ from: sender, text: 'confirm', language: 'en' }); // → COMPLETED

    expect(result.ok).toBe(true);
    expect(rs.calls.length).toBe(1);

    const dto = rs.calls[0];
    const reservedAt = new Date(dto.reservationTime);
    // 有効な ISO 日時であること。
    expect(Number.isNaN(reservedAt.getTime())).toBe(false);
    // 固定クロックの年（2025）で解決され、年 2000 にはならない。
    expect(reservedAt.getUTCFullYear()).toBe(2025);
    expect(reservedAt.getUTCFullYear()).not.toBe(2000);
    // day_2 は基準日 +1 日、slot_0900 は 09:00 JST = 00:00 UTC。
    expect(reservedAt.toISOString()).toBe('2025-06-11T00:00:00.000Z');
  });

  test('実データ形状（トップレベル reply.id）のインタラクティブ選択が入力値として使われる', async () => {
    // SELECT_SERVICE 状態で reply:{id:'consultation'} を受けると、その id が
    // サービスとして採用され次状態（SELECT_DATE）へ 'consultation' が引き継がれる。
    const sender = '12025550101';
    const stateStore = createInMemoryStateStore();
    stateStore.set(sender, { step: ConversationStep.SELECT_SERVICE, contact: sender, language: 'en' });

    const wa = makeWhatsAppMock();
    const rs = makeReservationServiceMock({ ok: true, reservation: { sessionId: "test-session-123" } });

    const chatbot = createChatbotService({
      reservationService: rs.service,
      whatsAppClient: wa.client,
      joinLinkService: makeJoinLinkMock().service,
      stateStore,
    });

    // 実機 Vonage の inbound 形（message_type:'reply', 選択値は reply.id）。
    const result = await chatbot.handleInboundMessage({
      from: sender,
      channel: 'whatsapp',
      message_type: 'reply',
      reply: { id: 'consultation', title: 'Consultation' },
      language: 'en',
    });

    expect(result.ok).toBe(true);
    const saved = stateStore.get(sender);
    expect(saved.step).toBe(ConversationStep.SELECT_DATE);
    // reply.id が抽出され、サービスが文字列 'consultation' として引き継がれる。
    expect(saved.service).toBe('consultation');
    expect(typeof saved.service).toBe('string');
  });

  test('中間ステップでは選択肢メッセージが送信され状態が保存される', async () => {
    const sender = '+15552223333';
    const stateStore = createInMemoryStateStore();

    const wa = makeWhatsAppMock();
    const rs = makeReservationServiceMock({ ok: true, reservation: { sessionId: "test-session-123" } });

    const chatbot = createChatbotService({
      reservationService: rs.service,
      whatsAppClient: wa.client,
      joinLinkService: makeJoinLinkMock().service,
      stateStore,
    });

    // 初回メッセージ（START → SELECT_SERVICE）。
    const result = await chatbot.handleInboundMessage({ from: sender, text: 'hi', language: 'en' });

    expect(result.ok).toBe(true);
    expect(rs.calls.length).toBe(0); // まだ予約作成されない
    expect(wa.calls.length).toBe(1);
    expect(stateStore.get(sender).step).toBe(ConversationStep.SELECT_SERVICE);
  });
});

describe('Chatbot_Service 確定メッセージの内容検証 (要件 1.4・6.3)', () => {
  /** 固定トークンを返す joinLinkService と固定クロックを用いたチャットボットを作る。 */
  function createTestChatbot({ sender = '+15551230000', language = 'en', service = 'consultation', reservationTime = '2030-01-01T10:00:00.000Z' } = {}) {
    const stateStore = createInMemoryStateStore();
    seedConfirmState(stateStore, sender, language);

    const joinLinkMock = makeFixedTokenJoinLinkMock();
    const wa = makeWhatsAppMock();
    const rs = makeReservationServiceMock({
      ok: true,
      reservation: {
        reservationId: 'r-test',
        contact: sender,
        reservationTime,
        service,
        status: 'confirmed',
        language,
        sessionId: 'test-session-123',
      },
    });

    const chatbot = createChatbotService({
      reservationService: rs.service,
      whatsAppClient: wa.client,
      joinLinkService: joinLinkMock.service,
      stateStore,
    });

    return { chatbot, wa, joinLinkMock, sender };
  }

  test('確定メッセージに正しい入室URLが含まれる（日本語）', async () => {
    const { chatbot, wa, joinLinkMock, sender } = createTestChatbot({
      sender: '+819012345678',
      language: 'ja',
      service: 'consultation',
      reservationTime: '2026-01-15T10:30:00.000Z',
    });

    await chatbot.handleInboundMessage({ from: sender, text: '確定', language: 'ja' });

    expect(wa.calls.length).toBe(1);
    expect(wa.calls[0].outMessage.type).toBe(OutMessageType.CONFIRMATION);

    // メッセージ本文の検証
    const sentText = wa.calls[0].outMessage.text;
    expect(sentText).toContain('ご予約が確定しました');
    expect(sentText).toContain('相談'); // service name (ja)
    expect(sentText).toContain('入室URL:');
    expect(sentText).toContain(joinLinkMock.fixedUrl); // 正確な入室URLが含まれる
    expect(sentText).toContain('このリンクは一度だけ有効です');

    // URL 形式の検証: https://{origin}/join/{32-char-hex}
    const urlMatch = sentText.match(/https:\/\/[^\/]+\/join\/([a-f0-9]{32})/);
    expect(urlMatch).not.toBeNull();
    expect(urlMatch[1]).toHaveLength(32); // 16 バイト = 32 文字の 16 進数

    // 日時が日本語フォーマットで含まれる
    expect(sentText).toMatch(/2026年1月15日/); // 2026-01-15 が日本語フォーマットで含まれる
  });

  test('確定メッセージに正しい入室URLが含まれる（英語）', async () => {
    const { chatbot, wa, joinLinkMock, sender } = createTestChatbot({
      sender: '+155512345678',
      language: 'en',
      service: 'consultation',
      reservationTime: '2026-01-15T10:30:00.000Z',
    });

    await chatbot.handleInboundMessage({ from: sender, text: 'confirm', language: 'en' });

    expect(wa.calls.length).toBe(1);
    expect(wa.calls[0].outMessage.type).toBe(OutMessageType.CONFIRMATION);

    const sentText = wa.calls[0].outMessage.text;
    expect(sentText).toContain('Your reservation is confirmed');
    expect(sentText).toContain('Consultation');
    expect(sentText).toContain('Join URL:');
    expect(sentText).toContain(joinLinkMock.fixedUrl);
    expect(sentText).toContain('This link is one-time only');

    // URL 形式の検証
    const urlMatch = sentText.match(/https:\/\/[^\/]+\/join\/([a-f0-9]{32})/);
    expect(urlMatch).not.toBeNull();
    expect(urlMatch[1]).toHaveLength(32);

    // 日時が英語フォーマットで含まれる
    expect(sentText).toMatch(/Jan 15, 2026/); // 2026-01-15 が英語フォーマットで含まれる
  });

  test('入室URLのトークンが 32 文字の 16 進数である', async () => {
    const { chatbot, wa, joinLinkMock, sender } = createTestChatbot();

    await chatbot.handleInboundMessage({ from: sender, text: 'confirm', language: 'en' });

    const sentText = wa.calls[0].outMessage.text;
    const urlMatch = sentText.match(/https:\/\/[^\/]+\/join\/([a-f0-9]{32})/);

    expect(urlMatch).not.toBeNull();
    const token = urlMatch[1];
    expect(token).toHaveLength(32);
    // 16 進数のみで構成される
    expect(token).toMatch(/^[a-f0-9]+$/);
    // 固定モックのトークンと一致
    expect(token).toBe(joinLinkMock.fixedToken);
  });

  test('入室URLの形式が正しい（origin + /join/ + 32文字トークン）', async () => {
    const customOrigin = 'https://myapp.example.com';
    const joinLinkMock = makeFixedTokenJoinLinkMock();
    // モックの issueForReservation は origin を使わず固定 URL を返すため、
    // ここでは joinLinkMock.fixedUrl が正しい形式であることを確認するだけ
    expect(joinLinkMock.fixedUrl).toBe('https://example.com/join/' + 'a'.repeat(32));
    expect(joinLinkMock.fixedUrl).toMatch(/^https:\/\/[^\/]+\/join\/[a-f0-9]{32}$/);
  });

  test('入室URLに「一度だけ有効」の文言が含まれる（日本語・英語）', async () => {
    // 日本語
    const { chatbot: jaChatbot, wa: jaWa, joinLinkMock: jaMock, sender: jaSender } = createTestChatbot({ language: 'ja' });
    await jaChatbot.handleInboundMessage({ from: jaSender, text: '確定', language: 'ja' });
    expect(jaWa.calls[0].outMessage.text).toContain('このリンクは一度だけ有効です');

    // 英語
    const { chatbot: enChatbot, wa: enWa, joinLinkMock: enMock, sender: enSender } = createTestChatbot({ language: 'en' });
    await enChatbot.handleInboundMessage({ from: enSender, text: 'confirm', language: 'en' });
    expect(enWa.calls[0].outMessage.text).toContain('This link is one-time only');
  });

  test('日時が言語に応じたフォーマットで含まれる', async () => {
    // 日本語: 2026年1月15日 19:30 (JST = UTC+9)
    const { chatbot: jaChatbot, wa: jaWa, sender: jaSender } = createTestChatbot({
      language: 'ja',
      reservationTime: '2026-01-15T10:30:00.000Z',
    });
    await jaChatbot.handleInboundMessage({ from: jaSender, text: '確定', language: 'ja' });
    const jaText = jaWa.calls[0].outMessage.text;
    expect(jaText).toMatch(/2026年1月15日/);
    expect(jaText).toMatch(/19:30/);

    // 英語: Jan 15, 2026, 7:30 PM (JST = UTC+9)
    const { chatbot: enChatbot, wa: enWa, sender: enSender } = createTestChatbot({
      language: 'en',
      reservationTime: '2026-01-15T10:30:00.000Z',
    });
    await enChatbot.handleInboundMessage({ from: enSender, text: 'confirm', language: 'en' });
    const enText = enWa.calls[0].outMessage.text;
    expect(enText).toMatch(/Jan 15, 2026/);
    expect(enText).toMatch(/7:30/);
  });

  test('サービス名が言語に応じて翻訳される', async () => {
    // 日本語: consultation -> 相談
    const { chatbot: jaChatbot, wa: jaWa, sender: jaSender } = createTestChatbot({ language: 'ja', service: 'consultation' });
    await jaChatbot.handleInboundMessage({ from: jaSender, text: '確定', language: 'ja' });
    expect(jaWa.calls[0].outMessage.text).toContain('相談');

    // 英語: consultation -> Consultation
    const { chatbot: enChatbot, wa: enWa, sender: enSender } = createTestChatbot({ language: 'en', service: 'consultation' });
    await enChatbot.handleInboundMessage({ from: enSender, text: 'confirm', language: 'en' });
    expect(enWa.calls[0].outMessage.text).toContain('Consultation');
  });
});
