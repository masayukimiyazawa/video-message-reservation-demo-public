# Technology Stack

## Architecture

**npm workspaces によるモノレポ**（`backend` = `@vvr/backend`、`frontend` = `@vvr/frontend`）。共有パッケージは置かず、各ワークスペースが独立した `package.json` / テストランナー / `.env` を持つ。

```
root
├── backend/    Express API + Socket.IO + cron + Mongoose
└── frontend/   React SPA (Vite)
```

クライアント / サーバー分離に加え、次の 4 つの外部チャネルを持つ。

1. **REST**（Express）— 予約・セッション・録画・文字起こしの API
2. **WebSocket**（Socket.IO）— 管理者 UI への push。`reservation:due` / `recording:status`
3. **受信 Webhook** — Vonage Messages API（WhatsApp）のみ。POST のみ
4. **Vonage Video Client SDK** — ブラウザ ↔ SFU のメディアプレーン（WebRTC）

### バックエンドの 4 層

| 層 | パス | 責務 |
| --- | --- | --- |
| ドメイン層 | `backend/src/domain/` | **副作用ゼロの純粋関数のみ。** プロパティテストの対象 |
| アプリケーション層 | `backend/src/services/` | ビジネスオーケストレーション + Express Router + ミドルウェア |
| インフラ層 | `backend/src/infra/` | Mongoose / Vonage SDK クライアント / Socket.IO エミッタ |
| 設定 | `backend/src/config/env.js` | `process.env` を読む唯一の場所 |

**この分割の設計上の要点**

- **依存注入が全モジュールに及ぶ** — すべてのサービス / Router / クライアントは `createXxx(deps = {})` ファクトリで、既定値を持つ。テストはモジュール差し替えではなく依存注入で行う。
- **import 時副作用ゼロ** — Vonage クライアントは遅延生成（lazy init）、Mongo 接続は遅延実行、`@vonage/*` は動的 `import()`。`index.js` の `createApp` は DB 接続・Socket.IO・スケジューラを一切行わない。
- **定数は単一情報源** — `domain/constants.js` の enum を infra（Mongoose の `enum`）も再利用する。リテラルを二重定義しない。
- **層間の依存は「1 行下へ」** — 上位層を import しない。詳細は `structure.md`。
- **`Object.freeze`** を定数マップと公開サービスの返り値に適用。

### Socket.IO の循環依存回避（再利用価値の高いパターン）

`http.createServer(app)` を唯一の `request` ハンドラとして生成し、同一サーバーへ後から Socket.IO を attach する。Socket.IO を先に attach すると `request` リスナが 2 個になり、engine.io と Express が同じ `res` を二重処理して `ERR_HTTP_HEADERS_SENT` でプロセスが落ちる。

実装は `ioRef` ホルダーで遅延バインドし、順序（emitter → service → app → server → io → DB → cron → listen）を `index.js` にコメント付きで明文化している。回帰テストで `server.listeners('request')` の長さが 1 であることを検証する。

## Core Technologies

**TypeScript は使用しない。純 JavaScript（ESM）で、JSDoc typedef で型を表現する。**

| 領域 | 技術 | バージョン |
| --- | --- | --- |
| 言語 | JavaScript (ESM) | `"type": "module"` |
| ランタイム | Node.js | `>=20.0.0` |
| パッケージ管理 | npm workspaces | lockfile v3 |
| バックエンド | Express | `^4.19.2` |
| ODM | Mongoose | `^8.5.1` |
| リアルタイム | Socket.IO | `^4.7.5`（server / client 同一） |
| 認証 | jsonwebtoken + bcryptjs | `^9.0.2` / `^2.4.3` |
| スケジューラ | node-cron | `^3.0.3` |
| フロントエンド | React + React Router | `^18.3.1` / `^7.18.4` |
| i18n | i18next + react-i18next | `^23.12.2` / `^15.0.0` |
| ビルド | Vite + @vitejs/plugin-react | `^5.3.5` |
| テスト | Jest / Vitest / fast-check | 29 / 2.1.9 / `^3.19.0` |
| DB | MongoDB Atlas（外部） | — |

