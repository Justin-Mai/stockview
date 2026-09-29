/* ============================================================
   股票账本 · 带图标的启动器
   ------------------------------------------------------------
   Windows 的 .bat / .cmd 无法携带自定义图标（图标由文件类型
   HKCR\batfile 全局指定），所以这里编译一个极小的可执行文件，
   把图标作为资源嵌进去，双击体验与 .bat 完全一致。

   它只做一件事：调用同目录下的 启动.bat，并把控制台输出原样透传，
   因此启动逻辑始终只有一处（启动.bat），不会出现两份实现不一致。

   编译（由 scripts/build-launcher.ps1 自动完成）：
     csc /target:exe /codepage:65001 /win32icon:assets\stockview.ico ^
         /out:股票账本.exe /r:System.dll launcher\Launcher.cs
   ============================================================ */

using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;

// 让资源管理器「属性 / 详细信息」里有可读的名字，而不是 0.0.0.0
[assembly: AssemblyTitle("股票账本 · Ledger")]
[assembly: AssemblyProduct("Stockview Ledger")]
[assembly: AssemblyDescription("股票 / 基金 / 加密货币 本地统计面板（双击启动）")]
[assembly: AssemblyCopyright("本地个人使用")]
[assembly: AssemblyVersion("1.0.0.0")]
[assembly: AssemblyFileVersion("1.0.0.0")]

internal static class Launcher
{
    private const string BatchName = "启动.bat";

    private static int Main(string[] args)
    {
        string dir = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
        if (string.IsNullOrEmpty(dir)) dir = Directory.GetCurrentDirectory();

        string batch = Path.Combine(dir, BatchName);

        if (!File.Exists(batch))
        {
            Console.Error.WriteLine();
            Console.Error.WriteLine("  [错误] 同目录下找不到 " + BatchName);
            Console.Error.WriteLine("  [ERROR] Cannot find " + BatchName + " next to this program.");
            Console.Error.WriteLine();
            Console.Error.WriteLine("  请把本程序与 " + BatchName + "、server\\、web\\ 放在同一个文件夹中。");
            Console.Error.WriteLine("  Keep this file in the project folder, next to " + BatchName + ".");
            Console.Error.WriteLine();
            Console.Error.WriteLine("  按任意键退出 / Press any key to exit.");
            try { Console.ReadKey(true); } catch { /* 非交互环境 */ }
            return 1;
        }

        var psi = new ProcessStartInfo("cmd.exe", "/c \"" + batch + "\"")
        {
            WorkingDirectory = dir,
            UseShellExecute = false,
        };

        try
        {
            using (Process p = Process.Start(psi))
            {
                if (p == null) return 1;
                p.WaitForExit();
                return p.ExitCode;
            }
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("  [错误] 启动失败：" + ex.Message);
            try { Console.ReadKey(true); } catch { /* 忽略 */ }
            return 1;
        }
    }
}
