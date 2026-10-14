/**
 * WhatsApp メッセージ本文の言語別選択（要件 6.3）
 *
 * ドメイン層の `nextStep` が返す `OutMessage` は英語（en）を既定の本文として持つ。
 * Chatbot_Service は保存レコード / 会話状態の language（en/ja）に応じて本文を選択して
 * 送信する必要がある（要件 6.3・Property 8）。
 *
 * 本モジュールは副作用のない純粋なローカライズ関数を提供する。
 * OutMessage が `textByLang: { en, ja }` を持つ場合はそれを優先し、なければ
 * 既定の英語本文（`text`）を、日本語向けには辞書ベースの訳を返す。
 *
 * @module services/messageText
 */

import { OutMessageType } from '../domain/constants.js';

/**
 * 既定英語本文 → 日本語本文の対訳辞書。
 * ドメインの `nextStep` が生成する固定文言を日本語へ対応付ける。
 * @readonly
 */
const JA_TEXT = Object.freeze({
  'Please choose a service to book.': 'ご予約されるサービスを選択してください。',
  'Please choose a date.': '予約日を選択してください。',
  'Please choose a time.': '予約時刻を選択してください。',
  'Please confirm your reservation.': '予約内容をご確認ください。',
  'Your reservation is confirmed.': 'ご予約が確定しました。',
  'Let us restart. Please choose a service.':
    '最初からやり直します。サービスを選択してください。',
});

/**
 * 予約不可メッセージ（言語別 / 要件 1.5）。
 * @readonly
 */
export const UNAVAILABLE_TEXT = Object.freeze({
  en: 'That slot is not available. Please choose one of the alternatives below.',
  ja: 'その予約枠はご利用いただけません。以下の代替候補からお選びください。',
});

/**
 * 予約確定メッセージ本文を言語別に生成する（要件 1.4・6.3）。
 * @param {object} [summary] 予約概要（service / reservationTime 等）
 * @param {('en'|'ja')} language
 * @returns {string}
 */
export function confirmationText(summary = {}, language = 'en') {
  const service = summary.service ?? '';
  const time = summary.reservationTime ?? '';
  if (language === 'ja') {
    return `ご予約が確定しました。サービス: ${service} / 予約時刻: ${time}`;
  }
  return `Your reservation is confirmed. Service: ${service} / Time: ${time}`;
}

/**
 * OutMessage の本文を言語に応じて解決する（要件 6.3・Property 8）。
 *
 * 優先順位:
 *  1) outMessage.textByLang[language] があればそれを用いる。
 *  2) 確定メッセージ（CONFIRMATION）は summary を用いた言語別文言を生成する。
 *  3) 日本語かつ対訳辞書にヒットすれば訳文を返す。
 *  4) それ以外は既定の英語本文（outMessage.text）を返す。
 *
 * @param {import('../domain/types.js').OutMessage} outMessage
 * @param {('en'|'ja')} language
 * @returns {string}
 */
export function localizeText(outMessage, language = 'en') {
  if (
    outMessage?.textByLang &&
    typeof outMessage.textByLang[language] === 'string'
  ) {
    return outMessage.textByLang[language];
  }

  if (outMessage?.type === OutMessageType.CONFIRMATION) {
    return confirmationText(outMessage.summary, language);
  }

  const text = outMessage?.text ?? '';
  if (language === 'ja' && JA_TEXT[text]) {
    return JA_TEXT[text];
  }
  return text;
}

export default localizeText;
