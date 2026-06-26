Set-Location -LiteralPath $PSScriptRoot
$host.UI.RawUI.WindowTitle = "Captcha OCR Server"
$shortPkg = "C:\ocr-py\Lib\site-packages"

Write-Host "===== Captcha OCR Server =====" -ForegroundColor Cyan
Write-Host ""

Write-Host "[1/4] Checking Python..." -NoNewline
$pyVer = python --version 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host " FAIL" -ForegroundColor Red
    Write-Host "Python not found. Visit python.org to install"
    Read-Host "Press Enter to exit"
    exit 1
}
Write-Host " $pyVer" -ForegroundColor Green

Write-Host "[2/4] Checking packages..." -NoNewline
$needInstall = $false
if (!(Test-Path "$shortPkg\httpx")) { $needInstall = $true }

if ($needInstall) {
    Write-Host " installing..." -ForegroundColor Yellow
    Write-Host "     (Target: $shortPkg)" -ForegroundColor Gray

    New-Item -Path $shortPkg -ItemType Directory -Force | Out-Null

    pip install --target "$shortPkg" -r requirements.txt --no-warn-script-location 2>&1

    if ($LASTEXITCODE -ne 0) {
        Write-Host "FAILED" -ForegroundColor Red
        Read-Host "Press Enter to exit"
        exit 1
    }
    Write-Host "Done" -ForegroundColor Green
} else {
    Write-Host " ready" -ForegroundColor Green
}

Write-Host "[3/4] Pre-loading OCR model..." -ForegroundColor Yellow
Write-Host "     (First run downloads model, may take a while)"
python -c "import sys; sys.path.insert(0, '$shortPkg'); import ddddocr; ddddocr.DdddOcr(det=True, ocr=False, show_ad=False); ddddocr.DdddOcr(ocr=True, det=False, show_ad=False, beta=True)" 2>&1 | Out-Null

Write-Host "[4/4] Starting server..." -ForegroundColor Cyan
Write-Host ""
Write-Host "  Server: http://127.0.0.1:9876" -ForegroundColor White
Write-Host "  Press Ctrl+C to stop" -ForegroundColor Gray
Write-Host ""
python "$PSScriptRoot\server.py"

Write-Host "Server stopped."
Read-Host "Press Enter to exit"
