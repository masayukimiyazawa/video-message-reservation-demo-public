/**
 * 会話状態遷移ドメインロジック (Task 2.1 / 要件 1.1・1.6)
 *
 * 副作用を持たない純粋関数 `nextStep(state, input)` を提供する。
 * 有効な次の会話状態と、種別（reply button / list / メディアテンプレート /
 * カルーセル / 確定）を持つ outMessage を返す。
 *
 * 設計対応:
 *  - Chatbot_Service ドメイン関数 `nextStep(state, input) -> { nextState, outMessage }`
 *  - Correctness Property 1: 会話遷移は常に有効な状態と選択肢を返す
 *
 * @module domain/conversation
 */

import { ConversationStep, OutMessageType, SUPPORTED_LANGUAGES } from './constants.js';

/**
 * 予約対象サービスの選択肢 (list メッセージ用)。
 * @readonly
 */
export const SERVICE_OPTIONS = Object.freeze([
  Object.freeze({ id: 'consultation', title: 'Consultation', titleByLang: { en: 'Consultation', ja: '相談' } }),
  Object.freeze({ id: 'follow_up', title: 'Follow-up', titleByLang: { en: 'Follow-up', ja: 'フォローアップ' } }),
  Object.freeze({ id: 'telemedicine', title: 'Telemedicine', titleByLang: { en: 'Telemedicine', ja: '遠隔診療' } }),
]);

/**
 * サービスタイトルを言語に応じて解決する。
 * option が `titleByLang: { en, ja }` を持つ場合はそれを優先し、
 * なければ `title` をそのまま用いる。
 * @param {string} serviceId サービス ID
 * @param {('en'|'ja')} language
 * @returns {string}
 */
export function localizeServiceTitle(serviceId, language) {
  const option = SERVICE_OPTIONS.find((o) => o.id === serviceId);
  if (!option) return serviceId;
  if (option.titleByLang && typeof option.titleByLang[language] === 'string') {
    return option.titleByLang[language];
  }
  return option.title;
}

/**
 * 予約日の選択肢 (list メッセージ用の後方互換プレースホルダ / id の真実の源)。
 *
 * 注意: 実際に WhatsApp ユーザーへ提示される日付タイトルは静的な "Day N" ではなく、
 * {@link buildDateOptions} が現在時刻 `now` を基準に生成する具体的な日付文字列
 * （例 en: "2026-09-26 (Fri)" / ja: "9月26日(金)"）である。DATE_OPTIONS は
 * 後方互換（他コード/テストが import している場合）と id 体系（day_1..day_N）の
 * 真実の源として残す。buildDateOptions は既定でこの配列長から件数を導出する。
 * @readonly
 */
export const DATE_OPTIONS = Object.freeze([
  Object.freeze({ id: 'day_1', title: 'Day 1' }),
  Object.freeze({ id: 'day_2', title: 'Day 2' }),
  Object.freeze({ id: 'day_3', title: 'Day 3' }),
]);

/**
 * 決定的な曜日名（UTC 曜日インデックス 0=Sun..6=Sat）。
 * Intl / ロケール実装による環境差を避け、テストの決定性を保証するため固定配列を用いる。
 * @readonly
 */
const WEEKDAY_NAMES_EN = Object.freeze(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);
const WEEKDAY_NAMES_JA = Object.freeze(['日', '月', '火', '水', '木', '金', '土']);

