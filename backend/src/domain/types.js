/**
 * ドメイン型定義 (JSDoc typedef)
 *
 * JavaScript プロジェクトのため、型は JSDoc typedef で表現する。
 * これらは設計書の Data Models / Correctness Properties に対応する。
 * ランタイムの実体は持たず、後続タスクの純粋関数・サービスが参照する。
 */

/**
 * 予約レコード (要件 2.2 / design: Reservation)
 * @typedef {Object} Reservation
 * @property {string} reservationId - 予約 ID
 * @property {string} contact - エンドユーザー連絡先（WhatsApp 番号）
 * @property {Date|string} reservationTime - 予約時刻
 * @property {string} service - 対象サービス
 * @property {('pending'|'confirmed'|'cancelled'|'completed')} status - 予約状態
 * @property {('en'|'ja')} language - 対応言語
 * @property {boolean} [notified] - 予約時刻通知済みフラグ
 * @property {string} [sessionId] - 紐づく Vonage セッション ID
 * @property {string} [assignedStaffId] - 担当スタッフ ID
 * @property {Date|string} [createdAt]
 * @property {Date|string} [updatedAt]
 */

/**
 * 予約 DTO — 会話完了状態から構築される登録要求用データ (要件 1.2 / 1.3)
 * @typedef {Object} ReservationDTO
 * @property {string} contact - エンドユーザー連絡先
 * @property {Date|string} reservationTime - 予約時刻
 * @property {string} service - 対象サービス
 * @property {('en'|'ja')} language - 対応言語
 */

/**
 * ユーザー（管理者/スタッフ / 要件 5）
 * @typedef {Object} User
 * @property {string} userId
 * @property {('administrator'|'staff')} role
 * @property {string} passwordHash
 */

/**
 * 予約枠 — 空き判定の入力 (要件 1.5)
 * @typedef {Object} Slot
 * @property {Date|string} start - 開始時刻
 * @property {Date|string} end - 終了時刻
 */

/**
 * 空き判定結果 (要件 1.5 / Property 3)
 * @typedef {Object} AvailabilityResult
 * @property {boolean} available
 * @property {Slot[]} alternatives - 重複時の非重複な代替候補
 */

/**
 * バリデーション結果 (要件 2.2 / 6.4 / Property 5)
 * @typedef {Object} ValidationResult
 * @property {boolean} valid
 * @property {string[]} errors - 検証失敗の理由（フィールド名等）
 */

/**
 * 認可の所有関係コンテキスト (要件 5 / Property 7)
 * @typedef {Object} Ownership
 * @property {string} [userId] - 操作者のユーザー ID
 * @property {string} [assignedStaffId] - 対象予約の担当スタッフ ID
 */

/**
 * 会話状態 (要件 1.1 / 1.2)
 * @typedef {Object} ConversationState
 * @property {string} step - ConversationStep のいずれか
 * @property {string} [contact]
 * @property {string} [service]
 * @property {Date|string} [reservationTime]
 * @property {('en'|'ja')} [language]
 */

/**
 * 送信メッセージ (要件 1.1 / 1.6)
 * @typedef {Object} OutMessage
 * @property {string} type - OutMessageType のいずれか
 * @property {string} [text]
 * @property {Object[]} [options] - reply button / list の選択肢
 * @property {Object} [media] - メディアテンプレート/カルーセル用
 */

/**
 * アーカイブオプション (要件 7 / 8 / design: ArchiveOptions)
 * @typedef {Object} ArchiveOptions
 * @property {string} sessionId
 * @property {boolean} hasAudio
 * @property {boolean} hasVideo
 * @property {('individual'|'composed')} outputMode
 * @property {boolean} [hasTranscription]
 * @property {{primaryLanguageCode: string}} [transcriptionProperties]
 * @property {string} [name]
 */

/**
 * 整形後文字起こし (要件 8.3 / design: SpeakerTranscript)
 * @typedef {Object} SpeakerTranscript
 * @property {number} channel - 音声チャンネル番号
 * @property {string} streamId - channels_metadata.id（ストリーム = 話者）
 * @property {string} speakerLabel - stream ID から解決した表示名
 * @property {Array<{start: number, end: number, text: string}>} segments
 */

// typedef のみのモジュール。ランタイムのエクスポートは無し。
export {};
