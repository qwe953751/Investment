#!/usr/bin/env bash
# 確定今天休市時，讓盤中接力的這一棒留在原地，不要把棒子交給一個只會重新開始收集的下一棒。
#
# 為什麼需要：2026-10-23 颱風假。收集器在 10:00 發現 MIS 的日期一直停在上一個交易日，判定沒開盤、
# 提早收工——但收工的只是「這一棒」。下一棒的 intraday.yml「等到開盤」只看 data 分支的
# market-calendar.json（證交所年度休市日曆，臨時停班不會在裡面），於是 in_session 又是 true，
# 重新開始收集：過了 10:00 只跑 1 輪就收工，「保底停留」補到 3 分鐘，再換下一棒。
# 10:01 到 15:07 重複了 101 棒（平常 9～12 棒），每一棒都白打約 40 個 MIS／證交所／櫃買請求、
# 寫一次 Supabase、開兩個 job。資料沒壞也沒亮鈴鐺，但違背「到 10:00 都沒有就停掉」的決定。
#
# 做法：收集步驟正常結束、而且還沒過 hold_until 時，用 `market-day`（TradingDayResolver：
# 週末 → 證交所日曆 → 10:00 後 MIS 日期仍停在上一個交易日）問一次今天開不開盤。
#   exit 10（確定休市）：留在本棒到 hold_until；每 interval 秒複查一次，MIS 出現今天的日期
#                        （exit 0）就提早結束、把棒子交給會收集的下一棒。
#   其他（0 開盤、20 不確定、程式出錯）：不留，照常交棒——跟改之前完全一樣。
# 不用收集器的結束結果當訊號：興櫃尾段讀不到 CDN 與「今天沒有快照」都回同一個結果，分不出來。
#
# 複查同時是安全閥：就算 market-day 在交易日偶發誤判成休市，最多讓尾段晚 10 分鐘開始，
# 不會漏收，也不會擋住整天。
#
# 這支腳本永遠 exit 0（用法錯誤除外）：它只是「要不要多留一會兒」，任何環節出錯都退回照常交棒，
# 不能讓一棒因此轉紅。時間只用可攜的 date +%s 與 sleep，本機（macOS）的測試才跑得動。
#
# 用法：scripts/intraday-closed-hold.sh <hold_until_epoch> [check_interval_seconds，預設 600]
set -uo pipefail

hold_until=${1:-}
interval=${2:-600}

case "$hold_until" in
    '' | *[!0-9]*)
        echo "用法：intraday-closed-hold.sh <hold_until_epoch> [check_interval_seconds]" >&2
        exit 2
        ;;
esac

case "$interval" in
    *[!0-9]* | 0)
        echo "check_interval_seconds 必須是正整數。" >&2
        exit 2
        ;;
esac

clock() {
    # GNU date 用 -d，BSD date（macOS）用 -r。
    date -d "@$1" +%H:%M 2>/dev/null || date -r "$1" +%H:%M
}

market_day() {
    dotnet run -c Release --project src/Invest.Web -- market-day
}

if [ "$(date +%s)" -ge "$hold_until" ]; then
    echo "今天的收集時段已過，不必留在本棒。"
    exit 0
fi

market_day
code=$?
if [ "$code" -ne 10 ]; then
    echo "今天不是確定休市（market-day exit ${code}），照常交棒。"
    exit 0
fi

if [ $(( interval % 60 )) -eq 0 ]; then every="$(( interval / 60 )) 分鐘"; else every="$interval 秒"; fi
echo "今天確定休市，留在本棒到 $(clock "$hold_until")，不讓下一棒重開收集；每 ${every}複查一次。"

while :; do
    now=$(date +%s)
    [ "$now" -lt "$hold_until" ] || break

    nap=$(( hold_until - now ))
    [ "$nap" -gt "$interval" ] && nap=$interval
    sleep "$nap"

    [ "$(date +%s)" -lt "$hold_until" ] || break

    market_day
    code=$?
    if [ "$code" -eq 0 ]; then
        echo "MIS 已出現今天的成交日期，結束等待，交給下一棒收集。"
        exit 0
    fi
    echo "$(clock "$(date +%s)") 複查：market-day exit ${code}，繼續留在本棒。"
done

echo "今天的收集時段結束，交棒。"
exit 0
