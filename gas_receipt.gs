// const debugsheet = SpreadsheetApp.openById('デバッグ用のスプシのID').getSheetByName('log');

const LINE_ACCESS_TOKEN = PropertiesService.getScriptProperties().getProperty('LINE_ACCESS_TOKEN');
const DIFY_API_KEY = PropertiesService.getScriptProperties().getProperty('DIFY_API_KEY');
const RESULT_SHEET_ID = PropertiesService.getScriptProperties().getProperty('RESULT_SHEET_ID');
const RESULT_SHEET_URL = `https://docs.google.com/spreadsheets/d/${RESULT_SHEET_ID}`;

// LINEからのPOSTリクエストを処理
function doPost(e) {
  Logger.log('--- doPost start ---');
  try {
    Logger.log('Received event: %s', JSON.stringify(e));
    
    if (!e.postData || !e.postData.contents) {
      Logger.log('postDataが存在しないため、処理を終了します。');
      return ContentService.createTextOutput(JSON.stringify({ content: 'no postData' })).setMimeType(ContentService.MimeType.JSON);
    }


    const json = JSON.parse(e.postData.contents);
    Logger.log('Received JSON: %s', JSON.stringify(json));

    const event = json.events[0];
    if (!event) {
      Logger.log('イベントが存在しないため、処理を終了します。');
      return ContentService.createTextOutput(JSON.stringify({ content: 'no event' })).setMimeType(ContentService.MimeType.JSON);
    }
    const replyToken = event.replyToken;

    if (event.message && event.message.type === 'image') {
      const messageId = event.message.id;
      Logger.log('画像メッセージ受信: messageId=%s', messageId);
      const imageBlob = getImageFromLINE(messageId);
      Logger.log('画像取得成功。サイズ: %d bytes', imageBlob.getBytes().length);

      const base64Image = Utilities.base64Encode(imageBlob.getBytes());
      Logger.log('画像をbase64エンコード完了: length=%d', base64Image.length);

      const { total_amount } = analyzeReceipt(base64Image);
      Logger.log('レシート解析結果: total_amount=%s', total_amount);

      writeToSheet(total_amount);
      Logger.log('スプレッドシートに記入完了');

      replyMessage(replyToken, `レシートの情報:\n合計金額: ${total_amount}\nスプレッドシートに記録しました。確認はこちら:\n${RESULT_SHEET_URL}`);
      Logger.log('返信完了');
    } else {
      Logger.log('画像メッセージでないため、メッセージを返信します。');
      replyMessage(replyToken, 'レシート画像を送信してください。');
    }

    Logger.log('--- doPost end ---');

    //デバッグ
    if (debugsheet !== null) {
      debugsheet.insertRowBefore(1);
      let dt = new Date();
      debugsheet.getRange('A1').setValue(Utilities.formatDate(dt, "JST", 'yyyy-MM-dd HH:m:ss'));
      debugsheet.getRange('B1').setValue(Logger.getLog());
    }

    return ContentService.createTextOutput(JSON.stringify({ content: 'ok' })).setMimeType(ContentService.MimeType.JSON);

  } catch (error) {
    Logger.log(`エラーが発生しました: ${error.stack || error}`);

    //デバッグ
    if (debugsheet !== null) {
      debugsheet.insertRowBefore(1);
      let dt = new Date();
      debugsheet.getRange('A1').setValue(Utilities.formatDate(dt, "JST", 'yyyy-MM-dd HH:m:ss'));
      debugsheet.getRange('B1').setValue(Logger.getLog());
    }

    return ContentService.createTextOutput(JSON.stringify({ content: 'error' })).setMimeType(ContentService.MimeType.JSON);
  }
}

// LINEから画像を取得
function getImageFromLINE(messageId) {
  Logger.log('getImageFromLINE start: messageId=%s', messageId);
  const url = `https://api-data.line.me/v2/bot/message/${messageId}/content`;
  const response = UrlFetchApp.fetch(url, {
    headers: { 'Authorization': `Bearer ${LINE_ACCESS_TOKEN}` },
  });
  Logger.log('LINE画像取得レスポンスステータス: %s', response.getResponseCode());
  Logger.log('getImageFromLINE end');
  return response.getBlob();
}

// Difyでレシートを解析
function analyzeReceipt(base64Image) {
  Logger.log('analyzeReceipt start');
  const fileId = uploadFileToDify(base64Image);
  Logger.log('DifyファイルID取得: %s', fileId);

  const result = runDifyWorkflow(fileId);
  Logger.log('Difyワークフロー実行結果: total_amount=%s', result.total_amount);
  Logger.log('analyzeReceipt end');
  return result;
}

