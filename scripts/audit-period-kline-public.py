#!/usr/bin/env python3
"""Audit every claimed complete Taiwan weekly/monthly chart on the public site."""

import argparse
import concurrent.futures
import json
import urllib.request
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path


def get_json(base, path, timeout=30):
    with urllib.request.urlopen(base.rstrip("/") + "/" + path, timeout=timeout) as response:
        return json.load(response)


def inspect_chart(ticker, data):
    if data.get("schemaVersion") != 2:
        return "圖表不是週／月 K schemaVersion 2"
    fields = data.get("periodFields", [])
    for period in ("weekly", "monthly"):
        bars = data.get(period)
        if not isinstance(bars, list) or not bars:
            return f"{period} 沒有週期棒"
        try:
            decoded = [dict(zip(fields, bar, strict=True)) for bar in bars]
        except (TypeError, ValueError):
            return f"{period} 欄位與資料長度不符"
        full = [bar for bar in decoded if all(bar.get(key) is not None for key in ("open", "high", "low", "close"))]
        if len(full) < 60:
            return f"{period} 只有 {len(full)} 根完整棒"
        if any(full[i]["date"] >= full[i + 1]["date"] for i in range(len(full) - 1)):
            return f"{period} 日期不是遞增"
        if decoded[-1].get("ma60") is None:
            return f"{period} 最新 MA60 缺失"
    return None


def audit(args):
    queue = json.loads((Path(args.data_dir) / "imports-periods-status/queue.json").read_text(encoding="utf-8"))
    if queue.get("schemaVersion") != 1:
        raise ValueError("週月回補佇列版本不相容")
    manifest = get_json(args.site, "manifest.json")
    entries = queue["tickers"]
    listed = sorted(t for t, record in entries.items()
                    if record.get("market") in ("Twse", "Tpex") and record.get("status") != "archive_only")
    rows = []

    def check(ticker):
        try:
            data = get_json(args.site, f"data/kline/{ticker}.json")
            issue = inspect_chart(ticker, data)
        except Exception as error:
            issue = f"圖表無法取得或解析：{type(error).__name__}: {error}"
        return {"ticker": ticker, "queueStatus": entries[ticker].get("status"),
                "status": "pass" if issue is None else "fail", "reason": issue}

    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
        rows = list(pool.map(check, listed))
    failed = [row for row in rows if row["status"] == "fail"]
    other = [{"ticker": t, "status": r.get("status", "unknown"), "reason": r.get("reason")}
             for t, r in sorted(entries.items()) if r.get("status") != "complete"]
    counts = dict(Counter(r.get("status", "unknown") for r in entries.values()))
    latest = manifest.get("latestTradingDate", "").replace("/", "-")
    expected = queue.get("lastRun", {}).get("through")
    publication_lag = expected is not None and latest != expected
    report = {"checkedAt": datetime.now(timezone.utc).isoformat(), "site": args.site,
              "manifestVersion": manifest.get("version"), "latestTradingDate": latest,
              "queueTradingDate": expected, "publicationLag": publication_lag,
              "statusCounts": counts, "listedChecked": len(listed), "archiveOnly": counts.get("archive_only", 0),
              "publicPassed": len(listed) - len(failed),
              "publicFailures": failed, "remainingOrExceptions": other, "rows": rows}
    Path(args.output).write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({key: report[key] for key in ("manifestVersion", "latestTradingDate", "queueTradingDate",
          "publicationLag", "statusCounts", "listedChecked", "publicPassed")}, ensure_ascii=False))
    print(f"逐檔報告：{args.output}")
    if failed or publication_lag or any(counts.get(status, 0) for status in
            ("pending", "interrupted", "temporary_failure", "source_rejected")):
        raise SystemExit(1)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-dir", required=True)
    parser.add_argument("--site", default="https://frank-invest.github.io")
    parser.add_argument("--output", required=True)
    parser.add_argument("--workers", type=int, default=8)
    args = parser.parse_args()
    if not 1 <= args.workers <= 16:
        parser.error("workers 須為 1～16")
    audit(args)


if __name__ == "__main__":
    main()
