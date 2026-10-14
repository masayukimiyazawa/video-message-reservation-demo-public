# Project Structure

## Organization Philosophy

**npm workspaces モノレポ ＋ バックエンドは厳格な 4 層（Clean Architecture / ports & adapters）＋ フロントエンドは「ルート → コンポーネント → api」**。

バックエンドは技術レイヤーで分割され、そのドメイン層の内側だけが capability 単位（1 ファイル 1 ビジネス概念）に並ぶ。services 層だけは feature 縦断で並ぶ。フロントエンドは feature 単位の深さより、**`api/` をデータ層として 1 枚にまとめる**ことを選んでいる。

この構成の軸は「再利用」ではなく **「副作用から切り離すこと」** である。外部世界に触れる可能性があるモジュールはすべて `createX(deps = {})` ファクトリを持ち、実装を結び付けるのは `index.js` だけの Composition Root である。

## Directory Patterns

### モノレポのワークスペース分割
**Location**: `backend/`, `frontend/`
**Purpose**: Express/Node プロセスと Vite/React SPA の硬い境界。各々独自の `package.json`・テストランナー・`.env`。
**Example**: 拡張子の分裂がここだけで起きる — backend は全て `.js`、React コンポーネントは `.jsx`。

### バックエンド 4 層
**Location**: `backend/src/{config,domain,services,infra}/` ＋ `backend/src/index.js`
**Purpose**: ディレクトリがそのまま層。
- `config/` — 1 ファイルのみ。**`process.env` を読む唯一の場所**。他のファイルで直接読まない
- `domain/` — 純粋関数 ＋ frozen enum ＋ JSDoc typedef。I/O も SDK も Express も含まない
- `services/` — アプリケーションサービス、Express Router、ミドルウェア、WhatsApp クライアント
- `infra/` — Mongoose モデル、リポジトリ、DB 接続、Vonage Video クライアント、Socket.IO エミッタ

**Example**: `domain/availability.js` は `./constants.js` だけを import する。`infra/reservationStore.js` は `../domain/constants.js` と `./mongoConnection.js` だけを import する。

### ドメイン層の「1 ファイル 1 概念」
**Location**: `backend/src/domain/<capability>.js`
**Purpose**: ファイル名 == 主たる export 関数名。プロパティテストの命名（`<capability>.property.test.js`）が 1:1 で対応する。
**Example**: `checkAvailability` → `availability.js`、`canAccess` → `authorization.js`、`nextStep` → `conversation.js`、`groupBySpeaker` → `groupBySpeaker.js`。

### services 層の「concern ごとのトリプレット」
**Location**: `backend/src/services/<concern>{Service,Middleware,Routes}.js`
**Purpose**: feature 縦断ごとに、純粋寄りのサービス・HTTP アダプタ・横断ミドルウェアを兄弟ファイルに分ける。1 ファイルに統合しない。
**Example**: `authService.js` ← `authMiddleware.js` ← `authRoutes.js`。`recordingRoutes.js` は 1 ファイルから 2 つの Router を export する（サービスは共有するが、マウント先が異なるため）。

### 「マウントは 1 箇所だけ」
**Location**: `backend/src/index.js` のみ
**Purpose**: URL プレフィックス → Router の写像と、実インフラの配線。**ほかのファイルは全部ファクトリと既定インスタンスを export するだけ。**
**Example**: `app.use('/reservations', reservationRouter)` のようなマウントは index.js にしか書かない。各 `*Routes.js` はサブルート（`router.post('/:archiveId/stop')`）だけを宣言する。

### フロントエンドの `api/` 集約
**Location**: `frontend/src/{api,pages,components,components/admin,video,i18n,styles,test}/`
**Purpose**: **`hooks/` `store/` `utils/` `types/` を作らない。** 再利用ロジックは `api/` と `video/` に畳み込む。
- `api/client.js` — REST と JWT 保持、`ApiError`
- `api/socket.js` — Socket.IO 購読ラッパ
- `api/video.js` — Vonage Video Client SDK ラッパ（遅延 import）
- `api/auth.js` — JWT デコードと権限表示用ヘルパ（**セキュリティではない**）
- `video/backgroundSkins.js` — フロント側の純ロジックモジュール
- `components/admin/` — 管理者 UI の機能パネル。`pages/AdminPage.jsx` だけが import する

**Example**: カスタム hooks は存在しない。Page コンポーネントが `useState` / `useEffect` / `useRef` を直接持つ。

