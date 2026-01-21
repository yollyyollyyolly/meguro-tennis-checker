// check-availability.js (Puppeteer版)
// クリック遷移でWebFormsの文脈を維持し、カレンダー→詳細（時間帯）を辿って「○」枠を抽出する

const puppeteer = require("puppeteer");
const { Resend } = require("resend");
const fs = require("fs");

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL;

const START_URL = "https://resv.city.meguro.tokyo.jp/Web/Home/WgR_ModeSelect";

const TARGET_FACILITIES = [
  { key: "駒場", patterns: ["駒場"] },
  { key: "区民センター", patterns: ["区民センター"] },
  { key: "碑文谷", patterns: ["碑文谷"] },
];

const SYMBOLS_AVAILABLE = ["○", "〇"];
const SYMBOLS_PARTIAL = ["△"];
const ONLY_CIRCLE = true;

const SHOT = {
  mode: "/tmp/01_mode_select.png",
  afterMode: "/tmp/02_after_mode_click.png",
  calendar: "/tmp/03_calendar.png",
  detail: "/tmp/04_detail.png",
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

function normalize(s) {
  return (s || "").replace(/\s+/g, " ").trim();
}

async function clickByText(page, text) {
  // テキストにマッチする要素をクリック（リンク/ボタン優先）
  const escaped = text.replace(/"/g, '\\"');
  const candidates = await page.$x(
    `//*[self::a or self::button or self::span or self::div][contains(normalize-space(.), "${escaped}")]`
  );
  if (!candidates.length) throw new Error(`clickByText: 要素が見つかりません: ${text}`);
  await candidates[0].click();
}

async function ensureNotErrorPage(page, label) {
  const bodyText = await page.evaluate(() => document.body?.innerText || "");
  // 文字化けでも「ホームへ」だけ出るようなページを弾く
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

async function waitStable(page) {
  await page.waitForTimeout(1200);
}

async function scanFacilityFromCalendar(page, facility) {
  const results = [];

  // 施設ブロックを探す：施設名を含む要素を起点に少し親へ
  const handle = await page.evaluateHandle((patterns) => {
    const all = Array.from(document.querySelectorAll("body *"));
    const hit = all.find((el) => {
      const t = (el.textContent || "").trim();
      return t && patterns.some((p) => t.includes(p));
    });
    if (!hit) return null;

    let cur = hit;
    for (let i = 0; i < 6; i++) {
      if (!cur.parentElement) break;
      cur = cur.parentElement;
      if (cur.querySelector && cur.querySelector("table")) return cur;
    }
    return hit.parentElement || hit;
  }, facility.patterns);

  const block = handle && (await handle.asElement());
  if (!block) {
    console.log(`施設ブロック見つからず: ${facility.key}`);
    return results;
  }

  const marks = ONLY_CIRCLE ? SYMBOLS_AVAILABLE : [...SYMBOLS_AVAILABLE, ...SYMBOLS_PARTIAL];

  // ブロック内のクリック対象（a/button/onclick）を列挙
  const targets = await page.evaluate((root, marks) => {
    const out = [];
    const els = Array.from(root.querySelectorAll("a,button,td,span,div"));
    for (const el of els) {
      const txt = (el.textContent || "").trim();
      if (!txt) continue;
      if (!marks.some((m) => txt.includes(m))) continue;

      const isClickable =
        el.tagName === "A" ||
        el.tagName === "BUTTON" ||
        el.getAttribute("onclick");

      if (isClickable) {
        out.push({ txt, tag: el.tagName });
      }
    }
    return out;
  }, block, marks);

  if (!targets.length) {
    console.log(`空きマーク要素なし: ${facility.key}`);
    return results;
  }

  console.log(`候補(${facility.key}): ${targets.length}件`);

  // クリック回数制限（負荷抑制）
  const MAX = 8;
  let clicks = 0;

  for (let i = 0; i < targets.length && clicks < MAX; i++) {
    clicks++;

    // 記号でクリック（最初の一致）
    const mark = marks.find((m) => targets[i].txt.includes(m)) || marks[0];

    // 施設名近傍から mark を含む a/button をクリックする
    // （DOMが揺れるので、厳密に同じ要素を取るのは避ける）
    const clicked = await page.evaluate((facilityPatterns, mark) => {
      const all = Array.from(document.querySelectorAll("a,button,[onclick]"));
      // 施設名に近い領域を優先するため、施設名を含む要素の近傍を探す
      const anchor = Array.from(document.querySelectorAll("body *"))
        .find(el => {
          const t = (el.textContent || "").trim();
          return t && facilityPatterns.some(p => t.includes(p));
        });

      let scope = document;
      if (anchor) {
        scope = anchor.closest("table") || anchor.parentElement || document;
      }

      const cand = Array.from(scope.querySelectorAll("a,button,[onclick]"))
        .find(el => ((el.textContent || "").trim().includes(mark)));

      if (cand) {
        cand.click();
        return true;
      }
      // フォールバック：ページ全体
      const cand2 = all.find(el => ((el.textContent || "").trim().includes(mark)));
      if (cand2) {
        cand2.click();
        return true;
      }
      return false;
    }, facility.patterns, mark);

    if (!clicked) {
      console.log(`クリック対象が見つからず(${facility.key}) mark=${mark}`);
      continue;
    }

    await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
    await waitStable(page);
    await ensureNotErrorPage(page, `${facility.key} detail`);
    await safeShot(page, SHOT.detail);

    // 詳細ページの表から○行抽出
    const lines = await page.evaluate((availableMarks) => {
      const out = [];
      const tables = Array.from(document.querySelectorAll("table"));
      for (const table of tables) {
        const rows = Array.from(table.querySelectorAll("tr"));
        for (const tr of rows) {
          const cells = Array.from(tr.querySelectorAll("th,td")).map(td => (td.textContent || "").trim()).filter(Boolean);
          if (!cells.length) continue;
          const hasAvail = cells.some(x => availableMarks.some(m => x.includes(m)));
          if (!hasAvail) continue;
          out.push(cells.join(" "));
        }
      }
      return out;
    }, SYMBOLS_AVAILABLE);

    for (const line of lines.slice(0, 30)) {
      results.push({ facility: facility.key, line });
    }

    // 戻る
    await page.goBack({ waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
    await waitStable(page);
    await ensureNotErrorPage(page, `${facility.key} back`);
    await safeShot(page, SHOT.calendar);
  }

  return results;
}

(async () => {
  try {
    mustEnv("RESEND_API_KEY", RESEND_API_KEY);
    mustEnv("NOTIFY_EMAIL", NOTIFY_EMAIL);

    const browser = await puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    const page = await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36"
    );
    await page.setExtraHTTPHeaders({ "Accept-Language": "ja-JP,ja;q=0.9" });

    console.log("開始：トップページへ");
    await page.goto(START_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
    await waitStable(page);
    await safeShot(page, SHOT.mode);
    await ensureNotErrorPage(page, "mode");

    console.log("「施設種類から探す」をクリック");
    await clickByText(page, "施設種類から探す");
    await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
    await waitStable(page);
    await safeShot(page, SHOT.afterMode);
    await ensureNotErrorPage(page, "afterMode");

    console.log("「庭球場」をクリック");
    await clickByText(page, "庭球場");
    await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
    await waitStable(page);
    await ensureNotErrorPage(page, "afterTennis");

    console.log("カレンダー到達 URL:", page.url());
    await safeShot(page, SHOT.calendar);

    const all = [];
    for (const f of TARGET_FACILITIES) {
      console.log(`施設スキャン: ${f.key}`);
      const r = await scanFacilityFromCalendar(page, f);
      all.push(...r);
    }

    // 重複排除
    const seen = new Set();
    const uniq = [];
    for (const x of all) {
      const k = `${x.facility}::${x.line}`;
      if (seen.has(k)) continue;
      seen.add(k);
      uniq.push(x);
    }

    console.log(`取得した情報: ${uniq.length}件`);

    if (uniq.length > 0) {
      const lines = [];
      lines.push("🎾 目黒区庭球場に空きが見つかりました！");
      lines.push("");
      for (const f of TARGET_FACILITIES) {
        const hits = uniq.filter(u => u.facility === f.key);
        if (!hits.length) continue;
        lines.push(`【${f.key}】`);
        for (const h of hits.slice(0, 30)) lines.push(`- ${h.line}`);
        lines.push("");
      }
      lines.push("予約・確認はこちら:");
      lines.push(page.url());
      await sendMail("🎾 庭球場に空きあり！", lines.join("\n"));
    }

    await browser.close();
    console.log("チェック完了");
  } catch (err) {
    console.log("致命的エラー:", err && (err.stack || err.message || err));
    try {
      await sendMail("❌ 庭球場チェッカー エラー", `${err && (err.stack || err.message || err)}\n`);
    } catch (_) {}
    process.exit(1);
  }
})();
