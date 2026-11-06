# 发到上游用的帖子草稿

目标仓库：https://github.com/mashangshui/digital-life-core

- Discussions 入口：https://github.com/mashangshui/digital-life-core/discussions
- 新建讨论：https://github.com/mashangshui/digital-life-core/discussions/new/choose
- 没有 Discussions 时的备用：https://github.com/mashangshui/digital-life-core/issues/new

发之前先看一眼那个仓库有没有 Discussions 标签。没有的话只能开 Issue，
但作者在 README 里声明了不答疑、不审 PR，那种情况下收益很低。

分类建议选 Show and tell 或 General。

---

## 正文

## 给她的记忆加一个「人」的维度

内置海马体有锚点、有注意力倾斜、有情绪反馈，但它没有「人」这个概念——
问它「我认识哪些人」，答不出来，因为没有这个聚合视图。

我加了一个可选器官补这块：

- 人物档案、关系、事件；一条记忆只存一份，人物那边是索引，改一处不会分叉
- 双分量衰减：细节忘得快，事情的"存在感"几年不散
- 压缩只发生在展示层，原话一个字不删，权重决定给你看原话、一句摘要、还是一个影子
- 想起会回温：同一件事被翻出来一次，它就重一点
- 认不出是谁的时候不编，挂个账，合适时机自然问一句

接入方式没有改任何核心代码：manifest 里写 `kind: 'memory'`，
核心扫到会自动把记忆路由指过来。

```
[life-os] 记忆路由已接她的海马体：listener（想起→organ_listener_recall，记下→organ_listener_remember）
```

装法：把 `listener.ts` 放进 `web-ui/organs/self-made/`，重启 DSH。

接上之后这几样是白拿的：锚点（存记忆时的情绪快照）、注意力倾斜、命中反馈、未命中累积成缺口。
代价是每次调用都花她的能量，返回还会被 4000 字预算再加工一遍。

已知限制：

- 没有长期跑的实测数据，只有 33 项自测
- 记忆路由按名字排序抢占，装第二个记忆器官会打架
- 检索是二元组倒排加同义表，不是向量，语义距离远的关联会漏

仓库：https://github.com/pit2419/dsh-character-long-memory
版本：v1.1.6
