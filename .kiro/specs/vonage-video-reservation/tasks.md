# Implementation Plan

## Overview

本実装計画は、Vonage Video API を中核とした予約機能付きビデオ通話アプリケーション（Node.js/Express バックエンド、React SPA フロントエンド、MongoDB Atlas 永続化）を、純粋ドメインロジックを起点に段階的に構築する。まず副作用のない純粋関数（会話遷移・空き判定・認可判定・アーカイブオプション構築・文字起こし整形）を実装し、設計書の 10 個の Correctness Property を `fast-check` によるプロパティテストで検証する。次にインフラ層（Mongoose リポジトリ、Vonage SDK 連携、Socket.IO）を実装し、Express API と React UI を配線して全体を統合する。

各タスクは前のタスクの成果物を土台に構築され、孤立コードが残らないよう最後に配線まで行う。テスト関連サブタスクは `*` を付して任意扱いとする。プロパティテストは各テストに `Feature: vonage-video-reservation, Property {番号}: {本文}` タグを付け、最低 100 イテレーションを実行する。

## Tasks

- [x] 1. プロジェクト基盤とディレクトリ構成のセットアップ
  - モノレポ構成（`backend/`・`frontend/`）を作成し、`package.json`・`.env.example`（Vonage/MongoDB/JWT 用の環境変数キー）を定義する
  - バックエンド: Express、`@vonage/server-sdk`、Mongoose、Socket.IO、`node-cron`、`jsonwebtoken`、テスト用 `jest`・`fast-check` を導入する
  - フロントエンド: React SPA スキャフォールド、`react-i18next`、Vonage Video Client SDK、Socket.IO client を導入する
  - ドメイン層のディレクトリ（`backend/src/domain/`）と型・定数（予約状態 enum、対応言語 `{en, ja}`）を定義する
  - _Requirements: 2.2, 6.4_

- [x] 2. チャットボット会話ドメインロジックの実装
  - [x] 2.1 会話状態遷移関数 `nextStep(state, input)` を実装する
    - 有効な次の会話状態と、種別（reply button / list / メディアテンプレート / 確定）を持つ `outMessage` を返す純粋関数を実装する
    - リッチメディア（メディアテンプレート/カルーセル）メッセージ種別の組立を含める
    - _Requirements: 1.1, 1.6_

  - [x] 2.2 予約 DTO 構築関数 `buildReservationDTO(completedState)` を実装する
    - 完了した会話状態から連絡先・予約時刻・対象サービス・対応言語を含む予約 DTO を構築する
    - _Requirements: 1.2, 1.3_

  - [x]* 2.3 会話遷移のプロパティテストを書く
    - **Property 1: 会話遷移は常に有効な状態と選択肢を返す**
    - **Validates: Requirements 1.1**

  - [x]* 2.4 予約 DTO 構築のプロパティテストを書く
    - **Property 2: 完了会話からの予約 DTO は必須フィールドを備える**
    - **Validates: Requirements 1.2, 1.3**

- [x] 3. 予約ドメインロジック（空き判定・バリデーション）の実装
  - [x] 3.1 空き判定関数 `checkAvailability(existing[], requestedSlot)` を実装する
    - 重複時は `available: false` と 1 つ以上の非重複な代替候補を返し、非重複時のみ `available: true` を返す純粋関数を実装する
    - _Requirements: 1.5_

  - [x] 3.2 予約バリデーション関数 `validateReservation(record)` を実装する
    - 必須フィールド（予約 ID・連絡先・予約時刻・対象サービス・状態・対応言語）の存在と `language ∈ {en, ja}` を検証する
    - _Requirements: 2.2, 6.4_

  - [x]* 3.3 空き判定のプロパティテストを書く
    - **Property 3: 空き判定は重複時に必ず代替を提示する**
    - **Validates: Requirements 1.5**

  - [x]* 3.4 予約バリデーションのプロパティテストを書く
    - **Property 5: 予約レコードのバリデーション**
    - **Validates: Requirements 2.2, 6.4**

