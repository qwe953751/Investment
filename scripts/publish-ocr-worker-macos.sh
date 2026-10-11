#!/usr/bin/env bash
# 把 D+ OCR Worker 發布到 macOS 使用者的 Application Support（不受隱私保護），供 LaunchAgent 執行。
#
# 為什麼不直接從 repo 執行：repo 在 ~/Desktop 底下時，launchd 啟動的 bash 沒有權限讀取該資料夾
# （macOS 隱私保護，Operation not permitted、exit code 126）；而且 `dotnet run` 每次重啟都會從
# 當下的工作目錄重新建置，編輯到一半或換 branch 時 Worker 會跟著壞。發布成固定的輸出後，Worker 只依賴
# 這份輸出與 Keychain，行為與 Windows 的自包含 EXE 一致：改了 Worker 程式就必須重新發布才會生效。
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repository_root="$(cd "${script_dir}/.." && pwd)"
install_root="${INVEST_OCR_WORKER_HOME:-${HOME}/Library/Application Support/Invest/ocr-worker}"
app_dir="${install_root}/app"
scripts_dir="${install_root}/scripts"

export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/local/share/dotnet:${PATH}"
dotnet_version="$(dotnet --version)"
if [[ "${dotnet_version}" != 10.* ]]; then
    echo "ocr-worker 只能用 .NET 10；目前是 ${dotnet_version}。" >&2
    exit 4
fi

# 只清掉我們自己建立的 app 子目錄（避免輸出夾帶舊版 DLL）；install_root 與 scripts 不動。
if [[ -z "${app_dir}" || "${app_dir}" != */Invest/ocr-worker/app ]]; then
    echo "拒絕清除非預期的輸出目錄：${app_dir}" >&2
    exit 5
fi
rm -rf "${app_dir}"
mkdir -p "${app_dir}" "${scripts_dir}"

cd "${repository_root}"
dotnet publish src/Invest.Web/Invest.Web.csproj -c Release -o "${app_dir}" --nologo -v q

cp "${script_dir}/run-ocr-worker-macos.sh" "${script_dir}/run-ocr-worker-macos-background.sh" "${scripts_dir}/"
chmod 700 "${scripts_dir}/run-ocr-worker-macos.sh" "${scripts_dir}/run-ocr-worker-macos-background.sh"

commit="$(git -C "${repository_root}" rev-parse --short HEAD 2>/dev/null || echo unknown)"
printf '%s\n' "${commit}" > "${install_root}/PUBLISHED_COMMIT"
printf 'D+ OCR Worker 已發布到 %s（commit %s）\n' "${app_dir}" "${commit}"
