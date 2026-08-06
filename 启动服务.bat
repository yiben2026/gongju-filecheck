@echo off
chcp 65001 >nul 2>&1
title 文件核查服务

echo.
echo   ================================
echo     文件核查服务启动中...
echo   ================================
echo.

REM 检查 Node.js 是否可用
where node >nul 2>&1
if %errorlevel% == 0 (
    set "NODE_CMD=node"
    set "NPM_CMD=npm"
) else (
    REM 尝试常见安装路径
    if exist "C:\Program Files\nodejs\node.exe" (
        set "NODE_CMD=C:\Program Files\nodejs\node.exe"
        set "NPM_CMD=C:\Program Files\nodejs\npm.cmd"
    ) else if exist "C:\Program Files (x86)\nodejs\node.exe" (
        set "NODE_CMD=C:\Program Files (x86)\nodejs\node.exe"
        set "NPM_CMD=C:\Program Files (x86)\nodejs\npm.cmd"
    ) else (
        echo   [错误] 未找到 Node.js！
        echo   请先安装 Node.js：https://nodejs.org
        echo   安装后重新运行此文件。
        echo.
        pause
        exit /b 1
    )
)

REM 检查依赖是否已安装
if not exist "%~dp0node_modules" (
    echo   首次运行，正在安装依赖包...
    echo.
    cd /d "%~dp0"
    "%NPM_CMD%" install
    if %errorlevel% neq 0 (
        echo.
        echo   [错误] 依赖安装失败！
        echo   请检查网络连接后重试。
        echo.
        pause
        exit /b 1
    )
    echo.
    echo   依赖安装完成！
    echo.
)

REM 启动服务
cd /d "%~dp0"
"%NODE_CMD%" server.js
pause
