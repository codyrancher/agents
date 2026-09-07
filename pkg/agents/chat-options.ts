// What claude in this pod can be told to do, read from claude rather than written down here.
//
// The chat view offers menus for the model, the effort level, the permission mode and the MCP
// servers - the things Claude Code's own UI lets somebody change mid-conversation. The values
// in those menus are the one thing that must not be a list in this file: claude is updated
// inside the pod, on its own schedule, and a hard-coded set of model aliases is wrong the first
// time a new one ships. `claude --help` knows, and it is one exec away.
//
// So everything here is a parser. The reading and the applying live in ChatPane, which has the
// pod; these are pure functions over what came back, which is what makes them checkable.

/** One flag's help text: its own line, plus the wrapped continuation lines under it. */
export function helpSection(help: string, flag: string): string {
  const lines = String(help || '').split('\n');
  const start = lines.findIndex((line) => new RegExp(`^\\s*(-\\w, )?${ flag }[ =<]`).test(line));

  if (start < 0) {
    return '';
  }

  const out = [lines[start]];

  // A continuation is indented past the flag column and does not itself start an option. That
  // is the whole shape of commander's output, and it is stable across versions in a way that
  // counting columns is not.
  for (let i = start + 1; i < lines.length && !/^\s*-/.test(lines[i]); i++) {
    out.push(lines[i]);
  }

  return out.join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * The model aliases, and only the aliases.
 *
 * claude's sentence is "an alias for the latest model (e.g. 'fable', 'opus', or 'sonnet') or a
 * model's full name (e.g. 'claude-fable-5')", so everything from "full name" onwards is an
 * example of the other kind of answer and must not be offered as an alias - it is one model,
 * pinned, which is not what a menu of three is for.
 */
export function modelAliases(help: string): string[] {
  const section = helpSection(help, '--model');
  const head = section.split(/full name/)[0];

  return [...head.matchAll(/'([A-Za-z0-9][\w.-]*)'/g)].map((m) => m[1])
    .filter((alias, i, all) => all.indexOf(alias) === i);
}

/**
 * The values in a flag's parenthesised list, however it is spelled.
 *
 * Two shapes in the same `--help`, because commander writes them differently depending on
 * whether the option declared `choices`:
 *
 *   --effort <level>          ... (low, medium, high, xhigh, max)
 *   --permission-mode <mode>  ... (choices: "acceptEdits", "auto", ...)
 */
export function flagChoices(help: string, flag: string): string[] {
  const section = helpSection(help, flag);
  const quoted = [...section.matchAll(/"([A-Za-z][\w.-]*)"/g)].map((m) => m[1]);

  if (quoted.length) {
    return quoted.filter((value, i, all) => all.indexOf(value) === i);
  }

  // The bare list: the last parenthesised group that is a comma-separated run of plain words.
  const groups = [...section.matchAll(/\(([^()]+)\)/g)].map((m) => m[1]);
  const list = groups.reverse().find((group) => /^[\w.-]+(\s*,\s*[\w.-]+)+$/.test(group.trim()));

  return list ? list.split(',').map((value) => value.trim()).filter(Boolean) : [];
}

export interface McpServer {
  name: string;
  url: string;
  ok: boolean;
  detail: string;
}

/**
 * `claude mcp list`, which reports one server per line with its health:
 *
 *   claude.ai Google Drive: https://drivemcp.googleapis.com/mcp/v1 - ✔ Connected
 *
 * A name may contain spaces and dots; the separator is the colon-space, and there is exactly
 * one of those per line because a URL's colon is followed by a slash.
 */
export function parseMcpList(out: string): McpServer[] {
  const servers: McpServer[] = [];

  for (const line of String(out || '').split('\n')) {
    const match = /^(.+?): (\S+) - (.+)$/.exec(line.trim());

    if (!match) {
      continue;
    }

    const detail = match[3].trim();

    servers.push({
      name: match[1].trim(), url: match[2], ok: /connected/i.test(detail), detail,
    });
  }

  return servers;
}

/**
 * Which model is in force, and what is deciding it.
 *
 * The order is claude's own precedence: the flag the pane was started with beats the
 * environment, which beats settings.json, which beats ~/.claude.json. Reported with its source
 * because "opus, from the argv this pane was started with" and "opus, because settings.json
 * says so" behave differently the moment somebody restarts the pane.
 */
export function currentModel(found: { argv: string; env: string; settings: string; config: string }): { model: string; source: string } {
  const order: [string, string][] = [
    ['argv', found.argv], ['env', found.env], ['settings', found.settings], ['config', found.config],
  ];
  const [source = '', model = ''] = order.find(([, value]) => !!(value || '').trim()) || [];

  return { model: (model || '').trim(), source };
}

/** A value safe to put in a slash command typed into a pane. */
export function isSafeOptionValue(value: string): boolean {
  return /^[\w.-]+$/.test(String(value || '').trim());
}
