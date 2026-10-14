import { describe, it, expect } from 'vitest';
import {
  isRecordingPending,
  isTranscriptionPending,
  hasPendingMedia,
} from './mediaPending.js';

/**
 * 録画・文字起こしの「まだ DL できない」判定テスト（GAP 1）。
 * バックグラウンド再取得（useAutoRefresh）の対象を決める純粋関数を検証する。
 */

describe('isRecordingPending (GAP 1)', () => {
  it('URL がまだ無い録画は pending（処理中）', () => {
    expect(isRecordingPending({ id: 'a1', status: 'processing' })).toBe(true);
    expect(isRecordingPending({ id: 'a1', status: 'stopped' })).toBe(true);
    expect(isRecordingPending({ id: 'a1' })).toBe(true);
  });

  it('URL がある録画は pending ではない', () => {
    expect(isRecordingPending({ id: 'a1', status: 'available', url: 'https://x/a1.mp4' })).toBe(false);
    expect(isRecordingPending({ id: 'a1', downloadUrl: 'https://x/a1.mp4' })).toBe(false);
  });

  it('終端ステータス（failed/expired）は URL が無くても pending にしない', () => {
    expect(isRecordingPending({ id: 'a1', status: 'failed' })).toBe(false);
    expect(isRecordingPending({ id: 'a1', status: 'expired' })).toBe(false);
  });

  it('null/undefined は pending ではない', () => {
    expect(isRecordingPending(null)).toBe(false);
    expect(isRecordingPending(undefined)).toBe(false);
  });
});

describe('isTranscriptionPending (GAP 1)', () => {
  it('文字起こし未完成（hasTranscription=false）は pending', () => {
    expect(isTranscriptionPending({ id: 'a1', hasTranscription: false })).toBe(true);
    expect(isTranscriptionPending({ id: 'a1' })).toBe(true);
  });

  it('文字起こし済み・DL URL ありは pending ではない', () => {
    expect(isTranscriptionPending({ id: 'a1', hasTranscription: true })).toBe(false);
    expect(isTranscriptionPending({ id: 'a1', downloadUrl: 'https://x/t.zip' })).toBe(false);
    expect(isTranscriptionPending({ id: 'a1', transcription: { url: 'https://x/t.zip' } })).toBe(false);
  });

  it('終端ステータスは pending にしない', () => {
    expect(isTranscriptionPending({ id: 'a1', status: 'failed' })).toBe(false);
  });
});

describe('hasPendingMedia (GAP 1)', () => {
  it('録画か文字起こしのどちらかに未完了があれば true', () => {
    expect(hasPendingMedia([{ id: 'a1', status: 'processing' }], [])).toBe(true);
    expect(hasPendingMedia([], [{ id: 'a1', hasTranscription: false }])).toBe(true);
    expect(hasPendingMedia([], [])).toBe(false);
    expect(hasPendingMedia()).toBe(false);
  });

  it('全件そろっていれば false（ポーリング停止）', () => {
    const archives = [{ id: 'a1', status: 'available', url: 'https://x/a1.mp4' }];
    const transcriptions = [{ id: 'a1', hasTranscription: true }];
    expect(hasPendingMedia(archives, transcriptions)).toBe(false);
  });
});