- [x] 4. 通知・認可ドメインロジックの実装
  - [x] 4.1 到来予約選択関数 `selectDueReservations(reservations[], now)` を実装する
    - `reservationTime <= now` かつ `notified == false` の予約と厳密に一致する集合を返す純粋関数を実装する
    - _Requirements: 3.1, 3.2_

  - [x] 4.2 認可判定関数 `canAccess(role, action, ownership)` を実装する
    - 管理者は全許可、スタッフは自身に割り当てられた予約のみ許可、それ以外は拒否する純粋関数を実装する
    - _Requirements: 5.1, 5.2, 5.3, 5.4_

  - [x]* 4.3 到来予約選択のプロパティテストを書く
    - **Property 6: 到来予約の選択は期限到来かつ未通知に限定される**
    - **Validates: Requirements 3.1, 3.2**

  - [x]* 4.4 認可判定のプロパティテストを書く
    - **Property 7: 認可判定はロールと所有関係に整合する**
    - **Validates: Requirements 5.1, 5.2, 5.3, 5.4**

- [x] 5. 録画・文字起こしドメインロジックの実装
  - [x] 5.1 アーカイブオプション構築関数 `buildArchiveOptions(req)` を実装する
    - `withTranscription === true` の場合、必ず `outputMode: 'individual'`・`hasAudio: true`・`hasTranscription: true`・`transcriptionProperties.primaryLanguageCode` を設定する純粋関数を実装する
    - _Requirements: 7.2, 8.1_

  - [x] 5.2 文字起こし整形関数 `groupBySpeaker(rawJson)` を実装する
    - `segments[].channel` と `channels_metadata`（`id` = stream ID）を用いて全発話を話者単位に対応付け、`SpeakerTranscript[]` を返す純粋関数を実装する
    - _Requirements: 8.3_

  - [x]* 5.3 アーカイブオプション構築のプロパティテストを書く
    - **Property 9: 文字起こし要時のアーカイブは必ず個別ストリームで有効化される**
    - **Validates: Requirements 7.2, 8.1**

  - [x]* 5.4 文字起こし整形のプロパティテストを書く
    - **Property 10: 文字起こし整形は全発話を保存し話者に対応付ける**
    - **Validates: Requirements 8.3**

- [x] 6. チェックポイント - ドメイン層のテストがすべて通ることを確認
  - すべてのテストが通ることを確認し、疑問があればユーザーに質問する。

- [x] 7. データ層（MongoDB Atlas / Mongoose）の実装
  - [x] 7.1 Reservation / User の Mongoose スキーマとモデルを実装する
    - 設計の Reservation スキーマ（予約 ID・連絡先・予約時刻・サービス・状態・言語・notified・sessionId・assignedStaffId）と User スキーマ（userId・role・passwordHash）を定義する
    - _Requirements: 2.2, 5.1_

  - [x] 7.2 Reservation_Store リポジトリと Atlas 接続を実装する
    - `save` / `findById` / `find(filter)` / `updateStatus` を実装し、接続・書込失敗時に例外を送出する
    - _Requirements: 2.1, 2.4, 2.3_

  - [x]* 7.3 保存・取得ラウンドトリップのプロパティテストを書く
    - **Property 4: 予約レコードの保存・取得ラウンドトリップ**（インメモリ Mongo / テストコンテナを使用）
    - **Validates: Requirements 2.1, 2.4**

  - [x]* 7.4 Reservation_Store 書込失敗の変換ユニットテストを書く
    - 例外注入時に構造化エラー/失敗応答へ変換されることを検証する
    - _Requirements: 2.3_

- [x] 8. Reservation_System アプリケーションサービスの実装
  - [x] 8.1 予約 CRUD と一覧取得サービスを実装する
    - `createReservation` / `updateReservation` / `cancelReservation` / `listReservations` を実装し、`validateReservation`・`checkAvailability`・Reservation_Store を配線する
    - 書込失敗時にエラー記録と失敗応答への変換を行う
    - _Requirements: 1.3, 2.1, 2.3, 2.4_

  - [x]* 8.2 予約サービスのユニットテストを書く
    - 空き不可時の代替提示、状態遷移、失敗応答変換のエッジケースを検証する
    - _Requirements: 1.5, 2.3_

- [x] 9. Auth_Service（RBAC / JWT）の実装
  - [x] 9.1 ログインエンドポイントと JWT 発行を実装する
    - `POST /auth/login` を実装し、認証・ロール（管理者/スタッフ）判定と JWT 発行を行う
    - _Requirements: 5.1_

  - [x] 9.2 認可ミドルウェア `authorize(action)` を実装する
    - JWT 検証後、`canAccess` の判定に基づき保護エンドポイントを許可/拒否（HTTP 403）する
    - _Requirements: 5.2, 5.3, 5.4_

  - [x]* 9.3 認可ミドルウェアのユニットテストを書く
    - 権限のない操作が 403 で拒否されること、所有関係ごとの許可を検証する
    - _Requirements: 5.4_

