import importlib.util
import argparse
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


SOURCE = Path(__file__).resolve().parents[1] / "scripts" / "audit-period-kline-public.py"
SPEC = importlib.util.spec_from_file_location("period_kline_public_audit", SOURCE)
audit = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(audit)


class PublicPeriodKLineAuditTests(unittest.TestCase):
    def chart(self, count=60, ma60=100):
        fields = ["date", "open", "high", "low", "close", "ma60"]
        bars = [[f"{2000 + i // 12:04d}-{i % 12 + 1:02d}-01", 100, 110, 90, 100, ma60]
                for i in range(count)]
        return {"schemaVersion": 2, "periodFields": fields, "weekly": bars, "monthly": bars}

    def test_sixty_complete_bars_and_latest_ma60(self):
        self.assertIsNone(audit.inspect_chart("3711", self.chart()))
        self.assertIn("只有 59 根", audit.inspect_chart("3711", self.chart(59)))
        self.assertIn("MA60 缺失", audit.inspect_chart("3711", self.chart(ma60=None)))

    def test_rejects_missing_price_and_bad_period_field_width(self):
        chart = self.chart()
        chart["monthly"][0][1] = None
        self.assertIn("只有 59 根", audit.inspect_chart("3711", chart))
        chart = self.chart()
        chart["weekly"][0].append(1)
        self.assertIn("欄位與資料長度不符", audit.inspect_chart("3711", chart))

    def test_audits_pending_listed_stock_as_well_as_claimed_complete(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            state = root / "imports-periods-status" / "queue.json"
            state.parent.mkdir()
            state.write_text(json.dumps({"schemaVersion": 1, "lastRun": {"through": "2026-10-22"},
                "tickers": {"2330": {"market": "Twse", "status": "complete"},
                            "3711": {"market": "Twse", "status": "pending"},
                            "7777": {"market": "Emerging", "status": "unsupported_source"}}}), encoding="utf-8")

            def source(_, path):
                if path == "manifest.json":
                    return {"version": "v1", "latestTradingDate": "2026/10/22"}
                return self.chart() if "2330" in path else self.chart(16)

            output = root / "report.json"
            with patch.object(audit, "get_json", side_effect=source):
                with self.assertRaises(SystemExit):
                    audit.audit(argparse.Namespace(data_dir=str(root), site="https://example.test",
                                                  output=str(output), workers=2))
            report = json.loads(output.read_text(encoding="utf-8"))
            self.assertEqual(2, report["listedChecked"])
            self.assertEqual(1, report["publicPassed"])
            self.assertEqual("3711", report["publicFailures"][0]["ticker"])


if __name__ == "__main__":
    unittest.main()
