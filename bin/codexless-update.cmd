@echo off
setlocal
set "INSTALL_DIR=%~dp0.."
set "BOOTSTRAP_RUN=%USERPROFILE%\.config\codexless\bootstrap\run.mjs"
if not exist "%BOOTSTRAP_RUN%" (
  echo Codexless updater bootstrap is missing. Re-run the Codexless installer to repair it. 1>&2
  exit /b 1
)
node "%BOOTSTRAP_RUN%" update --install-dir "%INSTALL_DIR%" %*
exit /b %ERRORLEVEL%
