/**
 * Header icon that opens the configured decision-log Google Sheet in a new
 * tab. The sheet ID comes from the SHEET_ID env var so the link stays in
 * sync if the operator swaps spreadsheets later.
 *
 * Renders nothing if SHEET_ID is unset.
 */
export function SheetsIconLink() {
  const sheetId = process.env.SHEET_ID;
  if (!sheetId) return null;
  const url = `https://docs.google.com/spreadsheets/d/${sheetId}/edit`;
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer noopener"
      aria-label="Open decision-log Google Sheet"
      title="Decision log (Google Sheets)"
      className="inline-flex items-center justify-center rounded-md p-1 text-slate-500 transition-colors hover:bg-slate-100 hover:text-emerald-700"
    >
      {/* Google-Sheets-style icon, drawn inline so we don't pull a remote image
         (faster, works offline, no CORS, no tracking). Trimmed down from the
         official logo silhouette: rounded green page with white grid. */}
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        className="h-5 w-5"
        aria-hidden="true"
      >
        <path
          fill="#0F9D58"
          d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2Z"
        />
        <path fill="#0F9D58" d="M14.5 2v5.5H20" />
        <path fill="#fff" fillOpacity=".15" d="M14.5 2v5.5H20" />
        <path
          fill="#fff"
          d="M8 11h8v8H8v-8Zm1 1v1.7h2.5V12H9Zm3.5 0v1.7H15V12h-2.5ZM9 14.7v1.6h2.5v-1.6H9Zm3.5 0v1.6H15v-1.6h-2.5ZM9 17.3V18h2.5v-.7H9Zm3.5 0V18H15v-.7h-2.5Z"
        />
      </svg>
    </a>
  );
}
