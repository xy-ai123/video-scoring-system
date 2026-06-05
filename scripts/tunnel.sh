#!/usr/bin/env bash
# scripts/tunnel.sh
# -----------------
# Self-healing Cloudflare tunnel supervisor.
#
# Cloudflare "quick tunnels" (cloudflared tunnel --url) come with no
# uptime guarantee — the edge URL silently expires every few hours,
# leaving cloudflared running but unreachable. Bookmarks go stale.
#
# This script wraps cloudflared in a supervisor loop:
#   1. start cloudflared in the background
#   2. sniff the trycloudflare URL from its stdout
#   3. write it to .tunnel-url and rewrite dashboard.html (so the
#      Desktop bookmark always redirects to the live URL)
#   4. poll the URL every $HEALTH_INTERVAL seconds
#   5. if the URL stops responding (curl returns 000 / non-2xx for
#      $HEALTH_FAIL_THRESHOLD consecutive checks), kill cloudflared
#      and go back to step 1
#
# Net effect: as long as `tunnel.sh` is running, the local
# `dashboard.html` bookmark is always live.
#
# Usage:
#   ./scripts/tunnel.sh          # tunnel port 3000 (Dashboard 1)
#   ./scripts/tunnel.sh 3001     # tunnel port 3001 (Dashboard 2)
#   Ctrl-C at any time to stop the supervisor + tunnel.
#
# First-time setup: brew install cloudflared

set -e

PORT="${1:-3000}"
TARGET="http://localhost:${PORT}"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
URL_FILE="$ROOT/.tunnel-url"
REDIRECT_FILE="$ROOT/dashboard.html"
# macOS Internet Location file on the user's Desktop. Double-clicking it
# opens `dashboard.html` in Safari, which redirects to the live tunnel
# URL. We recreate it every startup so an accidental Desktop cleanup
# can't break the bookmark forever.
DESKTOP_SHORTCUT="$HOME/Desktop/VideoScoring Dashboard.webloc"
# Second .webloc that points DIRECTLY at the current tunnel URL (not at
# the local HTML redirect). Rewritten on every URL rotation so a
# Safari bookmark dragged off this file always opens the live URL.
# Sits next to the redirect-style one above so the user can pick
# whichever flow feels more natural.
DESKTOP_LIVE_SHORTCUT="$HOME/Desktop/VideoScoring (live URL).webloc"
# Mirror of URL_FILE under XDG-ish cache dir, so any script anywhere on
# the machine can read the current tunnel URL with:
#     cat ~/.cache/vss-tunnel-url
# Without needing to know where the project is checked out. Useful for
# helper scripts that don't have $ROOT (e.g. ad-hoc shortcuts, Raycast
# snippets, cron jobs).
CACHE_URL_FILE="$HOME/.cache/vss-tunnel-url"

# How often to check the URL. 30 s + threshold 3 = a dead URL is
# caught in ~90s, which is still snappy but lenient enough that a
# slow dev-server HMR rebuild (Next.js compiles taking >15s after a
# code change) doesn't trick the supervisor into killing a healthy
# tunnel. Earlier this was 15s/2 = 30s tolerance, which thrashed
# every URL inside a minute whenever the dev server was busy.
HEALTH_INTERVAL=30
HEALTH_FAIL_THRESHOLD=3
# Per-probe curl timeout. The previous 10s was tighter than the
# Next.js cold-start time on /admin after a code change (~15-20s),
# which made the supervisor mark a perfectly-good tunnel as dead.
# 30s comfortably covers cold starts + a bit of jitter.
HEALTH_CURL_TIMEOUT=30

# When the tunnel URL rotates (cloudflared restarts → new edge URL),
# pop the local dashboard.html file open in the user's default browser.
# Safari then meta-refreshes to the live URL automatically. End result:
# the operator never sees a stale "Cloudflare Error 1033" because the
# moment the URL changes, a fresh tab appears with the working one.
# Set ROTATE_AUTO_OPEN=0 in the environment to disable (e.g. headless).
ROTATE_AUTO_OPEN="${ROTATE_AUTO_OPEN:-1}"

