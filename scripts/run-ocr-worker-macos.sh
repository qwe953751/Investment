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

# launchd（LaunchAgent）啟動時的 PATH 只有 /usr/bin:/bin:/usr/sbin:/sbin，找不到 Homebrew 或官方安裝的 dotnet；
# 補上常見安裝位置（互動式終端機本來就有，重複加入無害）。
export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/local/share/dotnet:${PATH}"

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
    else
        OCR_CODEX_PATH="codex"
        # ChatGPT App 內建的 Codex：新版放在 codex-cli/bin/codex，舊版是 Resources/codex。
        for candidate in \
            "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex" \
            "/Applications/ChatGPT.app/Contents/Resources/codex"; do
            if [[ -f "${candidate}" && -x "${candidate}" ]]; then
                OCR_CODEX_PATH="${candidate}"
                break
            fi
        done
    fi
fi
export OCR_CODEX_PATH

printf 'Codex CLI 路徑：%s\n' "${OCR_CODEX_PATH}"
printf 'Max reasoning effort：%s\n' "${OCR_MAX_REASONING_EFFORT}"

# INVEST_OCR_WORKER_APP_DIR 有值＝LaunchAgent 執行已發布的輸出（見 publish-ocr-worker-macos.sh）；
# 沒有值＝在終端機從原始碼執行（開發與單輪診斷用）。
if [[ -n "${INVEST_OCR_WORKER_APP_DIR:-}" ]]; then
    printf 'Worker 發布版本：%s\n' "$(cat "$(dirname "${INVEST_OCR_WORKER_APP_DIR}")/PUBLISHED_COMMIT" 2>/dev/null || echo unknown)"
    cd "${INVEST_OCR_WORKER_APP_DIR}"
    exec dotnet "${INVEST_OCR_WORKER_APP_DIR}/Invest.Web.dll" ocr-worker "$@"
fi

cd "${repository_root}"
exec dotnet run --project src/Invest.Web -c Release -- ocr-worker "$@"
