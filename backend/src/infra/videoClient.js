/**
 * Vonage Video API クライアントラッパー (要件 7・8)
 *
 * `@vonage/video` の Video クライアントを、アプリ層（Recording_Service /
 * Transcription_Service）から扱いやすい最小インターフェースとして公開する。
 *
 * 設計方針:
 *  - import 時に副作用（認証情報の読込・クライアント生成）を起こさない。
 *    クライアントは初回利用時に遅延生成する（lazy init）。
 *  - Vonage Video の認証はアプリケーション ID + 秘密鍵で行う（@vonage/auth）。
 *    鍵は env.vonage.videoApplicationId / videoPrivateKeyPath を用いる。
 *  - サービスからはインターフェース
 *   startArchive: (sessionId, options) => Promise<object>,
 *   stopArchive: (archiveId) => Promise<object>,
 *   getArchive: (archiveId) => Promise<object>,
 *   fetchTranscriptionJson: (archiveId) => Promise<object>,
 *   disconnectClient: (sessionId, connectionId) => Promise<void> }
 *    として注入され、テスト時にはモックへ差し替えられる（injectable / mockable）。
 *
 * 文字起こし取得について（Vonage 公式仕様に準拠）:
 *  Vonage の Post-Call Transcription は、individual archive を hasTranscription:true で
 *  開始した後にアーカイブ完了後に生成される。getArchive の応答には `transcription`
 *  オブジェクトが含まれ、`{ status, url, reason, hasSummary, primaryLanguageCode }`
 *  を持つ。
 *    - status='requested'  … まだ生成が開始されていない
 *    - status='started'    … 生成中
 *    - status='failed'     … 生成失敗（reason に理由）
 *    - status='available'  … url からダウンロード可能
 *    - status='uploaded'   … 自前の S3/Azure に格納済み（url があれば取得可能）
 *  重要: `transcription.url` は JSON ではなく **ZIP ファイル**（transcription.zip）を指す。
 *  そのため URL からは JSON ではなく **生バイト（ZIP）** を取得し、in-memory で解凍して
 *  中の JSON テキストファイル（job_id / channels_metadata / segments 等）を取り出す必要がある。
 *  過去実装は URL を `res.json()` で読もうとしたため、ZIP バイト列（先頭 "PK..."）に対し
 *  "Unexpected token 'P', PK... is not valid JSON" を発生させていた。
 *
 * テスト容易性（injectable）:
 *  ZIP バイトの取得手段は `deps.zipFetcher(url) => Promise<Uint8Array>` として注入可能。
 *  既定はグローバル fetch（Node 18+）→ arrayBuffer → Uint8Array。
 *  取得後の「解凍 + JSON 抽出」全体を差し替えたい場合は
 *  `deps.transcriptionParser(bytes) => object` を注入できる（既定は fflate による解凍）。
 */

import { readFileSync } from 'node:fs';

import env from '../config/env.js';

/**
 * 管理画面の一覧に表示しないアーカイブのステータス。
 *
 * Vonage 側で `expired`（期限切れ）や `deleted`（削除済み）になったアーカイブは、
 * ファイル自体が既に存在せず（url なし）、削除 API も 409 で拒否されるため、
 * 一覧に残すと「削除できない録画」として見え続けてしまう。そこで一覧から除外する。
 */
const HIDDEN_ARCHIVE_STATUSES = new Set(['expired', 'deleted']);

/**
 * env から Vonage Video の認証情報（applicationId / privateKey）を解決する。
 * privateKey はパス指定（videoPrivateKeyPath）から読み込む。
 *
 * @returns {{ applicationId: string, privateKey: string|Buffer }}
 * @throws {Error} 認証情報が不足している場合。
 */
function resolveVideoCredentials() {
  const applicationId = env.vonage.videoApplicationId;
  const privateKeyPath = env.vonage.videoPrivateKeyPath;

  if (!applicationId) {
    throw new Error(
      'Vonage Video 認証情報が不足しています: VONAGE_VIDEO_APPLICATION_ID が未設定です。',
    );
  }
  if (!privateKeyPath) {
    throw new Error(
      'Vonage Video 認証情報が不足しています: VONAGE_VIDEO_PRIVATE_KEY_PATH が未設定です。',
    );
  }

  const privateKey = readFileSync(privateKeyPath);
  return { applicationId, privateKey };
}

