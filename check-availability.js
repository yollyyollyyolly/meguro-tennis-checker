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
  '区民センター',
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
    
    console.log('庭球場詳細ページにアクセス中...');
    await page.goto('https://resv.city.meguro.tokyo.jp/Web/Yoyaku/WgR_JikantaibetsuAkiJoukyou', {
      waitUntil: 'networkidle2',
      timeout: 30000
    });
    
    console.log('ページ読み込み完了、詳細な空き状況を確認中...');
    await page.waitForTimeout(3000);

    // 詳細な空き状況を取得
    console.log('詳細な空き状況を取得中...');
    
    const availabilities = await page.evaluate((targets) => {
      const results = [];
      
      // すべてのテーブルを取得
      const tables = document.querySelectorAll('table');
      
      console.log(`${tables.length}個のテーブルを発見`);
      
      tables.forEach((table, tableIndex) => {
        const tableText = table.textContent || '';
        
        // 対象施設が含まれているかチェック
        const matchedFacility = targets.find(facility => tableText.includes(facility));
        
        if (!matchedFacility) {
          return; // この施設は対象外
        }
        
        console.log(`${matchedFacility}のテーブルを発見`);
        
        // テーブルの見出しから施設名と日付を取得
        let currentDate = '';
        let currentFacility = matchedFacility;
        
        // 日付を探す（例：2026年1月21日(水)）
        const dateMatch = tableText.match(/(\d+)年(\d+)月(\d+)日\((.)\)/);
        if (dateMatch) {
          currentDate = `${dateMatch[2]}月${dateMatch[3]}日(${dateMatch[4]})`;
        }
        
        // テーブルのヘッダー行から時間帯を取得
        const headerRow = table.querySelector('tr');
        if (!headerRow) return;
        
        const timeSlots = [];
        const headerCells = headerRow.querySelectorAll('th, td');
        
        headerCells.forEach(cell => {
          const cellText = cell.textContent.trim();
          // 時間帯のパターン（例：9:00～11:00）
          if (/\d+:\d+/.test(cellText)) {
            timeSlots.push(cellText);
          }
        });
        
        console.log(`時間帯: ${timeSlots.join(', ')}`);
        
        // データ行を処理
        const rows = table.querySelectorAll('tr');
        
        rows.forEach((row, rowIndex) => {
          if (rowIndex === 0) return; // ヘッダー行はスキップ
          
          const cells = row.querySelectorAll('td');
          if (cells.length === 0) return;
          
          // 最初のセルはコート名など
          const courtName = cells[0] ? cells[0].textContent.trim() : '';
          
          // 各時間帯のセルをチェック
          cells.forEach((cell, cellIndex) => {
            const cellText = cell.textContent.trim();
            
            // ○が含まれていれば空きあり
            if (cellText === '○' || cellText.includes('○')) {
              // 対応する時間帯を取得
              // ヘッダーとデータ行のセル位置を合わせる
              let timeSlot = '';
              
              // ヘッダー行の同じ位置から時間帯を取得
              const headerCellAtSamePosition = headerRow.querySelectorAll('th, td')[cellIndex];
              if (headerCellAtSamePosition) {
                timeSlot = headerCellAtSamePosition.textContent.trim();
              }
              
              if (timeSlot && /\d+:\d+/.test(timeSlot)) {
                results.push({
                  facility: currentFacility,
                  date: currentDate || '日付不明',
                  court: courtName || 'コート不明',
                  time: timeSlot,
                  text: `${currentFacility} - ${currentDate} ${courtName} ${timeSlot}`
                });
                
                console.log(`空き発見: ${currentFacility} ${currentDate} ${courtName} ${timeSlot}`);
              }
            }
          });
        });
      });
      
      console.log(`合計${results.length}件の空き時間を発見`);
      return results;
    }, TARGET_FACILITIES);

    console.log(`取得した情報: ${availabilities.length}件`);

    // スクリーンショットを保存（デバッグ用）
    await page.screenshot({ path: '/tmp/meguro-tennis-debug.png', fullPage: true });
    console.log('スクリーンショット保存: /tmp/meguro-tennis-debug.png');

    // 空きがあれば通知
    if (availabilities.length > 0) {
      // 施設ごと、日付ごとにグループ化
      const grouped = {};
      availabilities.forEach(item => {
        const key = `${item.facility}`;
        if (!grouped[key]) {
          grouped[key] = {};
        }
        
        const dateKey = item.date;
        if (!grouped[key][dateKey]) {
          grouped[key][dateKey] = [];
        }
        
        grouped[key][dateKey].push(item);
      });
      
      let message = '🎾 目黒区庭球場に空きが見つかりました！\n\n';
      
      Object.keys(grouped).forEach(facility => {
        message += `【${facility}】\n`;
        
        Object.keys(grouped[facility]).forEach(date => {
          message += `${date}\n`;
          
          grouped[facility][date].forEach(item => {
            message += `  ${item.court} ${item.time}\n`;
          });
        });
        
        message += '\n';
      });
      
      message += '予約はこちら:\nhttps://resv.city.meguro.tokyo.jp/Web/Yoyaku/WgR_JikantaibetsuAkiJoukyou';
      
      await sendEmailNotify('🎾 庭球場に空きあり！', message);
      console.log('空きを検出し、メール通知を送信しました');
      console.log('通知内容:\n' + message);
    } else {
      console.log('現在、対象施設に空きはありません');
      
      // 24時間に1回、動作確認の通知を送る（オプション）
      const hour = new Date().getHours();
      if (hour === 0) { // 毎日0時に動作確認（UTC時間なので日本時間9時）
        await sendEmailNotify(
          '目黒区庭球場チェッカー 動作確認',
          '目黒区庭球場チェッカーは正常に動作しています（現在空きなし）\n\n監視中の施設：\n- 駒場庭球場\n- 区民センター体育館\n- 碑文谷庭球場'
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
