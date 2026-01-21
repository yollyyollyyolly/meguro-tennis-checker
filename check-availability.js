// check-availability.js
// Meguro Tennis Availability Watcher (Windows local / Playwright)
// - Robust navigation with retries
// - Avoids waiting for images/fonts (resource filtering)
// - Captures HTML + screenshot on failures
// - Sends email via Resend when availability found (or on errors if configured)

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const { Resend } = require("resend");

const START_URL = "https://resv.city.meguro.tokyo.jp/Web/Home/WgR_ModeSelect";
const CAL_URL = "https://resv.city.meguro.tokyo.jp/Web/Yoyaku/WgR_ShisetsubetsuAkiJoukyou";
const DETAIL_URL = "https://resv.city.meguro.tokyo.jp/Web/Yoyaku/WgR_JikantaibetsuAkiJoukyou";

const TARGET_FACILITIES = [
  { key: "駒場", includes: ["駒場"] },
  { key: "区民センター", includes: ["区民センター"] },
  { key: "碑文谷", includes: ["碑文谷"] },
];

// ====== ENV ======
const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || "";
// 任意：エラー時にも通知したいなら "1"
const NOTIFY_ON_ERROR = process.env.NOTIFY_ON_ERROR || "0";

// 任意：混雑回避（少し待つ）
const EXTRA_DELAY_MS = parseInt(process.env.EXTRA_DELAY_MS || "0", 10);