## Key Libraries

開発パターンを形づくるものだけを列挙する。

- **`@vonage/video`, `@vonage/auth`**（server）— セッション作成 / クライアントトークン発行 / アーカイブ操作。認証は application-id + 秘密鍵（ファイルパス指定）。
- **`@vonage/messages`, `@vonage/server-sdk`**（server）— WhatsApp 送信。text / image には公式の型付きクラスを、reply button / list / carousel には**公式クラスが存在しない**ため `custom`（`message_type: 'custom'`）を手で組み立てる。
- **`@vonage/client-sdk-video`**（browser, `^2.28.2`）— 通話・画面共有。**動的 `import()`** で初期バンドルから外す。
- **`@vonage/jwt`** — 受信 Webhook の署名検証（SHA-256 HMAC）。直接依存ではなく動的 import。
- **`fast-check`** — プロパティベーステスト。ドメイン層の検証戦略の土台。詳細は `testing.md`。
- **`fflate`**（`0.8.3` の完全固定）— Vonage 文字起こしファイル（ZIP）の in-memory 解凍。ZIP パースの正確性が製品成立に関わるため意図的に完全固定。

**意図的に採用していないもの**: `supertest`（Node 標準 `http` で実リクエストを送る方針）、状態管理ライブラリ、CSS フレームワーク、`helmet` / `express-rate-limit`、 Winston / pino（素の `console`）。

### 依存の固定方針

