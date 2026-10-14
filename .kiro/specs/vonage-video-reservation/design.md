# Design Document

## Overview

本設計は、Vonage Video API を中核とした予約機能付きビデオ通話アプリケーションのアーキテクチャを定義する。エンドユーザーは WhatsApp（Vonage Messages API）上のリッチメディア対応チャットボットで予約を行い、予約時刻に WhatsApp 通知と管理者 UI 画面通知を受け取る。管理者・スタッフは RBAC で保護された React SPA の管理者 UI から予約管理・ビデオ通話・録画（アーカイブ）・話者分離文字起こしを操作する。予約データは MongoDB Atlas に永続化される。

技術スタックは以下の通り。

- **バックエンド**: JavaScript / Node.js（Express）、`@vonage/server-sdk` を用いた Vonage Video API / Messages API 連携
- **フロントエンド**: React SPA（スマートフォン・PC 両対応のレスポンシブ設計）、`react-i18next` による英語・日本語 i18n、Vonage Video Client SDK
- **データストア**: MongoDB Atlas（Mongoose ODM）
- **認証・認可**: RBAC（管理者 / スタッフ）、JWT ベースのセッション
- **ビデオ・録画・文字起こし**: Vonage Video API（セッション、individual output mode アーカイブ、Post-Call Transcription）
- **メッセージング**: Vonage Messages API（WhatsApp のインタラクティブメッセージ・メディアテンプレート）
- **リアルタイム通知**: WebSocket（Socket.IO）による管理者 UI 画面内通知

本設計は要件 1〜8 のすべてを網羅する。

### 設計上の重要な前提（Vonage 純正機能の範囲）

Post-Call Transcription は **individual stream archive**（`outputMode: "individual"`）でのみ利用可能であり、composed archive では利用できない。文字起こし結果は単一の JSON として提供され、話者（ストリーム）分離は「別ファイル」ではなく **channel** によって表現される。各セグメントは `channel`（整数）を持ち、`channels_metadata`（各要素の `id` がストリーム ID に対応）で話者へ解決する。本アプリの「話者分離」はこの channel／stream 単位の分離を指し、1 ストリーム内の複数話者分離（speaker diarization）は Vonage 純正 Post-Call Transcription の範囲外として扱う。参加者ごとに個別ストリームを publish する前提で、stream ID とユーザーの対応付けはクライアントトークン生成時の connection data とセッションモニタリングコールバックで行う。

## Architecture

### システム構成

```
┌────────────────┐        ┌──────────────────────────────────────────────┐
│  End_User      │        │            Backend (Node.js / Express)         │
│  (WhatsApp)    │        │                                                │
└──────┬─────────┘        │  ┌─────────────┐  ┌──────────────────────┐    │
       │ WhatsApp          │  │Chatbot_Svc  │  │ Reservation_System   │    │
       │ (Messages API)    │  │(Webhook)    │──│ (予約 CRUD/空き判定) │    │
       ▼                   │  └─────┬───────┘  └──────────┬───────────┘    │
┌────────────────┐  webhook│        │                      │                │
│ Vonage         │────────▶│  ┌─────▼───────┐  ┌───────────▼──────────┐    │
│ Messages API   │◀────────│  │Notification │  │ Reservation_Store    │    │
│ (WhatsApp)     │  send    │  │_Service     │  │ (Mongoose)           │────┼──▶ MongoDB Atlas
└────────────────┘         │  └─────┬───────┘  └──────────────────────┘    │
                           │        │ Socket.IO                            │
┌────────────────┐         │  ┌─────▼───────┐  ┌──────────────────────┐    │
│ Vonage         │◀────────│  │Auth_Service │  │ Recording_Service    │    │
│ Video API      │  REST    │  │(RBAC/JWT)   │  │ Transcription_Service│────┼──▶ Vonage Video API
└──────┬─────────┘         │  └─────────────┘  └──────────────────────┘    │
       │ Client SDK        └───────────────────────┬────────────────────────┘
       ▼                                            │ REST / WebSocket
┌───────────────────────────────────────────────────▼───────────────┐
│                    Frontend (React SPA)                             │
│   Admin_UI (RBAC/予約管理/録画/文字起こし)  │  Video_Call_UI        │
│   i18n (en/ja) ・ レスポンシブ ・ 画面内通知 │  背景スキン選択       │
│                                             │  (病院遠隔診療テーマ含) │
└─────────────────────────────────────────────────────────────────────┘
```

