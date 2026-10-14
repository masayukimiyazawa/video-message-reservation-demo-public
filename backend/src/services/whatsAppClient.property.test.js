import fc from 'fast-check';

import { toWhatsAppPayload } from './whatsAppClient.js';
import { localizeText, confirmationText } from './messageText.js';
import { OutMessageType } from '../domain/constants.js';

/**
 * Property 8: WhatsApp 送信言語は予約の対応言語と一致する（Task 10.3 / 要件 6.3）
 *
 * Feature: vonage-video-reservation, Property 8: WhatsApp 送信言語は予約の対応言語と一致する:
 *   任意の予約について、Chatbot_Service が送信する WhatsApp メッセージの言語は、
 *   その予約レコードに保存された対応言語（en/ja）と一致する。
 *
 * 対象: whatsAppClient.toWhatsAppPayload / messageText.localizeText。
 *   予約の language（en/ja）を送信時の language に渡したとき、生成される WhatsApp
 *   ペイロード本文が、その言語向けにローカライズされた本文（localizeText の出力）と
 *   厳密に一致することを検証する。これにより「送信言語 == 予約言語」を担保する。
 */

/**
 * ペイロードから言語検証対象の本文テキストを抽出する。
 * OutMessage 種別ごとに本文が置かれる場所が異なるため吸収する。
 */
function extractBodyText(payload, outMessage) {
  switch (outMessage.type) {
    case OutMessageType.REPLY_BUTTON:
    case OutMessageType.LIST:
      return payload.custom.interactive.body.text;
    case OutMessageType.CAROUSEL:
      return payload.custom.body.text;
    case OutMessageType.MEDIA_TEMPLATE:
      // 画像ありなら caption、なければ text。
      return payload.message_type === 'image' ? payload.image.caption : payload.text;
    case OutMessageType.CONFIRMATION:
    case OutMessageType.TEXT:
    default:
      return payload.text;
  }
}

/** en 既定文とその日本語対訳が定義済みの文言（辞書ヒットするもの）。 */
const localizableEnTexts = [
  'Please choose a service to book.',
  'Please choose a date.',
  'Please choose a time.',
  'Please confirm your reservation.',
  'Your reservation is confirmed.',
];

/** textByLang を明示的に持つ / 持たない両方の OutMessage を生成する。 */
const outMessageArb = fc.oneof(
  // 辞書対訳を持つプレーンテキスト
  fc.record({
    type: fc.constant(OutMessageType.TEXT),
    text: fc.constantFrom(...localizableEnTexts),
  }),
  // textByLang を明示指定したテキスト
  fc.record({
    type: fc.constantFrom(OutMessageType.TEXT, OutMessageType.REPLY_BUTTON, OutMessageType.LIST),
    text: fc.string({ maxLength: 20 }),
    textByLang: fc.record({
      en: fc.string({ minLength: 1, maxLength: 20 }),
      ja: fc.string({ minLength: 1, maxLength: 20 }),
    }),
    options: fc.array(
      fc.record({ id: fc.string({ minLength: 1, maxLength: 8 }), title: fc.string({ maxLength: 10 }) }),
      { maxLength: 3 },
    ),
  }),
  // 確定メッセージ（summary から言語別に生成）
  fc.record({
    type: fc.constant(OutMessageType.CONFIRMATION),
    summary: fc.record({
      service: fc.string({ maxLength: 15 }),
      reservationTime: fc.string({ maxLength: 25 }),
    }),
  }),
  // メディアテンプレート（画像あり）
  fc.record({
    type: fc.constant(OutMessageType.MEDIA_TEMPLATE),
    text: fc.constantFrom(...localizableEnTexts),
    media: fc.record({ imageUrl: fc.webUrl() }),
  }),
);

const languageArb = fc.constantFrom('en', 'ja');

describe('WhatsApp 送信言語マッピング (Task 10.3 / Property 8)', () => {
  test('Feature: vonage-video-reservation, Property 8: WhatsApp 送信言語は予約の対応言語と一致する', () => {
    fc.assert(
      fc.property(outMessageArb, languageArb, (outMessage, language) => {
        const payload = toWhatsAppPayload(outMessage, {
          to: '+15551230000',
          from: '+15559990000',
          language,
        });

        // 生成された本文は、その言語向けにローカライズした本文と一致する。
        const expected = localizeText(outMessage, language);
        const actual = extractBodyText(payload, outMessage);
        expect(actual).toBe(expected);
      }),
      { numRuns: 100 },
    );
  });

  test('Feature: vonage-video-reservation, Property 8: 言語ごとに本文が実際に切り替わる（en/ja で異なる）', () => {
    fc.assert(
      fc.property(
        fc.record({
          type: fc.constant(OutMessageType.CONFIRMATION),
          summary: fc.record({
            service: fc.string({ minLength: 1, maxLength: 15 }),
            reservationTime: fc.string({ minLength: 1, maxLength: 25 }),
          }),
        }),
        (outMessage) => {
          const en = extractBodyText(
            toWhatsAppPayload(outMessage, { to: 't', from: 'f', language: 'en' }),
            outMessage,
          );
          const ja = extractBodyText(
            toWhatsAppPayload(outMessage, { to: 't', from: 'f', language: 'ja' }),
            outMessage,
          );
          // 確定メッセージは言語別テンプレートで生成されるため異なる本文になる。
          expect(en).toBe(confirmationText(outMessage.summary, 'en'));
          expect(ja).toBe(confirmationText(outMessage.summary, 'ja'));
          expect(en).not.toBe(ja);
        },
      ),
      { numRuns: 100 },
    );
  });
});
