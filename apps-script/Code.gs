/**
 * Video Scoring System — Google Apps Script (form-bound).
 *
 * Trigger: install an "On form submit" trigger for `onFormSubmit`.
 * Script Properties (File -> Project Properties -> Script properties):
 *   WEBHOOK_URL          - public URL ending in /api/webhooks/google-form
 *   WEBHOOK_SECRET       - HMAC shared secret with the server
 *   FIELD_EMAIL          - exact title of the email form item
 *   FIELD_NAME           - exact title of the name form item
 *   FIELD_CATEGORY       - exact title of the category form item
 *   FIELD_VIDEO          - exact title of the file-upload form item
 *   FIELD_PHONE          - OPTIONAL. If unset, the script auto-detects any
 *                          form question whose title contains "phone"
 *                          (case-insensitive). Set to a specific title only
 *                          when you have multiple phone-like questions and
 *                          want to disambiguate.
 *
 * NOTE: After editing this file, you must hit "Save" in the Apps Script
 * editor for the change to take effect on the next form submission. Apps
 * Script does not auto-deploy file edits.
 */

function getProp_(key) {
  var v = PropertiesService.getScriptProperties().getProperty(key);
  if (!v) throw new Error('Missing Script Property: ' + key);
  return v;
}

// Non-throwing variant. Returns null when the property is unset, instead of
// crashing the whole form-submit handler. Used for OPTIONAL fields like
// FIELD_PHONE where it's fine to fall back to auto-detect.
function getPropOptional_(key) {
  var v = PropertiesService.getScriptProperties().getProperty(key);
  return v ? v : null;
}

function findItem_(itemResponses, title) {
  for (var i = 0; i < itemResponses.length; i++) {
    if (itemResponses[i].getItem().getTitle() === title) {
      return itemResponses[i];
    }
  }
  return null;
}

// Looser variant: case-insensitive "title contains substring" match. Used by
// the phone-field auto-detect so a form question titled
// "Phone Provided ( Check sticker on the back of the phone)" still matches
// even if the operator only typed "Phone Provided" into the script property,
// or didn't set anything at all and we fall back to searching for "phone".
function findItemContains_(itemResponses, needle) {
  if (!needle) return null;
  var lower = String(needle).toLowerCase();
  for (var i = 0; i < itemResponses.length; i++) {
    var t = itemResponses[i].getItem().getTitle() || '';
    if (t.toLowerCase().indexOf(lower) !== -1) {
      return itemResponses[i];
    }
  }
  return null;
}

function asString_(resp) {
  if (!resp) return '';
  var v = resp.getResponse();
  if (v == null) return '';
  return String(v).trim();
}

function asArray_(resp) {
  if (!resp) return [];
  var v = resp.getResponse();
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

function buildPayload_(e) {
  var formResponse = e.response;
  var responseId = formResponse.getId();
  var itemResponses = formResponse.getItemResponses();

  var emailTitle = getProp_('FIELD_EMAIL');
  var nameTitle = getProp_('FIELD_NAME');
  var categoryTitle = getProp_('FIELD_CATEGORY');
  var videoTitle = getProp_('FIELD_VIDEO');
  // OPTIONAL Script Property. If set, we'll loose-match against that title
  // (case-insensitive substring) — handy when the operator wants a specific
  // title to win over auto-detect. If unset, we just fall back to searching
  // any question whose title contains "phone".
  var phoneTitle = getPropOptional_('FIELD_PHONE');

  var emailResp = findItem_(itemResponses, emailTitle);
  var nameResp = findItem_(itemResponses, nameTitle);
  var categoryResp = findItem_(itemResponses, categoryTitle);
  var videoResp = findItem_(itemResponses, videoTitle);
  // Phone extraction is forgiving: explicit FIELD_PHONE > contains "phone" >
  // null. This way the form question
  // "Phone Provided ( Check sticker on the back of the phone)" gets caught
  // without any operator setup.
  var phoneResp =
    (phoneTitle ? findItemContains_(itemResponses, phoneTitle) : null) ||
    findItemContains_(itemResponses, 'phone');

  var submitterEmail = asString_(emailResp) || (formResponse.getRespondentEmail && formResponse.getRespondentEmail()) || '';
  if (!submitterEmail) throw new Error('Missing submitter email');

  var fileIds = asArray_(videoResp);
  if (!fileIds.length) throw new Error('No uploaded files in response');

  var files = [];
  for (var i = 0; i < fileIds.length; i++) {
    var id = fileIds[i];
    try {
      var f = DriveApp.getFileById(id);
      files.push({
        driveFileId: id,
        name: f.getName(),
        mimeType: f.getMimeType()
      });
    } catch (err) {
      Logger.log('Could not stat Drive file ' + id + ': ' + err);
      files.push({ driveFileId: id, name: id, mimeType: undefined });
    }
  }

  var phoneProvided = asString_(phoneResp);

  return {
    responseId: responseId,
    submitterEmail: submitterEmail,
    submitterName: asString_(nameResp) || submitterEmail,
    category: asString_(categoryResp) || 'uncategorized',
    // Empty string -> undefined so it serializes cleanly; the webhook
    // handler treats both as "no phone".
    phoneProvided: phoneProvided || undefined,
    files: files
  };
}

function hmacSha256Hex_(message, secret) {
  var raw = Utilities.computeHmacSha256Signature(message, secret);
  // Convert to hex.
  var hex = '';
  for (var i = 0; i < raw.length; i++) {
    var byte = raw[i];
    if (byte < 0) byte += 256;
    var s = byte.toString(16);
    if (s.length === 1) s = '0' + s;
    hex += s;
  }
  return hex;
}

function postWithRetry_(url, body, signature, timestamp) {
  var options = {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'X-Signature': 'sha256=' + signature,
      'X-Timestamp': timestamp,
      // Skip ngrok-free's browser-warning interstitial when developing locally.
      'ngrok-skip-browser-warning': 'true'
    },
    payload: body,
    muteHttpExceptions: true,
    followRedirects: true
  };

  var delays = [2000, 5000, 15000];
  for (var attempt = 0; attempt < 3; attempt++) {
    var resp = UrlFetchApp.fetch(url, options);
    var code = resp.getResponseCode();
    if (code >= 200 && code < 300) {
      Logger.log('Webhook accepted (' + code + ') on attempt ' + (attempt + 1));
      return;
    }
    Logger.log(
      'Webhook attempt ' + (attempt + 1) + ' failed: HTTP ' + code +
      ' body=' + resp.getContentText().slice(0, 500)
    );
    if (attempt < delays.length) {
      Utilities.sleep(delays[attempt]);
    }
  }
  throw new Error('Webhook failed after retries');
}