# Minimum seconds between two auto-opens. Even with the lenient
# health check above, a real outage could rotate URLs multiple times
# in quick succession — and we don't want Safari piling up tabs of
# dead URLs. 300s (5 min) is generous enough that the user always
# sees a fresh tab when something legitimately changed, without
# spamming tabs during a transient cloudflared restart storm.
AUTO_OPEN_COOLDOWN_SEC="${AUTO_OPEN_COOLDOWN_SEC:-300}"
LAST_AUTO_OPEN_EPOCH=0

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "cloudflared is not installed. Install with: brew install cloudflared" >&2
  exit 1
fi
if ! lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Nothing is listening on port ${PORT}." >&2
  echo "Start the dev server first: pnpm dev:web (or pnpm dev:web-algo)" >&2
  exit 1
fi

write_desktop_shortcut() {
  # .webloc points at the dashboard.html file:// URL, which itself
  # redirects to whatever the current tunnel URL is. So this shortcut
  # never needs updating — only created if missing. URL-encodes spaces
  # in the absolute project path (Application Support has them).
  if [ -f "$DESKTOP_SHORTCUT" ]; then return 0; fi
  local encoded="${ROOT// /%20}"
  cat > "$DESKTOP_SHORTCUT" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>URL</key>
  <string>file://${encoded}/dashboard.html</string>
</dict>
</plist>
PLIST
  echo "[supervisor] (re)created Desktop shortcut at $DESKTOP_SHORTCUT"
}

write_live_shortcut() {
  # Direct-URL .webloc — rewritten on every tunnel rotation. Double-
  # clicking it opens https://<current>.trycloudflare.com/admin/clipping
  # straight in Safari, no intermediate file:// redirect. The bookmark
  # is "live" because this file's contents change in lockstep with the
  # cloudflared URL, so any Safari Favourites entry derived from it
  # keeps resolving to the current tunnel.
  #
  # Why also keep the redirect-style "VideoScoring Dashboard.webloc"?
  # Because if Safari has cached an OLD copy of THIS direct .webloc
  # (rare but possible — Safari sometimes snapshots Favourites), the
  # redirect-style one is a guaranteed always-fresh fallback. Two
  # bookmarks, two failure modes covered.
  local target="$1"
  cat > "$DESKTOP_LIVE_SHORTCUT" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>URL</key>
  <string>${target}/admin/clipping</string>
</dict>
</plist>
PLIST
}

