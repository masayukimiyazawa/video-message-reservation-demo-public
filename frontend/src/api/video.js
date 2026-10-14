/**
 * Vonage Video Client SDK 初期化ラッパー（タスク 15.1 / 要件 4.1）。
 *
 * `@vonage/client-sdk-video` を遅延ロードして初期化する薄いモジュール。
 * 実際の publish/subscribe や UI 配線は後続タスク 16（Video_Call_UI）で行う。
 * ここではセッション初期化と接続の土台のみを提供する。
 */

let videoSdkPromise = null;

/**
 * SDK を遅延ロードする。バンドル初期ロードを軽くするため動的 import を用いる。
 * @returns {Promise<typeof import('@vonage/client-sdk-video')>}
 */
export function loadVideoSdk() {
  if (!videoSdkPromise) {
    videoSdkPromise = import('@vonage/client-sdk-video');
  }
  return videoSdkPromise;
}

/**
 * Vonage Video セッションを初期化する。
 *
 * 第 1 引数は SDK 内部では `partnerId` として扱われ、
 * `https://config.opentok.com/project/{partnerId}/config.json` を引いて
 * 接続先 API ホスト（含意するセッション情報）を決める。
 * Vonage Video アプリケーション（Unified）で作られたセッションの
 * partnerId は **アプリケーション ID（UUID）** であり、8 文字の API キーを
 * 渡すと接続先が解決できず接続に失敗する。
 *
 * @param {string} applicationId Vonage Video アプリケーション ID（UUID）
 * @param {string} sessionId セッション ID
 * @returns {Promise<import('@vonage/client-sdk-video').Session>}
 */
export async function initSession(applicationId, sessionId) {
  const OT = await loadVideoSdk();
  return OT.initSession(applicationId, sessionId);
}

/**
 * セッションへ接続する。接続失敗時は reject する（要件 4.4 の再接続 UI 側で処理）。
 * @param {import('@vonage/client-sdk-video').Session} session
 * @param {string} token セッショントークン（バックエンド `/sessions/:id/token` で発行）
 * @returns {Promise<import('@vonage/client-sdk-video').Session>}
 */
export function connectSession(session, token) {
  return new Promise((resolve, reject) => {
    session.connect(token, (error) => {
      if (error) {
        reject(error);
      } else {
        resolve(session);
      }
    });
  });
}

/**
 * Publisher を生成する（映像・音声送信）。後続タスク 16 で利用。
 * @param {HTMLElement|string} targetElement
 * @param {import('@vonage/client-sdk-video').PublisherProperties} [properties]
 * @returns {Promise<import('@vonage/client-sdk-video').Publisher>}
 */
export async function initPublisher(targetElement, properties = {}) {
  const OT = await loadVideoSdk();
  return new Promise((resolve, reject) => {
    const publisher = OT.initPublisher(targetElement, properties, (error) => {
      if (error) {
        reject(error);
      } else {
        resolve(publisher);
      }
    });
  });
}

/**
 * 画面共有用の Publisher を生成する（管理者のドキュメント/画面共有 / 要件 4.x）。
 *
 * `videoSource: 'screen'` を指定すると Vonage/OpenTok の画面共有モードになり、
 * ブラウザ標準の「画面 / ウィンドウ / タブ」選択ダイアログが起動する（ユーザー操作が必須）。
 * 画面共有では既定で音声を送らない（publishAudio:false）。呼び出し側で上書き可能。
 * 既存 `initPublisher` と同様に Promise でラップし、成功で resolve・失敗で reject する。
 * @param {HTMLElement|string} targetElement 画面共有のローカル表示先（管理者用の小さなインジケータ等）
 * @param {import('@vonage/client-sdk-video').PublisherProperties} [properties]
 * @returns {Promise<import('@vonage/client-sdk-video').Publisher>}
 */
export async function initScreenPublisher(targetElement, properties = {}) {
  const OT = await loadVideoSdk();
  return new Promise((resolve, reject) => {
    const publisher = OT.initPublisher(
      targetElement,
      {
        // 画面共有: ブラウザの画面/ウィンドウ/タブ選択ダイアログを起動する。
        videoSource: 'screen',
        // 画面共有では既定で音声を送信しない（呼び出し側で上書き可）。
        publishAudio: false,
        ...properties,
      },
      (error) => {
        if (error) {
          reject(error);
        } else {
          resolve(publisher);
        }
      },
    );
  });
}

export default {
  loadVideoSdk,
  initSession,
  connectSession,
  initPublisher,
  initScreenPublisher,
};
