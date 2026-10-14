import { describe, it, expect } from 'vitest';
import {
  BACKGROUND_SKINS,
  DEFAULT_SKIN_ID,
  TELEMEDICINE_SKIN_ID,
  getSkin,
  applyBackgroundSkin,
} from './backgroundSkins.js';

/**
 * タスク 16.4 / 要件 4.3: 背景スキン選択適用のユニットテスト。
 * applyBackgroundSkin(skinId, element) が選択スキン（telemedicine を含む）を
 * 通話画面要素へ適用することを検証する。
 */
describe('backgroundSkins (要件 4.3)', () => {
  it('スキン集合に病院遠隔診療（telemedicine）テーマを含む', () => {
    expect(TELEMEDICINE_SKIN_ID).toBe('telemedicine');
    const ids = BACKGROUND_SKINS.map((s) => s.id);
    expect(ids).toContain('telemedicine');
    // 既定スキンも含まれる。
    expect(ids).toContain(DEFAULT_SKIN_ID);
  });

  it('telemedicine スキンを選択すると要素へ背景とデータ属性が適用される', () => {
    const element = document.createElement('div');
    const applied = applyBackgroundSkin(TELEMEDICINE_SKIN_ID, element);

    expect(applied.id).toBe('telemedicine');
    expect(element.getAttribute('data-skin')).toBe('telemedicine');
    // telemedicine の背景（ティール/ホワイト系グラデーション）が適用される。
    const telemedicine = BACKGROUND_SKINS.find((s) => s.id === 'telemedicine');
    expect(element.style.background).toBe(telemedicine.background);
    // オーバーレイ CSS 変数が設定される。
    expect(element.style.getPropertyValue('--call-skin-overlay')).toBe(
      telemedicine.overlay,
    );
  });

  it('任意の定義済みスキンを選択すると対応する背景が適用される', () => {
    const element = document.createElement('div');
    const office = applyBackgroundSkin('office', element);
    expect(office.id).toBe('office');
    expect(element.getAttribute('data-skin')).toBe('office');
    expect(element.style.background).toBe(
      BACKGROUND_SKINS.find((s) => s.id === 'office').background,
    );
  });

  it('未知の skinId の場合は既定スキンを適用する', () => {
    const element = document.createElement('div');
    const applied = applyBackgroundSkin('does-not-exist', element);
    expect(applied.id).toBe(DEFAULT_SKIN_ID);
    expect(element.getAttribute('data-skin')).toBe(DEFAULT_SKIN_ID);
  });

  it('要素未指定でも副作用なくスキンを解決して返す', () => {
    expect(() => applyBackgroundSkin(TELEMEDICINE_SKIN_ID)).not.toThrow();
    const applied = applyBackgroundSkin(TELEMEDICINE_SKIN_ID);
    expect(applied.id).toBe('telemedicine');
  });

  it('getSkin は既知 ID を返し未知 ID では既定にフォールバックする', () => {
    expect(getSkin('telemedicine').id).toBe('telemedicine');
    expect(getSkin('nope').id).toBe(DEFAULT_SKIN_ID);
  });
});
