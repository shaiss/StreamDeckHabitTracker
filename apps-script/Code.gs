// Habit logger for Stream Deck. Appends one timestamped row per tap.
// Paste this into the Apps Script editor attached to your sheet
// (Extensions -> Apps Script), then Deploy as a Web app. See ../README.md.

const SHEET_NAME = 'Log';
const SECRET = 'CHANGE_ME'; // optional: set to a random word to require ?key=that word

function doGet(e)  { return handle(e); }
function doPost(e) { return handle(e); }

function handle(e) {
  try {
    var p = (e && e.parameter) ? e.parameter : {};
    var habit = (p.habit || '').toString().trim();
    if (!habit) return out('Missing habit');

    // Optional shared-secret check (ignored while SECRET is still CHANGE_ME)
    if (SECRET && SECRET !== 'CHANGE_ME' && p.key !== SECRET) return out('Unauthorized');

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(SHEET_NAME) || ss.insertSheet(SHEET_NAME);
    if (sheet.getLastRow() === 0) {
      sheet.appendRow(['Timestamp', 'Habit', 'Date', 'Time', 'Note']);
      sheet.setFrozenRows(1);
    }
    var tz  = ss.getSpreadsheetTimeZone();
    var now = new Date();
    sheet.appendRow([
      now,
      habit,
      Utilities.formatDate(now, tz, 'yyyy-MM-dd'),
      Utilities.formatDate(now, tz, 'HH:mm:ss'),
      (p.note || '').toString()
    ]);
    return out('Logged: ' + habit + ' at ' + Utilities.formatDate(now, tz, 'HH:mm'));
  } catch (err) {
    return out('Error: ' + err);
  }
}

function out(msg) {
  return ContentService.createTextOutput(msg).setMimeType(ContentService.MimeType.TEXT);
}
