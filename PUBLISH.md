# 发布 / 分发说明

## 先看清楚它是什么

`listener.ts` 是一个 **DSH 自写器官**，不是 npm 插件包。

安装方式是：丢进 `web-ui/organs/self-made/` 目录，宿主自动编译装载；或者让 AI 调 `write_new_organ` 写入。

这意味着它**不能**直接上架插件市场。市场（dshmarket）装的是 npm 包（bundle），走的是 `plugin_manager install_bundle` 那条路，跟器官是两套东西。

---

## 一、发到 GitHub（已替你做完本地部分）

这个目录已经 `git init` 并提交过了。你需要做的只有：

1. 在 GitHub 新建一个空仓库，比如 `listener-organ`
2. 在这个目录执行：

```bash
git remote add origin https://github.com/<你的用户名>/listener-organ.git
git branch -M main
git push -u origin main
```

HTTPS 方式需要 Personal Access Token（Settings → Developer settings → Tokens），密码方式早就不能用了。SSH 方式需要先把公钥传到 GitHub。

我这边没有你的凭据，也不该有，所以这一步只能你来。

---

## 二、上架插件市场：现在上不去

原因不是权限，是形态不对。

| | 器官 | 市场 bundle |
| --- | --- | --- |
| 形态 | 单个 `.ts`，`defineOrgan({...})` | npm 包，Cordis 插件 |
| 安装 | 放进 `self-made/` | `plugin_manager install_bundle` |
| 存储 | `ctx.kv` | `ctx.storage` 服务 |
| 工具注册 | `ctx.registerTool` | `ctx.tools.register` |

要上架，得把它重写成标准插件包。具体要改的地方：

1. **入口**：`export default defineOrgan({...})` → Campus 插件函数 `export function apply(ctx, config)`。
2. **存储**：`ctx.kv.get/set` → `ctx.storage` 的 domain facility。
3. **工具**：`ctx.registerTool({name, description, parameters, execute})` → `ctx.tools.register(...)`，参数格式要重新对一遍（市场这边是 JSON Schema，跟器官的"属性表"格式不一样）。
4. **提示词注入**：`getPromptContext` → `ctx.systemPrompt.context(...)`。
5. **定时任务**：`ctx.onTick` → `ctx.timer.interval(...)`。
6. **化学那部分**（`ctx.inflict`）是数字生命专有的，市场版必须去掉或做成可选，否则会报"未知能力"。
7. **package.json**：要有 `name`、`version`、`dsh` 字段、`main` 入口。

这不是打包，是重写。代码逻辑能复用八成，但外壳全换。

---

## 三、我的建议

先发 GitHub，别急着上市场。

理由：

- 器官版本已经跑通、有测试、有文档，现在就能用。
- 市场版本要重写一遍外壳，还要跟市场的 schema 再对一次，出错面很大。
- 更重要的是：市场里别人装的是 bundle，**你不能保证他们装了 digital-life-core**。而这个插件的情绪部分强依赖它。去掉之后，它就只剩一个记忆库——那市面上已经有好几个了。

如果确实要上市场，先告诉我，我去把 dshmarket 的包格式查清楚，再决定改到什么程度。
