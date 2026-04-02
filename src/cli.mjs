#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { dirname, join } from "node:path";
import { mkdir, readFile, appendFile, writeFile, stat, rename, copyFile } from "node:fs/promises";
import { chatCompletion, getConfig } from "./ollama.mjs";
import { createTools, formatToolResult } from "./tools.mjs";

const WORKSPACE = process.cwd();
const MAX_STEPS = 12;
const STATE_DIR = join(WORKSPACE, ".clama");
const LEGACY_STATE_DIR = join(WORKSPACE, ".claudegemma");
const HISTORY_FILE = join(STATE_DIR, "history.jsonl");
const MEMORY_FILE = join(STATE_DIR, "memory.json");
const HISTORY_MESSAGES = Number(process.env.CLAMA_HISTORY_MESSAGES ?? process.env.CLAUDEGEMMA_HISTORY_MESSAGES ?? "20");

const TOOL_SPEC = [
  {
    name: "list_files",
    description: "List files and directories inside the workspace.",
    arguments: { path: "string (optional)" },
  },
  {
    name: "read_file",
    description: "Read a UTF-8 file from the workspace.",
    arguments: { path: "string" },
  },
  {
    name: "write_file",
    description: "Write a UTF-8 file to the workspace, creating parents as needed.",
    arguments: { path: "string", content: "string" },
  },
  {
    name: "replace_text",
    description: "Replace text in a file.",
    arguments: { path: "string", from: "string", to: "string", all: "boolean (optional)" },
  },
  {
    name: "search_text",
    description: "Search text with ripgrep in the workspace.",
    arguments: { pattern: "string", path: "string (optional)", flags: "string (optional)" },
  },
  {
    name: "run_shell",
    description: "Run a shell command in the workspace.",
    arguments: { command: "string", args: "array of strings (optional)" },
  },
  {
    name: "open_app",
    description: "Open a macOS application by name.",
    arguments: { appName: "string" },
  },
  {
    name: "open_path",
    description: "Open a file or folder on macOS.",
    arguments: { path: "string" },
  },
  {
    name: "music_control",
    description: "Control the macOS Music app playback.",
    arguments: { action: "play|pause|toggle|next|previous|stop" },
  },
  {
    name: "music_status",
    description: "Get the current track and playback state from Music.",
    arguments: {},
  },
  {
    name: "volume_control",
    description: "Control macOS output volume.",
    arguments: { action: "up|down|mute|unmute|set", value: "number (optional)" },
  },
  {
    name: "clipboard_get",
    description: "Read the current clipboard text.",
    arguments: {},
  },
  {
    name: "clipboard_set",
    description: "Write text to the clipboard.",
    arguments: { text: "string" },
  },
  {
    name: "disk_free",
    description: "Get free disk space on the main system volume.",
    arguments: {},
  },
  {
    name: "stat_path",
    description: "Inspect whether a path exists and what it is.",
    arguments: { path: "string" },
  },
];

function normalizeText(value) {
  return String(value).toLowerCase().replace(/\s+/g, " ").trim();
}

function containsAny(text, phrases) {
  return phrases.some((phrase) => text.includes(phrase));
}

function openAppAction(appName) {
  return { type: "open_app", arguments: { appName } };
}

function openPathAction(path) {
  return { type: "open_path", arguments: { path } };
}