### レイヤー分割

- **プレゼンテーション層（React SPA）**: `Admin_UI` と `Video_Call_UI`。i18n・レスポンシブ・画面内通知を担う。`Video_Call_UI` は病院遠隔診療テーマを含む複数の背景スキンからの選択・適用も担う。トランスポート（REST/WebSocket/Video Client SDK）に依存するが、メッセージ処理・予約ロジックには依存しない。
- **アプリケーション層（Express）**: `Chatbot_Service` / `Reservation_System` / `Notification_Service` / `Auth_Service` / `Recording_Service` / `Transcription_Service`。ビジネスロジックを担う。
- **ドメイン層（純粋ロジック）**: 会話状態遷移、空き判定、認可判定、アーカイブオプション構築、文字起こし整形。副作用を持たない純粋関数として切り出し、プロパティテストの対象とする。
- **インフラ層**: `Reservation_Store`（MongoDB Atlas / Mongoose）、Vonage SDK クライアント、Socket.IO。

### 主要フロー

**予約フロー（要件 1・2・6）**: WhatsApp 受信 → Messages API Webhook → `Chatbot_Service` が会話状態を遷移させインタラクティブメッセージを返信 → 確定時に `Reservation_System` が空き判定 → `Reservation_Store` に保存 → 確定メッセージ送信。

**通知フロー（要件 3）**: スケジューラ（`node-cron`）が定期的に到来予約を検出 → `Notification_Service` が WhatsApp 通知送信と Socket.IO による管理者 UI 通知イベント送出。WhatsApp 送信失敗時も画面通知は継続。

**通話・録画・文字起こしフロー（要件 4・7・8）**: 管理者/スタッフが `Video_Call_UI` でセッション参加 → 管理者 UI から録画開始 → `Recording_Service` が individual output mode かつ `hasTranscription: true` でアーカイブ開始 → 通話終了後 `Transcription_Service` が Post-Call Transcription を取得・整形 → 管理者 UI に話者単位で表示。

## Components and Interfaces

### Chatbot_Service（要件 1・6）

Vonage Messages API の Webhook を受け、会話状態を管理して予約フローを進行する。

- `POST /webhooks/inbound-message`: WhatsApp 受信 Webhook。会話状態と入力から次の遷移を決定。
- `POST /webhooks/message-status`: 送達ステータス Webhook。
- ドメイン関数 `nextStep(state, input) -> { nextState, outMessage }`: 純粋関数。`outMessage` はインタラクティブ（reply button / list）、メディアテンプレート、確定メッセージ等の種別を持つ。
- ドメイン関数 `buildReservationDTO(completedState) -> ReservationDTO`: 完了した会話状態から予約 DTO を構築。
- 送信は保存レコードの `language`（en/ja）に応じてメッセージ本文を選択（要件 6.3）。

### Reservation_System（要件 1・2・6）

予約の作成・更新・キャンセル・照会と空き判定を担う。

- `createReservation(dto)` / `updateReservation(id, patch)` / `cancelReservation(id)`
- `listReservations(filter)`: `Admin_UI` 用一覧取得。
- ドメイン関数 `checkAvailability(existing[], requestedSlot) -> { available, alternatives[] }`: 純粋関数。重複時は代替候補を返す（要件 1.5）。
- ドメイン関数 `validateReservation(record) -> Result`: 必須フィールド（予約 ID、連絡先、予約時刻、対象サービス、状態、対応言語）と `language ∈ {en, ja}` を検証（要件 2.2・6.4）。

### Reservation_Store（要件 2）

MongoDB Atlas 上の永続化層。Mongoose Repository として実装。

- `save(record)` / `findById(id)` / `find(filter)` / `updateStatus(id, status)`
- 接続・書込失敗時は例外を送出し、`Reservation_System` がエラー記録と失敗応答へ変換（要件 2.3）。

### Notification_Service（要件 3）

- スケジューラ `pollDueReservations()`: 一定間隔で実行。
- ドメイン関数 `selectDueReservations(reservations[], now) -> due[]`: 純粋関数。`reservationTime <= now` かつ `notified == false` のものを抽出（要件 3.1・3.2）。
- `notify(reservation)`: WhatsApp 通知送信（Messages API）と Socket.IO イベント `reservation:due` 送出。WhatsApp 失敗時もイベント送出は継続し、失敗を記録（要件 3.4）。

### Auth_Service（要件 5）

