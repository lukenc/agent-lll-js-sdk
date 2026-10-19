<!--
本文件是**指针**，不是内容。工程规范的唯一真源是同目录的 AGENTS.md。

为什么需要这一层：部分工具只读 CLAUDE.md、不读 AGENTS.md，
所以下面那一行 @AGENTS.md 是必需的 —— 删掉它，这些工具就完全看不到项目规范
（包括 Definition of Done 与 Invariants）。

维护规则：
- **不要在下面追加内容**；需要新规则就写进 AGENTS.md。
- 这里用 @import 而不是 symlink，因为 Windows 上建符号链接需要管理员权限或开发者模式。
- 导入的文件在加载时展开，成本与内容直接写在这里相同。
- 本注释是 block-level HTML comment，加载时会被剥掉，不占上下文。
-->

@AGENTS.md