// ====== UTIL ======
function ts() {
  return new Date().toISOString();
}
function log(msg) {
  console.log(`[${ts()}] ${msg}`);
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function safeWrite(file, content) {
  try {
    fs.writeFileSync(file, content);
  } catch (e) {
    // ignore
  }
}

async function sendMail(subject, text) {
  if (!RESEND_API_KEY || !NOTIFY_EMAIL) {
    log("MAIL: skipped (RESEND_API_KEY or NOTIFY_EMAIL missing)");
    return;
  }
  const resend = new Resend(RESEND_API_KEY);
  const { data, error } = await resend.emails.send({
    from: "tennis-checker <onboarding@resend.dev>",
    to: [NOTIFY_EMAIL],
    subject,
    text,
  });
  if (error) {
    log(`MAIL: error ${JSON.stringify(error)}`);
    return;
  }
  log(`MAIL: sent id=${data?.id || "unknown"}`);
}

async function withRetries(name, fn, { tries = 3, baseDelay = 1500 } = {}) {
  let lastErr = null;
  for (let i = 1; i <= tries; i++) {
    try {
      return await fn(i);
    } catch (e) {
      lastErr = e;
      log(`${name}: attempt ${i}/${tries} failed: ${e?.message || e}`);
      const backoff = baseDelay * Math.pow(2, i - 1);
      await sleep(backoff);
    }
  }
  throw lastErr;
}

// ====== PARSING ======

// 施設別カレンダー（○/△）を取る：最終的には詳細ページで時間まで取るので、ここは「対象施設が出ていること」の確認用に軽く使う
function extractFacilityCalendarMarks(html) {
  // HTML上で「駒場」「区民センター」「碑文谷」と「○」「△」が近接しているかの雑判定
  // 正確な取得は詳細ページで行う
  const results = [];
  for (const f of TARGET_FACILITIES) {
    const hit = f.includes.some((kw) => html.includes(kw));
    results.push({ facility: f.key, present: hit });
  }
  return results;
}

// 詳細ページ（時間帯別）から「○」だけ抜く
// 目黒区サイトはテーブル構造が変動し得るので、DOMを走査して「○」セルの近傍テキストから
// 日付/面/時間帯を推定する（ロバスト寄り）
async function extractTimeSlots(page) {
  // 文字化け対策：ページの textContent を主に使う（画像/フォント不要）
  const items = await page.evaluate(() => {
    function clean(s) {
      return (s || "").replace(/\s+/g, " ").trim();
    }

    // 日付見出しっぽいもの（例: 1月21日(水)）を拾う
    const bodyText = document.body ? document.body.innerText : "";
    const dateRegex = /(\d{1,2})月(\d{1,2})日\s*\((.)\)/g;

    // DOMベースでテーブルを探す
    const tables = Array.from(document.querySelectorAll("table"));
    const results = [];

    // 日付ブロックを推定：テーブル前後の見出し
    function findNearestDate(el) {
      let cur = el;
      for (let i = 0; i < 8 && cur; i++) {
        // 兄弟/親を遡って innerText から日付を探す
        const t = clean(cur.innerText);
        const m = t.match(/(\d{1,2})月(\d{1,2})日\s*\((.)\)/);
        if (m) return m[0];
        cur = cur.parentElement;
      }
      // 全文から最初の方の一致（弱い）
      const m2 = bodyText.match(/(\d{1,2})月(\d{1,2})日\s*\((.)\)/);
      return m2 ? m2[0] : "";
    }

    // 面（A面/B面等）推定
    function inferCourtFromRow(row) {
      const th = row.querySelector("th");
      if (th) {
        const t = clean(th.innerText);
        if (t) return t;
      }
      // 先頭セル
      const first = row.querySelector("td");
      if (first) {
        const t = clean(first.innerText);
        // "A面"などが含まれる場合
        if (t.includes("面")) return t;
      }
      return "";
    }

    // 時間帯推定：ヘッダ行に時間があることが多い
    function inferTimeHeaders(table) {
      const headerCells = Array.from(table.querySelectorAll("tr")).slice(0, 2)
        .flatMap(tr => Array.from(tr.querySelectorAll("th,td")));
      const texts = headerCells.map(c => clean(c.innerText));
      // "9:00" などを含むものだけ
      const timeLike = texts.filter(t => /\d{1,2}:\d{2}/.test(t));
      // 重複除去
      return Array.from(new Set(timeLike));
    }

    for (const table of tables) {
      const timeHeaders = inferTimeHeaders(table);
      const rows = Array.from(table.querySelectorAll("tr"));

      // "○"セルを探す
      for (const row of rows) {
        const cells = Array.from(row.querySelectorAll("td"));
        if (!cells.length) continue;

        const court = inferCourtFromRow(row);

        for (let idx = 0; idx < cells.length; idx++) {
          const c = cells[idx];
          const t = clean(c.innerText);

          if (t === "○" || t === "◯") {
            const date = findNearestDate(table) || findNearestDate(row) || "";
            const time = timeHeaders[idx] || ""; // 位置が合う場合
            results.push({
              date,
              court,
              time,
              raw: t
            });
          }
        }
      }
    }

    // さらに、テーブルが取れなかった場合の保険：本文から "○" の近傍だけ拾う（粗い）
    if (results.length === 0) {
      // ここでは何もしない（誤検出が増えるため）
    }

    return results;
  });

  // 正規化：施設名が詳細ページに出ている前提で、施設名は外で付与
  return items
    .map((x) => ({
      date: (x.date || "").trim(),
      court: (x.court || "").trim(),
      time: (x.time || "").trim(),
    }))
    .filter((x) => x.date || x.court || x.time);
}

// ====== MAIN ======

async function main() {
  log("=== START ===");
  log(`START_URL: ${START_URL}`);
  log(`CAL_URL:   ${CAL_URL}`);
  log(`DETAIL_URL:${DETAIL_URL}`);
  log(`NOTIFY_EMAIL: ${NOTIFY_EMAIL ? "***" : "(missing)"}`);

  const artifactsDir = path.join(process.cwd(), "artifacts");
  if (!fs.existsSync(artifactsDir)) fs.mkdirSync(artifactsDir, { recursive: true });

  const browser = await chromium.launch({
    headless: true,
  });

  const context = await browser.newContext({
    locale: "ja-JP",
    timezoneId: "Asia/Tokyo",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
    ignoreHTTPSErrors: true,
  });

  const page = await context.newPage();

  // 重いリソースをブロック（文字化け対策ではなく「安定性＆速度」目的）
 _vlan:
  page.route("**/*", async (route) => {
    const req = route.request();
    const url = req.url();
    const type = req.resourceType();
    if (
      type === "image" ||
      type === "media" ||
      type === "font" ||
      url.endsWith(".png") ||
      url.endsWith(".jpg") ||
      url.endsWith(".jpeg") ||
      url.endsWith(".gif") ||
      url.endsWith(".woff") ||
      url.endsWith(".woff2") ||
      url.endsWith(".ttf")
    ) {
      return route.abort();
    }
    return route.continue();
  });

  page.on("requestfailed", (req) => {
    const url = req.url();
    const failure = req.failure();
    if (failure && /ERR_FAILED|TIMED_OUT/i.test(failure.errorText || "")) {
      // ノイズになりやすいので抑制気味に
      // log(`requestfailed: ${req.resourceType()} ${failure.errorText} ${url}`);
      return;
    }
  });

  // 重要：タイムアウトを長めに
  page.setDefaultTimeout(120000);
  page.setDefaultNavigationTimeout(120000);

  async function snap(label) {
    const png = path.join(artifactsDir, `${label}.png`);
    const html = path.join(artifactsDir, `${label}.html`);
    try {
      await page.screenshot({ path: png, fullPage: true });
    } catch {}
    try {
      const content = await page.content();
      safeWrite(html, content);
    } catch {}
    return { png, html };
  }

  try {
    // 1) トップへアクセス（セッション確立）
    await withRetries(
      "TOP",
      async (i) => {
        log(`TOP: goto attempt=${i} url=${START_URL}`);
        await page.goto(START_URL, { waitUntil: "domcontentloaded" });
        // ちょい待つ（JS初期化）
        await page.waitForTimeout(1500);
      },
      { tries: 3, baseDelay: 1500 }
    );

    if (EXTRA_DELAY_MS > 0) {
      await sleep(EXTRA_DELAY_MS);
    }

    // 2) カレンダーページへ（直接 goto ）
    await withRetries(
      "CAL",
      async (i) => {
        log(`CAL: goto attempt=${i} url=${CAL_URL}`);
        await page.goto(CAL_URL, { waitUntil: "domcontentloaded" });
        // GoBackError.html へ飛ばされる場合があるので検知
        const cur = page.url();
        if (cur.includes("/Web/Error/html/GoBackError.html")) {
          throw new Error("CAL: redirected to GoBackError.html");
        }
        // JSで中身が描画されることがあるので少し待つ
        await page.waitForTimeout(2000);
      },
      { tries: 5, baseDelay: 2000 }
    );

    await snap("01_calendar");

    // 3) 対象施設が表示されているか軽く確認（存在しないと以降の詳細も意味薄い）
    const calHtml = await page.content();
    const presences = extractFacilityCalendarMarks(calHtml);
    log(`CAL: presence=${JSON.stringify(presences)}`);

    // 4) 詳細ページへ
    // ここが「直アクセスで弾かれる」場合があるため、2段階でトライ：
    //   a) そのまま goto DETAIL_URL
    //   b) CALページ上からリンク/フォームがあればクリック（heuristics）
    async function gotoDetailDirect() {
      await page.goto(DETAIL_URL, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(2500);
      const cur = page.url();
      if (cur.includes("/Web/Error/html/GoBackError.html")) {
        throw new Error("DETAIL: redirected to GoBackError.html");
      }
    }

    async function gotoDetailByHeuristics() {
      // CALページに戻って、"時間帯別" 的なリンクを探してクリック
      await page.goto(CAL_URL, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(2000);

      const clicked = await page.evaluate(() => {
        function norm(s) {
          return (s || "").replace(/\s+/g, " ").trim();
        }
        const candidates = [];
        const texts = [
          "時間帯別",
          "時間帯",
          "空き状況",
          "時間帯別空き状況",
          "時間帯別の空き状況",
        ];
        const els = Array.from(document.querySelectorAll("a,button,input[type=submit],input[type=button]"));
        for (const el of els) {
          const t = norm(el.innerText || el.value || "");
          const href = el.getAttribute("href") || "";
          const onclick = el.getAttribute("onclick") || "";
          let score = 0;
          for (const k of texts) {
            if (t.includes(k)) score += 10;
          }
          if (href.includes("WgR_JikantaibetsuAkiJoukyou")) score += 50;
          if (onclick.includes("Jikantaibetsu")) score += 30;
          if (score > 0) candidates.push({ score, t, href, onclick });
        }
        candidates.sort((a,b)=>b.score-a.score);
        const top = candidates[0];
        if (!top) return { ok:false, reason:"no-candidate", candidates:[] };

        // 実クリック
        // hrefがjavascript:void(0)でも onclick がある場合がある
        const target = els.find(el => {
          const tt = norm(el.innerText || el.value || "");
          const hh = el.getAttribute("href") || "";
          return tt === top.t && hh === top.href;
        }) || els.find(el => norm(el.innerText || el.value || "") === top.t);

        if (!target) return { ok:false, reason:"target-not-found", candidates:[top] };

        (target).click();
        return { ok:true, picked:top };
      });

      log(`DETAIL: heuristic click result=${JSON.stringify(clicked)}`);
      // 遷移待ち（SPAの可能性もあるので url 変化 or network idle を緩く）
      try {
        await page.waitForLoadState("domcontentloaded", { timeout: 30000 });
      } catch {}
      await page.waitForTimeout(2500);

      const cur = page.url();
      if (cur.includes("/Web/Error/html/GoBackError.html")) {
        throw new Error("DETAIL(heuristic): redirected to GoBackError.html");
      }
      // もしまだCALにいるなら失敗扱い
      if (cur.includes("WgR_ShisetsubetsuAkiJoukyou")) {
        throw new Error("DETAIL(heuristic): still on calendar url");
      }
    }

    await withRetries(
      "DETAIL",
      async (i) => {
        log(`DETAIL: attempt=${i} direct goto`);
        try {
          await gotoDetailDirect();
          return;
        } catch (e) {
          log(`DETAIL: direct failed: ${e.message}`);
        }
        log(`DETAIL: attempt=${i} fallback heuristics`);
        await gotoDetailByHeuristics();
      },
      { tries: 4, baseDelay: 2500 }
    );

    await snap("02_detail");

    // 5) ここで時間帯を抽出
    const detailUrl = page.url();
    log(`DETAIL: reached url=${detailUrl}`);

    const allSlots = await extractTimeSlots(page);

    // 6) 施設別に振り分け（詳細ページに施設見出しがある前提で、その近傍で分類…が理想だがまずは最低限）
    // 最低限：対象施設名がページテキストにあるかでフィルタし、全スロットを各施設に紐づけるのは危険なので
    //   -> 今回は「ページ全文に施設名が出る」場合だけ、その施設として採用
    const bodyText = await page.evaluate(() => (document.body ? document.body.innerText : ""));
    const facilityHits = TARGET_FACILITIES.filter(f => f.includes.some(k => bodyText.includes(k)));

    let findings = [];
    if (facilityHits.length === 0) {
      // 施設名が取れない場合：スロットだけ送る（ただし誤通知防止のため subject を弱める）
      findings = allSlots.map(s => ({ facility: "（施設名未判定）", ...s }));
    } else if (facilityHits.length === 1) {
      // 1施設だけ出るならその施設として扱う
      findings = allSlots.map(s => ({ facility: facilityHits[0].key, ...s }));
    } else {
      // 複数施設が同一ページに並ぶ場合：分類が必要だが構造依存が強い
      // ここでは「一旦まとめて通知（施設未分類）」にして誤分類を避ける
