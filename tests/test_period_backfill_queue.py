import argparse
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


SOURCE = Path(__file__).resolve().parents[1] / "scripts" / "period-backfill-queue.py"
SPEC = importlib.util.spec_from_file_location("period_backfill_queue", SOURCE)
queue = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(queue)


class PeriodBackfillQueueTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        (self.root / "imports").mkdir()
        (self.root / "imports" / "2026-10-22.json").write_text(json.dumps({
            "isTradingDay": True,
            "quotes": [
                {"ticker": "2330", "market": "Twse"},
                {"ticker": "3711", "market": "Twse"},
                {"ticker": "5483", "market": "Tpex"},
                {"ticker": "7777", "market": "Emerging"},
            ]}), encoding="utf-8")
        self.plan_file = self.root / "plan.json"

    def plan(self, specified="", retry=False):
        queue.plan(argparse.Namespace(data_dir=str(self.root), output=str(self.plan_file),
                                      limit=75, tickers=specified, retry_rejected=retry))
        return queue.read_json(self.plan_file)

    def finish(self, log, exit_code=0):
        logfile = self.root / "run.log"
        logfile.write_text(log, encoding="utf-8")
        queue.finish(argparse.Namespace(data_dir=str(self.root), plan=str(self.plan_file),
                                        log=str(logfile), exit_code=exit_code))
        return queue.state_at(self.root)

    def save_coverage(self, ticker, weekly=60, monthly=60):
        directory = self.root / "imports-periods"
        directory.mkdir(exist_ok=True)
        bar = {"open": 1, "high": 2, "low": 1, "close": 2}
        (directory / f"{ticker}.json").write_text(json.dumps({
            "schemaVersion": 1, "ticker": ticker,
            "weekly": [bar] * weekly, "monthly": [bar] * monthly,
        }), encoding="utf-8")

    def test_resumes_after_bounded_partial_run_and_keeps_rejections(self):
        self.save_coverage("2330")
        self.assertEqual(["3711", "5483"], self.plan()["tickers"])
        self.save_coverage("3711")
        state = self.finish("3711 完成：週 70／月 65（只保存摘要與前置收盤）。\n")
        self.assertEqual("complete", state["tickers"]["3711"]["status"])
        self.assertEqual("pending", state["tickers"]["5483"]["status"])
        self.assertEqual("unsupported_source", state["tickers"]["7777"]["status"])
        self.assertEqual(["5483"], self.plan()["tickers"])
        state = self.finish("5483 未更新，保留原摘要：事件週期日資料與原始摘要不一致。\n", 1)
        self.assertEqual("source_rejected", state["tickers"]["5483"]["status"])
        self.assertNotIn("3711", self.plan()["tickers"])
        self.assertEqual(["5483"], self.plan(retry=True)["tickers"])

    def test_temporary_failure_retries_and_short_history_is_recorded(self):
        self.plan("3711")
        state = self.finish("3711 未更新，保留原摘要：Response status code does not indicate success: 502 (Bad Gateway).\n", 1)
        self.assertEqual("temporary_failure", state["tickers"]["3711"]["status"])
        self.assertNotIn("3711", self.plan()["tickers"])
        self.save_coverage("3711", weekly=55, monthly=35)
        self.plan("3711")
        state = self.finish("3711 完成：週 55／月 35（只保存摘要與前置收盤）。\n")
        self.assertEqual("short_history", state["tickers"]["3711"]["status"])
        self.assertNotIn("3711", self.plan()["tickers"])

    def test_unreported_ticker_is_delayed_after_batch_timeout(self):
        self.save_coverage("2330")
        self.plan()
        self.save_coverage("3711")
        state = self.finish("3711 完成：週 70／月 65（只保存摘要與前置收盤）。\n", 124)
        self.assertEqual("interrupted", state["tickers"]["5483"]["status"])
        self.assertEqual([], self.plan()["tickers"])


if __name__ == "__main__":
    unittest.main()