/**
 * DEBUG HELPER — run this manually from the Apps Script editor's "Run" menu
 * to verify the phone-extract logic finds your form's "Phone Provided"
 * question without needing to submit a real form response.
 *
 * What it does:
 *   1. Looks up the form bound to this script.
 *   2. Logs every form item title (so you can see exactly what Apps Script
 *      sees — useful when titles contain odd whitespace).
 *   3. Reports which item the auto-detect would match for "phone".
 *
 * Open: Apps Script editor → top menu → "Run" → pick `testPhoneExtraction`.
 *       Then "View → Logs" (or the bottom panel) to see results.
 */
function testPhoneExtraction() {
  var form = FormApp.getActiveForm();
  if (!form) {
    Logger.log('No active form bound to this script. Open this script from the form itself (Extensions -> Apps Script on the form), not from a standalone editor.');
    return;
  }
  var items = form.getItems();
  Logger.log('Form: "' + form.getTitle() + '" has ' + items.length + ' items:');
  for (var i = 0; i < items.length; i++) {
    var title = items[i].getTitle();
    var contains = title && title.toLowerCase().indexOf('phone') !== -1;
    Logger.log('  [' + (i + 1) + '] ' + JSON.stringify(title) + (contains ? '   <-- auto-detect MATCH for "phone"' : ''));
  }

  // Simulate the resolution buildPayload_ would do.
  var explicit = getPropOptional_('FIELD_PHONE');
  Logger.log('\nFIELD_PHONE script property = ' + JSON.stringify(explicit));

  // FormItem and ItemResponse are different — but for the title-match step
  // we only need the title. Build a faux itemResponses-shaped array so we
  // can reuse findItemContains_ unchanged.
  var fauxItems = items.map(function (it) {
    return { getItem: function () { return it; } };
  });
  var match =
    (explicit ? findItemContains_(fauxItems, explicit) : null) ||
    findItemContains_(fauxItems, 'phone');
  if (match) {
    Logger.log('\nPhone-extract resolved to: ' + JSON.stringify(match.getItem().getTitle()));
    Logger.log('-> Real submissions will have phoneProvided = <whatever the submitter chose for that question>.');
  } else {
    Logger.log('\nPhone-extract resolved to: NOTHING.');
    Logger.log('-> Real submissions will have phoneProvided = null.');
    Logger.log('   Either rename the phone question to contain the word "phone", or set FIELD_PHONE in Script Properties to the exact (or partial) title above.');
  }
}

function onFormSubmit(e) {
  try {
    var url = getProp_('WEBHOOK_URL');
    var secret = getProp_('WEBHOOK_SECRET');

    var payload = buildPayload_(e);
    var body = JSON.stringify(payload);
    var timestamp = String(Date.now());
    var signature = hmacSha256Hex_(timestamp + '\n' + body, secret);

    Logger.log(
      'Submitting responseId=' + payload.responseId +
      ' files=' + payload.files.length
    );
    postWithRetry_(url, body, signature, timestamp);
  } catch (err) {
    Logger.log('onFormSubmit error: ' + (err && err.stack || err));
    throw err;
  }
}
