/**
 * MiMo TTS Extension for Pi
 * 
 * 使用小米 MiMo-V2.5-TTS 模型为 Pi agent 添加语音回答功能
 * 
 * API: https://token-plan-cn.xiaomimimo.com/v1/chat/completions
 * 格式: chat completions（不是 OpenAI 的 /audio/speech）
 * 
 * 命令:
 *   /tts - 弹窗菜单（开关/选择模型/选择音色/设置风格）
 */

import { execFile, type ChildProcess } from "node:child_process";
import { writeFileSync, readFileSync, unlinkSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { matchesKey, Key } from "@earendil-works/pi-tui";

// MiMo TTS 配置（从 auth.json 读取）
const MIMO_API_BASE = "https://token-plan-cn.xiaomimimo.com/v1";
const AUTH_FILE = join(homedir(), ".pi", "agent", "auth.json");

function getApiKey(): string {
  try {
    if (existsSync(AUTH_FILE)) {
      const auth = JSON.parse(readFileSync(AUTH_FILE, "utf-8"));
      // 优先使用 Mimo provider，其次 xiaomi-token-plan-cn
      return auth.Mimo?.key || auth["xiaomi-token-plan-cn"]?.key || "";
    }
  } catch (error) {
    console.error("Failed to read auth.json:", error);
  }
  return "";
}

// 可用模型列表
const MODELS = [
  { id: "mimo-v2.5-tts", name: "标准TTS", desc: "使用预置精品音色" },
  { id: "mimo-v2.5-tts-voicedesign", name: "音色设计", desc: "通过文本描述定制音色" },
  { id: "mimo-v2.5-tts-voiceclone", name: "音色克隆", desc: "基于音频样本复刻音色" },
];

// 可用音色列表（仅标准TTS模型可用）
const VOICES = [
  { id: "mimo_default", name: "MiMo默认", lang: "中文", gender: "女" },
  { id: "冰糖", name: "冰糖", lang: "中文", gender: "女" },
  { id: "茉莉", name: "茉莉", lang: "中文", gender: "女" },
  { id: "苏打", name: "苏打", lang: "中文", gender: "男" },
  { id: "白桦", name: "白桦", lang: "中文", gender: "男" },
  { id: "Mia", name: "Mia", lang: "英文", gender: "女" },
  { id: "Chloe", name: "Chloe", lang: "英文", gender: "女" },
  { id: "Milo", name: "Milo", lang: "英文", gender: "男" },
  { id: "Dean", name: "Dean", lang: "英文", gender: "男" },
];

interface TTSState {
  enabled: boolean;
  model: string;
  voice: string;
  style: string;
  filterEnabled: boolean;
  summarizeEnabled: boolean;   // LLM 总结开关
  summarizeThreshold: number;  // 触发阈值（字符数）
  summarizeModel: string;      // 文本总结模型
  summarizeThinkLevel: string; // 思考深度: off | low | medium | high
}

// 默认状态
const DEFAULT_STATE: TTSState = {
  enabled: false,
  model: "mimo-v2.5-tts",
  voice: "冰糖",
  style: "用自然流畅的语气说",
  filterEnabled: true,
  summarizeEnabled: true,
  summarizeThreshold: 500,
  summarizeModel: "xiaomi-token-plan-cn/mimo-v2-pro",
  summarizeThinkLevel: "medium", // 默认与现状一致：MiMo 不传 thinking 时思考开启
};

// 配置文件路径
const CONFIG_FILE = join(__dirname, "config.json");

// 当前状态
const state: TTSState = { ...DEFAULT_STATE };

// 当前播放进程（用于 stop 功能）
let currentPlayer: ChildProcess | null = null;

// 让其他扩展(如 pi-jarvis-sphere)能感知 TTS 播放状态
let ttsEvents: { emit: (channel: string, data: unknown) => void } | null = null;

/** 发出 TTS 播放状态信号 + 同步 globalThis 标志(供其他扩展读取初始态)。
 *  只在持有真实 TUI 事件总线时才发信号/置标志——子 agent 的 "print" 会话与本会话
 *  共享 globalThis,若在这里无条件置标志,子 agent 的 TTS 会污染标志却没有 TUI 总线
 *  事件,导致下次球挂载时误判为“正在说话”。ttsEvents 仅在 TUI 会话的 session_start
 *  里被赋值,故非 TUI 会话(子 agent print)下为 null,直接 return。 */
function emitTtsState(playing: boolean): void {
  if (!ttsEvents) return;
  (globalThis as any).__piTtsPlaying = playing;
  ttsEvents.emit(
    playing ? "tts:started" : "tts:stopped",
    playing ? { source: "mimo" } : undefined,
  );
}

// 停止当前播放
function stopPlayback(): boolean {
  if (currentPlayer) {
    currentPlayer.kill("SIGTERM");
    currentPlayer = null;
    emitTtsState(false);
    return true;
  }
  return false;
}

// 从配置文件加载状态
function loadState(): void {
  try {
    if (existsSync(CONFIG_FILE)) {
      const data = JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
      state.enabled = data.enabled ?? DEFAULT_STATE.enabled;
      state.model = data.model ?? DEFAULT_STATE.model;
      state.voice = data.voice ?? DEFAULT_STATE.voice;
      state.style = data.style ?? DEFAULT_STATE.style;
      state.filterEnabled = data.filterEnabled ?? DEFAULT_STATE.filterEnabled;
      state.summarizeEnabled = data.summarizeEnabled ?? DEFAULT_STATE.summarizeEnabled;
      state.summarizeThreshold = data.summarizeThreshold ?? DEFAULT_STATE.summarizeThreshold;
      state.summarizeModel = data.summarizeModel ?? DEFAULT_STATE.summarizeModel;
      state.summarizeThinkLevel = data.summarizeThinkLevel ?? DEFAULT_STATE.summarizeThinkLevel;
    }
  } catch (error) {
    console.error("Failed to load config:", error);
  }
}

// 保存状态到配置文件
function saveState(): void {
  try {
    writeFileSync(CONFIG_FILE, JSON.stringify(state, null, 2), "utf-8");
  } catch (error) {
    console.error("Failed to save config:", error);
  }
}

// 初始化时加载状态
loadState();

// 音色预览音频目录
const VOICE_PREVIEW_DIR = join(__dirname, "mimo-tts-voices");

// 检查音色预览文件是否存在
function getVoicePreviewPath(voiceId: string): string | null {
  const path = join(VOICE_PREVIEW_DIR, `${voiceId}.wav`);
  return existsSync(path) ? path : null;
}

// 播放预览音频
function playPreview(voiceId: string): void {
  const previewPath = getVoicePreviewPath(voiceId);
  if (!previewPath) return;
  
  if (process.platform === "darwin") {
    execFile("afplay", [previewPath], (err) => {
      if (err) console.error("Preview playback error:", err);
    });
  }
}

/**
 * 调用 MiMo TTS API 生成音频
 */
async function synthesizeSpeech(text: string): Promise<Buffer | null> {
  const messages = [
    { role: "user", content: state.style },
    { role: "assistant", content: text },
  ];

  try {
    const apiKey = getApiKey();
    if (!apiKey) {
      console.error("No MiMo API key found in auth.json");
      return null;
    }
    
    const response = await fetch(`${MIMO_API_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: state.model,
        messages,
        audio: {
          format: "wav",
          voice: state.voice,
        },
      }),
    });

    if (!response.ok) {
      console.error(`MiMo TTS API error: ${response.status}`);
      return null;
    }

    const data = await response.json() as any;
    const audioBase64 = data?.choices?.[0]?.message?.audio?.data;
    
    if (!audioBase64) {
      console.error("No audio data in response");
      return null;
    }

    return Buffer.from(audioBase64, "base64");
  } catch (error) {
    console.error("MiMo TTS request failed:", error);
    return null;
  }
}

/**
 * 播放音频文件
 */
function playAudio(audioBuffer: Buffer): void {
  // 先停止当前播放，避免多个进程同时运行
  stopPlayback();
  
  const tmpFile = join(tmpdir(), `mimo-tts-${Date.now()}.wav`);
  
  try {
    writeFileSync(tmpFile, audioBuffer);
    emitTtsState(true);
    
    // 根据平台选择播放命令
    if (process.platform === "darwin") {
      const childD = execFile("afplay", [tmpFile], (err) => {
        if (err && err.signal !== "SIGTERM") console.error("afplay error:", err);
        if (currentPlayer === childD) {
          currentPlayer = null;
          emitTtsState(false);
        }
        cleanup(tmpFile);
      });
      currentPlayer = childD;
    } else if (process.platform === "linux") {
      const player = existsSync("/usr/bin/paplay") ? "paplay" : "aplay";
      const childL = execFile(player, [tmpFile], (err) => {
        if (err && err.signal !== "SIGTERM") console.error(`${player} error:`, err);
        if (currentPlayer === childL) {
          currentPlayer = null;
          emitTtsState(false);
        }
        cleanup(tmpFile);
      });
      currentPlayer = childL;
    } else {
      const childW = execFile("powershell.exe", [
        "-NoProfile",
        "-Command",
        `(New-Object Media.SoundPlayer '${tmpFile}').PlaySync()`,
      ], (err) => {
        if (err && err.signal !== "SIGTERM") console.error("PowerShell playback error:", err);
        if (currentPlayer === childW) {
          currentPlayer = null;
          emitTtsState(false);
        }
        cleanup(tmpFile);
      });
      currentPlayer = childW;
    }
  } catch (error) {
    console.error("Audio playback failed:", error);
    currentPlayer = null;
    emitTtsState(false);
    cleanup(tmpFile);
  }
}

function cleanup(file: string): void {
  try {
    unlinkSync(file);
  } catch {}
}

/**
 * 从消息内容中提取文本
 */
function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  
  return content
    .filter((block: any) => block?.type === "text" && typeof block.text === "string")
    .map((block: any) => block.text)
    .join("\n")
    .replace(/<(thinking|thought)>[\s\S]*?<\/\1>/gi, "")
    .replace(/<(thinking|thought)\s*\/>/gi, "")
    .trim();
}

const FILTER_SUMMARY_PROMPT = `你是语音播报摘要器。下面是一段 AI 助手给用户的回复，请把它总结成 1-3 句口语化的话，直接告诉用户结果。
要求：
- 只输出总结内容本身，不要任何前缀、解释、标注
- 用自然口语风格，像在跟人说话
- 突出核心结论，省略细节、代码、路径、命令等不适合朗读的内容
- 不超过 3 句`;

/** 从 pi 模型注册表获取可用的文本模型列表（有 auth 配置的优先，否则全部） */
function getSummarizeModels(ctx: any): any[] {
  const reg = ctx?.modelRegistry;
  if (!reg) return [];
  const list = reg.getAvailable().length > 0 ? reg.getAvailable() : reg.getAll();
  return (list || []).filter((m: any) => m?.input?.includes("text"));
}

/** 模型 → "provider/id" 唯一键 */
function summarizeModelKey(model: any): string {
  return `${model.provider}/${model.id}`;
}

/** 按 key 解析注册表中的模型；key 不含 "/" 时按裸 id 兼容旧配置 */
function resolveSummarizeModel(ctx: any, key: string): any {
  if (!key) return null;
  const models = getSummarizeModels(ctx);
  if (key.includes("/")) {
    const [provider, id] = key.split("/");
    return models.find((m: any) => m.provider === provider && m.id === id) || null;
  }
  return models.find((m: any) => m.id === key) || null;
}

const VISIBLE_MODELS = 10;

// 自绘滚动+过滤模型选择器（参考 pi-model-favorites 的窗口滚动 + / 过滤）
// 返回选中的模型对象，取消返回 null
function pickSummarizeModel(ctx: any, models: any[], currentKey: string | undefined): Promise<any | null> {
  const sorted = [...models].sort((a: any, b: any) =>
    a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name)
  );

  return ctx.ui.custom<any | null>((tui: any, theme: any, _keybindings: any, done: (v: any | null) => void) => {
    let filter = "";
    let filtering = false;
    let cursor = 0;
    let scroll = 0;
    let version = 0;
    let cached: { version: number; width: number; lines: string[] } | undefined;

    const matches = (m: any): boolean => {
      if (filter === "") return true;
      const q = filter.toLowerCase();
      return (
        m.name.toLowerCase().includes(q) ||
        m.id.toLowerCase().includes(q) ||
        m.provider.toLowerCase().includes(q)
      );
    };
    const visible = (): any[] => sorted.filter(matches);
    const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(v, hi));

    const rebuild = (): void => {
      const list = visible();
      if (list.length === 0) { cursor = 0; scroll = 0; return; }
      cursor = clamp(cursor, 0, list.length - 1);
      scroll = clamp(scroll, 0, Math.max(0, list.length - VISIBLE_MODELS));
      if (cursor < scroll) scroll = cursor;
      else if (cursor >= scroll + VISIBLE_MODELS) scroll = cursor - VISIBLE_MODELS + 1;
    };
    const move = (delta: number): void => {
      const list = visible();
      if (list.length === 0) return;
      cursor = clamp(cursor + delta, 0, list.length - 1);
      if (cursor < scroll) scroll = cursor;
      else if (cursor >= scroll + VISIBLE_MODELS) scroll = cursor - VISIBLE_MODELS + 1;
    };

    rebuild();

    const render = (width: number): string[] => {
      if (cached && cached.version === version && cached.width === width) return cached.lines;
      const list = visible();
      const lines: string[] = [theme.fg("accent", theme.bold("选择总结模型"))];
      if (list.length === 0) {
        lines.push(theme.fg("dim", "  (no models match)"));
      } else {
        if (scroll > 0) lines.push(theme.fg("dim", "  ▲"));
        for (let i = scroll; i < Math.min(list.length, scroll + VISIBLE_MODELS); i++) {
          const m = list[i];
          const key = `${m.provider}/${m.id}`;
          const text = `${m.name} (${m.provider})${key === currentKey ? " ✓" : ""}`;
          if (i === cursor) lines.push(theme.bg("selectedBg", theme.fg("accent", `▸ ${text}`)));
          else lines.push(`  ${text}`);
        }
        if (scroll + VISIBLE_MODELS < list.length) lines.push(theme.fg("dim", "  ▼"));
      }
      if (filtering) {
        lines.push(theme.fg("accent", `filter: "${filter}"`) + theme.fg("dim", " • enter apply • esc clear"));
      } else {
        lines.push(theme.fg("dim", "↑↓ nav • enter select • / filter • esc cancel"));
      }
      cached = { version, width, lines };
      return lines;
    };

    const handleInput = (data: string): void => {
      if (filtering) {
        if (matchesKey(data, Key.escape)) { filter = ""; filtering = false; }
        else if (matchesKey(data, Key.enter)) { filtering = false; }
        else if (matchesKey(data, Key.backspace)) { filter = filter.slice(0, -1); }
        else if (data.length === 1 && data >= " ") { filter += data; }
        else return;
        rebuild();
        version++;
        tui.requestRender();
        return;
      }
      if (data === "/") { filtering = true; version++; tui.requestRender(); return; }
      if (matchesKey(data, Key.up)) move(-1);
      else if (matchesKey(data, Key.down)) move(1);
      else if (matchesKey(data, Key.enter)) {
        const list = visible();
        const m = list[cursor];
        if (m) done(m);
        return;
      } else if (matchesKey(data, Key.escape)) { done(null); return; }
      else return;
      version++;
      tui.requestRender();
    };

    return { render, invalidate: () => { cached = undefined; }, handleInput };
  });
}

/**
 * 用 LLM 把长文本总结成 1-3 句口语化摘要（失败返回 null，由调用方降级）
 * 模型取自 pi 模型注册表，auth/协议/thinking 格式由 complete() 自动处理
 */
async function summarizeWithLLM(ctx: any, text: string): Promise<string | null> {
  const model = resolveSummarizeModel(ctx, state.summarizeModel);
  if (!model) return null;

  // 输入截断：保护 token
  const truncatedInput = text.length > 8000 ? text.substring(0, 8000) + "\n\n[内容过长，已截断]" : text;

  try {
    const msg = await ctx.modelRegistry.complete(
      model,
      {
        systemPrompt: FILTER_SUMMARY_PROMPT,
        messages: [{ role: "user", content: truncatedInput }],
      },
      {
        reasoning: state.summarizeThinkLevel as any,
        temperature: 0.3,
        maxTokens: 300,
        timeoutMs: 10000,
      },
    );

    const content = msg?.content;
    if (Array.isArray(content)) {
      const result = content
        .filter((b: any) => b?.type === "text" && typeof b.text === "string")
        .map((b: any) => b.text)
        .join("")
        .trim();
      if (result) return result;
    }
    return null;
  } catch (error) {
    console.error("[tts-mimo] summarize failed:", error);
    return null;
  }
}

/**
 * 结构黑名单：检测“给人看而非给人听”的内容（代码块/命令输出/路径清单/表格）
 * 命中则阻止 TTS 朗读。全部纯正则/行扫描，零网络/LLM 调用。
 */
function structuralBlacklist(text: string): { blocked: boolean; reason?: string } {
  if (!text) return { blocked: false };

  const lines = text.split("\n");
  const nonEmpty = lines.filter((l) => l.trim().length > 0);
  const nonEmptyCount = nonEmpty.length;

  // 非空行很少时不误杀（除非是单个大代码块）
  if (nonEmptyCount < 3) {
    const fenceCount = (text.match(/```/g) || []).length;
    if (fenceCount >= 2 && text.length > 200) {
      return { blocked: true, reason: "code-block" };
    }
    return { blocked: false };
  }

  // --- 代码块检测：成对围栏且代码内容占比 >50% ---
  const fenceCount = (text.match(/```/g) || []).length;
  if (fenceCount >= 2) {
    let codeChars = 0;
    const codeBlockRe = /```[\s\S]*?```/g;
    let m: RegExpExecArray | null;
    while ((m = codeBlockRe.exec(text)) !== null) {
      codeChars += m[0].length;
    }
    if (codeChars / text.length > 0.5) {
      return { blocked: true, reason: "code-block" };
    }
  }

  // --- 命令输出检测：$/>/# 开头或终端日志特征行，占比 >40% ---
  const cmdRe = /^\s*(\$|>|#)\s/;
  const logRe = /^\s*(Running|Executing|Output|Result|Error|Warning)\s*:/i;
  let cmdLines = 0;
  for (const l of nonEmpty) {
    if (cmdRe.test(l) || logRe.test(l)) cmdLines++;
  }
  if (cmdLines / nonEmptyCount > 0.4) {
    return { blocked: true, reason: "command-output" };
  }

  // --- 文件路径清单检测：以 / 或 ~ 开头，或匹配文件路径模式，占比 >40% ---
  const pathStartRe = /^\s*(\/|~)/;
  const filePathRe = /(\w+\/)+\w+\.\w{1,5}/;
  let pathLines = 0;
  for (const l of nonEmpty) {
    if (pathStartRe.test(l) || filePathRe.test(l)) pathLines++;
  }
  if (pathLines / nonEmptyCount > 0.4) {
    return { blocked: true, reason: "path-list" };
  }

  // --- 表格检测：| 开头且 | 结尾，至少 3 行且占比 >50% ---
  const tableRe = /^\s*\|.*\|\s*$/;
  let tableLines = 0;
  for (const l of nonEmpty) {
    if (tableRe.test(l)) tableLines++;
  }
  if (tableLines >= 3 && tableLines / nonEmptyCount > 0.5) {
    return { blocked: true, reason: "table" };
  }

  return { blocked: false };
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode === "tui") ttsEvents = pi.events;
  });

  // /tts 命令: 弹窗菜单
  pi.registerCommand("tts", {
    description: "MiMo TTS 设置 (stop: 停止播放)",
    handler: async (args, ctx) => {
      // 处理 stop 子命令
      if (args.trim().toLowerCase() === "stop") {
        const stopped = stopPlayback();
        ctx.ui.notify(stopped ? "TTS 播放已停止" : "当前没有正在播放的 TTS", "info");
        return;
      }
      
      const currentVoice = VOICES.find((v) => v.id === state.voice);
      const currentModel = MODELS.find((m) => m.id === state.model);
      const currentSummaryModel = resolveSummarizeModel(ctx, state.summarizeModel);
      
      // 构建菜单选项
      const options = [
        `开关 TTS: ${state.enabled ? "已开启 ✓" : "已关闭"}`,
        `选择模型: ${currentModel?.name} (${currentModel?.desc})`,
        `选择音色: ${currentVoice?.name} (${currentVoice?.gender}, ${currentVoice?.lang})`,
        `设置风格: ${state.style}`,
        `内容过滤: ${state.filterEnabled ? "已开启 ✓" : "已关闭"}`,
        `LLM 总结: ${state.summarizeEnabled ? "已开启 ✓" : "已关闭"}`,
        `总结阈值: ${state.summarizeThreshold} 字`,
        `总结模型: ${currentSummaryModel ? `${currentSummaryModel.id} (${currentSummaryModel.provider})` : "未配置/无效"}`,
        `思考深度: ${state.summarizeThinkLevel}`,
      ];
      
      // 弹窗选择
      const choice = await ctx.ui.select("MiMo TTS 设置", options);
      
      if (!choice) return;
      
      const index = options.indexOf(choice);
      
      switch (index) {
        case 0: // 开关 TTS
          state.enabled = !state.enabled;
          saveState();
          ctx.ui.notify(`MiMo TTS ${state.enabled ? "已开启" : "已关闭"}`, "info");
          break;
          
        case 1: // 选择模型
          await selectModel(ctx);
          break;
          
        case 2: // 选择音色
          await selectVoice(ctx, pi);
          break;
          
        case 3: // 设置风格
          await setStyle(ctx, pi);
          break;

        case 4: // 内容过滤开关
          state.filterEnabled = !state.filterEnabled;
          saveState();
          ctx.ui.notify(`内容过滤 ${state.filterEnabled ? "已开启" : "已关闭"}`, "info");
          break;

        case 5: // LLM 总结开关
          state.summarizeEnabled = !state.summarizeEnabled;
          saveState();
          ctx.ui.notify(`LLM 总结 ${state.summarizeEnabled ? "已开启" : "已关闭"}`, "info");
          break;

        case 6: { // 总结阈值（循环切换 300/500/800/1000）
          const thresholds = [300, 500, 800, 1000];
          state.summarizeThreshold = thresholds[(thresholds.indexOf(state.summarizeThreshold) + 1) % thresholds.length];
          saveState();
          ctx.ui.notify(`总结阈值: ${state.summarizeThreshold} 字`, "info");
          break;
        }

        case 7: { // 总结模型（自绘滚动选择器，从 pi 已配置模型列表选取，支持 / 过滤）
          const models = getSummarizeModels(ctx);
          if (models.length === 0) {
            ctx.ui.notify("没有可用的文本模型", "error");
            break;
          }
          const current = resolveSummarizeModel(ctx, state.summarizeModel);
          const currentKey = current ? `${current.provider}/${current.id}` : undefined;
          const chosen = await pickSummarizeModel(ctx, models, currentKey);
          if (chosen) {
            state.summarizeModel = summarizeModelKey(chosen);
            saveState();
            ctx.ui.notify(`总结模型: ${chosen.id} (${chosen.provider})`, "info");
          }
          break;
        }

        case 8: { // 思考深度（循环切换 off/low/medium/high）
          const thinkLevels = ["off", "low", "medium", "high"];
          state.summarizeThinkLevel = thinkLevels[(thinkLevels.indexOf(state.summarizeThinkLevel) + 1) % thinkLevels.length];
          saveState();
          ctx.ui.notify(`思考深度: ${state.summarizeThinkLevel}`, "info");
          break;
        }
      }
    },
  });

  // 选择模型
  async function selectModel(ctx: any) {
    const modelOptions = MODELS.map((m) => 
      `${m.name} - ${m.desc}${m.id === state.model ? " ✓" : ""}`
    );
    
    const choice = await ctx.ui.select("选择模型:", modelOptions);
    
    if (choice) {
      const index = modelOptions.indexOf(choice);
      if (index >= 0) {
        state.model = MODELS[index].id;
        saveState();
        ctx.ui.notify(`模型已切换: ${MODELS[index].name}`, "info");
      }
    }
  }

  // 选择音色
  async function selectVoice(ctx: any, pi: ExtensionAPI) {
    const result = await ctx.ui.custom<string | null>((tui: any, theme: any, keybindings: any, done: (value: string | null) => void) => {
      let selected = VOICES.findIndex((v) => v.id === state.voice);
      if (selected < 0) selected = 0;
      
      let cachedWidth: number | undefined;
      let cachedLines: string[] | undefined;
      
      function invalidate() {
        cachedWidth = undefined;
        cachedLines = undefined;
      }
      
      function render(width: number): string[] {
        if (cachedLines && cachedWidth === width) return cachedLines;
        
        const lines: string[] = [];
        lines.push(theme.fg("accent", "选择音色 (↑↓ 移动, → 试听, Enter 确认, Esc 取消):"));
        lines.push("");
        
        for (let i = 0; i < VOICES.length; i++) {
          const v = VOICES[i];
          const prefix = i === selected ? theme.fg("accent", "> ") : "  ";
          const name = `${v.name} (${v.gender}, ${v.lang})`;
          const line = `${prefix}${name}`;
          lines.push(line);
        }
        
        cachedWidth = width;
        cachedLines = lines;
        return lines;
      }
      
      function handleInput(data: string) {
        if (matchesKey(data, Key.up) && selected > 0) {
          selected--;
          invalidate();
          tui.requestRender();
        } else if (matchesKey(data, Key.down) && selected < VOICES.length - 1) {
          selected++;
          invalidate();
          tui.requestRender();
        } else if (matchesKey(data, Key.right)) {
          playPreview(VOICES[selected].id);
        } else if (matchesKey(data, Key.enter)) {
          done(VOICES[selected].id);
        } else if (matchesKey(data, Key.escape)) {
          done(null);
        }
      }
      
      return { render, handleInput, invalidate };
    });
    
    if (result) {
      state.voice = result;
      saveState();
      const voice = VOICES.find((v) => v.id === result);
      ctx.ui.notify(`音色已切换: ${voice?.name}`, "info");
    }
  }

  // 设置风格
  async function setStyle(ctx: any, pi: ExtensionAPI) {
    const style = await ctx.ui.input(
      "设置朗读风格:",
      state.style
    );
    
    if (style && style.trim()) {
      state.style = style.trim();
      saveState();
      ctx.ui.notify(`风格已设置: ${state.style}`, "info");
    }
  }

  // 监听 agent_end 事件，自动朗读
  pi.on("agent_end", async (_event, ctx) => {
    if (!state.enabled) return;

    const entries = ctx.sessionManager.getBranch();
    const lastAssistant = [...entries]
      .reverse()
      .find((e) => e.type === "message" && e.message?.role === "assistant");

    if (!lastAssistant?.message?.content) return;

    const text = extractText(lastAssistant.message.content);
    if (!text || text.length < 10) return;

    // 结构黑名单：跳过代码/命令输出/路径清单/表格等“给人看”的内容
    if (state.filterEnabled) {
      const { blocked, reason } = structuralBlacklist(text);
      if (blocked) {
        console.log(`[tts-mimo] Skipped (${reason})`);
        return;
      }
    }

    // 长度处理：超过 summarizeThreshold 时用 LLM 总结成 1-3 句
    let speechText: string;
    if (text.length > state.summarizeThreshold) {
      if (state.summarizeEnabled) {
        const summary = await summarizeWithLLM(ctx, text);
        if (summary) {
          speechText = summary;
        } else {
          // LLM 失败降级：回到旧行为（读最后 2000 字，结尾通常是对话总结）
          speechText = text.length > 2000 ? "……" + text.substring(text.length - 2000) : text;
        }
      } else {
        speechText = text.length > 2000 ? "……" + text.substring(text.length - 2000) : text;
      }
    } else {
      speechText = text;
    }

    synthesizeSpeech(speechText).then((audio) => {
      if (audio) playAudio(audio);
    });
  });
}