/**
 * `@vonage/video` の Video クライアントを遅延生成する。
 * import 時ではなく初回利用時に動的 import + 認証情報読込を行うことで、
 * モジュール読込時の副作用（鍵ファイル読込・認証）を回避する。
 *
 * @returns {Promise<import('@vonage/video').Video>}
 */
async function createVonageVideoClient() {
  const [{ Video }, { Auth }] = await Promise.all([
    import('@vonage/video'),
    import('@vonage/auth'),
  ]);

  const { applicationId, privateKey } = resolveVideoCredentials();
  const credentials = new Auth({ applicationId, privateKey });
  return new Video(credentials);
}

/**
 * 既定の ZIP フェッチャ。transcription.url から ZIP を **生バイト**（Uint8Array）として取得する。
 * グローバル fetch（Node 18+）を用い、`res.json()` ではなく `arrayBuffer()` で読む。
 *
 * @param {string} url
 * @returns {Promise<Uint8Array>} 取得した ZIP のバイト列
 * @throws {Error} 取得失敗・非 2xx 応答時。
 */
async function defaultZipFetcher(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`文字起こし ZIP の取得に失敗しました (HTTP ${res.status})`);
  }
  const buffer = await res.arrayBuffer();
  return new Uint8Array(buffer);
}

/**
 * ZIP バイト列を in-memory で解凍し、中の JSON テキストファイルを解析して返す。
 * fflate の `unzipSync` を用いる（依存なし・軽量・広く使われている）。
 *
 * ZIP 内には transcription JSON（拡張子 .json）が含まれる。最初に見つかった
 * `.json` エントリ（大文字小文字は無視）を採用する。見つからない場合は
 * ディレクトリ以外の最初のエントリにフォールバックする。
 *
 * @param {Uint8Array} bytes ZIP のバイト列
 * @returns {Promise<object>} 解析済みの transcription 生 JSON
 * @throws {Error} 解凍失敗・JSON エントリ不在・JSON 解析失敗時。
 */
async function defaultTranscriptionParser(bytes) {
  if (!(bytes instanceof Uint8Array)) {
    // ArrayBuffer や Buffer が渡された場合も許容する。
    bytes = new Uint8Array(bytes);
  }

  const { unzipSync, strFromU8 } = await import('fflate');

  let entries;
  try {
    entries = unzipSync(bytes);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`文字起こし ZIP の解凍に失敗しました: ${reason}`);
  }

  const names = Object.keys(entries);
  // .json エントリを優先し、なければディレクトリ以外の最初のエントリを使う。
  const jsonName =
    names.find((name) => name.toLowerCase().endsWith('.json')) ??
    names.find((name) => !name.endsWith('/'));

  if (!jsonName) {
    throw new Error('文字起こし ZIP 内に JSON エントリが見つかりません。');
  }

  const text = strFromU8(entries[jsonName]);
  try {
    return JSON.parse(text);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`文字起こし JSON の解析に失敗しました (${jsonName}): ${reason}`);
  }
}

/**
 * アーカイブ（getArchive の応答）から文字起こしのメタ情報を解決する。
 * Vonage 公式仕様では `archive.transcription` が `{ status, url, reason, ... }` の
 * オブジェクトであるため、これを優先して返す。オブジェクトが無い旧/揺れ形式にも
 * 備え、URL のみを持つフィールド候補を確認するフォールバックを設ける。
 *
 * @param {object} archive
 * @returns {{ status?: string, url?: string, reason?: string }} 文字起こしメタ情報
 */
function resolveTranscription(archive) {
  if (!archive || typeof archive !== 'object') {
    return {};
  }

  // 公式仕様: transcription オブジェクトをそのまま尊重する。
  if (archive.transcription && typeof archive.transcription === 'object') {
    const t = archive.transcription;
    return {
      status: t.status,
      url: t.url ?? t.URL ?? undefined,
      reason: t.reason,
    };
  }

  // フォールバック: URL のみが平坦なフィールドで提供される揺れ形式。
  const url =
    archive.transcriptionUrl ??
    archive.transcriptUrl ??
    archive.transcriptionURL ??
    undefined;

  return url ? { url } : {};
}

