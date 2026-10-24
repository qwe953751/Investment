#!/usr/bin/env python3
"""產生 kline-period-parity.json：週 K／月 K 的 C# 與 JavaScript 一致性基準。

這是獨立於 C#（PeriodKLineCalculator）與 JavaScript（site.js 的 buildKLinePeriodBars）的第三份
參考實作，只用標準函式庫、不碰專案程式。三邊對同一份輸入必須得到同一份答案：

  * C# 測試（PeriodKLineCalculatorTests）：原始行情 → 計算器 → 對 expected。
  * JavaScript 測試（tests/kline-period.test.mjs）：expected 的日 K＋已走完的週期 → 組最後一根 → 對 partialCases。

執行：python3 tests/fixtures/kline-period-parity.generate.py > tests/fixtures/kline-period-parity.json
只有「規則」改了才需要重產；改規則時要同步改 C#、JavaScript 與 PeriodKLineCalculator 的註解。

情境（ticker 9999，2026-02-23 起共 55 個交易日，最後一天 2026-05-12）：
  * 2026-04-03、2026-05-01 休市 → 週五缺一天的短週，其中 03-30 那週橫跨三月與四月。
  * 2026-04-22 除息（前收 100 → 參考價 90，倍率 0.9）落在週中，之前的日子全部乘 0.9。
  * 2026-02-24 只有收盤價（舊資料缺開高低）→ 當週與當月不畫 K 棒，但收盤照算均線。
  * 2026-03-12 開高低收價格關係不可能 → 被擋下，當週不畫，也不進日 K 與均線。
  * 最後一週（05-11、05-12）還沒走完。
"""
import json
import sys
from datetime import date, timedelta
from decimal import Decimal as D, ROUND_HALF_EVEN, getcontext

getcontext().prec = 40

HOLIDAYS = {date(2026, 4, 3), date(2026, 5, 1)}
FIRST, LAST = date(2026, 2, 23), date(2026, 5, 12)
EVENT_DATE, FACTOR = date(2026, 4, 22), D("0.9")
CLOSE_ONLY = {date(2026, 2, 24)}
REJECTED = {date(2026, 3, 12)}
MA_PERIODS = (5, 10, 20, 60, 240)


def q4(value):
    return None if value is None else float(value.quantize(D("0.0001"), rounding=ROUND_HALF_EVEN))


def trading_days():
    day = FIRST
    while day <= LAST:
        if day.weekday() < 5 and day not in HOLIDAYS:
            yield day
        day += timedelta(days=1)


def raw_rows():
    rows, previous_close = [], D("100")
    for index, day in enumerate(trading_days()):
        close = D("100") + D((index * 7) % 13) + D(index % 5) * D("0.25") - D("6")
        open_ = previous_close
        high = max(open_, close) + D("1") + D(index % 4) * D("0.5")
        low = min(open_, close) - D("1") - D(index % 3) * D("0.5")
        row = dict(date=day, open=open_, high=high, low=low, close=close,
                   volume=D(1000 * (10 + (index * 3) % 7)))
        if day in CLOSE_ONLY:
            row.update(open=None, high=None, low=None)
        if day in REJECTED:
            row.update(high=min(open_, close) - D("0.5"))  # 最高價低於開收：不可能
        rows.append(row)
        previous_close = close
    return rows


def state_of(row):
    if row["open"] is None or row["high"] is None or row["low"] is None:
        return "close-only"
    valid = (row["high"] >= row["open"] and row["high"] >= row["close"] and row["high"] >= row["low"]
             and row["low"] <= row["open"] and row["low"] <= row["close"])
    return "bar" if valid else "rejected"


def adjusted(rows):
    result = []
    for row in rows:
        factor = FACTOR if row["date"] < EVENT_DATE else D("1")
        state = state_of(row)
        result.append(dict(
            date=row["date"], state=state, volume=row["volume"], close=row["close"] * factor,
            open=row["open"] * factor if state == "bar" else None,
            high=row["high"] * factor if state == "bar" else None,
            low=row["low"] * factor if state == "bar" else None))
    return result


def moving_averages(closes):
    return {f"ma{n}": (sum(closes[-n:]) / n if len(closes) >= n else None) for n in MA_PERIODS}


def daily_points(rows):
    points, closes, previous = [], [], None
    for row in rows:
        if row["state"] == "rejected":
            continue
        closes.append(row["close"])
        if row["state"] == "bar":
            points.append(dict(date=row["date"].isoformat(), open=q4(row["open"]), high=q4(row["high"]),
                               low=q4(row["low"]), close=q4(row["close"]), previousClose=q4(previous),
                               **{k: q4(v) for k, v in moving_averages(closes).items()},
                               tradingVolume=q4(row["volume"])))
        previous = row["close"]
    return points


def period_start(day, period):
    return day - timedelta(days=day.weekday()) if period == "week" else day.replace(day=1)


def period_points(rows, period):
    groups = {}
    for row in rows:
        groups.setdefault(period_start(row["date"], period), []).append(row)
    points, closes, previous = [], [], None
    for key in sorted(groups):
        group = groups[key]
        usable = [r for r in group if r["state"] != "rejected"]
        if not usable:
            continue
        close = usable[-1]["close"]
        closes.append(close)
        drawable = all(r["state"] == "bar" for r in group)
        points.append(dict(
            date=usable[0]["date"].isoformat(), endDate=usable[-1]["date"].isoformat(),
            open=q4(group[0]["open"]) if drawable else None,
            high=q4(max(r["high"] for r in group)) if drawable else None,
            low=q4(min(r["low"] for r in group)) if drawable else None,
            close=q4(close), previousClose=q4(previous),
            **{k: q4(v) for k, v in moving_averages(closes).items()},
            tradingVolume=q4(sum(r["volume"] for r in usable))))
        previous = close
    return points


def main():
    raw = raw_rows()
    rows = adjusted(raw)
    # 測試用的「看到哪一天」：週中、週五、連假後第一天、跨月第一天、月底、最後一天。
    # 刻意避開有缺開高低／被擋下日子的週期（前端只看得到畫得出來的日 K，無從得知被擋下的日子）。
    cases = ["2026-04-06", "2026-04-08", "2026-04-10", "2026-04-21", "2026-04-22", "2026-04-23",
             "2026-04-30", "2026-05-04", "2026-05-08", "2026-05-11", "2026-05-12"]
    partial = []
    for end in cases:
        truncated = [r for r in rows if r["date"].isoformat() <= end]
        partial.append(dict(
            endDate=end,
            weekly=period_points(truncated, "week")[-1],
            monthly=period_points(truncated, "month")[-1]))
    document = dict(
        description="週 K／月 K 一致性基準。由 kline-period-parity.generate.py 產生，請勿手改。",
        ticker="9999", market="twse", adjustmentThrough=LAST.isoformat(),
        events=[dict(effectiveDate=EVENT_DATE.isoformat(), previousClose=100.0, referencePrice=90.0)],
        rows=[dict(date=r["date"].isoformat(),
                   open=None if r["open"] is None else float(r["open"]),
                   high=None if r["high"] is None else float(r["high"]),
                   low=None if r["low"] is None else float(r["low"]),
                   close=float(r["close"]), volume=float(r["volume"])) for r in raw],
        expected=dict(daily=daily_points(rows), weekly=period_points(rows, "week"),
                      monthly=period_points(rows, "month")),
        partialCases=partial)
    json.dump(document, sys.stdout, ensure_ascii=False, indent=1)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
