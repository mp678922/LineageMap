/** @OnlyCurrentDoc */
// Bind this script to the private Google Sheet that stores the public landmarks.
const LANDMARK_SHEET = 'Landmarks';
const SETTINGS_SHEET = 'Settings';
const HEADERS = ['id', 'name', 'type', 'note', 'x', 'y', 'row', 'col', 'updatedAt'];
const TYPES = ['place', 'boss', 'note', 'npc', 'portal', 'danger'];

function doGet(e) {
  const query = e && e.parameter || {};
  let result;
  if (query.action === 'list') {
    result = {ok: true, landmarks: readLandmarks_()};
  } else if (query.action === 'receipt' && /^[a-f0-9]{32}$/.test(query.id || '')) {
    const value = CacheService.getScriptCache().get('receipt:' + query.id);
    result = value ? JSON.parse(value) : {pending: true};
  } else {
    result = {ok: false, error: '不支援的請求'};
  }
  const callback = query.callback || '';
  if (!/^lineageCallback_[a-f0-9]{32}$/.test(callback)) {
    return ContentService.createTextOutput(JSON.stringify({ok: false, error: '無效的回呼函式'}))
      .setMimeType(ContentService.MimeType.JSON);
  }
  return ContentService.createTextOutput(callback + '(' + JSON.stringify(result) + ');')
    .setMimeType(ContentService.MimeType.JAVASCRIPT);
}

function doPost(e) {
  const input = e && e.parameter || {};
  const id = input.opId || '';
  if (!/^[a-f0-9]{32}$/.test(id)) return json_({ok: false, error: '無效的操作識別碼'});
  let result;
  try {
    const expected = editCode_();
    if (!samePassword_(input.password || '', expected)) throw new Error('編輯密碼不正確');
    if (input.action === 'verify') {
      result = {ok: true};
    } else if (input.action === 'save' || input.action === 'delete') {
      const lock = LockService.getScriptLock();
      lock.waitLock(10000);
      try { result = mutateLandmark_(input); }
      finally { lock.releaseLock(); }
    } else {
      throw new Error('不支援的操作');
    }
  } catch (error) {
    result = {ok: false, error: String(error.message || error)};
  }
  CacheService.getScriptCache().put('receipt:' + id, JSON.stringify(result), 300);
  return json_(result);
}

function json_(value) {
  return ContentService.createTextOutput(JSON.stringify(value))
    .setMimeType(ContentService.MimeType.JSON);
}

function samePassword_(a, b) {
  const left = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, a);
  const right = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, b);
  let diff = left.length ^ right.length;
  for (let i = 0; i < Math.min(left.length, right.length); i++) diff |= left[i] ^ right[i];
  return diff === 0;
}

function editCode_() {
  const book = SpreadsheetApp.getActiveSpreadsheet();
  const settings = book && book.getSheetByName(SETTINGS_SHEET);
  if (!settings) throw new Error('找不到 Settings 工作表');
  const code = String(settings.getRange('B2').getDisplayValue()).trim();
  if (!/^[0-9]{4}$/.test(code)) throw new Error('請在 Settings!B2 填入 4 位數編輯碼');
  return code;
}

function sheet_() {
  const book = SpreadsheetApp.getActiveSpreadsheet();
  if (!book) throw new Error('請從 Google 試算表建立綁定的 Apps Script');
  let sheet = book.getSheetByName(LANDMARK_SHEET);
  if (!sheet) {
    sheet = book.insertSheet(LANDMARK_SHEET);
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function readLandmarks_() {
  const sheet = sheet_();
  const last = sheet.getLastRow();
  if (last < 2) return [];
  return sheet.getRange(2, 1, last - 1, HEADERS.length).getValues()
    .filter(row => /^[a-f0-9]{32}$/.test(String(row[0])))
    .map(row => ({id: String(row[0]), name: String(row[1]), type: String(row[2]),
      note: String(row[3]), x: Number(row[4]), y: Number(row[5]),
      row: Number(row[6]), col: Number(row[7]), updatedAt: String(row[8])}));
}

function mutateLandmark_(input) {
  const sheet = sheet_();
  const id = input.id || '';
  if (!/^[a-f0-9]{32}$/.test(id)) throw new Error('無效的地標識別碼');
  const last = sheet.getLastRow();
  const ids = last > 1 ? sheet.getRange(2, 1, last - 1, 1).getValues().flat() : [];
  const found = ids.indexOf(id);
  if (input.action === 'delete') {
    if (found < 0) throw new Error('地標不存在');
    sheet.deleteRow(found + 2);
    return {ok: true};
  }
  const name = String(input.name || '').trim();
  const note = String(input.note || '').trim();
  const type = String(input.type || 'place');
  const x = Number(input.x), y = Number(input.y);
  const row = Number(input.row), col = Number(input.col);
  if (!name || name.length > 60 || note.length > 500 || !TYPES.includes(type) ||
      ![x, y, row, col].every(Number.isFinite) || !Number.isInteger(row) ||
      !Number.isInteger(col) || row < 0 || col < 0 || x < 0 || y < 0)
    throw new Error('地標資料無效');
  if (found < 0 && last >= 2001) throw new Error('地標數量已達上限');
  const values = [id, sheetText_(name), type, sheetText_(note), x, y, row, col,
    new Date().toISOString()];
  sheet.getRange(found >= 0 ? found + 2 : last + 1, 1, 1, HEADERS.length)
    .setValues([values]);
  return {ok: true, id};
}

function sheetText_(text) {
  return /^[=+\-@]/.test(text) ? "'" + text : text;
}
