# Vonage Video Reservation

Vonage Video API を中核とした予約機能付きビデオ通話アプリケーション。

- **backend/**: Node.js / Express、Vonage Video & Messages API、MongoDB Atlas (Mongoose)、Socket.IO、node-cron、JWT/RBAC
- **frontend/**: React SPA、react-i18next (en/ja)、Vonage Video Client SDK、Socket.IO client

## 主な機能

| 機能 | 説明 |
|------|------|
| **WhatsApp 予約フロー** | reply button / list / carousel などインタラクティブメッセージでサービス・日時選択、確認 OK / 修正選択、確定時に入室リンク自動埋め込み |
| **時間スロット制御** | 09:00 / 10:30 / 14:00 / 15:30 の固定枠。当日枠を絞り込み、候補が空なら複数日候補を提示（現行の制約は末尾参照） |
| **リマインダー通知** | 確定予約の 24 時間以内・10 分以内をそれぞれ定期確認。10 分以内の通知は入室 URL ボタンと管理画面通知付き |
| **予約時刻到来通知** | 予約時刻になったら WhatsApp（入室リンク付き）+ 管理画面 Socket.IO で通知 |
| **入室リンク（ワンタイム）** | `/join/:tokenId` ページが `POST /sessions/join/:tokenId` でリンクを消費し、ゲストトークンを取得して `/call/:sessionId` へ遷移。同じリンクの再利用は不可 |
| **確認画面強化** | 予約内容表示、確認 OK / 修正ボタン、修正時はサービス選択へ戻る |
| **多言語対応** | 英語・日本語に対応。WhatsApp の既定は日本語、Web UI の初期言語は英語（選択を保存）。チャット開始時に言語選択肢を表示 |
| **管理画面** | 予約管理・通知・録画・文字起こし・テストリンク生成（管理者トークン / ユーザー用ワンタイム URL） |
| **RBAC** | administrator / staff ロールと担当者一致判定を実装。ただしスタッフ用 API・Socket.IO の制約は末尾参照 |
| **ビデオ通話** | レスポンシブ UI、背景スキン、画面共有（管理者のみ）、再接続・ハングアップ |
| **録画・文字起こし** | ゲスト入室時の自動録画、全員退室時の停止・会議室終了、個別ストリーム単位の文字起こし |

## セットアップ

リポジトリルートで実行します。**Node.js 24 LTS を推奨**します。ルートの `engines` は `>=20.0.0` ですが、現在の lockfile の Vite 8 は `^20.19.0 || >=22.12.0`、Vitest 5 は `^22.12.0 || ^24.0.0 || >=26.0.0` が必要です。Node.js 20.0〜20.18 ではフロントエンドの現行ツールを実行できません。

```bash
npm ci
cp backend/.env.example backend/.env
```

`backend/.env` に以下を設定します（詳細は [backend/.env.example](backend/.env.example)）。

| 設定 | 用途 |
|---|---|
| `MONGODB_URI` / `MONGODB_DB_NAME` | MongoDB 接続。DB 名の既定は `video_reservation` |
| `JWT_SECRET` / `JWT_EXPIRES_IN` | 管理画面の JWT 署名鍵と有効期限（既定 `1h`） |
| `VONAGE_VIDEO_APPLICATION_ID` / `VONAGE_VIDEO_PRIVATE_KEY_PATH` | Video セッション作成・トークン・録画。相対鍵パスは `backend/` 基準 |
| `VONAGE_API_KEY` / `VONAGE_API_SECRET` / `VONAGE_APPLICATION_ID` / `VONAGE_PRIVATE_KEY_PATH` / `VONAGE_WHATSAPP_FROM` | Messages API の認証情報と WhatsApp 送信元。使用する Application / Sandbox に合わせて設定 |
| `PUBLIC_APP_URL` | 利用者が開く公開 URL。トンネル設定後に指定 |
| 3 種類の署名シークレット | 後述の Webhook 署名検証。本番では必須 |

MongoDB の接続許可と Vonage の各機能も設定してください。秘密鍵と `.env` はコミットしないでください。

## スクリプト

- `npm run dev:backend` — バックエンド開発サーバー起動
- `npm run dev:frontend` — フロントエンド開発サーバー起動
- `npm run build:frontend` — フロントエンドを `frontend/dist` にビルド
- `npm run start --workspace=backend` — バックエンド通常起動（watch なし）
- `npm run seed:user --workspace=backend -- --help` — アカウント作成 CLI のヘルプ
- `npm run test:backend` — バックエンドの Jest テスト
- `npm run test:frontend` — フロントエンドの Vitest テスト
- `npm test` — 両ワークスペースのテスト

テスト件数・成功数は固定値として記載しません。HTTP 統合テストでも Vonage / MongoDB 等をモック・スタブに置き換えるものがあり、「統合テストは実 Vonage 環境が必須」とは限りません。実際の配信・通話・録画確認は別途、[手動 E2E 手順](docs/manual-e2e-recording-transcription.md)を参照してください。

## アーキテクチャ

- ドメイン層（純粋関数）: `backend/src/domain/`
- アプリケーション層: `backend/src/services/`
- インフラ層: `backend/src/infra/`

英語版の [Marp スライド](docs/architecture-overview.marp.md)、[PowerPoint](docs/architecture-overview.pptx)、[日本語版 PowerPoint](docs/architecture-overview.ja.pptx) も参照できます。

## ローカル開発での Vonage Webhook 設定（Cloudflare Tunnel）

Vonage の Messages API（WhatsApp）はローカルの `localhost` に直接 Webhook を届けられないため、公開 HTTPS トンネルが必要です。ここではアカウント不要で使える Cloudflare のクイックトンネルを使います。

### Webhook エンドポイント（本アプリの実装）

バックエンドは `PORT=4000`（既定）で以下の 4 つの Webhook を公開します。

| 種別 | パス | メソッド |
|---|---|---|
| Inbound（受信） | `/webhooks/inbound-message` | POST |
| Status（送達ステータス） | `/webhooks/message-status` | POST |
| **Video Session Monitoring** | `/webhooks/video-events` | POST |
| **Video Archive Monitoring** | `/webhooks/video-archive-events` | POST |

### 手順

1. 上記セットアップと `backend/.env` の設定を済ませる。バックエンドは以下の手順で一度だけ起動します。

2. フロントエンドをビルドし、バックエンドを起動する。

   入室リンク `/join/:tokenId` は SPA のクライアントサイドルートで、HTML ファイルは存在しません。バックエンドが**ビルド済みフロントも配信する**（history fallback 付き）ため、先にビルドします。

   ```bash
   # フロントをビルド（backend が frontend/dist を配信する）
   npm run build:frontend

   # バックエンドを起動
   npm run dev:backend
   # ヘルスチェック: curl http://localhost:4000/health
   # 入室ページ: curl -I 'http://localhost:4000/join/example-token' → 200 text/html
   ```

   > `frontend/dist` が無い場合、バックエンドは SPA を配信しません（開発中は Vite dev server が担当）。
   > コードを変更したら `npm run build:frontend` を再実行してください。
   > `/health` と `/api/health` は HTTP サーバーの稼働確認用です。MongoDB 接続失敗時もサーバーは起動するため、DB・Vonage の利用可能性までは保証しません。

3. `cloudflared` をインストールしてクイックトンネルを起動する（ログイン・ドメイン設定は不要）。

   **バックエンド（4000）をそのまま公開**します。API と SPA の両方がこの 1 本のトンネル経由で到達できます。

   ```bash
   # macOS
   brew install cloudflared

   # 4000 番ポートを公開（API + SPA の両方）
   cloudflared tunnel --url http://localhost:4000
   ```

   実行すると `https://<ランダム>.trycloudflare.com` 形式の公開 URL が表示されます。

   表示された URL を `backend/.env` に設定して、バックエンドを再起動します：

   ```bash
   # backend/.env
   PUBLIC_APP_URL=https://<ランダム>.trycloudflare.com
   ```

4. Vonage ダッシュボードの Application で Messages capability を有効にし、表示された公開 URL を使って以下を設定する（Application を使わず WhatsApp サンドボックスでテストする場合は、Messages API Sandbox 画面にも同じ 2 つの URL を登録する）。

   - **Inbound URL**: `https://<ランダム>.trycloudflare.com/webhooks/inbound-message`
   - **Status URL**: `https://<ランダム>.trycloudflare.com/webhooks/message-status`

5. バックエンドの起動ログに以下が表示されることを確認する。

   ```
   [backend] public app url: https://<ランダム>.trycloudflare.com
   ```

   `警告: PUBLIC_APP_URL が…` が出る場合は設定が漏れています（この状態では入室リンクの発行が fail-closed で拒否されます）。

6. WhatsApp から任意のメッセージを送り、ボットの返信や処理ログを確認する。組み込みの HTTP アクセスログはありません。**予約フローの開始に特定のキーワードは不要**です（例:「予約」「こんにちは」）。

Messages API Sandbox を使う場合は、`VONAGE_MESSAGES_API_HOST=https://messages-sandbox.nexmo.com` と `WHATSAPP_INTERACTIVE_FALLBACK_TEXT=true` を設定します。後者はインタラクティブ送信をテキストに変換する設定であり、番号返信を選択肢 ID に変換する入力処理はありません。Sandbox のテキスト返信だけで本番と同じ予約操作ができるとは限りません。

### 入室リンクの公開 URL（PUBLIC_APP_URL）

`CLIENT_ORIGIN`（CORS 許可用）とは別に、**利用者が実際に開く URL** を `PUBLIC_APP_URL` で指定します。両者は用途が違います。

| 環境 | `PUBLIC_APP_URL` の値 | 備考 |
|---|---|---|
| テスト | `https://<ランダム>.trycloudflare.com` | Cloudflare クイックトンネル。**再起動ごとに変わる**ので `.env` を更新してバックエンドを再起動する |
| 本番 | `https://<デプロイドメイン>` | アプリケーションの公開 URL |

- 末尾スラッシュはリンク組み立て時に除去されます。URL のサブパスは文字列として保持されますが、React Router の `basename` 等は未設定です。標準構成では公開 URL のルートで配信してください。
- 未設定・ループバック（`localhost` / `127.0.0.1` 等）・不正 URL・HTTP(S) 以外では、**入室リンクの発行を拒否**します。新しい入室トークンは保存されず、バックエンド起動時にも警告が出ます。この検証はリンク発行時のもので、消費 API の条件ではありません。
- `.env` ファイルの変更には再起動が必要です。リンク発行サービスは実行時の `process.env.PUBLIC_APP_URL` を都度参照しますが、起動ログと CORS 設定は起動時の値を使用します。

### フロントエンドの配信（SPA history fallback）

入室リンクの `/join/:tokenId` は React Router のクライアントサイドルートで、対応する HTML ファイルは存在しません。バックエンドはビルド済みフロント（`frontend/dist`）を配信し、API 以外の未知パスには `index.html` を返します（history fallback）。

- **先に `npm run build:frontend` を実行**してください。`frontend/dist` が無い場合、バックエンドは SPA を配信しません。
- `/api` `/auth` `/sessions` `/reservations` `/recordings` `/transcriptions` `/webhooks` `/monitoring` `/health` `/socket.io` は SPA の history fallback 対象外です（API の JSON 応答や 401/403/404 等を維持します）。
- フロントの API ベース URL は**同一オリジン**（`VITE_API_BASE_URL` 未設定 = 相対パス）です。バックエンドと同じオリジンで配信されるため、利用者のスマホが `localhost` を参照せずに済みます。
- Vite dev server（5173）の現行 proxy には `/reservations` と `/socket.io`（WebSocket）が含まれていません。フロントとバックエンドを分ける場合は、`frontend/.env.local` に `VITE_API_BASE_URL=http://localhost:4000` を設定して Vite を再起動し、`CLIENT_ORIGIN` をフロントのオリジンに合わせてください。スマホからは端末から到達可能な HTTPS バックエンド URL が必要です。通常のトンネル動作確認には上記の同一オリジン構成を推奨します。

### 管理者アカウントの作成（初回のみ）

管理者 UI にログインするには、`users` コレクションに bcrypt ハッシュ済みのユーザーが必要です。**登録用 API は用意されていない**ため、CLI で投入します。

パスワードをコマンド引数やコマンド文字列に直接書かず、**非表示入力から一時的な環境変数で渡します**（以下は Bash 用）。

```bash
read -r -s -p 'Password (12+ characters): ' USER_SEED_PASSWORD
printf '\n'
export USER_SEED_PASSWORD
npm run seed:user --workspace=backend -- --id admin --role administrator
unset USER_SEED_PASSWORD
```

既存ユーザーのパスワードを再設定する場合は、入力をやり直し、CLI 呼び出しを `npm run seed:user --workspace=backend -- --id admin --force` に置き換えます。

| 引数 | 説明 |
|---|---|
| `--id <userId>` | ログイン ID（必須・空白なし・一意） |
| `--role <role>` | `administrator` / `staff`（既定 `administrator`） |
| `--force` | 既存ならパスワードのみ再設定。不在なら `administrator` として新規作成（`--role` は適用されない） |
| `--help` | 使い方を表示する |

- DB に保存されるのは bcrypt ハッシュのみです。CLI は入力環境変数を読み取った後に自プロセスの `process.env` から削除しますが、メモリの安全な消去を保証するものではありません。
- `--force` はロール（権限）を変更しません。既存の権限はそのまま維持されます。
- パスワードの最小文字数は 12（`domain/validateUserInput.js` の `MIN_PASSWORD_LENGTH`）。

### 管理者パスワードの保管場所・方式

| 項目 | 詳細 |
|------|------|
| **保存先** | MongoDB の `users` コレクション。DB 名は `MONGODB_DB_NAME`（既定 `video_reservation`） |
| **ドキュメント例** | `{ "_id": ObjectId("..."), "userId": "admin", "passwordHash": "$2a$12$...", "role": "administrator" }` |
| **ハッシュ方式** | **bcrypt（cost = 12）**（`$2a$12$...` 形式） |
| **平文の扱い** | CLI が環境変数から読み込み、ハッシュ化して DB に保存。平文は DB へ保存しない |
| **ログ・環境変数** | アプリは平文をログ出力しない。環境変数は一時入力であり、親シェルからの削除や履歴・プロセス環境への露出防止は実行者側の管理が必要 |

> **注意**: `backend/.env` に管理者パスワードを書き込まないでください。コマンド文字列にパスワードを直書きすると、環境変数経由でもシェル履歴に残る可能性があります。実行後は親シェルでも `unset USER_SEED_PASSWORD` してください。

### 注意点

- クイックトンネルの URL は**起動ごとに変わります**。再起動時は `PUBLIC_APP_URL` と、Messages / Video の全 4 Webhook URL を更新してください。固定 URL が必要な場合は Cloudflare アカウントで Named Tunnel（`cloudflared tunnel create` + 独自ドメインへのルート）を作成します。
- **署名検証**: Vonage の各機能はそれぞれ独立した署名シークレットを使用します。本番ではすべて設定必須。

  | 機能 | 環境変数 | Vonage ダッシュボード設定箇所 |
  |---|---|---|
  | Messages API (WhatsApp) | `VONAGE_MESSAGES_SIGNATURE_SECRET` | Settings → Signed Webhooks |
  | Video Session Monitoring | `VONAGE_VIDEO_SESSION_MONITORING_SIGNATURE_SECRET` | Application → Video → Session Monitoring |
  | Video Archive Monitoring | `VONAGE_VIDEO_ARCHIVE_MONITORING_SIGNATURE_SECRET` | Application → Video → Archiving → Configure Callback URL |

  未設定（空値）の場合は署名検証をスキップします（ローカル開発向け。本番では必ず設定）。`NODE_ENV=production` で未設定の場合は **fail-closed（503 拒否）** になります。

- Messages API の Webhook は常に `POST`・JSON ボディで届きます。

### 画面共有（Chrome タブ / Safari 等）について

本アプリの管理者画面「資料/画面共有」ボタンは、Vonage Video SDK の `videoSource: 'screen'` を使用しています。
内部ではブラウザ標準の `navigator.mediaDevices.getDisplayMedia()` を呼び出しています。

**本アプリは拡張機能の連携ではなく、SDK の画面キャプチャを使用します。**

本アプリに拡張機能の登録処理はありません。共有できる画面・ウィンドウ・タブの種類は、利用するブラウザ・OS・Vonage SDK の対応状況によって異なります。特にモバイルや Safari で、デスクトップ Chrome と同じ共有機能が使えるとは限りません。

**注意点**:
- 共有対象はブラウザの選択画面に表示された項目から選んでください
- HTTPS 必須（`getDisplayMedia` は安全なコンテキストでのみ動作）。開発時も Cloudflare Tunnel 等で HTTPS 化してください

### ローカル直叩きのスモークテスト（署名検証を空にしている前提）

```bash
curl -s -X POST http://localhost:4000/webhooks/inbound-message \
  -H 'content-type: application/json' \
  -d '{"from":"1234567890","text":"予約"}'
```

> `text` の値は例です。**予約フローの起動に特定のキーワードは不要**で、初回メッセージは内容を問いません（統合テスト等で「予約」を用いているのは慣例・サンプルです）。

この確認は `NODE_ENV=production` 以外で署名シークレットが空の場合に限ります。ローカルへの HTTP リクエストでも、通常のボット処理が実際の WhatsApp 返信を試みます。`from` は自分が管理するテスト宛先に置き換え、返信確認には Messages API の認証情報・送信元設定を用意してください。

## Vonage Video Application の設定（今回利用する機能）

本アプリの Video 機能は **サーバー側 SDK 呼び出しに加え、Vonage Video のコールバック（Webhook）を受信**します。特に **ゲスト入室時の自動録画開始と、会議終了時の録画停止は Session Monitoring コールバックに依存**するため、Vonage ダッシュボードでコールバック URL を必ず設定してください。認証情報（Application ID + 秘密鍵）だけでは自動録画は動作しません。

### 今回 Video API で利用する機能と実装方式

| 機能 | 実装方式 | Webhook 要否 |
|---|---|---|
| セッション作成・トークン発行 | `createSession` / `generateClientToken`（connection data に userId/role を埋め込み、話者⇔ストリーム対応付け） | 不要 |
| 会議室ライフサイクル | `POST /webhooks/video-events`（Session Monitoring）: `connectionCreated` → ゲスト入室で自動録画開始、`connectionDestroyed` → 全員退室で録画停止・会議室無効化 | **必須** |
| 録画（アーカイブ）開始/停止 | 自動制御または `POST /recordings/start` / `POST /recordings/:archiveId/stop` で SDK 呼び出し。Archive Monitoring は状態通知・後処理を担当 | 状態のリアルタイム反映に推奨 |
| 話者分離文字起こし | 個別ストリームアーカイブ（`outputMode: individual` + `hasTranscription`）。`available` / `uploaded` コールバックで自動取得、または `GET /transcriptions/:archiveId` で取得し `groupBySpeaker` で整形 | 自動取得に推奨 |

### コールバック URL について（本アプリで実装済み）

Vonage Video Application には **Capabilities → Video** 内に以下のコールバック URL 欄があります。

| 機能 | パス | 本アプリでの実装 |
|---|---|---|
| **Session Monitoring** | `/webhooks/video-events` | ✅ 実装済み（`connectionCreated` / `connectionDestroyed` で会議室ライフサイクル管理） |
| **Archive Monitoring** | `/webhooks/video-archive-events` | ✅ 状態通知。`available` / `uploaded` で文字起こし取得、`stopped` で停止処理を確認、`failed` で失敗を記録 |

本アプリは **両方を実装** しています。Vonage ダッシュボードでそれぞれのコールバック URL を設定してください。

### 設定手順（ダッシュボード）

1. [Vonage API Dashboard](https://dashboard.nexmo.com/) → **Applications** → Video を有効化したアプリを選択。
2. **Capabilities → Video** を有効にする。
3. **Session Monitoring** セクションで Callback URL を設定：

   - URL: `https://<公開URL>/webhooks/video-events`
   - Signature Secret: `VONAGE_VIDEO_SESSION_MONITORING_SIGNATURE_SECRET` と同じ値

4. **Archiving** セクションで Callback URL を設定：

   - URL: `https://<公開URL>/webhooks/video-archive-events`
   - Signature Secret: `VONAGE_VIDEO_ARCHIVE_MONITORING_SIGNATURE_SECRET` と同じ値

5. アプリの **Application ID** と **秘密鍵（private key）** を取得し、`backend/.env` に設定する。

    ```bash
    VONAGE_VIDEO_APPLICATION_ID=<Video を有効にした Application ID>
    VONAGE_VIDEO_PRIVATE_KEY_PATH=./vonage_video_private.key   # ダウンロードした秘密鍵のパス
    ```

    > Messages（WhatsApp）と Video を同一 Application にまとめることも、別々の Application に分けることも可能です。分ける場合は Messages 用（`VONAGE_APPLICATION_ID` / `VONAGE_PRIVATE_KEY_PATH`）と Video 用（`VONAGE_VIDEO_APPLICATION_ID` / `VONAGE_VIDEO_PRIVATE_KEY_PATH`）をそれぞれ設定します。

---

## 通知スケジューラ設定（Notification Scheduler）

バックエンドは `node-cron` で以下の 3 種類の通知を定期確認します。指定した時刻ちょうどの配信を保証するものではなく、次回のポーリングで処理します。

### 1. 予約時刻到来通知（`reservation:due`）
- **スケジュール**: `NOTIFICATION_CRON`（既定: 毎分 `* * * * *`）
- **対象**: `reservationTime <= now` かつ `notified !== true`。現行コードでは予約状態による除外がなく、キャンセル済み・完了済みでも条件を満たせば対象になります
- **動作**: WhatsApp 送信（入室リンク付き）+ Socket.IO `reservation:due` イベント送出
- **二重防止**: 送信後に `notified = true` に更新

### 2. 事前リマインダー（`reservation:reminder`）
- **スケジュール**: `NOTIFICATION_REMINDER_CRON`（既定: 毎時 0 分 `0 * * * *`）
- **対象**: `reservationTime > now` かつ `reservationTime - now <= windowMs` かつ `reminderSent !== true` かつ `status === 'confirmed'`
- **ウィンドウ**: `NOTIFICATION_REMINDER_WINDOW_MS`（既定: 24 時間 = 86400000 ms）
- **動作**: WhatsApp 送信（入室リンクなし）+ Socket.IO `reservation:reminder` イベント送出。ただし現行 AdminPage はこのイベントを購読していません
- **二重防止**: 送信後に `reminderSent = true` に更新

### 3. 10 分以内リマインダー（`reservation:tenMinReminder`）
- **スケジュール**: `NOTIFICATION_TEN_MIN_REMINDER_CRON`（既定: 毎分 `* * * * *`）
- **対象**: `status === 'confirmed'`、`tenMinReminderSent !== true`、`0 < reservationTime - now <= windowMs`
- **ウィンドウ**: `NOTIFICATION_TEN_MIN_REMINDER_WINDOW_MS`（既定: 600000 ms = 10 分）。「10 分前 ± 5 分」ではありません
- **動作**: WhatsApp の入室 URL ボタン（`cta_url`、Sandbox フォールバック時はテキスト URL）+ 管理画面イベント。ブラウザ通知は対応・許可された環境のみ
- **二重防止**: `tenMinReminderSent = true` に更新。24 時間以内のフラグとは独立

管理画面の手動再通知は `POST /reservations/:id/resend-notification` から新しい入室リンクを送信し、成功時に `reservation:manualJoinLink` を送出します。

### 環境変数（`backend/.env`）
```bash
# 到来通知スケジューラ（毎分実行推奨）
NOTIFICATION_CRON=* * * * *

# リマインダー通知スケジューラ（既定: 毎時 0 分。本番では */15 * * * * 等も可）
NOTIFICATION_REMINDER_CRON=0 * * * *

