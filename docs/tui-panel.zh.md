# OPS 只读侧栏

[English](tui-panel.md)

## 启用

在 dsh-TUI profile 中启用已有的 `dsh-ops/tui` bundle 行并重启；默认关闭。使用实验性 `tuiPanels` API v1，需要包含「按导出子组件入口最近的包清单准入」修复的 TUI 构建。只识别外层包清单的旧构建不能保证正确的组件身份。

修改已有行，不要添加重复行：

```yaml
id: dsh-ops-tui
name: dsh-ops/tui
disabled: false
config:
  maxSessions: 32
  maxActive: 128
  recentLimit: 8
```

添加 OPS 标签，不强制打开或抢焦点。不新增 TUI/React 运行时依赖，使用宿主提供的 React 与 UI 原语。没有 `tuiPanels` 时只有该可选行等待；API v1 注册被拒绝时不启动观测。原 OPS 操作权限不变；UI 子组件拥有独立清单，不要求工具契约、不申请权限、不注册命令，也不拦截决策事件。

## 显示内容

- 当前选中会话自该组件启用后观察到的原生与 PTC OPS 调用。
- 调用数、运行中、传输返回/错误与最近观察耗时。
- 达到上限时明确标记统计不完整。「已返回」是中性状态，**不代表业务成功**；后台任务启动调用返回不代表任务已经完成。

这不是历史重放或持久用量统计。关闭再打开面板不重置观测，卸载组件才清空。不保留命令、参数、搜索模式、替换文本、路径、结果正文或错误正文。切换会话只切换快照，不增加模型/worker 调用、job_output 读取、轮询、提示词段落或 token 节省估算。不提供删除、重试、提权或发送给模型按钮。

## 上限

TUI 行只接受以下键：

| 键 | 默认 | 范围 |
| --- | ---: | --- |
| `maxSessions` | 32 | 1–256 个保留会话，LRU 淘汰 |
| `maxActive` | 128 | 每会话跟踪 1–1024 个进行中调用 |
| `recentLimit` | 8 | 每会话 1–64 条已结算记录 |

限制的是观测内存，不是工具执行。进行中记录达到上限后省略新调用，并标记统计不完整；淘汰会话只丢统计，不取消工作。使用完整 component 面板；当前 TUI API 的 compact 专用渲染和 send-to-chat 均不在范围内。

## 验证

```console
node test/run.mjs tui-activity tui-panel manifest
DSH_OPS_TUI_ROOT=/path/to/dsh-TUI DSH_OPS_REQUIRE_TUI=1 node test/run.mjs tui-host
```

可选宿主用例从同一个 TUI 检出或构建包解析 React/Cordis/渲染依赖，在任何 TUI 导入前隔离 HOME/USERPROFILE/DSH_HOME，验证真实 Loader 准入、OPS 导出子路径、inline/fullscreen 的 28/38 列面板、会话切换和卸载。工具事件是合成数据，不等于 Windows 原生执行、OS 沙箱或真实 PTY 手工验收。未设置路径时明确记为跳过；`DSH_OPS_REQUIRE_TUI=1` 使缺少路径成为失败。

侧栏不改变整包声明的 Windows x64、Linux x64 和 macOS arm64 目标；UI 测试本身不能替代原生执行或 OS 沙箱验收。
