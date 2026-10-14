/**
 * Chatbot_Service（WhatsApp 予約チャットボット / 要件 1.1・1.2・1.4・1.5・1.6・6.3）
 *
 * Vonage Messages API（WhatsApp）の受信を起点に会話状態を進行させ、予約完了時に
 * Reservation_System へ登録し、確定メッセージ／代替候補を WhatsApp で返信する
 * アプリケーション層サービス。純粋ドメインロジックを配線する。
 *
 * 配線するドメイン/サービス:
 *  - domain: nextStep(state, input)            … 会話遷移（要件 1.1・1.6）
 *  - domain: buildReservationDTO(completedState)… 完了会話→予約 DTO（要件 1.2）
 *  - service: reservationService.createReservation … 登録・空き判定（要件 1.3・1.5）
 *  - service: whatsAppClient.sendOutMessage    … WhatsApp 送信（言語別 / 要件 6.3）
 *
 * 会話状態の保持:
 *  送信者（WhatsApp 番号）をキーとしたインメモリ Map で保持する。
 *  ※ 単一プロセス前提の暫定実装。将来的に Reservation_Store / Redis 等へ
 *    永続化する余地を残すため、状態ストアは注入可能にしている。
 *
 * 外部入力の取り扱い:
 *  受信 Webhook のペイロードは信頼できない外部入力として扱い、送信者・入力値・言語を
 *  防御的に抽出・正規化する（署名/JWT 検証は chatbotRoutes 側で実施）。
 *
 * @module services/chatbotService
 */

import { nextStep, confirmationMessage } from '../domain/conversation.js';
import { buildReservationDTO } from '../domain/reservationDto.js';
import {
  ConversationStep,
  SUPPORTED_LANGUAGES,
  OutMessageType,
  ReservationStatus,
} from '../domain/constants.js';
import { reservationService as defaultReservationService } from './reservationService.js';
import { whatsAppClient as defaultWhatsAppClient } from './whatsAppClient.js';
import { joinLinkService as defaultJoinLinkService } from './joinLinkService.js';
import { UNAVAILABLE_TEXT } from './messageText.js';

/**
 * 単純なインメモリ会話状態ストア（送信者キー → 会話状態）。
 * @returns {{ get: (k: string) => object|undefined, set: (k: string, v: object) => void, delete: (k: string) => void }}
 */
export function createInMemoryStateStore() {
  const map = new Map();
  return {
    get: (key) => map.get(key),
    set: (key, value) => {
      map.set(key, value);
    },
    delete: (key) => {
      map.delete(key);
    },
  };
}

/**
 * 受信 Webhook ペイロードから送信者番号を防御的に抽出する。
 * Vonage Messages API inbound の形（from が文字列 or { number }）に両対応。
 * @param {object} payload
 * @returns {string|undefined}
 */
function extractSender(payload) {
  const from = payload?.from;
  if (typeof from === 'string') return from;
  if (from && typeof from === 'object') {
    if (typeof from.number === 'string') return from.number;
    if (typeof from.id === 'string') return from.id;
  }
  return undefined;
}

/**
 * 受信 Webhook ペイロードからユーザー入力値を防御的に抽出する。
 * インタラクティブ応答（reply / list）とテキストの双方に対応する。
 *
 * 実機の Vonage Messages API（WhatsApp）inbound の実データでは、インタラクティブ選択
 * （ボタン / リスト）は トップレベル `message_type: "reply"` として届き、選択値は
 * トップレベル `payload.reply.id` に入る（例 `{ message_type: "reply",
 * reply: { id: "consultation", title: "Consultation" } }`）。従来コードは
 * `payload.interactive.*` のみを見ていたため実データを拾えず、選択値が取れずに
 * サービスがオブジェクト化・時刻が既定 00:00 に落ちる不具合があった。
 * ここではまず実データ形状（トップレベル reply.id）を優先し、環境差異に備えて
 * 従来の候補もフォールバックとして残す。信頼できない外部入力として防御的に扱う。
 *
 * @param {object} payload
 * @returns {string|undefined}
 */
function extractInputValue(payload) {
  // 実機 Vonage の形: トップレベル reply.id（インタラクティブ選択の選択値）。
  // message_type === 'reply' のとき、この reply.id を最優先で返す。
  if (payload?.reply && typeof payload.reply.id === 'string') {
    return payload.reply.id;
  }
  // フォールバック: 環境により異なるインタラクティブ応答の形（複数候補を試す）。
  const interactive = payload?.interactive ?? payload?.message?.interactive;
  if (interactive) {
    const reply =
      interactive.button_reply ??
      interactive.list_reply ??
      interactive.reply ??
      null;
    if (reply && typeof reply.id === 'string') return reply.id;
  }
  // プレーンテキスト（実機はトップレベル payload.text）。
  if (typeof payload?.text === 'string') return payload.text;
  if (typeof payload?.message?.content?.text === 'string') {
    return payload.message.content.text;
  }
  return undefined;
}

