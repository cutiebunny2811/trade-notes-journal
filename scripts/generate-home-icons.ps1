# Export the approved sidebar artwork as square PNGs for iOS and the web app manifest.
# The source is 162x163; cropping its final background row avoids distorting the logo.
Add-Type -AssemblyName System.Drawing

$projectRoot = Split-Path -Parent $PSScriptRoot
$sourcePath = Join-Path $projectRoot 'dist/trade-notes-icon-premium.png'
$source = [System.Drawing.Bitmap]::new($sourcePath)
try {
  if ($source.Width -ne 162 -or $source.Height -ne 163) {
    throw 'The approved icon dimensions changed; review the crop before exporting.'
  }

  $sourceRect = [System.Drawing.Rectangle]::new(0, 0, 162, 162)
  foreach ($size in @(180, 192, 512)) {
    $output = [System.Drawing.Bitmap]::new($size, $size)
    try {
      $graphics = [System.Drawing.Graphics]::FromImage($output)
      try {
        $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::Half
        $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
        $graphics.Clear([System.Drawing.Color]::FromArgb(14, 27, 24))
        $graphics.DrawImage($source, [System.Drawing.Rectangle]::new(0, 0, $size, $size), $sourceRect, [System.Drawing.GraphicsUnit]::Pixel)
      } finally {
        $graphics.Dispose()
      }

      $name = if ($size -eq 180) { 'apple-touch-icon.png' } else { "icon-$size.png" }
      $output.Save((Join-Path $projectRoot "dist/$name"), [System.Drawing.Imaging.ImageFormat]::Png)
    } finally {
      $output.Dispose()
    }
  }
} finally {
  $source.Dispose()
}
