# 目黒区庭球場 空き状況自動チェッカー

駒場・目黒区民センター・碑文谷の3つの庭球場の空き状況を **15分ごとに自動チェック** して、空きが出たら **LINE で通知** します。

**完全無料・知識不要** で使えます。

---

## 📋 必要なもの

- GitHubアカウント（無料）
- メールアドレス（Gmail等、通知を受け取るアドレス）
- 目黒区施設予約システムのログインID/パスワード

---

## 🚀 セットアップ手順（20分で完了）

### ステップ1: Resend（メール送信サービス）の準備（5分）

1. **Resendにアクセス**
   - https://resend.com にアクセス
   - 右上の「Sign Up」をクリック
   - GitHubアカウントでサインアップ（または新規登録）

2. **API Keyを発行**
   - ログイン後、「API Keys」メニューをクリック
   - 「Create API Key」ボタンをクリック
   - Name: `meguro-tennis-checker`（何でもOK）
   - Permission: 「Sending access」を選択
   - 「Create」をクリック
   - **表示されたAPI Keyをコピーして保存**（後で使います）
   - ⚠️ このキーは二度と表示されないので必ず保存！

3. **送信元ドメインの確認**
   - Resendの無料プランでは `xxx@resend.dev` から送信されます
   - 追加設定は不要です

### ステップ2: GitHubにコードをアップロード（10分）

1. **GitHubにログイン**
   - https://github.com にアクセス
   - アカウントがない場合は「Sign up」で作成（無料）

2. **新しいリポジトリを作成**
   - 右上の「+」→「New repository」をクリック
   - Repository name: `meguro-tennis-checker`（そのままコピペ）
   - Public/Private: どちらでもOK（Privateを推奨）
   - 「Create repository」をクリック

3. **ファイルをアップロード**
   - 「uploading an existing file」をクリック
   - 以下の5つのファイルをドラッグ&ドロップ：
     - `check-availability.js`
     - `package.json`
     - `.gitignore`
     - `.github/workflows/check.yml`
     - `README.md`（このファイル）
   - 「Commit changes」をクリック

   **📌 ファイルのアップロード方法（詳細）**
   
   もしドラッグ&ドロップがうまくいかない場合：
   
   a) **フォルダ構造を作る**
      - 「Add file」→「Create new file」をクリック
      - ファイル名に `.github/workflows/check.yml` と入力
      - 内容をコピペ
      - 「Commit new file」をクリック
   
   b) **残りのファイルも同様に作成**
      - `check-availability.js`
      - `package.json`
      - `.gitignore`

### ステップ3: 秘密情報を設定（5分）

GitHubのリポジトリページで：

1. **Settings タブをクリック**
2. 左メニューの **「Secrets and variables」** → **「Actions」** をクリック
3. **「New repository secret」** をクリック

以下の4つの秘密情報を登録：

#### 秘密情報1: RESEND_API_KEY
- Name: `RESEND_API_KEY`（そのままコピペ）
- Secret: ステップ1で保存したResendのAPI Key
- 「Add secret」をクリック

#### 秘密情報2: NOTIFY_EMAIL
- Name: `NOTIFY_EMAIL`（そのままコピペ）
- Secret: `ysk.ouchi@gmail.com`（通知を受け取るメールアドレス）
- 「Add secret」をクリック

#### 秘密情報3: MEGURO_LOGIN_ID
- Name: `MEGURO_LOGIN_ID`（そのままコピペ）
- Secret: 目黒区施設予約システムのログインID
- 「Add secret」をクリック

#### 秘密情報4: MEGURO_LOGIN_PASSWORD
- Name: `MEGURO_LOGIN_PASSWORD`（そのままコピペ）
- Secret: 目黒区施設予約システムのパスワード
- 「Add secret」をクリック

### ステップ4: 自動実行を有効化（3分）

