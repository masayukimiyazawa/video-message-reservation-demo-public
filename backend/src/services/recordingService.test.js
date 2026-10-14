import {
  createRecordingService,
  RecordingErrorCode,
  RecordingStatus,
} from './recordingService.js';
import { createActiveArchiveStore } from '../infra/activeArchiveStore.js';

/**
 * Recording_Service / Transcription_Service 失敗通知のユニットテスト
 * （Task 12.3 / 要件 7.4・8.5）
 *
 *  - startRecording 失敗 → recording:status に start_failed を送出し失敗応答を返す（要件 7.4）
 *  - fetchTranscription 失敗 → transcription_failed を送出し失敗応答を返す（要件 8.5）
 *
 * videoClient（throwing）と statusEmitter を注入モックにして検証する。
 */

/** emitRecordingStatus の呼び出しを記録する statusEmitter モック。 */
function makeEmitter() {
  const events = [];
  return {
    emitter: { emitRecordingStatus: (payload) => events.push(payload) },
    events,
  };
}

/** events から特定 status のペイロードを取り出す。 */
function findStatus(events, status) {
  return events.find((e) => e.status === status);
}

const baseVideoClient = {
  startArchive: async () => ({ id: 'arch-1' }),
  stopArchive: async () => ({ ok: true, archive: { id: 'arch-1', status: 'stopped' } }),
  fetchTranscriptionJson: async () => ({ segments: [], channels_metadata: [] }),
};

describe('Recording_Service 録画開始失敗 (Task 12.3 / 要件 7.4)', () => {
  test('startArchive が失敗すると start_failed を送出し失敗応答を返す', async () => {
    const { emitter, events } = makeEmitter();
    const errors = [];
    const svc = createRecordingService({
      videoClient: { ...baseVideoClient, startArchive: async () => { throw new Error('Vonage 5xx'); } },
      statusEmitter: emitter,
      logger: { error: (...a) => errors.push(a), info: () => {} },
    });

    const result = await svc.startRecording({ sessionId: 'sess-1', withTranscription: true, language: 'ja' });

    expect(result.ok).toBe(false);
    expect(result.code).toBe(RecordingErrorCode.START_FAILED);
    expect(result.message).toContain('Vonage 5xx');
    // start_failed が Admin_UI へ送出された（要件 7.4）。
    const failed = findStatus(events, RecordingStatus.START_FAILED);
    expect(failed).toBeDefined();
    expect(failed.sessionId).toBe('sess-1');
    expect(failed.error).toContain('Vonage 5xx');
    // 失敗が記録される。
    expect(errors.length).toBeGreaterThanOrEqual(1);
  });

  test('sessionId 欠落（ドメイン検証失敗）でも start_failed を送出する', async () => {
    const { emitter, events } = makeEmitter();
    const svc = createRecordingService({
      videoClient: baseVideoClient,
      statusEmitter: emitter,
      logger: { error: () => {}, info: () => {} },
    });

    const result = await svc.startRecording({ withTranscription: true });
    expect(result.ok).toBe(false);
    expect(result.code).toBe(RecordingErrorCode.VALIDATION_ERROR);
    expect(findStatus(events, RecordingStatus.START_FAILED)).toBeDefined();
  });

  test('録画開始成功時は starting と started を送出し { ok:true, archive } を返す', async () => {
    const { emitter, events } = makeEmitter();
    const svc = createRecordingService({
      videoClient: { ...baseVideoClient, startArchive: async () => ({ id: 'arch-9' }) },
      statusEmitter: emitter,
      logger: { error: () => {}, info: () => {} },
    });

    const result = await svc.startRecording({ sessionId: 'sess-9', withTranscription: true, language: 'en' });
    expect(result.ok).toBe(true);
    expect(result.archive.id).toBe('arch-9');
    expect(findStatus(events, RecordingStatus.STARTING)).toBeDefined();
    const started = findStatus(events, RecordingStatus.STARTED);
    expect(started).toBeDefined();
    expect(started.archiveId).toBe('arch-9');
    expect(started.hasTranscription).toBe(true);
  });
});