/**
 * ペイロード / 既存状態から送信言語（en/ja）を決定する。
 * @param {object} payload
 * @param {object} [existingState]
 * @returns {('en'|'ja')}
 */
function resolveLanguage(payload, existingState) {
  const candidates = [payload?.language, payload?.locale, existingState?.language];
  for (const c of candidates) {
    if (SUPPORTED_LANGUAGES.includes(c)) return c;
  }
  return 'ja';
}

/**
 * 代替候補（Slot[]）を WhatsApp インタラクティブ（list）用の選択肢へ整形する。
 * @param {Array<{start: Date|string|number, end?: Date|string|number}>} alternatives
 * @returns {Array<{ id: string, title: string }>}
 */
function alternativesToOptions(alternatives = []) {
  return alternatives.map((slot, i) => {
    const start = slot.start instanceof Date ? slot.start : new Date(slot.start);
    const iso = Number.isNaN(start.getTime()) ? String(slot.start) : start.toISOString();
    return { id: `alt_${i}_${iso}`, title: iso };
  });
}

/**
 * Chatbot_Service を生成する。依存は注入可能。
 *
 * @param {object} [deps]
 * @param {ReturnType<import('./reservationService.js').createReservationService>} [deps.reservationService]
 * @param {ReturnType<import('./whatsAppClient.js').createWhatsAppClient>} [deps.whatsAppClient]
 * @param {ReturnType<typeof createInMemoryStateStore>} [deps.stateStore] 会話状態ストア
 * @param {{ error: Function, info?: Function }} [deps.logger]
 * @param {() => Date} [deps.clock]
 *   現在時刻取得関数（既定は実時刻 `() => new Date()`）。nextStep に予約日時解決の
 *   基準時刻 `now` を注入するために用いる。未注入だと 'day_N'/'slot_HHMM' が固定基準
 *   （2000-01-01）で解決され、実運用の予約日時が誤って年 2000 になるため必須。
 *   テストでは固定クロックを注入して決定的に検証できる。
 * @returns {{
 *   handleInboundMessage: (payload: object) => Promise<object>,
 *   handleMessageStatus: (payload: object) => Promise<object>,
 * }}
 */
