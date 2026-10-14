/**
 * 公開アプリ URL の解決と検証
 *
 * 入室リンク（WhatsApp で配信される URL）は利用者の端末で開かれるため、
 * 開発者のマシン上の localhost には到達できません。Cloudflare トンネルや
 * デプロイ先の公開 URL を指す必要があります。
 *
 * このモジュールは次の 2 つを提供する:
 *  1) `resolvePublicAppUrl()` — 末尾スラッシュや空白を正規化した公開 URL
 *  2) `describePublicAppUrlProblem()` — 不正な設定の診断文言（起動時警告用）
 *
 * 環境変数 PUBLIC_APP_URL を読むのは config/env.js 側の責務で、ここでは
 * 値のみを受け取る（純粋関数でテストしやすい）ため。
 *
 * @module config/publicAppUrl
 */

/** ローカルループバックは「公開」された URL ではない。 */
const LOCAL_HOSTNAME_PATTERN = /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)$/i;

/**
 * 値がローカルループバックを指しているかを判定する（ポート・パスは無視）。
 * @param {string} value
 * @returns {boolean}
 */
function isLocalHostname(value) {
  let hostname;
  try {
    hostname = new URL(value).hostname;
  } catch {
    // URL として解釈できない場合は判定不能なので「ローカルではない」とみなす
    // （不正である旨は別メッセージで出す）。
    return false;
  }
  return LOCAL_HOSTNAME_PATTERN.test(hostname);
}

/**
 * 公開アプリ URL を正規化する。
 *
 * - 前後の空白を除去
 * - 末尾スラッシュを除去（buildJoinUrl が `/join/` を連結するため二重を避ける）
 * - 空文字はそのまま返す（呼び出し側で未設定として扱う）
 *
 * @param {string} value 生の環境変数値
 * @returns {string}
 */
export function resolvePublicAppUrl(value) {
  return String(value ?? '').trim().replace(/\/+$/, '');
}

/**
 * 公開アプリ URL の設定問題を診断し、人が読む文言を返す。
 *
 * 検出する問題:
 *  - 未設定（空）
 *  - URL として解釈できない
 *  - http / https 以外のスキーム
 *  - localhost / 127.0.0.1 などのループバック（利用者の端末から到達できない）
 *
 * @param {string} value 生の環境変数値
 * @returns {string} 問題がなければ空文字
 */
export function describePublicAppUrlProblem(value) {
  const normalized = resolvePublicAppUrl(value);

  if (!normalized) {
    return (
      'PUBLIC_APP_URL が未設定です。入室リンクが localhost を指し、' +
      '利用者の端末から到達できません。' +
      'テストなら Cloudflare トンネルの URL (https://xxx.trycloudflare.com)、' +
      '本番ならデプロイ先の公開 URL を設定してください。'
    );
  }

  let parsed;
  try {
    parsed = new URL(normalized);
  } catch {
    return (
      `PUBLIC_APP_URL が URL として解釈できません: ${normalized}。` +
      'https:// で始まる完全な公開 URL を設定してください。'
    );
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return (
      `PUBLIC_APP_URL のスキームが ${parsed.protocol} です。` +
      'https://（本番）または http:// を指定してください。'
    );
  }

  if (isLocalHostname(normalized)) {
    return (
      `PUBLIC_APP_URL がループバックを指しています: ${normalized}。` +
      '利用者の端末（スマホ）から到達できないため、' +
      'Cloudflare トンネルの URL (テスト) またはデプロイ先の公開 URL (本番) にしてください。'
    );
  }

  return '';
}
