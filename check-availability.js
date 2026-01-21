// check-availability.js
// 目的：目黒区予約サイトを「クリック遷移」で辿り、駒場/区民センター/碑文谷の空き時間（○）を抽出して通知する
// 重要：URL直アクセスはエラーになりやすい（WebForms/セッション/VIEWSTATE）ため一切しない

const { chromium } = require("playwright");
const { Resend } = require("resend");

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL;

const START_URL = "https://resv.city.meguro.tokyo.jp/Web/Home/WgR_ModeSelect";
const TARGET_CAL_URL = "https://resv.city.meguro.tokyo.jp/Web/Yoyaku/WgR_ShisetsubetsuAkiJoukyou";

// 施設名は表記揺れがあるので「部分一致」で拾う（強め）
const TARGET_FACILITIES = [
  { key: "駒場", patterns: ["駒場"] },
  { key: "区民センター", patterns: ["区民センター"] },
  { key: "碑文谷", patterns: ["碑文谷"] },
];

// 記号揺れ対策（○/〇/△/×等）
const SYMBOLS = {
  available: ["○", "〇"],        // 空き
  partial: ["△"],               // 一部空き（必要なら通知対象に含める）
  unavailable: ["×", "✕"],
};

// 通知対象：○だけにするなら true。△も拾いたいなら false
const ONLY_CIRCLE = true;

// スクショ保存先（Artifactsで回収できるように）
const SHOT = {
  mode: "/tmp/01_mode_select.png",
  afterModeClick: "/tmp/02_after_mode_click.png",
  calendar: "/tmp/03_calendar.png",
  detail: "/tmp/04_detail.png",
  error: "/tmp/99_error.png",
};
const HTML_ERROR = "/tmp/99_error.html";

function mustEnv(name, value) {
  if (!value) throw new Error(`Missing env: ${name}`);
}

function isErrorLikeText(txt) {
  if (!txt) return false;
  // 文字化けしてても進入禁止アイコンのページは "ホームへ" が出がち
  // 日本語が取れないケースもあるので、見た目の手がかりも一部使う
  return (
    txt.includes("エラー") ||
    txt.includes("無効") ||
    txt.includes("禁止") ||
    txt.includes("ホームへ") ||
    txt.includes("戻る") && txt.includes("ホーム")
  );
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

async function clickByText(page, text) {
  const loc = page.getByText(text, { exact: false });
  await loc.first().click({ timeout: 15000 });
}

async function ensureNotErrorPage(page, label) {
  const bodyText = await page.evaluate(() => document.body?.innerText || "");
  if (isErrorLikeText(bodyText)) {
    await safeShot(page, SHOT.error);
    try {
      const html = await page.content();
      const fs = require("fs");
      fs.writeFileSync(HTML_ERROR, html, "utf-8");
    } catch (_) {}
    throw new Error(`不正遷移/エラーページ疑い (${label}) url=${page.url()}`);
  }
}

async function gotoAndWait(page, url) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(1000);
}

function normalize(s) {
  return (s || "").replace(/\s+/g, " ").trim();
}

