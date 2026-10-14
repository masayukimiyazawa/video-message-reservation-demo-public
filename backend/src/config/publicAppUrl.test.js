/**
 * 公開アプリ URL の解決・検証ユニットテスト
 *
 * 実害の不具合:
 *   入室リンクのベース URL に CORS 用の CLIENT_ORIGIN を使っていたため、
 *   テスト環境でも本番でも http://localhost:5173 が配信されていた。
 *   利用者のスマホから localhost は到達できないので、ボタンは表示されても
 *   開こうとすると接続できなかった。
 *
 * @module config/publicAppUrl.test
 */

import { resolvePublicAppUrl, describePublicAppUrlProblem } from './publicAppUrl.js';

describe('resolvePublicAppUrl', () => {
  test('末尾スラッシュと空白を除去する', () => {
    expect(resolvePublicAppUrl('  https://app.example.com///  ')).toBe(
      'https://app.example.com',
    );
  });

  test('末尾スラッシュがなければそのまま返す', () => {
    expect(resolvePublicAppUrl('https://app.example.com')).toBe('https://app.example.com');
  });

  test('空文字・未定義は空文字を返す', () => {
    expect(resolvePublicAppUrl('')).toBe('');
    expect(resolvePublicAppUrl(undefined)).toBe('');
    expect(resolvePublicAppUrl(null)).toBe('');
  });

  test('サブパスのデプロイも保持する', () => {
    expect(resolvePublicAppUrl('https://example.com/video/')).toBe('https://example.com/video');
  });
});

describe('describePublicAppUrlProblem', () => {
  test('Cloudflare トンネルの URL は問題なし', () => {
    expect(
      describePublicAppUrlProblem('https://random-words-1234.trycloudflare.com'),
    ).toBe('');
  });

  test('本番のデプロイ先 URL は問題なし', () => {
    expect(describePublicAppUrlProblem('https://app.example.com')).toBe('');
  });

  test('未設定は問題として報告する', () => {
    const problem = describePublicAppUrlProblem('');
    expect(problem).toContain('PUBLIC_APP_URL');
    expect(problem).toContain('未設定');
    // テスト/本番それぞれの指針を含める
    expect(problem).toContain('trycloudflare.com');
    expect(problem).toContain('デプロイ先');
  });

  test('localhost はループバックとして報告する', () => {
    const problem = describePublicAppUrlProblem('http://localhost:5173');
    expect(problem).toContain('ループバック');
  });

  test('127.0.0.1 もループバックとして報告する', () => {
    expect(describePublicAppUrlProblem('http://127.0.0.1:5173')).toContain('ループバック');
  });

  test('IPv6 ループバックもループバックとして報告する', () => {
    expect(describePublicAppUrlProblem('http://[::1]:5173')).toContain('ループバック');
  });

  test('URL として解釈できない値を報告する', () => {
    expect(describePublicAppUrlProblem('not-a-url')).toContain('URL として解釈できません');
  });

  test('http/https 以外のスキームを報告する', () => {
    expect(describePublicAppUrlProblem('ftp://example.com')).toContain('スキーム');
  });

  test('localhost を含むサブドメインは誤検知しない', () => {
    // localhost という文字列が含まれていてもループバックではない
    expect(describePublicAppUrlProblem('https://my-localhost.example.com')).toBe('');
  });

  test('末尾スラッシュがあっても判定が同じ', () => {
    expect(describePublicAppUrlProblem('https://app.example.com/')).toBe('');
  });
});
