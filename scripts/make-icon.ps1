# ============================================================
#  生成应用图标 assets/stockview.ico
#
#  设计：与应用内的「印章」视觉一致 —— 朱砂圆角方印 + 米白汉字。
#   - ≥32px：印上「账」字（与应用左上角 logo 完全一致）
#   - <32px ：改用「¥」符号（汉字在小尺寸会糊成一团，货币符号仍然清晰可辨）
#
#  字形定位不靠手感：先在离屏画布上量出墨迹实际边界，
#  再按「让墨迹中心落在画布正中」反推绘制位置。
#  （早期版本手调了一个「视觉补偿」把字往上推了 3.5%，导致看起来偏左上。）
#
#  输出为多尺寸 ICO：16 / 24 / 32 / 48 / 64 / 128 用 BMP(DIB) 条目，
#  256 用 PNG 条目（Windows Vista+ 支持），兼顾兼容性与体积。
#
#  用法：pwsh -File scripts/make-icon.ps1
# ============================================================

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Drawing.Primitives -ErrorAction SilentlyContinue

$root = Split-Path -Parent $PSScriptRoot
$outDir = Join-Path $root 'assets'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$icoPath = Join-Path $outDir 'stockview.ico'

# 应用主色
$sealTop    = [System.Drawing.Color]::FromArgb(255, 240, 80, 48)   # #f05030
$sealBottom = [System.Drawing.Color]::FromArgb(255, 199, 47, 26)   # #c72f1a
$cream      = [System.Drawing.Color]::FromArgb(255, 255, 248, 244) # #fff8f4

# 字号占画布比例，与选用字体配套
$SMALL_MAX = 32          # 小于这个尺寸用 ¥
$RATIO_SMALL = 0.62
$RATIO_LARGE = 0.60

# ---------------------------------------------------------- 字形规格（唯一来源）