/**
 * 具体的な予約日の選択肢を生成する純粋関数。
 *
 * `now`（注入された現在時刻）から {@link resolveReservationDateTime} と同一の基準日規則
 * （resolveBaseDate(now) を UTC 00:00 の日に丸める）で基準日を求め、N=1..count について
 * 基準日 + (N-1) 日の具体的な日付タイトルを持つ選択肢配列を返す。
 *
 * 重要:
 *  - `id` は 'day_N' のまま維持する（表示だけ具体化）。これにより後段の
 *    {@link resolveReservationDateTime} が選択された日付を正しくオフセット解決できる。
 *  - 日付計算は UTC で行う（resolveReservationDateTime の UTC 日計算と一致させ、
 *    表示タイトルと解決される reservationTime のタイムゾーンずれを防ぐ）。
 *  - 決定的・純粋: `Date.now()` を呼ばず、注入された `now` からのみ導出する。
 *    曜日/月名は固定配列を用い、Intl 等の実行時ロケールに依存しない。
 *
 * タイトル書式:
 *  - en: "YYYY-MM-DD (Www)" 例 "2026-09-26 (Fri)"（ISO 日付 + 3 文字曜日、曖昧さなし・並べ替え可能）
 *  - ja: "M月D日(W)" 例 "9月26日(金)"
 *
 * @param {string|number|Date|undefined} now 注入された基準時刻（未指定なら決定的基準にフォールバック）
 * @param {('en'|'ja')} [language='en'] 表示言語（'ja' 以外は en 書式）
 * @param {number} [count=DATE_OPTIONS.length] 生成する選択肢数（既定は DATE_OPTIONS 件数）
 * @returns {Array<{ id: string, title: string }>}
 */
export function buildDateOptions(now, language = 'en', count = DATE_OPTIONS.length) {
  const base = resolveBaseDate(now);
  const lang = language === 'ja' ? 'ja' : 'en';
  const n = Number.isFinite(count) && count >= 1 ? Math.floor(count) : DATE_OPTIONS.length;

  const options = [];
  for (let i = 0; i < n; i += 1) {
    // 基準日を UTC 00:00 に丸め、(i) 日進める（day_1 は基準日当日）。
    const date = new Date(
      Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() + i, 0, 0, 0, 0),
    );
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth() + 1; // 1..12
    const day = date.getUTCDate(); // 1..31
    const weekday = date.getUTCDay(); // 0..6

    let title;
    if (lang === 'ja') {
      title = `${month}月${day}日(${WEEKDAY_NAMES_JA[weekday]})`;
    } else {
      const mm = String(month).padStart(2, '0');
      const dd = String(day).padStart(2, '0');
      title = `${year}-${mm}-${dd} (${WEEKDAY_NAMES_EN[weekday]})`;
    }

    options.push({ id: `day_${i + 1}`, title });
  }
  return options;
}

/**
 * 予約時刻の選択肢 (list メッセージ用のプレースホルダ)。
 * @readonly
 */

/** Japan Standard Time (UTC+9) オフセット（ミリ秒）。 */
export const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/**
 * 指定 instant が属する JST 暦日の「JST 0:00」を UTC instant として返す。
 *
 * サーバー／クライアントのローカルタイムゾーンに依存しないよう、
 * 時刻はすべて UTC で演算し、JST への変換はオフセットの加減算で行う。
 * （ローカル時刻の getDate()/setHours() を使うと、サーバーが JST の場合は
 *   15:00 以降で「今日」が明日にずれるなど不正になる。）
 *
 * @param {Date|string|number} now 基準 instant
 * @returns {Date} JST 0:00 に相当する instant
 */
export function startOfJstDayUtc(now) {
  const base = toDate(now);
  if (Number.isNaN(base.getTime())) {
    throw new RangeError('startOfJstDayUtc: 不正な日時です');
  }
  return startOfDayInOffset(base, JST_OFFSET_MS);
}

/**
 * 指定 instant を「基準時刻ゾーンで見た 0:00」に丸める。
 *
 * @param {Date} instant 丸めの対象
 * @param {number} offsetMs 基準ゾーンの UTC からのオフセット（0 = UTC, JST_OFFSET_MS = JST）
 * @returns {Date}
 */
function startOfDayInOffset(instant, offsetMs) {
  const shifted = new Date(instant.getTime() + offsetMs);
  return new Date(
    Date.UTC(
      shifted.getUTCFullYear(),
      shifted.getUTCMonth(),
      shifted.getUTCDate(),
      0,
      0,
      0,
      0,
    ) - offsetMs,
  );
}

/**
 * 指定 instant の「基準時刻ゾーンにおける M/D」を取り出す。
 * @param {Date} instant
 * @param {number} offsetMs 基準ゾーンの UTC からのオフセット
 * @returns {string} 'M/D' 形式
 */
