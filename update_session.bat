@echo off
title Update Session Bot Keuangan
color 0A

echo.
echo ================================================
echo   UPDATE SESSION BOT KEUANGAN KE RAILWAY
echo ================================================
echo.

:: Cek apakah node tersedia
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Node.js tidak ditemukan. Install dulu di nodejs.org
    pause
    exit /b
)

:: Hapus session lama
echo [1/5] Menghapus session lama...
if exist auth_info (
    rmdir /s /q auth_info
    echo       Session lama dihapus.
) else (
    echo       Tidak ada session lama.
)

:: Jalankan bot untuk scan QR baru
echo.
echo [2/5] Menjalankan bot untuk scan QR...
echo.
echo ================================================
echo   SCAN QR CODE YANG MUNCUL DI BAWAH INI
echo   Setelah muncul "Bot Keuangan aktif!"
echo   Tunggu 3 detik lalu tutup jendela ini (X)
echo   dan JANGAN tekan tombol apapun dulu!
echo ================================================
echo.
start "Bot Keuangan - Scan QR" cmd /k "node index.js"

:: Tunggu user scan QR dan bot aktif
echo.
echo Tunggu sampai kamu scan QR dan bot aktif...
echo Setelah bot aktif, tekan ENTER di sini untuk lanjut.
pause >nul

:: Matikan proses node
echo.
echo [3/5] Menyimpan session...
taskkill /f /im node.exe >nul 2>&1
timeout /t 2 /nobreak >nul

:: Cek apakah auth_info terbuat
if not exist auth_info (
    echo [ERROR] Folder auth_info tidak ditemukan.
    echo         Pastikan kamu sudah scan QR dan bot aktif sebelum tekan ENTER.
    pause
    exit /b
)

:: Buat zip dari auth_info
echo [4/5] Membuat file zip session...
if exist auth_info.zip del auth_info.zip
if exist auth_info_b64.txt del auth_info_b64.txt

powershell -Command "Compress-Archive -Path auth_info\* -DestinationPath auth_info.zip -Force"
if %errorlevel% neq 0 (
    echo [ERROR] Gagal membuat zip. Pastikan PowerShell tersedia.
    pause
    exit /b
)

:: Encode ke Base64
certutil -encode auth_info.zip auth_info_b64.txt >nul
if %errorlevel% neq 0 (
    echo [ERROR] Gagal encode Base64.
    pause
    exit /b
)

:: Hapus baris header/footer certutil (-----BEGIN/END CERTIFICATE-----)
powershell -Command "(Get-Content auth_info_b64.txt | Where-Object { $_ -notmatch '-----' }) -join '' | Set-Content auth_info_b64_clean.txt"

echo.
echo ================================================
echo [5/5] SELESAI! Lakukan langkah berikut:
echo ================================================
echo.
echo 1. File auth_info_b64_clean.txt sudah siap
echo 2. Buka Railway ^> Variables
echo 3. Update nilai WA_SESSION_BASE64 dengan
echo    isi file auth_info_b64_clean.txt
echo 4. Klik Redeploy di Railway
echo.
echo Membuka file sekarang...
notepad auth_info_b64_clean.txt

echo.
echo Setelah copy isi file ke Railway, tekan ENTER untuk selesai.
pause >nul

:: Bersihkan file temporary
del auth_info.zip >nul 2>&1
del auth_info_b64.txt >nul 2>&1
del auth_info_b64_clean.txt >nul 2>&1

echo.
echo Selesai! Bot kamu di Railway akan aktif setelah redeploy.
echo.
pause