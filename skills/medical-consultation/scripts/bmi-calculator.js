// BMI (Body Mass Index) Calculator
// 身体质量指数计算器

/**
 * Calculate BMI and provide health assessment
 * @param {number} weight - Weight in kilograms
 * @param {number} height - Height in centimeters
 * @returns {object} BMI calculation result with health assessment
 */
function calculateBMI(weight, height) {
  // Validate input
  if (!weight || !height || weight <= 0 || height <= 0) {
    throw new Error('Invalid input: weight and height must be positive numbers');
  }

  // Convert height from cm to meters
  const heightInMeters = height / 100;

  // Calculate BMI
  const bmi = weight / (heightInMeters * heightInMeters);

  // Determine BMI category (WHO standards for Asian population)
  let category = '';
  let healthStatus = '';
  let risks = [];
  let recommendations = [];

  if (bmi < 18.5) {
    category = '体重过轻 (Underweight)';
    healthStatus = '偏瘦';
    risks = ['营养不良', '免疫力下降', '骨质疏松风险'];
    recommendations = [
      '增加营养摄入，确保均衡饮食',
      '适量力量训练增加肌肉量',
      '咨询营养师制定增重计划',
      '排查是否有甲亢、糖尿病等疾病'
    ];
  } else if (bmi >= 18.5 && bmi < 24) {
    category = '正常体重 (Normal weight)';
    healthStatus = '健康';
    risks = [];
    recommendations = [
      '保持当前健康的生活方式',
      '继续均衡饮食和规律运动',
      '定期体检监测健康指标'
    ];
  } else if (bmi >= 24 && bmi < 28) {
    category = '超重 (Overweight)';
    healthStatus = '超重';
    risks = ['心血管疾病风险增加', '糖尿病风险', '高血压', '关节负担加重'];
    recommendations = [
      '控制总热量摄入（减少500-750 kcal/天）',
      '增加有氧运动（每周150分钟）',
      '减少精制碳水和高脂食物',
      '目标：3-6个月减重5-10%',
      '监测血压、血糖、血脂'
    ];
  } else {
    category = '肥胖 (Obese)';
    healthStatus = '肥胖';
    risks = [
      '高血压、高血脂、糖尿病高风险',
      '心脑血管疾病',
      '脂肪肝',
      '睡眠呼吸暂停',
      '某些癌症风险增加'
    ];
    recommendations = [
      '建议就医评估代谢综合征',
      '制定专业减重计划',
      '控制饮食 + 增加运动',
      '必要时考虑药物或手术治疗',
      '定期监测：血压、血糖、血脂、肝功能'
    ];
  }

  // Calculate ideal weight range (for normal BMI 18.5-24)
  const idealWeightMin = 18.5 * heightInMeters * heightInMeters;
  const idealWeightMax = 24 * heightInMeters * heightInMeters;

  // Calculate weight difference
  const weightDifference = weight - ((idealWeightMin + idealWeightMax) / 2);

  return {
    bmi: bmi.toFixed(1),
    weight: weight,
    height: height,
    category: category,
    healthStatus: healthStatus,
    risks: risks,
    recommendations: recommendations,
    idealWeightRange: {
      min: idealWeightMin.toFixed(1),
      max: idealWeightMax.toFixed(1)
    },
    weightDifference: weightDifference.toFixed(1),
    timestamp: new Date().toISOString()
  };
}

/**
 * Format BMI result for display
 */
function formatBMIResult(result) {
  let output = `
╔═══════════════════════════════════════════════════════════╗
║              BMI 计算结果 (BMI Calculation Result)        ║
╚═══════════════════════════════════════════════════════════╝

📊 基本信息：
   体重: ${result.weight} kg
   身高: ${result.height} cm
   BMI 指数: ${result.bmi}

📈 健康评估：
   分类: ${result.category}
   状态: ${result.healthStatus}

💡 理想体重范围：
   ${result.idealWeightRange.min} - ${result.idealWeightRange.max} kg
   当前与理想体重差距: ${result.weightDifference > 0 ? '+' : ''}${result.weightDifference} kg
`;

  if (result.risks.length > 0) {
    output += `\n⚠️  健康风险：\n`;
    result.risks.forEach(risk => {
      output += `   - ${risk}\n`;
    });
  }

  output += `\n✅ 建议：\n`;
  result.recommendations.forEach(rec => {
    output += `   ${rec}\n`;
  });

  output += `\n📅 计算时间: ${new Date(result.timestamp).toLocaleString('zh-CN')}`;
  output += `\n\n💡 提示: BMI 仅供参考，不适用于孕妇、运动员、肌肉发达者等特殊人群。`;
  output += `\n   建议结合体脂率、腰围等指标综合评估。\n`;

  return output;
}

// Example usage and execution
try {
  // Example: 70kg, 175cm
  const result = calculateBMI(70, 175);
  const formattedOutput = formatBMIResult(result);

  console.log(formattedOutput);

  // Return the result object
  return result;

} catch (error) {
  console.error('BMI 计算错误:', error.message);
  throw error;
}
