#!/bin/bash
# 为每个 MiMo TTS 音色生成自我介绍音频

API_URL="https://token-plan-cn.xiaomimimo.com/v1/chat/completions"
API_KEY="tp-c91ohic56107zv0rbyb2xxpaf5mm3b7nwr65vy9f2xbeilhb"
OUTPUT_DIR="$HOME/.pi/agent/extensions/mimo-tts-voices"

# 音色列表
VOICES=("冰糖" "茉莉" "苏打" "白桦" "Mia" "Chloe" "Milo" "Dean")

# 自我介绍文本
INTRO_TEXT="你好，我是MiMo语音助手，很高兴认识你！"

for voice in "${VOICES[@]}"; do
  echo "生成音色: $voice ..."
  
  response=$(curl -s -X POST "$API_URL" \
    -H "Authorization: Bearer $API_KEY" \
    -H "Content-Type: application/json" \
    -d "{
      \"model\": \"mimo-v2.5-tts\",
      \"messages\": [
        {\"role\": \"user\", \"content\": \"用温柔的语气说\"},
        {\"role\": \"assistant\", \"content\": \"$INTRO_TEXT\"}
      ],
      \"audio\": {
        \"format\": \"wav\",
        \"voice\": \"$voice\"
      }
    }")
  
  # 提取 base64 音频数据
  audio_base64=$(echo "$response" | jq -r '.choices[0].message.audio.data')
  
  if [ "$audio_base64" != "null" ] && [ -n "$audio_base64" ]; then
    # 解码并保存
    echo "$audio_base64" | base64 -D > "$OUTPUT_DIR/$voice.wav"
    echo "  已保存: $OUTPUT_DIR/$voice.wav"
  else
    echo "  错误: 无法生成音频"
  fi
done

echo "完成！"