### Vonage Video セッションの接続識別子はアプリケーション ID
**Location**: `backend/src/config/env.js`（`env.vonage`）、`sessionService.js` → `sessionRoutes.js` → `CallPage.jsx`

 クライアント SDK の `initSession` 第 1 引数は、SDK 内部では `partnerId` として扱われる。
 この値は `https://config.opentok.com/project/{partnerId}/config.json` を引いて
 **接続先 API ホスト（含意するセッション情報）を決める**ため、形状が違えば接続できない。

| 識別子 | 環境変数 | 形 | 用途 |
| --- | --- | --- | --- |
| Video application ID | `VONAGE_VIDEO_APPLICATION_ID` | UUID(36) | サーバー側のトークン署名・監視 API、**かつクライアント `initSession` の第 1 引数** |
| 秘密鍵 | `VONAGE_VIDEO_PRIVATE_KEY_PATH` | PEM | 上記 application ID の秘密鍵 |
| API キー | `VONAGE_API_KEY` | 8 文字 | 旧 OpenTok プロジェクト用。Vonage Video アプリケーションのセッション接続には**使わない** |

- `POST /sessions/:id/token`、`POST /sessions/:id/guest-token`、`POST /sessions/join/:tokenId` は
  `applicationId` を返す。**フロントはその値を `initSession` に渡す**。
- **実測**: 8 文字の API キーを渡すと、`config.json` は 200 で返るが
  返す `apiUrl` が旧ホスト（`api-standard.opentok.com`）になり、そこからセッション情報を
  取得すると `<error code="403"/>` ONLY となる。SDK はこれを例外へ変換するため、
  UI には「接続に失敗しました/reconnect」としか出ない。streamId を見る機会すらない。
- 判別方法: `initSession` の第 1 引数を変えた状態で
  `GET {config.json の apiUrl}/session/{sessionId}?extended=true` を叩き、
  `session_id` が返るか `<error>` になるかを見る。
- Vonage 公式ドキュメントも「Vonage アプリケーションを使う場合、このパラメータには
  アプリケーション ID を渡す」と明記している（パラメータ名が歴史的経緯で `apiKey` のまま）。

### Video Session Monitoring Webhook（新機能）
**Location**: `backend/src/services/monitoringRoutes.js`、`backend/src/services/roomLifecycleService.js`、`backend/src/infra/videoClient.js` (`disconnectClient`)

 Vonage Video API の **Session Monitoring** コールバックを受け、ユーザー・管理者の接続を監視する。

- エンドポイント: `POST /webhooks/video-events`（署名検証付き。`webhookSignature` ミドルウェアを再利用）
- ペイロード: `connectionCreated` / `connectionDestroyed` イベント
  - `connection.data` には JSON 文字列で `{ userId, role }` が埋め込まれており、話者分離の識別子として用いる
- 無効化トリガー: **ユーザーと管理者の全員が退室した直後**
  1. 在室記録（`SessionPresence`）から退出接続を除去
  2. `shouldCloseRoom`（domain）で「一度は使われた・記録あり・空室」を判定
  3. `markClosed`（条件付き更新）で無効化の所有権を取得（冪等）
  4. その室の未消費入室トークン（`JoinToken`）を一括無効化
  5. その室に紐づく全予約を `completed` に更新
  6. **新規入室を拒否**（`/sessions/:id/guest-token` と `/sessions/join/:tokenId` が `room_closed` / `join_token_room_closed` を返す）

- **Vonage 側の残存接続は切断しない**（在室記録が空時点で切断対象は 0 件）。
  代わりに「無効化後の入室試行」を `connectionCreated` で検知し、その接続を `disconnectClient(sessionId, connectionId)` で強制切断する。これが実質的な「室内残存者の追い出し」経路。

- 署名検証: 既存の `webhookSignature.js`（JWT Bearer）を再利用。Video 監視コールバックも署名シークレット（`VONAGE_SIGNATURE_SECRET`）で保護可能。fail-closed（本番で未設定時 503）を維持。

- 既存 API キー (`VONAGE_API_KEY`) との混同禁止。Video monitoring は application ID + 秘密鍵で認証するため、API キーは使わない。

### フロントエンドの入室フロー（新機能）
**Location**: `frontend/src/pages/JoinPage.jsx`、`frontend/src/pages/CallPage.jsx`、`frontend/src/api/client.js`、`frontend/src/App.jsx`

 WhatsApp 経由で届く **一度だけ有効な入室リンク** (`/join/:tokenId`) を実装。