# リマインダーウィンドウ（ミリ秒）。既定 24h = 86400000
NOTIFICATION_REMINDER_WINDOW_MS=86400000

# 10 分以内リマインダー（毎分確認）
NOTIFICATION_TEN_MIN_REMINDER_CRON=* * * * *
NOTIFICATION_TEN_MIN_REMINDER_WINDOW_MS=600000
```

### 部分的失敗の許容（要件 3.4）
- 定期通知では WhatsApp が例外で失敗しても Socket.IO 送出を試み、通知フラグを更新します。配信成功の保証や自動再試行ではありません
- フラグ更新は送信後のため、更新失敗・並行実行・複数プロセスで重複送信する可能性があります
- `whatsappFailures` は送信関数が投げた例外を集計します。到来・事前通知の `sendText` は失敗を `{ ok: false }` で返すため、これらの送信失敗はクライアントのログに残っても集計に反映されない場合があります

## 現行実装の制約

- **時刻と候補**: 管理画面の枠 API は JST 暦日を使用しますが、WhatsApp の日付候補・時刻候補は既定の UTC 基準で生成し、選択時刻を JST として解決する経路があります。候補が空のフォールバックは選択日を含む 3 日分で、過去の枠が再提示される場合があります。「常に未来の枠のみ」とは保証できません。
- **状態保持**: チャット会話状態と進行中の録画 ID 対応はプロセス内メモリです。再起動・水平スケールを考慮した共有化は未実装です。
- **スタッフ認可**: 管理者と担当者一致判定はありますが、一部 API はリクエストから担当者情報を取得します。一覧 API には保存済み予約から担当者を解決する処理がなく、通常のスタッフ操作が 403 になる場合があります。全 API で割当範囲を適切に扱える実装ではありません。
- **Socket.IO**: クライアントは JWT を送信しますが、サーバー側のハンドシェイク認証・担当者別 room 配信は未実装で、イベントは `io.emit` で全接続へ配信します。公開運用前にアクセス制御が必要です。
- **ゲスト入室**: ワンタイムリンクとは別に、`POST /sessions/:id/guest-token` は JWT なしで利用でき、キャンセル以外の予約と会議室状態を確認します。すべてのゲスト入室がワンタイムリンク必須ではありません。
- **文字起こし**: 話者分離は channel / stream 単位です。1 本のストリーム内の複数話者を識別する機能ではありません。開発環境の録画関連一覧には外部 API 失敗時にモックデータを返す経路があり、一覧表示だけでは実録画の成功を証明しません。
