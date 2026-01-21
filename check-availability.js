const fs = require("fs");
const { chromium } = require("playwright");
const { Resend } = require("resend");

// ====== ENV ======
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL;

// Optional proxy (if GitHub IP is blocked)
const PROXY_SERVER = process.env.PROXY_SERVER;
const PROXY_USERNAME = process.env.PROXY_USERNAME;
const PROXY_PASSWORD = process.env.PROXY_PASSWORD;

// ====== URLS ======
const START_URL = "https://resv.city.meguro.tokyo.jp/Web/Home/WgR_ModeSelect";
const CAL_URL = "https://resv.city.meguro.tokyo.jp/Web/Yoyaku/WgR_ShisetsubetsuAkiJoukyou";

// ====== DEBUG FILES ======
const TS = new Date().toISOString().replace(/[:.]/g, "-");
const OUT = {
  startPng: `/tmp/meguro-start-${TS}.png`,
  calPng: `/tmp/meguro-cal-${TS}.png`,
  errPng: `/tmp/meguro-error-${TS}.png`,
  startHtml: `/tmp/meguro-start-${TS}.html`,
  calHtml: `/tmp/meguro-cal-${TS}.html`,
  errHtml: `/tmp/meguro-error-${TS}.html`,
  logTxt: `/tmp/meguro-log-${TS}.txt`,
};

