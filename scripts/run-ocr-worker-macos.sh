#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repository_root="$(cd "${script_dir}/.." && pwd)"
worker_email="${OCR_WORKER_EMAIL:-ocr-worker@investment.local}"

if ! command -v security >/dev/null 2>&1; then
    echo '找不到 macOS Keychain 的 security 指令。' >&2
    exit 2
fi

worker_password="$(security find-generic-password -w -a "${worker_email}" -s 'invest-ocr-worker')"
if [[ -z "${worker_password}" ]]; then
    echo 'Keychain 找不到 invest-ocr-worker 密碼。' >&2
    exit 3
fi

dotnet_version="$(dotnet --version)"
if [[ "${dotnet_version}" != 10.* ]]; then
    echo "ocr-worker 只能用 .NET 10；目前是 ${dotnet_version}。" >&2
    exit 4
fi

export OCR_WORKER_EMAIL="${worker_email}"
export OCR_WORKER_PASSWORD="${worker_password}"
export OCR_AGENT_PRIMARY="${OCR_AGENT_PRIMARY:-codex}"
export OCR_MAX_REASONING_EFFORT="${OCR_MAX_REASONING_EFFORT:-max}"

if [[ -z "${OCR_CODEX_PATH:-}" ]]; then
    if command -v codex >/dev/null 2>&1; then
        OCR_CODEX_PATH="$(command -v codex)"
    elif [[ -x "/Applications/ChatGPT.app/Contents/Resources/codex" ]]; then
        OCR_CODEX_PATH="/Applications/ChatGPT.app/Contents/Resources/codex"
    else
        OCR_CODEX_PATH="codex"
    fi
fi
export OCR_CODEX_PATH

printf 'Codex CLI 路徑：%s\n' "${OCR_CODEX_PATH}"
printf 'Max reasoning effort：%s\n' "${OCR_MAX_REASONING_EFFORT}"

cd "${repository_root}"
exec dotnet run --project src/Invest.Web -c Release -- ocr-worker "$@"
