/**
 * Vonage Video アーカイブ + 文字起こし取得 統合テスト（Task 18.2 / 要件 7.2・8.2）
 *
 * individual アーカイブ開始と Post-Call Transcription 取得を HTTP レベルで代表例により検証する
 * （外部挙動の網羅は目的としない）。
 *
 * 検証対象（エンドツーエンド）:
 *  - POST /recordings/start に withTranscription:true で要求すると、
 *    実 buildArchiveOptions（ドメイン純粋関数）を通じて videoClient.startArchive が
 *    outputMode 'individual' + hasTranscription:true + hasAudio:true で呼ばれる（要件 7.2）。
 *  - GET /transcriptions/:archiveId で videoClient.fetchTranscriptionJson の生 JSON を取得し、
 *    実 groupBySpeaker で話者（channel/stream）単位に整形した結果が返る（要件 8.2・8.3）。
 *
 * 実装方針:
 *  - supertest は導入せず、Node 標準 http で createApp に対し実 HTTP リクエストを送る。
 *  - 実 buildArchiveOptions / groupBySpeaker / recordingService を配線し、
 *    モックするのは外部境界（Vonage Video クライアント）と Socket.IO ステータスエミッタ、
 *    および authorize ミドルウェア（パススルー）のみ。
 *
 * @module services/recording.integration.test
 */

import http from 'node:http';

import { createApp } from '../index.js';
import { createRecordingRouter, createTranscriptionRouter } from './recordingRoutes.js';
import { createRecordingService } from './recordingService.js';

/**
 * authorize(action) のパススルー実装（テスト用）。
 * 管理者としてリクエストを通し、統合フローに焦点を当てる。
 * @returns {import('express').RequestHandler}
 */
const passThroughAuthorize = () => (req, _res, next) => {
  req.user = { userId: 'admin-test', role: 'administrator' };
  next();
};

/**
 * Socket.IO ステータスエミッタのスパイ。recording:status ペイロードを記録する。
 * @returns {{ emitter: { emitRecordingStatus: Function }, events: Array<object> }}
 */
function makeEmitterSpy() {
  const events = [];
  return {
    events,
    emitter: { emitRecordingStatus: (payload) => events.push(payload) },
  };
}

/**
 * Vonage Video クライアントのモック。startArchive / fetchTranscriptionJson の呼び出しを記録し、
 * 実 API を呼ばずに定型値を返す。
 * @param {object} rawTranscription fetchTranscriptionJson が返す生 JSON
 * @returns {{ client: object, calls: { startArchive: Array<any[]>, fetchTranscription: Array<any[]> } }}
 */
function makeVideoClientMock(rawTranscription, { archives } = {}) {
  const calls = { startArchive: [], stopArchive: [], fetchTranscription: [], getArchives: 0 };
  return {
    calls,
    client: {
      async startArchive(sessionId, options) {
        calls.startArchive.push([sessionId, options]);
        return { id: 'archive-001', sessionId, status: 'started' };
      },
      async stopArchive(archiveId) {
        calls.stopArchive.push([archiveId]);
        return { id: archiveId, status: 'stopped' };
      },
      async fetchTranscriptionJson(archiveId) {
        calls.fetchTranscription.push([archiveId]);
        return rawTranscription;
      },
      async getArchives() {
        calls.getArchives += 1;
        return { ok: true, archives: archives ?? [] };
      },
    },
  };
}

/**
 * 現実的な Post-Call Transcription 生 JSON（channel + channels_metadata）。
 * 2 話者・3 セグメント。groupBySpeaker が話者単位へ整形できる形。
 */
const RAW_TRANSCRIPTION = Object.freeze({
  segments: [
    { channel: 0, start: 0.0, end: 2.5, text: 'Hello, how can I help you today?' },
    { channel: 1, start: 2.6, end: 5.0, text: 'I would like to book a follow-up.' },
    { channel: 0, start: 5.1, end: 7.0, text: 'Sure, let me check availability.' },
  ],
  channels_metadata: [
    { id: 'stream-doctor', name: 'Dr. Smith' },
    { id: 'stream-patient', name: 'Patient' },
  ],
});

/**
 * createApp を実 HTTP サーバーとして起動し、任意メソッド/パスへ JSON を送る。
 * @param {import('express').Express} app
 * @param {('GET'|'POST')} method
 * @param {string} path
 * @param {object} [body]
 * @returns {Promise<{ status: number, json: object }>}
 */
function request(app, method, path, body) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const { port } = server.address();
      const payload = body ? JSON.stringify(body) : null;
      const headers = {};
      if (payload) {
        headers['content-type'] = 'application/json';
        headers['content-length'] = Buffer.byteLength(payload);
      }
      const req = http.request(
        { host: '127.0.0.1', port, method, path, headers },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => {
            server.close(() => {
              resolve({ status: res.statusCode, json: data ? JSON.parse(data) : null });
            });
          });
        },
      );
      req.on('error', (err) => {
        server.close(() => reject(err));
      });
      if (payload) req.write(payload);
      req.end();
    });
  });
}

/**
 * Recording / Transcription ルーターを実 recordingService（モック videoClient）で配線した
 * テスト用アプリを構築する。
 * @param {object} rawTranscription
 */