1. 受信者がリンクをタップ → `JoinPage` が `POST /sessions/join/:tokenId` を叩く
2. バックエンドはトークンを atomic に消費し、ゲスト publisher トークン（`token`, `sessionId`, `apiKey` 等）を返す
3. `JoinPage` は取得トークンを `sessionStorage['vvr.joinToken']` に保存し、`/call/:sessionId` へ遷移
4. `CallPage` マウント時に `sessionStorage` を確認し、あれば再取得せずそのまま接続（同タブ刷新に対応）
5. 通話終了（ハングアップ / 画面遷移）時に `sessionStorage` を消費済みにする

- 入室リンクは **初回クリックで消費** される（二重クリック・別タブ開きは 410 `already_used` / `room_closed` で拒否）
- URL 自体が bearer secret なのでログ・エラーにトークン ID を含めない

### 入室トークン・在室状況の永続化（新機能）
**Location**: `backend/src/infra/joinTokenModel.js`、`backend/src/infra/joinTokenStore.js`、`backend/src/infra/sessionPresenceModel.js`、`backend/src/infra/sessionPresenceStore.js`、`backend/src/domain/joinLink.js`、`backend/src/domain/sessionPresence.js`

- `JoinToken`: 推測不能な 16 バイト hex `tokenId`、予約 ID、セッション ID、有効期限（予約時刻 + 3h、最低 30 分）、`consumedAt` / `invalidatedAt` で once-only / room-closed を表現
- `SessionPresence`: 接続配列（`connectionId`, `userId`, `role`, `joinedAt`）、`openedAt` / `closedAt` で「誰か入ったことがあるか」「無効化済みか」を判定
- `shouldCloseRoom`: `openedAt != null` かつ `connections.length === 0` かつ `closedAt == null` の 3 条件
- 同一 `sessionId` に複数予約が紐づく場合、`findBySessionId` で全件 `completed` にする

### テストは同居
**Location**: ソースと同一ディレクトリ
**Purpose**: `__tests__/` も `test/` ミラーツリーも作らない。Jest の `testMatch: ["**/*.test.js"]` が唯一の選択機構。
**Example**: `domain/groupBySpeaker.js` ↔ `domain/groupBySpeaker.property.test.js`。例外は frontend の共有 setup ファイル `frontend/src/test/setup.js` のみ。

### レイヤーバレルは「宣言だけ」
**Location**: `backend/src/{domain,infra,services}/index.js`
**Purpose**: 各層の公開サーフェスを 1 箇所にまとめる宣言用ファイル。
**重要**: **現状、ソースはこれを一切 import していない。** 具体的なファイルを直接 import する形が確立した規約になっている。新モジュールは barrel への追記なしでもよい。**「barrel 経由の import は 0 件」を既定として維持する。**

## Naming Conventions

### ファイル

| 種別 | 規約 | 例 |
| --- | --- | --- |
| backend モジュール | **camelCase**（区切りなし） | `availability.js`, `groupBySpeaker.js`, `whatsAppClient.js` |
| エントリ / バレル | `index.js` | `domain/index.js`, `src/index.js` |
| ユニットテスト | `<subject>.test.js` | `reservationService.test.js` |
| プロパティテスト | `<subject>.property.test.js` | `availability.property.test.js` |
| 統合テスト | `<subject>.integration.test.js` | `recording.integration.test.js` |
| 振る舞い別テスト | `<subject>.<aspect>.test.js` | `conversation.dateOptions.test.js` |
| React コンポーネント | **PascalCase + `.jsx`** | `AdminPage.jsx`, `CallPage.jsx` |
| ロケール / スタイル | `<lang>.json`, camelCase | `ja.json`, `global.css` |

**注意**: 仕様書（spec）のコンポーネント名は `Pascal_Snake_Case`（`Reservation_System`, `Notification_Service`）だが、これは**ドメイン上の呼び名であって、識別子には絶対に使わない**。実装ではアンダースコアを落として `reservationService.js` / `reservationService` になる。この名前体系は日本語コメントと JSDoc 内でのみ生き残る。

### 関数・識別子

- 関数は **camelCase の動詞** — `checkAvailability`, `canAccess`, `nextStep`, `buildArchiveOptions`, `groupBySpeaker`, `selectDueReservations`, `validateReservation`
- ファクトリは **`createX` / `createXService` / `createXRouter`** — `createApp`, `createStatusEmitter`, `createRecordingService`, `createInMemoryStateStore`
- 既定シングルトンは **素の名詞**（`default` 接頭辞なし）。そして必ず名前付き export と `export default` の 2 つを併記する:
  ```js
  export const reservationService = createReservationService();
  export default reservationService;
  ```
  エラーコードやファクトリも同時に取りたい場合は**名前付き**形式を使う: `import { createReservationService, ReservationErrorCode } from './reservationService.js';`
