namespace Invest.Web.Features.Assets.Ocr.Services;

/// <summary>
/// 以作業系統的檔案分享鎖保證同一台電腦只有一個 Worker；程序崩潰後檔案仍可被下一次啟動重用，
/// 不需要留下容易誤判的 stale PID。鎖檔路徑可由 OCR_WORKER_LOCK_PATH 覆寫。
/// </summary>
public sealed class OcrWorkerSingleInstance : IDisposable
{
    private readonly FileStream _lockStream;

    private OcrWorkerSingleInstance(FileStream lockStream, string path)
    {
        _lockStream = lockStream;
        Path = path;
    }

    public string Path { get; }

    public static OcrWorkerSingleInstance Acquire(string? configuredPath = null)
    {
        var configured = configuredPath ?? Environment.GetEnvironmentVariable("OCR_WORKER_LOCK_PATH");
        var path = string.IsNullOrWhiteSpace(configured)
            ? System.IO.Path.Combine(System.IO.Path.GetTempPath(), "invest-ocr-worker.lock")
            : configured.Trim();
        var directory = System.IO.Path.GetDirectoryName(path);
        if (!string.IsNullOrWhiteSpace(directory))
        {
            Directory.CreateDirectory(directory);
        }

        try
        {
            var stream = new FileStream(path, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
            return new(stream, path);
        }
        catch (IOException exception)
        {
            throw new InvalidOperationException($"已有另一個 D+ OCR Worker 正在執行（鎖檔：{path}）。", exception);
        }
    }

    public void Dispose() => _lockStream.Dispose();
}
