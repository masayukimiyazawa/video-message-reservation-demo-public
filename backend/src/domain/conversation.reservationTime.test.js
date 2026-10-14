/**
 * ドメイン ハッピーパス統合例（要件 1.2）
 *
 * 会話フロー START → SELECT_SERVICE → SELECT_DATE → SELECT_TIME → CONFIRM → COMPLETED
 * を nextStep で辿り、完了状態が buildReservationDTO を通過して有効な予約 DTO を
 * 生成することを検証する（本番 WhatsApp テストで発見されたバグの回帰防止）。
 *
 * バグ: SELECT_TIME でスロット ID ('slot_0900') をそのまま reservationTime に格納して
 * いたため buildReservationDTO が「予約時刻が不正」で throw していた。
 */

import {
  nextStep,
  resolveReservationDateTime,
  DEFAULT_RESERVATION_BASE,
} from './conversation.js';
import { buildReservationDTO } from './reservationDto.js';
import { ConversationStep, OutMessageType } from './constants.js';

/**
 * 受信シーケンスをドメイン純粋関数だけで再現する。
 * @param {Array<object|string|undefined>} inputs 各ステップの入力
 * @param {object} [initial] 初期状態
 * @returns {{ state: object, outMessage: object }}
 */
function runFlow(inputs, initial = { step: ConversationStep.START, contact: '+8190000000' }) {
  let state = initial;
  let outMessage;
  for (const input of inputs) {
    const result = nextStep(state, input);
    state = result.nextState;
    outMessage = result.outMessage;
  }
  return { state, outMessage };
}

describe('ドメイン ハッピーパス: 完了状態は buildReservationDTO を通過する (要件 1.2)', () => {
  test('service→date→time→confirm を辿ると有効な reservationTime を持つ完了状態になる', () => {
    const { state, outMessage } = runFlow([
      { language: 'ja' }, // START → SELECT_SERVICE
      { value: 'consultation' }, // SELECT_SERVICE → SELECT_DATE
      { value: 'day_2' }, // SELECT_DATE → SELECT_TIME
      { value: 'slot_1030' }, // SELECT_TIME → CONFIRM（ここで日時解決）
      { value: 'confirm' }, // CONFIRM → COMPLETED
    ]);

    expect(state.step).toBe(ConversationStep.COMPLETED);
    expect(outMessage.type).toBe(OutMessageType.CONFIRMATION);

    // reservationTime は Date 解析可能な ISO 文字列
    expect(typeof state.reservationTime).toBe('string');
    expect(Number.isNaN(new Date(state.reservationTime).getTime())).toBe(false);

    // buildReservationDTO は throw せず 4 フィールドを返す
    const dto = buildReservationDTO(state);
    expect(dto.contact).toBe('+8190000000');
    expect(dto.service).toBe('consultation');
    expect(dto.language).toBe('ja');
    expect(dto.reservationTime).toBe(state.reservationTime);
    expect(Number.isNaN(new Date(dto.reservationTime).getTime())).toBe(false);
  });

  test('注入された now を基準に day_N / slot_HHMM が正しく解決される', () => {
    // day_1 = 基準日当日, slot_0900 = 09:00 JST = 00:00 UTC
    const now = '2025-06-10T12:34:56.000Z';
    const iso = resolveReservationDateTime('day_1', 'slot_0900', now);
    expect(iso).toBe('2025-06-10T00:00:00.000Z');

    // day_3 = 基準日 + 2 日, slot_1530 = 15:30 JST = 06:30 UTC
    const iso3 = resolveReservationDateTime('day_3', 'slot_1530', now);
    expect(iso3).toBe('2025-06-12T06:30:00.000Z');
  });

  test('now 未指定時は決定的な基準日時にフォールバックする', () => {
    const iso = resolveReservationDateTime('day_1', 'slot_1400', undefined);
    expect(iso).toBe('2000-01-01T05:00:00.000Z');
    expect(new Date(DEFAULT_RESERVATION_BASE).getUTCFullYear()).toBe(2000);
  });

  test('後方互換: 既に有効な ISO 文字列が渡された場合はそのまま採用する', () => {
    const iso = resolveReservationDateTime('day_2', '2030-01-02T08:15:00.000Z', undefined);
    expect(iso).toBe('2030-01-02T08:15:00.000Z');
  });

  test('解析不能なスロットでも有効な日時にフォールバックする', () => {
    const iso = resolveReservationDateTime('day_1', 'garbage', undefined);
    expect(Number.isNaN(new Date(iso).getTime())).toBe(false);
  });
});