- 設定は camelCase: `env.clientOrigin`, `env.vonage.videoApplicationId`, `env.notificationCron`

### enum / 定数マップ

**厳密なペア規約**（`domain/constants.js` で一貫）:
```js
export const ReservationStatus = Object.freeze({ PENDING: 'pending', /* ... */ });
export const RESERVATION_STATUSES = Object.freeze(Object.values(ReservationStatus));
```
- キー = `UPPER_SNAKE_CASE` の `PascalCase` オブジェクト、派生配列 = `UPPER_SNAKE_CASE`
- **値 = `lower_snake_case` 文字列**（camelCase ではない）。`MANAGE_RESERVATION: 'manage_reservation'` のようにキーと値で表記がずれるのは意図的
- 同型のペアを `services/recordingService.js`（`RecordingErrorCode` / `RecordingStatus`）と `frontend/src/api/auth.js`（`ROLES`）、`frontend/src/api/socket.js`（`SOCKET_EVENTS`）でも使う

### その他の規約

- **「型」は `domain/types.js` の JSDoc typedef のみ。** そこが唯一の型定義場所。命名は `PascalCase`、フィールドは camelCase
- React コンポーネントは **`export default function PascalCase()`**。名前付きコンポーネント export は使わない
- CSS は **kebab-case BEM**。ブロック `.app-shell`、エレメント `.admin-menu__item`、モディファイア `.admin-menu__item--active`。**状態モディファイアは wire 上のステータスをそのまま underscored で使う**（`.recording-badge--start_failed`）
- CSS デザイントークンは `global.css` の `:root` に置き、`var(...)` で参照する。スキン側は実行時変数 1 つ（`--call-skin-overlay`）だけ上書きする
- i18n キーは **dotted lowercase namespace → camelCase leaf**。`admin.reserve.status.pending`, `call.skins.telemedicine`
- API ルートは **複数形 kebab-case 名詞**。パラメータは `:archiveId` のように lowerCamel
- Socket イベントは **`resource:event` のコロン名前空間**。サーバー側とクライアント側の両方で**定数として export する**（イベント名を素の文字列で書かない）
- 失敗コードは `lower_snake_case`。Router ごとに `Object.freeze` した `ERROR_STATUS` マップで HTTP status に写像する

## Import Organization

### パスエイリアスは存在しない

`tsconfig.json` も `jsconfig.json` も Vite の `resolve.alias` も無い。**100% 相対パスで、拡張子を必ず付ける**（ネイティブ ESM の要件）。唯一の例外はロケール JSON（`import en from './locales/en.json';` のように拡張子省略）。

### 並び順の規約

1. Node 標準モジュールを先頭に、`node:` プレフィックス付き。空行で区切る
2. サードパーティパッケージ
3. 空行を挟んで自前の相対 import。**同層の兄弟 → 上位層**の順

```js
import { randomUUID } from 'node:crypto';

import { Router } from 'express';

import { reservationService as defaultReservationService } from './reservationService.js';
import { authorize as defaultAuthorize } from './authMiddleware.js';
import { AuthAction } from '../domain/constants.js';
```

複数名 import は**複数行で展開し、末尾カンマ + 閉じ波括弧を独立行**にする。

### 副作用 import は先頭のブートストラップのみ

`import 'dotenv/config'` / `import './styles/global.css'` / `import '../styles/call.css'`。ここに置かない。

### バックエンドの依存注入：rename-on-import ＋ `??`

```js
import { reservationStore as defaultStore } from '../infra/reservationStore.js';

export function createReservationService(deps = {}) {
  const store = deps.store ?? defaultStore;
  const logger = deps.logger ?? console;
```
モジュール差し替え（`jest.mock`）ではなく、**この形**で注入する。

### フロントエンドの遅延ロード

第三次 SDK は初期バンドルから外す:
```js
let videoSdkPromise = null;
export function loadVideoSdk() {
  if (!videoSdkPromise) { videoSdkPromise = import('@vonage/client-sdk-video'); }
  return videoSdkPromise;
}
```
バックエンド側の `@vonage/*` も同様に動的 import する（import 時副作用ゼロの要件）。

