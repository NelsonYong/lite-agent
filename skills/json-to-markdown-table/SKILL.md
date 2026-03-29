---
name: json-to-markdown-table
description: 将 JSON 数据（包括格式不规范的 JSON）转换为两列 Markdown 表格，第一列表头为"键值"，第二列为对应的翻译值（英语/中文/本地语言）。当用户提供 JSON 数据并要求转成表格、生成对照表，或进行多语言翻译并输出表格时使用。表格必须始终输出。
disable-model-invocation: true
---

# JSON 转 Markdown 表格

## 核心规则

- **表格必须输出**，无论 JSON 内容多少，都要生成完整的 Markdown 表格
- 第一列表头固定为 `键值`，第二列表头根据语言决定（如 `英语`、`中文`、`本地` 等）
- 若 JSON 格式不规范（缺引号、多余逗号、注释等），先自动修正再处理，不要报错中断
- 只有 `英语`、`中文` 需要显式展示，其他语言均为 `本地`
- 直接输出 markdown 表格，禁止在代码块中输出

## 输出格式

```markdown
| 键值 | {语言} |
| ---- | ------ |
| key1 | value1 |
| key2 | value2 |
```

## 处理步骤

1. **解析 JSON**：识别所有键值对；若格式有问题，容错修正后继续
2. **确定第二列表头**：根据值的语言或用户指定决定（英语 / 中文 / 本地语言名称）
3. **生成表格**：每行对应一个键值对，键放第一列，值放第二列
4. **处理特殊字符**：值中的竖线 `|` 替换为 `\|`，换行替换为空格

## 示例

**输入 JSON（英语）：**

```json
{
  "limit-history.granted": "Granted",
  "limit-history.expired": "Expired"
}
```

**输出：**

```markdown
| 键值                  | 英语    |
| --------------------- | ------- |
| limit-history.granted | Granted |
| limit-history.expired | Expired |
```

**输入 JSON（日语）：**

```json
{
  "limit-history.granted": "付与済み",
  "limit-history.expired": "失効"
}
```

**输出：**

```markdown
| 键值                  | 本地     |
| --------------------- | -------- |
| limit-history.granted | 付与済み |
| limit-history.expired | 失効     |
```

## 多语言对照表（可选）

如果用户提供多个语言版本，可生成多列对照表：

```markdown
| 键值 | 英语 | 中文 | 本地 |
| ---- | ---- | ---- | ---- |
| key  | val  | val  | val  |
```
