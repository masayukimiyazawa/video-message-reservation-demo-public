/**
 * フロントエンド SPA の配信（同一オリジン運用）
 *
 * 入室リンク（`/join/:tokenId`）は利用者がブラウザで直接開く URL だが、
 * React Router のクライアントサイドルートであり、HTML ファイル实体は存在しない。
 * バックエンド（4000）だけを公開している構成では `Cannot GET /join/xxx` になる。
 *
 * そこでビルド済みフロント（frontend/dist）をバックエンドから配信し、
 * API 以外の未知パスは index.html にフォールバック（history fallback）させる。
 * これにより「1 つの公開オリジン」で API と SPA の両方を配信でき、
 * トンネルやデプロイ先を 1 つだけ公開すればよくなる。
 *
 * 重要: API/Webhook のパスはフォールバックせず、通常の 404/401 のまま返す。
 * 認証が読めないパスが index.html を返すと、フロントが JSON として解釈し
 * 原因究明が難しくなるため。
 *
 * @module services/spaStatic
 */

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

import express from 'express';

/**
 * フォールバックさせない（API として扱う）パスの先頭。
 * ここに一致するリクエストは index.html ではなく API 側の応答を返す。
 */
export const API_PATH_PREFIXES = Object.freeze([
  '/api',
  '/auth',
  '/sessions',
  '/reservations',
  '/recordings',
  '/transcriptions',
  '/webhooks',
  '/monitoring',
  '/health',
  '/socket.io',
]);

/**
 * パスが API 系かどうかを判定する。
 * @param {string} pathname
 * @returns {boolean}
 */
export function isApiPath(pathname) {
  return API_PATH_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

/**
 * ビルド済みフロントエンドの配信ミドルウェアを生成する。
 *
 * @param {object} [deps]
 * @param {string} [deps.distDir] frontend/dist の絶対パス
 *   （既定は backend/ から相対解決: apps のモノレポ構成を想定）
 * @param {boolean} [deps.enabled=true] false なら何も返さない（dist 不在時のテスト用）
 * @returns {import('express').RequestHandler[] | null}
 *   dist が存在しない場合は null（開発中は Vite dev server が担当するため）
 */
export function createSpaStatic({ distDir, enabled = true } = {}) {
  if (!enabled) {
    return null;
  }

  // backend/ を cwd として相対解決する（node --watch src/index.js の実行位置）。
  const resolvedDist = resolve(distDir ?? join(process.cwd(), '..', 'frontend', 'dist'));

  if (!existsSync(join(resolvedDist, 'index.html'))) {
    return null;
  }

  const indexHtml = join(resolvedDist, 'index.html');

  // 1) 静的アセット（/assets/*.js など）。index.html フォールバックより先に当てる。
  const staticAssets = express.static(resolvedDist, { index: false });

  // 2) history fallback。GET かつ API 以外のみ index.html を返す。
  const historyFallback = (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return next();
    }
    if (isApiPath(req.path)) {
      return next();
    }
    return res.sendFile(indexHtml);
  };

  return [staticAssets, historyFallback];
}
