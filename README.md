# AI Girl Quota (`aigirl-quota`)

Antigravity 虚拟形象与额度监控插件（Auxiliary Side Pane UI Plugin）。

<img width="1070" height="738" alt="image" src="https://github.com/user-attachments/assets/9b75625f-77cf-4cd3-a445-1f2cd7f4b370" />


## 功能特性

- **双虚拟形象展示**：在 Antigravity 右侧面板（Aux Pane）展示 `Claude.png` 与 `Gemini.png` 透明背景立绘。
- **双维度 HP 血量条**：实时展示 **5 小时限额（5H Limit）** 与 **周限额（Weekly Limit）** 剩余百分比。
  - `>= 70%` 翡翠绿 / `40% - 69%` 琥珀金 / `15% - 39%` 珊瑚橙 / `1% - 14%` 警戒红 / `0%` 枯竭灰。
  - 带有丝滑缓动动画与残影掉血条（Trail Bar）。
- **动态重置小时钟**：每个血条旁附带实时走动的 SVG 指针时钟与倒计时环，悬浮可查看精确本地重置时间。
- **模型状态区别化高亮**：
  - **Claude 系列**：Claude 形象激活暖金光环与悬浮呼吸特效。
  - **Gemini 系列**：Gemini 形象激活星穹紫青光环与悬浮呼吸特效。
  - **Orchestrator 模式**：顶部切换为流光协同徽章；若当前任务同时调用了 Gemini 与 Claude 系列模型，双方形象同时高亮并激活「双系协同」光束连接。
- **耗尽变灰遮罩**：当某系列模型额度归零不可用时，对应形象自动切换为灰度去色 + 磨砂锁止遮罩，并显示重置倒计时。
- **效果预览**：内置「模拟预览」面板方便随时预览各类状态。

## 安装与更新（Windows）

1. **克隆或下载本仓库**到本地任意目录：
   ```powershell
   git clone https://github.com<你的用户名>/<你的仓库名>.git
   cd <你的仓库名>
   ```
   *(或者点击页面右上角 `Code` -> `Download ZIP` 并解压)*

2. **运行安装脚本**（首次安装及后续拉取代码更新均运行此命令）：
   ```powershell
   powershell -ExecutionPolicy Bypass -File .\install.ps1
   ```
   *(如果系统允许直接执行脚本，也可以直接运行 `.\install.ps1`)*

3. **重启 Antigravity**，即可在右侧面板看到 **AI Girl Quota**。