function buildApp(rawTranscription = RAW_TRANSCRIPTION, { archives } = {}) {
  const { emitter, events } = makeEmitterSpy();
  const { client: videoClient, calls } = makeVideoClientMock(rawTranscription, { archives });
  const recordingService = createRecordingService({
    videoClient,
    statusEmitter: emitter,
    logger: { error: () => {}, info: () => {} },
  });
  const recordingRouter = createRecordingRouter({
    recordingService,
    authorize: passThroughAuthorize,
  });
  const transcriptionRouter = createTranscriptionRouter({
    recordingService,
    authorize: passThroughAuthorize,
    videoClient,
  });
  const app = createApp({ recordingRouter, transcriptionRouter });
  return { app, calls, events };
}

describe('Vonage Video アーカイブ + 文字起こし取得 統合テスト (Task 18.2 / 要件 7.2・8.2)', () => {
  test('代表例1: withTranscription で individual アーカイブが開始される（要件 7.2）', async () => {
    const { app, calls } = buildApp();

    const res = await request(app, 'POST', '/recordings/start', {
      sessionId: 'session-abc',
      withTranscription: true,
      language: 'ja',
      name: 'clinic-call',
    });

    expect(res.status).toBe(201);
    expect(res.json.archive).toBeDefined();
    expect(res.json.archive.id).toBe('archive-001');

    // buildArchiveOptions の効果: startArchive が individual + 文字起こし有効で呼ばれる。
    expect(calls.startArchive).toHaveLength(1);
    const [sessionId, options] = calls.startArchive[0];
    expect(sessionId).toBe('session-abc');
    expect(options.outputMode).toBe('individual');
    expect(options.hasTranscription).toBe(true);
    expect(options.hasAudio).toBe(true);
    expect(options.transcriptionProperties.primaryLanguageCode).toBe('ja-JP');
  });

  test('代表例2: Post-Call Transcription を取得し話者単位に整形して返す（要件 8.2・8.3）', async () => {
    const { app, calls } = buildApp();

    const res = await request(app, 'GET', '/transcriptions/archive-001');

    expect(res.status).toBe(200);
    expect(calls.fetchTranscription).toHaveLength(1);
    expect(calls.fetchTranscription[0][0]).toBe('archive-001');

    // groupBySpeaker の効果: channel/stream 単位に整形されている。
    const transcript = res.json.transcript;
    expect(Array.isArray(transcript)).toBe(true);
    expect(transcript).toHaveLength(2); // 2 話者（channel 0 / 1）

    const byChannel = new Map(transcript.map((s) => [s.channel, s]));
    const doctor = byChannel.get(0);
    const patient = byChannel.get(1);

    expect(doctor.streamId).toBe('stream-doctor');
    expect(doctor.speakerLabel).toBe('Dr. Smith');
    expect(doctor.segments).toHaveLength(2); // channel 0 の発話は 2 件
    expect(patient.streamId).toBe('stream-patient');
    expect(patient.segments).toHaveLength(1);

    // 全セグメント（3 件）が過不足なく保存されている。
    const totalSegments = transcript.reduce((n, s) => n + s.segments.length, 0);
    expect(totalSegments).toBe(3);
  });

  test('代表例3: 開始→文字起こし取得の一連フローが成立し状態通知が送出される', async () => {
    const { app, calls, events } = buildApp();

    const startRes = await request(app, 'POST', '/recordings/start', {
      sessionId: 'session-xyz',
      withTranscription: true,
      language: 'en',
    });
    expect(startRes.status).toBe(201);
    const archiveId = startRes.json.archive.id;

    const txRes = await request(app, 'GET', `/transcriptions/${archiveId}`);
    expect(txRes.status).toBe(200);
    expect(txRes.json.transcript).toHaveLength(2);

    // en 指定は en-US に写像される。
    expect(calls.startArchive[0][1].transcriptionProperties.primaryLanguageCode).toBe('en-US');

    // recording:status に started と transcription_ready が送出されている（要件 7.5・8.5 系）。
    const started = events.find((e) => e.status === 'started');
    expect(started).toBeDefined();
    expect(started.hasTranscription).toBe(true);
    const ready = events.find((e) => e.status === 'transcription_ready');
    expect(ready).toBeDefined();
    expect(ready.archiveId).toBe(archiveId);
    expect(ready.speakerCount).toBe(2);
  });

  test('代表例4: GET /transcriptions は注入 videoClient の getArchives を使い transcription 有りだけ返す（要件 8.5）', async () => {
    const { app, calls } = buildApp(RAW_TRANSCRIPTION, {
      archives: [
        { id: 'a-1', sessionId: 's1', transcription: { url: 'https://example.com/trans-a-1.zip', status: 'available' } },
        { id: 'a-2', sessionId: 's1' }, // transcription なし
      ],
    });

    const res = await request(app, 'GET', '/transcriptions');

    expect(res.status).toBe(200);
    // 動的 import ではなく注入された videoClient が使われる（DI の検証）。
    expect(calls.getArchives).toBe(1);
    // 正規化により archiveId が補完される（フロントのキー整合）。文字起こし無しは除外。
    expect(res.json.transcriptions).toHaveLength(1);
    expect(res.json.transcriptions[0]).toMatchObject({
      id: 'a-1',
      sessionId: 's1',
      hasTranscription: true,
      archiveId: 'a-1',
    });
  });
});
