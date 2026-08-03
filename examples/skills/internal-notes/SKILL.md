---
name: internal-notes
description: 仅供宿主程序读取的内部说明，不暴露给大模型。
disable-model-invocation: true
---

# 内部说明

这个技能设置了 `disable-model-invocation: true`：

- 不会出现在系统提示的技能清单里
- 大模型无法通过 `skill` 工具调用它
- 宿主代码仍可通过 `agent.skills.get('internal-notes')` 读取