function monthDayInOffset(instant, offsetMs) {
  const shifted = new Date(instant.getTime() + offsetMs);
  return `${shifted.getUTCMonth() + 1}/${shifted.getUTCDate()}`;
}

/**
 * 指定 instant の「基準時刻ゾーンにおける YYYY-MM-DD」を取り出す。
 *
 * スロットの表示タイトル（'M/D HH:MM'）は表示専用であり、年を含まないため
 * 実データとしては使えない。呼び出し元が slotted な予約を作成できるよう、
 * 日付と時刻を機械可読なフィールドとして別途持たせる。
 *
 * @param {Date} instant
 * @param {number} offsetMs 基準ゾーンの UTC からのオフセット
 * @returns {string} 'YYYY-MM-DD' 形式
 */
function isoDateInOffset(instant, offsetMs) {
  const shifted = new Date(instant.getTime() + offsetMs);
  const year = shifted.getUTCFullYear();
  const month = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const day = String(shifted.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * 基準日上のある時刻を UTC instant として求める。
 *
 * dayStart は既に「その基準日の 0:00 相当の instant」なので、そこへ時分の長さを
 * 加えるだけでその基準日の時刻になる（オフセットをもう一度引かないこと）。
 *
 * @param {Date} dayStart 基準日 0:00 の instant
 * @param {number} hour その基準日での時
 * @param {number} minute その基準日での分
 * @returns {Date}
 */
function timeOnDay(dayStart, hour, minute) {
  return new Date(dayStart.getTime() + (hour * 60 + minute) * 60 * 1000);
}

/**
 * 時間スロットの定義（基準時刻 `now` と選択日 `selectedDate` に基づき動的に生成）。
 *
 * ルール:
 *  - 選択日が基準日 (`now` の日付) の場合: 現在時刻より遅いスロットのみ表示
 *  - 選択日が基準日で利用可能スロットが 0 個の場合: 翌日以降 3 日分のスロットを表示
 *  - 選択日が明日以降の場合: 全スロット表示
 *
 * 比較はすべて UTC instant で行い、スロットの「9:00」は **基準日ゾーンの 9:00** を意味する。
 *
 * 基準日ゾーンは明示的に選べる（既定は UTC）:
 *  - チャットフロー（`nextStep` → 呼び出し元は startOfToday を渡さない）は
 *    {@link buildDateOptions} / {@link resolveReservationDateTime} と揃えた UTC 暦日を使う。
 *  - 管理画面は `dayBasisOffsetMs: JST_OFFSET_MS` を渡して JST 暦日を使う。
 *
 * いずれの場合もローカルタイムゾーンの getDate()/setHours() に依存しないため、
 * サーバー TZ が変わっても結果は同じになる。
 *
 * @param {string|number|Date|undefined} now - 基準時刻（未指定・不正なら決定的な基準時刻）
 * @param {string} selectedDate - 'day_1' | 'day_2' | 'day_3'（基準日からの相対日）
 * 各スロットは以下のフィールドを持つ:
 *  - `id` / `title`: 既存仕様（表示・チャットフローの識別子）
 *  - `time`: 'HH:MM'。予約済み判定（title ではなく時刻で比較する）
 *  - `date`: 'YYYY-MM-DD'（基準日ゾーン）。**title に年が無いため必須**
 *
 * `title` は表示専用であり、multiDay の場合は 'M/D HH:MM' と日付を含むため
 * 日付＋時刻として解析してはいけない。予約作成には `date` と `time` を使う。
 *
 * @param {object} [opts]
 * @param {Date|string|number} [opts.startOfToday] 明示的な基準日 0:00（呼び出し側が算出したもの）
 * @param {number} [opts.dayBasisOffsetMs=0] 基準日ゾーンの UTC オフセット（0=UTC, JST_OFFSET_MS=JST）
 * @returns {Array<{id: string, title: string, time: string, date: string}>}
 */
export function buildTimeOptions(now, selectedDate, opts = {}) {
  const { startOfToday, dayBasisOffsetMs = 0 } = opts ?? {};
  const baseNow = resolveBaseDate(now);
  const today = startOfToday
    ? toDate(startOfToday)
    : startOfDayInOffset(baseNow, dayBasisOffsetMs);

  // 固定スロット（時刻は基準日ゾーン）
  const allSlots = [
    { id: 'slot_0900', title: '09:00', hour: 9, minute: 0 },
    { id: 'slot_1030', title: '10:30', hour: 10, minute: 30 },
    { id: 'slot_1400', title: '14:00', hour: 14, minute: 0 },
    { id: 'slot_1530', title: '15:30', hour: 15, minute: 30 },
  ];

  // 選択日が「基準日から何日後か」を算出
  const dayIndex = parseInt(selectedDate?.replace('day_', ''), 10);
  if (isNaN(dayIndex) || dayIndex < 1 || dayIndex > 3) {
    return allSlots.map((s) => ({
      id: s.id,
      title: s.title,
      time: s.title,
      date: isoDateInOffset(today, dayBasisOffsetMs),
    }));
  }

  const targetDate = new Date(today.getTime() + (dayIndex - 1) * 24 * 60 * 60 * 1000);

  const isToday = targetDate.getTime() === today.getTime();

  // 基準日が今日なら「現在時刻より後」だけを採用
  const filtered = allSlots.filter((slot) => {
    if (!isToday) return true;
    return timeOnDay(targetDate, slot.hour, slot.minute).getTime() > baseNow.getTime();
  });

  // 今日で利用可能スロットがあればそれを返す
  if (filtered.length > 0) {
    return filtered.map((s) => ({
      id: s.id,
      title: s.title,
      time: s.title,
      date: isoDateInOffset(targetDate, dayBasisOffsetMs),
    }));
  }

  // 今日で空なら翌日以降 3 日分の全スロットを返す（基準日ゾーンの日付ラベル付き）
  const multiDay = [];
  for (let d = 0; d < 3; d++) {
    const day = new Date(targetDate.getTime() + d * 24 * 60 * 60 * 1000);
    const label = monthDayInOffset(day, dayBasisOffsetMs);
    const isoDate = isoDateInOffset(day, dayBasisOffsetMs);
    allSlots.forEach((slot) => {
      multiDay.push({
        id: `${slot.id}_day${d + 1}`,
        title: `${label} ${slot.title}`,
        time: slot.title,
        date: isoDate,
      });
    });
  }
  return multiDay;
}

/**
 * 日付文字列等を Date に正規化する。
 * @param {Date|string|number} value
 * @returns {Date}
 */
function toDate(value) {
  return value instanceof Date ? value : new Date(value);
}

/**
 * 予約フローの遷移順序。
 * @readonly
 */
export const STEP_ORDER = Object.freeze([
  ConversationStep.START,
  ConversationStep.SELECT_SERVICE,
  ConversationStep.SELECT_DATE,
  ConversationStep.SELECT_TIME,
  ConversationStep.CONFIRM,
  ConversationStep.COMPLETED,
]);

/**
 * 予約日時解決の決定的な基準時刻。
 *
 * 純粋関数の決定性（プロパティテストの再現性）を保つため、`now` が注入されない場合は
 * この固定基準時刻を用いる。実運用では chatbotService 等が `input.now` / `state.now`
 * に実時刻（ISO 文字列または epoch）を注入することで正しい予約日時を得る。
 * `Date.now()` を純粋コア内で無条件に呼ぶことはしない（決定性を壊さないため）。
 * @readonly
 */
export const DEFAULT_RESERVATION_BASE = '2000-01-01T00:00:00.000Z';

/**
 * 注入された `now`（ISO 文字列 or epoch 数値 or Date）を Date に正規化する（純粋）。
 * 解析できない場合は決定的な基準時刻 {@link DEFAULT_RESERVATION_BASE} を返す。
 * @param {string|number|Date|undefined} now
 * @returns {Date}
 */
export function resolveBaseDate(now) {
  if (now instanceof Date && !Number.isNaN(now.getTime())) return now;
  if (typeof now === 'number' && Number.isFinite(now)) {
    const d = new Date(now);
    if (!Number.isNaN(d.getTime())) return d;
  }
  if (typeof now === 'string' && now.trim().length > 0) {
    const d = new Date(now);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date(DEFAULT_RESERVATION_BASE);
}

/**
 * 選択された日付オプション ('day_N') と時刻スロット ('slot_HHMM') を実際の予約日時へ
 * 解決する純粋関数。
 *
 * 規則:
 *  - 既に解析可能な日時（Date または ISO 文字列）が渡された場合はそれを優先（後方互換）。
 *  - 'day_N' → 基準日 (now を UTC 00:00 に丸めた日) + (N - 1) 日。すなわち Day 1 は基準日当日。
 *  - 'slot_HHMM' → その日の UTC HH:MM。
 *  - 解析できない場合は基準日 (UTC 00:00) にフォールバックし、常に有効な日時を返す。
 *
 * 返り値は ISO 8601 文字列（Date 解析可能）で、buildReservationDTO が受理できる。
 *
 * @param {string|Date|undefined} selectedDate 選択日 ('day_N') または既に有効な日時
 * @param {string|Date|undefined} slotValue 選択時刻 ('slot_HHMM') または既に有効な日時
 * @param {string|number|Date|undefined} now 注入された基準時刻（未指定なら決定的基準）
 * @returns {string} 予約日時の ISO 8601 文字列
 */
export function resolveReservationDateTime(selectedDate, slotValue, now) {
  // 後方互換: slotValue が既に有効な日時ならそのまま採用。
  if (slotValue instanceof Date && !Number.isNaN(slotValue.getTime())) {
    return slotValue.toISOString();
  }
  if (typeof slotValue === 'string') {
    const trimmed = slotValue.trim();
    const slotMatch = /^slot_(\d{2})(\d{2})$/.exec(trimmed);
    if (!slotMatch && trimmed.length > 0) {
      const asDate = new Date(trimmed);
      if (!Number.isNaN(asDate.getTime())) {
        return asDate.toISOString();
      }
    }
  }

  // 基準日（UTC 00:00 に丸める）を算出。
  const base = resolveBaseDate(now);
  let dayOffset = 0;
  if (typeof selectedDate === 'string') {
    const dayMatch = /^day_(\d+)$/.exec(selectedDate.trim());
    if (dayMatch) {
      const n = Number.parseInt(dayMatch[1], 10);
      if (Number.isFinite(n) && n >= 1) dayOffset = n - 1;
    }
  }

  const result = new Date(
    Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() + dayOffset, 0, 0, 0, 0),
  );

  // 時刻スロットの解析（'slot_HHMM'）。解析不能なら 00:00 のまま（有効な日時を保証）。
  // スロットの時刻は JST 表記（例: slot_0900 = 9:00 JST）なので、UTC に変換するため 9 時間引く。
  if (typeof slotValue === 'string') {
    // slot_HHMM または slot_HHMM_dayN の両方に対応
    const slotMatch = /^slot_(\d{2})(\d{2})(?:_day(\d+))?$/.exec(slotValue.trim());
    if (slotMatch) {
      const hours = Number.parseInt(slotMatch[1], 10);
      const minutes = Number.parseInt(slotMatch[2], 10);
      if (hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59) {
        // スロット時刻は JST 表記なので、UTC に変換するため 9 時間引く
        const utcHours = (hours - 9 + 24) % 24;
        const dayAdjust = hours < 9 ? -1 : 0;
        result.setUTCHours(utcHours, minutes, 0, 0);
        if (dayAdjust !== 0) {
          result.setUTCDate(result.getUTCDate() + dayAdjust);
        }
      }
      // _dayN があれば追加オフセット
      if (slotMatch[3]) {
        const extraDay = Number.parseInt(slotMatch[3], 10);
        if (Number.isFinite(extraDay) && extraDay > 0) {
          result.setUTCDate(result.getUTCDate() + (extraDay - 1));
        }
      }
    }
  }

  return result.toISOString();
}

/**
 * 入力値を文字列に正規化する（純粋・安全）。
 * @param {*} value
 * @returns {string|undefined}
 */
function readInputValue(value) {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && typeof value.value === 'string') return value.value;
  if (typeof value === 'object' && typeof value.id === 'string') return value.id;
  return String(value);
}

/**
 * reply button メッセージを組み立てる。
 * @param {string} text
 * @param {ReadonlyArray<{id: string, title: string}>} options
 * @returns {import('./types.js').OutMessage}
 */
function replyButtonMessage(text, options) {
  return { type: OutMessageType.REPLY_BUTTON, text, options: options.map((o) => ({ ...o })) };
}

/**
 * list メッセージを組み立てる。
 * @param {string} text
 * @param {ReadonlyArray<{id: string, title: string}>} options
 * @returns {import('./types.js').OutMessage}
 */
function listMessage(text, options) {
  return { type: OutMessageType.LIST, text, options: options.map((o) => ({ ...o })) };
}

/**
 * リッチメディア（メディアテンプレート/カルーセル）メッセージを組み立てる。
 * 要件 1.6: 画像を含むメディアテンプレートまたはカルーセルメッセージ。
 *
 * @param {import('./constants.js').OutMessageType} type - MEDIA_TEMPLATE か CAROUSEL
 * @param {string} text
 * @param {{header?: string, imageUrl?: string, cards?: Array<Object>}} [media]
 * @param {ReadonlyArray<{id: string, title: string}>} [options]
 * @returns {import('./types.js').OutMessage}
 */
export function buildRichMediaMessage(type, text, media = {}, options = []) {
  const message = { type, text };
  if (type === OutMessageType.CAROUSEL) {
    // カルーセルは複数カードの集合。media.cards が未指定なら options から生成する。
    const cards =
      Array.isArray(media.cards) && media.cards.length > 0
        ? media.cards.map((c) => ({ ...c }))
        : options.map((o) => ({
            id: o.id,
            title: o.title,
            imageUrl: media.imageUrl,
          }));
    message.media = { ...media, cards };
  } else {
    // メディアテンプレート: 単一の画像/ヘッダを持つ。
    message.media = { ...media };
  }
  if (options.length > 0) {
    message.options = options.map((o) => ({ ...o }));
  }
  return message;
}

/**
 * 確定メッセージ（要約付き）を組み立てる。
 * @param {import('./types.js').ConversationState} state
 * @returns {import('./types.js').OutMessage}
 */
function confirmationMessage(state, joinUrl) {
  const lang = state.language === 'ja' ? 'ja' : 'en';
  const time = state.reservationTime ? formatDateTime(state.reservationTime, lang) : '';
  const serviceTitle = localizeServiceTitle(state.service, lang);
  const text = joinUrl
    ? (lang === 'ja'
        ? `ご予約が確定しました。\nサービス: ${serviceTitle}\n日時: ${time}\n入室URL: ${joinUrl}\n※このリンクは一度だけ有効です。`
        : `Your reservation is confirmed.\nService: ${serviceTitle}\nTime: ${time}\nJoin URL: ${joinUrl}\n※This link is one-time only.`)
    : (lang === 'ja'
        ? `ご予約が確定しました。\nサービス: ${serviceTitle}\n日時: ${time}`
        : `Your reservation is confirmed.\nService: ${serviceTitle}\nTime: ${time}`);

  return {
    type: OutMessageType.CONFIRMATION,
    text,
    summary: {
      contact: state.contact,
      service: state.service,
      reservationTime: state.reservationTime,
      language: state.language,
      joinUrl,
    },
  };
}

/**
 * 予約詳細を言語に応じてフォーマットする。
 * @param {object} state
 * @param {('en'|'ja')} lang
 * @returns {string}
 */
function formatReservationDetails(state, lang) {
  const time = state.reservationTime ? formatDateTime(state.reservationTime, lang) : '';
  return lang === 'ja'
    ? `以下の内容でご予約を承ります。\nサービス: ${state.service}\n日時: ${time}\n\nよろしければ「確認OK」、修正する場合は「修正」を選択してください。`
    : `Please confirm your reservation.\nService: ${state.service}\nTime: ${time}\n\nSelect "Confirm" to proceed or "Modify" to make changes.`;
}

/**
 * ISO 日時文字列 (UTC) を言語別の表示形式 (JST) に変換する。
 * 内部保存は UTC、表示は JST に統一する。
 * @param {string} iso - UTC の ISO 8601 文字列
 * @param {('en'|'ja')} lang
 * @returns {string} JST 表示文字列
 */
function formatDateTime(iso, lang) {
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    // 保存時刻は UTC。Asia/Tokyo を指定して JST 表示する。
    if (lang === 'ja') {
      const jst = new Date(d.getTime() + JST_OFFSET_MS);
      return `${jst.getUTCFullYear()}年${jst.getUTCMonth() + 1}月${jst.getUTCDate()}日 ${String(jst.getUTCHours()).padStart(2, '0')}:${String(jst.getUTCMinutes()).padStart(2, '0')}`;
    }
    // 英語は 12 時間表記 (AM/PM) で JST 表示
    const jst = new Date(d.getTime() + JST_OFFSET_MS);
    return jst.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'UTC' });
  } catch {
    return iso;
  }
}

