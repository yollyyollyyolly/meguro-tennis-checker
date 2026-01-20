# 🎾 目黒区庭球場チェッカー - 3分でわかるセットアップ

## これをするだけ！

### 1️⃣ Resendでメール送信設定（5分）
1. https://resend.com/ にアクセス
2. 「Sign Up」→ GitHubアカウントで登録
3. 「API Keys」→「Create API Key」
4. Name: meguro-tennis-checker
5. **API Keyをコピーして保存**（後で使う）

### 2️⃣ GitHubにアップロード（5分）
1. https://github.com にログイン（アカウントない場合は作成）
2. 右上「+」→「New repository」
3. 名前: `meguro-tennis-checker`
4. 「Create repository」
5. ダウンロードしたZIPを解凍
6. 全ファイルをドラッグ&ドロップでアップロード

### 3️⃣ 秘密情報を設定（5分）
1. Settings → Secrets and variables → Actions
2. 「New repository secret」を4回クリックして以下を登録：

| Name | Secret |
|------|--------|
| `RESEND_API_KEY` | ステップ1のAPI Key |
| `NOTIFY_EMAIL` | `ysk.ouchi@gmail.com` |
| `MEGURO_LOGIN_ID` | 目黒区のログインID |
| `MEGURO_LOGIN_PASSWORD` | 目黒区のパスワード |

### 4️⃣ 実行開始（1分）
1. Actions タブ
2. 「I understand...」をクリック
3. 「庭球場空き状況チェック」→「Run workflow」

## ✅ 完了！

15分ごとに自動チェックが始まります。
空きが出たらysk.ouchi@gmail.comにメールが届きます。

---

## 📱 通知例

**件名:** 🎾 庭球場に空きあり！

**本文:**
```
🎾 目黒区庭球場に空きが見つかりました！

【駒場】
日付: 1月25日
時間: 9:00, 11:00
---

今すぐ予約: https://resv.city.meguro.tokyo.jp/...
```

---

## ⚡ トラブル時

- Actions タブで実行ログを確認
- エラーがある場合は赤い×をクリック
- 詳細は README.md を参照

---

**所要時間**: 合計15分
**費用**: 完全無料
**知識**: 不要（コピペのみ）
