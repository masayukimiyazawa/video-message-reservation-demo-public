/**
 * ドメイン定数
 *
 * 副作用を持たない純粋な定義のみを配置する。
 * 予約状態 enum・対応言語・ロール・認可アクションなど、
 * ドメイン層全体で共有される不変の値をここで一元管理する。
 */

/**
 * 入室リンクの拒否理由
 *
 * 定義の正本は domain/joinLink.js だが、frontend / services が
 * 定数モジュールからまとめて参照できるよう、ここにも同じ値を公开する。
 * 値の一致は joinLink.test.js で検証する。
 * @readonly
 * @enum {string}
 */
export const JoinTokenErrorCode = Object.freeze({
  /** トークンが存在しない（typo・攻撃・古いリンク） */
  NOT_FOUND: 'join_token_not_found',
  /** すでに使われた（一度だけ有効なリンクの核心） */
  ALREADY_USED: 'join_token_already_used',
  /** 期限切れ */
  EXPIRED: 'join_token_expired',
  /** 会議室の終了処理により無効化された */
  ROOM_CLOSED: 'join_token_room_closed',
});

/**
 * 予約状態 (要件 2.2)
 * @readonly
 * @enum {string}
 */
export const ReservationStatus = Object.freeze({
  PENDING: 'pending',
  CONFIRMED: 'confirmed',
  CANCELLED: 'cancelled',
  COMPLETED: 'completed',
});

/** 予約状態の全値配列（Mongoose enum / バリデーション用） */
export const RESERVATION_STATUSES = Object.freeze(Object.values(ReservationStatus));

/**
 * 対応言語 (要件 6.4)
 * @readonly
 * @enum {string}
 */
export const SupportedLanguage = Object.freeze({
  EN: 'en',
  JA: 'ja',
});

/** 対応言語の全値配列 { en, ja } */
export const SUPPORTED_LANGUAGES = Object.freeze(Object.values(SupportedLanguage));

/**
 * 言語コード → Vonage Post-Call Transcription 用の primaryLanguageCode
 * (要件 7.2 / 8.1)
 */
export const TRANSCRIPTION_LANGUAGE_CODE = Object.freeze({
  [SupportedLanguage.EN]: 'en-US',
  [SupportedLanguage.JA]: 'ja-JP',
});

/**
 * ユーザーロール (要件 5)
 * @readonly
 * @enum {string}
 */
export const Role = Object.freeze({
  ADMINISTRATOR: 'administrator',
  STAFF: 'staff',
});

/** ロールの全値配列 */
export const ROLES = Object.freeze(Object.values(Role));

/**
 * 認可アクション (要件 5.2 / 5.3 / 5.4)
 * canAccess で参照する操作種別。
 * @readonly
 * @enum {string}
 */
export const AuthAction = Object.freeze({
  MANAGE_RESERVATION: 'manage_reservation',
  VIEW_RESERVATION: 'view_reservation',
  START_RECORDING: 'start_recording',
  STOP_RECORDING: 'stop_recording',
  VIEW_RECORDING: 'view_recording',
  VIEW_TRANSCRIPTION: 'view_transcription',
  MANAGE_PERMISSIONS: 'manage_permissions',
});

/**
 * 会話状態のステップ (要件 1.1 / 1.2)
 * Chatbot_Service の nextStep が遷移させる状態。
 * @readonly
 * @enum {string}
 */
export const ConversationStep = Object.freeze({
  START: 'start',
  SELECT_SERVICE: 'select_service',
  SELECT_DATE: 'select_date',
  SELECT_TIME: 'select_time',
  CONFIRM: 'confirm',
  COMPLETED: 'completed',
});

/**
 * 送信メッセージ種別 (要件 1.1 / 1.6)
 * @readonly
 * @enum {string}
 */
export const OutMessageType = Object.freeze({
  REPLY_BUTTON: 'reply_button',
  LIST: 'list',
  MEDIA_TEMPLATE: 'media_template',
  CAROUSEL: 'carousel',
  CONFIRMATION: 'confirmation',
  TEXT: 'text',
  /**
   * URL ボタン（CTA）を 1 つ持つインタラクティブ種別。
   * 返信ボタン（reply）と違い、タップで指定 URL を開く。
   * 入室リンク通知など「リンクを開かせる」用途で使う。
   */
  CTA_URL: 'cta_url',
});

/**
 * 背景スキン ID (要件 4.3)
 * 病院遠隔診療テーマ (telemedicine) を含む定義済みスキン集合。
 * @readonly
 */
export const BackgroundSkin = Object.freeze({
  NONE: 'none',
  BLUR: 'blur',
  TELEMEDICINE: 'telemedicine',
  OFFICE: 'office',
  NEUTRAL: 'neutral',
});

export const BACKGROUND_SKINS = Object.freeze(Object.values(BackgroundSkin));
