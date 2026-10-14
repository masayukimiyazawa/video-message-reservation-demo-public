# Requirements Document

## Introduction

本機能は、Vonage Video API を用いた予約機能付きビデオ通話アプリケーションである。エンドユーザーは WhatsApp（Vonage Messages API）上のリッチメディア対応チャットボットを通じて通話予約を行い、予約時刻になると WhatsApp 通知と管理者 UI 画面通知の両方を受け取る。管理者・スタッフはロールベースアクセス制御で保護された管理者 UI から予約を管理し、ビデオ通話を実施・録画し、録画を話者（ストリーム）単位で分離した文字起こしを取得できる。ビデオ通話 UI と管理者 UI はいずれもスマートフォンと PC の両方に対応するレスポンシブ設計であり、英語と日本語の言語選択に対応する。ビデオ通話 UI では、病院遠隔診療テーマを含む複数の背景スキンから選択して通話画面に適用できる。予約データは外部の MongoDB Atlas に保存される。

バックエンドは JavaScript/Node.js、フロントエンドは React SPA、データストアは MongoDB Atlas を用いる。ビデオ通話・録画（アーカイブ）は Vonage Video API、メッセージングは Vonage Messages API（WhatsApp）を用いる。

## Glossary

- **Reservation_System**: 予約の作成・保存・照会・状態管理を担うバックエンドサービス
- **Chatbot_Service**: Vonage Messages API（WhatsApp）を介してエンドユーザーと対話し予約を受け付けるサービス
- **Notification_Service**: 予約時刻の到来を検知し WhatsApp 通知および管理者 UI 通知を送出するサービス
- **Video_Call_UI**: エンドユーザーおよびスタッフが利用する Vonage Video API ベースのビデオ通話画面
- **Admin_UI**: 管理者・スタッフが予約管理・通話・録画操作を行う Web 画面（React SPA）
- **Auth_Service**: ロールベースアクセス制御（RBAC）による認証・認可を担うサービス
- **Recording_Service**: Vonage Video API のアーカイブ（録画）を開始・停止・管理するサービス
- **Transcription_Service**: Vonage Video API の Post-Call Transcription によりストリーム（話者）単位で分離された文字起こしを生成・取得するサービス
- **Reservation_Store**: MongoDB Atlas 上の予約データ永続化層
- **管理者 (Administrator)**: すべての予約管理・録画・文字起こし操作および権限を持つロール
- **スタッフ (Staff)**: 自身に割り当てられた予約に対する通話・録画などの限定的操作権限を持つロール
- **エンドユーザー (End_User)**: WhatsApp 経由で予約を行い、ビデオ通話に参加する利用者
- **予約時刻 (Reservation_Time)**: 予約レコードに保存された通話開始予定の日時
- **対応言語 (Supported_Language)**: 英語（en）または日本語（ja）
- **背景スキン (Background_Skin)**: ビデオ通話 UI に適用される選択可能な背景画像テーマ（病院遠隔診療テーマを含む複数から選択可能）

## Requirements

### 要件 1: WhatsApp チャットボットによる予約受付

**ユーザーストーリー:** エンドユーザーとして、WhatsApp 上のチャットボットで通話予約を行いたい。それにより、専用アプリをインストールせずに手軽に予約できる。

#### 受入基準

1. WHEN エンドユーザーが WhatsApp で予約開始メッセージを送信する, THE Chatbot_Service SHALL Vonage Messages API のインタラクティブメッセージ（リプライボタンまたはリストメッセージ）を用いて予約フローの選択肢を返信する
2. WHEN エンドユーザーが予約日時と対象サービスを選択して確定する, THE Chatbot_Service SHALL 予約情報を Reservation_System に登録要求として送信する
3. WHEN Reservation_System が予約登録要求を受信する, THE Reservation_System SHALL 予約レコードを Reservation_Store に保存する
4. WHEN 予約レコードの保存が完了する, THE Chatbot_Service SHALL WhatsApp で予約確定メッセージをエンドユーザーに送信する
5. IF 選択された予約日時が既に確保不可能である, THEN THE Chatbot_Service SHALL 予約不可の旨と代替日時の選択肢を WhatsApp で提示する
6. WHERE リッチメディアメッセージが要求される, THE Chatbot_Service SHALL 画像を含むメディアテンプレートまたはカルーセルメッセージを送信する

> **補足（起動トリガー）:** 予約フローの開始に特定のキーワードは不要です。エンドユーザーからの**最初のメッセージは内容を問わず**（例:「予約」「こんにちは」）、Chatbot_Service は予約フロー（サービス選択の選択肢）を返信します。統合テストや README のスモークテストで「予約」を用いているのは単なる慣例・サンプルです。