export function createChatbotService(deps = {}) {
  const reservationService = deps.reservationService ?? defaultReservationService;
  const whatsAppClient = deps.whatsAppClient ?? defaultWhatsAppClient;
  const joinLinkService = deps.joinLinkService ?? defaultJoinLinkService;
  const stateStore = deps.stateStore ?? createInMemoryStateStore();
  const logger = deps.logger ?? console;
  // 現在時刻取得関数（既定は実時刻）。nextStep へ予約日時解決の基準時刻を注入する。
  const clock = deps.clock ?? (() => new Date());

  /**
   * 予約完了時の処理: DTO 構築 → 予約作成 → 入室リンク発行 → 確定メッセージ送信。
   *
   * @param {string} sender 送信者 WhatsApp 番号
   * @param {object} completedState 完了会話状態（step === COMPLETED）
   * @param {import('../domain/types.js').OutMessage} confirmationOutMessage
   *   nextStep が返した確定メッセージ（確定成功時に送信）
   * @param {('en'|'ja')} language
   * @returns {Promise<object>} 処理結果
   */
  async function finalizeReservation(sender, completedState, confirmationOutMessage, language) {
    let dto;
    try {
      dto = buildReservationDTO(completedState);
    } catch (err) {
      logger.error('[Chatbot_Service] 予約 DTO 構築に失敗しました:', err);
      return { ok: false, code: 'dto_error', message: err?.message ?? String(err) };
    }

    // 会話が最後まで進んだ時点で予約は確定なので CONFIRMED として登録する。
    // pending のままだと事前リマインダー（24時間前・10分前）の対象外になり、
    // 確定メッセージを送ったのに開催直前の通知が一切届かない。
    const result = await reservationService.createReservation({
      ...dto,
      contact: dto.contact ?? sender,
      status: ReservationStatus.CONFIRMED,
    });

    // 空き不可時: 予約不可メッセージ + 代替候補（インタラクティブ list）を送信（要件 1.5）
    if (!result.ok && result.code === 'slot_unavailable') {
      const options = alternativesToOptions(result.alternatives);
      const outMessage = {
        type: OutMessageType.LIST,
        text: UNAVAILABLE_TEXT[language] ?? UNAVAILABLE_TEXT.en,
        options,
      };
      await whatsAppClient.sendOutMessage(outMessage, { to: sender, language });
      // 会話を時刻選択へ戻し、再選択を促す。
      stateStore.set(sender, {
        ...completedState,
        step: ConversationStep.SELECT_TIME,
        language,
      });
      return { ok: false, code: 'slot_unavailable', alternatives: result.alternatives, outMessage };
    }

    // その他の失敗（バリデーション / store エラー）: 記録し失敗応答（呼び出し元でハンドリング）
    if (!result.ok) {
      logger.error('[Chatbot_Service] 予約作成に失敗しました:', result);
      return { ok: false, code: result.code ?? 'reservation_error', detail: result };
    }

    // 保存完了 → 入室リンクを発行して確定メッセージに含める
    const savedLanguage = SUPPORTED_LANGUAGES.includes(result.reservation?.language)
      ? result.reservation.language
      : language;

    // 入室リンクを発行（一度だけ有効）
    const { url: joinUrl } = await joinLinkService.issueForReservation({
      reservationId: result.reservation.reservationId,
      sessionId: result.reservation.sessionId,
      reservationTime: result.reservation.reservationTime,
    });

    // 入室URLを含む確定メッセージを生成して送信
    const finalMessage = confirmationMessage(result.reservation, joinUrl);
    await whatsAppClient.sendOutMessage(finalMessage, {
      to: sender,
      language: savedLanguage,
    });

    // 完了した会話状態はクリアする。
    stateStore.delete(sender);
    return { ok: true, reservation: result.reservation, outMessage: finalMessage };
  }

  /**
   * 受信メッセージ Webhook を処理する（要件 1.1・1.2・1.5）。
   *
   * 流れ:
   *  1) ペイロードから送信者・入力・言語を抽出。
   *  2) 送信者の既存会話状態を取得（無ければ START）。
   *  3) nextStep で次状態と outMessage を決定。
   *  4) 次状態が COMPLETED なら予約確定処理へ（DTO→登録→確定/代替）。
   *  5) それ以外は次状態を保存し outMessage を WhatsApp 送信。
   *
   * @param {object} payload 受信 Webhook ボディ（信頼できない外部入力）
   * @returns {Promise<object>} 処理結果
   */
  async function handleInboundMessage(payload) {
    const sender = extractSender(payload);
    if (!sender) {
      return { ok: false, code: 'bad_request', message: 'sender を特定できません。' };
    }

    const existingState = stateStore.get(sender) ?? {
      step: ConversationStep.START,
      contact: sender,
    };
    const language = resolveLanguage(payload, existingState);
    const inputValue = extractInputValue(payload);

    // 会話遷移（純粋関数）。言語は入力から明示指定できる。
    // 予約日時解決の基準時刻として現在時刻（now）を必ず注入する。これを渡さないと
    // nextStep が 'day_N'/'slot_HHMM' を固定基準（2000-01-01）で解決し、実運用の予約
    // 日時が誤って年 2000 になる。入力値の有無に関わらず now を含める。
    const now = clock().toISOString();
    const { nextState, outMessage } = nextStep(
      { ...existingState, contact: existingState.contact ?? sender, language },
      inputValue !== undefined ? { value: inputValue, language, now } : { language, now },
    );

    // 完了時は予約確定フローへ（finalizeReservation 内で入室リンク付きメッセージを生成・送信）。
    if (nextState.step === ConversationStep.COMPLETED) {
      return finalizeReservation(sender, nextState, outMessage, language);
    }

    // 中間ステップ: 状態を保存し、選択肢メッセージを送信（要件 1.1・1.6）。
    stateStore.set(sender, nextState);
    const sendResult = await whatsAppClient.sendOutMessage(outMessage, { to: sender, language });
    return { ok: true, nextState, outMessage, send: sendResult };
  }

  /**
   * 送達ステータス Webhook を処理する。
   *
   * 送達状態（delivered / read / failed 等）を記録する。会話状態の進行には影響しないが、
   * 失敗時はログに残す（Notification_Service 等の再送判断は後続タスクの範囲）。
   *
   * @param {object} payload ステータス Webhook ボディ
   * @returns {Promise<object>}
   */
  async function handleMessageStatus(payload) {
    const status = payload?.status ?? payload?.message?.status;
    const messageUuid = payload?.message_uuid ?? payload?.message_id ?? payload?.messageUuid;
    if (status === 'failed' || status === 'rejected' || status === 'undeliverable') {
      logger.error('[Chatbot_Service] メッセージ送達失敗:', { messageUuid, status, error: payload?.error });
    } else if (logger.info) {
      logger.info('[Chatbot_Service] メッセージ送達ステータス:', { messageUuid, status });
    }
    return { ok: true, status: status ?? 'unknown', messageUuid };
  }

  return { handleInboundMessage, handleMessageStatus };
}

/** 既定の Chatbot_Service（実 Reservation_System / WhatsApp クライアント依存）。 */
export const chatbotService = createChatbotService();

export default chatbotService;
