#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
label="com.invest.ocr-worker"
plist_dir="${HOME}/Library/LaunchAgents"
plist_path="${plist_dir}/${label}.plist"
log_dir="${HOME}/Library/Logs/Invest"
install_root="${INVEST_OCR_WORKER_HOME:-${HOME}/Library/Application Support/Invest/ocr-worker}"
uid_value="$(id -u)"

mkdir -p "${plist_dir}" "${log_dir}"
# 先停掉執行中的 Worker：發布會覆寫它正在使用的檔案。
launchctl bootout "gui/${uid_value}" "${plist_path}" >/dev/null 2>&1 || true

INVEST_OCR_WORKER_HOME="${install_root}" "${script_dir}/publish-ocr-worker-macos.sh"

python3 - "${plist_path}" "${install_root}/scripts/run-ocr-worker-macos-background.sh" "${install_root}/app" "${log_dir}" <<'PY'
import plistlib
import sys

plist_path, launcher, app_dir, log_dir = sys.argv[1:]
payload = {
    "Label": "com.invest.ocr-worker",
    "ProgramArguments": [launcher],
    # 工作目錄與腳本都放在 Application Support：launchd 啟動的程序讀不到 ~/Desktop 底下的 repo。
    "WorkingDirectory": app_dir,
    "EnvironmentVariables": {"INVEST_OCR_WORKER_APP_DIR": app_dir},
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
printf '已安裝並啟動 %s；狀態：launchctl print gui/%s/%s；log：%s/ocr-worker.log\n' "${label}" "${uid_value}" "${label}" "${log_dir}"
printf '驗收：log 的啟動訊息要含「在線詢問：指名回應」與「Worker 發布版本」，不是只看 launchctl 的 running。\n'