### 要件 2: 予約データの永続化（MongoDB Atlas）

**ユーザーストーリー:** 管理者として、予約データを外部の MongoDB Atlas に保存したい。それにより、アプリケーションから独立してデータを保持・管理できる。

#### 受入基準

1. WHEN 予約が作成・更新・キャンセルされる, THE Reservation_System SHALL 該当する予約レコードを MongoDB Atlas 上の Reservation_Store に書き込む
2. THE 予約レコード SHALL 予約 ID、エンドユーザー連絡先、予約時刻、対象サービス、予約状態、対応言語を含む
3. IF Reservation_Store への接続または書き込みが失敗する, THEN THE Reservation_System SHALL エラーを記録し、呼び出し元に失敗を示す応答を返す
4. WHEN Admin_UI が予約一覧を要求する, THE Reservation_System SHALL Reservation_Store から予約レコードを取得して返す

### 要件 3: 予約時刻の通知（WhatsApp + 管理者 UI）

**ユーザーストーリー:** エンドユーザーおよび管理者として、予約時刻の到来を通知で知りたい。それにより、通話の開始を逃さない。

#### 受入基準

1. WHEN 予約時刻に到達する, THE Notification_Service SHALL 該当エンドユーザーへ Vonage Messages API（WhatsApp）で通知メッセージを送信する
2. WHEN 予約時刻に到達する, THE Notification_Service SHALL Admin_UI 上に画面通知を表示するための通知イベントを送出する
3. WHILE Admin_UI が管理者またはスタッフによって開かれている, THE Admin_UI SHALL 受信した予約時刻通知イベントを画面上に表示する
4. IF WhatsApp 通知の送信が失敗する, THEN THE Notification_Service SHALL 送信失敗を記録し、Admin_UI 画面通知の送出を継続する

### 要件 4: ビデオ通話 UI（レスポンシブ）

**ユーザーストーリー:** エンドユーザーおよびスタッフとして、スマートフォンでも PC でも使えるビデオ通話画面を利用したい。それにより、デバイスを問わず通話に参加できる。

#### 受入基準

1. WHEN 予約に紐づく通話セッションに参加する, THE Video_Call_UI SHALL Vonage Video API を用いて音声・映像の送受信を確立する
2. THE Video_Call_UI SHALL スマートフォンおよび PC の画面幅に応じてレイアウトを調整するレスポンシブ表示を提供する
3. WHERE エンドユーザーが背景スキンを選択している, THE Video_Call_UI SHALL 選択された背景スキン（病院遠隔診療テーマを含む複数の選択肢のいずれか）を通話画面に適用する
4. IF ビデオ通話セッションへの接続が失敗する, THEN THE Video_Call_UI SHALL 接続失敗を示すメッセージを表示し再接続操作を提示する

### 要件 5: 管理者 UI とロールベースアクセス制御

**ユーザーストーリー:** 管理者およびスタッフとして、権限に応じた管理画面から予約と通話を管理したい。それにより、役割に応じた操作のみを安全に実行できる。

#### 受入基準

1. WHEN ユーザーが Admin_UI にログイン要求を行う, THE Auth_Service SHALL 認証を行い、管理者またはスタッフのロールを判定する
2. WHERE ログインユーザーのロールが管理者である, THE Admin_UI SHALL すべての予約管理・録画・文字起こし・権限管理の操作を許可する
3. WHERE ログインユーザーのロールがスタッフである, THE Admin_UI SHALL 自身に割り当てられた予約に対する操作のみを許可する
4. IF 権限のない操作が要求される, THEN THE Auth_Service SHALL 当該操作を拒否し、認可エラーを返す
5. THE Admin_UI SHALL スマートフォンおよび PC の画面幅に応じてレイアウトを調整するレスポンシブ表示を提供する

### 要件 6: 多言語対応（英語・日本語）

**ユーザーストーリー:** エンドユーザーおよび管理者として、英語または日本語を選択して利用したい。それにより、母語で操作・対話できる。

#### 受入基準

1. WHEN ユーザーが対応言語を選択する, THE Admin_UI SHALL 選択された言語で画面表示を提供する
2. WHEN ユーザーが対応言語を選択する, THE Video_Call_UI SHALL 選択された言語で画面表示を提供する
3. WHERE 予約レコードに対応言語が保存されている, THE Chatbot_Service SHALL 当該言語で WhatsApp メッセージを送信する
4. THE Reservation_System SHALL 対応言語として英語（en）および日本語（ja）を選択可能とする

### 要件 7: 録画（アーカイブ）開始

**ユーザーストーリー:** 管理者およびスタッフとして、管理者画面からビデオ通話の録画を開始したい。それにより、通話内容を後から確認できる。