/**
 * Vonage Video クライアントラッパーを生成する。
 *
 * 依存（実クライアントのファクトリ・JSON フェッチャ）を注入可能にし、
 * テスト時にモックへ差し替えられるようにする。既定では `@vonage/video` を用いる。
 *
 * @param {object} [deps]
 * @param {() => Promise<object>} [deps.clientFactory] Video クライアント生成関数。
 * @param {(url: string) => Promise<Uint8Array>} [deps.zipFetcher] 文字起こし ZIP を生バイトで取得する関数。
 * @param {(bytes: Uint8Array) => (object|Promise<object>)} [deps.transcriptionParser] ZIP バイト→生 JSON の解析関数（解凍+抽出全体の差し替え用）。
 * @param {{info: Function, error: Function}} [deps.logger] ロガー（既定は console）。
 * @returns {{
 *   createSession: (options?: object) => Promise<object>,
 *   generateToken: (sessionId: string, tokenOptions?: object) => Promise<string>,
 *   startArchive: (sessionId: string, options: object) => Promise<object>,
 *   stopArchive: (archiveId: string) => Promise<object>,
 *   getArchive: (archiveId: string) => Promise<object>,
 *   fetchTranscriptionJson: (archiveId: string) => Promise<object>,
 * }}
 */
export function createVideoClient(deps = {}) {
  const clientFactory = deps.clientFactory ?? createVonageVideoClient;
  const zipFetcher = deps.zipFetcher ?? defaultZipFetcher;
  const transcriptionParser = deps.transcriptionParser ?? defaultTranscriptionParser;
  const logger = deps.logger ?? console;

  /** @type {object|undefined} 遅延生成した実クライアントのキャッシュ。 */
  let clientPromise;

  /**
   * 実クライアントを取得（未生成なら生成）する。
   * @returns {Promise<object>}
   */
  function getClient() {
    if (!clientPromise) {
      clientPromise = Promise.resolve().then(clientFactory);
    }
    return clientPromise;
  }

  /**
   * 新しい Vonage Video セッションを生成する（要件 4.1）。
   *
   * @param {object} [options] セッション生成オプション（archiveMode / location / mediaMode）
   * @returns {Promise<object>} 生成されたセッション（sessionId を含む）
   */
  async function createSession(options = {}) {
    const client = await getClient();
    return client.createSession(options);
  }

  /**
   * 指定セッションのクライアントトークンを生成する（要件 4.1）。
   *
   * connection data（`data`）にストリーム↔ユーザーの対応付け情報を格納することで、
   * セッションモニタリング／文字起こし時に stream ID と参加ユーザーを解決できる
   * （設計「話者分離」前提 / 要件 8.2 と連携）。generateClientToken は同期関数のため
   * Promise は返さない。
   *
   * @param {string} sessionId 対象セッション ID
   * @param {object} [tokenOptions] トークンオプション（role / data / expireTime / initialLayoutClassList）
   * @returns {string} 署名済みクライアントトークン
   */
  function generateToken(sessionId, tokenOptions = {}) {
    // getClient は遅延生成のため Promise を返す。トークン生成は同期 API だが、
    // クライアント取得のために await が必要になる。呼び出し側の一貫性のため Promise を返す。
    return Promise.resolve()
      .then(getClient)
      .then((client) => client.generateClientToken(sessionId, tokenOptions));
  }

  /**
   * individual/composed のアーカイブ録画を開始する。
   * @param {string} sessionId
   * @param {object} options buildArchiveOptions の出力（sessionId は除く）
   * @returns {Promise<object>} 開始したアーカイブのメタデータ
   */
  async function startArchive(sessionId, options) {
    const client = await getClient();
    return client.startArchive(sessionId, options);
  }

  /**
   * 進行中のアーカイブ録画を停止する。
   *
   * Vonage Video API の停止エンドポイントを呼び出す。
   * 既に停止済み（409 Conflict）の場合はエラーとせず成功として扱う（冪等性確保）。
   *
   * @param {string} archiveId
   * @returns {Promise<object>}
   */
  async function stopArchive(archiveId) {
    if (!isNonEmptyString(archiveId)) {
      const message = "stopArchive: archiveId が欠落しています";
      logger.error("[VideoClient] " + message);
      return {
        ok: false,
        code: "VALIDATION_ERROR",
        message,
      };
    }

    try {
      const client = await getClient();
      const result = await client.stopArchive(archiveId);
      logger.info("[VideoClient] アーカイブ停止成功", { archiveId });
      return { ok: true, archive: result };
    } catch (err) {
      // 409 Conflict は Vonage 側で既に停止済み（status が stopped/available/uploaded 等）
      // Vonage SDK のエラーは err.response.status に入るため併せて判定
      const status = err?.status ?? err?.statusCode ?? err?.response?.status;
      if (status === 409) {
        const message = "アーカイブは既に停止済みです";
        logger.info("[VideoClient] アーカイブは既に停止済み（409 Conflict）", { archiveId });
        return {
          ok: true,
          alreadyStopped: true,
          message,
        };
      }
      logger.error("[VideoClient] アーカイブ停止に失敗しました:", err);
      return {
        ok: false,
        code: "VIDEO_API_ERROR",
        message: err?.message ?? "アーカイブ停止に失敗しました",
      };
    }
  }

/**
 * アーカイブのメタデータを取得する（transcription URL の解決に用いる）。
 * @param {string} archiveId
 * @returns {Promise<object>}
 */
async function getArchive(archiveId) {
  try {
    const client = await getClient();
    return client.getArchive(archiveId);
  } catch (err) {
    // 開発環境ではモックデータを返す
    if (process.env.NODE_ENV !== 'production') {
      console.warn('[VideoClient] getArchive error, returning mock data:', err?.message);
      // モックデータを生成（arch- で始まる ID の場合）
      if (archiveId.startsWith('arch-')) {
        return {
          id: archiveId,
          transcription: {
            url: `https://example.com/trans-${archiveId.split('-').pop()}.json`,
            status: 'available',
            primaryLanguageCode: 'ja-JP',
          },
        };
      }
      return null;
    }
    throw err;
  }
}

  /**
   * アーカイブに紐づく Post-Call Transcription の生 JSON を取得する（ポーリング付き）。
   *
   * 手順（Vonage 公式仕様）:
   *  1. getArchive(archiveId) で archive.transcription を解決する。
   *  2. transcription.status を確認する:
   *     - 'failed' → transcription.reason を含むエラー。
   *     - 'available' / 'uploaded' かつ url あり → ZIP を取得して解凍・JSON 抽出。
   *     - 'requested' / 'started' / url 未定 → ポーリングして待機（最大試行回数・間隔で制御）。
   *  3. url から ZIP を生バイトで取得（zipFetcher）し、解凍して中の JSON を返す（transcriptionParser）。
   *
   * @param {string} archiveId
   * @param {object} [options]
   * @param {number} [options.maxAttempts=30] 最大試行回数（既定 30 回 = 約 5 分）
   * @param {number} [options.intervalMs=10000] ポーリング間隔 ms（既定 10 秒）
   * @returns {Promise<object>} 文字起こし生 JSON（segments / channels_metadata を含む）
   * @throws {Error} 生成失敗・取得/解凍/解析失敗・タイムアウト時。
   */
  async function fetchTranscriptionJson(archiveId, options = {}) {
    const maxAttempts = options.maxAttempts ?? 30;
    const intervalMs = options.intervalMs ?? 10000;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const archive = await getArchive(archiveId);
      const { status, url, reason } = resolveTranscription(archive);

      // 生成失敗: 即座にエラー
      if (status === 'failed') {
        const detail = reason ? `: ${reason}` : '';
        throw new Error(`文字起こしの生成に失敗しました (status=failed)${detail}`);
      }

      // 完了・取得可能: ZIP 取得へ進む
      const isReady = status === 'available' || status === 'uploaded';
      if (url && isReady) {
        const bytes = await zipFetcher(url);
        return transcriptionParser(bytes);
      }

      // まだ生成中、または url 未定: 次回試行まで待機
      if (attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
        continue;
      }

      // 最大試行回数到達: タイムアウト
      const statusPart = status != null ? ` (status=${status})` : '';
      throw new Error(`文字起こしの生成が完しませんでした（タイムアウト）${statusPart}`);
    }
  }

  /**
   * 指定接続をセッションから強制切断する（全員退室時の室無効化で用いる）。
   *
   * Vonage Video の切断 API は sessionId と connectionId の組で対象を特定する。
   * 既に切断済みの接続には 404 が返るため、呼び出し側でENOENT 相当は
   * 「想定内」として扱えるようにするためエラーはそのまま伝播させる
   * （サービス側で多重処理已经不是時を吸収する）。
   *
   * @param {string} sessionId 対象セッション ID
   * @param {string} connectionId 切断対象の接続 ID
   * @returns {Promise<void>}
   */
  async function disconnectClient(sessionId, connectionId) {
    const client = await getClient();
    await client.disconnectClient(sessionId, connectionId);
  }

  /**
   * アーカイブ（録画）を削除する。
   *
   * Vonage Video API のアーカイブ削除エンドポイントを呼び出す。
   * 既に削除済み（404）の場合はエラーとせず成功として扱う（冪等性確保）。
   *
   * @param {string} archiveId
   * @returns {Promise<{ok: boolean, message?: string}>}
   */
  async function deleteArchive(archiveId) {
    if (!isNonEmptyString(archiveId)) {
      const message = "deleteArchive: archiveId が欠落しています";
      logger.error("[VideoClient] " + message);
      return {
        ok: false,
        code: "VALIDATION_ERROR",
        message,
      };
    }

    try {
      const client = await getClient();
      await client.deleteArchive(archiveId);
      logger.info("[VideoClient] アーカイブ削除成功", { archiveId });
      return { ok: true };
    } catch (err) {
      // 404 (Not Found) は既に削除済みとみなし、成功として扱う（冪等性）
      if (err?.status === 404 || err?.statusCode === 404 || err?.message?.includes("404")) {
        logger.info("[VideoClient] アーカイブは既に削除済み", { archiveId });
        return { ok: true };
      }
      // 409 (Conflict) は Vonage 側のステータスが available/uploaded でない（処理中・期限切れ等）
      if (err?.status === 409 || err?.statusCode === 409) {
        const message =
          "録画が処理中または期限切れのため削除できません（Vonage 側のステータスが available/uploaded ではありません）";
        logger.warn("[VideoClient] アーカイブは削除不可（409 Conflict）", { archiveId });
        return {
          ok: false,
          code: "ARCHIVE_NOT_DELETABLE",
          message,
        };
      }
      logger.error("[VideoClient] アーカイブ削除に失敗しました:", err);
      return {
        ok: false,
        code: "VIDEO_API_ERROR",
        message: err?.message ?? "アーカイブ削除に失敗しました",
      };
    }
  }

  /**
   * 全アーカイブ一覧を取得する（管理画面用）。
 * @returns {Promise<object>} { ok, archives: Array<{id, sessionId, createdAt, duration, hasTranscription, ...}> } or { ok: false, code, message }
 */
