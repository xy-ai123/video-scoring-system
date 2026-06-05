# Apps Script — onFormSubmit webhook

This directory contains the Google Apps Script source that lives inside your Google Form's bound script project. It signs and POSTs each new submission to your deployed web app.

## One-time setup

1. **Open the Form.** Go to your Google Form (the one whose responses should be scored).
2. **Open the Script editor.** Click the three-dot menu (`⋮`) at the top right of the Form -> `Script editor`. A new Apps Script project opens, bound to this Form.
3. **Show the manifest.** In the Apps Script editor, click the gear icon (Project Settings) on the left sidebar and tick "Show 'appsscript.json' manifest file in editor".
4. **Replace `appsscript.json`** with the contents of `apps-script/appsscript.json` from this repo. Save.
5. **Replace `Code.gs`** with the contents of `apps-script/Code.gs` from this repo. Save.
6. **Set Script Properties.** In the editor, click the gear icon -> Project Settings -> Script Properties -> Add script property. Add these keys (values come from your deployment):
   - `WEBHOOK_URL` — the deployed URL of the web app, e.g. `https://your-app.up.railway.app/api/webhooks/google-form`
   - `WEBHOOK_SECRET` — same value as the `WEBHOOK_SECRET` env var on the server. A long random string.
   - `FIELD_EMAIL` — the **exact title** of the form item that asks for the submitter's email
   - `FIELD_NAME` — the exact title of the name item
   - `FIELD_CATEGORY` — the exact title of the category item
   - `FIELD_VIDEO` — the exact title of the file-upload item
7. **Install the trigger.**
   - Click the alarm-clock icon ("Triggers") in the left sidebar.
   - Click `Add Trigger` (bottom right).
   - Choose function: `onFormSubmit`.
   - Deployment: `Head`.
   - Event source: `From form`.
   - Event type: `On form submit`.
   - Failure notifications: `Notify me immediately` (recommended).
   - Save. You will be prompted to authorize the script.
8. **Authorize.** Approve the requested OAuth scopes (Forms read, External Requests, Drive read).

## Verifying

- Submit a test response to the Form (uploading a small video file).
- Open Apps Script -> Executions to see the run log. You should see `Webhook accepted (200)`.
- On the dashboard at `${WEBHOOK_URL%/api/webhooks/google-form}/admin`, the new submission should appear within seconds.

## Troubleshooting

- **`Missing Script Property: …`** — you didn't set one of the required Script Properties.
- **`HTTP 401`** — `WEBHOOK_SECRET` mismatch between Apps Script and the server.
- **`HTTP 400`** — payload didn't validate; check that the form item titles in Script Properties exactly match the form's item titles.
- **`No uploaded files in response`** — the `FIELD_VIDEO` form item must be a "File upload" question.
- **Drive `getFileById` denied** — ensure the Form's response Drive folder is shared with the server's Service Account email as Viewer.
