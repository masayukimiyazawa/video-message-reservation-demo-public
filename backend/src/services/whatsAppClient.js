/**
 * WhatsApp 送信クライアント（Vonage Messages API ラッパー / 要件 1.4・1.6・6.3）
 *
 * Chatbot_Service / Notification_Service から利用する送信専用ラッパー。
 * ドメイン層の `OutMessage`（reply button / list / メディアテンプレート /
 * カルーセル / 確定 / テキスト）を WhatsApp（Vonage Messages API）の送信ペイロードへ
 * 変換して送信する。
 *
 * 設計対応:
 *  - Chatbot_Service: 送信は保存レコードの language（en/ja）に応じて本文を選択（要件 6.3）。
 *  - 要件 1.4: 予約確定メッセージ送信。
 *  - 要件 1.6: 画像を含むメディアテンプレート / カルーセルメッセージ送信。
 *
 * テスト容易性:
 *  実際の Vonage Messages クライアントは注入可能（`deps.messagesClient`）にし、
 *  ユニットテストではモックを差し込める。既定では @vonage/server-sdk の
 *  Vonage インスタンスの `messages` クライアントを遅延生成して用いる。
 *
 * 注意:
 *  Vonage Messages API の WhatsApp インタラクティブメッセージ（reply button / list）は
 *  純正の型付きクラスとして提供されていないため、`WhatsAppCustom`（custom オブジェクト）
 *  として組み立てて送信する。テキスト・画像・テンプレートは型付きクラスを用いる。
 *
 * @module services/whatsAppClient
 */

import { OutMessageType } from '../domain/constants.js';
import env from '../config/env.js';
import { localizeText } from './messageText.js';

/**
 * Vonage Messages クライアントを遅延生成する。
 * env の Vonage 資格情報（apiKey/apiSecret または applicationId/privateKey）を用いる。
 * 実際の送信を行わないテストでは deps.messagesClient を注入するため、
 * ここが呼ばれるのは本番／統合時のみ。
 *
 * ホスト（apiHost）は Vonage コンストラクタの第 2 引数（options）で指定する:
 *   new Vonage(credentials, { apiHost: 'https://messages-sandbox.nexmo.com' })
 * env.vonage.messagesApiHost が非空のときのみ options を渡す。
 *   - Sandbox: https://messages-sandbox.nexmo.com（Sandbox 番号はこちらへ送る必要がある）
 *   - 本番（既定）: https://api.nexmo.com（options 省略で SDK 既定）
 * 空のときは従来どおり単一引数で生成し完全後方互換を保つ。
 *
 * @returns {Promise<{ send: Function }>}
 */
async function createDefaultMessagesClient() {
  const { Vonage } = await import('@vonage/server-sdk');
  const credentials = {
    apiKey: env.vonage.apiKey,
    apiSecret: env.vonage.apiSecret,
  };
  if (env.vonage.applicationId) {
    credentials.applicationId = env.vonage.applicationId;
  }
  if (env.vonage.privateKeyPath) {
    credentials.privateKey = env.vonage.privateKeyPath;
  }
  const apiHost = env.vonage.messagesApiHost;
  const vonage =
    typeof apiHost === 'string' && apiHost.length > 0
      ? new Vonage(credentials, { apiHost })
      : new Vonage(credentials);
  return vonage.messages;
}

/**
 * ドメインの OutMessage を WhatsApp（Vonage Messages API）送信ペイロードへ変換する。
 *
 * 保存レコードの language（en/ja）に応じて本文（text/title）をローカライズする（要件 6.3）。
 * 返すオブジェクトは Vonage Messages API の `send` に渡せる形（channel/message_type/to/from/…）。
 *
 * @param {import('../domain/types.js').OutMessage} outMessage ドメインの送信メッセージ
 * @param {object} params
 * @param {string} params.to 宛先 WhatsApp 番号（E.164）
 * @param {string} params.from 送信元 WhatsApp 番号
 * @param {('en'|'ja')} params.language 送信言語（要件 6.3）
 * @param {boolean} [params.interactiveFallbackText=false]
 *   true の場合、reply button / list / carousel / メディアテンプレート（画像あり）などの
 *   custom / interactive 種別をプレーンテキスト（message_type: 'text'）へフォールバックする。
 *   Vonage Messages API Sandbox は custom/interactive を非対応（HTTP 422）のため。
 *   false（既定）のときは従来どおり custom interactive ペイロードを生成する（完全後方互換）。
 * @returns {object} Vonage Messages API 送信ペイロード
 */
