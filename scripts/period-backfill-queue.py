#!/usr/bin/env python3
"""Plan and record bounded, resumable Taiwan weekly/monthly history batches.

The state lives on the data branch. Only the C# backfiller creates price bars;
this script schedules tickers and records its verified outcomes.
"""

import argparse
import calendar
import collections
import datetime as dt
import json
import re
from pathlib import Path

STATE_PATH = Path("imports-periods-status/queue.json")
COMPLETE = re.compile(r"(?:^|\n)([0-9A-Za-z]+) 完成：週 (\d+)／月 (\d+)")
REUSED = re.compile(r"(?:^|\n)([0-9A-Za-z]+) 已有本輪合格摘要，略過。")
FAILED = re.compile(r"(?:^|\n)([0-9A-Za-z]+) 未更新，保留原摘要：([^\n]+)")
TRANSIENT = ("timed out", "timeout", "502", "503", "429", "temporar", "name resolution", "connection", "request was canceled", "官方月摘要不可用")


def now():
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0)


def read_json(path):
    with path.open(encoding="utf-8") as stream:
        return json.load(stream)


def atomic_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".writing")
    temporary.write_text(json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    temporary.replace(path)


def state_at(data_dir):
    path = data_dir / STATE_PATH
    state = read_json(path) if path.exists() else {"schemaVersion": 1, "runs": 0, "tickers": {}}
    if state.get("schemaVersion") != 1 or not isinstance(state.get("tickers"), dict):
        raise ValueError("週月回補佇列版本不相容")
    return state


def universe(data_dir):
    files = sorted((data_dir / "imports").glob("????-??-??.json"))
    if not files:
        raise ValueError("data/imports 沒有正式行情，不能規劃回補")
    stocks = {}
    last_seen = {}
    trading_days = []
    for file in files:
        snapshot = read_json(file)
        if not snapshot.get("isTradingDay"):
            continue
        trading_days.append(file.stem)
        for quote in snapshot.get("quotes", []):
            ticker = quote.get("ticker")
            market = quote.get("market")
            if isinstance(ticker, str) and ticker.isascii() and ticker.isalnum() and market in ("Twse", "Tpex", "Emerging"):
                stocks[ticker] = market
                last_seen[ticker] = file.stem
    if not trading_days:
        raise ValueError("data/imports 沒有交易日，不能規劃回補")
    # StaticSiteExporter: RankingDates.Selectable(last 120).First().AddMonths(-3).
    first = dt.date.fromisoformat(trading_days[-120] if len(trading_days) >= 120 else trading_days[0])
    month_index = first.year * 12 + first.month - 1 - 3
    year, month_zero = divmod(month_index, 12)
    month = month_zero + 1
    chart_from = dt.date(year, month, min(first.day, calendar.monthrange(year, month)[1])).isoformat()
    return stocks, trading_days[-1], last_seen, chart_from


def coverage(data_dir, ticker):
    path = data_dir / "imports-periods" / (ticker + ".json")
    if not path.exists():
        return None
    try:
        source = read_json(path)
        if source.get("ticker") != ticker or source.get("schemaVersion") != 1:
            return None
        counts = {}
        for period in ("weekly", "monthly"):
            counts[period] = sum(
                bar.get("open") is not None and bar.get("high") is not None
                and bar.get("low") is not None and bar.get("close") is not None
                for bar in source.get(period, []))
        counts["initialBoundaryChecked"] = "initial-period first-day check" in source.get("validation", "")
        return counts
    except (ValueError, OSError, TypeError):
        return None


def classify_error(message):
    return "temporary_failure" if any(token in message.lower() for token in TRANSIENT) else "source_rejected"


def eligible(record, today, through, retry_rejected):
    status = record.get("status", "pending")
    if status == "pending":
        return True
    if status in ("temporary_failure", "interrupted"):
        if record.get("through") != through:
            return True
        return int(record.get("attempts", 0)) < 3 and today >= record.get("retryAt", "")
    if status == "source_rejected":
        return retry_rejected
    if status == "short_history":
        return record.get("through") != through
    return False


def plan(args):
    data_dir = Path(args.data_dir)
    stocks, through, last_seen, chart_from = universe(data_dir)
    state = state_at(data_dir)
    selected = []
    specified = args.tickers.split() if args.tickers else []
    if specified and any(t not in stocks or stocks[t] == "Emerging" for t in specified):
        raise ValueError("指定代號不在正式上市櫃名冊中")
    if len(specified) != len(set(specified)):
        raise ValueError("指定代號重複")
    if specified:
        candidates = specified
        known_bars = {}
    else:
        known_bars = {t: coverage(data_dir, t) for t, market in stocks.items()
                      if market != "Emerging" and last_seen[t] >= chart_from}
        # First initialize missing stocks; older valid files that still need a longer window follow.
        candidates = sorted(known_bars, key=lambda t: (known_bars[t] is not None, t))
    instant = now().isoformat()
    for ticker in candidates:
        if len(selected) >= args.limit:
            break
        bars = coverage(data_dir, ticker) if specified else known_bars[ticker]
        record = state["tickers"].get(ticker, {})
        revived = record.get("status") == "archive_only" and last_seen[ticker] >= chart_from
        if revived:
            record = {}
        if not specified and not revived and bars and bars["weekly"] >= 60 and bars["monthly"] >= 60 and bars["initialBoundaryChecked"]:
            continue
        if bars is None and record.get("status") in ("complete", "short_history"):
            record = {}
        if bars and not bars["initialBoundaryChecked"] and record.get("status") == "complete":
            record = {}
        if not specified and not eligible(record, instant, through, args.retry_rejected):
            continue
        selected.append(ticker)
    result = {"schemaVersion": 1, "through": through, "tickers": selected, "batchSize": args.limit,
              "candidateCount": len(known_bars) if not specified else sum(
                  market != "Emerging" and last_seen[t] >= chart_from for t, market in stocks.items()),
              "excludedEmerging": sum(market == "Emerging" for market in stocks.values()),
              "archiveOnly": sum(market != "Emerging" and last_seen[t] < chart_from
                                 for t, market in stocks.items())}
    atomic_json(Path(args.output), result)
    print(json.dumps(result, ensure_ascii=False))


def finish(args):
    data_dir = Path(args.data_dir)
    plan_data = read_json(Path(args.plan))
    log = Path(args.log).read_text(encoding="utf-8", errors="replace") if Path(args.log).exists() else ""
    state = state_at(data_dir)
    when = now()
    done = {m.group(1) for m in COMPLETE.finditer(log)}
    reused = {m.group(1) for m in REUSED.finditer(log)}
    failures = {m.group(1): m.group(2).strip() for m in FAILED.finditer(log)}
    attempted = 0
    for ticker in plan_data["tickers"]:
        if ticker not in done and ticker not in reused and ticker not in failures:
            continue
        attempted += 1
        previous = state["tickers"].get(ticker, {})
        attempts = int(previous.get("attempts", 0)) + 1 if previous.get("through") == plan_data["through"] else 1
        record = {"through": plan_data["through"], "checkedAt": when.isoformat(), "attempts": attempts}
        if ticker in failures:
            message = failures[ticker]
            record["status"] = classify_error(message)
            record["reason"] = message[:500]
            if record["status"] == "temporary_failure":
                record["retryAt"] = (when + dt.timedelta(minutes=30)).isoformat()
        else:
            bars = coverage(data_dir, ticker)
            if bars is None:
                record["status"] = "interrupted"
                record["reason"] = "回補回報成功，但未保存可核對的摘要檔"
            elif bars["weekly"] >= 60 and bars["monthly"] >= 60 and bars["initialBoundaryChecked"]:
                record["status"] = "complete"
                record["weekly"] = bars["weekly"]
                record["monthly"] = bars["monthly"]
            else:
                record["status"] = "short_history"
                record["weekly"] = bars["weekly"]
                record["monthly"] = bars["monthly"]
                record["reason"] = "來源已核對，但目前保存的完整週／月棒不足 60；待逐檔公開驗收"
        state["tickers"][ticker] = record
    if args.exit_code and attempted:
        unreported = next((t for t in plan_data["tickers"] if t not in done and t not in reused and t not in failures), None)
        if unreported is not None:
            state["tickers"][unreported] = {
                "through": plan_data["through"], "checkedAt": when.isoformat(), "attempts": 1,
                "status": "interrupted", "reason": "整批在此代號附近中止；無逐檔成功或拒收結果，稍後重試",
                "retryAt": (when + dt.timedelta(minutes=30)).isoformat(),
            }
    stocks, through, last_seen, chart_from = universe(data_dir)
    if through != plan_data["through"]:
        raise ValueError("回補期間內行情基準已改變，拒絕保存不一致的狀態")
    for ticker, market in stocks.items():
        if market == "Emerging":
            state["tickers"][ticker] = {"status": "unsupported_source", "market": market,
                                         "reason": "興櫃日均價口徑尚無合格的週月摘要來源"}
            continue
        if last_seen[ticker] < chart_from:
            state["tickers"][ticker] = {"status": "archive_only", "market": market,
                "lastSeen": last_seen[ticker], "reason":
                f"最後行情 {last_seen[ticker]} 早於目前公開日 K 起點 {chart_from}；保留歷史摘要但不宣稱有公開圖表"}
            continue
        record = state["tickers"].get(ticker)
        if record is not None and record.get("status") == "archive_only":
            record = None
        if record is None:
            bars = coverage(data_dir, ticker)
            if bars and bars["weekly"] >= 60 and bars["monthly"] >= 60 and bars["initialBoundaryChecked"]:
                record = {"status": "complete", "weekly": bars["weekly"], "monthly": bars["monthly"]}
            else:
                record = {"status": "pending"}
            state["tickers"][ticker] = record
        record["market"] = market
    state["runs"] = int(state.get("runs", 0)) + 1
    state["lastRun"] = {"at": when.isoformat(), "through": plan_data["through"], "requested": len(plan_data["tickers"]),
                        "attempted": attempted, "processExit": args.exit_code}
    atomic_json(data_dir / STATE_PATH, state)
    result = {"requested": len(plan_data["tickers"]), "attempted": attempted,
              "complete": sum(state["tickers"].get(t, {}).get("status") == "complete" for t in plan_data["tickers"]),
              "failed": len(failures), "unattempted": len(plan_data["tickers"]) - attempted,
              "runs": state["runs"], "processExit": args.exit_code,
              "statusCounts": dict(collections.Counter(record["status"] for record in state["tickers"].values()))}
    print(json.dumps(result, ensure_ascii=False))


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("plan")
    p.add_argument("--data-dir", required=True)
    p.add_argument("--output", required=True)
    p.add_argument("--limit", type=int, default=75)
    p.add_argument("--tickers", default="")
    p.add_argument("--retry-rejected", action="store_true")
    p.set_defaults(func=plan)
    p = sub.add_parser("finish")
    p.add_argument("--data-dir", required=True)
    p.add_argument("--plan", required=True)
    p.add_argument("--log", required=True)
    p.add_argument("--exit-code", type=int, required=True)
    p.set_defaults(func=finish)
    args = parser.parse_args()
    if getattr(args, "limit", 1) < 1 or getattr(args, "limit", 1) > 100:
        parser.error("批次大小須為 1～100")
    args.func(args)


if __name__ == "__main__":
    main()
