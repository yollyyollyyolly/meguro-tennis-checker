const fs = require("fs");
const puppeteer = require("puppeteer");
const { Resend } = require("resend");

// ========= ENV =========
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL;

const START_URL = "https://resv.city.meguro.tokyo.jp/Web/Home/WgR_ModeSelect";
const CAL_URL = "https://resv.city.meguro.tokyo.jp/Web/Yoyaku/WgR_ShisetsubetsuAkiJoukyou";

const TS = new Date().toISOString().replace(/[:.]/g, "-");
const OUT = {
  startPng: `/tmp/01_start_${TS}.png`,
  calPng: `/tmp/02_calendar_${TS}.png`,
  errPng: `/tmp/99_error_${TS}.png`,
  startHtml: `/tmp/01_start_${TS}.html`,
  calHtml: `/tmp/02_calendar_${TS}.html`,
  errHtml: `/tmp/99_error_${TS}.html`,
  logTxt: `/tmp/00_log_${TS}.txt`,
};

// ========= Utils =========
function must(name, v) {
  if (!v) throw new Error(`Missing env: ${name}`);
}
function log(line) {
  const s = `[${new Date().toISOString()}] ${line}\n`;
  process.stdout.write(s);
  try {
    fs.appendFileSync(OUT.logTxt, s, "utf-8");
  } catch (_) {}
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
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
function isGoBackErrorUrl(url) {
  return typeof url === "string" && url.includes("/Web/Error/html/GoBackError.html");
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
  log(`メール送信成功 ${data ? `id=${data.id}` : ""}`);
}

// ========= Navigation helpers =========
async function gotoWithRetry(page, url, label, opts = {}) {
  const timeouts = [60000, 120000, 180000];
  const waitUntils = ["domcontentloaded", "networkidle2"];

  for (let i = 0; i < 3; i++) {
    const backoff = 1500 * Math.pow(2, i);
    await sleep(backoff);
    for (const waitUntil of waitUntils) {
      try {
        log(`${label}: goto attempt=${i + 1} waitUntil=${waitUntil} url=${url}`);
        const resp = await page.goto(url, {
          waitUntil,
          timeout: timeouts[i],
          ...opts,
        });
        const status = resp ? resp.status() : 0;
        log(`${label}: goto ok status=${status} final=${page.url()}`);
        await sleep(1200);
        return resp;
      } catch (e) {
        log(`${label}: goto fail msg=${e?.message || e}`);
      }
    }
  }
  throw new Error(`${label}: goto failed url=${url} current=${page.url()}`);
}

// 画面上のリンク/ボタンを「狙い撃ち」でクリックする（見つかったら即クリック）
async function clickByHeuristics(page, label) {
  log(`${label}: clickByHeuristics start`);

  // クリック候補：hrefに目的URLが入ってる / onclickに目的パスが入ってる / 文言がそれっぽい
  const result = await page.evaluate((CAL_URL) => {
    function norm(s) {
      return (s || "").replace(/\s+/g, " ").trim();
    }
    function scoreEl(el) {
      const tag = el.tagName.toLowerCase();
      const text = norm(el.innerText || el.textContent || "");
      const href = el.getAttribute("href") || "";
      const onclick = el.getAttribute("onclick") || "";
      const value = el.getAttribute("value") || "";

      let score = 0;
      if (href.includes("WgR_ShisetsubetsuAkiJoukyou")) score += 100;
      if (onclick.includes("WgR_ShisetsubetsuAkiJoukyou")) score += 100;
      if (href === CAL_URL) score += 120;

      // 文言ヒューリスティック
      const blob = `${text} ${value}`.toLowerCase();
      if (blob.includes("施設種類")) score += 30;
      if (blob.includes("庭球場")) score += 25;
      if (blob.includes("空き") || blob.includes("空状況") || blob.includes("空き状況")) score += 15;
      if (blob.includes("検索")) score += 10;

      // クリックできそうな要素に加点
      if (tag === "a" || tag === "button") score += 10;
      if (tag === "input") {
        const type = (el.getAttribute("type") || "").toLowerCase();
        if (type === "button" || type === "submit") score += 10;
      }
      return { score, tag, text, href, onclick };
    }

    const candidates = [];
    const els = Array.from(document.querySelectorAll("a, button, input[type=button], input[type=submit]"));
    for (const el of els) {
      const s = scoreEl(el);
      if (s.score >= 40) candidates.push({ el, ...s });
    }
    candidates.sort((a, b) => b.score - a.score);

    if (candidates.length === 0) return { ok: false, why: "no candidates" };

    const best = candidates[0];
    // クリック実行
    best.el.scrollIntoView({ block: "center" });
    best.el.click();

    return {
      ok: true,
      picked: { score: best.score, tag: best.tag, text: best.text, href: best.href, onclick: best.onclick },
      tried: candidates.slice(0, 5).map((c) => ({ score: c.score, tag: c.tag, text: c.text, href: c.href })),
    };
  }, CAL_URL);

  log(`${label}: clickByHeuristics result=${JSON.stringify(result)}`);
  return result && result.ok;
}

// 「施設種類から探す」→「庭球場」を順にクリックする（最終手段）
async function clickFacilityFlow(page) {
  log("FLOW: click facility->tennis (fallback)");

  // 施設種類らしきボタン
  const clicked1 = await page.evaluate(() => {
    function norm(s) {
      return (s || "").replace(/\s+/g, " ").trim();
    }
    const els = Array.from(document.querySelectorAll("a, button, input[type=button], input[type=submit]"));
    // 施設種類 / 種類から探す / 施設検索
    const hit = els.find((el) => {
      const t = norm(el.innerText || el.textContent || el.getAttribute("value") || "");
      return t.includes("施設種類") || t.includes("種類から探す") || t.includes("施設検索");
    });
    if (!hit) return false;
    hit.scrollIntoView({ block: "center" });
    hit.click();
    return true;
  });
  log(`FLOW: clicked facility-search=${clicked1}`);

  await sleep(1500);

  // 庭球場をクリック
  const clicked2 = await page.evaluate(() => {
    function norm(s) {
      return (s || "").replace(/\s+/g, " ").trim();
    }
    const els = Array.from(document.querySelectorAll("a, button, input[type=button], input[type=submit], div, span"));
    // 「庭球場」を含むクリック可能要素を探す
    const hit = els.find((el) => {
      const t = norm(el.innerText || el.textContent || "");
      return t.includes("庭球場");
    });
    if (!hit) return false;
    hit.scrollIntoView({ block: "center" });
    hit.click();
    return true;
  });
  log(`FLOW: clicked tennis=${clicked2}`);

  return clicked1 && clicked2;
}

async function ensureCalendar(page) {
  // まずSTARTへ
  await gotoWithRetry(page, START_URL, "TOP");

  const topHtml = await page.content();
  await safeWrite(OUT.startHtml, topHtml);
  await safeShot(page, OUT.startPng);

  // パターンA：TOPから「カレンダーへ行く要素」をクリック
  // navigationが走る可能性があるので waitForNavigation と併用（タイミングズレ対策）
  for (let i = 0; i < 3; i++) {
    log(`CAL: try click heuristics round=${i + 1}`);

    const navPromise = page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => null);
    const ok = await clickByHeuristics(page, "CAL");
    const nav = await navPromise;

    // クリックで動かない場合もあるので、少し待ってURL判定
    await sleep(2000);

    const u = page.url();
    log(`CAL: after click url=${u} nav=${nav ? "yes" : "no"}`);
    if (u.includes("WgR_ShisetsubetsuAkiJoukyou") && !isGoBackErrorUrl(u)) return true;

    // GoBackErrorならTOPに戻して別ルートを試す
    if (isGoBackErrorUrl(u)) {
      log("CAL: hit GoBackError after click, going back to TOP and retry");
      await gotoWithRetry(page, START_URL, "TOP_RETRY");
      continue;
    }
  }

  // パターンB：施設種類→庭球場（強制フロー）
  log("CAL: fallback facility flow");
  await gotoWithRetry(page, START_URL, "TOP_FALLBACK");
  const navPromise2 = page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 90000 }).catch(() => null);
  await clickFacilityFlow(page);
  await navPromise2;
  await sleep(2000);

  const u2 = page.url();
  log(`CAL: after facility flow url=${u2}`);
  if (u2.includes("WgR_ShisetsubetsuAkiJoukyou") && !isGoBackErrorUrl(u2)) return true;

  // パターンC：最後に「referer付きでCALを直叩き」（一応残す）
  log("CAL: last resort goto CAL with referer");
  await gotoWithRetry(page, CAL_URL, "CAL_GOTO_LAST", { referer: START_URL });
  await sleep(1200);
  const u3 = page.url();
  log(`CAL: after last resort url=${u3}`);
  if (u3.includes("WgR_ShisetsubetsuAkiJoukyou") && !isGoBackErrorUrl(u3)) return true;

  return false;
}