#### 受入基準

1. WHEN 管理者またはスタッフが Admin_UI で録画開始操作を行う, THE Recording_Service SHALL Vonage Video API のアーカイブ録画を開始する
2. WHEN 録画開始要求が文字起こしを伴う, THE Recording_Service SHALL 個別ストリームアーカイブ（individual output mode）として録画を開始する
3. WHEN 管理者またはスタッフが Admin_UI で録画停止操作を行う, THE Recording_Service SHALL 進行中のアーカイブ録画を停止する
4. IF アーカイブ録画の開始が失敗する, THEN THE Recording_Service SHALL 失敗を Admin_UI に通知し、失敗内容を記録する
5. WHEN 録画状態が変化する, THE Admin_UI SHALL 現在の録画状態を画面に表示する

### 要件 8: 話者分離文字起こし（Vonage 純正機能の範囲）

**ユーザーストーリー:** 管理者として、録画を話者（ストリーム）単位で分離した文字起こしとして取得したい。それにより、誰が何を話したかを整理して確認できる。

#### 受入基準

1. WHEN 個別ストリームアーカイブの録画が開始される, THE Transcription_Service SHALL Vonage Video API の Post-Call Transcription を有効化して録画を開始する
2. WHEN 文字起こしが利用可能状態になる, THE Transcription_Service SHALL Vonage Video API から文字起こし結果を取得する
3. THE Transcription_Service SHALL 文字起こし結果を、各発話をチャンネル（ストリーム）単位に対応付けて話者ごとに区別した形式で提供する
4. WHEN 文字起こし結果の取得が完了する, THE Admin_UI SHALL 話者単位に区別された文字起こしを表示する
5. IF 文字起こしの生成または取得が失敗する, THEN THE Transcription_Service SHALL 失敗を記録し、Admin_UI に失敗状態を通知する

### 要件 9: パスワードレス入室リンク（WhatsApp 通知内）

**ユーザーストーリー:** エンドユーザーとして、WhatsApp 通知に含まれるリンクをタップするだけで通話に入室したい。それにより、パスワード入力なしで手軽に参加できる。

#### 受入基準

1. WHEN 予約時刻に到達する, THE Notification_Service SHALL WhatsApp 通知本文に **一度だけ有効な入室リンク** を含めて送信する
2. WHEN エンドユーザーが入室リンクをタップする, THE Video_Call_UI SHALL トークンを消費し、入室を許可する
3. WHEN 入室リンクが 2 回目以降にクリックされる, THE Video_Call_UI SHALL 「このリンクは既に使用されました」と案内し、再入室を拒否する
4. WHEN 入室リンクが有効期限を過ぎる, THE Video_Call_UI SHALL 「このリンクの有効期限が切れています」と案内する
5. WHEN 同一タブでページを刷新する, THE Video_Call_UI SHALL 既に取得済みのトークンで再接続し、再度リンクを消費しない
6. THE 入室リンクの有効期限 SHALL 予約時刻 + 3 時間（最低 30 分）とする
7. THE 入室リンクのトークン ID SHALL 推測不能な 16 バイト乱数とする
8. IF 入室リンクを他者へ共有した場合, THE Video_Call_UI SHALL 最初のクリック者のみを入室させ、後続は拒否する

### 要件 10: 会議室ライフサイクル（全員退室で自動無効化）

**ユーザーストーリー:** 管理者として、参加者が全員退室したら会議室が自動的に無効化され、再入室できなくなってほしい。それにより、使い終わった室を安全に閉じられる。

#### 受入基準

1. WHEN ユーザーまたは管理者が Vonage Video セッションから退室する, THE Room_Lifecycle_Service SHALL Vonage Session Monitoring Webhook を介して退出を検知する
2. WHEN その会議室にユーザーと管理者の全員が退室した, THE Room_Lifecycle_Service SHALL 会議室を無効化する
3. WHEN 会議室が無効化される, THE Room_Lifecycle_Service SHALL 以下を実行する:
   - その室の未消費入室リンクを一括無効化する
   - その室に紐づく全予約を `completed` 状態に更新する
   - 以降の入室要求（ゲストトークン・入室リンク）を `room_closed` / `join_token_room_closed` で拒否する
4. IF 会議室が一度も使われていない（誰も入室していない）状態で退出イベントが来る, THEN THE Room_Lifecycle_Service SHALL 無効化しない（誤検知防止）
5. WHEN 無効化後に入室試行が来る, THE Room_Lifecycle_Service SHALL その接続を Vonage 側から強制切断する
6. THE Room_Lifecycle_Service SHALL 同時退室・同時入室の競合を冪等に処理し、二重無効化を防ぐ