- [x] 10. Chatbot_Service（Vonage Messages API Webhook）の実装
  - [x] 10.1 受信/ステータス Webhook と会話進行を実装する
    - `POST /webhooks/inbound-message`・`POST /webhooks/message-status` を実装し、署名/JWT 検証・`nextStep` による会話進行・`buildReservationDTO` から Reservation_System への登録を配線する
    - 空き不可時（`checkAvailability` が false）に予約不可メッセージと代替候補（インタラクティブメッセージ）を返す
    - _Requirements: 1.1, 1.2, 1.5_

  - [x] 10.2 WhatsApp 送信（確定・リッチメディア・言語別）を実装する
    - 予約保存完了時の確定メッセージ送信、メディアテンプレート/カルーセル送信、保存レコードの `language` に応じた本文選択を実装する
    - _Requirements: 1.4, 1.6, 6.3_

  - [x]* 10.3 送信言語マッピングのプロパティテストを書く
    - **Property 8: WhatsApp 送信言語は予約の対応言語と一致する**
    - **Validates: Requirements 6.3**

  - [x]* 10.4 確定メッセージ送信のユニットテストを書く
    - 予約確定時に確定メッセージ送信が呼ばれること（モック）を検証する
    - _Requirements: 1.4_

- [x] 11. Notification_Service（スケジューラ + Socket.IO）の実装
  - [x] 11.1 スケジューラと通知送出を実装する
    - `node-cron` による `pollDueReservations` を実装し、`selectDueReservations` で抽出した予約に対し WhatsApp 通知送信と Socket.IO `reservation:due` イベント送出を行う
    - WhatsApp 送信失敗時は失敗を記録しつつ Socket.IO 送出を継続し、`notified` を更新する
    - _Requirements: 3.1, 3.2, 3.4_

  - [x]* 11.2 通知の部分的失敗ユニットテストを書く
    - WhatsApp 通知失敗時も画面通知イベントが送出されることを検証する
    - _Requirements: 3.4_

- [x] 12. Recording_Service / Transcription_Service（Vonage Video API）の実装
  - [x] 12.1 録画開始/停止と状態通知を実装する
    - `startRecording` / `stopRecording` を実装し、`buildArchiveOptions` を用いて individual + `hasTranscription` でアーカイブ開始、状態変化を Socket.IO `recording:status` で通知する
    - 録画開始失敗を捕捉し失敗内容を記録・通知する
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5_

  - [x] 12.2 Post-Call Transcription 取得と整形を実装する
    - `fetchTranscription(archiveId)` で結果を取得し、`groupBySpeaker` で話者単位に整形して返す
    - 取得/生成失敗を記録し Socket.IO で失敗状態を通知する
    - _Requirements: 8.1, 8.2, 8.3, 8.5_

  - [x]* 12.3 録画/文字起こし失敗通知のユニットテストを書く
    - 録画開始失敗・文字起こし取得失敗時に失敗通知と記録が行われることを検証する
    - _Requirements: 7.4, 8.5_

- [x] 13. Video トークン発行と Express API 配線
  - [x] 13.1 セッション/トークンエンドポイントと全 API ルーティングを配線する
    - `POST /sessions/:id/token`（connection data による stream-ユーザー対応付けを含む）、`/reservations`・`/recordings/*`・`/transcriptions/:archiveId` を `authorize` で保護して配線する
    - _Requirements: 4.1, 7.1, 8.2_

- [x] 14. チェックポイント - バックエンド統合の確認
  - すべてのテストが通ることを確認し、疑問があればユーザーに質問する。

- [x] 15. フロントエンド基盤と i18n のセットアップ
  - [x] 15.1 React SPA 基盤・ルーティング・API/Socket クライアントを実装する
    - REST クライアント、Socket.IO クライアント接続、Vonage Video Client SDK 初期化のラッパーを実装する
    - _Requirements: 4.1_

  - [x] 15.2 `react-i18next` による en/ja i18n と言語切替を実装する
    - 英語・日本語の翻訳リソースと言語切替 UI を実装し、Admin_UI・Video_Call_UI で選択言語表示を提供する
    - _Requirements: 6.1, 6.2_

  - [x]* 15.3 i18n 切替のユニットテストを書く
    - en/ja 表示切替が Admin_UI・Video_Call_UI で反映されることを検証する
    - _Requirements: 6.1, 6.2_

