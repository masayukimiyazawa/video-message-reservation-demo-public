# 手動E2E手順書：録画の自動開始・ダウンロード・文字起こし表示

本書は「管理画面に録画・文字起こしのダウンロードボタンが表示されない」不具合修正を、
**実 Vonage Video API / 実 MongoDB** を用いて人間が確認するための手順である。
自動テスト（ユニット/統合）は本書末尾の対応表を参照。実環境の外部境界（Vonage の
アーカイブ生成・署名付き URL）は自動テストでは代替できないため、リリース前に本手順で確認する。

- 対象要件: 録画の自動開始（会議開始）/ 会議終了後の録画ダウンロード / 文字起こしの表示・ダウンロード
- 対象画面: 管理画面（`/admin`）の「Recording」「Transcription」「Reservations」各メニュー

---

## 1. 前提条件

### 1.1 認証情報・DB（`backend/.env`）

```bash
NODE_ENV=production                      # モックデータ返却を無効化（実データで確認するため）
MONGODB_URI=mongodb://...                # 実 MongoDB
JWT_SECRET=<任意の長い文字列>

# Video（録画・文字起こし）
VONAGE_VIDEO_APPLICATION_ID=<Video を有効にした Application ID>
VONAGE_VIDEO_PRIVATE_KEY_PATH=./vonage_video_private.key

# Webhook 署名シークレット（各機能で別。ダッシュボードの値と一致させる）
VONAGE_VIDEO_SESSION_MONITORING_SIGNATURE_SECRET=<Session Monitoring の署名シークレット>
VONAGE_VIDEO_ARCHIVE_MONITORING_SIGNATURE_SECRET=<Archiving の署名シークレット>

# 公開 URL（利用者が開く入室リンクのオリジン。トンネル URL）
PUBLIC_APP_URL=https://<ランダム>.trycloudflare.com
CLIENT_ORIGIN=http://localhost:5173
PORT=4000
```

> **重要（モック無効化）**: `NODE_ENV` が `production` 以外だと、アーカイブが 0 件のとき
> 開発用モック（`https://example.com/...`）が返り、実データでの確認にならない。
> `NODE_ENV=production` では署名シークレット未設定だと Webhook が **503 で拒否**されるため、
> 上記シークレットを必ず設定する。

### 1.2 Vonage ダッシュボード（Applications → 対象アプリ → Capabilities → Video）

| 設定項目 | URL | Signature Secret |
|---|---|---|
| Session Monitoring | `https://<公開URL>/webhooks/video-events` | `VONAGE_VIDEO_SESSION_MONITORING_SIGNATURE_SECRET` と同じ |
| Archiving | `https://<公開URL>/webhooks/video-archive-events` | `VONAGE_VIDEO_ARCHIVE_MONITORING_SIGNATURE_SECRET` と同じ |

- **Video** capability を有効化する。
- Webhook の詳細は `README-JP.md` の「Vonage Video Application の設定」を参照。

### 1.3 公開トンネルと起動

```bash
# ターミナルA: バックエンド(4000)を公開（URL は起動ごとに変わる）
cloudflared tunnel --url http://localhost:4000
# 表示された https URL を PUBLIC_APP_URL とダッシュボードの各 URL に反映

# ターミナルB: バックエンド
npm run dev --workspace=backend

# ターミナルC: フロントエンド
npm run dev --workspace=frontend
```

起動ログに `[backend] public app url: https://...` が出ること、警告が出ないことを確認する。

---

## 2. シナリオ: 会議開始 → 録画 → 終了 → ダウンロード → 文字起こし

### 2.1 予約とゲスト入室リンクの準備

1. 管理画面に administrator でログインし、**Reservations** で予約を 1 件作成する
   （サービス・日時・連絡先を入力）。作成された予約の `sessionId` を控える。
2. その予約の入室リンク（`/join/<tokenId>`）を発行・取得する。
   - 予約時刻到達で WhatsApp に届くリンク、または「手動再通知」で送ったリンクを使う。
3. ログで `POST /webhooks/video-events` の `connectionCreated` が受信できる状態にする。

### 2.2 録画が「会議開始時に確実に開始される」ことの確認（要件1）

1. 発行した入室リンクを **別ブラウザ/端末（ゲスト）** で開き、通話に参加する。
   - ゲストの connection data に `role: "guest"` が入っている必要がある
     （`POST /sessions/:id/guest-token` 経由のリンクなら自動で付与される）。
2. バックエンドログで以下を確認する:
   - `[monitoring]` に `connectionCreated` を受信（署名検証を通過）
   - `ゲスト入室を検知、自動録画＋文字起こしを開始`
   - `自動録画開始成功`（`withTranscription: true`、`language` が予約言語）
3. 管理画面の **Recording** メニューを開く:
   - 状態バッジが `Recording` になる
   - アーカイブ ID が表示される
   - （ブラウザ DevTools の Network → WS で `recording:status` が `{"status":"started",...}`）

> 期待: ゲスト入室だけで録画が始まる。管理者/スタッフの入室だけでは開始しない。

### 2.3 会議終了 → 録画ファイルのダウンロード（要件2）

1. 参加者全員（ゲスト含む）が退室する。
2. バックエンドログで確認:
   - `会議終了に伴う録画停止成功`
   - Archive Monitoring で `status: stopped` → `available` を受信し、
     `recording:status` が `available`（`downloadUrl` 付き）で送出される
