# Browser Ops 8（v8.2）—— 自带浏览器的通用操作插件

包名 `@local/browser-ops8`，源码 `DSH输出\_plugins\browser-ops8`，14 个 `web_*` 工具。

## 这一版改了什么

| 问题（实测） | 改法 |
|---|---|
| `web_navigate` 超时直接抛异常 | 结构化返回 `{ ok:false, stage, error, hint }`，并继续读页面状态；超时不算失败 |
| `web_eval` 返回字符串/数字报 must be an object | 底层兜底：任何返回值都包成 `{ result: ... }` |
| 只能靠 waitMs 硬等 | `web_wait` 增加 `networkIdle`：在途请求为 0 持续 idleMs + DOM 签名稳定 |
| 上传只能点系统框 | 新增 `web_upload`，用 `DOM.setFileInputFiles` 直接塞文件 |
| 关标签只能一个一个关 | `web_tabs action=close` 支持 `all` + `keep` 或 `indexes` 批量 |
| 两个工具做同一件事 | 删掉 `web_wait_idle`，能力并入 `web_wait networkIdle=true` |

## 十四条工具

| 工具 | 用途 |
|---|---|
| `web_launch` | 启动或复用插件自己的浏览器（持久 profile） |
| `web_status` | 运行状态、版本、profile、标签列表 |
| `web_tabs` | list / new / activate / close（可批量） |
| `web_navigate` | 打开网址，可新标签；超时不抛错 |
| `web_snapshot` | 页面语义轮廓，元素给 `[eN]` 引用 |
| `web_act` | 按 ref / 文字 / 选择器执行 click、type、select、check、submit |
| `web_key` | 按键 |
| `web_scroll` | 滚动 |
| `web_shot` | 截图 |
| `web_eval` | 执行 JS（返回值任意类型都行） |
| `web_wait` | 等条件 + 可选的网络空闲 |
| `web_upload` | 给 file input 塞文件 |
| `web_click` | 原始坐标点击 |
| `web_drag` | 原始拖拽 |

## 等页面真正稳下来

抓懒加载列表的标准三步，不再靠猜时间：

    web_scroll direction=bottom
    web_wait networkIdle=true idleMs=1000
    web_snapshot

`networkIdle=true` 同时满足两件事：

1. 没有任何请求在途，且持续 idleMs 毫秒
2. DOM 签名稳定：元素数量、滚动高度、文本长度在这段时间内没变

## 批量关标签

    web_tabs action=close all=true keep=[0]
    web_tabs action=close indexes=[2,3,4]

## 两条明确不做的事

### 1. 滑块 / 拼图 / 短信 / 人脸验证

拉勾的「按住滑块拖到最右边」、豆瓣发表的腾讯拼图、BOSS 的短信码，一律不自动处理。

这些是平台专门设置的人机验证；拖动靠碰运气，失败还可能触发风控封号，绕过它越界。

分工：验证那一下由人做，其余全自动。

### 2. 浏览器原生目录选择框（showDirectoryPicker）

CDP 没有稳定接口去选中一个目录，那是操作系统级对话框。

- input type=file → `web_upload` 能过
- showDirectoryPicker / showOpenFilePicker → 只能人手动点一次

章节复制器的「选目录」属于后者，只需选一次。

## 需要重启一次

改动都在源码里，当前会话模块已缓存。重开 DSH 后全部生效：工具数 13 变 14（去掉 web_wait_idle，加上 web_upload）。