// ========= Main =========
(async () => {
  let browser;
  try {
    must("RESEND_API_KEY", RESEND_API_KEY);
    must("NOTIFY_EMAIL", NOTIFY_EMAIL);

    log("=== START ===");
    log(`START_URL: ${START_URL}`);
    log(`CAL_URL:   ${CAL_URL}`);
    log(`NOTIFY_EMAIL: ***`);

    browser = await puppeteer.launch({
      headless: "new",
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
      ],
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720 });
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36"
    );

    // 文字化けスクショは気にしない。安定性優先で重いリソースは落とす
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      const t = req.resourceType();
      if (t === "image" || t === "font" || t === "media") return req.abort();
      return req.continue();
    });
    page.on("requestfailed", (req) => {
      log(`requestfailed: ${req.resourceType()} ${req.failure()?.errorText} ${req.url()}`);
    });

    // カレンダー到達を保証する
    const reached = await ensureCalendar(page);

    const calHtml = await page.content();
    await safeWrite(OUT.calHtml, calHtml);
    await safeShot(page, OUT.calPng);

    const finalUrl = page.url();
    log(`FINAL url=${finalUrl}`);

    if (!reached || isGoBackErrorUrl(finalUrl) || !finalUrl.includes("WgR_ShisetsubetsuAkiJoukyou")) {
      await safeShot(page, OUT.errPng);
      await safeWrite(OUT.errHtml, calHtml);
      throw new Error(
        `CAL not reached (or GoBackError). final=${finalUrl}\n` +
          `次はArtifactsのHTML/PNGで、どのボタンが押されているか確定してピン留めします。`
      );
    }

    // ここまで来たら「正しく遷移できた」ので、まずそれを成功通知する（空き抽出は次段）
    await sendMail(
      "✅ 目黒区チェッカー：カレンダー到達（正規遷移OK）",
      [
        "カレンダーページに正規遷移で到達できました。",
        "",
        `finalUrl: ${finalUrl}`,
        "",
        "Artifactsにデバッグ出力があります：",
        `- ${OUT.startPng}`,
        `- ${OUT.calPng}`,
        `- ${OUT.startHtml}`,
        `- ${OUT.calHtml}`,
        `- ${OUT.logTxt}`,
        "",
        "次のステップ：このカレンダー画面から「○/△をクリックして時間帯ページへ」も自動化できます。",
      ].join("\n")
    );

    log("=== DONE ===");
    await browser.close();
  } catch (e) {
    log(`FATAL: ${e?.stack || e?.message || e}`);
    try {
      await sendMail(
        "❌ 目黒区チェッカー：エラー",
        [
          "実行中にエラーが発生しました。",
          "",
          String(e?.stack || e?.message || e),
          "",
          "Artifacts(debug)にHTML/PNG/logが残ります。",
          "GoBackErrorの場合は「直叩き不可＝正規遷移必須」なので、このコードはクリック遷移を全ルート試します。",
        ].join("\n")
      );
    } catch (_) {}
    if (browser) {
      try { await browser.close(); } catch (_) {}
    }
    process.exit(1);
  }
})();
