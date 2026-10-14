# Testing Standards

ドメイン層の **Correctness Property** を主軸にした二重戦略（backend = Jest + fast-check、frontend = Vitest）。テストは「製品コードと同じ場所」に置き、`npm test` 1 コマンドで両ワークスペースを必ず走らせる。

## Philosophy

- **生成的な入力にはプロパティテスト、具体例にはユニットテスト。** ドメイン層の業務規則（8 つ）はすべて `fast-check` で検証する。
- **純粋関数を;I/O から切り離すごとが検証可能性になる。** `domain/` に副作用を持ち込まないことが `testing.md` の前提である。
- **外部サービス挙動の網羅は追わない。** 統合テストは代表例 1〜3 件で足りる（設計上の明示的な方針）。
- **UI の見た目はスナップショットと目視**で検証し、property test の対象にしない。

## Organization

- **Co-located**（`backend` / `frontend` とも）。`__tests__/` ツリーは作らない。
  - backend: ソースと同一ディレクトリ、`*.test.js`
  - frontend: `src/**/*.test.{js,jsx}`
- 共有 setup は frontend の `src/test/setup.js` 1 ファイルのみ（jest-dom と `afterEach(cleanup)` だけ）。

## Naming（3 種のサフィックスで種別を表す）

| パターン | 種別 | 例 |
| --- | --- | --- |
| `<subject>.test.js` | ユニット | `reservationService.test.js` |
| `<subject>.property.test.js` | プロパティ（fast-check） | `availability.property.test.js` |
| `<subject>.integration.test.js` | 統合 | `recording.integration.test.js` |
| `<subject>.<aspect>.test.js` | 1 つの振る舞いに絞った | `conversation.dateOptions.test.js` |

`<aspect>` は「大きなモジュールから細かな振る舞いを切り出す」ときに使う（`conversation.reservationTime.test.js` は実 WhatsApp bug の回帰ガード）。

## Test Types

- **Unit** — 依存を `makeStore()` / `makeLogger()` のようなモジュールローカルファクトリでスタブ。極めて速い。
- **Property** — 下記「Property Tests」節を参照。
- **Integration** — 複数の実ユニットを together に動かし、**外部境界だけ**をモックする。
- **Frontend** — `@testing-library/react` による描画検証。外部 SDK ラッパー（`api/video.js`）と REST（`api/client.js`）をモック。

## Property Tests

ドメイン層の検証の主役。設計の **10 個の Correctness Property**（1:1 で `*.property.test.js` に対応）:

1. 会話遷移は常に有効な状態と選択肢を返す
2. 完了会話からの予約 DTO は必須フィールドを備える
3. 空き判定は重複時に必ず代替を提示する
4. 予約レコードの保存・取得ラウンドトリップ
5. 予約レコードのバリデーション
6. 到来予約の選択は期限到来かつ未通知に限定される
7. 認可判定はロールと所有関係に整合する
8. WhatsApp 送信言語は予約の対応言語と一致する
9. 文字起こし要時のアーカイブは必ず個別ストリームで有効化される
10. 文字起こし整形は全発話を保存し話者に対応付ける

**規約**

- 各テストに**タグを必ず付ける**:
  ```js
  /**
   * Feature: vonage-video-reservation, Property 3: 空き判定は重複時に必ず代替を提示する
   * Validates: Requirements 1.5
   */
  ```
- **反復回数**: 生成的な入力は **最低 100 回**（実体は 150〜400）。ただし**有限ドメイン**（入力が数個しかない性質）は 50 回でも可。
- **オラクルを独立実装する** — 判定ロジックを SUT を信用せず、テスト側で書き直す:
  ```js
  /** 半開区間 [start, end) の重複判定（テスト側の独立実装） */
  function overlaps(aStart, aEnd, bStart, bEnd) { return aStart < bEnd && bStart < aEnd; }
  ```
