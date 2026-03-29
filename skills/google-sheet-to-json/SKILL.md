---
name: google-sheet-to-json
description: 将从 Google Sheet 复制的制表符分隔（TSV）表格数据转换为多个 i18n JSON 代码块。第一列为翻译 key，其余列为不同语言的 value。使用 PapaParse + delimiter '\t' 解析。当用户粘贴 Google Sheet 表格数据并要求输出 JSON、生成多语言翻译文件时使用。
disable-model-invocation: true
---

# Google Sheet TSV → i18n JSON

## 数据格式说明

- **第一列**：翻译 key（如 `limit-detail.title`）
- **第二列起**：每列对应一种语言的翻译 value
- **可选首行（推荐）**：语言代码/名称作为列标题，例如 `key	en	ja	id`
  - 若首行第一列不含 `.`，则视为标题行，语言名取自标题
  - 若无标题行，自动命名为 `lang1`、`lang2`...

## 工作流程

1. **保存 TSV 数据**：将用户粘贴的文本写入 `/tmp/tsv_input.tsv`
2. **google-sheet-to-json/scripts 脚本目录是否有 node_modules**：没有安装的话需要执行 `npm install` 安装依赖。
3. **执行解析脚本**：
   ```bash
   node .cursor/skills/google-sheet-to-json/scripts/parse-tsv.js
   ```
4. **格式化输出**：按脚本输出的 `===LANG:名称===` 分隔符，为每种语言生成独立 JSON 代码块

> 脚本位于 `.cursor/skills/google-sheet-to-json/scripts/parse-tsv.js`，首次运行会自动安装 `papaparse` 到脚本同目录的 `node_modules/`，后续无需重复安装。

## 输出示例

脚本执行后，将每个语言块格式化为独立代码块输出给用户：

**en：**

```json
{
  "limit-detail.available-limit-tooltips-popup-title": "Outstanding Balance",
  "limit-detail.general-limit-title-v3": "Available Limit"
}
```

**ja：**

```json
{
  "limit-detail.available-limit-tooltips-popup-title": "未払い残高",
  "limit-detail.general-limit-title-v3": "利用可能枠"
}
```

## 注意事项

- 如需自定义语言名称，在粘贴数据时添加首行标题，例如：
  ```
  key	en	ja	id
  some.key	Hello	こんにちは	Halo
  ```
- 包含 `\t` 字符的值会自动被 PapaParse 处理（勿手动转义）
- 脚本复用 `/tmp` 目录，如需保留中间文件请自行调整路径