write_redirect() {
  # Atomic-write the local HTML redirect so the Desktop bookmark always
  # opens the current tunnel URL. Anyone bookmarking the .trycloudflare
  # URL itself will eventually go stale; this file does not.
  local target="$1"
  cat > "$REDIRECT_FILE" <<HTML
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Video Scoring Dashboard</title>
  <meta http-equiv="refresh" content="0; url=${target}/admin/clipping">
  <style>body{font-family:system-ui,sans-serif;padding:2rem;line-height:1.5;color:#0f172a}a{color:#2563eb}code{background:#f1f5f9;padding:2px 6px;border-radius:4px;font-size:13px}.small{color:#64748b;font-size:13px;margin-top:1rem}</style>
</head>
<body>
  <h2>Opening dashboard…</h2>
  <p>If you're not redirected automatically, click here:</p>
  <p><a href="${target}/admin/clipping"><strong>${target}/admin/clipping</strong></a></p>
  <p class="small">Bookmark THIS local file (not the trycloudflare URL). The cloud URL rotates whenever the supervisor restarts a dead tunnel.</p>
  <p class="small">Current URL: <code>${target}</code></p>
</body>
</html>
HTML
}

# Holds the PID of the most recently spawned cloudflared. Used by
# health-check + EXIT trap to kill cleanly.
CF_PID=""

cleanup() {
  if [ -n "$CF_PID" ] && kill -0 "$CF_PID" 2>/dev/null; then
    kill "$CF_PID" 2>/dev/null || true
    wait "$CF_PID" 2>/dev/null || true
  fi
  rm -f "$URL_FILE" "$REDIRECT_FILE" "$CACHE_URL_FILE"
  # Note: we intentionally leave both .webloc shortcuts on the Desktop.
  # They hold the last-known URL; the user might still want to glance
  # at it after Ctrl-C. (URL_FILE / CACHE_URL_FILE removal signals
  # "supervisor not running" to any script polling them.)
  echo
  echo "Tunnel supervisor stopped. Bye."
}
trap cleanup EXIT INT TERM

notify_rotation() {
  # Best-effort macOS notification when the URL rotates. Falls back to
  # a no-op if osascript isn't available (Linux, or sandboxed shells).
  local new_url="$1"
  if command -v osascript >/dev/null 2>&1; then
    osascript -e "display notification \"New tunnel URL is live. Opening dashboard…\" with title \"VideoScoring Dashboard\" subtitle \"${new_url}\"" 2>/dev/null || true
  fi
}

auto_open_dashboard() {
  # Pop the local dashboard.html (which meta-refreshes to the live URL)
  # in the user's default browser. macOS `open` handles file:// URLs
  # cleanly; Linux falls back to xdg-open if present. No-op otherwise.
  if [ "$ROTATE_AUTO_OPEN" != "1" ]; then return 0; fi

  # Rate-limit: if we just opened a tab within the last
  # AUTO_OPEN_COOLDOWN_SEC, skip this open. Prevents Safari from being
  # buried in dead-URL tabs during a rotation storm (transient
  # cloudflared restart, ISP blip, or a regression in health-check
  # tuning). dashboard.html still gets rewritten every rotation, so
  # any tab the user manually refreshes still resolves to the live URL.
  local now
  now=$(date +%s)
  local since_last=$(( now - LAST_AUTO_OPEN_EPOCH ))
  if [ "$LAST_AUTO_OPEN_EPOCH" -gt 0 ] && [ "$since_last" -lt "$AUTO_OPEN_COOLDOWN_SEC" ]; then
    echo "[supervisor] skipping auto-open (last open ${since_last}s ago, cooldown ${AUTO_OPEN_COOLDOWN_SEC}s)"
    return 0
  fi
  LAST_AUTO_OPEN_EPOCH=$now

  if command -v open >/dev/null 2>&1; then
    open "$REDIRECT_FILE" >/dev/null 2>&1 || true
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$REDIRECT_FILE" >/dev/null 2>&1 || true
  fi
}

# Tracks the prior tunnel URL across restarts within this supervisor's
# lifetime. Empty on cold start so the FIRST tunnel launch doesn't
# trigger the auto-open (the user explicitly ran `./tunnel.sh` and
# doesn't want a surprise Safari window). Set after the first launch.
PREV_URL=""

start_tunnel() {
  # Spawn cloudflared, sniff its stdout for the trycloudflare URL,
  # write the redirect file as soon as we see it. The cloudflared
  # process is left running in the background; CF_PID tracks it.
  local log
  log="$(mktemp -t cf.XXXXX.log)"
  # Pass --config /dev/null so cloudflared does NOT auto-load
  # ~/.cloudflared/config.yml. Without this guard, if a named-tunnel
  # config.yml is present (e.g. left over from Phase B of the is-a.dev
  # migration), its `ingress:` rules can apply to the quick tunnel too,
  # routing every request to the catch-all 404 because the dynamic
  # `*.trycloudflare.com` hostname doesn't match any explicit rule.
  # This burned us once — keep the flag so it can't happen again.
  cloudflared --config /dev/null tunnel --url "$TARGET" >"$log" 2>&1 &
  CF_PID=$!
  echo
  echo "[supervisor] started cloudflared pid=$CF_PID (log $log)"
  # Wait up to 15 s for the URL to appear in the log. cloudflared
  # normally prints its trycloudflare URL within 2-5 s of starting;
  # anything longer than 15 s means it's hung on DNS, the edge is
  # unreachable, or the binary is broken. Killing + respawning gets
  # us productive faster than the old 30 s wait. (If the user's
  # network is genuinely that slow, the next spawn will hit the same
  # wall — they'll see repeated "no URL appeared" messages.)
  local url=""
  for _ in $(seq 1 15); do
    sleep 1
    if [ ! -d "/proc/$CF_PID" ] && ! kill -0 "$CF_PID" 2>/dev/null; then
      echo "[supervisor] cloudflared died before printing a URL (see $log)" >&2
      return 1
    fi
    url=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$log" | head -1 || true)
    if [ -n "$url" ]; then break; fi
  done
  if [ -z "$url" ]; then
    echo "[supervisor] no URL appeared in 15 s — killing cloudflared" >&2
    kill "$CF_PID" 2>/dev/null || true
    return 1
  fi
  echo "$url" > "$URL_FILE"
  # Mirror to ~/.cache/vss-tunnel-url so any helper script on the
  # machine can `cat` the current URL without knowing $ROOT. mkdir -p
  # is idempotent + cheap; safe to call on every rotation.
  mkdir -p "$(dirname "$CACHE_URL_FILE")" 2>/dev/null || true
  echo "$url" > "$CACHE_URL_FILE"
  write_redirect "$url"
  write_desktop_shortcut
  # Rewrite the direct-URL .webloc on every rotation (NOT just when
  # missing) so any Safari Favourites entry derived from it always
  # opens the current tunnel URL.
  write_live_shortcut "$url"

  # Detect a rotation: PREV_URL is non-empty (this isn't the first
  # tunnel launch) AND the new URL differs from the prior one. On
  # rotation we both (a) toast a notification and (b) open the local
  # dashboard.html, which the browser will refresh to the live URL —
  # so the operator never gets stuck staring at a stale tunnel-URL
  # bookmark.
  if [ -n "$PREV_URL" ] && [ "$PREV_URL" != "$url" ]; then
    echo "[supervisor] rotated $PREV_URL -> $url (auto-opening dashboard)"
    notify_rotation "$url"
    auto_open_dashboard
  fi
  PREV_URL="$url"

  echo
  echo "════════════════════════════════════════════════════════════"
  echo "  Public URL:      $url"
  echo "  Dashboard:       $url/admin/clipping"
  echo "  Stable bookmark: file://$REDIRECT_FILE"
  echo "  Desktop icon:    $DESKTOP_SHORTCUT"
  echo "  Live-URL icon:   $DESKTOP_LIVE_SHORTCUT"
  echo "  URL cache file:  $CACHE_URL_FILE  ($(cat "$CACHE_URL_FILE" 2>/dev/null))"
  echo "════════════════════════════════════════════════════════════"
  echo
  return 0
}

check_url_alive() {
  # Returns 0 if URL responds with anything < 500 within 10 s,
  # 1 otherwise. Quick tunnels return 307 at root (redirect to login),
  # which we count as alive.
  local url
  url="$(cat "$URL_FILE" 2>/dev/null)"
  if [ -z "$url" ]; then return 1; fi
  local code
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time "$HEALTH_CURL_TIMEOUT" "$url/" 2>/dev/null || echo "000")
  case "$code" in
    2*|3*|4*) return 0 ;;
    *) return 1 ;;
  esac
}

# ===== Supervisor main loop ==============================================
while true; do
  if ! start_tunnel; then
    # Was 10 s. Dropped to 3 s so a transient cloudflared startup
    # failure (DNS hiccup, ISP blip) doesn't add multi-second dead
    # time on top of the inevitable health-check tolerance window.
    # Worst case: 3 s wasted per real outage — barely measurable.
    echo "[supervisor] tunnel start failed, retrying in 3 s ..."
    sleep 3
    continue
  fi
  fails=0
  while true; do
    sleep "$HEALTH_INTERVAL"
    # Did cloudflared die outright?
    if ! kill -0 "$CF_PID" 2>/dev/null; then
      echo "[supervisor] cloudflared process exited — restarting"
      break
    fi
    if check_url_alive; then
      fails=0
    else
      fails=$((fails + 1))
      echo "[supervisor] health check failed (${fails}/${HEALTH_FAIL_THRESHOLD})"
      if [ "$fails" -ge "$HEALTH_FAIL_THRESHOLD" ]; then
        echo "[supervisor] URL appears dead — killing cloudflared and respawning"
        kill "$CF_PID" 2>/dev/null || true
        wait "$CF_PID" 2>/dev/null || true
        break
      fi
    fi
  done
done
