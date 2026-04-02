import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { dirname, resolve, relative } from "node:path";
import os from "node:os";
import { mkdir, readFile, readdir, writeFile, stat } from "node:fs/promises";

const execFileAsync = promisify(execFile);

function runProcess(command, args = [], { cwd, input } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      if (code === 0) {
        resolvePromise({ stdout, stderr, code });
      } else {
        const error = new Error(`Command failed: ${command} ${args.join(" ")}`);
        error.code = code;
        error.stdout = stdout;
        error.stderr = stderr;
        rejectPromise(error);
      }
    });

    if (typeof input === "string") {
      child.stdin.end(input);
    } else {
      child.stdin.end();
    }
  });
}

function formatBytes(bytes) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const rounded = value >= 10 || unitIndex === 0 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[unitIndex]}`;
}

function ensureInsideWorkspace(workspace, targetPath) {
  const resolvedWorkspace = resolve(workspace);
  const resolvedTarget = resolve(workspace, targetPath);
  const rel = relative(resolvedWorkspace, resolvedTarget);
  if (rel.startsWith("..") || rel === ".." || rel === "") {
    if (rel === "") return resolvedTarget;
    throw new Error(`Refusing to access path outside workspace: ${targetPath}`);
  }
  return resolvedTarget;
}

export function createTools(workspace) {
  return {
    list_files: async ({ path = "." } = {}) => {
      const dir = ensureInsideWorkspace(workspace, path);
      const { stdout } = await execFileAsync("rg", ["--files", dir], {
        cwd: workspace,
        maxBuffer: 1024 * 1024 * 8,
      }).catch((error) => {
        if (error?.code === 1) return { stdout: "" };
        throw error;
      });
      return stdout
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((filePath) => ({ path: filePath, name: filePath.split("/").pop() ?? filePath }));
    },

    read_file: async ({ path }) => {
      if (!path) throw new Error("read_file requires path");
      const filePath = ensureInsideWorkspace(workspace, path);
      return await readFile(filePath, "utf8");
    },

    write_file: async ({ path, content }) => {
      if (!path) throw new Error("write_file requires path");
      if (typeof content !== "string") throw new Error("write_file requires string content");
      const filePath = ensureInsideWorkspace(workspace, path);
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, content, "utf8");
      return { path: filePath, bytesWritten: Buffer.byteLength(content, "utf8") };
    },

    replace_text: async ({ path, from, to, all = true }) => {
      if (!path) throw new Error("replace_text requires path");
      if (typeof from !== "string" || typeof to !== "string") {
        throw new Error("replace_text requires string from/to");
      }
      const filePath = ensureInsideWorkspace(workspace, path);
      let content = await readFile(filePath, "utf8");
      const next = all ? content.split(from).join(to) : content.replace(from, to);
      if (next === content) {
        return { path: filePath, changed: false, replaced: 0 };
      }
      await writeFile(filePath, next, "utf8");
      return { path: filePath, changed: true, replaced: all ? content.split(from).length - 1 : 1 };
    },

    search_text: async ({ pattern = ".", path = ".", flags = "-nH" } = {}) => {
      const dir = ensureInsideWorkspace(workspace, path);
      const flagArgs = String(flags)
        .split(/\s+/)
        .map((part) => part.trim())
        .filter(Boolean);
      try {
        const { stdout } = await execFileAsync("rg", [...flagArgs, pattern, dir], {
          cwd: workspace,
          maxBuffer: 1024 * 1024 * 8,
        });
        return stdout;
      } catch (error) {
        if (error?.code === 1) return "";
        throw error;
      }
    },

    run_shell: async ({ command, args = [] }) => {
      if (!command) throw new Error("run_shell requires command");
      const commandArgs = Array.isArray(args) ? args : [];
      const isCompound = commandArgs.length === 0 && /\s/.test(command);
      const execTarget = isCompound ? "sh" : command;
      const execArgs = isCompound ? ["-lc", command] : commandArgs;
      const { stdout, stderr } = await execFileAsync(execTarget, execArgs, {
        cwd: workspace,
        maxBuffer: 1024 * 1024 * 8,
        shell: false,
      });
      return { stdout, stderr };
    },

    open_app: async ({ appName }) => {
      if (!appName || typeof appName !== "string") {
        throw new Error("open_app requires appName");
      }
      const { stdout, stderr } = await execFileAsync("open", ["-a", appName], {
        cwd: workspace,
        maxBuffer: 1024 * 1024 * 4,
      });
      return { stdout, stderr, appName };
    },

    open_path: async ({ path }) => {
      if (!path || typeof path !== "string") {
        throw new Error("open_path requires path");
      }
      const expandedPath = path.startsWith("~") ? path.replace(/^~/, os.homedir()) : path;
      const { stdout, stderr } = await execFileAsync("open", [expandedPath], {
        cwd: workspace,
        maxBuffer: 1024 * 1024 * 4,
      });
      return { stdout, stderr, path: expandedPath };
    },

    music_control: async ({ action }) => {
      if (!action || typeof action !== "string") {
        throw new Error("music_control requires action");
      }

      const scriptMap = {
        play: 'tell application "Music" to play',
        pause: 'tell application "Music" to pause',
        toggle: 'tell application "Music" to playpause',
        next: 'tell application "Music" to next track',
        previous: 'tell application "Music" to previous track',
        stop: 'tell application "Music" to stop',
      };

      const script = scriptMap[action];
      if (!script) {
        throw new Error(`Unsupported music action: ${action}`);
      }

      const { stdout, stderr } = await execFileAsync("osascript", ["-e", script], {
        cwd: workspace,
        maxBuffer: 1024 * 1024 * 4,
      });
      return { stdout, stderr, action };
    },

    music_status: async () => {
      const script = [
        'tell application "Music"',
        'if it is running is false then return "stopped\\n\\n\\n"',
        'if player state is stopped then return "stopped\\n\\n\\n"',
        'return (player state as text) & linefeed & name of current track & linefeed & artist of current track & linefeed & album of current track',
        'end tell',
      ];

      const { stdout } = await execFileAsync("osascript", script.flatMap((line) => ["-e", line]), {
        cwd: workspace,
        maxBuffer: 1024 * 1024 * 4,
      });

      const [state = "", title = "", artist = "", album = ""] = String(stdout)
        .split("\n")
        .map((part) => part.trim());

      return {
        state,
        title: title || null,
        artist: artist || null,
        album: album || null,
      };
    },

    volume_control: async ({ action, value }) => {
      if (!action || typeof action !== "string") {
        throw new Error("volume_control requires action");
      }

      if (action === "mute" || action === "unmute") {
        const script = action === "mute" ? "set volume with output muted" : "set volume without output muted";
        const { stdout, stderr } = await execFileAsync("osascript", ["-e", script], {
          cwd: workspace,
          maxBuffer: 1024 * 1024 * 4,
        });
        return { stdout, stderr, action, value };
      }

      let script;
      if (action === "set") {
        const numericValue = Number(value);
        if (!Number.isFinite(numericValue)) {
          throw new Error("volume_control action=set requires numeric value");
        }
        const clamped = Math.max(0, Math.min(100, Math.round(numericValue)));
        script = `set volume output volume ${clamped}`;
      } else if (action === "up" || action === "down") {
        const { stdout } = await execFileAsync("osascript", ["-e", "output volume of (get volume settings)"], {
          cwd: workspace,
          maxBuffer: 1024 * 1024 * 4,
        });
        const currentVolume = Number(String(stdout).trim());
        if (!Number.isFinite(currentVolume)) {
          throw new Error("Could not read current volume");
        }
        const next = action === "up" ? Math.min(100, currentVolume + 10) : Math.max(0, currentVolume - 10);
        script = `set volume output volume ${Math.round(next)}`;
      }

      if (!script) {
        throw new Error(`Unsupported volume action: ${action}`);
      }

      const { stdout, stderr } = await execFileAsync("osascript", ["-e", script], {
        cwd: workspace,
        maxBuffer: 1024 * 1024 * 4,
      });
      return { stdout, stderr, action, value };
    },

    clipboard_get: async () => {
      const { stdout } = await execFileAsync("pbpaste", [], {
        cwd: workspace,
        maxBuffer: 1024 * 1024 * 4,
      });
      return stdout;
    },

    clipboard_set: async ({ text }) => {
      if (typeof text !== "string") {
        throw new Error("clipboard_set requires text");
      }
      const { stdout, stderr } = await runProcess("pbcopy", [], { cwd: workspace, input: text });
      return { stdout, stderr, length: text.length };
    },

    disk_free: async () => {
      const { stdout } = await execFileAsync("df", ["-k", "/"], {
        cwd: workspace,
        maxBuffer: 1024 * 1024 * 4,
      });

      const lines = String(stdout)
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);

      if (lines.length < 2) {
        throw new Error("Could not read disk usage");
      }

      const parts = lines[1].split(/\s+/);
      const availableKb = Number(parts[3]);
      const usedKb = Number(parts[2]);
      const totalKb = Number(parts[1]);
      const capacity = parts[4] ?? null;

      if (![availableKb, usedKb, totalKb].every(Number.isFinite)) {
        throw new Error("Could not parse disk usage");
      }

      return {
        mount: "/",
        total: formatBytes(totalKb * 1024),
        used: formatBytes(usedKb * 1024),
        free: formatBytes(availableKb * 1024),
        capacity,
      };
    },

    stat_path: async ({ path }) => {
      if (!path) throw new Error("stat_path requires path");
      const filePath = ensureInsideWorkspace(workspace, path);
      const s = await stat(filePath);
      return {
        path: filePath,
        isFile: s.isFile(),
        isDirectory: s.isDirectory(),
        size: s.size,
        mtime: s.mtime.toISOString(),
      };
    },
  };
}

export function formatToolResult(result) {
  if (typeof result === "string") return result;
  return JSON.stringify(result, null, 2);
}
