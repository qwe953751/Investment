#!/usr/bin/env bash
set -euo pipefail

label="com.invest.ocr-worker"
plist_path="${HOME}/Library/LaunchAgents/${label}.plist"
uid_value="$(id -u)"

launchctl bootout "gui/${uid_value}" "${plist_path}" >/dev/null 2>&1 || true
rm -f "${plist_path}"
printf '已移除 %s LaunchAgent；不會刪除 Worker log 或 Keychain 密碼。\n' "${label}"