function Get-GlyphSpec([int]$s) {
  $isSmall = $s -lt $SMALL_MAX
  $family = if ($isSmall) { 'Microsoft YaHei UI' } else { 'Noto Serif SC' }
  $ratio = if ($isSmall) { $RATIO_SMALL } else { $RATIO_LARGE }
  $size = [double]($s * $ratio)
  try {
    $font = New-Object System.Drawing.Font($family, $size, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
    # 记下实际采用的字体族，尺寸很小或字体缺失时 GDI+ 会回退，这里只做提示
    $used = $font.FontFamily.Name
  } catch {
    $font = New-Object System.Drawing.Font('SimSun', $size, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
    $used = 'SimSun'
  }
  return [pscustomobject]@{
    IsSmall = $isSmall
    Glyph   = $(if ($isSmall) { '¥' } else { '账' })
    Font    = $font
    Family  = $used
  }
}

function New-TextFormat {
  $sf = New-Object System.Drawing.StringFormat
  $sf.Alignment = [System.Drawing.StringAlignment]::Center
  $sf.LineAlignment = [System.Drawing.StringAlignment]::Center
  $sf.FormatFlags = [System.Drawing.StringFormatFlags]::NoClip
  return $sf
}

# ---------------------------------------------------------- 墨迹测量

function Get-InkBounds([System.Drawing.Bitmap]$bmp, [int]$Threshold = 40) {
  $w = $bmp.Width; $h = $bmp.Height
  $rect = New-Object System.Drawing.Rectangle(0, 0, $w, $h)
  $locked = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $stride = $locked.Stride
  $raw = New-Object byte[] ($stride * $h)
  [System.Runtime.InteropServices.Marshal]::Copy($locked.Scan0, $raw, 0, $raw.Length)
  $bmp.UnlockBits($locked)

  $minX = $w; $minY = $h; $maxX = -1; $maxY = -1
  for ($y = 0; $y -lt $h; $y++) {
    $row = $y * $stride
    for ($x = 0; $x -lt $w; $x++) {
      if ($raw[$row + $x * 4 + 3] -ge $Threshold) {
        if ($x -lt $minX) { $minX = $x }
        if ($x -gt $maxX) { $maxX = $x }
        if ($y -lt $minY) { $minY = $y }
        if ($y -gt $maxY) { $maxY = $y }
      }
    }
  }
  if ($maxX -lt 0) { return $null }
  return [pscustomobject]@{
    MinX = $minX; MinY = $minY; MaxX = $maxX; MaxY = $maxY
    Width = ($maxX - $minX + 1); Height = ($maxY - $minY + 1)
    CX = (($minX + $maxX) / 2.0); CY = (($minY + $maxY) / 2.0)
  }
}

<#
  量出「让字形墨迹中心落在 s×s 画布正中」所需的绘制位移。
  做法：在 2s×2s 离屏画布上，用一个 s×s 的矩形居中画字，
  再测墨迹中心；因为 DrawString 的位移与矩形位移线性对应，可直接换算。
#>
function Measure-GlyphOffset([int]$s, $spec) {
  $canvas = $s * 2
  $bmp = New-Object System.Drawing.Bitmap($canvas, $canvas, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  # 关掉网格拟合：它会把字形吸附到整像素，破坏位移的线性关系
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAlias
  $brush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
  $sf = New-TextFormat
  $rect = New-Object System.Drawing.RectangleF(($s / 2.0), ($s / 2.0), $s, $s)
  $g.DrawString($spec.Glyph, $spec.Font, $brush, $rect, $sf)
  $g.Dispose(); $brush.Dispose(); $sf.Dispose()

  $ink = Get-InkBounds $bmp
  $bmp.Dispose()
  if (-not $ink) { return [pscustomobject]@{ DX = 0.0; DY = 0.0; Ink = $null } }

  # 目标：墨迹中心 = 画布中心 (s, s)
  return [pscustomobject]@{
    DX = ($s - $ink.CX)
    DY = ($s - $ink.CY)
    Ink = $ink
  }
}

# ---------------------------------------------------------- 绘制

function New-RoundedPath([int]$x, [int]$y, [int]$w, [int]$h, [int]$r) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $r * 2
  $p.AddArc($x, $y, $d, $d, 180, 90)
  $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
  $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
  $p.CloseFigure()
  return $p
}

# 只画印章底：圆角方形渐变 + 内侧高光（不含字）
function New-SealBackground([int]$s) {
  $bmp = New-Object System.Drawing.Bitmap($s, $s, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.Clear([System.Drawing.Color]::Transparent)

  $pad = [Math]::Max(0, [int][Math]::Round($s * 0.015))
  $side = $s - 2 * $pad
  $radius = [Math]::Max(2, [int][Math]::Round($s * 0.19))
  $path = New-RoundedPath $pad $pad $side $side $radius
  $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    (New-Object System.Drawing.Point(0, $pad)),
    (New-Object System.Drawing.Point(0, ($pad + $side))),
    $sealTop, $sealBottom)
  $g.FillPath($brush, $path)

  if ($s -ge 24) {
    $inset = [int][Math]::Round($s * 0.085)
    $stroke = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(70, 255, 255, 255), [Math]::Max(1, $s / 48.0))
    $inner = New-RoundedPath ($pad + $inset) ($pad + $inset) ($side - 2 * $inset) ($side - 2 * $inset) ([Math]::Max(1, $radius - $inset))
    $g.DrawPath($stroke, $inner)
    $stroke.Dispose(); $inner.Dispose()
  }

  $brush.Dispose(); $path.Dispose(); $g.Dispose()
  return $bmp
}

# 在已成图的位图上按给定位移画字
function Add-Glyph([System.Drawing.Bitmap]$bmp, [int]$s, $spec, [double]$dx, [double]$dy) {
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  # 关掉网格拟合：它会把字形吸附到整像素，破坏「位移线性对应」的前提
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAlias
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $brush = New-Object System.Drawing.SolidBrush($cream)
  $sf = New-TextFormat
  $rect = New-Object System.Drawing.RectangleF([float]$dx, [float]$dy, $s, $s)
  $g.DrawString($spec.Glyph, $spec.Font, $brush, $rect, $sf)
  $brush.Dispose(); $sf.Dispose(); $g.Dispose()
}

<#
  把成品与「只有底色」的版本相减，量出字形墨迹相对画布中心的实际偏移。
  这是唯一能真正发现「字偏左上」的检查 —— 只看代码看不出来。
#>
function Get-RenderedOffset([System.Drawing.Bitmap]$with, [System.Drawing.Bitmap]$without) {
  $w = $with.Width; $h = $with.Height
  $lockA = $with.LockBits((New-Object System.Drawing.Rectangle(0, 0, $w, $h)), [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $lockB = $without.LockBits((New-Object System.Drawing.Rectangle(0, 0, $w, $h)), [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $rawA = New-Object byte[] ($lockA.Stride * $h); [System.Runtime.InteropServices.Marshal]::Copy($lockA.Scan0, $rawA, 0, $rawA.Length)
  $rawB = New-Object byte[] ($lockB.Stride * $h); [System.Runtime.InteropServices.Marshal]::Copy($lockB.Scan0, $rawB, 0, $rawB.Length)
  $strideA = $lockA.Stride; $strideB = $lockB.Stride
  $with.UnlockBits($lockA); $without.UnlockBits($lockB)

  $minX = $w; $minY = $h; $maxX = -1; $maxY = -1
  for ($y = 0; $y -lt $h; $y++) {
    for ($x = 0; $x -lt $w; $x++) {
      $a = $y * $strideA + $x * 4
      $b = $y * $strideB + $x * 4
      $d = [Math]::Abs($rawA[$a] - $rawB[$b]) + [Math]::Abs($rawA[$a + 1] - $rawB[$b + 1]) + [Math]::Abs($rawA[$a + 2] - $rawB[$b + 2])
      if ($d -gt 30) {
        if ($x -lt $minX) { $minX = $x }
        if ($x -gt $maxX) { $maxX = $x }
        if ($y -lt $minY) { $minY = $y }
        if ($y -gt $maxY) { $maxY = $y }
      }
    }
  }
  if ($maxX -lt 0) { return $null }
  return [pscustomobject]@{
    MinX = $minX; MinY = $minY; MaxX = $maxX; MaxY = $maxY
    Width = ($maxX - $minX + 1); Height = ($maxY - $minY + 1)
    DX = ((($minX + $maxX) / 2.0) - (($w - 1) / 2.0))
    DY = ((($minY + $maxY) / 2.0) - (($h - 1) / 2.0))
  }
}

<#
  成品位图：底色 + 字形。
  定位走闭环：先按墨迹测量给初值，画完再量实际残差并修正，直到 ≤0.5px 或达上限。
#>
function New-IconBitmap([int]$s, [switch]$SkipGlyph, [double]$Tolerance = 0.5, [int]$MaxPasses = 4) {
  $bg = New-SealBackground $s
  if ($SkipGlyph) { return $bg }

  $spec = Get-GlyphSpec $s
  $off = Measure-GlyphOffset $s $spec
  $dx = $off.DX
  $dy = $off.DY
  $bmp = $null
  $passes = 0
  $residual = $null

  for ($i = 1; $i -le $MaxPasses; $i++) {
    $passes = $i
    if ($bmp) { $bmp.Dispose() }
    $bmp = [System.Drawing.Bitmap]$bg.Clone()
    Add-Glyph $bmp $s $spec $dx $dy
    $residual = Get-RenderedOffset $bmp $bg
    if (-not $residual) { break }
    if ([Math]::Abs($residual.DX) -le $Tolerance -and [Math]::Abs($residual.DY) -le $Tolerance) { break }
    # 实测偏了多少就往回挪多少
    $dx -= $residual.DX
    $dy -= $residual.DY
  }

  $script:LastGlyphInfo = [pscustomobject]@{
    Size = $s; Glyph = $spec.Glyph; Passes = $passes
    DrawX = $dx; DrawY = $dy
    ResidualX = $(if ($residual) { $residual.DX } else { 0 })
    ResidualY = $(if ($residual) { $residual.DY } else { 0 })
    InkW = $(if ($residual) { $residual.Width } else { 0 })
    InkH = $(if ($residual) { $residual.Height } else { 0 })
  }
  $spec.Font.Dispose()
  $bg.Dispose()
  return $bmp
}

# ---------------------------------------------------------- ICO 编码

function Get-IcoEntry([int]$s) {
  $bmp = New-IconBitmap $s
  $ms = New-Object System.IO.MemoryStream

  if ($s -ge 256) {
    # PNG 条目：体积小，Vista+ 支持
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  } else {
    # BMP(DIB) 条目：兼容性最好
    $w = $bmp.Width; $h = $bmp.Height
    $rect = New-Object System.Drawing.Rectangle(0, 0, $w, $h)
    $locked = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $stride = $locked.Stride
    $raw = New-Object byte[] ($stride * $h)
    [System.Runtime.InteropServices.Marshal]::Copy($locked.Scan0, $raw, 0, $raw.Length)
    $bmp.UnlockBits($locked)

    $bw = New-Object System.IO.BinaryWriter($ms)
    # BITMAPINFOHEADER（高度写两倍：XOR 位图 + AND 掩码）
    $bw.Write([int]40); $bw.Write([int]$w); $bw.Write([int]($h * 2))
    $bw.Write([int16]1); $bw.Write([int16]32); $bw.Write([int]0)
    $bw.Write([int]($w * $h * 4)); $bw.Write([int]0); $bw.Write([int]0); $bw.Write([int]0); $bw.Write([int]0)

    # XOR 位图：BGRA、自下而上
    for ($y = $h - 1; $y -ge 0; $y--) {
      $rowStart = $y * $stride
      for ($x = 0; $x -lt $w; $x++) {
        $o = $rowStart + $x * 4
        $bw.Write([byte]$raw[$o + 0])  # B
        $bw.Write([byte]$raw[$o + 1])  # G
        $bw.Write([byte]$raw[$o + 2])  # R
        $bw.Write([byte]$raw[$o + 3])  # A
      }
    }

    # AND 掩码：每行按 4 字节对齐；alpha=0 处置 1（透明）
    # 注意必须用位移取字节下标：PowerShell 的 [int] 是「四舍五入」，
    # 写成 [int]($x/8) 会在每行最后一个像素上多算一格导致越界。
    $maskRow = [int]([Math]::Ceiling($w / 32.0) * 4)
    $mask = New-Object byte[] ($maskRow * $h)
    for ($y = 0; $y -lt $h; $y++) {
      $srcRow = $y * $stride
      $dstRow = ($h - 1 - $y) * $maskRow
      for ($x = 0; $x -lt $w; $x++) {
        if ($raw[$srcRow + $x * 4 + 3] -eq 0) {
          $mask[$dstRow + ($x -shr 3)] = $mask[$dstRow + ($x -shr 3)] -bor (128 -shr ($x -band 7))
        }
      }
    }
    $bw.Write($mask, 0, $mask.Length)
    $bw.Flush()
  }

  $bytes = $ms.ToArray()
  $ms.Dispose(); $bmp.Dispose()
  return $bytes
}

# ---------------------------------------------------------- 组装 ICO 容器

$sizes = @(16, 24, 32, 48, 64, 128, 256)
$images = @()
Write-Host ""
Write-Host "字形墨迹定位自检（把成品与「只有底色」的版本相减，实测墨迹中心相对画布中心的偏移）"
Write-Host ("  {0,-7} {1,-5} {2,-16} {3,-14} {4,-10} {5,-12} {6}" -f '尺寸', '字形', '未校正偏移', '最终残差', '墨迹尺寸', '迭代次数', '最终绘制位移')
$worst = 0.0
foreach ($s in $sizes) {
  $bytes = Get-IcoEntry $s          # 绘制 + 闭环校正，结果信息写在 $script:LastGlyphInfo
  $info = $script:LastGlyphInfo

  # 未校正偏移 = 直接把字画在 s×s 矩形正中时的墨迹偏差
  $spec = Get-GlyphSpec $s
  $off = Measure-GlyphOffset $s $spec
  $spec.Font.Dispose()
  $raw = "{0:F2},{1:F2}px" -f (-$off.DX), (-$off.DY)

  $left = "{0:F2},{1:F2}px" -f $info.ResidualX, $info.ResidualY
  $dims = "$($info.InkW)×$($info.InkH)"
  $dxStr = "{0:F2},{1:F2}px" -f $info.DrawX, $info.DrawY
  $worst = [Math]::Max($worst, [Math]::Max([Math]::Abs($info.ResidualX), [Math]::Abs($info.ResidualY)))

  Write-Host ("  {0,-7} {1,-5} {2,-16} {3,-14} {4,-10} {5,-12} {6}" -f `
    "${s}px", $info.Glyph, $raw, $left, $dims, $info.Passes, $dxStr)
  $images += [pscustomobject]@{ Size = $s; Bytes = $bytes }
  Write-Host ("          └ 条目 {0,7:N0} 字节" -f $bytes.Length)
}
Write-Host ""
Write-Host ("  最大残差 {0:F2}px（0.5px 是像素栅格上的理论极限）" -f $worst)

$fs = [System.IO.File]::Create($icoPath)
$bw = New-Object System.IO.BinaryWriter($fs)
$bw.Write([int16]0)                 # reserved
$bw.Write([int16]1)                 # type = icon
$bw.Write([int16]$images.Count)     # 图像数量

$offset = 6 + 16 * $images.Count
foreach ($img in $images) {
  $s = $img.Size
  $bw.Write([byte]$(if ($s -ge 256) { 0 } else { $s }))  # width
  $bw.Write([byte]$(if ($s -ge 256) { 0 } else { $s }))  # height
  $bw.Write([byte]0)                # 调色板数
  $bw.Write([byte]0)                # reserved
  $bw.Write([int16]1)               # planes
  $bw.Write([int16]32)              # bpp
  $bw.Write([int]$img.Bytes.Length)
  $bw.Write([int]$offset)
  $offset += $img.Bytes.Length
}
foreach ($img in $images) { $bw.Write($img.Bytes, 0, $img.Bytes.Length) }
$bw.Flush(); $bw.Dispose(); $fs.Dispose()

Write-Host ""
Write-Host ("已生成 {0}  ({1:N0} 字节，{2} 个尺寸)" -f $icoPath, (Get-Item $icoPath).Length, $images.Count)
