import fc from 'fast-check';
import { nextStep, STEP_ORDER } from './conversation.js';
import {
  ConversationStep,
  OutMessageType,
  SUPPORTED_LANGUAGES,
} from './constants.js';

/**
 * Feature: vonage-video-reservation, Property 1: 会話遷移は常に有効な状態と選択肢を返す
 *
 * For any 有効な会話状態と任意のユーザー入力について、nextStep は有効な次の会話状態と、
 * 種別が定義済みのインタラクティブメッセージ（reply button / list / メディアテンプレート / 確定）を返す。
 *
 * Validates: Requirements 1.1
 */

const VALID_STEPS = STEP_ORDER;
const VALID_OUT_TYPES = Object.values(OutMessageType);

/** 任意の（既知/未知含む）step 文字列 */
const stepArb = fc.oneof(
  fc.constantFrom(...VALID_STEPS),
  fc.string(), // 未知/不正な step も含める
);

/** 会話状態ジェネレータ */
const stateArb = fc.record(
  {
    step: stepArb,
    contact: fc.option(fc.string(), { nil: undefined }),
    service: fc.option(fc.string(), { nil: undefined }),
    reservationTime: fc.option(fc.string(), { nil: undefined }),
    selectedDate: fc.option(fc.string(), { nil: undefined }),
    language: fc.option(fc.constantFrom(...SUPPORTED_LANGUAGES, 'xx'), {
      nil: undefined,
    }),
  },
  { requiredKeys: ['step'] },
);

/** 入力ジェネレータ: 文字列 / オブジェクト（value/id/language）/ undefined */
const inputArb = fc.oneof(
  fc.constant(undefined),
  fc.string(),
  fc.record(
    {
      value: fc.option(fc.string(), { nil: undefined }),
      id: fc.option(fc.string(), { nil: undefined }),
      language: fc.option(fc.constantFrom(...SUPPORTED_LANGUAGES, 'xx'), {
        nil: undefined,
      }),
    },
    { requiredKeys: [] },
  ),
);

describe('Property 1: 会話遷移は常に有効な状態と選択肢を返す (要件 1.1)', () => {
  test('nextStep は有効な次状態と定義済み種別の outMessage を返す', () => {
    fc.assert(
      fc.property(stateArb, inputArb, (state, input) => {
        const result = nextStep(state, input);

        // 戻り値の構造
        expect(result).toBeDefined();
        expect(result.nextState).toBeDefined();
        expect(result.outMessage).toBeDefined();

        // 次の会話状態は有効な step のいずれか
        expect(VALID_STEPS).toContain(result.nextState.step);

        // 言語は必ず対応言語 { en, ja } のいずれかへ正規化される
        expect(SUPPORTED_LANGUAGES).toContain(result.nextState.language);

        // outMessage は定義済み種別
        expect(VALID_OUT_TYPES).toContain(result.outMessage.type);

        // 選択肢を持つ種別 (reply button / list) では options が非空配列
        if (
          result.outMessage.type === OutMessageType.REPLY_BUTTON ||
          result.outMessage.type === OutMessageType.LIST
        ) {
          expect(Array.isArray(result.outMessage.options)).toBe(true);
          expect(result.outMessage.options.length).toBeGreaterThan(0);
          for (const opt of result.outMessage.options) {
            expect(typeof opt.id).toBe('string');
            expect(typeof opt.title).toBe('string');
          }
        }
      }),
      { numRuns: 300 },
    );
  });

  test('nextStep は入力状態を変更しない（純粋性）', () => {
    fc.assert(
      fc.property(stateArb, inputArb, (state, input) => {
        const snapshot = JSON.stringify(state);
        nextStep(state, input);
        expect(JSON.stringify(state)).toBe(snapshot);
      }),
      { numRuns: 200 },
    );
  });

  test('完了状態への遷移は確定メッセージを返す', () => {
    // CONFIRM から confirm 入力で COMPLETED + CONFIRMATION になる
    const result = nextStep({ step: ConversationStep.CONFIRM }, 'confirm');
    expect(result.nextState.step).toBe(ConversationStep.COMPLETED);
    expect(result.outMessage.type).toBe(OutMessageType.CONFIRMATION);
  });

  test('SELECT_TIME で既知スロットを選ぶと reservationTime は Date 解析可能な値になる (要件 1.2)', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('day_1', 'day_2', 'day_3'),
        fc.constantFrom('slot_0900', 'slot_1030', 'slot_1400', 'slot_1530'),
        (dayId, slotId) => {
          const state = { step: ConversationStep.SELECT_TIME, selectedDate: dayId };
          const { nextState } = nextStep(state, { value: slotId });

          expect(nextState.step).toBe(ConversationStep.CONFIRM);
          expect(typeof nextState.reservationTime).toBe('string');
          const millis = new Date(nextState.reservationTime).getTime();
          expect(Number.isNaN(millis)).toBe(false);
        },
      ),
      { numRuns: 50 },
    );
  });
});
