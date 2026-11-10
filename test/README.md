# 测试说明

## 自动跑

```bash
node test/smoke.mjs
```

不需要 DSH 运行时。检查项：

1. `index.js` 能被 import
2. 导出 `name` / `inject` / `apply` 结构正确
3. 15 个 `web_*` 工具名在源码里齐全
4. 必需文件存在（package.json / README / LICENSE / icon / patch / 双语 locale）
5. `package.json` 有 `license` 和 `repository`

## 手动跑（需要 DSH 运行时，验证真实浏览器行为）

1. `web_launch` —— 起插件自己的浏览器，拿 `web_status` 确认端口和 profile
2. `web_navigate` url=https://example.com newTab=true
3. `web_snapshot` —— 确认能读到页面元素 ref
4. `web_eval` expression=`({title: document.title})` —— 确认返回值被包成 `{ result: ... }`
5. `web_shot` —— 截图确认
6. `web_tabs` action=close —— 确认标签能关

## 已知边界（不是 bug，是设计取舍）

| 场景 | 行为 |
|---|---|
| 滑块 / 拼图 / 短信 / 人脸验证 | 不自动处理。绕过人机验证会触发风控，也不合规 |
| `showDirectoryPicker` / `showOpenFilePicker` | 需要人手动点一次。CDP 没有稳定接口 |
| `<input type="file">` | 可以，用 `web_upload`（CDP `DOM.setFileInputFiles`）|
