#!/bin/bash
# Health Reminder Script - 健康提醒脚本
# Generate daily health reminders and tips

set -e

echo "════════════════════════════════════════════════════════"
echo "           健康提醒 (Health Reminder System)            "
echo "════════════════════════════════════════════════════════"
echo ""

# Get current time
HOUR=$(date +%H)
DAY_OF_WEEK=$(date +%u)  # 1=Monday, 7=Sunday
CURRENT_DATE=$(date +"%Y-%m-%d %H:%M:%S")

echo "📅 当前时间: $CURRENT_DATE"
echo ""

# Morning reminders (6:00 - 12:00)
if [ "$HOUR" -ge 6 ] && [ "$HOUR" -lt 12 ]; then
    echo "🌅 早安提醒："
    echo "   ✓ 起床后喝一杯温水（300-500ml）促进代谢"
    echo "   ✓ 吃营养丰富的早餐（30分钟内）"
    echo "   ✓ 测量晨起血压（高血压患者）"
    echo "   ✓ 进行轻度拉伸或晨练（15-30分钟）"
    echo ""
fi

# Noon reminders (12:00 - 14:00)
if [ "$HOUR" -ge 12 ] && [ "$HOUR" -lt 14 ]; then
    echo "☀️ 午间提醒："
    echo "   ✓ 午餐七八分饱，避免暴饮暴食"
    echo "   ✓ 餐后半小时散步10-15分钟"
    echo "   ✓ 适当午休20-30分钟（不超过1小时）"
    echo "   ✓ 避免餐后立即剧烈运动"
    echo ""
fi

# Afternoon reminders (14:00 - 18:00)
if [ "$HOUR" -ge 14 ] && [ "$HOUR" -lt 18 ]; then
    echo "🌤️ 下午提醒："
    echo "   ✓ 每隔1小时起身活动5分钟"
    echo "   ✓ 保持充足水分摄入"
    echo "   ✓ 15:00-16:00 适合进行有氧运动"
    echo "   ✓ 眼睛疲劳时做眼保健操"
    echo ""
fi

# Evening reminders (18:00 - 22:00)
if [ "$HOUR" -ge 18 ] && [ "$HOUR" -lt 22 ]; then
    echo "🌆 晚间提醒："
    echo "   ✓ 晚餐清淡，睡前3小时内不要进食"
    echo "   ✓ 避免睡前2小时剧烈运动"
    echo "   ✓ 减少屏幕时间，放松身心"
    echo "   ✓ 糖尿病患者：测量晚餐后2小时血糖"
    echo ""
fi

# Night reminders (22:00 - 6:00)
if [ "$HOUR" -ge 22 ] || [ "$HOUR" -lt 6 ]; then
    echo "🌙 睡眠提醒："
    echo "   ✓ 建议在23:00前入睡"
    echo "   ✓ 睡前1小时停止使用电子设备"
    echo "   ✓ 保持卧室凉爽（16-20°C）、安静、黑暗"
    echo "   ✓ 避免咖啡因和酒精"
    echo ""
fi

# Weekly exercise reminder
echo "🏃 本周运动提醒："
case $DAY_OF_WEEK in
    1|3|5)
        echo "   ✓ 今天是有氧运动日："
        echo "     - 快走、慢跑、游泳或骑行"
        echo "     - 目标：30-45分钟，心率达到最大心率的60-70%"
        ;;
    2|4)
        echo "   ✓ 今天是力量训练日："
        echo "     - 阻力训练或器械锻炼"
        echo "     - 目标：20-30分钟，锻炼主要肌群"
        ;;
    6|7)
        echo "   ✓ 今天是休息日/轻度活动日："
        echo "     - 瑜伽、太极或轻度拉伸"
        echo "     - 散步或户外活动"
        ;;
esac
echo ""

# Hydration reminder
TEMP_FILE="/tmp/water_intake_$USER.txt"
if [ -f "$TEMP_FILE" ]; then
    CUPS=$(cat "$TEMP_FILE")
else
    CUPS=0
fi

echo "💧 饮水提醒："
echo "   今日已记录饮水: $CUPS 杯（每杯约250ml）"
echo "   推荐每日饮水: 8-10 杯（2000-2500ml）"
echo "   剩余建议饮水量: $((8 - CUPS)) 杯"
echo ""

# Medication reminder placeholder
echo "💊 用药提醒："
echo "   ⚠️  慢性病患者请按时服药"
echo "   ✓ 高血压：早晚固定时间测血压并服药"
echo "   ✓ 糖尿病：监测血糖，规律用药"
echo "   ✓ 如有漏服，参考药品说明书处理"
echo ""

# Health tips of the day
TIPS=(
    "每天至少进行30分钟中等强度运动可降低心血管疾病风险30%"
    "充足睡眠（7-9小时）有助于免疫系统健康和体重控制"
    "地中海饮食（橄榄油、鱼类、全谷物、蔬果）可降低心脏病风险"
    "戒烟是预防心血管疾病最有效的措施之一"
    "定期体检可早期发现高血压、糖尿病、血脂异常等慢性病"
    "压力管理很重要：尝试冥想、深呼吸、瑜伽等放松技巧"
    "保持社交联系和良好人际关系有益心理健康"
    "限制钠盐摄入（<5g/天）可有效预防高血压"
)

# Get random tip
RANDOM_TIP=${TIPS[$RANDOM % ${#TIPS[@]}]}

echo "💡 今日健康小贴士："
echo "   $RANDOM_TIP"
echo ""

# Emergency reminder
echo "🚨 紧急情况识别："
echo "   如出现以下症状，请立即就医："
echo "   • 胸痛、呼吸困难、突发剧烈头痛"
echo "   • 肢体无力、言语不清、视力突变"
echo "   • 严重腹痛、呕血、黑便"
echo "   • 高热不退（>39°C）、意识改变"
echo ""

echo "════════════════════════════════════════════════════════"
echo "        保持健康生活方式，预防胜于治疗！"
echo "════════════════════════════════════════════════════════"
echo ""

# Save current date for tracking
echo "最后运行时间: $CURRENT_DATE" > /tmp/health_reminder_last_run.txt

exit 0
