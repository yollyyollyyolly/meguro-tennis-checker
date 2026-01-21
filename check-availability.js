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
        return { title, out, hasCircle: availableMarks.some(m => pageText.includes(m)) };
      }, SYMBOLS.available);

      if (slots.out.length) {
        results.push(...slots.out.map(line => ({
          facility: facility.key,
          line,
        })));
      }

      // 戻る（詳細→カレンダー）
      await page.goBack({ waitUntil: "domcontentloaded", timeout: 30000 }).catch(async () => {
        // goBack失敗時の保険：カレンダーに戻す
        await gotoAndWait(page, TARGET_CAL_URL);
      });
      await page.waitForTimeout(800);
      await ensureNotErrorPage(page, `${facility.key} back to calendar`);
      await safeShot(page, SHOT.calendar);

    } catch (e) {
      console.log(`詳細取得失敗(${facility.key}):`, e.message || e);
      // 失敗してもカレンダーに戻して継続
      await safeShot(page, SHOT.error);
      await gotoAndWait(page, TARGET_CAL_URL);
      await page.waitForTimeout(800);
    }
  }

  return results;
}

(async () => {
  try {
    mustEnv("RESEND_API_KEY", RESEND_API_KEY);
    mustEnv("NOTIFY_EMAIL", NOTIFY_EMAIL);

    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      locale: "ja-JP",
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36",
    });
    const page = await context.newPage();

    console.log("開始：トップページへ");
    await gotoAndWait(page, START_URL);
    await safeShot(page, SHOT.mode);
    await ensureNotErrorPage(page, "mode_select");

    // ここからは「クリック遷移」固定
    // 施設種類から探す → 庭球場 → カレンダー
    console.log("「施設種類から探す」をクリック");
    await clickByText(page, "施設種類から探す");
    await page.waitForTimeout(1200);
    await safeShot(page, SHOT.afterModeClick);
    await ensureNotErrorPage(page, "after_mode_click");

    console.log("「庭球場」をクリック");
    await clickByText(page, "庭球場");
    await page.waitForTimeout(1500);
    await page.waitForLoadState("domcontentloaded", { timeout: 20000 }).catch(() => {});
    await ensureNotErrorPage(page, "after_tennis_click");

    // カレンダーに到達しているか（到達してなければ明示的にここで止める）
    // ※直gotoはしない（最後の保険としてのみ使用）
    if (!page.url().includes("WgR_ShisetsubetsuAkiJoukyou")) {
      console.log("注意：カレンダーURLに未到達。現在URL:", page.url());
      // 念のため一回だけカレンダーURLへ（ここでエラーページになるなら、クリック遷移が壊れている）
      await gotoAndWait(page, TARGET_CAL_URL);
      await ensureNotErrorPage(page, "calendar_direct_fallback");
    }

    console.log("カレンダーページ読み込み完了");
    await safeShot(page, SHOT.calendar);

    // 施設ごとにクリックして詳細抽出
    const all = [];
    for (const f of TARGET_FACILITIES) {
      console.log(`施設スキャン開始: ${f.key}`);
      const r = await scanFacility(page, f);
      all.push(...r);
    }

    // 重複排除
    const uniq = [];
    const seen = new Set();
    for (const x of all) {
      const k = `${x.facility}::${x.line}`;
      if (seen.has(k)) continue;
      seen.add(k);
      uniq.push(x);
    }

    console.log(`取得した情報: ${uniq.length}件`);

    if (uniq.length === 0) {
      console.log("現在、対象施設に空きはありません（または抽出できませんでした）");
      // 通知を出さない（ノイズ削減）
      // ただし「抽出できていない」可能性をゼロにできないので、最初の数回は通知してもいい
      // 今回は運用重視で通知なしにする
    } else {
      // メール本文整形
      const lines = [];
      lines.push("🎾 目黒区庭球場に空きが見つかりました！");
      lines.push("");
      for (const f of TARGET_FACILITIES) {
        const hits = uniq.filter(u => u.facility === f.key);
        if (!hits.length) continue;
        lines.push(`【${f.key}】`);
        for (const h of hits.slice(0, 30)) {
          lines.push(`- ${h.line}`);
        }
        lines.push("");
      }
      lines.push("予約・確認はこちら:");
      lines.push(TARGET_CAL_URL);

      await sendMail("🎾 庭球場に空きあり！", lines.join("\n"));
    }

    await browser.close();
    console.log("チェック完了");
  } catch (err) {
    console.log("致命的エラー:", err && (err.stack || err.message || err));

    // エラー時は通知を飛ばす（運用上ここが重要）
    try {
      await sendMail(
        "❌ 庭球場チェッカー エラー",
        `エラーが発生しました。\n\n${err && (err.stack || err.message || err)}\n`
      );
    } catch (e2) {
      console.log("エラーメール送信にも失敗:", e2 && (e2.stack || e2.message || e2));
    }

    process.exit(1);
  }
})();
