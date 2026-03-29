/**
 * 用法：node parse-tsv.js <input.tsv>
 * 若不传文件路径，从 /tmp/tsv_input.tsv 读取
 *
 * 输出格式：每种语言以 ===LANG:名称=== 开头，后跟 JSON
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const scriptDir = __dirname;
const papaparsePath = path.join(scriptDir, 'node_modules/papaparse');
if (!fs.existsSync(papaparsePath)) {
  console.error('[setup] Installing papaparse...');
  execSync('npm install papaparse --silent', { cwd: scriptDir, stdio: 'inherit' });
}

const Papa = require(papaparsePath);

const inputPath = process.argv[2] || '/tmp/tsv_input.tsv';
const input = fs.readFileSync(inputPath, 'utf8');

const result = Papa.parse(input, {
  delimiter: '\t',
  skipEmptyLines: true,
});

if (result.errors.length) {
  console.error('Parse warnings:', result.errors);
}

const rows = result.data;
if (!rows.length) {
  console.error('No data found in input file.');
  process.exit(1);
}

// 首行第一列不含 "." 则视为标题行（语言名）
const hasHeader = !rows[0][0].includes('.');
const langNames = hasHeader
  ? rows[0].slice(1)
  : rows[0].slice(1).map((_, i) => `lang${i + 1}`);
const dataRows = hasHeader ? rows.slice(1) : rows;

langNames.forEach((lang, idx) => {
  const json = {};
  dataRows.forEach(row => {
    const key = row[0]?.trim();
    const val = row[idx + 1] ?? '';
    if (key) json[key] = val;
  });

  // 情况1：整列均为空值 → 跳过，不输出该语言块
  const allEmpty = Object.values(json).every(v => v === '');
  if (allEmpty) return;

  // 情况2：部分为空 → 正常输出，空值保留为空字符串
  console.log(`===LANG:${lang}===`);
  console.log(JSON.stringify(json, null, 2));
});

fs.unlinkSync(inputPath);
