using Invest.Web.Features.Assets.Ocr.Services;

namespace Invest.Web.Tests;

public sealed class OcrWorkerSingleInstanceTests
{
    [Fact]
    public void 同一鎖檔不可同時取得兩個Worker實例()
    {
        var path = System.IO.Path.Combine(
            System.IO.Path.GetTempPath(),
            $"invest-ocr-worker-test-{Guid.NewGuid():N}.lock");
        try
        {
            using var first = OcrWorkerSingleInstance.Acquire(path);
            var exception = Assert.Throws<InvalidOperationException>(() => OcrWorkerSingleInstance.Acquire(path));
            Assert.Contains("已有另一個", exception.Message, StringComparison.Ordinal);
        }
        finally
        {
            File.Delete(path);
        }
    }
}