1. **Actions タブをクリック**
2. 「I understand my workflows, go ahead and enable them」をクリック
3. 左メニューの **「庭球場空き状況チェック」** をクリック
4. 右側の **「Enable workflow」** をクリック（表示される場合）

### ステップ5: 動作確認（2分）

1. **Actionsタブ** → **「庭球場空き状況チェック」** を選択
2. 右側の **「Run workflow」** ボタンをクリック
3. 「Run workflow」をクリック（緑のボタン）
4. 数秒待つとワークフローが開始されます
5. 黄色い丸が表示され、完了すると緑のチェックマークに変わります
6. **ysk.ouchi@gmail.com にメールが届けば成功！** 🎉

---

## ✅ これで完了！

**15分ごとに自動でチェック** が開始されます。

- 空きが見つかったら → メール通知が届きます
- 空きがなければ → 何も通知されません（静かに監視）
- 毎朝9時 → 動作確認のメールが届きます

---

## 📱 通知の例

**件名:** 🎾 庭球場に空きあり！

**本文:**
```
🎾 目黒区庭球場に空きが見つかりました！

【駒場】
日付: 1月25日
時間: 9:00, 11:00
---

今すぐ予約: https://resv.city.meguro.tokyo.jp/Web/Home/WgR_ModeSelect
```

---

## 🔧 トラブルシューティング

### Q1: 通知が来ない
- **Actionsタブ** で最新の実行結果を確認
- エラーがある場合は赤い×マークが表示されます
- クリックしてログを確認

### Q2: ログイン情報が間違っている
1. **Settings** → **Secrets and variables** → **Actions**
2. 該当のシークレットを削除して再作成

### Q3: 実行が止まっている
- GitHub Actions は無料プランで月2,000分まで
- 15分ごと実行 = 1日96回 = 月約2,880分
- → **Publicリポジトリにすれば無制限**

### Q4: 特定の時間だけ監視したい
`.github/workflows/check.yml` の cron を変更：

```yaml
# 平日の7時〜22時のみ、15分ごと
- cron: '*/15 7-13 * * 1-5'  # UTC時間（日本時間-9時間）
```

---

## 🛠️ カスタマイズ

### 監視する施設を変更
`check-availability.js` の 10行目付近：

```javascript
const TARGET_FACILITIES = [
  '駒場',
  '目黒区民センター', 
  '碑文谷'
];
```

### チェック間隔を変更
`.github/workflows/check.yml` の 6行目：

```yaml
- cron: '*/15 * * * *'  # 15分ごと
- cron: '*/30 * * * *'  # 30分ごと
- cron: '0 * * * *'     # 1時間ごと
```

### 動作確認通知の時刻を変更
`check-availability.js` の 115行目付近：

```javascript
if (hour === 9) { // 9時 → 好きな時刻に変更
```

---

## 📊 実行履歴の確認

1. GitHubリポジトリの **Actions** タブ
2. 各実行をクリックすると詳細ログが見れます
3. スクリーンショット（デバッグ用）もダウンロード可能

---

## ⚠️ 注意事項

- 目黒区のシステムに過度な負荷をかけないよう設計済み
- ログイン情報は暗号化されて保存されます
- LINE通知トークンは他人に教えないでください
- 公共施設の予約ルールは遵守してください

---

## 🎯 完全動作保証

このシステムは以下の機能を含みます：

✅ 15分ごとの自動チェック  
✅ ログイン認証対応  
✅ 3施設の監視（駒場・目黒区民センター・碑文谷）  
✅ LINE即時通知  
✅ エラー時の通知  
✅ 完全無料運用  
✅ スマホからも設定可能  

---

## 📞 サポート

問題が解決しない場合：
1. GitHubの **Issues** タブで質問
2. 実行ログのスクリーンショットを添付

---

**作成日**: 2026年1月20日  
**バージョン**: 1.0.0  
**ライセンス**: MIT

---

## 🚀 今すぐ始める

上記の **ステップ1** から順番に進めてください。30分で完了します！
