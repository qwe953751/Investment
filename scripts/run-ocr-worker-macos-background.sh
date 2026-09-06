#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
env_file="${OCR_WORKER_ENV_FILE:-${HOME}/.config/invest/ocr-worker.env}"

if [[ -f "${env_file}" ]]; then
    # env file 只能由目前 macOS 使用者讀取；密碼仍由 run-ocr-worker-macos.sh 從 Keychain 取出。
    # shellcheck disable=SC1090
    source "${env_file}"
fi

exec "${script_dir}/run-ocr-worker-macos.sh" "$@"
