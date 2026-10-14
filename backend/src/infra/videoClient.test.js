/**
 * videoClient.fetchTranscriptionJson ユニットテスト（要件 8.2）
 *
 * Vonage Post-Call Transcription の取得は、getArchive で得た `transcription`
 * オブジェクトの status を判定し、'available'/'uploaded' かつ url がある場合のみ
 * URL から **ZIP を生バイトで** ダウンロードし、解凍して中の JSON を返す。
 *
 * 過去のバグ: URL を `res.json()` で読もうとして ZIP バイト（先頭 "PK..."）に対し
 * "Unexpected token 'P', PK... is not valid JSON" が発生していた。本テストは
 * ZIP を解凍して JSON を取り出す挙動と、status に応じたエラー分岐を検証する。
 *
 * 依存注入:
 *  - clientFactory: getArchive をモックした擬似クライアントを返す。
 *  - zipFetcher(url): in-memory の ZIP（fflate zipSync 生成）を返す。
 *  実 fflate による解凍・JSON 抽出はモックせず、実挙動を検証する。
 *
 * @module infra/videoClient.test
 */

import { zipSync, strToU8 } from 'fflate';

import { createVideoClient } from './videoClient.js';

/**
 * groupBySpeaker が期待する形（segments[].channel / channels_metadata[].id）の
 * 現実的な transcription 生 JSON。
 */
const RAW_TRANSCRIPTION = {
  job_id: 'job-123',
  timestamp: '2024-01-01T00:00:00Z',
  number_of_channels: 2,
  channels_metadata: [
    { id: 'stream-doctor', name: 'Dr. Smith' },
    { id: 'stream-patient', name: 'Patient' },
  ],
  segments: [
    { channel: 0, start: 0.0, end: 2.5, text: 'Hello.', formatted: 'Hello.', confidence: 0.98 },
    { channel: 1, start: 2.6, end: 5.0, text: 'Hi.', formatted: 'Hi.', confidence: 0.97 },
  ],
  raw_data: {},
};

/**
 * transcription 生 JSON を格納した in-memory ZIP（Uint8Array）を生成する。
 * @param {object} json
 * @param {string} [entryName]
 * @returns {Uint8Array}
 */
function makeTranscriptionZip(json, entryName = 'transcription.json') {
  return zipSync({ [entryName]: strToU8(JSON.stringify(json)) });
}

/**
 * getArchive をモックした擬似 Video クライアントを生成する clientFactory。
 * @param {object} archive getArchive が返すアーカイブメタ
 * @param {{ calls: object }} [spy]
 * @returns {() => Promise<object>}
 */
function makeClientFactory(archive, spy = { calls: {} }) {
  spy.calls.getArchive = [];
  return async () => ({
    async getArchive(archiveId) {
      spy.calls.getArchive.push(archiveId);
      return archive;
    },
  });
}

describe('videoClient.fetchTranscriptionJson (要件 8.2)', () => {
  test("status 'available' + url: ZIP をダウンロード・解凍して生 JSON を返す", async () => {
    const zip = makeTranscriptionZip(RAW_TRANSCRIPTION);
    const fetchedUrls = [];
    const zipFetcher = async (url) => {
      fetchedUrls.push(url);
      return zip;
    };

    const client = createVideoClient({
      clientFactory: makeClientFactory({
        id: 'archive-001',
        transcription: {
          status: 'available',
          url: 'https://example.com/transcription.zip',
        },
      }),
      zipFetcher,
    });

    const result = await client.fetchTranscriptionJson('archive-001');

    // ZIP フェッチャは transcription.url に対して呼ばれる。
    expect(fetchedUrls).toEqual(['https://example.com/transcription.zip']);

    // 解凍して得た JSON が groupBySpeaker 期待形（segments/channels_metadata）で返る。
    expect(result.job_id).toBe('job-123');
    expect(result.segments).toHaveLength(2);
    expect(result.segments[0].channel).toBe(0);
    expect(result.channels_metadata[0].id).toBe('stream-doctor');
  });

  test("status 'uploaded' + url: 同様に解凍して生 JSON を返す", async () => {
    const zip = makeTranscriptionZip(RAW_TRANSCRIPTION, 'nested/transcript.JSON');
    const client = createVideoClient({
      clientFactory: makeClientFactory({
        id: 'archive-002',
        transcription: { status: 'uploaded', url: 'https://example.com/t.zip' },
      }),
      zipFetcher: async () => zip,
    });

    const result = await client.fetchTranscriptionJson('archive-002');
    expect(result.segments).toHaveLength(2);
  });

  test("status 'requested': ポーリングで待機し、利用可能になるまで待つ", async () => {
    let getArchiveCalls = 0;
    const zip = makeTranscriptionZip(RAW_TRANSCRIPTION);
    const client = createVideoClient({
      clientFactory: async () => ({
        async getArchive() {
          getArchiveCalls++;
          if (getArchiveCalls < 3) {
            return { transcription: { status: 'requested' } };
          }
          return {
            transcription: { status: 'available', url: 'https://example.com/trans.zip' },
          };
        },
      }),
      zipFetcher: async () => makeTranscriptionZip(RAW_TRANSCRIPTION),
    });

    const result = await client.fetchTranscriptionJson('archive-003', { maxAttempts: 5, intervalMs: 10 });

    expect(result.job_id).toBe('job-123');
    expect(result.segments).toHaveLength(2);
  });

  test("status 'started': ポーリングで待機し、利用可能になるまで待つ", async () => {
    let getArchiveCalls = 0;
    const zip = makeTranscriptionZip(RAW_TRANSCRIPTION);
    const client = createVideoClient({
      clientFactory: async () => ({
        async getArchive() {
          getArchiveCalls++;
          if (getArchiveCalls < 2) {
            return { transcription: { status: 'started', url: 'https://example.com/t.zip' } };
          }
          return {
            transcription: { status: 'available', url: 'https://example.com/trans.zip' },
          };
        },
      }),
      zipFetcher: async () => makeTranscriptionZip(RAW_TRANSCRIPTION),
    });

    const result = await client.fetchTranscriptionJson('archive-004', { maxAttempts: 5, intervalMs: 10 });

    expect(result.job_id).toBe('job-123');
    expect(result.segments).toHaveLength(2);
  });

  test("status 'failed': reason を含むエラーを投げる（即座に失敗）", async () => {
    const client = createVideoClient({
      clientFactory: makeClientFactory({
        id: 'archive-005',
        transcription: { status: 'failed', reason: 'audio too short' },
      }),
      zipFetcher: async () => {
        throw new Error('should not fetch on failure');
      },
    });

    await expect(client.fetchTranscriptionJson('archive-005')).rejects.toThrow(
      /生成に失敗しました.*audio too short/,
    );
  });

  test('transcription オブジェクト・url が無い: ポーリング後にタイムアウト', async () => {
    const client = createVideoClient({
      clientFactory: makeClientFactory({ id: 'archive-006' }),
      zipFetcher: async () => {
        throw new Error('should not fetch when url absent');
      },
    });

    await expect(client.fetchTranscriptionJson('archive-006', { maxAttempts: 2, intervalMs: 10 })).rejects.toThrow(
      /タイムアウト/,
    );
  });
});