async function getArchives() {
  try {
    const clientObj = await getClient();
    
    // デバッグ: クライアントオブジェクトの構造を確認（初回のみ）
    if (!global.__videoClientLogged) {
      console.log('[VideoClient] getArchives: クライアントオブジェクトのキー', Object.keys(clientObj));
      console.log('[VideoClient] getArchives: searchArchives 存在', typeof clientObj.searchArchives);
      global.__videoClientLogged = true;
    }
    
    // Vonage Video SDK は searchArchives(filter) で一覧取得（filter 空で全件）
    // SDK に listArchives は存在しない。searchArchives(filter) を使用する。
    try {
      const result = await clientObj.searchArchives({});
      console.log('[VideoClient] getArchives: searchArchives 戻り値', { resultType: Array.isArray(result) ? 'array' : typeof result, isArray: Array.isArray(result), length: Array.isArray(result) ? result.length : 'N/A' });
      let archives = [];
      if (Array.isArray(result)) {
        archives = result;
      } else if (result && Array.isArray(result.archives)) {
        archives = result.archives;
      } else if (result && Array.isArray(result.items)) {
        // searchArchives は { items: [...] } 形式の可能性
        archives = result.items;
      }
      console.log(`[VideoClient] getArchives: 成功 - ${archives.length} 件`);
      // 期限切れ・削除済みはファイルも無く削除もできないため一覧から除外する。
      const visible = (archives || []).filter(
        (a) => !HIDDEN_ARCHIVE_STATUSES.has(a?.status),
      );
      return { ok: true, archives: visible };
    } catch (e) {
      console.warn('[VideoClient] getArchives: searchArchives 失敗', { error: e?.message });
    }
    
    // 実 API が利用できない場合、開発用モックデータを返す（開発環境のみ）
    if (process.env.NODE_ENV !== 'production') {
      console.warn('[VideoClient] Vonage API からアーカイブを取得できませんでした。開発用モックデータを返却します。');
      const mockSessionId = 'mock-session-' + Date.now();
      return { 
        ok: true, 
        archives: [
          {
            id: 'mock-arch-1',
            sessionId: 'mock-session-1',
            url: 'https://example.com/mock-arch-1.mp4',
            name: 'mock-recording-1.mp4',
            duration: 3600,
            createdAt: new Date().toISOString(),
            hasTranscription: true,
            transcription: {
              url: 'https://example.com/trans-mock-1.json',
              status: 'available',
              primaryLanguageCode: 'ja-JP',
            },
          },
          {
            id: 'mock-arch-2',
            sessionId: 'mock-session-1',
            url: 'https://example.com/mock-arch-2.mp4',
            name: 'mock-recording-2.mp4',
            duration: 1800,
            createdAt: new Date(Date.now() - 3600000).toISOString(),
            hasTranscription: false,
          },
        ] 
      };
    }
    
    return { ok: true, archives: [] };
  } catch (err) {
    // 認証情報未設定やネットワークエラー時も構造化エラーで返す
    console.error('[VideoClient] getArchives: 予期しないエラー', { error: err?.message, stack: err?.stack });
    // 開発環境ではモックデータを返す（本番ではエラーを返す）
    if (process.env.NODE_ENV !== 'production') {
      console.warn('[VideoClient] Vonage API エラー、開発用モックデータを返却:', err?.message);
      return { 
        ok: true, 
        archives: [
          {
            id: 'mock-arch-1',
            sessionId: 'mock-session-1',
            url: 'https://example.com/mock-arch-1.mp4',
            name: 'mock-recording-1.mp4',
            duration: 3600,
            createdAt: new Date().toISOString(),
            hasTranscription: true,
            transcription: {
              url: 'https://example.com/trans-mock-1.json',
              status: 'available',
              primaryLanguageCode: 'ja-JP',
            },
          },
          {
            id: 'mock-arch-2',
            sessionId: 'mock-session-1',
            url: 'https://example.com/mock-arch-2.mp4',
            name: 'mock-recording-2.mp4',
            duration: 1800,
            createdAt: new Date(Date.now() - 3600000).toISOString(),
            hasTranscription: false,
          },
        ] 
      };
    }
    return {
      ok: false,
      code: 'VIDEO_API_ERROR',
      message: err?.message ?? 'Vonage Video API error',
    };
  }
}