- **純度は別テストにする** — `JSON.stringify` の before/after 比較で、引数が破壊されないことを検証。
- **パーサ系は round-trip 必須** — Property 10（文字起こし整形）のように不変条件が破れやすいものは往復で検証する。

## Mocking & Data

- **backend: モジュール差し替えではなく依存注入。** `createXxx(deps)` にスタブを渡す。エクスポートの `vi/jest.mock` を使わない。
- **frontend: 外部境界だけをモック**（`api/video.js` / `api/client.js`）。ページやコンポーネントは mock しない。
- **推移的な依存跨越には `importOriginal` の部分モック**。理由は `structure.md`「モジュールモックは推移的な依存を越えられない」参照。
- **認証状態で分岐するコンポーネントに注意** — `localStorage` が空なら未ログイン経路を通る。片方のトークン API だけをモックすると、**別経路から実 fetch が走る**。
- 共通フィクスチャはモジュールローカルのファクトリ関数（`makeStore()` / `renderWithI18n()`）。`beforeEach` のデータ塊にしない。
- **外部 API の payload フィクスチャは「実測値」で作る。** 想定した形で書くと、外部の実際の形式とずれていてもテストは green になり、検出できない。
  - 実例: Vonage の文字起こし JSON は `transcription.segments`（ネスト）＋ `channels_metadata`（channel をキーにしたオブジェクト）。トップレベル `segments` ＋ 配列を想定したテストは 66 件 green だったが、実データでは常に空配列を返し、話者分離が全面的に無言で失敗していた。プロパティテストが「誤った形式」を生成していたため偽の保証になっていた。
  - **教訓**: 外部 API の仕様を受ける関数には、**実環境で取得した生の payload を写した回帰テストを 1 本置く**。生成子は実データに存在しないフィールドを生成しないこと（実在しない組み合わせの「修正」は Relay になる）。
  - 実 ZIP からの取得経路（`arrayBuffer` → 解凍 → JSON 抽出）も、ZIP をメモリ上に生成する fixture で別途固定する（実 ZIP は `Content-Type: application/zip` / 先頭 `PK\x03\x04` / 単一 `.json` エントリ）。

## Frontend 固有

- `I18nextProvider` でラップし、`beforeEach` で `changeLanguage('en')` して**言語を固定**。その上でリテラル文字列を検証する（`'Failed to connect to the call'` など）。
- **アクセシブルな role / name でクエリ**する: `getByRole('alert')`, `getByRole('button', { name: 'Reconnect' })`, `getByRole('status')`。data-testid を優先しない。
- `vi.mock` は SUT の import より**前**（ホイスティングされるため）。SUT import を mock の後ろに置く。
- `css: false` のため、テスト中は CSS を処理しない。

## Integration（backend）

- **`supertest` を導入しない**（明示的な方針）。Node 標準 `http` で実 HTTP リクエストを送る。
- `http.createServer(app)` を ephemeral ポートで立て、`http.request` で叩く。Socket.IO はローカル空ポートにのみ attach し、**外部接続やモックは行わない**（ヘーメティック）。
- モックするのは外部境界（Vonage Video クライアント、Socket.IO エミッタ、`authorize` ミドルウェア）のみ。

## Coverage

- **カバレッジしきい値は無い。** `coverage/` を gitignore しているだけで、`collectCoverage` も閾値設定も無い。品質ゲートは「テストが全部通るか」のみ。

## Test Entry Point

- ルート `npm test` = `npm run test --workspaces`（backend + frontend 両方）。
- 個別: `npm run test:backend` / `npm run test:frontend`。
- **`&&` で繋がない。** 片方の失敗で他方がスキップされ、「テストが実行されない」という穴になる。`--workspaces` は両方必ず実行し、終了コードは合算。
- CI は無い。必要なら `--workspaces` をそのまま CI に載せる。

---
_パターンと判断を記録する。ツール固有の設定は各所に散らばせずパターンとして_

_Last updated: 2026-09-28（bootstrap）_
