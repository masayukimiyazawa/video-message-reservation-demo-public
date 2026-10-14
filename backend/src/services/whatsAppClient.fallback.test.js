/**
 * WhatsApp インタラクティブメッセージのプレーンテキストフォールバック（Sandbox 対応）ユニットテスト。
 *
 * Vonage Messages API Sandbox は custom / interactive メッセージ非対応（HTTP 422）のため、
 * interactiveFallbackText=true のとき REPLY_BUTTON / LIST / CAROUSEL を message_type: 'text'
 * へ変換することを検証する。既定（false）では従来どおり custom を生成する（後方互換）。
 */

import {
  toWhatsAppPayload,
  createWhatsAppClient,
} from './whatsAppClient.js';
import { localizeText } from './messageText.js';
import { OutMessageType } from '../domain/constants.js';

const to = '+15551230000';
const from = '+15559990000';

describe('toWhatsAppPayload インタラクティブフォールバック (Sandbox)', () => {
  const replyButtonMsg = {
    type: OutMessageType.REPLY_BUTTON,
    text: 'Please choose a service to book.',
    options: [
      { id: 'a', title: 'Checkup' },
      { id: 'b', title: 'Consultation' },
      { id: 'c', title: 'Follow-up' },
    ],
  };

  const listMsg = {
    type: OutMessageType.LIST,
    text: 'Please choose a time.',
    options: [
      { id: 't1', title: '10:00' },
      { id: 't2', title: '11:00' },
    ],
  };

  const carouselMsg = {
    type: OutMessageType.CAROUSEL,
    text: 'Please choose a service to book.',
    media: {
      cards: [
        { id: 'c1', title: 'Plan A', imageUrl: 'https://example.com/a.png' },
        { id: 'c2', title: 'Plan B', imageUrl: 'https://example.com/b.png' },
      ],
    },
  };

  test('REPLY_BUTTON は fallback=true でプレーンテキストになり本文と各タイトルを含む', () => {
    const payload = toWhatsAppPayload(replyButtonMsg, {
      to,
      from,
      language: 'en',
      interactiveFallbackText: true,
    });

    expect(payload.message_type).toBe('text');
    expect(payload.custom).toBeUndefined();
    expect(payload.channel).toBe('whatsapp');
    expect(payload.to).toBe(to);
    expect(payload.from).toBe(from);

    const body = localizeText(replyButtonMsg, 'en');
    expect(payload.text).toContain(body);
    expect(payload.text).toContain('1. Checkup');
    expect(payload.text).toContain('2. Consultation');
    expect(payload.text).toContain('3. Follow-up');
    // 英語ヒント
    expect(payload.text).toContain('(Reply with the number or text)');
  });

  test('LIST は fallback=true でプレーンテキストになり番号付きタイトルを含む', () => {
    const payload = toWhatsAppPayload(listMsg, {
      to,
      from,
      language: 'en',
      interactiveFallbackText: true,
    });

    expect(payload.message_type).toBe('text');
    expect(payload.custom).toBeUndefined();
    expect(payload.text).toContain(localizeText(listMsg, 'en'));
    expect(payload.text).toContain('1. 10:00');
    expect(payload.text).toContain('2. 11:00');
  });

  test('CAROUSEL は fallback=true でプレーンテキストになり各カードタイトルを含む', () => {
    const payload = toWhatsAppPayload(carouselMsg, {
      to,
      from,
      language: 'en',
      interactiveFallbackText: true,
    });

    expect(payload.message_type).toBe('text');
    expect(payload.custom).toBeUndefined();
    expect(payload.text).toContain(localizeText(carouselMsg, 'en'));
    expect(payload.text).toContain('1. Plan A');
    expect(payload.text).toContain('2. Plan B');
  });

  test('言語 ja のときヒントが日本語になり、本文も日本語ローカライズされる', () => {
    const payload = toWhatsAppPayload(replyButtonMsg, {
      to,
      from,
      language: 'ja',
      interactiveFallbackText: true,
    });

    expect(payload.message_type).toBe('text');
    expect(payload.text).toContain(localizeText(replyButtonMsg, 'ja'));
    expect(payload.text).toContain('（返信で番号または内容を送ってください）');
    expect(payload.text).not.toContain('(Reply with the number or text)');
  });

  test('言語 en/ja でヒント文字列が切り替わる', () => {
    const en = toWhatsAppPayload(listMsg, {
      to,
      from,
      language: 'en',
      interactiveFallbackText: true,
    }).text;
    const ja = toWhatsAppPayload(listMsg, {
      to,
      from,
      language: 'ja',
      interactiveFallbackText: true,
    }).text;

    expect(en).toContain('(Reply with the number or text)');
    expect(ja).toContain('（返信で番号または内容を送ってください）');
    expect(en).not.toBe(ja);
  });

  test('MEDIA_TEMPLATE（画像あり）は fallback=true でテキストになる（Sandbox 安全）', () => {
    const mediaMsg = {
      type: OutMessageType.MEDIA_TEMPLATE,
      text: 'Please confirm your reservation.',
      media: { imageUrl: 'https://example.com/x.png' },
    };
    const payload = toWhatsAppPayload(mediaMsg, {
      to,
      from,
      language: 'en',
      interactiveFallbackText: true,
    });

    expect(payload.message_type).toBe('text');
    expect(payload.image).toBeUndefined();
    expect(payload.text).toBe(localizeText(mediaMsg, 'en'));
  });

  test('CONFIRMATION / TEXT は fallback=true でも従来どおりテキスト', () => {
    const textMsg = { type: OutMessageType.TEXT, text: 'Please choose a date.' };
    const payload = toWhatsAppPayload(textMsg, {
      to,
      from,
      language: 'en',
      interactiveFallbackText: true,
    });
    expect(payload.message_type).toBe('text');
    expect(payload.text).toBe(localizeText(textMsg, 'en'));
  });

  test('既定（fallback 未指定 / false）では REPLY_BUTTON は custom interactive のまま', () => {
    const defaultPayload = toWhatsAppPayload(replyButtonMsg, {
      to,
      from,
      language: 'en',
    });
    expect(defaultPayload.message_type).toBe('custom');
    expect(defaultPayload.custom?.type).toBe('interactive');
    expect(defaultPayload.custom?.interactive?.type).toBe('button');

    const explicitFalse = toWhatsAppPayload(replyButtonMsg, {
      to,
      from,
      language: 'en',
      interactiveFallbackText: false,
    });
    expect(explicitFalse.message_type).toBe('custom');
  });
});

