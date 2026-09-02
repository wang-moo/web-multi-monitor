# Web Multi-Instance Monitor

基于 React、Tauri 2 和 WebView2 的 Windows 多网页监控工具。它可以在一个窗口内创建多个互相隔离的网页实例，适合同时观察多个网页会话或 Cocos 游戏画面。

## 功能

- 每页以 2 × 2 监控墙显示最多 4 个实例，超出后自动分页
- 每个实例使用独立的 WebView2 Profile，并启用隐私模式
- 每个实例可单独刷新、关闭、放大和按 90° 旋转
- 支持为单个实例或全部实例设置 Cocos `cc.director` 运行速度
- 新实例继承当前总速度，速度可设置为任意大于 0 的有限数字
- 仅允许打开 HTTP/HTTPS 地址，并禁用扩展、自动填充、开发者工具和新窗口
- 程序退出后清理本次运行产生的临时浏览器数据
- 针对 `gameh5pro.com`，为每个实例提供不同的 `_device_deviceID` 本地存储值

## 环境要求

- Windows 10/11
- Node.js 与 npm
- Rust stable（MSVC 工具链）
- Microsoft C++ Build Tools
- Microsoft Edge WebView2 Runtime

## 开发运行

```powershell
npm install
npm run tauri dev
```

只预览前端界面：

```powershell
npm run dev
```

浏览器预览不具备真实的 WebView2 实例创建、隔离、刷新和速度控制能力，这些功能需要在 Tauri 客户端中验证。

## 使用方法

1. 在左侧“页面链接”中填写完整的 HTTP/HTTPS 地址。
2. 点击“添加隔离画面”创建实例。
3. 使用画面右上角按钮进行刷新、旋转、放大或关闭。
4. 在画面顶部设置单个实例速度，或在主工具栏中设置总速度并应用到全部实例。
5. 实例超过 4 个时，使用右上角分页按钮切换监控墙。

修改链接只影响之后新建的实例，不会改变已经打开的画面。

## 构建 Windows 安装包

```powershell
npm install
npm run tauri build
```

构建完成后，NSIS 安装包位于：

```text
src-tauri\target\release\bundle\nsis\
```

可执行文件位于：

```text
src-tauri\target\release\web-multi-monitor.exe
```

## 测试

```powershell
cargo test --manifest-path src-tauri\Cargo.toml
npm run build
```

## 项目结构

```text
src/                         React 监控墙界面
src-tauri/src/lib.rs         WebView2 实例、布局、隔离和速度控制
src-tauri/tauri.conf.json    Tauri 窗口与安装包配置
vendor/tauri-runtime-wry/    支持独立 WebView2 Profile 的本地运行时补丁
```

## 隔离范围与限制

“多实例隔离”指每个 WebView2 实例拥有不同的 Profile，并启用隐私模式。它可以隔离 Cookie、缓存、LocalStorage 和 IndexedDB 等浏览器侧数据，但不等于网络或设备层面的完全匿名：

- 所有实例通常仍共享同一公网 IP
- 服务端仍可能通过账号、网络信息或浏览器指纹关联请求
- 如果服务端限制同一账号只能保留一个在线会话，新登录仍可能使旧会话下线
- 实例数量没有软件上限，但实际容量取决于 CPU、内存和 WebView2 资源
- 速度控制仅对暴露 `window.cc.director.getScheduler()` 的 Cocos 页面生效，普通网页不受影响

本项目当前仅面向 Windows；`vendor/tauri-runtime-wry` 是构建所需代码，请勿删除。
