/**
 * Chatbot_Service Webhook ルーティング（要件 1.1・1.2・1.5）
 *
 * Vonage Messages API（WhatsApp）の受信/ステータス Webhook を提供する Express Router。
 * 署名検証ミドルウェアで外部入力を検証した上で、Chatbot_Service に会話進行・予約登録・
 * 返信送信を委譲する。
 *
 * エンドポイント:
 *  - POST /webhooks/inbound-message : WhatsApp 受信（会話進行・予約登録）
 *  - POST /webhooks/message-status  : 送達ステータス
 *
 * レスポンス方針:
 *  Vonage Webhook は 2xx を返せば受領完了とみなされる。返信メッセージ送信は
 *  非同期的に Chatbot_Service 内で行われるため、ここでは処理結果の要約を 200 で返す。
 *  署名検証失敗のみ 401 を返す（webhookSignature ミドルウェア）。
 *
 * @module services/chatbotRoutes
 */

import { Router } from 'express';

import env from '../config/env.js';
import { chatbotService as defaultChatbotService } from './chatbotService.js';
import { verifyVonageWebhook } from './webhookSignature.js';

/**
 * Chatbot Webhook Router を生成する。テスト容易性のため依存を注入可能にする。
 *
 * @param {object} [deps]
 * @param {ReturnType<import('./chatbotService.js').createChatbotService>} [deps.chatbotService]
 * @param {import('express').RequestHandler} [deps.verifyWebhook] 署名検証ミドルウェア
 * @returns {import('express').Router}
 */
export function createChatbotRouter({
  chatbotService = defaultChatbotService,
  verifyWebhook = verifyVonageWebhook({ secret: env.vonage.messagesSignatureSecret }),
} = {}) {
  const router = Router();

  // POST /webhooks/inbound-message: 受信（要件 1.1・1.2・1.5）
  router.post('/inbound-message', verifyWebhook, async (req, res, next) => {
    try {
      const result = await chatbotService.handleInboundMessage(req.body ?? {});
      if (!result.ok && result.code === 'bad_request') {
        return res.status(400).json(result);
      }
      // 予約失敗（store/validation）も Webhook 受領自体は成功とし 200 で結果を返す。
      return res.status(200).json(result);
    } catch (err) {
      return next(err);
    }
  });

  // POST /webhooks/message-status: 送達ステータス
  router.post('/message-status', verifyWebhook, async (req, res, next) => {
    try {
      const result = await chatbotService.handleMessageStatus(req.body ?? {});
      return res.status(200).json(result);
    } catch (err) {
      return next(err);
    }
  });

  return router;
}

/** 既定の Chatbot Webhook Router（実 Chatbot_Service 依存）。 */
export const chatbotRouter = createChatbotRouter();

export default chatbotRouter;