export function toWhatsAppPayload(
  outMessage,
  { to, from, language, interactiveFallbackText = false },
) {
  const base = { channel: 'whatsapp', to, from };
  const text = localizeText(outMessage, language);

  // Sandbox 向けフォールバック: インタラクティブ/未対応種別をプレーンテキスト化する。
  if (interactiveFallbackText) {
    switch (outMessage.type) {
      case OutMessageType.REPLY_BUTTON:
      case OutMessageType.LIST: {
        const titles = (outMessage.options ?? []).map((o) =>
          localizeOptionTitle(o, language),
        );
        return {
          ...base,
          message_type: 'text',
          text: buildFallbackText(text, titles, language),
        };
      }

      case OutMessageType.CTA_URL: {
        // CTA ボタン相当を URL のプレーンテキストで代替する（ボタン押下は代替不可）。
        const label = localizeOptionTitle((outMessage.options ?? [])[0], language);
        const url = outMessage.options?.[0]?.url ?? '';
        return {
          ...base,
          message_type: 'text',
          text: [text, url, label].filter(Boolean).join('\n'),
        };
      }

      case OutMessageType.CAROUSEL: {
        const titles = (outMessage.media?.cards ?? []).map((c) =>
          localizeOptionTitle(c, language),
        );
        return {
          ...base,
          message_type: 'text',
          text: buildFallbackText(text, titles, language),
        };
      }

      case OutMessageType.MEDIA_TEMPLATE: {
        // Sandbox 安全のため画像ありでもテキスト（本文/キャプション相当）で送信する。
        return { ...base, message_type: 'text', text };
      }

      // CONFIRMATION / TEXT は既にテキストのため通常経路と同じ。
      default:
        break;
    }
  }

  switch (outMessage.type) {
    case OutMessageType.CTA_URL: {
      // WhatsApp CTA URL ボタン（cta_url）を custom として組み立てる。
      // タップで指定 URL が開く。reply button とは別種なので必ずこちらを使う。
      const option = (outMessage.options ?? [])[0] ?? {};
      return {
        ...base,
        message_type: 'custom',
        custom: {
          type: 'interactive',
          interactive: {
            type: 'cta_url',
            body: { text },
            action: {
              name: 'cta_url',
              parameters: {
                display_text: localizeOptionTitle(option, language),
                url: option.url ?? '',
              },
            },
          },
        },
      };
    }

    case OutMessageType.REPLY_BUTTON: {
      // WhatsApp インタラクティブ（reply button）を custom として組み立てる。
      const buttons = (outMessage.options ?? []).slice(0, 3).map((o) => ({
        type: 'reply',
        reply: { id: o.id, title: localizeOptionTitle(o, language) },
      }));
      return {
        ...base,
        message_type: 'custom',
        custom: {
          type: 'interactive',
          interactive: {
            type: 'button',
            body: { text },
            action: { buttons },
          },
        },
      };
    }

    case OutMessageType.LIST: {
      // WhatsApp インタラクティブ（list message）を custom として組み立てる。
      const rows = (outMessage.options ?? []).map((o) => ({
        id: o.id,
        title: localizeOptionTitle(o, language),
      }));
      return {
        ...base,
        message_type: 'custom',
        custom: {
          type: 'interactive',
          interactive: {
            type: 'list',
            body: { text },
            action: {
              button: language === 'ja' ? '選択' : 'Choose',
              sections: [{ title: text, rows }],
            },
          },
        },
      };
    }

    case OutMessageType.MEDIA_TEMPLATE: {
      // 画像を含むメディアテンプレート（要件 1.6）。画像があれば image、なければ text。
      const imageUrl = outMessage.media?.imageUrl;
      if (imageUrl) {
        return {
          ...base,
          message_type: 'image',
          image: { url: imageUrl, caption: text },
        };
      }
      return { ...base, message_type: 'text', text };
    }

    case OutMessageType.CAROUSEL: {
      // カルーセル（複数カード）は WhatsApp では custom として組み立てる（要件 1.6）。
      const cards = (outMessage.media?.cards ?? []).map((c) => ({
        id: c.id,
        title: localizeOptionTitle(c, language),
        image: c.imageUrl ? { url: c.imageUrl } : undefined,
      }));
      return {
        ...base,
        message_type: 'custom',
        custom: {
          type: 'carousel',
          body: { text },
          cards,
        },
      };
    }

    case OutMessageType.CONFIRMATION:
    case OutMessageType.TEXT:
    default: {
      // 確定メッセージ・プレーンテキスト（要件 1.4）。
      return { ...base, message_type: 'text', text };
    }
  }
}

