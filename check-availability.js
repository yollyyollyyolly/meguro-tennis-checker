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

async function dumpHtml(page) {
  try {
    fs.writeFileSync(HTML_ERROR, await page.content(), "utf-8");
  } catch (_) {}
}

async function ensureNotErrorPage(page, label) {
  const bodyText = await page.evaluate(() => document.body?.innerText || "");

  // エラー/禁止/無効っぽい兆候があれば「失敗として落とす」（誤って空き0件扱いしない）
  const suspicious =
    bodyText.includes("エラー") ||
    bodyText.includes("無効") ||
    bodyText.includes("禁止") ||
    bodyText.includes("ホームへ");

  if (suspicious) {
    await safeShot(page, SHOT.error);
    await dumpHtml(page);
    throw new Error(`不正遷移/エラーページ疑い (${label}) url=${page.url()}`);
  }
}

async function gotoWithRetry(page, url, label) {
  // Puppeteerで安全に使える waitUntil のみ使う
  // 目黒区側が重いので timeout を長め + 2回までリトライ
  const TIMEOUT = 90000;

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      console.log(`${label} goto 試行${attempt}: ${url}`);
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: TIMEOUT });
      await page.waitForTimeout(2500);
      console.log(`${label} goto後URL:`, page.url());
      return;
    } catch (e) {
      console.log(`${label} goto失敗(試行${attempt}):`, e && e.message ? e.message : e);
      await page.waitForTimeout(3000);
      // 次のattemptへ
    }
  }

  // 2回失敗したら最後に少し待ってから状態確認し、ダメなら落とす
  await page.waitForTimeout(4000);
  throw new Error(`${label} goto がタイムアウトしました url=${url} current=${page.url()}`);
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
        "--disable-dev-shm-usage",
      ],
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720 });
    await page.setExtraHTTPHeaders({ "Accept-Language": "ja-JP,ja;q=0.9" });

    // 遅い環境向け
    page.setDefaultNavigationTimeout(90000);

    // 速度と安定性のために重いリソースをカット（HTML/JS/XHRは通す）
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      const type = req.resourceType();
      if (type === "image" || type === "media" || type === "font") {
        return req.abort();
      }
      return req.continue();
    });

    console.log("1) トップへアクセス:", START_URL);
    await gotoWithRetry(page, START_URL, "TOP");
    await safeShot(page, SHOT.start);
    await ensureNotErrorPage(page, "start");

    console.log("2) カレンダーURLへ goto:", CAL_URL);
    await gotoWithRetry(page, CAL_URL, "CAL");

    await safeShot(page, SHOT.afterGotoCal);
    await ensureNotErrorPage(page, "after_goto_cal");

    const urlNow = page.url();
    console.log("到達URL:", urlNow);

    // 到達できていない場合は必ず失敗（誤判定防止）
    if (!urlNow.includes("WgR_ShisetsubetsuAkiJoukyou")) {
      await safeShot(page, SHOT.error);
      await dumpHtml(page);
      throw new Error(`庭球場カレンダー未到達: url=${urlNow}`);
    }

    // 到達確認OK → まず成功通知（この後、○/△抽出＋時間帯追跡を実装）
    await sendMail(
      "✅ 目黒区チェッカー：カレンダー到達確認",
      `カレンダーページへ到達できました。\n\nURL:\n${urlNow}\n\n次はこのページから○/△を抽出して時間帯ページまで追跡します。`
    );

    await browser.close();
    console.log("完了（到達確認）");
  } catch (err) {
    console.log("致命的エラー:", err && (err.stack || err.message || err));
    try {
      await sendMail(
        "❌ 目黒区チェッカー：遷移エラー",
        `${err && (err.stack || err.message || err)}\n\nArtifacts に /tmp のスクショ・HTMLがあれば確認してください。`
      );
    } catch (_) {}
    process.exit(1);
  }
})();