// Difyにファイルをアップロード
function uploadFileToDify(base64Image) {
  Logger.log('uploadFileToDify start');
  try {
    const url = 'https://api.dify.ai/v1/files/upload';
    const user = 'line-user'; // 任意のユーザーIDを設定
    const imageBytes = Utilities.base64Decode(base64Image);
    Logger.log('画像バイト長: %d', imageBytes.length);

    const blob = Utilities.newBlob(imageBytes, 'image/jpeg', 'receipt.jpg');
    Logger.log('Blob作成完了: type=%s, name=%s', blob.getContentType(), blob.getName());

    const formData = {
      'file': blob,
      'user': user
    };

    const options = {
      method: 'post',
      headers: {
        'Authorization': `Bearer ${DIFY_API_KEY}`
      },
      payload: formData,
      muteHttpExceptions: true
    };

    const response = UrlFetchApp.fetch(url, options);
    const status = response.getResponseCode();
    const responseText = response.getContentText();
    Logger.log('Difyファイルアップロードレスポンスステータス: %d', status);
    Logger.log('Difyファイルアップロードレスポンスボディ: %s', responseText);

    const result = JSON.parse(responseText);

    if (!result.id) {
      Logger.log('ファイルアップロード失敗: %s', JSON.stringify(result));
      throw new Error('ファイルアップロードに失敗しました。');
    }

    Logger.log('uploadFileToDify end');
    return result.id; // file_idを返す
  } catch (error) {
    Logger.log('uploadFileToDifyでエラーが発生しました: %s', error.message);
    throw error;
  }
}

// Difyのワークフローを実行し、結果から情報を取得
function runDifyWorkflow(fileId) {
  Logger.log('runDifyWorkflow start: fileId=%s', fileId);
  const url = 'https://api.dify.ai/v1/workflows/run';
  const user = 'line-user'; // 任意のユーザーID
  const payload = {
    "inputs": {
      // Difyワークフローで定義された変数名をreceiptとした例(先頭は小文字)
      "receipt": {
        "transfer_method": "local_file",
        "upload_file_id": fileId,
        "type": "image"
      }
    },
    "response_mode": "blocking",
    "user": user
  };
  Logger.log('ワークフロー実行ペイロード: %s', JSON.stringify(payload));

  const options = {
    method: 'post',
    headers: {
      'Authorization': `Bearer ${DIFY_API_KEY}`,
      'Content-Type': 'application/json'
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  const response = UrlFetchApp.fetch(url, options);
  const status = response.getResponseCode();
  const responseText = response.getContentText();
  Logger.log('Difyワークフローレスポンスステータス: %d', status);
  Logger.log('Difyワークフローレスポンスボディ: %s', responseText);

  const result = JSON.parse(responseText);
  
  if (result && result.data && result.data.outputs) {
    Logger.log('Difyワークフローoutputs全体: %s', JSON.stringify(result.data.outputs));
    const outputs = result.data.outputs;

    // textフィールドにJSON文字列が入っているため、これをパース
    if (outputs.text) {
      try {
        const parsed = JSON.parse(outputs.text);
        const total_amount = parsed.total_amount || '不明';
        Logger.log('取得した出力:total_amount=%s',  total_amount);
        Logger.log('runDifyWorkflow end');
        return { total_amount };
      } catch (parseError) {
        Logger.log('textフィールドのJSONパースに失敗しました: %s', parseError);
        throw new Error('レシート解析結果のパースに失敗しました。');
      }
    } else {
      Logger.log('textフィールドが存在しませんでした。');
      throw new Error('レシート解析結果が取得できませんでした。');
    }
  } else {
    Logger.log('ワークフローの結果が期待した形式でありません: %s', JSON.stringify(result));
    throw new Error('レシート解析結果の取得に失敗しました。');
  }
}


// スプレッドシートに書き込む
function writeToSheet(total_amount) {
  const sheet = SpreadsheetApp.openById(RESULT_SHEET_ID).getSheetByName('list');
  //日付を取得する 
  const currentDate = new Date();
  const formattedDate = Utilities.formatDate(currentDate, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');
  sheet.appendRow([formattedDate, total_amount]);

  Logger.log('スプシ書き込みに成功しました: %s', formattedDate,total_amount);

}


// LINEにメッセージを返信
function replyMessage(replyToken, message) {
  Logger.log('replyMessage start');
  const url = 'https://api.line.me/v2/bot/message/reply';
  const payload = {
    replyToken: replyToken,
    messages: [{ type: 'text', text: message }],
  };

  const options = {
    method: 'post',
    headers: {
      'Authorization': `Bearer ${LINE_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    payload: JSON.stringify(payload),
  };

  Logger.log('返信ペイロード: %s', JSON.stringify(payload));

  try {
    const response = UrlFetchApp.fetch(url, options);
    Logger.log('返信成功: %s', response.getContentText());
  } catch (error) {
    Logger.log(`返信失敗: ${error.stack || error}`);
    throw new Error('返信に失敗しました。');
  }
  Logger.log('replyMessage end');
}
