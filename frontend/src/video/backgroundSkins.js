/**
 * 背景スキン定義と適用ロジック（タスク 16.2 / 要件 4.3）。
 *
 * ビデオ通話画面に適用できる背景スキン集合を定義し、`applyBackgroundSkin(skinId)`
 * で選択されたスキンを通話画面ルート要素に適用する。スキン集合には病院遠隔診療
 * （telemedicine）テーマを必ず含む。
 *
 * 背景はネットワーク画像に依存しないよう、CSS グラデーション（`background` 値）で
 * 表現する。各スキンは通話画面上のクラス `.call-stage` に対して `background` を
 * 直接適用し、文字色などの補助トークンも設定する。
 */

/** 既定スキン ID（プレーンな暗色背景）。 */
export const DEFAULT_SKIN_ID = 'default';

/** 病院遠隔診療テーマの ID（要件 4.3 で必須）。 */
export const TELEMEDICINE_SKIN_ID = 'telemedicine';

/**
 * 定義済み背景スキン集合。
 * - `id`: 一意な識別子。i18n キー `call.skins.<id>` に対応。
 * - `background`: CSS `background` プロパティ値（グラデーション）。
 * - `overlay`: 映像タイル背後のオーバーレイ色（任意）。
 *
 * @type {ReadonlyArray<{ id: string, background: string, overlay?: string }>}
 */
export const BACKGROUND_SKINS = Object.freeze([
  {
    id: DEFAULT_SKIN_ID,
    background: 'radial-gradient(circle at 50% 20%, #2b2f3a 0%, #14161c 100%)',
    overlay: 'rgba(0, 0, 0, 0.25)',
  },
  {
    // 病院遠隔診療テーマ: 清潔感のあるティール/ホワイト系グラデーション。
    id: TELEMEDICINE_SKIN_ID,
    background:
      'linear-gradient(135deg, #e6f4f4 0%, #cfe9ec 45%, #a7d3d8 100%)',
    overlay: 'rgba(12, 74, 84, 0.18)',
  },
  {
    id: 'office',
    background: 'linear-gradient(160deg, #3a4256 0%, #232838 100%)',
    overlay: 'rgba(0, 0, 0, 0.3)',
  },
  {
    id: 'nature',
    background:
      'linear-gradient(135deg, #204d3b 0%, #2f7a52 50%, #6fb98f 100%)',
    overlay: 'rgba(0, 0, 0, 0.22)',
  },
]);

/** スキン ID → スキン定義の索引。 */
const SKIN_INDEX = Object.freeze(
  BACKGROUND_SKINS.reduce((acc, skin) => {
    acc[skin.id] = skin;
    return acc;
  }, {}),
);

/**
 * 指定 ID のスキン定義を取得する。未知の ID の場合は既定スキンを返す。
 * @param {string} skinId
 * @returns {{ id: string, background: string, overlay?: string }}
 */
export function getSkin(skinId) {
  return SKIN_INDEX[skinId] || SKIN_INDEX[DEFAULT_SKIN_ID];
}

/**
 * 選択された背景スキンを通話画面要素へ適用する（要件 4.3）。
 *
 * 与えられた要素に対して:
 *  - `data-skin` 属性にスキン ID を設定（CSS フックおよびテスト用）。
 *  - インライン `background` にスキンの背景値を設定。
 *  - CSS 変数 `--call-skin-overlay` にオーバーレイ色を設定。
 *
 * 未知の skinId が渡された場合は既定スキンを適用する。要素が未指定の場合は
 * 何もせず、解決したスキンだけを返す（副作用なしで呼び出し可能）。
 *
 * @param {string} skinId 適用するスキンの ID
 * @param {HTMLElement|null} [element] 適用先要素（通常は `.call-stage`）
 * @returns {{ id: string, background: string, overlay?: string }} 適用したスキン
 */
export function applyBackgroundSkin(skinId, element) {
  const skin = getSkin(skinId);

  if (element && element.style) {
    element.setAttribute('data-skin', skin.id);
    element.style.background = skin.background;
    if (skin.overlay) {
      element.style.setProperty('--call-skin-overlay', skin.overlay);
    } else {
      element.style.removeProperty('--call-skin-overlay');
    }
  }

  return skin;
}

export default {
  BACKGROUND_SKINS,
  DEFAULT_SKIN_ID,
  TELEMEDICINE_SKIN_ID,
  getSkin,
  applyBackgroundSkin,
};