// ====== UTIL ======
function must(name, v) {
  if (!v) throw new Error(`Missing env: ${name}`);
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function appendLog(line) {
  const s = `[${new Date().toISOString()}] ${line}\n`;
  process.stdout.write(s);
  try {
    fs.appendFileSync(OUT.logTxt, s, "utf-8");
  } catch (_) {}
}
async function safeWrite(path, content) {
  try {
    fs.writeFileSync(path, content, "utf-8");
  } catch (_) {}
}
async function safeShot(page, path) {
  try {
    await page.screenshot({ path, fullPage: true });
  } catch (_) {}
}

async function sendMail(subject, text) {
  must("RESEND_API_KEY", RESEND_API_KEY);
  must("NOTIFY_EMAIL", NOTIFY_EMAIL);

  const resend = new Resend(RESEND_API_KEY);
  const { data, error } = await resend.emails.send({
    from: "Meguro Tennis Checker <onboarding@resend.dev>",
    to: [NOTIFY_EMAIL],
    subject,
    text,
  });

  if (error) throw new Error(`Resend error: ${JSON.stringify(error)}`);
  appendLog(`メール送信成功 ${data ? `id=${data.id}` : ""}`);
}

function classifyBlock(status, bodyText) {
  const t = bodyText || "";
  const is403 = status === 403;
  const is429 = status === 429;
  const is5xx = status >= 500 && status <= 599;

  const keywords = [
    "アクセスできません",
    "アクセスが集中",
    "しばらくしてから",
    "エラー",
    "無効",
    "禁止",
    "このページは表示できません",
    "ホームへ",
  ];
  const kwHit = keywords.some((k) => t.includes(k));

  return {
    blocked: is403 || is429 || kwHit,
    overloaded: is5xx || t.includes("アクセスが集中"),
    status,
    kwHit,
  };
}

// ====== MAIN ======
(async () => {
  try {
    must("RESEND_API_KEY", RESEND_API_KEY);
    must("NOTIFY_EMAIL", NOTIFY_EMAIL);

    appendLog("=== START ===");
    appendLog(`START_URL: ${START_URL}`);
    appendLog(`CAL_URL:   ${CAL_URL}`);
    appendLog(`NOTIFY_EMAIL: ${NOTIFY_EMAIL}`);
    appendLog(`PROXY: ${PROXY_SERVER ? "ON" : "OFF"}`);

    const launchOptions = { headless: true };
    if (PROXY_SERVER) {
      launchOptions.proxy = {
        server: PROXY_SERVER,
        username: PROXY_USERNAME || undefined,
        password: PROXY_PASSWORD || undefined,
      };
    }

    const browser = await chromium.launch(launchOptions);

    // 「文字化けしてもOK」方針：画像/フォントは落としてHTML中心で判定する
    const baseHeaders = {
      "Accept-Language": "ja-JP,ja;q=0.9,en-US;q=0.7,en;q=0.6",
      "Upgrade-Insecure-Requests": "1",
    };

    const context = await browser.newContext({
      locale: "ja-JP",
      timezoneId: "Asia/Tokyo",
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
      viewport: { width: 1280, height: 720 },
      extraHTTPHeaders: baseHeaders,
    });

    // 軽量化：image/font/mediaは落とす（timeout低減）
    await context.route("**/*", (route) => {
      const type = route.request().resourceType();
      if (type === "image" || type === "font" || type === "media") return route.abort();
      return route.continue();
    });

    const page = await context.newPage();

    page.on("requestfailed", (req) => {
      appendLog(`requestfailed: ${req.resourceType()} ${req.failure()?.errorText} ${req.url()}`);
    });

    // ここが重要：Refererはヘッダーをいじらず page.goto の option referer を使う
    async function robustGoto(url, label, referer) {
      const attempts = [
        { waitUntil: "domcontentloaded", timeout: 180000 },
        { waitUntil: "networkidle", timeout: 240000 },
      ];

      for (let i = 0; i < 3; i++) {
        const backoff = 2000 * Math.pow(2, i);
        appendLog(`${label}: goto attempt=${i + 1} backoff=${backoff}ms url=${url}`);
        await sleep(backoff);

        for (const a of attempts) {
          try {
            const resp = await page.goto(url, { ...a, referer: referer || undefined });
            const status = resp ? resp.status() : 0;
            appendLog(`${label}: goto ok waitUntil=${a.waitUntil} status=${status} final=${page.url()}`);
            await sleep(2500);
            return resp;
          } catch (e) {
            appendLog(`${label}: goto fail waitUntil=${a.waitUntil} msg=${e?.message || e}`);
          }
        }
      }
      throw new Error(`${label}: goto failed after retries url=${url} current=${page.url()}`);
    }

    // 1) TOP
    appendLog("1) TOP access");
    const topResp = await robustGoto(START_URL, "TOP");
    const topStatus = topResp ? topResp.status() : 0;

    const topHtml = await page.content();
    await safeWrite(OUT.startHtml, topHtml);
    await safeShot(page, OUT.startPng);

    const topText = await page.evaluate(() => document.body?.innerText || "");
    const topJudge = classifyBlock(topStatus, topText);
    appendLog(`TOP judge: ${JSON.stringify(topJudge)}`);
    if (topJudge.blocked) {
      await safeShot(page, OUT.errPng);
      await safeWrite(OUT.errHtml, topHtml);
      throw new Error(
        `TOP blocked/denied. status=${topStatus} kwHit=${topJudge.kwHit}\n` +
          `GitHub ActionsのIP帯が弾かれている可能性があります。PROXY_SERVER導入が最短です。`
      );
    }

    // 2) CAL（Referer付き）
    appendLog("2) CAL access");
    const calResp = await robustGoto(CAL_URL, "CAL", START_URL);
    const calStatus = calResp ? calResp.status() : 0;

    const calHtml = await page.content();
    await safeWrite(OUT.calHtml, calHtml);
    await safeShot(page, OUT.calPng);

    const calText = await page.evaluate(() => document.body?.innerText || "");
    const calJudge = classifyBlock(calStatus, calText);
    appendLog(`CAL judge: ${JSON.stringify(calJudge)}`);

    const finalUrl = page.url();
    appendLog(`CAL finalUrl: ${finalUrl}`);

    // 未到達なら落とす（「空きなし」誤判定を防ぐ）
    if (!finalUrl.includes("WgR_ShisetsubetsuAkiJoukyou")) {
      await safeShot(page, OUT.errPng);
      await safeWrite(OUT.errHtml, calHtml);
      throw new Error(
        `CAL not reached. status=${calStatus} final=${finalUrl}\n` +
          `blocked=${calJudge.blocked} overloaded=${calJudge.overloaded} kwHit=${calJudge.kwHit}`
      );
    }
    if (calJudge.blocked) {
      await safeShot(page, OUT.errPng);
      await safeWrite(OUT.errHtml, calHtml);
      throw new Error(
        `CAL blocked/denied. status=${calStatus} kwHit=${calJudge.kwHit}\n` +
          `GitHub ActionsのIP帯制限の可能性が高いです。PROXY_SERVER導入が最短です。`
      );
    }

    // ここまでOK
    await sendMail(
      "✅ 目黒区チェッカー：カレンダー到達OK（ヘッダー修正版）",
      [
        "カレンダーページへ到達できました。",
        "",
        `URL: ${finalUrl}`,
        `HTTP status: ${calStatus}`,
        "",
        "Artifacts(debug-xxxx)で以下が見れます：",
        `- ${OUT.startPng}`,
        `- ${OUT.calPng}`,
        `- ${OUT.startHtml}`,
        `- ${OUT.calHtml}`,
        `- ${OUT.logTxt}`,
      ].join("\n")
    );

    await browser.close();
    appendLog("=== DONE ===");
  } catch (err) {
    appendLog(`FATAL: ${err?.stack || err?.message || err}`);
    try {
      await sendMail(
        "❌ 目黒区チェッカー：エラー（ヘッダー修正版）",
        [
          "実行中にエラーが発生しました。",
          "",
          String(err?.stack || err?.message || err),
          "",
          "Artifacts(debug-xxxx)を確認してください。",
          "blocked/deniedが濃厚なら、次の一手は PROXY_SERVER の投入が最短です（Secrets追加だけ）。",
        ].join("\n")
      );
    } catch (_) {}
    process.exit(1);
  }
})();
