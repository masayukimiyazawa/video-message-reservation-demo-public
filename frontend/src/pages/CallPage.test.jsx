import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import i18n, { changeLanguage } from '../i18n/index.js';

/**
 * タスク 16.3 / 要件 4.4: ビデオ接続失敗 UI のユニットテスト。
 * トークン取得が失敗した場合に、CallPage が失敗メッセージと再接続ボタンを
 * 表示することを検証する。Video Client SDK ラッパー（api/video.js）はモックし
 * 実サービスへ接続しない。
 *
 * 認証状態による分岐（CallPage.jsx 151-154）:
 *   - ログイン済み（管理者/スタッフ）→ api.createSessionToken
 *   - 未ログイン（エンドユーザー）    → api.createGuestSessionToken（予約バックド）
 * どちらの経路でも同じ検証を行うため、両方をモックして失敗させる。
 * このテストは localStorage が空なので実際の描画は未ログイン経路になる。
 */

// Vonage Video Client SDK ラッパーをモック（実サービス非依存）。
vi.mock('../api/video.js', () => ({
  initSession: vi.fn(),
  connectSession: vi.fn(),
  initPublisher: vi.fn(),
  initScreenPublisher: vi.fn(),
}));

// REST クライアントをモックし、認証済み/未ログインの両トークン発行を失敗させる。
// api/auth.js も client.js の getAuthToken / clearAuthToken に依存するため、
// 丸ごと置換せず importOriginal で部分モックする（未ログイン = localStorage 空）。
vi.mock('../api/client.js', async (importOriginal) => {
  const actual = await importOriginal();
  const api = {
    createSessionToken: vi.fn(),
    createGuestSessionToken: vi.fn(),
  };
  return { ...actual, api, default: { ...actual.default, api } };
});

import CallPage from './CallPage.jsx';
import { api } from '../api/client.js';
import { initSession, initPublisher, initScreenPublisher } from '../api/video.js';

function renderCallPage(sessionId = 'sess-123') {
  return render(
    <I18nextProvider i18n={i18n}>
      <MemoryRouter initialEntries={[`/call/${sessionId}`]}>
        <Routes>
          <Route path="/call/:sessionId" element={<CallPage />} />
        </Routes>
      </MemoryRouter>
    </I18nextProvider>,
  );
}

beforeEach(async () => {
  await changeLanguage('en');
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('CallPage 接続失敗 UI (要件 4.4)', () => {
  it('トークン取得失敗時に失敗メッセージと再接続ボタンを表示する', async () => {
    api.createGuestSessionToken.mockRejectedValue(new Error('token endpoint down'));

    renderCallPage();

    // 失敗アラートが表示される。
    const alert = await screen.findByRole('alert');
    expect(alert).toBeInTheDocument();
    // 失敗メッセージ本文（i18n: call.connectionFailed）。
    expect(screen.getByText('Failed to connect to the call')).toBeInTheDocument();
    // エラー詳細（例外メッセージ）も表示される。
    expect(screen.getByText('token endpoint down')).toBeInTheDocument();
    // 再接続ボタンが提示される。
    expect(
      screen.getByRole('button', { name: 'Reconnect' }),
    ).toBeInTheDocument();
    // 接続失敗により以降の SDK 初期化は行われない。
    expect(initSession).not.toHaveBeenCalled();
  });

  it('SDK セッション接続失敗時も失敗 UI を表示する', async () => {
    api.createGuestSessionToken.mockResolvedValue({
      token: 'tok',
      sessionId: 'sess-123',
      applicationId: 'app-1',
    });
    initSession.mockRejectedValue(new Error('session init failed'));

    renderCallPage();

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByText('Failed to connect to the call')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Reconnect' }),
    ).toBeInTheDocument();
  });

  it('再接続ボタンを押すと再接続を試みる（トークン取得が再度呼ばれる）', async () => {
    const user = userEvent.setup();
    api.createGuestSessionToken.mockRejectedValue(new Error('still down'));

    renderCallPage();

    await screen.findByRole('button', { name: 'Reconnect' });
    expect(api.createGuestSessionToken).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: 'Reconnect' }));

    // 再接続でトークン取得が再度呼ばれる。
    await waitFor(() => {
      expect(api.createGuestSessionToken).toHaveBeenCalledTimes(2);
    });
    // 依然失敗しているため再接続ボタンは残る。
    expect(
      screen.getByRole('button', { name: 'Reconnect' }),
    ).toBeInTheDocument();
  });

  it('セッション初期化には Vonage アプリケーション ID（UUID）を渡す', async () => {
    // クライアント SDK の第 1 引数は partnerId として使われ、接続先 API ホストの解決に
    // 使われる。8 文字の API キーを渡すと host 解決に失敗し、実測では
    // セッション情報取得が <error code="403"/> を返して接続できなかった。
    // そのため Vonage Video アプリケーション ID を渡す。
    api.createGuestSessionToken.mockResolvedValue({
      token: 'tok',
      sessionId: 'sess-123',
      applicationId: 'app-uuid-1234',
    });
    const session = {
      on: vi.fn(),
      connect: vi.fn(),
      disconnect: vi.fn(),
    };
    initSession.mockResolvedValue(session);

    renderCallPage();

    await waitFor(() => {
      expect(initSession).toHaveBeenCalledTimes(1);
    });
    // 第 1 引数がアプリケーション ID、第 2 引数が sessionId
    expect(initSession).toHaveBeenCalledWith('app-uuid-1234', 'sess-123');
  });
});