- **`fflate` は完全固定**（`0.8.3`、キャレット無し）。ZIP パースの正確性が製品成立に関わるため。
- **`uuid` は root の `overrides` で完全固定**（`11.1.1`）。`node-cron` が要求する `^8.3.0` は [`uuid` の非推奨ライン](https://github.com/uuidjs/uuid/blob/main/CHANGELOG.md) に当たり、advisory（GHSA-w5hq-g745-h8pq、v3/v5/v6 の `buf` 引数）も承受する。CommonJS 向け推奨ラインである v11 を指定して全体を 1 ツリーに寄せる。
  - **教訓（実測で検証済み）**: `overrides` 変更後に「依存が消える / バージョンが戻される」症状が出たら、**npm workspaces では `node_modules` が workspace ごとに独立している**ことを疑う。ルート `node_modules` だけを削除して `npm install` すると、**残存した `backend/node_modules` を正とみなして lockfile を再構築し、その workspace の推移的依存を再解決しない**（実測: `@vonage/server-sdk` の依存 13 パッケージが消失し、`require('@vonage/server-sdk')` が `Cannot find module '@vonage/accounts'` で失敗した）。正解手順は **`rm -rf node_modules backend/node_modules frontend/node_modules package-lock.json && npm install`**。
  - `npm update <pkg>` も危険。override を壊して推移的に別バージョンを落とす（実測: node-cron が 8.3.2 に巻き戻った）。
  - **もう一つの独立した原因**: `~/.npmrc` の `cache` が VS Code の temp 配下（`~/.vscode/tmp/tmp_vscode_*/npm-cache`）を指している場合、**キャッシュ汚染により `overrides` が黙って無視される**（隔離キャッシュで同じ package.json を解決すると正しい `11.1.1` になるが、汚染キャッシュでは旧 `9.0.1` に戻る）。lockfile が manifest と食い違う場合、先に `npm install --cache=<隔離パス>` で切り分ける。
- その他の直接依存はキャレット指定で、意図的な例外は `fflate` と `uuid` のみ。
- **テストランナーは frontend のみ**（`vitest`）。backend は `jest` + `fast-check`。
- **`npm audit` を 0 件で維持する**（2026-09-28 時点）。`vitest 5.0.2` / `vite 8.3.1` / `@vitejs/plugin-react 6.1.1` へ major 移行済み。`jsdom` は audit 違反ではないため `25.x` に据え置き、`30.x` は hex カラーが `rgb()` に正規化されて `backgroundSkins.test.js` が落ちるため上げない。
- **npm workspace の hoisting に依存しない**（実測・重要な罠）: `npm install` の**増分**更新では旧 lockfile のネスト配置（`frontend/node_modules/vitest`）が保持され、hoist された `node_modules/@testing-library/jest-dom` から `vitest` が解決できず `Cannot find package 'vitest' imported from .../jest-dom/dist/vitest.mjs` で全 suite が落ちる。**依存バージョンを跨ぐ変更をしたら `rm -rf node_modules backend/node_modules frontend/node_modules package-lock.json && npm install` で必ずクリーン再インストールする**（overrides の教訓と同じ手順）。

## Development Standards

### Type Safety

- `tsconfig.json` は存在しない。型は `backend/src/domain/types.js` に集約した **JSDoc `@typedef`** で表現する（型専用モジュール。実行時 export は無し）。
- ドメイン enum は `@readonly @enum {string}` の JSDoc を必ず付け、`Object.freeze` する。
- `any` はほぼ禁止。フロントエンドの汎用 fetch / socket ペイロード型以外では使わない。ユニオン型で書く（`@property {('pending'|'confirmed'|'cancelled'|'completed')} status`）。
- Mongoose スキーマはドメイン定数を `enum` に流用する。

### Code Quality

**現状の正直なところ**: ESLint / Prettier の**設定も依存も存在しない**。`lint` スクリプトも無い。一方でコードには `// eslint-disable-next-line no-console` / `no-unused-vars` が 10 箇所以上ある。**実質的なスタイル規約はコードから読み取るしかない。**

観測されている規約:
- シングルクォート、セミコロン、末尾カンマ、2 スペースインデント
- **名前付き export を使う**。加えて公開サーフェスには `export default` も併記する（`export const videoClient = ...; export default videoClient;` の 2 行セット）
- **全ファイルの冒頭に日本語 JSDoc ヘッダ** — 目的 → 要件参照（`(要件 7.4・7.5・8.5)`）→ 設計理由。コメントは日本語、識別子と文字列リテラルは英語。
- **要件トレーサビリティ** — `(要件 2.3)` / `_Validates: Requirements 1.5_` / `(Task 18.2)` を随所に記載する。
- コミットは Conventional Commits。scope / subject は英語、本文は日本語も可。

### Testing

詳細は **`testing.md`** を参照。（backend = Jest、frontend = Vitest、ドメイン層 = プロパティテスト。テストはソースと同階層に同居し、`npm test` 1 コマンドで両ワークスペースを走らせる）

## Development Environment

### 必要なもの

- **Node.js >= 20**、npm
- **MongoDB Atlas** クラスタ（予約データ用）
- **Vonage ダッシュボード**: Video 機能と Messages（WhatsApp）機能を持つ Application
- **`cloudflared`**（ローカル開発時のみ）— Vonage は `localhost` に Webhook を配送できず、利用者のスマホも `localhost` へ到達できないため Quick Tunnel が必要。**フロント（5173）を公開**すると入室リンクと Webhook を 1 本で賄える（Vite の dev proxy が API を中継）。**URL は再起動ごとに変わる**ので `PUBLIC_APP_URL` と Inbound / Status URL の再登録を前提とする。固定 URL が必要なら Named Tunnel を使う。

### 公開 URL と CORS オリジンは別物

- `CLIENT_ORIGIN` = CORS 許可用（開発時は `http://localhost:5173`）。
- `PUBLIC_APP_URL` = **利用者が実際に開く公開 URL**（入室リンクの配信先）。テストは Cloudflare トンネル、本番はデプロイ先。

入室リンク生成に `CLIENT_ORIGIN` を流用すると利用者の端末から到達できない localhost を配信してしまう。`publicAppUrl.js` の `describePublicAppUrlProblem()` で検証し、不正時は入室リンク発行を fail-closed で拒否する（トークンを消費する前に止める）。新規に「利用者に見せる URL」を生成する際は `PUBLIC_APP_URL` を使うこと。

### SPA はバックエンドが配信する（history fallback）

`/join/:tokenId` などの React Router ルートはクライアントサイドのみで、HTML ファイル実体が存在しない。バックエンド（4000）だけを公開すると `Cannot GET /join/xxx` になるため、`services/spaStatic.js` が `frontend/dist` を配信し、API 以外の未知パスに `index.html` を返す。

- **`npm run build:frontend` が前提**。`dist` が無い場合は配信しない（開発は Vite dev server が担当）。
- `API_PATH_PREFIXES`（`/api` `/auth` `/sessions` `/reservations` `/webhooks` `/socket.io` 等）は index.html に化けさせない。認証エラーが HTML になるとフロントが解釈できず原因究明不能になるため。
- フロントの `VITE_API_BASE_URL` は**未設定 = 同一オリジン**。利用者の端末が `localhost` を参照しないための措置。

### 環境変数

**値は一切 steering に書かない。** 変数名のみ。定義は `backend/.env.example`（git 管理済み）。

環境変数の読み込みは `backend/src/config/env.js` の**集約点だけ**。他のファイルで `process.env` を直接読まない。バリデーションライブラリは使わず、`||` 既定値で素直に既定値にフォールバックする。

- **秘密値は環境変数に入れず、ファイルパスを入れる。** Vonage の秘密鍵は `VONAGE_*_PRIVATE_KEY_PATH` に `backend/` 基準の相対パスを指定し、実行時に `readFileSync` で読む（backend は cwd=`backend/` で起動する）。
- `.gitignore` は `.env` / `.env.local` / `*.key` を除外し、`!*.example` でテンプレートだけ残す。
- **秘密ファイルのパーミッションは `600` にする。** `backend/.env` と `backend/private.key` は開発者のみ読み書き可能とする。`chmod` は git に記録されないため、clone 後・ファイル再生成のたびに以下のコマンドで再設定する:
  ```bash
  chmod 600 backend/.env backend/private.key
  ```
  `.env.example` に実値を入れるな（値は空 or プレースホルダのみ）。 commit 前には `git status` に `.env` / `*.key` が現れないことを確認する。

### Webhook 署名検証は fail-closed

`VONAGE_SIGNATURE_SECRET` が未設定のとき、`verifyVonageWebhook`（`backend/src/services/webhookSignature.js`）の既定の挙動は **NODE_ENV で決まる**:

- `NODE_ENV=production`: **fail-closed**。検証できないため **HTTP 503** で拒否し、`next()` を通さない。警告ログではなく `logger.error` を出す。
- `NODE_ENV=development`: 開発容易性のためスキップを許可し、`logger.warn` を出力する。

**「検証できないのに通す」のは本番では絶対に禁止。** 認証を省略してリクエストを信頼すると、偽装 Webhook で予約作成や会話進行を操作できてしまう（認証バイパス）。テストや意図的な開発用途では `allowUnverified` オプションで明示的に上書きできる。

401（要求元の認証失敗）とは区別し、**設定不備は 503** で返す。Vonage 側が 401 を受けると署名不一致と誤認し、再送制御が狂う。

### コマンド


```bash
# インストール（lockfile に忠実。npm install は lock を更新しうる）
npm ci

# 開発（backend / frontend は別々で起動する。ルートに dev スクリプトは無い）
npm run dev:backend     # node --watch src/index.js  (cwd=backend, port 4000)
npm run dev:frontend    # vite                   (port 5173)

# テスト（backend + frontend の両方を必ず走らせる）
npm test                # = npm run test --workspaces
npm run test:backend    # 個別に回したい場合
npm run test:frontend

# ビルド
npm run build:frontend  # backend にビルド工程は無い
```

**重要**: ルート `npm test` は **`--workspaces`** を使う。`&&` で繋ぐと片方の失敗で他方がスキップされ、「テストが実行されない」という穴が再発する。`--workspaces` なら両方が必ず実行され、終了コードは全体の合算になる。

**注意**: CI は存在しない（全品質ゲートは手動）。

## Key Technical Decisions

| 決定 | 理由 |
| --- | --- |
| **ドメイン層を純粋関数に切り出す** — 8 つの業務規則（会話遷移 / 空き判定 / 認可 / アーカイブオプション / 文字起こし整形 など）を副作用ゼロで独立させる | プロパティテスト可能にするため。`now` / `clock` は**必ず引数**で注入し、`Date.now()` を関数内で呼ばない。決定性はこの層の前提条件 |
| **文字起こしには `outputMode: 'individual'` が必須** | Post-Call Transcription は individual archive でのみ利用可能。composed では不可。この不変条件を `buildArchiveOptions` が強制する |
| **「話者分離」= channel / stream 単位** | Vonage が単一 JSON を返し `segments[].channel` と `channels_metadata[].id`（＝ストリーム ID）で話者を解決する以上、これ以上の分離は純正機能の外。stream ↔ ユーザーの対応付けはトークンの connection data で行う |
| **Video は Webhook を使わない（戻り値 + ポーリング）** | Video 側のコールバック受信を前提にせず、SDK 戻り値と `getArchive` のポーリングで完結させる。設定と障害点を減らし、Video 用 Inbound URL 設定を不要にする |
| **文字起こしファイルは ZIP** | `transcription.url` は JSON ではなく ZIP を指す。`arrayBuffer` → `unzipSync` → 中の `*.json` を取り出す。過去 `res.json()` で読んでいた実装は `PK...` により `Unexpected token 'P'` で失敗していた |
| **MongoDB Atlas + Mongoose Repository** | アプリから独立した永続化層という要件。`save` / `findById` / `find` / `findBySessionId` / `updateStatus` / `markNotified` を `.lean()` で返す。**失敗は握り潰さず `new Error(msg, { cause: err })` で投げる** |
| **認証 = JWT bearer + RBAC、認可は純粋関数へ委譲** | 「あなたが誰か」（authService）と「何が許されるか」（`canAccess` + `authorize`）を分離。所有者解決はエンドポイントごとに注入可能で、解決不能なら**非所有扱い＝403**（fail-closed） |
| **ユーザー列挙の防止** | 「ユーザー不在」と「パスワード不一致」で**同一の例外・同一メッセージ**を投げる |
| **予約バックドのゲストトークン** | 未認証の通話参加を無制限に許さない。有効（cancelled 以外）な予約が 1 件でもなければ 403。アプリ DL ゼロという製品価値と、認可の安全性を両立させる。**この機能追加は認証状態による分岐を増やした**ため、変更時は対になる frontend テストの追随が必要（`testing.md` 参照） |
| **サービス層は `{ ok, code, message }` を返す** | API 境界で例外を投げない。Routes が `code` → HTTP status に写像する。**投げるのはドメイン層のバリデーションのみ** |
| **トランスポートは無条件 no-op** | Socket.IO の `io` が未配線でも例外を投げない。通知や録画の失敗がビジネスロジックを壊さないようにするため。emit 失敗はログのみ |
| **予約単位の分離処理** | 通知ループは予約 1 件ずつ独立処理。1 件の失敗が他を止めない。WhatsApp 送信失敗は記録するが、Admin UI 通知と `markNotified` は必ず実行する（二重通知防止のため失敗時もマーク） |
| **会話状態はインメモリ（暫定）** | 送信者キーの `Map`。**単一プロセス前提**であり、将来 Redis 等へ移すため状態ストアを注入可能にしてある。「完成した設計」ではない |
| **Messages と Video で別 Application を許す** | 2 組の資格情報（`VONAGE_APPLICATION_ID` / `VONAGE_VIDEO_APPLICATION_ID`）を持つことで、同一 Application でも分離でも運用できる |
| **Messages API Sandbox 用のフォールバックを 2 種** | ① `VONAGE_MESSAGES_API_HOST` によるホスト切替（未設定なら生成せず完全後方互換）。② `WHATSAPP_INTERACTIVE_FALLBACK_TEXT` による**インタラクティブ → テキストの降格**。Sandbox は reply button / list / carousel を 422 で拒むため。**本番の WhatsApp 番号では無効のまま**にする |
| **Webhook は 200 応答** | Vonage は 2xx を受領扱いとするため、業務エラーはボディで返す。401 になるのは署名検証失敗のみ |
| **背景はネットワーク画像に依存しない** | CSS グラデーションと `data-skin` 属性で表現する。`telemedicine` は必須スキンとして固定 |
| **i18n は予約レコードに永続化** | 言語は保存されることで、後の WhatsApp 送信と文字起こしエンジン言語（`en`→`en-US`, `ja`→`ja-JP`）も一意に決まる。UI の文字列差し替えに留めない |

## Dependency Audit Policy

`npm audit` の残件は **「到達不能」を根拠に意図的に残す**。重大度を理由に `npm audit fix --force` を実行しない。

**判断手順**

1. 修正が **major 跨ぎか** を確認。major 跨ぎで、本プロジェクトの唯一の品質ゲートが 153 テスト（lint / 型検査 / CI なし）なら、**警告の除去より回帰リスクの方が大きい**。
2. 到達可能性を **実際にコードで判定**する（advisory の文言の前提条件を、そのアプリが満たすか）。
3. 到達可能なら、**低リスクな経路だけで**解消する。非 major で足りるならそちらを選ぶ。

**到達不能と判定した残件（2026-09-28 時点、5 件）**

| 警告 | 到達不能の根拠 |
| --- | --- |
| `vitest` **critical** — UI server 起動時に任意ファイル読み取り・実行 (GHSA-5xrq-8626-4rwp) | advisory の前提は「Vitest UI server が起動している」こと。**`@vitest/ui` は未インストール**、`--ui` スクリプトも無く、テストは `vitest run` のみ。UI サーバは立ち上がらない |
| `@vitest/mocker` / `vite-node` — redirect mock のパストラバーサル (GHSA-82fw-gwwq-j7x9) | mock のパスは**開発者がテストファイル内で決定**する。外部入力に由来しない。dev 専用 |
| `vite` **high** — 最適化 `.map` のパストラバーサル / `server.fs.deny` バイパス / launch-editor の NTLM 関連 (3 件) | いずれも **dev サーバのリクエスト処理**に依存。`npm run dev:frontend` は既定で localhost のみに bind。本番は `vite build` の静的成果物で dev サーバを含まない |
| `esbuild` — dev サーバが任意サイトからのリクエストを処理 (GHSA-67mh-4wv8-2f99) | 同上。dev サーバ限定 |

**この前提が崩れる条件（再評価のトリガ）**

- `@vitest/ui` を導入する、またはテストを `vitest --ui` で走らせる → **vitest critical を major upgrade せずには不可**
- dev サーバを `0.0.0.0` に bind する、またはコンテナ内から公開する、または reverse proxy で露出させる → **`vite` high / `esbuild` が実害化**
- CI で `vite preview` や dev サーバを外部公開する

**残る移行の規模感**: `vitest 2.1.9 → 5.0.2`（**3 major**）/ `vite 5.4.21 → 8.3.1`（**2 major**）。Vitest 3 の `environmentMatchGlobs` 廃止・pool 既定値変更、v4/v5 の追加破壊が子和分や設定に及ぶ可能性が高く、**本件は独立した移行プロジェクトとして計画する**（前端构建の検証と全 21 テストの green 期間を移行の合否条件にする）。

---
_標準とパターンを記録する。依存一覧のすべては記載しない_

_Last updated: 2026-09-28（bootstrap）_