describe('infra videoClient disconnectClient（接続の強制切断）', () => {
  /** disconnectClient を記録する擬似 Video クライアントの clientFactory。 */
  function makeDisconnectFactory(spy = { calls: [] }) {
    return async () => ({
      disconnectClient: async (sessionId, connectionId) => {
        spy.calls.push({ sessionId, connectionId });
      },
    });
  }

  test('sessionId と connectionId をそのまま SDK へ渡す', async () => {
    const spy = { calls: [] };
    const client = createVideoClient({ clientFactory: makeDisconnectFactory(spy) });

    await client.disconnectClient('2_MX4-session', 'conn-abc');

    expect(spy.calls).toEqual([{ sessionId: '2_MX4-session', connectionId: 'conn-abc' }]);
  });

  test('切断に失敗したらエラーを伝播させる（多重処理已经不是側で開く）', async () => {
    const client = createVideoClient({
      clientFactory: async () => ({
        disconnectClient: async () => {
          throw new Error('404 connection not found');
        },
      }),
    });

    await expect(client.disconnectClient('s', 'c')).rejects.toThrow(/404/);
  });
});

describe('infra videoClient getArchives（期限切れ・削除済みの除外）', () => {
  /** searchArchives をモックした擬似 Video クライアントの clientFactory。 */
  function makeArchivesFactory(archives) {
    return async () => ({
      async searchArchives() {
        return archives;
      },
    });
  }

  test('expired / deleted は一覧から除外し、available / started は残す', async () => {
    const client = createVideoClient({
      clientFactory: makeArchivesFactory([
        { id: 'a1', status: 'available', url: 'https://e/a1.mp4' },
        { id: 'a2', status: 'expired' },
        { id: 'a3', status: 'deleted' },
        { id: 'a4', status: 'started' },
      ]),
    });

    const result = await client.getArchives();

    expect(result.ok).toBe(true);
    expect(result.archives.map((a) => a.id)).toEqual(['a1', 'a4']);
  });

  test('status を持たないアーカイブは残す', async () => {
    const client = createVideoClient({
      clientFactory: makeArchivesFactory([{ id: 'a1' }]),
    });

    const result = await client.getArchives();

    expect(result.archives.map((a) => a.id)).toEqual(['a1']);
  });
});

describe('infra videoClient deleteArchive', () => {
  /** deleteArchive の挙動を注入する擬似 Video クライアントの clientFactory。 */
  function makeDeleteFactory(impl) {
    return async () => ({ deleteArchive: impl });
  }

  test('成功時は { ok: true } を返す', async () => {
    const client = createVideoClient({ clientFactory: makeDeleteFactory(async () => ({})) });

    await expect(client.deleteArchive('a1')).resolves.toEqual({ ok: true });
  });

  test('404（削除済み）は冪等に成功扱い', async () => {
    const client = createVideoClient({
      clientFactory: makeDeleteFactory(async () => {
        const err = new Error('Not Found');
        err.status = 404;
        throw err;
      }),
    });

    await expect(client.deleteArchive('a1')).resolves.toEqual({ ok: true });
  });

  test('409 Conflict は ARCHIVE_NOT_DELETABLE を返す', async () => {
    const client = createVideoClient({
      clientFactory: makeDeleteFactory(async () => {
        const err = new Error('Conflict');
        err.status = 409;
        throw err;
      }),
    });

    const result = await client.deleteArchive('a1');

    expect(result).toMatchObject({ ok: false, code: 'ARCHIVE_NOT_DELETABLE' });
    expect(result.message).toMatch(/処理中|期限切れ/);
  });

  test('archiveId が空なら VALIDATION_ERROR を返す', async () => {
    const client = createVideoClient({ clientFactory: makeDeleteFactory(async () => ({})) });

    const result = await client.deleteArchive('');

    expect(result).toMatchObject({ ok: false, code: 'VALIDATION_ERROR' });
  });
});