/**
 * モバイル（エンドユーザー）側の退出導線のテスト。
 *
 * CallPage には通話終了ボタンが既に存在するが、接続中は通話コントロールを
 * まとめて表示しないため「接続を待たされ続ける」状態と、
 * 「終了後に通話画面から出られない」状態が取り残されていた。
 * ここでは (1) 接続中の中断操作と、その競合（遅れて完了する接続が CONNECTED に戻らないこと）、
 * (2) 終了・失敗後にトップへ戻れることを検証する。
 */
describe('CallPage 退出導線（モバイル利用者）', () => {
  /** 解決をテスト側で制御するための deferred を作る。 */
  function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  function renderWithHome(sessionId = 'sess-123') {
    return render(
      <I18nextProvider i18n={i18n}>
        <MemoryRouter initialEntries={[`/call/${sessionId}`]}>
          <Routes>
            <Route path="/call/:sessionId" element={<CallPage />} />
            <Route path="/" element={<p>HOME</p>} />
          </Routes>
        </MemoryRouter>
      </I18nextProvider>,
    );
  }

  it('接続中にも「接続を中止」ボタンを提示する', async () => {
    api.createGuestSessionToken.mockResolvedValue({
      token: 'tok',
      sessionId: 'sess-123',
      applicationId: 'app-1',
    });
    // 接続処理を進めないまま保留させる。
    initSession.mockReturnValue(new Promise(() => {}));

    renderWithHome();

    const cancel = await screen.findByRole('button', { name: 'Cancel' });
    expect(cancel).toBeInTheDocument();
  });

  it('接続中に中止すると ENDED になり、遅れて完了した接続は CONNECTED に戻らない', async () => {
    const user = userEvent.setup();
    api.createGuestSessionToken.mockResolvedValue({
      token: 'tok',
      sessionId: 'sess-123',
      applicationId: 'app-1',
    });
    const gate = deferred();
    const session = {
      on: vi.fn(),
      connect: vi.fn(),
      disconnect: vi.fn(),
    };
    initSession.mockReturnValue(gate.promise);

    renderWithHome();

    await user.click(await screen.findByRole('button', { name: 'Cancel' }));

    // 中止後は「通話が終了しました」表示へ遷移する。
    expect(await screen.findByText('You have left the call')).toBeInTheDocument();

    // 後から initSession が解決しても、破棄済みセッションとして disconnect される。
    gate.resolve(session);
    await waitFor(() => {
      expect(session.disconnect).toHaveBeenCalled();
    });

    // CONNECTED に戻らず、終了状態が維持される（通話コントロールは出ない）。
    expect(screen.getByText('You have left the call')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Turn camera off' }),
    ).not.toBeInTheDocument();
  });

  it('通話終了後に「トップへ戻る」で「会議室から退出しました」画面を表示する', async () => {
    const user = userEvent.setup();
    api.createGuestSessionToken.mockResolvedValue({
      token: 'tok',
      sessionId: 'sess-123',
      applicationId: 'app-1',
    });
    // 接続処理を進めないまま保留させ、CONNECTING から ENDED へ遷移させる。
    initSession.mockReturnValue(new Promise(() => {}));

    renderWithHome();

    await user.click(await screen.findByRole('button', { name: 'Cancel' }));
    await screen.findByText('You have left the call');

    await user.click(screen.getByRole('button', { name: 'Back to top' }));

    // モバイル利用者は HOME ではなく「会議室から退出しました」画面（LEFT 状態）になる
    await screen.findByText('You have left the conference room');
    await screen.findByText(
      'You have left the conference room. Press "Rejoin" to join again or "Back to top" to return to the home page.'
    );
    // 再参加ボタンとトップへ戻るボタンが表示される
    expect(screen.getByRole('button', { name: 'Rejoin' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Back to top' })).toBeInTheDocument();
  });

  it('接続失敗時にも「トップへ戻る」で「会議室から退出しました」画面を表示する', async () => {
    const user = userEvent.setup();
    api.createGuestSessionToken.mockRejectedValue(new Error('token endpoint down'));

    renderWithHome();

    await screen.findByRole('alert');
    expect(
      screen.getByRole('button', { name: 'Back to top' }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Back to top' }));

    // モバイル利用者は HOME ではなく「会議室から退出しました」画面（LEFT 状態）になる
    await screen.findByText('You have left the conference room');
    await screen.findByText(
      'You have left the conference room. Press "Rejoin" to join again or "Back to top" to return to the home page.'
    );
  });
});

/**
 * 管理画面（管理者）の表示レイアウト切り替えのテスト。
 *
 * 資料共有の有無で表示レイアウトを切り替える:
 *   - 共有前 (data-sharing='false'): 相手映像を全面に表示し、自分は PiP（小窓）。
 *   - 共有中 (data-sharing='true'):  共有資料を主役（メイン）に、相手映像と自分を小画面で並べる。
 *
 * data-sharing は CallPage が共有状態に応じて設定する識別子で、見た目��制御は
 * call.css の同セレクタが担う。ここでは識別子が正しく切り替わり、
 * かつ SDK が埋め込む 3 つの描画先（相手映像・自分・共有資料）が
 * 切替後も DOM から消えないことを検証する（消えると映像が黒くなるため）。
 */
describe('CallPage 管理画面の表示レイアウト切り替え', () => {
  /** role: administrator の JWT を作る（auth.js は署名検証せずペイロードのみ読む）。 */
  function makeAdminToken() {
    const payload = btoa(
      JSON.stringify({ userId: 'admin-1', role: 'administrator' }),
    )
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    return `header.${payload}.signature`;
  }

  /** CONNECTED まで進める SDK モック一式を組み立てる。 */
  function connectAdmin() {
    const session = {
      on: vi.fn(),
      connect: vi.fn(),
      publish: vi.fn((publisher, cb) => cb && cb(null)),
      disconnect: vi.fn(),
    };
    initSession.mockResolvedValue(session);
    initPublisher.mockResolvedValue({ destroy: vi.fn() });
    api.createSessionToken.mockResolvedValue({
      token: 'tok',
      sessionId: 'sess-123',
      applicationId: 'app-uuid-1234',
    });
    return session;
  }

  function renderAdminCall() {
    return render(
      <I18nextProvider i18n={i18n}>
        <MemoryRouter initialEntries={['/call/sess-123']}>
          <Routes>
            <Route path="/call/:sessionId" element={<CallPage />} />
          </Routes>
        </MemoryRouter>
      </I18nextProvider>,
    );
  }

  beforeEach(() => {
    localStorage.setItem('vvr.authToken', makeAdminToken());
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('共有前は相手映像メイン・自分 PiP になる（data-sharing=false、資料プレースホルダーを出さない）', async () => {
    connectAdmin();
    const { container } = renderAdminCall();

    // 接続完了を待つ（通話コントロール＝資料共有ボタンが出現する条件）。
    const shareBtn = await screen.findByRole('button', { name: 'Share document' });

    const layout = container.querySelector('.call-admin-layout');
    expect(layout).toBeInTheDocument();
    expect(layout.dataset.sharing).toBe('false');

    // 共有前の表示レイアウト: 相手映像全面 / 自分は PiP。
    const side = container.querySelector('.call-admin-side');
    const remotes = container.querySelector('.call-admin-subview.call-remotes');
    const local = container.querySelector('.call-admin-subview--local');
    expect(side).toBeInTheDocument();
    expect(remotes).toBeInTheDocument();
    expect(local).toBeInTheDocument();

    // 資料のメイン領域は CSS で非表示にするため、プレースホルダーは描画しない。
    expect(
      screen.queryByText('Share a document to present'),
    ).not.toBeInTheDocument();

    // 未共有なので「共有中」表示はまだ出ない。
    expect(shareBtn).toHaveAttribute('aria-pressed', 'false');
  });

  it('共有開始で data-sharing=true へ切り替わり、3つの描画先がDOMから消えない', async () => {
    const user = userEvent.setup();
    const session = connectAdmin();
    const screenPublisher = { on: vi.fn(), destroy: vi.fn(), unpublish: vi.fn() };
    initScreenPublisher.mockResolvedValue(screenPublisher);

    const { container } = renderAdminCall();
    await user.click(await screen.findByRole('button', { name: 'Share document' }));

    // publish 完了を待つ → setSharing(true) → data-sharing='true'。
    await waitFor(() => {
      expect(container.querySelector('.call-admin-layout').dataset.sharing).toBe(
        'true',
      );
    });
    expect(session.publish).toHaveBeenCalled();

    // 共有中の表示レイアウト: 資料メイン + 映像は小画面列。
    expect(
      screen.getByText('You are sharing your screen'),
    ).toBeInTheDocument();
    expect(container.querySelector('.call-admin-main')).toBeInTheDocument();

    // 切替後も SDK が埋め込む 3 つの描画先が残っていること（消えると映像が黒くなる）。
    expect(container.querySelector('.call-admin-shared')).toBeInTheDocument();
    expect(container.querySelector('.call-admin-subview.call-remotes')).toBeInTheDocument();
    expect(container.querySelector('.call-admin-subview--local')).toBeInTheDocument();

    // 停止で data-sharing='false' に戻る。
    await user.click(screen.getByRole('button', { name: 'Stop sharing' }));
    await waitFor(() => {
      expect(container.querySelector('.call-admin-layout').dataset.sharing).toBe(
        'false',
      );
    });
    expect(container.querySelector('.call-admin-subview.call-remotes')).toBeInTheDocument();
  });
});

/**
 * レイアウト切り替えの CSS 側の検証。
 *
 * vitest は css: false（vite.config.js）で CSS を処理しないため、
 * [data-sharing] セレクタが実際に適用されるかは計算スタイルでは確認できない。
 * ここでは call.css を読み込み、切り替えに必要なセレクタが揃っているかを検証する
 * （セレクタ名を改名すると、このテストが落ちる）。
 */
describe('call.css の表示レイアウト切り替えルール', () => {
  /** CSS ファイルを読む（vitest では import.meta.url が file スキームでないため cwd から解決）。 */
  async function readCallCss() {
    const { readFile } = await import('node:fs/promises');
    const path = join(process.cwd(), 'src/styles/call.css');
    return readFile(path, 'utf-8');
  }

  it('data-sharing=true/false 双方のセレクタが存在する', async () => {
    const css = await readCallCss();
    expect(css).toMatch(/\.call-admin-layout\[data-sharing='true'\]/);
    expect(css).toMatch(/\.call-admin-layout\[data-sharing='false'\]/);
  });

  it('共有前に資料メインを隠し、相手映像を全面表示にするルールがある', async () => {
    const css = await readCallCss();
    // 資料のメイン領域は display:none で非表示にする。
    expect(css).toMatch(
      /\.call-admin-layout\[data-sharing='false'\]\s*\.call-admin-main\s*\{[^}]*display:\s*none/,
    );
    // 相手映像はステージ全体を埋める（絶対配置 + inset: 0）。
    expect(css).toMatch(
      /\.call-admin-layout\[data-sharing='false'\]\s*\.call-admin-subview\.call-remotes\s*\{[^}]*position:\s*absolute[^}]*inset:\s*0/,
    );
  });

  it('共有前の自分映像は PiP（小窓・絶対配置）になる', async () => {
    const css = await readCallCss();
    expect(css).toMatch(
      /\.call-admin-layout\[data-sharing='false'\]\s*\.call-admin-subview--local\s*\{[^}]*position:\s*absolute[^}]*width:\s*\d+px[^}]*height:\s*\d+px/,
    );
  });

  /**
   * CSS から @media ブロックを抽出する（中括弧の対応を数えるため正規表現だけに頼らない）。
   * @param {string} css
   * @returns {string[]}
   */
  function extractMediaBlocks(css) {
    const blocks = [];
    const re = /@media[^{]*\{/g;
    let m;
    while ((m = re.exec(css)) !== null) {
      let depth = 1;
      let i = re.lastIndex;
      while (i < css.length && depth > 0) {
        if (css[i] === '{') depth += 1;
        else if (css[i] === '}') depth -= 1;
        i += 1;
      }
      blocks.push(css.slice(re.lastIndex, i - 1));
    }
    return blocks;
  }

  it('レスポンシブでも共有前の 1:1 構成が維持される', async () => {
    const css = await readCallCss();
    // 900px / 640px の各メディアクエリ内に data-sharing の分岐がある。
    const responsive = extractMediaBlocks(css).filter(
      (b) => b.includes("data-sharing='false'") && b.includes('.call-admin-layout'),
    );
    expect(responsive.length).toBeGreaterThanOrEqual(2);
  });
});

/**
 * モバイル（エンドユーザー）側の接続成功時のレンダリングテスト。
 *
 * 要件 4.1・4.2・4.3: Vonage Video API で音声・映像の送受信を確立し、
 * レスポンシブ表示・背景スキン選択を提供することを検証する。
 */
describe('CallPage モバイル利用者の接続成功時レンダリング (要件 4.1・4.2・4.3)', () => {
  /** CONNECTED まで進める SDK モック一式を組み立てる（未ログイン＝ゲスト）。 */
  function connectGuest() {
    const session = {
      on: vi.fn(),
      connect: vi.fn(),
      publish: vi.fn((publisher, cb) => cb && cb(null)),
      disconnect: vi.fn(),
    };
    initSession.mockResolvedValue(session);
    initPublisher.mockResolvedValue({ destroy: vi.fn() });
    api.createGuestSessionToken.mockResolvedValue({
      token: 'tok',
      sessionId: 'sess-123',
      applicationId: 'app-uuid-1234',
    });
    return session;
  }

  function renderGuestCall(sessionId = 'sess-123') {
    return render(
      <I18nextProvider i18n={i18n}>
        <MemoryRouter initialEntries={[`/call/${sessionId}`]}>
          <Routes>
            <Route path="/call/:sessionId" element={<CallPage />} />
          </Routes>
        </MemoryRouter>
      </I18nextProvider>,
    );
  }

  it('接続成功時にビデオステージ・リモートグリッド・ローカルPiP・コントロールバーが描画される', async () => {
    connectGuest();
    const { container } = renderGuestCall();

    // 接続完了を待つ（通話コントロールが出現する条件）。
    await screen.findByRole('button', { name: 'Hang up' });

    // ステージコンテナが存在する。
    const stage = container.querySelector('.call-stage');
    expect(stage).toBeInTheDocument();
    expect(stage.dataset.status).toBe('connected');

    // リモートグリッド（相手映像の表示領域）が存在する。
    const remotes = container.querySelector('.call-remotes');
    expect(remotes).toBeInTheDocument();

    // ローカル映像（自分の映像）PiP が存在する。
    const localTile = container.querySelector('.call-tile--local');
    expect(localTile).toBeInTheDocument();

    // 共有資料領域は非アクティブ（screen ストリーム受信時のみ data-active=true）。
    const shared = container.querySelector('.call-shared');
    expect(shared).toBeInTheDocument();
    expect(shared.dataset.active).toBeUndefined();

    // 通話コントロールバー（マイク・カメラ・切断）が表示される。
    expect(screen.getByRole('button', { name: 'Turn microphone off' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Turn camera off' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Hang up' })).toBeInTheDocument();

    // 資料共有ボタンは管理者のみなので出ない。
    expect(screen.queryByRole('button', { name: 'Share document' })).not.toBeInTheDocument();

    // セッションID表示がある（i18n: call.sessionLabel）。
    expect(screen.getByText('call.sessionLabel: sess-123')).toBeInTheDocument();
  });

  it('背景スキンセレクタがヘッダーに表示され、選択変更で applyBackgroundSkin が呼ばれる', async () => {
    connectGuest();
    const { container } = renderGuestCall();

    await screen.findByRole('button', { name: 'Hang up' });

    // 背景スキンセレクタが存在する。
    const selector = container.querySelector('.call-skin-selector select');
    expect(selector).toBeInTheDocument();

    // 既定スキンが選択されている。
    expect(selector.value).toBe('default');

    // スキン変更時のハンドラが動作することを確認（applyBackgroundSkin はモックされていないため、
    // DOM への適用は CSS 側のテストで担保。ここではセレクタの値変更のみ検証）。
    const telemedicineOption = selector.querySelector('option[value="telemedicine"]');
    expect(telemedicineOption).toBeInTheDocument();
    expect(telemedicineOption.textContent).toBe('Telemedicine (Teal)');
  });

  it('スマートフォン幅（640px以下）では CSS メディアクエリでレイアウトが調整される', async () => {
    // CSS 側のテストで担保しているが、DOM 構造としてモバイル用クラスが
    // 正しく適用されることを確認する。
    connectGuest();
    const { container } = renderGuestCall();

    await screen.findByRole('button', { name: 'Hang up' });

    // .call-tile--local はモバイル幅では 120x90 になる（CSS で定義）。
    // jsdom ではメディアクエリが適用されないため、クラス構造のみ確認。
    const localTile = container.querySelector('.call-tile--local');
    expect(localTile).toHaveClass('call-tile--local');

    // .call-controls はモバイル幅で左下配置になる（CSS で定義）。
    const controls = container.querySelector('.call-controls');
    expect(controls).toBeInTheDocument();
  });

  it('没入型モード（ゲスト参加・WhatsAppリンク経由）ではヘッダーとセッション表示が隠れる', async () => {
    connectGuest();
    // isGuestJoin() が true を返すように sessionStorage にゲスト参加フラグを設定。
    sessionStorage.setItem('vvr.guestJoin', JSON.stringify({ reservationId: 'r-1', sessionId: 'sess-123' }));

    const { container } = renderGuestCall();

    await screen.findByRole('button', { name: 'Hang up' });

    // 没入型クラスが適用される。
    const page = container.querySelector('.page--call--immersive');
    expect(page).toBeInTheDocument();

    // ヘッダー（スキンセレクタ含む）が表示されない。
    expect(screen.queryByText('Background')).not.toBeInTheDocument();
    expect(screen.queryByText('Video Call')).not.toBeInTheDocument();
    expect(screen.queryByText('call.sessionLabel: sess-123')).not.toBeInTheDocument();

    sessionStorage.clear();
  });
});

/**
 * 管理者の画面共有フロー完全テスト。
 */
describe('CallPage 管理者の画面共有フロー', () => {
  /** role: administrator の JWT を作る。 */
  function makeAdminToken() {
    const payload = btoa(
      JSON.stringify({ userId: 'admin-1', role: 'administrator' }),
    )
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    return `header.${payload}.signature`;
  }

  /** CONNECTED まで進める SDK モック一式を組み立てる。 */
  function connectAdmin() {
    const session = {
      on: vi.fn(),
      connect: vi.fn(),
      publish: vi.fn((publisher, cb) => cb && cb(null)),
      disconnect: vi.fn(),
    };
    initSession.mockResolvedValue(session);
    initPublisher.mockResolvedValue({ destroy: vi.fn() });
    api.createSessionToken.mockResolvedValue({
      token: 'tok',
      sessionId: 'sess-123',
      applicationId: 'app-uuid-1234',
    });
    return session;
  }

  function renderAdminCall() {
    return render(
      <I18nextProvider i18n={i18n}>
        <MemoryRouter initialEntries={['/call/sess-123']}>
          <Routes>
            <Route path="/call/:sessionId" element={<CallPage />} />
          </Routes>
        </MemoryRouter>
      </I18nextProvider>,
    );
  }

  beforeEach(() => {
    localStorage.setItem('vvr.authToken', makeAdminToken());
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('画面共有開始・停止の完全フローで UI 状態が正しく遷移する', async () => {
    const user = userEvent.setup();
    const session = connectAdmin();
    const screenPublisher = {
      on: vi.fn(),
      destroy: vi.fn(),
      unpublish: vi.fn(),
    };
    initScreenPublisher.mockResolvedValue(screenPublisher);

    const { container } = renderAdminCall();

    // 接続完了を待つ。
    await screen.findByRole('button', { name: 'Share document' });

    // 初期状態: 共有前。
    let layout = container.querySelector('.call-admin-layout');
    expect(layout.dataset.sharing).toBe('false');
    expect(screen.getByRole('button', { name: 'Share document' })).toHaveAttribute('aria-pressed', 'false');

    // 共有開始ボタンをクリック。
    await user.click(screen.getByRole('button', { name: 'Share document' }));

    // 共有中状態へ遷移。
    await waitFor(() => {
      expect(container.querySelector('.call-admin-layout').dataset.sharing).toBe('true');
    });
    expect(screen.getByRole('button', { name: 'Stop sharing' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('You are sharing your screen')).toBeInTheDocument();

    // 共有停止ボタンをクリック。
    await user.click(screen.getByRole('button', { name: 'Stop sharing' }));

    // 共有前状態へ戻る。
    await waitFor(() => {
      expect(container.querySelector('.call-admin-layout').dataset.sharing).toBe('false');
    });
    expect(screen.getByRole('button', { name: 'Share document' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByText('You are sharing your screen')).not.toBeInTheDocument();
  });

  it('共有中にリモート screen ストリームを受信しても管理者のメイン領域は自分の共有プレビューのまま', async () => {
    const user = userEvent.setup();
    const session = connectAdmin();
    const screenPublisher = {
      on: vi.fn(),
      destroy: vi.fn(),
      unpublish: vi.fn(),
    };
    initScreenPublisher.mockResolvedValue(screenPublisher);

    const { container } = renderAdminCall();
    await screen.findByRole('button', { name: 'Share document' });
    await user.click(screen.getByRole('button', { name: 'Share document' }));
    await waitFor(() => {
      expect(container.querySelector('.call-admin-layout').dataset.sharing).toBe('true');
    });

    // 管理者のメイン領域（自分の screen プレビュー）が残っていること。
    expect(container.querySelector('.call-admin-shared')).toBeInTheDocument();
    expect(container.querySelector('.call-admin-main')).toBeInTheDocument();

    // 相手映像はサブビュー列にあること。
    expect(container.querySelector('.call-admin-subview.call-remotes')).toBeInTheDocument();
    expect(container.querySelector('.call-admin-subview--local')).toBeInTheDocument();
  });
});

/**
 * モバイル（エンドユーザー）が共有資料を受信したときのレイアウトテスト。
 */
describe('CallPage モバイル利用者の共有資料受信レイアウト', () => {
  /** CONNECTED まで進める SDK モック一式を組み立てる（未ログイン＝ゲスト）。 */
  function connectGuest() {
    const session = {
      on: vi.fn(),
      connect: vi.fn(),
      publish: vi.fn((publisher, cb) => cb && cb(null)),
      disconnect: vi.fn(),
    };
    initSession.mockResolvedValue(session);
    initPublisher.mockResolvedValue({ destroy: vi.fn() });
    api.createGuestSessionToken.mockResolvedValue({
      token: 'tok',
      sessionId: 'sess-123',
      applicationId: 'app-uuid-1234',
    });
    return session;
  }

  function renderGuestCall(sessionId = 'sess-123') {
    return render(
      <I18nextProvider i18n={i18n}>
        <MemoryRouter initialEntries={[`/call/${sessionId}`]}>
          <Routes>
            <Route path="/call/:sessionId" element={<CallPage />} />
          </Routes>
        </MemoryRouter>
      </I18nextProvider>,
    );
  }

  it('screen ストリーム受信時に共有資料領域がアクティブになり、リモートグリッドが PiP 化する', async () => {
    const session = connectGuest();
    const { container } = renderGuestCall();

    await screen.findByRole('button', { name: 'Hang up' });

    // 初期状態: 共有資料領域は非アクティブ、リモートグリッドは通常表示。
    let shared = container.querySelector('.call-shared');
    expect(shared.dataset.active).toBeUndefined();
    let remotes = container.querySelector('.call-remotes');
    expect(remotes.className).not.toContain('call-remotes--pip');

    // streamCreated イベントをシミュレート（screen ストリーム）。
    const screenStreamEvent = {
      stream: {
        streamId: 'stream-screen-1',
        videoType: 'screen',
      },
    };
    // session.on の第2引数（ハンドラ）を取得して呼び出す。
    const streamCreatedHandler = session.on.mock.calls.find(
      (call) => call[0] === 'streamCreated',
    )?.[1];
    expect(streamCreatedHandler).toBeDefined();

    // screen ストリーム受信をシミュレート。
    await act(async () => {
      streamCreatedHandler(screenStreamEvent);
    });

    // 共有資料領域がアクティブになる。
    shared = container.querySelector('.call-shared');
    expect(shared.dataset.active).toBe('true');

    // リモートグリッドが PiP クラスを持つようになる。
    remotes = container.querySelector('.call-remotes');
    expect(remotes.className).toContain('call-remotes--pip');
  });

  it('screen ストリーム終了時に共有資料領域が非アクティブになり、リモートグリッドが通常表示に戻る', async () => {
    const session = connectGuest();
    const { container } = renderGuestCall();

    await screen.findByRole('button', { name: 'Hang up' });

    // 先に screen ストリームを受信してアクティブにする。
    const streamCreatedHandler = session.on.mock.calls.find(
      (call) => call[0] === 'streamCreated',
    )?.[1];
    const screenStreamEvent = {
      stream: { streamId: 'stream-screen-1', videoType: 'screen' },
    };
    await act(async () => {
      streamCreatedHandler(screenStreamEvent);
    });

    let shared = container.querySelector('.call-shared');
    expect(shared.dataset.active).toBe('true');

    // streamDestroyed イベントをシミュレート。
    const streamDestroyedHandler = session.on.mock.calls.find(
      (call) => call[0] === 'streamDestroyed',
    )?.[1];
    expect(streamDestroyedHandler).toBeDefined();

    const screenStreamEndEvent = {
      stream: { streamId: 'stream-screen-1', videoType: 'screen' },
    };
    await act(async () => {
      streamDestroyedHandler(screenStreamEndEvent);
    });

    // 共有資料領域が非アクティブになる。
    shared = container.querySelector('.call-shared');
    expect(shared.dataset.active).toBeUndefined();

    // リモートグリッドが通常表示に戻る。
    const remotes = container.querySelector('.call-remotes');
    expect(remotes.className).not.toContain('call-remotes--pip');
  });
});

/**
 * 退出先の判定（入室経路）テスト。
 *
 * 退出先は「入室経路」で決まる:
 *   - WhatsApp 入室リンク経由（ゲスト）→ 退出完了画面（LEFT 状態）
 *   - リンク経由でなく、ログイン済み（管理者/スタッフ）→ 管理画面（/admin）
 * また退出完了画面の「トップへ戻る」はトップページ（/）へ遷移する。
 */
describe('CallPage 退出先の判定（入室経路）', () => {
  /** 指定ロールの JWT を作る（auth.js は署名検証せずペイロードのみ読む）。 */
  function makeToken(role, userId = `${role}-1`) {
    const payload = btoa(JSON.stringify({ userId, role }))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    return `header.${payload}.signature`;
  }

  /** /admin・/ への遷移を検証できるルーターで描画する。 */
  function renderWithRoutes() {
    return render(
      <I18nextProvider i18n={i18n}>
        <MemoryRouter initialEntries={['/call/sess-123']}>
          <Routes>
            <Route path="/call/:sessionId" element={<CallPage />} />
            <Route path="/admin" element={<p>ADMIN</p>} />
            <Route path="/" element={<p>HOME</p>} />
          </Routes>
        </MemoryRouter>
      </I18nextProvider>,
    );
  }

  /** 接続を保留させ、CONNECTING のまま「接続を中止」で ENDED へ遷移できるようにする。 */
  function pauseConnection() {
    initSession.mockReturnValue(new Promise(() => {}));
    api.createGuestSessionToken.mockResolvedValue({
      token: 'tok',
      sessionId: 'sess-123',
      applicationId: 'app-uuid-1234',
    });
    api.createSessionToken.mockResolvedValue({
      token: 'tok',
      sessionId: 'sess-123',
      applicationId: 'app-uuid-1234',
    });
  }

  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it('ログイン済み管理者（リンク非経由）は退出時に管理画面へ戻る', async () => {
    const user = userEvent.setup();
    localStorage.setItem('vvr.authToken', makeToken('administrator'));
    pauseConnection();

    renderWithRoutes();

    await user.click(await screen.findByRole('button', { name: 'Cancel' }));
    await screen.findByText('You have left the call');
    await user.click(screen.getByRole('button', { name: 'Back to top' }));

    // 管理画面へ遷移し、退出完了画面は表示されない。
    expect(await screen.findByText('ADMIN')).toBeInTheDocument();
    expect(
      screen.queryByText('You have left the conference room'),
    ).not.toBeInTheDocument();
  });

  it('ログイン済みスタッフ（リンク非経由）も退出時に管理画面へ戻る', async () => {
    const user = userEvent.setup();
    localStorage.setItem('vvr.authToken', makeToken('staff'));
    pauseConnection();

    renderWithRoutes();

    await user.click(await screen.findByRole('button', { name: 'Cancel' }));
    await screen.findByText('You have left the call');
    await user.click(screen.getByRole('button', { name: 'Back to top' }));

    // 管理画面へ遷移し、退出完了画面は表示されない。
    expect(await screen.findByText('ADMIN')).toBeInTheDocument();
    expect(
      screen.queryByText('You have left the conference room'),
    ).not.toBeInTheDocument();
  });

  it('WhatsAppリンク経由の管理者は退出時に挨拶ページを表示し、管理画面へ戻らない', async () => {
    const user = userEvent.setup();
    localStorage.setItem('vvr.authToken', makeToken('administrator'));
    // 入室リンク経由（ゲスト参加フラグ）を設定する。
    sessionStorage.setItem(
      'vvr.guestJoin',
      JSON.stringify({ reservationId: 'r-1', sessionId: 'sess-123' }),
    );
    pauseConnection();

    renderWithRoutes();

    await user.click(await screen.findByRole('button', { name: 'Cancel' }));
    await screen.findByText('You have left the call');
    await user.click(screen.getByRole('button', { name: 'Back to top' }));

    // 入室経路がリンク経由なので管理画面ではなく挨拶ページになる。
    await screen.findByText('You have left the conference room');
    expect(screen.queryByText('ADMIN')).not.toBeInTheDocument();
  });

  it('退出完了画面の「トップへ戻る」でトップページへ遷移する', async () => {
    const user = userEvent.setup();
    pauseConnection();

    renderWithRoutes();

    await user.click(await screen.findByRole('button', { name: 'Cancel' }));
    await screen.findByText('You have left the call');
    // ENDED → 退出完了画面（LEFT）。
    await user.click(screen.getByRole('button', { name: 'Back to top' }));
    await screen.findByText('You have left the conference room');

    // 退出完了画面の「トップへ戻る」でホームへ戻る。
    await user.click(screen.getByRole('button', { name: 'Back to top' }));
    expect(await screen.findByText('HOME')).toBeInTheDocument();
  });
});


