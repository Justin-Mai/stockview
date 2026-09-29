# ============================================================
#  一键构建：图标 + 带图标的启动器
#
#  为什么需要这一步：Windows 的 .bat 不能携带自定义图标。
#  这里用 .NET Framework 自带的 csc.exe（Win7 以上都有，无需安装任何东西）
#  编译出一个几 KB 的启动器，把图标作为资源嵌进去。
#
#  用法：pwsh -File scripts/build-launcher.ps1
# ============================================================

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$ico = Join-Path $root 'assets\stockview.ico'
$cs = Join-Path $root 'launcher\Launcher.cs'
$exe = Join-Path $root '股票账本.exe'

# 1. 先生成图标（若已存在且你不想重画，可注释掉这一行）
& pwsh -NoProfile -File (Join-Path $PSScriptRoot 'make-icon.ps1')

if (-not (Test-Path $ico)) { throw "图标不存在：$ico" }
if (-not (Test-Path $cs)) { throw "启动器源码不存在：$cs" }

# 2. 找 csc.exe
$cscCandidates = @(
  "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe",
  "$env:WINDIR\Microsoft.NET\Framework\v4.0.30319\csc.exe"
)
$csc = $cscCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $csc) {
  throw "找不到 csc.exe。需要 .NET Framework 4.x（Windows 10/11 默认自带）。若确实没有，可继续使用 启动.bat（功能完全相同，只是没有自定义图标）。"
}

Write-Host ""
Write-Host "编译器：$csc"
Write-Host "正在编译 股票账本.exe ..."

# 3. 编译。/codepage:65001 保证源码里的中文（启动.bat 文件名）正确解析
$args = @(
  '/nologo',
  '/target:exe',
  '/platform:anycpu',
  '/optimize+',
  '/codepage:65001',
  '/r:System.dll',
  "/win32icon:$ico",
  "/out:$exe",
  $cs
)
& $csc @args
if ($LASTEXITCODE -ne 0) { throw "编译失败（exit $LASTEXITCODE）" }

if (-not (Test-Path $exe)) { throw "编译未产出 $exe" }

$size = (Get-Item $exe).Length
Write-Host ""
Write-Host ("完成：$exe  ({0:N0} 字节)" -f $size)
Write-Host ""
Write-Host "现在可以双击「股票账本.exe」启动（带图标）。"
Write-Host "「启动.bat」保留作为后备，两者行为完全一致。"