async function loadHistory() {
  try {
    const raw = await readFile(HISTORY_FILE, "utf8");
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter((entry) => entry && (entry.role === "user" || entry.role === "assistant") && typeof entry.content === "string")
      .slice(-HISTORY_MESSAGES)
      .map(({ role, content }) => ({ role, content }));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

async function migrateLegacyState() {
  try {
    const legacyStat = await stat(LEGACY_STATE_DIR).catch(() => null);
    if (!legacyStat?.isDirectory()) return;

    const newStat = await stat(STATE_DIR).catch(() => null);
    if (!newStat?.isDirectory()) {
      await mkdir(dirname(STATE_DIR), { recursive: true });
      await rename(LEGACY_STATE_DIR, STATE_DIR);
      return;
    }

    const legacyHistory = join(LEGACY_STATE_DIR, "history.jsonl");
    const legacyMemory = join(LEGACY_STATE_DIR, "memory.json");
    const newHistory = join(STATE_DIR, "history.jsonl");
    const newMemory = join(STATE_DIR, "memory.json");

    const tasks = [];

    if (!(await stat(newHistory).catch(() => null)) && (await stat(legacyHistory).catch(() => null))) {
      tasks.push(copyFile(legacyHistory, newHistory));
    }
    if (!(await stat(newMemory).catch(() => null)) && (await stat(legacyMemory).catch(() => null))) {
      tasks.push(copyFile(legacyMemory, newMemory));
    }
    await Promise.all(tasks);
  } catch {
    // Best-effort migration only.
  }
}

function defaultMemory() {
  return {
    likes: [],
    dislikes: [],
    name: null,
    last_opened_apps: [],
    recent_actions: [],
  };
}

async function loadMemory() {
  try {
    const raw = await readFile(MEMORY_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return {
      likes: Array.isArray(parsed?.likes) ? parsed.likes.filter((item) => typeof item === "string") : [],
      dislikes: Array.isArray(parsed?.dislikes) ? parsed.dislikes.filter((item) => typeof item === "string") : [],
      name: typeof parsed?.name === "string" ? parsed.name : null,
      last_opened_apps: Array.isArray(parsed?.last_opened_apps)
        ? parsed.last_opened_apps.filter((item) => typeof item === "string")
        : [],
      recent_actions: Array.isArray(parsed?.recent_actions)
        ? parsed.recent_actions
            .filter((item) => item && typeof item === "object")
            .map((item) => ({
              ts: typeof item.ts === "string" ? item.ts : new Date().toISOString(),
              type: typeof item.type === "string" ? item.type : "unknown",
              summary: typeof item.summary === "string" ? item.summary : "",
            }))
        : [],
    };
  } catch (error) {
    if (error?.code === "ENOENT") return defaultMemory();
    return defaultMemory();
  }
}

async function saveMemory(memory) {
  await mkdir(dirname(MEMORY_FILE), { recursive: true });
  await writeFile(MEMORY_FILE, `${JSON.stringify(memory, null, 2)}\n`, "utf8");
}

function cleanMemoryValue(value) {
  return String(value)
    .trim()
    .replace(/^[\s"'`]+|[\s"'`.!?]+$/g, "")
    .trim();
}

function updateMemoryFromText(memory, text) {
  const rawText = String(text);
  let changed = false;

  const likeMatch = rawText.match(/(?:я люблю|мне нравится|мне нравятся|i like)\s+(.+)/i);
  if (likeMatch?.[1]) {
    const value = cleanMemoryValue(likeMatch[1]);
    if (value && !memory.likes.includes(value)) {
      memory.likes.push(value);
      changed = true;
    }
  }

  const dislikeMatch = rawText.match(/(?:я не люблю|мне не нравится|мне не нравятся|i don't like|i dislike)\s+(.+)/i);
  if (dislikeMatch?.[1]) {
    const value = cleanMemoryValue(dislikeMatch[1]);
    if (value && !memory.dislikes.includes(value)) {
      memory.dislikes.push(value);
      changed = true;
    }
  }

  const nameMatch = rawText.match(/(?:меня зовут|зови меня|my name is)\s+(.+)/i);
  if (nameMatch?.[1]) {
    const value = cleanMemoryValue(nameMatch[1]);
    if (value && memory.name !== value) {
      memory.name = value;
      changed = true;
    }
  }

  return changed;
}

function formatKnownMemory(memory) {
  const facts = [];
  if (memory.name) facts.push(`- user name: ${memory.name}`);
  if (memory.likes.length) facts.push(`- user likes: ${memory.likes.join(", ")}`);
  if (memory.dislikes.length) facts.push(`- user dislikes: ${memory.dislikes.join(", ")}`);
  if (memory.last_opened_apps.length) facts.push(`- last opened apps: ${memory.last_opened_apps.join(", ")}`);
  return facts.length ? `Known user facts:\n${facts.join("\n")}` : "Known user facts: none yet.";
}

function queryMemoryAnswer(prompt, memory) {
  const text = normalizeText(prompt);

  if (containsAny(text, ["что я люблю", "что мне нравится", "what do i like", "what do i love", "what do i enjoy"])) {
    if (memory.likes.length) {
      return `Вы говорили, что любите ${memory.likes.join(", ")}.`;
    }
    return "Пока не знаю, что вы любите.";
  }

  if (containsAny(text, ["как меня зовут", "что меня зовут", "what is my name", "who am i", "what am i called"])) {
    if (memory.name) {
      return `Вы говорили, что вас зовут ${memory.name}.`;
    }
    return "Пока не знаю, как вас зовут.";
  }

  if (containsAny(text, ["что я не люблю", "что мне не нравится", "what don't i like", "what do i dislike"])) {
    if (memory.dislikes.length) {
      return `Вы говорили, что вам не нравится ${memory.dislikes.join(", ")}.`;
    }
    return "Пока не знаю, что вам не нравится.";
  }

  if (containsAny(text, ["что я делал", "последнее действие", "what did i do", "what did i open", "recent actions"])) {
    if (memory.recent_actions.length) {
      const recent = memory.recent_actions.slice(-3).reverse();
      return `Последние действия:\n${recent.map((item) => `- ${item.summary}`).join("\n")}`;
    }
    return "Пока нет сохраненных действий.";
  }

  if (containsAny(text, ["что я открывал", "какие приложения я открывал", "what apps did i open"])) {
    if (memory.last_opened_apps.length) {
      return `Последние открытые приложения: ${memory.last_opened_apps.join(", ")}.`;
    }
    return "Пока нет сохраненных приложений.";
  }

  return null;
}

function getLastAssistantAnswer(memory) {
  const lastDialog = [...memory.recent_actions].reverse().find((item) => item.type === "dialog" && item.summary.includes("->"));
  if (!lastDialog) return null;
  const parts = lastDialog.summary.split("->");
  if (parts.length < 2) return null;
  return parts.slice(1).join("->").trim();
}

function humanizeMusicAction(action) {
  const map = {
    play: "Music is playing.",
    pause: "Music paused.",
    toggle: "Music toggled.",
    next: "Skipped to the next track.",
    previous: "Went to the previous track.",
    stop: "Music stopped.",
  };
  return map[action] ?? `Music action completed: ${action}.`;
}

function humanizeVolumeAction(action) {
  const map = {
    up: "Volume increased.",
    down: "Volume decreased.",
    mute: "Volume muted.",
    unmute: "Volume unmuted.",
    set: "Volume updated.",
  };
  return map[action] ?? `Volume action completed: ${action}.`;
}

function rememberInteraction(memory, { prompt, answer, directAction }) {
  if (directAction?.type === "open_app") {
    const appName = directAction.arguments?.appName;
    if (typeof appName === "string" && appName.trim()) {
      const normalized = appName.trim();
      memory.last_opened_apps = [normalized, ...memory.last_opened_apps.filter((item) => item !== normalized)].slice(0, 5);
      memory.recent_actions.push({
        ts: new Date().toISOString(),
        type: "open_app",
        summary: `opened ${normalized}`,
      });
    }
  } else if (directAction?.type === "open_path") {
    const path = directAction.arguments?.path;
    if (typeof path === "string" && path.trim()) {
      memory.recent_actions.push({
        ts: new Date().toISOString(),
        type: "open_path",
        summary: `opened ${path.trim()}`,
      });
    }
  } else if (directAction?.type === "music_control") {
    const action = directAction.arguments?.action;
    if (typeof action === "string" && action.trim()) {
      memory.recent_actions.push({
        ts: new Date().toISOString(),
        type: "music_control",
        summary: `music ${action.trim()}`,
      });
    }
  } else if (directAction?.type === "music_status") {
    memory.recent_actions.push({
      ts: new Date().toISOString(),
      type: "music_status",
      summary: "asked for current music status",
    });
  } else if (directAction?.type === "disk_free") {
    memory.recent_actions.push({
      ts: new Date().toISOString(),
      type: "disk_free",
      summary: "checked disk free space",
    });
  } else if (directAction?.type === "clipboard_get") {
    memory.recent_actions.push({
      ts: new Date().toISOString(),
      type: "clipboard_get",
      summary: "read clipboard text",
    });
  } else if (directAction?.type === "clipboard_set") {
    memory.recent_actions.push({
      ts: new Date().toISOString(),
      type: "clipboard_set",
      summary: "wrote text to clipboard",
    });
  }

  memory.recent_actions.push({
    ts: new Date().toISOString(),
    type: "dialog",
    summary: `${String(prompt).trim()} -> ${String(answer).trim()}`,
  });

  memory.recent_actions = memory.recent_actions.slice(-12);
  updateMemoryFromText(memory, prompt);
}

async function appendHistory(role, content) {
  if (typeof content !== "string" || !content.trim()) return;
  await mkdir(dirname(HISTORY_FILE), { recursive: true });
  await appendFile(HISTORY_FILE, `${JSON.stringify({ ts: new Date().toISOString(), role, content })}\n`, "utf8");
}

function detectDirectAction(prompt, memory) {
  const text = normalizeText(prompt);
  const compact = text.replace(/[.!?]+$/g, "");
  const openAppMap = {
    safari: "Safari",
    browser: "Safari",
    finder: "Finder",
    files: "Finder",
    notes: "Notes",
    terminal: "Terminal",
    settings: "System Settings",
    "system settings": "System Settings",
    music: "Music",
  };

  if (/^\/(open|launch)\s+/i.test(prompt)) {
    const appName = prompt.replace(/^\/(open|launch)\s+/i, "").trim();
    if (appName) return { type: "open_app", arguments: { appName } };
  }

  const memoryAnswer = queryMemoryAnswer(prompt, memory);
  if (memoryAnswer) {
    return { type: "final", content: memoryAnswer };
  }

  if (containsAny(text, ["что в буфере обмена", "покажи буфер обмена", "что скопировано", "show clipboard", "what's in the clipboard"])) {
    return { type: "clipboard_get", arguments: {} };
  }

  if (containsAny(text, ["скопируй это", "скопируй последний ответ", "copy this", "copy that"])) {
    const lastAnswer = getLastAssistantAnswer(memory);
    if (lastAnswer) {
      return { type: "clipboard_set", arguments: { text: lastAnswer } };
    }
  }

  const copyMatch = String(prompt).match(/^скопируй\s*[:\-]?\s+(.+)/i);
  if (copyMatch?.[1]) {
    const textValue = cleanMemoryValue(copyMatch[1]);
    if (textValue) return { type: "clipboard_set", arguments: { text: textValue } };
  }

  if (containsAny(text, ["открой finder", "запусти finder", "open finder", "launch finder"])) {
    return openAppAction("Finder");
  }

  if (containsAny(text, ["открой safari", "запусти safari", "open safari", "launch safari", "открой браузер", "запусти браузер"])) {
    return openAppAction("Safari");
  }

  if (
    containsAny(text, [
      "открой downloads",
      "открой загрузки",
      "открой папку downloads",
      "открой папку загрузки",
      "open downloads",
      "open загрузки",
      "open downloads folder",
      "launch downloads",
    ]) ||
    /^открой\s+(папку\s+)?downloads$/i.test(text) ||
    /^open\s+(the\s+)?downloads(\s+folder)?$/i.test(text)
  ) {
    return openPathAction("~/Downloads");
  }

  if (
    containsAny(text, [
      "открой documents",
      "открой документы",
      "открой папку documents",
      "open documents",
      "open документы",
      "open documents folder",
      "launch documents",
    ]) ||
    /^открой\s+(папку\s+)?documents$/i.test(text) ||
    /^open\s+(the\s+)?documents(\s+folder)?$/i.test(text)
  ) {
    return openPathAction("~/Documents");
  }

  if (
    containsAny(text, [
      "открой pictures",
      "открой картинки",
      "открой папку pictures",
      "open pictures",
      "open картинки",
      "open pictures folder",
      "launch pictures",
    ]) ||
    /^открой\s+(папку\s+)?pictures$/i.test(text) ||
    /^open\s+(the\s+)?pictures(\s+folder)?$/i.test(text)
  ) {
    return openPathAction("~/Pictures");
  }

  if (containsAny(text, ["открой desktop", "открой рабочий стол", "open desktop", "open рабочий стол"])) {
    return openPathAction("~/Desktop");
  }

  if (/^\/music\s+(play|pause|toggle|next|previous|stop)\b/i.test(prompt)) {
    const action = prompt.match(/^\/music\s+(play|pause|toggle|next|previous|stop)\b/i)?.[1];
    if (action) return { type: "music_control", arguments: { action } };
  }

  if (/^(open|launch)\s+music$/i.test(text) || text.includes("включи музыку") || text.includes("открой музыку")) {
    return { type: "open_app", arguments: { appName: "Music" } };
  }

  for (const [needle, appName] of Object.entries(openAppMap)) {
    if (text === `open ${needle}` || text === `launch ${needle}` || text === `открой ${needle}` || text === `запусти ${needle}`) {
      return { type: "open_app", arguments: { appName } };
    }
  }

  if (
    compact === "play" ||
    compact === "pause" ||
    compact === "toggle" ||
    compact === "next" ||
    compact === "previous" ||
    compact === "stop"
  ) {
    return { type: "music_control", arguments: { action: compact } };
  }

  if (
    containsAny(text, ["включи музыку", "запусти музыку", "открой музыку", "play music", "start music", "open music"]) ||
    compact === "music"
  ) {
    return openAppAction("Music");
  }

  if (containsAny(text, ["следующий трек", "next track", "следующая песня"])) {
    return { type: "music_control", arguments: { action: "next" } };
  }

  if (containsAny(text, ["предыдущий трек", "previous track", "верни предыдущий", "предыдущая песня"])) {
    return { type: "music_control", arguments: { action: "previous" } };
  }

  if (containsAny(text, ["пауза", "поставь на паузу", "pause music", "stop music"])) {
    return { type: "music_control", arguments: { action: "pause" } };
  }

  if (containsAny(text, ["продолжи музыку", "возобнови музыку", "resume music", "play music"])) {
    return { type: "music_control", arguments: { action: "play" } };
  }

  if (
    text.includes("play music") ||
    text.includes("start music") ||
    text.includes("music player") ||
    text.includes("включи музыку") ||
    text.includes("запусти музыку")
  ) {
    return { type: "open_app", arguments: { appName: "Music" } };
  }

  if (/^\/volume\s+(up|down|mute|unmute)\b/i.test(prompt)) {
    const action = prompt.match(/^\/volume\s+(up|down|mute|unmute)\b/i)?.[1];
    if (action) return { type: "volume_control", arguments: { action } };
  }

  if (/^\/volume\s+set\s+\d{1,3}\b/i.test(prompt)) {
    const value = prompt.match(/^\/volume\s+set\s+(\d{1,3})\b/i)?.[1];
    if (value) return { type: "volume_control", arguments: { action: "set", value } };
  }

  if (compact === "volume up" || compact === "louder" || compact === "turn volume up") {
    return { type: "volume_control", arguments: { action: "up" } };
  }

  if (compact === "volume down" || compact === "quieter" || compact === "turn volume down") {
    return { type: "volume_control", arguments: { action: "down" } };
  }

  if (compact === "mute" || compact === "mute volume") {
    return { type: "volume_control", arguments: { action: "mute" } };
  }

  if (compact === "unmute" || compact === "unmute volume") {
    return { type: "volume_control", arguments: { action: "unmute" } };
  }

  if (containsAny(text, ["громче", "прибавь громкость", "увеличь громкость", "make it louder", "volume up"])) {
    return { type: "volume_control", arguments: { action: "up" } };
  }

  if (containsAny(text, ["тише", "убавь громкость", "уменьши громкость", "make it quieter", "volume down"])) {
    return { type: "volume_control", arguments: { action: "down" } };
  }

  if (containsAny(text, ["выключи звук", "без звука", "mute volume", "mute"])) {
    return { type: "volume_control", arguments: { action: "mute" } };
  }

  if (/^\/clip\s+get\b/i.test(prompt) || compact === "clipboard" || compact === "copy clipboard") {
    return { type: "clipboard_get", arguments: {} };
  }

  if (/^\/clip\s+set\s+/i.test(prompt)) {
    const textValue = prompt.replace(/^\/clip\s+set\s+/i, "").trim();
    if (textValue) return { type: "clipboard_set", arguments: { text: textValue } };
  }

  if (/^\/play\s+/i.test(prompt)) {
    const target = prompt.replace(/^\/play\s+/i, "").trim();
    if (target) return { type: "run_shell", arguments: { command: "afplay", args: [target] } };
    return { type: "music_control", arguments: { action: "play" } };
  }

  if (containsAny(text, ["какая музыка сейчас играет", "что сейчас играет", "what is playing", "what's playing", "now playing"])) {
    return { type: "music_status", arguments: {} };
  }

  if (containsAny(text, ["сколько свободного места на диске", "сколько места на диске", "free disk space", "disk space", "сколько гб свободно", "сколько gb свободно"])) {
    return { type: "disk_free", arguments: {} };
  }

  if (text.includes("play a song") || text.includes("play audio") || text.includes("включи звук")) {
    return { type: "final", content: "Нужен путь к аудиофайлу. Например: /play /Users/a1/Music/song.mp3" };
  }

  return null;
}

async function executeDirectAction(action, config) {
  const tools = createTools(WORKSPACE);
  const tool = tools[action.type];
  if (!tool) {
    throw new Error(`Unknown direct action: ${action.type}`);
  }
  const result = await tool(action.arguments ?? {});
  if (action.type === "open_app") {
    return `Opened ${action.arguments.appName}.`;
  }
  if (action.type === "open_path") {
    return `Opened ${action.arguments.path}.`;
  }
  if (action.type === "music_control") {
    return humanizeMusicAction(action.arguments?.action);
  }
  if (action.type === "volume_control") {
    return humanizeVolumeAction(action.arguments?.action);
  }
  if (action.type === "clipboard_set") {
    return "Copied to clipboard.";
  }
  if (action.type === "clipboard_get") {
    return typeof result === "string" ? result : formatToolResult(result);
  }
  if (action.type === "music_status") {
    if (result && typeof result === "object") {
      if (result.state === "stopped") return "Music is stopped.";
      const title = result.title ?? "unknown track";
      const artist = result.artist ? ` by ${result.artist}` : "";
      return `Now playing: ${title}${artist}.`;
    }
  }
  if (action.type === "disk_free" && result && typeof result === "object") {
    return `Free disk space: ${result.free} of ${result.total} available on ${result.mount}.`;
  }
  return typeof result === "string" ? result : formatToolResult(result);
}

async function resolvePrompt(prompt, config, memory) {
  const directAction = detectDirectAction(prompt, memory);
  if (!directAction) {
    return { answer: await runAgent(prompt, config, memory), directAction: null };
  }

  if (directAction.type === "final") {
    return { answer: directAction.content ?? "", directAction };
  }

  return { answer: await executeDirectAction(directAction, config), directAction };
}

function toolPrompt() {
  const tools = TOOL_SPEC.map((tool) => {
    const args = Object.entries(tool.arguments)
      .map(([key, value]) => `${key}: ${value}`)
      .join(", ");
    return `- ${tool.name}: ${tool.description}\n  arguments: { ${args} }`;
  }).join("\n");

  return `You are Clama, a local coding agent running inside a terminal.

Work inside this workspace only: ${WORKSPACE}
You can use the recent conversation history below as context.

Available tools:
${tools}

Rules:
- If you need a tool, respond with ONLY valid JSON.
- Tool call format: {"type":"tool","name":"tool_name","arguments":{...}}
- When you are done, respond with ONLY valid JSON.
- Final answer format: {"type":"final","content":"..."}
- Do not wrap JSON in markdown.
- Keep tool arguments minimal and correct.
- If a command fails, inspect the error and try a better next step.
- If the user asks for a local computer action, prefer tools over explanation.
- For macOS app launch, use open_app.
- For opening folders/files, use open_path.
- For Music playback controls, use music_control.
- For current track info, use music_status.
- For volume changes, use volume_control.
- For clipboard text, use clipboard_get and clipboard_set.
- For disk space questions, use disk_free.
- For audio playback, use run_shell with commands like "afplay /path/to/file.mp3" or use open_app for Music.
- Example: {"type":"tool","name":"open_app","arguments":{"appName":"Music"}}
- Example: {"type":"tool","name":"open_path","arguments":{"path":"~/Downloads"}}
- Example: {"type":"tool","name":"music_control","arguments":{"action":"play"}}
- Example: {"type":"tool","name":"music_status","arguments":{}}
- Example: {"type":"tool","name":"volume_control","arguments":{"action":"up"}}
- Example: {"type":"tool","name":"disk_free","arguments":{}}
- Example: {"type":"tool","name":"clipboard_set","arguments":{"text":"hello"}}
- Example: {"type":"tool","name":"run_shell","arguments":{"command":"afplay","args":["/Users/a1/Music/song.mp3"]}}
- If the request is specifically about opening Music, the app should be opened directly.
- Be concise, concrete, and practical.`;
}

function parseModelOutput(text) {
  const trimmed = text.trim();
  const candidates = [trimmed];
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) candidates.unshift(fenced[1].trim());
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {}
  }
  return null;
}

async function askModel(config, messages) {
  const content = await chatCompletion({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    model: config.model,
    temperature: config.temperature,
    messages,
  });
  return content;
}

async function runAgent(initialPrompt, config, memory) {
  const tools = createTools(WORKSPACE);
  const history = await loadHistory();
  const messages = [
    { role: "system", content: toolPrompt() },
    { role: "system", content: formatKnownMemory(memory) },
    ...history,
    { role: "user", content: initialPrompt },
  ];

  for (let step = 0; step < MAX_STEPS; step += 1) {
    const raw = await askModel(config, messages);
    const parsed = parseModelOutput(raw);

    if (!parsed) {
      messages.push({
        role: "user",
        content: `Your previous response was not valid JSON. Return ONLY valid JSON. Raw response:\n${raw}`,
      });
      continue;
    }

    if (parsed.type === "final") {
      return parsed.content ?? "";
    }

    if (parsed.type !== "tool" || typeof parsed.name !== "string") {
      messages.push({
        role: "user",
        content: `Unsupported response shape. Return either {"type":"tool",...} or {"type":"final",...}.`,
      });
      continue;
    }

    const tool = tools[parsed.name];
    if (!tool) {
      messages.push({
        role: "user",
        content: `Unknown tool "${parsed.name}". Available tools: ${Object.keys(tools).join(", ")}`,
      });
      continue;
    }

    try {
      const result = await tool(parsed.arguments ?? {});
      messages.push({ role: "assistant", content: raw });
      messages.push({
        role: "user",
        content: `Tool result for ${parsed.name}:\n${formatToolResult(result)}`,
      });
    } catch (error) {
      messages.push({ role: "assistant", content: raw });
      messages.push({
        role: "user",
        content: `Tool error for ${parsed.name}: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  throw new Error(`Agent reached max steps (${MAX_STEPS}) without a final answer.`);
}

function printBanner(config) {
  output.write(`Clama
workspace: ${WORKSPACE}
model: ${config.model}
baseUrl: ${config.baseUrl}
`);
}

async function main() {
  const config = getConfig();
  await migrateLegacyState();
  const memory = await loadMemory();
  printBanner(config);

  const rl = createInterface({ input, output });
  const argPrompt = process.argv.slice(2).join(" ").trim();

  if (argPrompt) {
    try {
      const result = await resolvePrompt(argPrompt, config, memory);
      const answer = result.answer;
      output.write(`\n${answer}\n`);
      rememberInteraction(memory, { prompt: argPrompt, answer, directAction: result.directAction });
      await saveMemory(memory);
      await appendHistory("user", argPrompt);
      await appendHistory("assistant", answer);
    } catch (error) {
      output.write(`\nError: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    } finally {
      rl.close();
    }
    return;
  }

  output.write("Type a request. Empty line exits.\n");
  while (true) {
    const prompt = await rl.question("\n> ");
    if (!prompt.trim()) break;
    try {
      const result = await resolvePrompt(prompt, config, memory);
      const answer = result.answer;
      output.write(`\n${answer}\n`);
      rememberInteraction(memory, { prompt, answer, directAction: result.directAction });
      await saveMemory(memory);
      await appendHistory("user", prompt);
      await appendHistory("assistant", answer);
    } catch (error) {
      output.write(`\nError: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }

  rl.close();
}

main().catch((error) => {
  output.write(`Fatal error: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