/**
 * 会話状態から次の状態と送信メッセージを決定する純粋関数。
 *
 * 副作用を持たず、入力の `state` を変更しない（新しいオブジェクトを返す）。
 * 未知/不正な step であっても必ず有効な状態と定義済み種別の outMessage を返す
 * （Property 1）。
 *
 * @param {import('./types.js').ConversationState} state - 現在の会話状態
 * @param {(string|{value?: string, id?: string, language?: ('en'|'ja')})} [input]
 *   - ユーザー入力（選択された選択肢の id / テキスト等）
 * @returns {{ nextState: import('./types.js').ConversationState, outMessage: import('./types.js').OutMessage }}
 */
export function nextStep(state, input) {
  // 入力状態を破壊しないため浅いコピーを作る。
  const current = state && typeof state === 'object' ? { ...state } : {};
  const step = STEP_ORDER.includes(current.step) ? current.step : ConversationStep.START;
  const value = readInputValue(input);
  // 言語は入力から明示指定できる。未指定・不正なら既定 'ja'。
  const inputLanguage =
    input && typeof input === 'object' && SUPPORTED_LANGUAGES.includes(input.language)
      ? input.language
      : undefined;
  const language = inputLanguage || (SUPPORTED_LANGUAGES.includes(current.language) ? current.language : 'ja');

  // 決定的な基準時刻。入力から明示注入可能（未指定なら state.now、さらに未指定なら
  // 決定的基準にフォールバック）。純粋性のため Date.now() は無条件には呼ばない。
  const now =
    (input && typeof input === 'object' && (input.now ?? undefined)) ?? current.now ?? undefined;

  // 言語切り替えボタンの処理（どのステップでも有効）
  if (value === 'lang_en' || value === 'lang_ja') {
    const newLang = value === 'lang_en' ? 'en' : 'ja';
    const nextState = { ...current, language: newLang, step: ConversationStep.START };
    return {
      nextState,
      outMessage: replyButtonMessage(
        newLang === 'ja'
          ? 'ご予約されるサービスを選択してください。'
          : 'Please choose a service to book.',
        [
          ...SERVICE_OPTIONS,
          { id: 'lang_en', title: 'English' },
          { id: 'lang_ja', title: '日本語' },
        ],
      ),
    };
  }

  switch (step) {
    case ConversationStep.START: {
      // 予約開始 → サービス選択（reply button で開始、選択肢を提示）。要件 1.1
      // 言語切り替えボタンも同時に提示する。
      const nextState = {
        ...current,
        step: ConversationStep.SELECT_SERVICE,
        language,
        contact: current.contact ?? value,
      };
      return {
        nextState,
        outMessage: replyButtonMessage(
          language === 'ja'
            ? 'ご予約されるサービスを選択してください。'
            : 'Please choose a service to book.',
          [
            ...SERVICE_OPTIONS,
            { id: 'lang_en', title: 'English' },
            { id: 'lang_ja', title: '日本語' },
          ],
        ),
      };
    }

    case ConversationStep.SELECT_SERVICE: {
      // サービス確定 → 日付選択（list メッセージ）。
      const service = value ?? current.service;
      const nextState = {
        ...current,
        step: ConversationStep.SELECT_DATE,
        language,
        service,
      };
      // 静的な "Day N" ではなく、現在時刻 now を基準にした具体的な日付タイトルを提示する。
      // id は 'day_N' のまま維持されるため resolveReservationDateTime が正しく解決できる。
      return {
        nextState,
        outMessage: listMessage('Please choose a date.', buildDateOptions(now, language)),
      };
    }

    case ConversationStep.SELECT_DATE: {
      // 日付確定 → 時刻選択（list メッセージ）。
      const selectedDate = value ?? current.selectedDate;
      const nextState = {
        ...current,
        step: ConversationStep.SELECT_TIME,
        language,
        selectedDate,
      };
      return {
        nextState,
        outMessage: listMessage('Please choose a time.', buildTimeOptions(now, selectedDate)),
      };
    }

    case ConversationStep.SELECT_TIME: {
      // 時刻確定 → 確認（リッチメディア: 予約内容のメディアテンプレート）。要件 1.6
      //
      // 重要（バグ修正 / 要件 1.2）:
      //   従来は選択されたスロット ID（例 'slot_0900'）をそのまま reservationTime に格納
      //   していたため、buildReservationDTO が Date 解析不能として拒否し予約が作成されな
      //   かった。ここで選択日 ('day_N') と時刻スロット ('slot_HHMM') を実際の予約日時
      //   （ISO 8601 文字列）へ解決してから格納する。決定性は resolveReservationDateTime
      //   に注入する `now`（既定は固定基準）で担保する。
      const slotValue = value ?? current.reservationTime;
      const reservationTime = resolveReservationDateTime(current.selectedDate, slotValue, now);
      const nextState = {
        ...current,
        step: ConversationStep.CONFIRM,
        language,
        reservationTime,
      };
      // 予約内容を表示して確認OK / 修正 を選択させる
      const details = formatReservationDetails(nextState, language);
      return {
        nextState,
        outMessage: replyButtonMessage(details, [
          { id: 'confirm_ok', title: language === 'ja' ? '確認OK' : 'Confirm', titleByLang: { en: 'Confirm', ja: '確認OK' } },
          { id: 'modify', title: language === 'ja' ? '修正' : 'Modify', titleByLang: { en: 'Modify', ja: '修正' } },
        ]),
      };
    }

    case ConversationStep.CONFIRM: {
      // 確認応答。confirm_ok なら確定、modify ならサービス選択へ戻す。
      const isConfirm = value === 'confirm_ok' || /^(confirm|yes|ok|はい|確定)$/i.test(String(value));
      const isModify = value === 'modify' || /^(modify|change|修正)$/i.test(String(value));
      if (isConfirm) {
        const nextState = { ...current, step: ConversationStep.COMPLETED, language };
        return { nextState, outMessage: confirmationMessage(nextState) };
      }
      if (isModify) {
        const nextState = { ...current, step: ConversationStep.SELECT_SERVICE, language };
        return {
          nextState,
          outMessage: replyButtonMessage(
            language === 'ja' ? 'どの項目を修正しますか？' : 'What would you like to change?',
            SERVICE_OPTIONS,
          ),
        };
      }
      // その他の入力は確認画面に戻す（言語を正規化して保持）
      const details = formatReservationDetails(current, language);
      return {
        nextState: { ...current, language },
        outMessage: replyButtonMessage(details, [
          { id: 'confirm_ok', title: language === 'ja' ? '確認OK' : 'Confirm', titleByLang: { en: 'Confirm', ja: '確認OK' } },
          { id: 'modify', title: language === 'ja' ? '修正' : 'Modify', titleByLang: { en: 'Modify', ja: '修正' } },
        ]),
      };
    }

    case ConversationStep.COMPLETED:
    default: {
      // 完了済み。再度の入力には確定内容を再送する（冪等）。
      const nextState = { ...current, step: ConversationStep.COMPLETED, language };
      return { nextState, outMessage: confirmationMessage(nextState) };
    }
  }
}

export { confirmationMessage, formatReservationDetails, formatDateTime };
