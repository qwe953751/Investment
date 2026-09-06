#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repository_root="$(cd "${script_dir}/.." && pwd)"
label="com.invest.ocr-worker"
plist_dir="${HOME}/Library/LaunchAgents"
plist_path="${plist_dir}/${label}.plist"
log_dir="${HOME}/Library/Logs/Invest"
uid_value="$(id -u)"

mkdir -p "${plist_dir}" "${log_dir}"
launchctl bootout "gui/${uid_value}" "${plist_path}" >/dev/null 2>&1 || true

python3 - "${plist_path}" "${repository_root}/scripts/run-ocr-worker-macos-background.sh" "${log_dir}" <<'PY'
import plistlib
import sys

plist_path, launcher, log_dir = sys.argv[1:]
payload = {
    "Label": "com.invest.ocr-worker",
    "ProgramArguments": [launcher],
    "WorkingDirectory": launcher.rsplit("/scripts/", 1)[0],
    "RunAtLoad": True,
    "KeepAlive": {"SuccessfulExit": False, "NetworkState": True},
    "ProcessType": "Background",
    "ThrottleInterval": 30,
    "StandardOutPath": f"{log_dir}/ocr-worker.log",
    "StandardErrorPath": f"{log_dir}/ocr-worker.error.log",
}
with open(plist_path, "wb") as stream:
    plistlib.dump(payload, stream, sort_keys=False)
PY

chmod 600 "${plist_path}"
launchctl bootstrap "gui/${uid_value}" "${plist_path}"
launchctl kickstart -k "gui/${uid_value}/${label}"
printf '已安裝並啟動 %s；狀態：launchctl print gui/%s/%s\n' "${label}" "${uid_value}" "${label}"