3. 管理画面 **Recording** メニュー:
   - 未完了（`available` 前）の行がある間は自動で再取得される（約5秒間隔・
     最大約2分）。**Refresh を押さなくても**、`available` になった時点で
     **Download** リンクが表示される
   - リンクをクリックし、録画ファイルが実際にダウンロードできる
4. **Reservations** メニューの該当予約行でも、録画列に **Download Recording** リンクが出る。
   - クリックして保存できる（`GET /reservations/:id/archives` が `url → downloadUrl` を返す）。

> 期待: `available` 後のみ Download が出る。`url` が無い（未完了）行には出ない。

### 2.4 文字起こしの表示・ダウンロード（要件3）

1. `available` 後に自動で文字起こし取得が走る。ログで確認:
   - `recording:status` に `transcription_ready` が送出される
2. 管理画面 **Transcription** メニュー:
   - 一覧に文字起こし可能なアーカイブが表示される（`ready`）
   - 未完了（`pending`）の行がある間は自動で再取得される（Refresh 不要）
   - 対象行の **View** を押すと、話者（話者ラベル / streamId）単位で発話が表示される
   - **Download** リンクが表示され、クリックで文字起こしファイル（ZIP）を取得できる
3. **Recording** メニューの対象行 **View Transcription** を押すと、
   **Transcription** タブへ切り替わり、そのアーカイブ ID が入力欄に引き継がれる。
   **Fetch transcription** で同様に話者別表示できる。
4. **Reservations** の該当予約行の文字起こし列に **Download Transcription** リンクが出る。

> 期待: 各画面から文字起こしの内容表示とダウンロードができる。

---

## 3. 判定基準（合格条件）

| # | 確認項目 | 合格条件 |
|---|---|---|
| 1 | 録画の自動開始 | ゲスト入室のみで録画が開始し、`recording:status=started` が届く |
| 2 | 会議終了での停止 | 全員退室で `stopRecording` が呼ばれ、後に `available` になる |
| 3 | 録画DL（Recording） | `available` 行に Download が出て、実ファイルを取得できる |
| 4 | 録画DL（Reservations） | 予約行に Download Recording が出て取得できる |
| 5 | 文字起こし表示 | 話者単位で内容が表示される |
| 6 | 文字起こしDL | Transcription 一覧の Download でファイル取得できる |
| 7 | タブ連携 | View Transcription でタブ切替＆ archiveId 引き継ぎ |

---

## 4. トラブルシューティング

| 症状 | 原因/対処 |
|---|---|
| Webhook が 503 | `NODE_ENV=production` で署名シークレット未設定。`.env` に両シークレットを設定 |
| Webhook が 401 | ダッシュボードの Signature Secret と `.env` の値が不一致 |
| 録画が始まらない | ゲストの connection data に `role:"guest"` が無い / Session Monitoring URL 未設定・届いていない |
| 一覧が `example.com` のモック | `NODE_ENV` が `production` 以外、または実 API がアーカイブ 0 件 |
| Download が出ない | アーカイブがまだ `available` でない（`stopped`/`uploaded` 途中）。管理画面は未完了の間 自動更新（最大約2分）。それでも出ない場合は Refresh で再確認 |
| 文字起こしが空 | Post-Call Transcription 生成待ち。管理画面は未完了の間 自動更新（最大約2分）。`transcription_ready` 送出後に再取得 |
| トンネル URL 変化で届かない | `cloudflared` 再起動で URL が変わる。ダッシュボードの 2 つの URL と `PUBLIC_APP_URL` を更新し再起動 |

---

## 5. 自動テストとの対応（実環境で代替できない部分の補完）

| 確認項目 | 自動テスト（本リポジトリ） |
|---|---|
| ゲスト入室→自動録画（E2E 配線） | `backend/src/services/monitoringRoutes.lifecycleE2E.test.js` |
| 予約言語の継承・会議終了での停止 | `backend/src/services/roomLifecycleService.test.js` |
| 録画一覧 `GET /recordings`（`url` 含む） | `backend/src/services/recordingRoutes.test.js` |
| 予約単位録画 `url → downloadUrl` | `backend/src/services/reservationRoutes.archives.test.js` |
| 文字起こし一覧の正規化・`downloadUrl` 解決 | `backend/src/services/recordingRoutes.test.js` |
| 文字起こし話者別取得 | `backend/src/services/recording.integration.test.js` |
| Archive Webhook の `available`/`stopped` 処理 | `backend/src/services/monitoringRoutes.test.js` |
| 管理画面の録画DLリンク表示 | `frontend/src/components/admin/adminPanels.test.jsx` |
| 管理画面の自動更新（Refresh 不要化） | `frontend/src/hooks/useAutoRefresh.test.jsx`, `frontend/src/components/admin/mediaPending.test.js`, `frontend/src/components/admin/adminPanels.test.jsx` |
| View Transcription のタブ連携・ID 引き継ぎ | `frontend/src/pages/AdminPage.test.jsx` |

自動テストは外部境界（Vonage の実アーカイブ・署名付き URL・実際のダウンロード可否）を
モックするため、**その部分のみ** 本手順で確認する。
