# MiMo TTS Extension for Pi

使用小米 MiMo-V2.5-TTS 模型为 Pi agent 添加语音回答功能。

## 功能

- 使用 MiMo TTS API 生成语音
- 支持多个 TTS 模型
- 支持多种音色（冰糖、茉莉、苏打、白桦等）
- 支持自定义朗读风格
- 自动朗读 agent 回答
- 内容过滤：自动跳过代码块、命令输出、文件路径清单、表格等不适合朗读的内容（/tts 菜单可开关）
- 状态持久化（开关、模型、音色、风格）

## 命令

- `/tts` - 打开设置菜单
  - 开关 TTS
  - 选择模型
  - 选择音色（支持预览）
  - 设置风格
  - 内容过滤开关

## 模型列表

| 模型 | 说明 |
| ------ | ------ |
| mimo-v2.5-tts | 标准TTS，使用预置精品音色 |
| mimo-v2.5-tts-voicedesign | 音色设计，通过文本描述定制音色 |
| mimo-v2.5-tts-voiceclone | 音色克隆，基于音频样本复刻音色 |

## 音色列表

| 音色 | 性别 | 语言 |
| ------ | ------ | ------ |
| 冰糖 | 女 | 中文（默认） |
| 茉莉 | 女 | 中文 |
| 苏打 | 男 | 中文 |
| 白桦 | 男 | 中文 |
| Mia | 女 | 英文 |
| Chloe | 女 | 英文 |
| Milo | 男 | 英文 |
| Dean | 男 | 英文 |

## 文件结构

```
mimo-tts/
├── index.ts                  # 主文件
├── mimo-tts-voices/          # 音色预览音频
│   ├── 冰糖.wav
│   ├── 茉莉.wav
│   ├── 苏打.wav
│   ├── 白桦.wav
│   ├── Mia.wav
│   ├── Chloe.wav
│   ├── Milo.wav
│   └── Dean.wav
├── generate-voice-previews.sh # 生成预览音频的脚本
└── README.md                 # 本文件
```

## 配置

### API Key

Extension 从 `~/.pi/agent/auth.json` 读取 MiMo API key。

使用 `/login` 命令添加 MiMo provider，或手动编辑 `auth.json`：

```json
{
  "Mimo": {
    "type": "api_key",
    "key": "your-api-key-here"
  }
}
```

### 用户偏好

用户偏好保存在 `config.json`：

```json
{
  "enabled": false,
  "model": "mimo-v2.5-tts",
  "voice": "冰糖",
  "style": "用自然流畅的语气说"
}
```

## 使用方法

1. 在 Pi TUI 中输入 `/reload` 加载 extension
2. 输入 `/tts` 打开设置菜单
3. 选择「开关 TTS」启用语音
4. 选择「选择音色」切换音色（支持预览）
5. 选择「设置风格」自定义朗读风格

## 重新生成预览音频

如果需要重新生成音色预览音频：

```bash
cd ~/.pi/agent/extensions/mimo-tts
bash generate-voice-previews.sh
```

## 依赖

- Pi coding agent
- macOS（使用 `afplay` 播放音频）
- MiMo TTS API 访问权限