- `POST /auth/login`: 認証し JWT を発行、ロール（管理者/スタッフ）を判定。
- Express ミドルウェア `authorize(action)`: 各保護エンドポイントに適用。
- ドメイン関数 `canAccess(role, action, ownership) -> boolean`: 純粋関数。管理者は全許可、スタッフは自身に割り当てられた予約のみ許可、それ以外は拒否（要件 5.2・5.3・5.4）。

### Recording_Service / Transcription_Service（要件 7・8）

Vonage Video API のアーカイブと Post-Call Transcription を扱う。

- `startRecording({ sessionId, withTranscription, primaryLanguageCode })`
- `stopRecording(archiveId)`
- ドメイン関数 `buildArchiveOptions(req) -> ArchiveOptions`: 純粋関数。`withTranscription === true` の場合、必ず `outputMode: "individual"`・`hasAudio: true`・`hasTranscription: true` を設定（要件 7.2・8.1）。
- `fetchTranscription(archiveId) -> RawTranscriptionJson`: 文字起こし取得（要件 8.2）。
- ドメイン関数 `groupBySpeaker(rawJson) -> SpeakerTranscript[]`: 純粋関数。`segments[].channel` と `channels_metadata`（`id` = stream ID）を用いて発話を話者単位に対応付ける（要件 8.3）。
- 録画状態変化は Socket.IO `recording:status` で `Admin_UI` に通知（要件 7.4・7.5・8.5）。

### Video_Call_UI（要件 4・6）

- Vonage Video Client SDK で音声・映像を送受信（要件 4.1）。
- CSS（フレックス/グリッド + メディアクエリ）でスマートフォン・PC 対応のレスポンシブ表示（要件 4.2）。
- 背景スキン選択機能 `applyBackgroundSkin(skinId)`: 定義済みの背景スキン集合（病院遠隔診療テーマを含む複数の選択肢）から、エンドユーザーが選択したスキンを通話画面に適用する（要件 4.3）。
- 接続失敗時は失敗メッセージと再接続操作を提示（要件 4.4）。
- i18n により選択言語で表示（要件 6.2）。

### Admin_UI（要件 3・5・6・7・8）

- ログイン・ロール別メニュー表示、レスポンシブ表示（要件 5.1・5.5）。
- Socket.IO 受信 `reservation:due` を画面内通知として表示（要件 3.3）。
- 録画開始/停止操作と録画状態表示（要件 7.1・7.3・7.5）。
- 話者単位に区別された文字起こし表示（要件 8.4）。
- `react-i18next` による選択言語表示（要件 6.1）。

### バックエンド API 概要

| メソッド | パス | 説明 | 認可 |
|---|---|---|---|
| POST | `/webhooks/inbound-message` | WhatsApp 受信 | Vonage 署名検証 |
| POST | `/auth/login` | ログイン・ロール判定 | 公開 |
| GET | `/reservations` | 予約一覧取得 | 管理者/スタッフ（範囲制限） |
| POST | `/reservations` | 予約作成 | 管理者/スタッフ |
| PATCH | `/reservations/:id` | 予約更新/キャンセル | 管理者/スタッフ（所有） |
| POST | `/sessions/:id/token` | Video トークン発行 | 管理者/スタッフ |
| POST | `/recordings/start` | 録画開始 | 管理者/スタッフ |
| POST | `/recordings/:archiveId/stop` | 録画停止 | 管理者/スタッフ |
| GET | `/transcriptions/:archiveId` | 話者分離文字起こし取得 | 管理者/スタッフ |

## Data Models

### Reservation（予約レコード / 要件 2.2）

```javascript
// Mongoose schema（概念）
const ReservationSchema = new Schema({
  reservationId: { type: String, required: true, unique: true }, // 予約 ID
  contact:       { type: String, required: true },  // エンドユーザー連絡先（WhatsApp 番号）
  reservationTime:{ type: Date,  required: true },  // 予約時刻
  service:       { type: String, required: true },  // 対象サービス
  status: { type: String, enum: ['pending','confirmed','cancelled','completed'], required: true }, // 予約状態
  language:      { type: String, enum: ['en','ja'], required: true }, // 対応言語
  notified:      { type: Boolean, default: false }, // 予約時刻通知済みフラグ
  sessionId:     { type: String },                  // 紐づく Vonage セッション ID
  assignedStaffId:{ type: String },                 // 担当スタッフ（スタッフ権限判定用）
  createdAt: Date, updatedAt: Date,
});
```

