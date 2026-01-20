const puppeteer = require('puppeteer');
const { Resend } = require('resend');

// 環境変数から設定を取得
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || 'ysk.ouchi@gmail.com';
const LOGIN_ID = process.env.MEGURO_LOGIN_ID;
const LOGIN_PASSWORD = process.env.MEGURO_LOGIN_PASSWORD;

// Resendクライアント初期化
const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;

// 監視対象の施設名（部分一致で検索）
const TARGET_FACILITIES = [
  '駒場',
  '目黒区民センター',
  '碑文谷'
];

// メール通知を送信
async function sendEmailNotify(subject, message) {
  if (!resend) {
    console.log('メール通知スキップ（API key未設定）:', subject);
    return;
  }
  
  try {
    const { data, error } = await resend.emails.send({
      from: 'tennis-checker@resend.dev',
      to: [NOTIFY_EMAIL],
      subject: subject,
      text: message,
    });

    if (error) {
      console.error('メール送信エラー:', error);
    } else {
      console.log('メール送信成功:', data);
    }
  } catch (error) {
    console.error('メール通知エラー:', error.message);
  }
}

// メイン処理
async function checkAvailability() {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu'
    ]
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    
    console.log('目黒区施設予約システムにアクセス中...');
    await page.goto('https://resv.city.meguro.tokyo.jp/Web/Home/WgR_ModeSelect', {
      waitUntil: 'networkidle2',
      timeout: 30000
    });

    // ログイン処理
    if (LOGIN_ID && LOGIN_PASSWORD) {
      console.log('ログイン処理を開始...');
      
      // ログインボタンをクリック
      await page.click('a[href*="login"]');
      await page.waitForTimeout(2000);
      
      // ID/パスワード入力
      await page.type('input[name*="ID"], input[type="text"]', LOGIN_ID);
      await page.type('input[name*="PASS"], input[type="password"]', LOGIN_PASSWORD);
      
      // ログイン実行
      await page.click('input[type="submit"], button[type="submit"]');
      await page.waitForTimeout(3000);
      
      console.log('ログイン完了');
    }

    // 「施設種類から探す」をクリック
    console.log('庭球場を検索中...');
    const facilityTypeLink = await page.$('a[href*="javascript:void(0)"]');
    if (facilityTypeLink) {
      const linkText = await page.evaluate(el => el.textContent, facilityTypeLink);
      if (linkText.includes('施設種類から探す')) {
        await facilityTypeLink.click();
        await page.waitForTimeout(2000);
      }
    }

    // 「庭球場」を選択
    const tennisCourtLink = await page.evaluateHandle(() => {
      const links = Array.from(document.querySelectorAll('a'));
      return links.find(a => a.textContent.includes('庭球場'));
    });
    
    if (tennisCourtLink) {
      await tennisCourtLink.click();
      await page.waitForTimeout(3000);
    }

    // 空き状況を取得
    console.log('空き状況を取得中...');
    await page.waitForTimeout(2000);
    
    const availabilities = await page.evaluate((targets) => {
      const results = [];
      
      // テーブルやリストから施設情報を探す
      const rows = document.querySelectorAll('tr, li, div[class*="facility"], div[class*="schedule"]');
      
      rows.forEach(row => {
        const text = row.textContent || '';
        
        // 対象施設名が含まれているかチェック
        const matchedFacility = targets.find(facility => text.includes(facility));
        
        if (matchedFacility) {
          // 「○」「空き」「可」などの空き情報を探す
          if (text.includes('○') || text.includes('空き') || text.includes('可') || 
              text.match(/\d+:\d+/) || text.includes('利用可')) {
            
            // 日付情報を抽出
            const dateMatch = text.match(/(\d+)月(\d+)日|(\d+)\/(\d+)/);
            const timeMatch = text.match(/(\d+):(\d+)/g);
            
            results.push({
              facility: matchedFacility,
              text: text.trim().substring(0, 200),
              hasAvailability: true,
              date: dateMatch ? dateMatch[0] : '不明',
              times: timeMatch || []
            });
          }
        }
      });
      
      return results;
    }, TARGET_FACILITIES);

    console.log(`取得した情報: ${availabilities.length}件`);

    // スクリーンショットを保存（デバッグ用）
    await page.screenshot({ path: '/tmp/meguro-tennis-debug.png', fullPage: true });
    console.log('スクリーンショット保存: /tmp/meguro-tennis-debug.png');

    // 空きがあれば通知
    if (availabilities.length > 0) {
      let message = '🎾 目黒区庭球場に空きが見つかりました！\n\n';
      
      availabilities.forEach((item, index) => {
        message += `【${item.facility}】\n`;
        message += `日付: ${item.date}\n`;
        if (item.times.length > 0) {
          message += `時間: ${item.times.join(', ')}\n`;
        }
        message += `---\n`;
      });
      
      message += '\n今すぐ予約: https://resv.city.meguro.tokyo.jp/Web/Home/WgR_ModeSelect';
      
      await sendEmailNotify('🎾 庭球場に空きあり！', message);
      console.log('空きを検出し、メール通知を送信しました');
    } else {
      console.log('現在、対象施設に空きはありません');
      
      // 24時間に1回、動作確認の通知を送る（オプション）
      const hour = new Date().getHours();
      if (hour === 9) { // 毎日9時に動作確認
        await sendEmailNotify(
          '目黒区庭球場チェッカー 動作確認',
          '目黒区庭球場チェッカーは正常に動作しています（現在空きなし）'
        );
      }
    }

  } catch (error) {
    console.error('エラーが発生しました:', error);
    await sendEmailNotify('❌ エラー発生', `エラー内容: ${error.message}`);
  } finally {
    await browser.close();
  }
}

// 実行
checkAvailability()
  .then(() => {
    console.log('チェック完了');
    process.exit(0);
  })
  .catch(error => {
    console.error('致命的エラー:', error);
    process.exit(1);
  });
