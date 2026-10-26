/**
 * The one detached rule for every place a shell command string is visible (a known tool's argument, a script's command
 * literal, a Codex CommandExecution, a Paseo shell row): does this command leave something running after it returns?
 * Only shell structure counts. Quoted arguments, heredoc bodies and comments are text, not commands, so searching for
 * the word `nohup` does not match; a `sh -c '…'` body is a command and is checked too. SESSION-HANDOFF-SPEC §5.7.
 */
const wrappers = /^(?:(?:\w+=\S*|sudo(?:\s+-[ugCDhprtU]\s+\S+|\s+-[A-Za-z]+)*|env(?:\s+-[uSC]\s+\S+|\s+-\S+)*|exec|command|builtin|nice(?:\s+-n\s*-?\d+|\s+-\d+)?|time|caffeinate(?:\s+-\w+)*)\s+)+/;
const daemonizing: RegExp[] = [
  /^(?:nohup|setsid|disown|daemonize)\b/,
  /^docker(?:-compose|\s+compose)\b.*\bup\b.*\s(?:-(?!-)[A-Za-z]*d[A-Za-z]*|--detach)\b/,
  /^docker(?:\s+container)?\s+(?:run|create\b.*\bstart)\b.*\s(?:-(?!-)[A-Za-z]*d[A-Za-z]*|--detach)\b/,
  /^docker(?:\s+container)?\s+start\b(?!.*\s(?:-(?!-)[A-Za-z]*[ai][A-Za-z]*|--attach|--interactive)\b)/,
  /^tmux\b.*\bnew(?:-session|-window)?\b.*\s-(?!-)[A-Za-z]*d/,
  /^screen\b.*\s-(?:[A-Za-z]*d[A-Za-z]*m|[A-Za-z]*m[A-Za-z]*d)/, /^screen\b.*\s-d\b.*\s-m\b/,
  /^pm2\s+(?:start|restart|reload)\b/,
  /^brew\s+services\s+(?:start|restart|run)\b/,
  /^launchctl\s+(?:load|bootstrap|kickstart|start)\b/,
  /^systemctl\s+(?:--user\s+)?(?:start|restart|reload-or-restart|enable\s+--now)\b/,
  /^start-stop-daemon\b.*\s(?:--background|-b)\b/,
];

/** Shell code with quoted strings replaced by `_` and heredoc bodies and comments removed; `sh -c` bodies are returned separately. */
function shellCode(command: string): { code: string; bodies: string[] } {
  let code = "", quote: "'" | '"' | undefined, quoted = "", heredoc: { word: string; tabs: boolean }[] = [];
  const bodies: string[] = [];
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      if (c === "\\" && quote === '"') { quoted += command.slice(i, i + 2); i++; continue; }
      if (c !== quote) { quoted += c; continue; }
      // The body of `sh -c '…'` runs as a command.
      if (/(?:^|[\s;&|(])(?:\S*\/)?(?:ba|z|da|k)?sh\s+(?:-\w+\s+)*-\w*c\w*\s*$/.test(code)) bodies.push(quoted);
      code += "_"; quote = undefined; quoted = ""; continue;
    }
    if (c === "\\") { code += " "; i++; continue; }
    if (c === "'" || c === '"') { quote = c; continue; }
    if (c === "#" && (i === 0 || /[\s;&|(]/.test(command[i - 1]))) { while (i + 1 < command.length && command[i + 1] !== "\n") i++; continue; }
    if (c === "<" && command[i + 1] === "<" && command[i + 2] !== "<") {
      const match = /^<<(-?)\s*(['"]?)([\w.-]+)\2/.exec(command.slice(i));
      if (match) { heredoc.push({ word: match[3], tabs: match[1] === "-" }); code += " "; i += match[0].length - 1; continue; }
    }
    if (c === "\n" && heredoc.length) {
      // Skip each pending heredoc body up to its delimiter line.
      let position = i + 1;
      for (const { word, tabs } of heredoc) {
        while (position < command.length) {
          const end = command.indexOf("\n", position), stop = end === -1 ? command.length : end, line = command.slice(position, stop);
          position = stop + 1;
          if ((tabs ? line.replace(/^\t+/, "") : line) === word) break;
        }
      }
      i = position - 1; heredoc = []; code += "\n"; continue;
    }
    code += c;
  }
  return { code, bodies };
}

export function detachedCommand(command: string, depth = 0): boolean {
  if (!command || depth > 2) return false;
  const { code, bodies } = shellCode(command.length > 64 * 1024 ? command.slice(0, 64 * 1024) : command);
  // A lone `&` (not `&&`, `>&`, `<&`, `|&`, `&>`) puts a job in the background.
  if (/(?<![&|<>])&(?![&>])/.test(code)) return true;
  for (const raw of code.split(/&&|\|\||[;|&\n()]/)) {
    const segment = raw.trim().replace(wrappers, "");
    if (segment && daemonizing.some((pattern) => pattern.test(segment))) return true;
  }
  return bodies.some((body) => detachedCommand(body, depth + 1));
}