### User（管理者/スタッフ / 要件 5）

```javascript
const UserSchema = new Schema({
  userId:   { type: String, required: true, unique: true },
  role:     { type: String, enum: ['administrator','staff'], required: true },
  passwordHash: { type: String, required: true },
});
```

### ArchiveOptions（録画オプション / 要件 7・8）

```javascript
// buildArchiveOptions の出力（Vonage Video API へ渡す）
{
  sessionId: string,
  hasAudio: true,
  hasVideo: true,
  outputMode: 'individual',            // 文字起こし要時は必ず individual
  hasTranscription: true,              // Post-Call Transcription 有効化
  transcriptionProperties: { primaryLanguageCode: 'ja-JP' | 'en-US' },
  name: string,
}
```

### SpeakerTranscript（整形後文字起こし / 要件 8.3）

```javascript
// groupBySpeaker の出力
[
  {
    channel: number,          // 音声チャンネル番号
    streamId: string,         // channels_metadata.id（ストリーム = 話者）
    speakerLabel: string,     // stream ID から解決した表示名
    segments: [ { start: number, end: number, text: string } ],
  },
  // ...
]
```

## Error Handling

- **Reservation_Store 接続/書込失敗（要件 2.3）**: リポジトリが例外を送出。`Reservation_System` は失敗をログ記録し、呼び出し元（Chatbot / Admin API）へ失敗応答（HTTP 5xx / 構造化エラー）を返す。
- **予約枠確保不可（要件 1.5）**: `checkAvailability` が `available: false` を返した場合、`Chatbot_Service` は予約不可メッセージと代替候補（インタラクティブメッセージ）を WhatsApp で提示。
- **WhatsApp 通知失敗（要件 3.4）**: `Notification_Service` は送信失敗を記録した上で、Socket.IO による管理者 UI 通知イベント送出を継続する（部分的失敗を許容）。
- **ビデオ接続失敗（要件 4.4）**: `Video_Call_UI` は接続エラーを検知し、失敗メッセージと再接続ボタンを表示。
- **認可エラー（要件 5.4）**: `authorize` ミドルウェアが `canAccess` の判定に基づき拒否し、HTTP 403（認可エラー）を返す。
- **録画開始失敗（要件 7.4）**: `Recording_Service` は Vonage API 失敗を捕捉し、`recording:status` で管理者 UI に失敗を通知、失敗内容を記録。
- **文字起こし生成/取得失敗（要件 8.5）**: `Transcription_Service` は失敗を記録し、Socket.IO で管理者 UI に失敗状態を通知。
- **Webhook 署名検証**: Vonage Messages Webhook は JWT/署名検証で改ざん・なりすましを防止。外部入力は信頼できないデータとして検証・サニタイズする。

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system-essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

### Property 1: 会話遷移は常に有効な状態と選択肢を返す

*For any* 有効な会話状態と任意のユーザー入力について、`nextStep` は有効な次の会話状態と、種別が定義済みのインタラクティブメッセージ（reply button / list / メディアテンプレート / 確定）を返す。

**Validates: Requirements 1.1**

### Property 2: 完了会話からの予約 DTO は必須フィールドを備える

*For any* 予約完了状態の会話について、`buildReservationDTO` が生成する予約 DTO は連絡先・予約時刻・対象サービス・対応言語のすべてを含む。

**Validates: Requirements 1.2, 1.3**

### Property 3: 空き判定は重複時に必ず代替を提示する

*For any* 既存予約集合と任意の希望予約枠について、`checkAvailability` は希望枠が既存予約と重複するとき `available: false` と 1 つ以上の非重複な代替候補を返し、重複しないときのみ `available: true` を返す。

**Validates: Requirements 1.5**

### Property 4: 予約レコードの保存・取得ラウンドトリップ

*For any* 有効な予約レコードについて、`Reservation_Store` に保存してから同一 ID で取得すると、保存したレコードと等価なレコードが返る。

**Validates: Requirements 2.1, 2.4**

### Property 5: 予約レコードのバリデーション

*For any* 予約レコードについて、`validateReservation` は必須フィールドがすべて存在し `language ∈ {en, ja}` の場合にのみ検証を通過し、いずれかが欠落または不正な言語の場合は拒否する。

**Validates: Requirements 2.2, 6.4**

### Property 6: 到来予約の選択は期限到来かつ未通知に限定される

