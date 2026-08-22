<div align="center">

# Codexless

### ChatGPT just started doing Codex's work.

**Give ChatGPT the local Codex toolbox already on your computer — from mobile, web, or desktop.**

[中文](README.zh-CN.md)

![Technical Preview](https://img.shields.io/badge/status-technical_preview-6b7280)
![Windows](https://img.shields.io/badge/Windows-supported-0078D4?logo=windows11&logoColor=white)
![Apple Silicon macOS](https://img.shields.io/badge/macOS-Apple_Silicon-111111?logo=apple&logoColor=white)
[![Apache-2.0 License](https://img.shields.io/badge/license-Apache--2.0-22c55e.svg)](LICENSE)

**Stay in ChatGPT. Work on your local machine. Bring in Codex only when you actually need it.**

</div>

Codexless gives the ChatGPT you're already talking to a tested set of local capabilities backed by the Codex tooling already on your machine.

Set up an environment, maintain a project, edit files, run commands, inspect or operate a browser — **start by telling ChatGPT what you want done. If the exposed tools are enough, it keeps working. When the task really needs Codex, it can bring Codex in explicitly.**

**Fewer unnecessary Codex calls means less Codex usage. Save that quota for the calls that actually need it.** That's the **less** in Codexless.

> **Curious? Give this repository to the ChatGPT you already use and ask it to check whether your machine can run Codexless and what you'll be able to do after setup.**

---

## What can it actually do?

### 1. Hand ChatGPT Codex's local toolbox

The ChatGPT you're already talking to can use the local capabilities Codexless has tested and exposed.

Inspect a project, set up an environment, handle maintenance, edit files, run commands, check the result — and stay in the same conversation.

**Plain English: work that used to force a handoff to Codex can often continue right where you are.**

These supported tool actions **do not call the Codex model and do not consume Codex quota.**

---

### 2. A second path when Codex updates

Codexless can keep using the Codex toolbox already installed on your machine, and Recommended setup also prepares a **pinned official Codex runtime** as a second, independent tool path. It does not replace the local Codex you already use.

After one additional official ChatGPT sign-in, file and command work can use the pinned runtime. If a local Codex update temporarily causes a compatibility problem, those tools still have an independent path. If you skip the extra sign-in for now, the local Codex path keeps working normally.

**Your local Codex is still required: Browser and Call Codex currently use it.** The two paths stay independent. If one fails, Codexless reports that failure instead of silently switching to the other. The pinned runtime uses its own isolated login; Codexless does not copy credentials from your existing Codex setup.

---

### 3. Reuse what Codex already knows

Project rules, Skills, directory conventions — when Codexless can safely reuse them, it does.

**Don't teach the same setup twice. Don't build a second stack.**

> **Take the toolbox. Bring the manual too.**

There is a longer-term benefit as well: **as the Codex toolbox evolves, Codexless does not have to rebuild every useful capability from scratch.** New capabilities can be promoted after they have been re-tested and accepted for the public surface.

That does **not** mean every Codex update instantly becomes a ChatGPT capability. If it has not been tested and accepted, it is not part of the public promise.

---

### 4. Start with ChatGPT. Bring in Codex when needed

**ChatGPT can be your default starting point.** Give it the task. If the current tools are enough, it keeps going. If the work really needs Codex, it can escalate from the same Chat. Prefer to open Codex directly? That's fine too — Codexless does not lock you into one workflow.

When it really is time to call Codex, Codexless **asks first**:

1. what it wants Codex to do;
2. how much Codex quota you have left right now;
3. whether to make the call — Yes or No;
4. after the run, how much was used and how much remains.

> **Keep working in ChatGPT. Bring in Codex when you actually need it.**

If the current Chat cannot render the Task Card, Codexless falls back to a plain-text confirmation. You still have to answer Yes or No; it never auto-approves the call.

<p align="center">
  <img src="docs/images/codex-task-card-flow.gif" width="100%" alt="Codex Task Card showing call, running, and completed states">
</p>

---

### 5. ChatGPT can work inside Chrome too

**It can do more than look at a page — it can carry out a bounded set of browser actions as well.**

The current public Browser surface supports:

- reading tabs and page content, plus viewport screenshots;
- opening, closing, and navigating pages;
- semantic clicks and text entry;
- bounded scrolling and `Enter` / `Tab` / `Escape`;
- prepared uploads and downloads.

#### Browser prerequisites

Chrome must be installed on the same machine, with the ChatGPT browser extension installed and connected in the Chrome profile you actually use.

For local file upload, the extension also needs **Allow access to file URLs** enabled.

---

## Is this for me?

**Probably yes if:**

1. you already use ChatGPT + Codex on real projects and are tired of moving context back and forth or maintaining two separate setups;
2. Codex quota is often tight and you want to save it for work that genuinely needs Codex;
3. you have a long-running AI assistant or companion you already know and trust, and would rather give that familiar assistant local hands than switch to a different agent every time real work starts.

**Probably not if:** you use Codex for nearly everything, already maintain mature custom agent infrastructure, or need unrestricted browser / desktop automation.

---

## Before you install

- **Platforms:** Windows + **Apple Silicon macOS (`arm64`)** Technical Preview. Intel Mac is not supported yet.
- **Prerequisites:** **Node.js 22+** and one working local **Codex** installation. Codex Desktop is optional; a working CLI/runtime is enough.
- **Recommended dual runtime:** A working local Codex is still required. Recommended setup also prepares Codexless's pinned official Codex runtime as an independent tool path; it does not install or replace your local Codex.
- **Browser:** Chrome and the ChatGPT browser extension must be installed and connected on this machine. Browser work uses the current Chrome profile and its site login state.
- **Upload:** local file upload additionally requires the extension's **Allow access to file URLs** setting.
- **Personal ChatGPT plans tested:** Plus and Pro have both passed real-machine product-path testing. That is test evidence, not a promise about future plan policy.
- **How local access works:** ChatGPT does not connect directly to `localhost`. A typical path is **local Codexless → authenticated Tunnel / remote MCP endpoint → ChatGPT App / Developer Mode**.
- **No tunnel lock-in:** OpenAI Secure MCP Tunnel is one supported path, not the only possible transport.
- **Independent project:** Codexless is not an OpenAI product and does not imply OpenAI endorsement.

---

## Install

**Make sure you already have Node.js 22+ and a working local Codex installation. The installer checks those prerequisites; it does not install Node/npm, and it does not install or replace that local Codex for you. Recommended setup also prepares Codexless's pinned official Codex runtime.**

If you would rather not inspect the environment yourself, give this repository to your AI assistant and ask it to check your platform, Node version, Codex installation, and install path first.

Final decisions about local execution, permissions, and trust are still yours.

**To install Codexless, check out or download the release/tag you want and run the installation command for your platform. To move to a newer preview later, get the newer release/tag and run the same installation command again. User state stored outside the install tree is preserved.**

### Windows

Install:

```powershell
.\bin\codexless-install.cmd
```

Default install directory:

```text
%LOCALAPPDATA%\Codexless
```

Check a project:

```powershell
& "$env:LOCALAPPDATA\Codexless\bin\codexless-doctor.cmd" --cwd "C:\path\to\your\project"
```

Start HTTP:

```powershell
& "$env:LOCALAPPDATA\Codexless\bin\codexless-http.cmd"
```

Uninstall:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\Codexless\scripts\uninstall.ps1"
```

### Apple Silicon macOS

The current preview supports Apple Silicon (`arm64`) only.

Install:

```sh
sh ./bin/codexless-install.sh
```

Default install directory:

```text
~/Library/Application Support/Codexless/app
```

Check a project:

```sh
"$HOME/Library/Application Support/Codexless/app/bin/codexless-doctor.sh" --cwd "/path/to/your/project"
```

Start HTTP:

```sh
"$HOME/Library/Application Support/Codexless/app/bin/codexless-http.sh"
```

Uninstall:

```sh
"$HOME/Library/Application Support/Codexless/app/bin/codexless-uninstall.sh"
```

### What does the installer do?

On both platforms, the installer checks Node.js and the local Codex runtime, installs dependencies in a staging area, and, for Recommended setup, prepares the pinned official Codex runtime. It runs doctor checks and activates the final install only after those checks pass.

It does not install Chrome or the browser extension, configure a Tunnel, or silently widen Codex trust. Browser upload permissions also remain an explicit user-side setting.

To move to a newer version, get the newer release/tag and run the same installation command again. Codexless does not check for or install updates automatically.

---

## FAQ

### 1. Does using Codexless consume Codex quota?

- **Codexless can let ChatGPT do many tasks that would otherwise need Codex. If Codex is not actually called, no Codex quota is used.** Codex quota is used only when you actually start Codex Agent work.
- **Work and Codex share the same quota pool.** Using Codexless inside a Work window does not bypass the usage that Work itself consumes. If your goal is to save Codex quota, **we recommend using Codexless from a normal Chat.**

---

### 2. What if Codex quota reaches 0%? Can Codexless still work?

**Yes. Everything already supported keeps working except the parts that actually call Codex.**

Reading, searching, editing, verification, and the supported model-free Browser actions can keep working.

When Codex quota is available again, you can call Codex again.

---

### 3. Is saving Codex quota the same as bypassing quota, plan limits, or platform rules?

**No. Saving quota means making fewer Codex model calls — not increasing, resetting, transferring, merging, or bypassing anyone's quota or plan limits.**

When the accepted model-free tools are enough, Codexless uses those tools instead of needlessly calling the Codex model. When Codex is actually called, normal Codex usage still applies.

Codexless is built on Codex App Server and ChatGPT app / MCP integration surfaces. It does not reverse-engineer a private UI or secret protocol to evade product boundaries.

It also does not route around local trust / permissions, approvals, sandbox or network boundaries, or platform confirmation requirements. If an upstream supported surface or policy changes, Codexless must adapt to the supported path or fail visibly — not secretly bypass the change.

---

### 4. How much access does this get? Can it change or delete local files?

**By default, the permission ceiling follows the authorization your local Codex already has. Codexless cannot silently widen that ceiling.**

Codexless can narrow permissions further for individual actions.

If you want a more conservative setup, tighten the relevant project trust or Codex permissions locally. A real permission / trust denial should fail visibly rather than silently switching to a stronger path just to make the task succeed.

See [`SECURITY.md`](SECURITY.md) for the full boundary.

---

### 5. Does ChatGPT get everything Codex can do?

**No.**

Codexless exposes only capabilities that have been reviewed and accepted for the public surface; it does not expose the entire Codex environment.

The current public service contract contains **39 tools**. The model directly sees **36** of them; three Task Card actions are app-only.

Actual Codex model work uses the dedicated Agent + approval flow. Ordinary local tool actions are not a hidden second route into metered Codex work.

The lower-level consent / commit / replay details are summarized in the internals section below.

---

### 6. Can the Browser operate websites for me?

**Yes.**

It can inspect tabs, capture screenshots, open / close / navigate pages, click semantic targets, fill text, scroll, press `Enter` / `Tab` / `Escape`, and perform prepared uploads and downloads.

It is intentionally not unrestricted browser control. Codexless does not expose arbitrary JavaScript, raw selectors, arbitrary coordinates, unrestricted keyboard input, generic CDP, or automatic Computer Use fallback.

Browser work uses the current local Chrome profile and its site login state. Local file upload additionally requires **Allow access to file URLs** in the extension settings.

---

### 7. Do I have to change my “plan in ChatGPT → execute in Codex” workflow?

**No.**

You can keep thinking, planning, and talking things through in ChatGPT.

If the current tools are enough, ChatGPT can continue and finish the work. When you genuinely need Codex, escalate explicitly.

Codexless reduces unnecessary handoffs; it does not force you to abandon a workflow you already like.

---

### 8. I thought ChatGPT could not access my local machine. How does Codexless do it?

Right: ChatGPT does not directly access your computer's `localhost`.

Codexless exposes the local service through an **authenticated MCP path**:

> **local Codexless → authenticated Tunnel / remote MCP endpoint → ChatGPT App / Developer Mode**

ChatGPT receives the Codexless tools exposed through that surface; it does not simply get unrestricted access to your whole computer.

Do not put Tunnel / endpoint credentials in the repository or public screenshots.

---

## For people who want the internals

### 1. Public contract

The current public service contract contains **39 tools**. The model directly sees **36**; three Task Card actions are app-only.

Metered Agent consent is server-side state: task identity is not approval. Codex dispatch still requires the matching approval / commit path, and a declined task cannot be revived by replaying an older request.

The exact surface is fixed in `src/surface-contracts.mjs` and covered by the public contract tests.

Run:

```powershell
npm test
```

### 2. Permission model

Codex remains the local permission / trust authority.

- Codexless can downscope permissions.
- A remote caller cannot silently select a stronger local permission profile.
- Real permission / trust denials fail visibly.

### 3. Browser boundary

The public Browser surface exposes reviewed user-intent actions rather than raw browser internals.

Current public actions include tab/page reads, screenshots, open / close / navigation, semantic click, text fill, bounded scroll, fixed `Enter` / `Tab` / `Escape`, file selection for upload, and browser-managed download.

It does not expose arbitrary JavaScript, raw selectors, arbitrary coordinates, unrestricted keyboard input, generic CDP, or automatic Computer Use fallback.

### 4. Integration model

Codexless is built around Codex App Server and ChatGPT app/MCP integration surfaces rather than reverse-engineering a private UI.

### 5. Current Technical Preview evidence

Windows and Apple Silicon macOS have both passed real-machine install / doctor / stdio acceptance.

Browser work has also been dogfooded on real Windows and Apple Silicon Mac machines. Release/source-candidate validation is tracked separately from the source-level capability contract rather than inferred from it.

### 6. Run from source

```sh
npm ci
npm run start:stdio
```

HTTP:

```sh
npm run start:http
```

If automatic discovery cannot find a currently accepted Codex executable, you can set `CODEX_BIN` explicitly.

On Windows, do not point `CODEX_BIN` at the npm `.cmd` / `.ps1` shim.

---

## For AI assistants

If a user sends you this repository and asks “What is this? Do I need it? Is it safe?”, inspect the actual repository and the current machine before making a recommendation.

Start with these facts:

1. Codexless lets ChatGPT use a set of **accepted Codex-backed local capabilities**; Codex remains an explicit expert escalation path.
2. It **does not increase or bypass Codex quota**. Ordinary tool work and actual Codex model work are separate paths.
3. The permission ceiling comes from effective local Codex authorization; a remote caller cannot silently widen it.
4. The public Browser surface can now read and operate a bounded set of browser actions, but it does not expose raw Browser internals.
5. Browser work requires local Chrome plus the ChatGPT browser extension; local file upload has one additional file-URL permission requirement.
6. Codexless is an independent project, not an OpenAI product or endorsement.

---

> **Keep working in ChatGPT. Bring in Codex for the hard parts.**
>
> **That's Codexless: not no Codex — just fewer unnecessary Codex calls.**