describe('createWhatsAppClient フォールバックフラグの伝播', () => {
  test('deps.interactiveFallbackText=true のとき sendOutMessage はテキストを送信する', async () => {
    const sent = [];
    const client = createWhatsAppClient({
      from,
      interactiveFallbackText: true,
      messagesClient: {
        send: async (payload) => {
          sent.push(payload);
          return { message_uuid: 'uuid-1' };
        },
      },
      logger: { error: () => {} },
    });

    const result = await client.sendOutMessage(
      {
        type: OutMessageType.REPLY_BUTTON,
        text: 'Please choose a service to book.',
        options: [{ id: 'a', title: 'Checkup' }],
      },
      { to, language: 'en' },
    );

    expect(result.ok).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0].message_type).toBe('text');
    expect(sent[0].custom).toBeUndefined();
    expect(sent[0].text).toContain('1. Checkup');
  });

  test('deps.interactiveFallbackText=false（既定注入）のとき custom を送信する', async () => {
    const sent = [];
    const client = createWhatsAppClient({
      from,
      interactiveFallbackText: false,
      messagesClient: {
        send: async (payload) => {
          sent.push(payload);
          return { message_uuid: 'uuid-2' };
        },
      },
      logger: { error: () => {} },
    });

    await client.sendOutMessage(
      {
        type: OutMessageType.LIST,
        text: 'Please choose a time.',
        options: [{ id: 't1', title: '10:00' }],
      },
      { to, language: 'en' },
    );

    expect(sent[0].message_type).toBe('custom');
    expect(sent[0].custom?.interactive?.type).toBe('list');
  });
});
