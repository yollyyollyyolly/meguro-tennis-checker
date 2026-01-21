const puppeteer = require("puppeteer");
const { Resend } = require("resend");
const fs = require("fs");

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL;

const START_URL = "https://resv.city.meguro.tokyo.jp/Web/Home/WgR_ModeSelect";
const CAL_URL = "https://resv.city.meguro.tokyo.jp/Web/Yoyaku/WgR_ShisetsubetsuAkiJoukyou";

const SHOT = {
  start: "/tmp/01_start.png",
  afterGotoCal: "/tmp/02_after_goto_cal.png",
  error: "/tmp/99_error.png",
};
const HTML_ERROR = "/tmp/99_error.html";

function mustEnv(name, v) {
  if (!v) throw new Error(`Missing env: ${name}`);
}

async function sendMail(subject, text) {
  mustEnv("RESEND_API_KEY", RESEND_API_KEY);
  mustEnv("NOTIFY_EMAIL", NOTIFY_EMAIL);
  const resend = new Resend(RESEND_API_KEY);
  const { data, error } = await resend.emails.send({
    from: "Meguro Tennis Checker <onboarding@resend.dev>",
    to: [NOTIFY_EMAIL],
    subject,
    text,
  });
  if (error) throw new Error(`Resend error: ${JSON.stringify(error)}`);
  console.log("メール送信成功", data ? { id: data.id } : "");
}

async function safeShot(page, path) {
  try {
    await page.screenshot({ path, fullPage: true });
  } catch (_) {}
}

async function ensureNotErrorPage(page, label) {
  const bodyText = await page.evaluate(() => document.body?.innerText || "");
  // 進入禁止系やエラー系（文字化けでもボタンだけ見える等）を弾く
  const suspicious =
    bodyText.includes("エラー") ||
    bodyText.includes("無効") ||
    bodyText.includes("禁止") ||
    bodyText.includes("ホームへ");

  if (suspicious) {
    await safeShot(page, SHOT.error);
    try {
      fs.writeFileSync(HTML_ERROR, await page.content(), "utf-8");
    } catch (_) {}
    throw new Error(`不正遷移/エラーページ疑い (${label}) url=${page.url()}`);
  }
}

(async () => {
  try {
    mustEnv("RESEND_API_KEY", RESEND_API_KEY);
    mustEnv("NOTIFY_EMAIL", NOTIFY_EMAIL);

    const browser = await puppeteer.launch({
      headless: "new",
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--lang=ja-JP",
      ],
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720 });
    await page.setExtraHTTPHeaders({ "Accept-Language": "ja-JP,ja;q=0.9" });

    console.log("1) トップへアクセス:", START_URL);
    await page.goto(START_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(1200);
    await safeShot(page, SHOT.start);
    await ensureNotErrorPage(page, "start");

    // ここが肝：トップを踏んだ“同一セッション”のまま、カレンダーURLへ移動
    console.log("2) カレンダーURLへ goto:", CAL_URL);

    // ナビタイムアウトを延長
    page.setDefaultNavigationTimeout(90000);

    const gotoCalendar = async () => {
      try {
        // waitUntil を軽くする（WebFormsで重い/長引くのを避ける）
        await page.goto(CAL_URL, { waitUntil: "commit", timeout: 90000 });
      } catch (e) {
        console.log("goto 1回目が失敗（タイムアウト含む）:", e && e.message ? e.message : e);
      }
      // 少し待って状態確認
      await page.waitForTimeout(4000);
      const u = page.url();
      console.log("goto後URL:", u);
      // まだ目的URLでなければ1回だけリトライ
      if (!u.includes("WgR_ShisetsubetsuAkiJoukyou")) {
        console.log("リトライで再gotoします");
        await page.goto(CAL_URL, { waitUntil: "commit", timeout: 90000 });
        await page.waitForTimeout(4000);
      }
    };

    await gotoCalendar();

    await safeShot(page, SHOT.afterGotoCal);
    await ensureNotErrorPage(page, "after_goto_cal");

    const urlNow = page.url();
    console.log("到達URL:", urlNow);

    if (!urlNow.includes("WgR_ShisetsubetsuAkiJoukyou")) {
      throw new Error(`庭球場カレンダー未到達: url=${urlNow}`);
    }

    // 到達判定：URLに期待文字列が含まれない場合は「未到達」として落とす（誤判定防止）
    if (!urlNow.includes("WgR_ShisetsubetsuAkiJoukyou")) {
      throw new Error(`庭球場カレンダー未到達: url=${urlNow}`);
    }

    // ここまで来たら「到達成功」なので、まずは成功通知だけ出す（空き抽出は次段で詰める）
    await sendMail(
      "✅ 目黒区チェッカー：カレンダー到達確認",
      `カレンダーページへ到達できました。\n\nURL:\n${urlNow}\n\n次はこのページから○/△を抽出して時間帯まで深掘りします。`
    );

    await browser.close();
    console.log("完了（到達確認）");
  } catch (err) {
    console.log("致命的エラー:", err && (err.stack || err.message || err));
    try {
      await sendMail(
        "❌ 目黒区チェッカー：遷移エラー",
        `${err && (err.stack || err.message || err)}\n\nスクショはArtifactsを確認してください。`
      );
    } catch (_) {}
    process.exit(1);
  }
})();