/**
 * 選択肢/カードのタイトルを言語に応じて解決する。
 * option が `titleByLang: { en, ja }` を持つ場合はそれを優先し、
 * なければ `title` をそのまま用いる。
 * @param {{ title?: string, titleByLang?: { en?: string, ja?: string } }} option
 * @param {('en'|'ja')} language
 * @returns {string}
 */
function localizeOptionTitle(option, language) {
  if (option?.titleByLang && typeof option.titleByLang[language] === 'string') {
    return option.titleByLang[language];
  }
  return option?.title ?? '';
}

/**
 * インタラクティブメッセージのフォールバック用プレーンテキストを組み立てる。
 * 本文の後に選択肢/カードのタイトルを番号付きで列挙し、返信方法のヒント（言語別）を付す。
 *
 * 例:
 *   <body>\n\n1. <title1>\n2. <title2>\n\n(返信で番号または内容を送ってください / Reply ...)
 *
 * @param {string} body ローカライズ済み本文
 * @param {string[]} titles 選択肢/カードのローカライズ済みタイトル配列
 * @param {('en'|'ja')} language 送信言語
 * @returns {string}
 */
function buildFallbackText(body, titles, language) {
  const hint =
    language === 'ja'
      ? '（返信で番号または内容を送ってください）'
      : '(Reply with the number or text)';
  const list = (titles ?? [])
    .map((title, i) => `${i + 1}. ${title}`)
    .join('\n');
  const parts = [body];
  if (list) {
    parts.push(list);
  }
  parts.push(hint);
  return parts.join('\n\n');
}

/**
 * WhatsApp 送信クライアントを生成する。
 *
 * @param {object} [deps]
 * @param {{ send: Function }} [deps.messagesClient] Vonage Messages クライアント（注入用）
 * @param {string} [deps.from] 送信元 WhatsApp 番号（既定は env.vonage.whatsappFrom）
 * @param {boolean} [deps.interactiveFallbackText] Sandbox 向けフォールバック
 *   （既定は env.vonage.interactiveFallbackText）。true で custom/interactive をテキスト化。
 * @param {{ error: Function, info?: Function }} [deps.logger] ロガー
 * @returns {{
 *   sendOutMessage: (outMessage: object, params: { to: string, language: ('en'|'ja') }) => Promise<object>,
 *   sendText: (params: { to: string, text: string }) => Promise<object>,
 * }}
 */
export function createWhatsAppClient(deps = {}) {
  const logger = deps.logger ?? console;
  const from = deps.from ?? env.vonage.whatsappFrom;
  // Sandbox 向けフォールバック設定。テストで注入可能、既定は env から解決。
  const interactiveFallbackText =
    deps.interactiveFallbackText ?? env.vonage.interactiveFallbackText;
  let messagesClient = deps.messagesClient ?? null;

  /**
   * Vonage Messages クライアントを取得（未注入なら遅延生成）。
   * @returns {Promise<{ send: Function }>}
   */
  async function getClient() {
    if (!messagesClient) {
      messagesClient = await createDefaultMessagesClient();
    }
    return messagesClient;
  }

  /**
   * ドメインの OutMessage を WhatsApp へ送信する。
   *
   * @param {import('../domain/types.js').OutMessage} outMessage
   * @param {object} params
   * @param {string} params.to 宛先 WhatsApp 番号
   * @param {('en'|'ja')} params.language 送信言語（要件 6.3）
   * @returns {Promise<object>} { ok, response } または { ok:false, error }
   */
  async function sendOutMessage(outMessage, { to, language }) {
    const payload = toWhatsAppPayload(outMessage, {
      to,
      from,
      language,
      interactiveFallbackText,
    });
    try {
      const client = await getClient();
      const response = await client.send(payload);
      return { ok: true, response };
    } catch (err) {
      logger.error('[WhatsAppClient] メッセージ送信に失敗しました:', err);
      return { ok: false, error: err?.message ?? String(err) };
    }
  }

  /**
   * プレーンテキストを送信する（確定メッセージ等の簡易送信用 / 要件 1.4）。
   * @param {object} params
   * @param {string} params.to
   * @param {string} params.text
   * @returns {Promise<object>}
   */
  async function sendText({ to, text }) {
    try {
      const client = await getClient();
      const response = await client.send({
        channel: 'whatsapp',
        to,
        from,
        message_type: 'text',
        text,
      });
      return { ok: true, response };
    } catch (err) {
      logger.error('[WhatsAppClient] テキスト送信に失敗しました:', err);
      return { ok: false, error: err?.message ?? String(err) };
    }
  }

  return { sendOutMessage, sendText };
}

/** 既定の WhatsApp 送信クライアント（実 Vonage Messages 依存）。 */
export const whatsAppClient = createWhatsAppClient();

export default whatsAppClient;