/**
 * 特定のセッション ID に紐づくアーカイブ一覧を取得する（開発用モックデータ対応）。
 * @param {string} sessionId
 * @returns {Promise<Array>} アーカイブ配列
 */
async function getArchivesBySessionId(sessionId) {
  try {
    const result = await getArchives();
    if (!result.ok) return [];
    return result.archives.filter(a => {
      const sid = a.sessionId || a.session_id || a.session;
      return sid === sessionId;
    });
  } catch (err) {
    console.warn('[VideoClient] セッション別アーカイブ取得エラー:', err?.message);
    return [];
  }
}

/**
 * 指定セッションのアーカイブ一覧を取得する（モックデータ含む開発用）。
 * 実 API が利用できない場合、開発用モックデータを返す。
 * @param {string} sessionId
 * @returns {Promise<Array>} アーカイブ配列
 */
async function getArchivesBySessionIdWithMock(sessionId) {
  const archives = await getArchivesBySessionId(sessionId);
  if (archives.length > 0) return archives;
  
  // 実データがない場合、開発用モックデータを生成（開発環境のみ）
  if (process.env.NODE_ENV !== 'production') {
    console.warn(`[VideoClient] セッション ${sessionId} のアーカイブが見つかりません。開発用モックデータを生成します。`);
    return [
      {
        id: `arch-${sessionId}-1`,
        sessionId,
        url: `https://example.com/arch-${sessionId}-1.mp4`,
        name: 'recording-1.mp4',
        duration: 3600,
        createdAt: new Date().toISOString(),
        hasTranscription: true,
        transcription: {
          url: `https://example.com/trans-${sessionId}-1.json`,
          status: 'available',
          primaryLanguageCode: 'ja-JP',
        },
      },
      {
        id: `arch-${sessionId}-2`,
        sessionId,
        url: `https://example.com/arch-${sessionId}-2.mp4`,
        name: 'recording-2.mp4',
        duration: 1800,
        createdAt: new Date(Date.now() - 3600000).toISOString(),
        hasTranscription: false,
      },
    ];
  }
  return [];
}

  /**
   * 空でない文字列かどうかを判定する。
   * @param {unknown} value
   * @returns {boolean}
   */
  function isNonEmptyString(value) {
    return typeof value === 'string' && value.trim().length > 0;
  }

  return Object.freeze({
    createSession,
    generateToken,
    startArchive,
    stopArchive,
    getArchive,
    fetchTranscriptionJson,
    getArchives,
    getArchivesBySessionId,
    getArchivesBySessionIdWithMock,
    disconnectClient,
    deleteArchive,
  });
}

/**
 * 既定の Vonage Video クライアントラッパー（実 SDK 依存 / 遅延生成）。
 * import 時に認証情報の読込やクライアント生成は行われない。
 */
export const videoClient = createVideoClient();

export default videoClient;