// カレンダー上で該当施設ブロックを見つけ、○/△セルをクリックして詳細ページで空き時間を抽出する
async function scanFacility(page, facility) {
  // ページ内の施設ブロックを「見出しテキスト」を頼りに探す
  // 見出し候補を全部拾って、パターンにマッチするものの近傍を対象にする
  const results = [];

  // 施設ブロック候補：見出し要素っぽいものを探索
  const headingHandles = await page.locator("h1,h2,h3,div,span").elementHandles();
  let matchedHeading = null;

  for (const h of headingHandles.slice(0, 800)) {
    const t = normalize(await h.evaluate(el => el.textContent || ""));
    if (!t) continue;
    if (facility.patterns.some(p => t.includes(p))) {
      matchedHeading = h;
      break;
    }
  }

  if (!matchedHeading) {
    console.log(`施設ブロック見つからず: ${facility.key}`);
    return results;
  }

  // 見出し要素の近傍（親要素）をブロックとして扱う
  const block = await matchedHeading.evaluateHandle(el => {
    // 施設ブロックはDOM構造が変わりやすいので、少し上の親を返す
    let cur = el;
    for (let i = 0; i < 5; i++) {
      if (!cur || !cur.parentElement) break;
      cur = cur.parentElement;
      // テーブル含む大きめ要素を目安に
      if (cur.querySelector && cur.querySelector("table")) return cur;
    }
    return el.parentElement || el;
  });

  // ブロック内のセルを探索
  // クリックできる要素（a/button）を優先、無ければセルクリック
  const targetMarks = ONLY_CIRCLE ? SYMBOLS.available : [...SYMBOLS.available, ...SYMBOLS.partial];

  // まずブロック内で「○/△」が含まれるクリック可能要素を集める
  const clickable = await block.evaluate((root, marks) => {
    const out = [];
    const qs = Array.from(root.querySelectorAll("a,button,td,span,div"));
    for (const el of qs) {
      const txt = (el.textContent || "").trim();
      if (!txt) continue;
      if (!marks.some(m => txt.includes(m))) continue;

      // クリック対象は、リンク/ボタン、または onclick を持つ要素
      const isClickable =
        el.tagName === "A" ||
        el.tagName === "BUTTON" ||
        typeof el.onclick === "function" ||
        el.getAttribute("onclick");

      if (isClickable) {
        // 近くの「日付」情報が取れるなら取る（後で詳細で再取得するが、ログの手掛かりに）
        out.push({
          tag: el.tagName,
          txt,
        });
      }
    }
    return out;
  }, targetMarks);

  if (!clickable.length) {
    console.log(`空きマーク要素なし: ${facility.key}`);
    return results;
  }

  console.log(`候補(${facility.key}): ${clickable.length} 件（クリックして詳細取得）`);

  // 「実際にクリック」して詳細ページへ → 時間帯表から○を拾う
  // ※同一ページで戻りながら順次処理。重いので最大件数を制限（多すぎると15分間隔でも重い）
  const MAX_CLICKS_PER_FACILITY = 8;
  let clicks = 0;

  for (let i = 0; i < clickable.length && clicks < MAX_CLICKS_PER_FACILITY; i++) {
    clicks++;

    // ブロックをLocatorとして再構成して、該当テキストを含む要素をクリック
    // ※同じ文字が複数あり得るので nth(i) は不安定。ここは「その時点で見える最初の一致」戦略にする
    const markText = targetMarks.find(m => clickable[i].txt.includes(m)) || targetMarks[0];

    // ブロック内で markText を含むリンク/ボタンを優先してクリック
    const blockLocator = page.locator(":scope").filter({ has: page.locator("table") }).first();
    // 上の blockLocator は曖昧なので、確実に「施設名を含む領域」から辿る
    const facilityArea = page.getByText(facility.patterns[0], { exact: false }).first().locator("..");
    const candidateLink = facilityArea.locator(`a:has-text("${markText}"), button:has-text("${markText}")`).first();

    try {
      const before = page.url();
      await candidateLink.click({ timeout: 15000 });
      await page.waitForTimeout(1000);

      // 遷移していない場合（postback等）、URLが変わらないことがあるので waitForLoadState も併用
      await page.waitForLoadState("domcontentloaded", { timeout: 20000 }).catch(() => {});
      await ensureNotErrorPage(page, `${facility.key} detail`);

      // 詳細ページにいるかどうか（URLで判定できるなら）
      // 直URLアクセスは禁止だが、遷移後のURL判定はOK
      const nowUrl = page.url();
      console.log(`詳細ページURL: ${nowUrl} (from ${before})`);
      await safeShot(page, SHOT.detail);

      // 詳細ページから空き時間抽出
      const slots = await page.evaluate((availableMarks) => {
        const out = [];
        const pageText = document.body?.innerText || "";

        // 施設名（ページ上部に出ている想定）
        const title = (document.querySelector("h1,h2,h3")?.textContent || "").trim();

        // 表っぽいところから「○」行を拾う
        // DOM構造は不安定なので、まずはテーブルセルの走査
        const tables = Array.from(document.querySelectorAll("table"));
        for (const table of tables) {
          const rows = Array.from(table.querySelectorAll("tr"));
          for (const tr of rows) {
            const tds = Array.from(tr.querySelectorAll("th,td"));
            if (!tds.length) continue;

            const rowText = tds.map(td => (td.textContent || "").trim()).filter(Boolean);

            // 行内に「○/〇」があれば空き
            const hasAvail = rowText.some(x => availableMarks.some(m => x.includes(m)));
            if (!hasAvail) continue;

            // それっぽい情報（面/時間/日付）を行テキストから推定
            // 例： "B面", "15:00-16:00", "1月21日" 等が混ざっているはず
            out.push(rowText.join(" "));
          }
        }

        // もし表抽出が0なら、ページテキストに○があるかだけでも返す（デバッグ用）