describe('Transcription_Service 文字起こし取得失敗 (Task 12.3 / 要件 8.5)', () => {
  test('fetchTranscriptionJson が失敗すると transcription_failed を送出し失敗応答を返す', async () => {
    const { emitter, events } = makeEmitter();
    const errors = [];
    const svc = createRecordingService({
      videoClient: {
        ...baseVideoClient,
        fetchTranscriptionJson: async () => { throw new Error('transcription URL not found'); },
      },
      statusEmitter: emitter,
      logger: { error: (...a) => errors.push(a), info: () => {} },
    });

    const result = await svc.fetchTranscription('arch-1');

    expect(result.ok).toBe(false);
    expect(result.code).toBe(RecordingErrorCode.TRANSCRIPTION_FAILED);
    expect(result.message).toContain('transcription URL not found');
    // transcription_failed が Admin_UI へ送出された（要件 8.5）。
    const failed = findStatus(events, RecordingStatus.TRANSCRIPTION_FAILED);
    expect(failed).toBeDefined();
    expect(failed.archiveId).toBe('arch-1');
    expect(errors.length).toBeGreaterThanOrEqual(1);
  });

  test('archiveId 欠落でも transcription_failed を送出する', async () => {
    const { emitter, events } = makeEmitter();
    const svc = createRecordingService({
      videoClient: baseVideoClient,
      statusEmitter: emitter,
      logger: { error: () => {}, info: () => {} },
    });

    const result = await svc.fetchTranscription('');
    expect(result.ok).toBe(false);
    expect(result.code).toBe(RecordingErrorCode.VALIDATION_ERROR);
    expect(findStatus(events, RecordingStatus.TRANSCRIPTION_FAILED)).toBeDefined();
  });

  test('取得成功時は transcription_ready を送出し { ok:true, transcript } を返す', async () => {
    const { emitter, events } = makeEmitter();
    const rawJson = {
      segments: [
        { channel: 0, start: 0, end: 1, text: 'hello' },
        { channel: 1, start: 1, end: 2, text: 'world' },
      ],
      channels_metadata: [
        { id: 'stream-a' },
        { id: 'stream-b' },
      ],
    };
    const svc = createRecordingService({
      videoClient: { ...baseVideoClient, fetchTranscriptionJson: async () => rawJson },
      statusEmitter: emitter,
      logger: { error: () => {}, info: () => {} },
    });

    const result = await svc.fetchTranscription('arch-7');
    expect(result.ok).toBe(true);
    expect(Array.isArray(result.transcript)).toBe(true);
    const ready = findStatus(events, RecordingStatus.TRANSCRIPTION_READY);
    expect(ready).toBeDefined();
    expect(ready.archiveId).toBe('arch-7');
  });
});

describe('Recording_Service 録画停止失敗 (Task 12.3 / 要件 7.4 系)', () => {
  test('stopArchive 失敗時は stop_failed を送出し失敗応答を返す', async () => {
    const { emitter, events } = makeEmitter();
    const svc = createRecordingService({
      videoClient: { ...baseVideoClient, stopArchive: async () => { throw new Error('stop error'); } },
      statusEmitter: emitter,
      logger: { error: () => {}, info: () => {} },
    });

    const result = await svc.stopRecording('arch-1');
    expect(result.ok).toBe(false);
    expect(result.code).toBe(RecordingErrorCode.STOP_FAILED);
    expect(findStatus(events, RecordingStatus.STOP_FAILED)).toBeDefined();
  });
});

describe('Recording_Service 進行中アーカイブ登録 (要件 10)', () => {
  test('録画開始成功で sessionId→archiveId を登録し、停止成功で削除する', async () => {
    const store = createActiveArchiveStore();
    const svc = createRecordingService({
      videoClient: { ...baseVideoClient, startArchive: async () => ({ id: 'arch-m' }) },
      statusEmitter: makeEmitter().emitter,
      activeArchiveStore: store,
      logger: { error: () => {}, info: () => {} },
    });

    await svc.startRecording({ sessionId: 'sess-m', withTranscription: true, language: 'ja' });
    // 手動・自動いずれの経路でも会議終了時に停止できるよう登録される。
    expect(store.get('sess-m')).toBe('arch-m');

    await svc.stopRecording('arch-m');
    expect(store.get('sess-m')).toBeNull();
  });

  test('録画開始失敗時は登録しない', async () => {
    const store = createActiveArchiveStore();
    const svc = createRecordingService({
      videoClient: { ...baseVideoClient, startArchive: async () => { throw new Error('boom'); } },
      statusEmitter: makeEmitter().emitter,
      activeArchiveStore: store,
      logger: { error: () => {}, info: () => {} },
    });

    await svc.startRecording({ sessionId: 'sess-x', withTranscription: true });
    expect(store.get('sess-x')).toBeNull();
  });
});
