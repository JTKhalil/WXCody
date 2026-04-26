$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Drawing

$size = 240
$s = 12
$gap = 6

$out = "D:\mochi\CodyProject\WXCody\assets\splash_logo.png"
New-Item -ItemType Directory -Force -Path (Split-Path $out) | Out-Null

$bmp = New-Object System.Drawing.Bitmap $size, $size
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::None
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
$g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::Half

$g.Clear([System.Drawing.Color]::FromArgb(0, 0, 0))

$bot = [System.Drawing.Color]::FromArgb(218, 17, 0)
$eye = [System.Drawing.Color]::FromArgb(0, 0, 0)
$brushBot = New-Object System.Drawing.SolidBrush $bot
$brushEye = New-Object System.Drawing.SolidBrush $eye
$brushText = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)

$msg = "Hello Cody"
$font = New-Object System.Drawing.Font "Consolas", 28, ([System.Drawing.FontStyle]::Regular), ([System.Drawing.GraphicsUnit]::Pixel)
$sz = $g.MeasureString($msg, $font)
$textW = [int][Math]::Ceiling($sz.Width)
$textH = [int][Math]::Ceiling($sz.Height)

$bodyW = 10 * $s
$bodyH = 6 * $s
$legH = 2 * $s
$botH = $bodyH + $legH
$groupH = $botH + $gap + $textH
$topY = [int](($size - $groupH) / 2)
$centerX = [int]($size / 2)
$x0 = $centerX - [int]($bodyW / 2)
$y0 = $topY

# Body
$g.FillRectangle($brushBot, $x0, $y0, $bodyW, $bodyH)
# Ears
$g.FillRectangle($brushBot, $x0 - 2 * $s, $y0 + 2 * $s, 2 * $s, 2 * $s)
$g.FillRectangle($brushBot, $x0 + $bodyW, $y0 + 2 * $s, 2 * $s, 2 * $s)
# Eyes
$g.FillRectangle($brushEye, $x0 + 2 * $s, $y0 + 2 * $s, $s, $s)
$g.FillRectangle($brushEye, $x0 + 7 * $s, $y0 + 2 * $s, $s, $s)
# Legs
$legY = $y0 + $bodyH
foreach ($lx in @(1, 3, 6, 8)) {
  $g.FillRectangle($brushBot, $x0 + $lx * $s, $legY, $s, $legH)
}

$textX = [int](($size - $textW) / 2)
$textY = $topY + $botH + $gap
$g.DrawString($msg, $font, $brushText, $textX, $textY)
$g.DrawString($msg, $font, $brushText, $textX + 1, $textY)

$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)

$g.Dispose()
$bmp.Dispose()

Write-Output "Wrote $out"