- [x] 16. Video_Call_UI の実装
  - [x] 16.1 ビデオ通話画面（レスポンシブ・再接続）を実装する
    - Vonage Video Client SDK で音声・映像の送受信を確立し、CSS（フレックス/グリッド + メディアクエリ）でスマートフォン・PC 対応のレスポンシブ表示を提供する
    - 接続失敗時に失敗メッセージと再接続操作を提示する
    - _Requirements: 4.1, 4.2, 4.4_

  - [x] 16.2 背景スキン選択（`applyBackgroundSkin(skinId)`）を実装する
    - 定義済みスキンセット（病院遠隔診療（telemedicine）テーマを含む）を用意し、`applyBackgroundSkin(skinId)` で選択したスキンを通話画面に適用する
    - _Requirements: 4.3_

  - [x]* 16.3 ビデオ接続失敗 UI のユニットテストを書く
    - 接続失敗時の再接続 UI 表示を検証する
    - _Requirements: 4.4_

  - [x]* 16.4 背景スキン選択適用のユニットテストを書く
    - `applyBackgroundSkin(skinId)` により選択スキン（病院遠隔診療テーマを含む）が通話画面へ適用されることを検証する
    - _Requirements: 4.3_

- [x] 17. Admin_UI の実装
  - [x] 17.1 ログイン・ロール別メニューとレスポンシブ表示を実装する
    - ログイン画面、ロール（管理者/スタッフ）別メニュー表示、レスポンシブレイアウトを実装する
    - _Requirements: 5.1, 5.2, 5.3, 5.5_

  - [x] 17.2 予約管理・画面内通知・録画操作・文字起こし表示を実装する
    - 予約一覧/管理、Socket.IO `reservation:due` の画面内通知表示、録画開始/停止操作と `recording:status` の録画状態表示、話者単位に区別された文字起こし表示を実装する
    - _Requirements: 2.4, 3.3, 7.1, 7.3, 7.5, 8.4_

  - [x] 17.3 Admin_UI の通知・録画・文字起こし表示のユニットテストを書く
    - `reservation:due` 受信時の画面通知表示、録画状態表示、話者単位文字起こし表示を検証する
    - _Requirements: 3.3, 7.5, 8.4_

- [x] 18. 統合テストと最終配線
  - [x]* 18.1 Vonage Messages API Webhook の統合テストを書く
    - 受信〜返信の一連の流れを 1〜3 件の代表例で検証する
    - _Requirements: 1.1, 1.2, 1.4_

  - [x]* 18.2 Vonage Video アーカイブ + 文字起こし取得の統合テストを書く
    - individual アーカイブ開始と Post-Call Transcription 取得を代表例で検証する
    - _Requirements: 7.2, 8.2_

- [x] 19. 最終チェックポイント - すべてのテストが通ることを確認
  - すべてのテストが通ることを確認し、疑問があればユーザーに質問する。

## Notes

- `*` が付いたサブタスクは任意であり、MVP を優先する場合はスキップ可能。
- 各タスクはトレーサビリティのため具体的な要件番号を参照している。
- プロパティテストは設計書の 10 個の Correctness Property を `fast-check`（最低 100 イテレーション）で検証し、各テストに `Feature: vonage-video-reservation, Property {番号}: {本文}` タグを付与する。
- チェックポイントは段階的な検証を保証する。
- ユニット/統合テストはプロパティテストを補完し、例・エッジケース・外部連携を検証する。
- 背景スキン選択（病院遠隔診療テーマを含む）は UI 上の関心事であり、ユニットテスト＋ビジュアルテストで検証する。新たな Correctness Property は追加しない。

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["2.1", "2.2", "3.1", "3.2", "4.1", "4.2", "5.1", "5.2"] },
    { "id": 2, "tasks": ["2.3", "2.4", "3.3", "3.4", "4.3", "4.4", "5.3", "5.4", "7.1"] },
    { "id": 3, "tasks": ["7.2", "9.1", "9.2"] },
    { "id": 4, "tasks": ["7.3", "7.4", "8.1", "9.3", "13.1"] },
    { "id": 5, "tasks": ["8.2", "10.1", "11.1", "12.1", "12.2"] },
    { "id": 6, "tasks": ["10.2", "10.3", "10.4", "11.2", "12.3"] },
    { "id": 7, "tasks": ["15.1", "15.2"] },
    { "id": 8, "tasks": ["15.3", "16.1", "16.2", "17.1"] },
    { "id": 9, "tasks": ["16.3", "16.4", "17.2"] },
    { "id": 10, "tasks": ["17.3", "18.1", "18.2"] }
  ]
}
```