## Code Organization Principles

### 依存方向

```
                  backend/src/index.js            ← Composition Root（実装を結ぶ唯一の場所）
                            │
        ┌───────────────────┼───────────────────┐
        ▼                   ▼                   ▼
  services/*Routes   services/*Service     infra/*（Mongoose / Vonage / Socket.IO）
  services/*Middleware          │                 ▲
                                └──── import ─────┘
        ▼
  services/*Client（whatsAppClient, webhookSignature, messageText）[同層の兄弟]
        ▼
   domain/*（純関数）◀── services と infra の双方から import される
        ▲
   config/env.js（services と infra から。ローカルモジュールは import しない）
```

**許可される辺**（現状違反ゼロ）

- `index.js` → `config/` `services/` `infra/`
- `services/*` → `domain/*`, `infra/*`, `config/env.js`, 兄弟 `services/*`
- `infra/*` → `domain/constants.js`（**enum のみ**）, `config/env.js`, 兄弟 `infra/*`
- `domain/*` → 兄弟 `domain/*` のみ

**禁止**（現在遵守されている）

- `domain/` → `infra/` `services/` `config/` へ import しない。**純粋関数が I/O を持たないことがプロパティテスト成立の前提**
- `infra/` → `services/` `index.js` へ import しない。永続化・外部 SDK がアプリ層を呼び戻さない
- `config/env.js` 以外での `process.env` 参照
- どのファイルからも自有レイヤーの `index.js` バレルを import しない（宣言のみ）

**意図的な例外（直すな）**: `whatsAppClient.js`（Vonage Messages）は外部 API ラッパなのに `services/` に置いてある。チャットボット／通知サービスのメッセージングポート責務であって、`infra/videoClient.js`（Vonage Video）と対になる。**この非対称は意図**であり、infra へ移すのは「改善」ではなく規約違反。

### エラー処理の分層（import ルールと同じ重みで守る）

- **infra は投げる** — ラップして `cause` を付ける。握り潰さない
  ```js
  throw new Error(`予約レコードの保存に失敗しました: ${err.message}`, { cause: err });
  ```
- **services は捕まえて結果オブジェクトに変換し、API 境界では投げない**
  ```js
  { ok: true, reservation }                              // 成功
  { ok: false, code: 'validation_error', errors }        // バリデーション失敗
  { ok: false, code: 'slot_unavailable', alternatives }  // 空きなし
  ```
- **`domain` だけが例外を投げる**（バリデーション）。services が受け取って `ok: false` に変える
- **Routes** はローカル `ERROR_STATUS` マップで `code` → HTTP status に写像し、想定外は `next(err)` で単一のエラーハンドラに渡す
- **トランスポートは例外を投げない** — 未配線の `io` は no-op。emit 失敗はログのみ

### フロントエンドの依存方向

```
main.jsx → App.jsx → pages/*, components/{Layout,RequireAuth}
pages/*   → components/admin/*, api/{client,auth,socket,video}, video/backgroundSkins.js, styles/call.css
components/admin/* → api/{client,auth}
api/{socket,auth}.js → api/client.js
```

- コンポーネントが page を import しない。`api/` が React やコンポーネントを import しない
- ページの CSS（`call.css`）は**そのページが自分で** import する。`global.css` のみ `main.jsx` で 1 回

### モジュールモックは「推移的な依存」を越えられない

Vitest の `vi.mock` は対象モジュールを**丸ごと置き換える**。そのモジュールを SUT が推移的に経由している場合、返していない export へ触れた時点で実行時例外になる（`No "X" export is defined on the mock`）。

実例: `CallPage` → `api/auth.js` → `api/client.js`。`client.js` を丸ごと置換すると `getAuthToken` が消え、`getCurrentUser()` が落ちる。

**対策**: SUT が推移的に使う export を持たせる自救手段があるなら、`importOriginal` で**部分モック**する。
```js
vi.mock('../api/client.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, api: { /* 上書きしたいものだけ */ } };
});
```
対象 export を 1 個ずつ足すより、将来 export が増えてもこちらが頑健です。

### 自動化の状況（把握しておくべき現実的なギャップ）

- ESLint / Prettier の設定・依存が無い（`eslint-disable` コメントのみ残存）
- CI が無い（`.github/` なし）。全品質ゲートは手動
- カバレッジ閾値が無い

---
_規約とパターンを記録する。ファイルツリーや網羅的リストは記載しない_

_Last updated: 2026-09-28（bootstrap）_
