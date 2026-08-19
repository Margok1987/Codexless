<div align="center">

# Codexless

### ChatGPT 开始干 Codex 的活了。

**让你的 ChatGPT 从手机、网页或桌面端，直接用上你本机已经有的 Codex 工具箱。**

[English](README.md)

![Technical Preview](https://img.shields.io/badge/status-technical_preview-6b7280)
![Windows](https://img.shields.io/badge/Windows-supported-0078D4?logo=windows11&logoColor=white)
![Apple Silicon macOS](https://img.shields.io/badge/macOS-Apple_Silicon-111111?logo=apple&logoColor=white)
[![Apache-2.0 License](https://img.shields.io/badge/license-Apache--2.0-22c55e.svg)](LICENSE)

**留在 ChatGPT。活落在本机。真需要 Codex 时，再摇人。**

</div>

Codexless 做的事很简单：**让你的 ChatGPT 套上 Codex 的工服，拎起你本地电脑里的 Codex 工具箱🧰，自己下场干。**

装环境、做维护、看项目、改文件、跑命令、操作浏览器——**你先跟 ChatGPT 说要干什么，它平时自己干；真需要 Codex，再摇 Codex 本人🤖。**

**少掉那些没必要的 Codex 调用，额度也就少花一点；真要调用时，再把额度花在刀刃上。** 这就是 Codexless 里的 **less**。

> **觉得这路子有意思？把这个仓库直接甩给你的 ChatGPT，让它自己看看：这台机器能不能装，装完能干什么。**

---

## 它到底能干什么？

### 1. Codex 的本地工具箱，直接递给 ChatGPT

让当前这个 Chat 直接拿 Codex 的本地工具干活。

看项目、装环境、做维护、改文件、跑命令、看结果，都可以留在这里继续。

**人话：以前总要切到 Codex 才能落地的那一步，现在原地就能继续做。**

这些已经支持的工具动作，**不会实际调用 Codex，也不会扣 Codex 额度。**

---

### 2. Codex 已经学会的，直接拿来用

项目规则、Skills、目录习惯，能复用的就直接复用。

**不用重教一遍，也不用另起炉灶。**

> **工具箱直接拎走，说明书也一起带上。**

还有一层长期好处：**Codex 的工具箱继续进化，我们不用从头重造一套。** 适合公开的新能力重新验收过，就能继续沿这条路拿来用。

当然，不是“Codex 一更新，ChatGPT 就自动得到全部新能力”。没验过的能力，不算公开承诺。

---

### 3. 先跟 ChatGPT 说，需要 Codex 时它再摇人

**ChatGPT 可以直接当你的默认入口。** 你先把事交给它；当前工具够用，它就继续做。真需要 Codex 专门出手时，再从当前 Chat 升级过去。你想直接开 Codex 当然也可以，Codexless 不限制原来的工作习惯。

真要调用 Codex 时，它先**向你打个申请**：

1. 准备让 Codex 干什么；
2. 先帮你查好当前还剩多少额度；
3. 要不要调用，Yes / No 你说了算；
4. 干完告诉你用了多少、还剩多少额度。

> **平时自己干。真需要时，再摇 Codex。**

如果当前 Chat 显示不了这张卡，也会退回普通文本确认；一样要你明确回答 Yes / No，不会自动放行。

<p align="center">
  <img src="docs/images/codex-task-card-flow.gif" width="100%" alt="Codex Task Card：调用、执行、完成三种状态">
</p>

---

### 4. Chat 窗口也能钻进 Chrome 干活了

**不仅有看浏览器的眼睛👀，也有操控浏览器的手🖐**

不再只是“看完告诉你怎么点”，而是可以自己继续操作下去。

当前公开 Browser 支持：

- 查看、截图👀；
- 打开、关闭、跳转页面🌐；
- 点击、填写文本、提交✍；
- 使用 `Enter` / `Tab` / `Escape`，滚动页面↕️；
- 上传⏫、下载⏬。

#### 使用浏览器操控，需要具备以下条件

本机需要安装 **Chrome**，并在实际使用的 Chrome profile 中安装并连接 **ChatGPT 浏览器扩展**。

如果需要上传本地文件，还需在扩展设置中打开 **“允许访问文件网址”**。

---

## 这东西适合我吗？

**大概率适合：**

1. 你本来就在用 ChatGPT + Codex 做项目，烦来回搬上下文、重复维护两套工具；
2. Codex 额度经常吃紧，想让它少在平时登场，把额度留到真要调用它的时候；
3. 你长期用着同一个 AI 助手 / 伴侣，不想为了干活换一个陌生 Agent，想让这个熟悉的 AI 也有本地手脚，能做更多事。

**可能没那么需要：** 你几乎所有任务都直接用 Codex，已经自己搭好成熟的 Agent 基础设施，或者需要的是一套无限制的浏览器 / 桌面自动化平台。

---

## 准备安装前，先看这几条

- **平台：** Windows + **Apple Silicon macOS（arm64）** Technical Preview。Intel Mac 暂不支持。
- **前提：** 本机已有 **Node.js 22+** 和可工作的 **Codex**。Codex Desktop 不是必须项，CLI 能正常使用也可以。
- **不会再装一份 Codex：** Codexless 会寻找并复用本机已有的 Codex；找不到当前可用版本时会明确提示，不会自动再装一套。
- **浏览器操控：** 本机需要安装 Chrome 和 ChatGPT 浏览器扩展；Browser 使用当前 Chrome profile 的网站登录状态。
- **上传文件：** 还需要在扩展设置中额外打开 **“允许访问文件网址”**。
- **个人套餐实测：** Plus 和 Pro 已在真实机器通过产品形态链路测试。这是实测证据，不是未来政策保证。
- **本地怎么连：** ChatGPT 不会直接访问 `localhost`。典型链路是 **本机 Codexless → 已认证 Tunnel / remote MCP endpoint → ChatGPT App / Developer Mode**。
- **Tunnel 不锁死：** OpenAI Secure MCP Tunnel 是已经支持的一条路，但不是唯一依赖。
- **包体：** 当前 Technical Preview 包本体低于 **0.21 MB 压缩 / 0.9 MB 解压**，不含正常安装依赖。
- **身份：** Codexless 是独立项目，不是 OpenAI 产品，也不代表 OpenAI 背书。

---

## 安装与更新

**先确认电脑里有 Node.js 22+ 和可工作的 Codex。安装脚本会检查，但不会替你安装 Node/npm 或 Codex。**

如果你不想自己判断环境，先把这个仓库交给自己的 AI，让它帮你检查平台、Node、Codex 和安装路径。

涉及本机执行、权限或 trust 的最终确认，仍然由你决定。

**从 2026 年 8 月 19 日发布的 `0.1.1-preview.0` 开始，Codexless 支持自动检查和一键更新。更早安装的版本，请先下载最新版，并重新运行下面对应平台的安装命令完成升级。**

### Windows

安装：

```powershell
.\bin\codexless-install.cmd
```

更新：

```powershell
& "$env:LOCALAPPDATA\Codexless\bin\codexless-update.cmd"
```

默认目录：

```text
%LOCALAPPDATA%\Codexless
```

检查项目：

```powershell
& "$env:LOCALAPPDATA\Codexless\bin\codexless-doctor.cmd" --cwd "C:\path\to\your\project"
```

启动 HTTP：

```powershell
& "$env:LOCALAPPDATA\Codexless\bin\codexless-http.cmd"
```

卸载：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\Codexless\scripts\uninstall.ps1"
```

### Apple Silicon macOS

当前只支持 Apple Silicon（`arm64`）。

安装：

```sh
sh ./bin/codexless-install.sh
```

更新：

```sh
"$HOME/Library/Application Support/Codexless/app/bin/codexless-update.sh"
```

默认目录：

```text
~/Library/Application Support/Codexless/app
```

检查项目：

```sh
"$HOME/Library/Application Support/Codexless/app/bin/codexless-doctor.sh" --cwd "/path/to/your/project"
```

启动 HTTP：

```sh
"$HOME/Library/Application Support/Codexless/app/bin/codexless-http.sh"
```

卸载：

```sh
"$HOME/Library/Application Support/Codexless/app/bin/codexless-uninstall.sh"
```

### installer 会做什么？

两端 installer 都会先检查 Node.js 和本机 Codex，再在临时区域安装依赖、运行 doctor，成功后才切换正式安装。

它不会替你安装 Chrome、浏览器扩展或配置 Tunnel，也不会自动扩大 Codex trust。Browser 上传所需的文件访问权限也需要用户自行打开。

Codexless 会低频检查官方 Release。有新版时会提醒，但**不会自动安装**。更新会先下载、校验和自检，通过后才切换；中途失败不会用半成品覆盖当前可用版本。

---

## FAQ

### 1. 我用 Codexless 干活，会消耗 Codex 额度吗？

- **Codexless 可以帮 ChatGPT 干很多原本要找 Codex 干的活；只要没有真的调用 Codex，就不会消耗 Codex 额度。** 真正启动 Codex Agent 时才会消耗。
- **Work 和 Codex 本来共用一套额度。** 所以在 Work 窗口里用 Codexless，并不能绕过 Work 自己需要消耗的额度；如果你的目标是尽量节省 Codex 额度，**推荐在普通 Chat 里使用 Codexless。**

---

### 2. 如果 Codex 额度到 0% 了，Codexless 还能干活吗？

**能。除了不能实际调用 Codex，其他已经支持的功能照常能用。**

读、查、改、验，以及不需要实际调用 Codex 的 Browser 功能还能继续。

等额度恢复后，再继续调用 Codex。

---

### 3. 省额度，是不是等于绕额度、绕套餐限制或者钻平台规则？

**不是。省额度，是少调用；不是把谁的额度变多、刷新、转移、合并或者绕过去。**

当前已经验收的 model-free 工具够用时，Codexless 就直接用这些工具，不为了同一件小事额外调用 Codex 模型；真正调用 Codex 时，Codex 额度仍然照常计算。

Codexless 基于 Codex App Server 和 ChatGPT app / MCP integration surface，不靠逆向私有 UI 或 secret protocol 去规避产品边界。

它也不会绕过本机 trust / permission、审批、sandbox / network 边界或平台确认。上游支持面或规则发生变化时，Codexless 应该跟着受支持的路径调整，或者明确失败，而不是偷偷绕过去。

---

### 4. 权限有多大？会不会乱删乱动我本地的东西？

**权限上限默认跟着你本机 Codex 的授权走，不会比 Codex 本身能操作的范围更大。**

Codexless 还可以按动作继续收窄权限。

如果你想更保守，可以在本机 Codex / 项目 trust 侧把权限范围收紧；Codexless 不会绕过这些设置。

真正的 permission / trust 拒绝应该明确失败，不会为了“把任务跑成功”偷偷切到更高权限路径。

完整边界看 [`SECURITY.md`](SECURITY.md)。

---

### 5. Codex 会什么，ChatGPT 就全部会了吗？

**不会。**

Codexless 只公开已经验收过的能力，不是把整个 Codex 环境无条件暴露出去。

当前公开服务合同是 **39 个工具**，其中模型直接看到 **36 个**；另外 3 个 Task Card 动作只供 App 界面使用。

真正需要调用 Codex 模型时，会走单独的 Agent / 审批流程；普通本地工具动作不是另一条隐藏的 Codex 调用通道。

更底层的 consent / commit / replay 细节放在后面的“给想看底层的人”。

---

### 6. Browser 能帮我操作网页吗？

**能。**

可以看标签页、截图、打开、关闭和跳转页面、点击、填写文本、滚动、使用 `Enter` / `Tab` / `Escape`、上传和下载。

它不是无限制接管 Chrome。任意脚本、任意 selector、任意坐标、完整键盘控制等 raw 能力不开放。

Browser 使用的是本机当前 Chrome profile 的登录状态；上传本地文件还需要额外打开扩展的 **“允许访问文件网址”**。

---

### 7. 我原来的 ChatGPT 规划 → Codex 执行工作流要改吗？

**不用。**

你照样可以先在 ChatGPT 里想、拆、聊。

当前工具够用就直接做完；真需要 Codex，再明确升级过去。

Codexless 减少的是没必要的搬运，不是逼你换工作习惯。

---

### 8. ChatGPT 不是不能直接进本地吗？Codexless 怎么做到的？

对，ChatGPT 不能直接访问你电脑上的 `localhost`。

Codexless 的做法是给本机服务接一条**经过认证的 MCP 通道**：

> **本机 Codexless → 已认证 Tunnel / remote MCP endpoint → ChatGPT App / Developer Mode**

ChatGPT 调的是 Codexless 对外开放的这组工具，不是直接拿到你整台电脑。

Tunnel / endpoint 的凭据不要进仓库，也不要贴进公开截图。

---

## 给想看底层的人

### 1. 公开合同

当前公开服务合同为 **39 个工具**；模型直接看到 **36 个**，另 3 个 Task Card 动作只供 App 界面使用。

Metered Agent 的 consent 是服务器侧状态：任务身份不是审批本身；真正 dispatch Codex 还必须经过对应的审批 / commit 路径。拒绝后不能靠重放旧请求把任务重新启动。

精确合同由 `src/surface-contracts.mjs` 固定，并由 public contract test 验收。

运行：

```powershell
npm test
```

### 2. 权限模型

Codex 仍是本地 permission / trust 权威。

- Codexless 可以继续收窄权限；
- 远端不能静默选择更强的本地权限；
- 真正的 permission / trust 拒绝要明确失败。

### 3. Browser 边界

公开 Browser 面向用户动作，不直接暴露 raw Browser 内部能力。

当前公开动作包括：读取标签页 / 页面、截图、打开 / 关闭 / 导航、语义点击、文本填写、滚动、固定 `Enter` / `Tab` / `Escape`、文件选择上传、浏览器下载。

不公开任意 JavaScript、raw selector、任意坐标、任意键盘、generic CDP，也不自动使用 Computer Use 兜底。

### 4. 集成方式

Codexless 基于 Codex App Server 和 ChatGPT app/MCP integration surface，不逆向私有 UI。

### 5. 当前 Technical Preview 证据

Windows 和 Apple Silicon macOS 都已经用真实机器跑过安装 / doctor / stdio 验收。

Browser 也已经在 Windows 和 Apple Silicon Mac 做过真实机器 dogfood；发布包仍按独立 release checklist 验收，不拿 source contract 代替实机证据。

### 6. 从源码运行

```sh
npm ci
npm run start:stdio
```

HTTP：

```sh
npm run start:http
```

自动发现找不到当前已验收的 Codex executable 时，可以显式设置 `CODEX_BIN`。

Windows 下不要把 `CODEX_BIN` 指到 npm 的 `.cmd` / `.ps1` shim。

---

## 给 AI 助理

如果用户把这个仓库发给你，问“这是啥？需要吗？安全吗？”，先看实际仓库和当前机器，再给建议。

先确认这些事实：

1. Codexless 让 ChatGPT 使用一组**经过验收**的 Codex-backed 本地能力；Codex 仍是专家升级通道。
2. 它**不增加、不绕过 Codex quota**；普通工具工作和真正调用 Codex 是两条不同路线。
3. 权限上限来自本机 Codex 当前有效授权；远端不能静默扩大。
4. Browser 已经不只是 Reader：能看、截、开、关、跳、点、填、滚、按固定键、上传、下载，但不暴露 raw Browser 内部能力。
5. Browser 需要本机 Chrome 和 ChatGPT 浏览器扩展；上传文件还需要额外的文件网址访问权限。
6. Codexless 是独立项目，不是 OpenAI 产品或背书。

---

> **平时自己干，硬骨头再摇 Codex。**
>
> **这就是 Codexless：不是不用 Codex，是不用什么都先叫 Codex。**