*For any* 予約集合と任意の現在時刻について、`selectDueReservations` が返す集合は、`reservationTime <= now` かつ `notified == false` である予約と厳密に一致する。

**Validates: Requirements 3.1, 3.2**

### Property 7: 認可判定はロールと所有関係に整合する

*For any* ロール・操作・所有関係の組について、`canAccess` は管理者にはすべての操作を許可し、スタッフには自身に割り当てられた予約に対する操作のみを許可し、それ以外はすべて拒否する。

**Validates: Requirements 5.1, 5.2, 5.3, 5.4**

### Property 8: WhatsApp 送信言語は予約の対応言語と一致する

*For any* 予約について、`Chatbot_Service` が送信する WhatsApp メッセージの言語は、その予約レコードに保存された対応言語（en/ja）と一致する。

**Validates: Requirements 6.3**

### Property 9: 文字起こし要時のアーカイブは必ず個別ストリームで有効化される

*For any* 録画開始要求について、文字起こしを伴う場合（`withTranscription === true`）、`buildArchiveOptions` の出力は必ず `outputMode === 'individual'` かつ `hasTranscription === true` かつ `hasAudio === true` を満たす。

**Validates: Requirements 7.2, 8.1**

### Property 10: 文字起こし整形は全発話を保存し話者に対応付ける

*For any* 有効な Post-Call Transcription JSON について、`groupBySpeaker` の出力に含まれる発話セグメントは元 JSON の全セグメントと過不足なく一致し、各セグメントは `channels_metadata` で解決可能な話者（stream ID）に対応付けられる。

**Validates: Requirements 8.3**

## Testing Strategy

*A property is a characteristic or behavior that should hold true across all valid executions of a system-essentially, a formal statement about what the system should do.*

本機能は、ユニットテストとプロパティベーステストを併用する二重テスト戦略を採用する。

### プロパティテスト

- ライブラリ: `fast-check`（JavaScript）。
- 各プロパティテストは最低 100 回のイテレーションを実行する。
- 各テストは対応する設計プロパティを次のタグ形式で参照する: **Feature: vonage-video-reservation, Property {番号}: {プロパティ本文}**。
- 対象（純粋ドメインロジック）:
  - Property 1・2（会話状態遷移・予約 DTO 構築）
  - Property 3（空き判定・代替提示）
  - Property 4（Reservation_Store のラウンドトリップ。インメモリ Mongo / テストコンテナを使用）
  - Property 5（予約バリデーション）
  - Property 6（到来予約の選択ロジック）
  - Property 7（認可判定 `canAccess`）
  - Property 8（送信言語のマッピング）
  - Property 9（アーカイブオプション構築）
  - Property 10（文字起こし整形パーサ。パーサ／整形は不変条件が破れやすいため round-trip 的検証を必須とする）

### ユニットテスト（例・エッジケース・エラー条件）

- 予約確定時に確定メッセージ送信が呼ばれること（モック、要件 1.4）。
- リッチメディア（メディアテンプレート/カルーセル）メッセージの組立（要件 1.6）。
- `Reservation_Store` 書込失敗時に失敗応答へ変換されること（例外注入、要件 2.3）。
- WhatsApp 通知失敗時も画面通知イベントが送出されること（要件 3.4）。
- 管理者 UI が `reservation:due` を受信し画面通知を表示すること（要件 3.3）。
- 選択された背景スキン（病院遠隔診療テーマを含む）が通話画面に適用されること（要件 4.3）。
- ビデオ接続失敗時の再接続 UI 表示（要件 4.4）。
- 録画開始/停止/失敗通知/状態表示（要件 7.1・7.3・7.4・7.5）。
- 話者単位に区別された文字起こしの管理者 UI 表示（要件 8.4）。
- i18n による en/ja 表示切替（要件 6.1・6.2）。

### 統合テスト（外部サービス連携・少数の代表例）

- Vonage Messages API Webhook 受信〜返信の一連（要件 1）。
- Vonage Video API での individual アーカイブ開始と Post-Call Transcription 取得（要件 8.2）。1〜3 件の代表例で検証し、外部サービス挙動の網羅は目的としない。

### レスポンシブ・UI の視覚検証

- レイアウトの視覚要件（要件 4.2・5.5）はスナップショットテストおよび主要ブレークポイント（スマートフォン幅・PC 幅）での目視確認で担保する。プロパティテストの対象外とする。
