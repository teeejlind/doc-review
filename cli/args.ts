// cli/args.ts (P4). The argv grammar of every §9.4 command, parsed with commander into a ParsedCommand without running
// anything. main.ts dispatches on it; tests/unit/cli/skill.test.ts parses every example in references/cli.md with it.
// Global flags on every command: --root <dir>, --pretty, --verbose (§9.1). A parse failure is CliErr USAGE (exit 3).
// Generalization pass: the descriptions name the human by display name (node/identity.ts), resolved once per process
// when a program is first built; `config` is a 27th command; `mdr --version` is handled in main.ts before parsing.
import { Command, CommanderError, Option } from 'commander'
import { nameForAgent } from '../node/identity'
import { cliErr, CliExit } from './output'

export const COMMANDS = [
  'port', 'serve', 'stop', 'open', 'arm', 'status', 'snapshot', 'pending', 'thread', 'comment', 'reply', 'suggest',
  'edit-block', 'write', 'resolve', 'reopen', 'decide', 'withdraw', 'edit-comment', 'delete-comment', 'ack', 'batch',
  'wait', 'disarm', 'history', 'doctor', 'config', 'import-gdoc', 'export-gdoc', 'export-docx', 'tour',
] as const
export type CommandName = (typeof COMMANDS)[number]

export interface ParsedCommand {
  name: CommandName
  /** Positional arguments in order (`<file>`, ids, ...). */
  args: string[]
  /** Options, global ones included, camelCased by commander (e.g. baseRev, insertAfter, waiterGen). */
  opts: Record<string, unknown>
}

type Def = { name: CommandName; usage: string; description: string; options: Array<[string, string]>; build?: (c: Command) => void }

const BODY: Array<[string, string]> = [['--body <text>', 'message body (- reads stdin)'], ['--body-file <file>', 'message body from a file']]
const KEY: Array<[string, string]> = [['--key <key>', 'idempotency key (otherwise the store derives one, §4.7)']]
const policy = (who: string): Array<[string, string]> => [['--suggest-only', 'third-party doc: comments and suggestions only'], ['--allow-edits', `lift suggest-only (only on ${who}'s say-so)`]]

const defs = (who: string): Def[] => {
  const POLICY = policy(who)
  return [
    { name: 'port', usage: 'port [target]', description: 'the root\'s port: formula, window state (§9.2)', options: [] },
    {
      name: 'serve', usage: 'serve [root]', description: 'start or adopt the server for a root',
      options: [['--foreground', 'run the server in this process'], ['--restart', 'stop a same-root server first'], ['--port <n>', 'exact port (tests/dev)']],
    },
    { name: 'stop', usage: 'stop [target]', description: 'stop the same-root server (or every mdr server with --all)', options: [['--all', 'stop every mdr server on this machine\'s port windows']] },
    {
      name: 'open', usage: 'open <file>', description: 'serve if needed, navigate a tab, print the waiter spec',
      options: [...POLICY, ['--launch', 'open the system browser when no tab is connected (no Browser pane)'], ['--offer-tour', 'first-ever use: open nothing and answer tour: "offer" until the tour was offered once'], ['--skip-tour', 'the user declined the tour: record it, then open']],
    },
    { name: 'arm', usage: 'arm <file>', description: 'end-of-turn: announce a waiter loop and print a fresh spec', options: [...POLICY] },
    { name: 'status', usage: 'status <file>', description: 'doc, server, presence and policy', options: [['--wait-waiter <sec>', 'block until a waiter is connected']] },
    {
      name: 'snapshot', usage: 'snapshot <file>', description: 'block refs + rev (and markdown with --md)',
      options: [['--md', 'include each block\'s markdown'], ['--text', 'include each block\'s plain text'], ['--from <ref>', 'first block bN'], ['--to <ref>', 'last block bN']],
    },
    { name: 'pending', usage: 'pending <file>', description: `what ${who} did since the last ack (never acks)`, options: [] },
    { name: 'thread', usage: 'thread <file> <id>', description: 'one thread in full', options: [] },
    {
      name: 'comment', usage: 'comment <file>', description: 'comment on a quote, a block or the doc',
      options: [
        ['--quote <text>', 'exact source text to anchor on'], ['--occurrence <n>', '1-based occurrence of the quote'],
        ['--near <ref>', 'disambiguate a quote by block bN (needs --base-rev)'], ['--base-rev <rev>', 'rev the refs were read at'],
        ['--doc', 'a doc-level comment'], ['--block <ref>', 'anchor on block bN (needs --base-rev)'], ...BODY, ...KEY,
      ],
    },
    { name: 'reply', usage: 'reply <file> <thread>', description: 'reply on a thread', options: [...BODY, ...KEY] },
    {
      name: 'suggest', usage: 'suggest <file>', description: 'suggest a change (quote → replacement, or a whole block)',
      options: [
        ['--quote <text>', 'exact source text to replace'], ['--replace <text>', 'replacement (- reads stdin)'], ['--replace-file <file>', 'replacement from a file'],
        ['--reason <text>', 'why (shown on the card)'], ['--thread <id>', 'attach to an existing thread'],
        ['--occurrence <n>', '1-based occurrence of the quote'], ['--near <ref>', 'disambiguate by block bN (needs --base-rev)'],
        ['--block <ref>', 'suggest a rewrite of block bN (needs --base-rev and --md)'], ['--base-rev <rev>', 'rev the refs were read at'],
        ['--md <markdown>', 'replacement block markdown (- reads stdin)'], ['--md-file <file>', 'replacement block markdown from a file'], ...KEY,
      ],
    },
    {
      name: 'edit-block', usage: 'edit-block <file>', description: 'replace, insert next to, delete, or replace a range of blocks',
      options: [
        ['--ref <ref>', 'target block bN (needs --base-rev)'], ['--line <line>', 'target the block holding this line (needs --base-rev)'],
        ['--quote <text>', 'target the block holding this source text'], ['--occurrence <n>', '1-based occurrence of the quote'],
        ['--base-rev <rev>', 'rev the refs were read at'], ['--md <markdown>', 'new markdown (- reads stdin)'], ['--md-file <file>', 'new markdown from a file'],
        ['--insert-after', 'insert after the target'], ['--insert-before', 'insert before the target'], ['--delete', 'delete the target'],
        ['--from <sel>', 'range start: bN, line:N or quote:TEXT'], ['--to <sel>', 'range end: bN, line:N or quote:TEXT'], ...KEY,
      ],
    },
    {
      name: 'write', usage: 'write <file>', description: 'whole-doc replace (only changed blocks are written)',
      options: [['--base-rev <rev>', 'rev the doc was read at'], ['--md <markdown>', 'the new doc (- reads stdin)'], ['--md-file <file>', 'the new doc from a file'], ...KEY],
    },
    { name: 'resolve', usage: 'resolve <file> <thread>', description: 'resolve a thread (optionally with a closing message)', options: [...BODY, ...KEY] },
    { name: 'reopen', usage: 'reopen <file> <thread>', description: 'reopen a thread', options: [...KEY] },
    { name: 'decide', usage: 'decide <file> <suggestion> <decision>', description: `accept or reject one of ${who}'s suggestions`, options: [...KEY] },
    { name: 'withdraw', usage: 'withdraw <file> <suggestion>', description: 'withdraw your own suggestion', options: [...KEY] },
    { name: 'edit-comment', usage: 'edit-comment <file> <comment>', description: 'edit your own message', options: [...BODY, ...KEY] },
    { name: 'delete-comment', usage: 'delete-comment <file> <comment>', description: 'delete your own message', options: [...KEY] },
    {
      name: 'ack', usage: 'ack <file>', description: 'ack pending up to a cursor (compare-and-swap with --since)',
      options: [['--cursor <n>', 'pending.cursor'], ['--since <s>', 'pending.since']],
    },
    {
      name: 'batch', usage: 'batch <file>', description: 'one BatchRequest (stdin, or --ops-file): all-or-nothing',
      options: [['--dry-run', 'validate and report without writing'], ['--ops-file <file>', 'read the BatchRequest from a file']],
    },
    {
      name: 'wait', usage: 'wait <file>', description: `block until ${who} sends the doc back (run only inside the generated waiter loop)`,
      options: [
        ['--timeout <sec>', 'give up after this many seconds (default 3300)'], ['--forever', 'never time out'],
        ['--waiter <id>', 'waiter id (w_ + 16 hex)'], ['--waiter-seed <s>', 'seed for a derived waiter id'], ['--waiter-gen <n>', 'connection generation'],
      ],
    },
    { name: 'disarm', usage: 'disarm <file>', description: 'end of review: stop the live waiter', options: [] },
    {
      name: 'history', usage: 'history <file>', description: 'versions (read-only)',
      options: [['--limit <n>', 'how many versions'], ['--show <v>', 'one version\'s markdown'], ['--diff <range>', 'diff a..b (vN, rev:N or current)']],
    },
    {
      name: 'doctor', usage: 'doctor <file>', description: 'sidecar and history health',
      options: [['--repair', 'quarantine corrupt lines'], ['--compact', 'drop superseded lines'], ['--gc', 'run object and history retention']],
    },
    {
      name: 'config', usage: 'config <action> [key] [value]', description: 'get, set or unset your mdr settings (name, protected, tour)',
      options: [],
    },
    {
      name: 'import-gdoc', usage: 'import-gdoc <file>', description: 'a saved Google Docs read_doc result → a new .md with every comment, reply and suggestion',
      options: [['--gdoc-json <file>', 'the saved read_doc result (commentsIncluded: true)'], ['--include-resolved', 'also import resolved Google threads (posted, then resolved)']],
    },
    {
      name: 'export-gdoc', usage: 'export-gdoc <file>', description: 'Google Docs export, in steps: the upload copy, then insertComment requests, then reply requests',
      options: [['--gdoc-json <file>', 'the saved read_doc result of the NEW Google Doc'], ['--comment-ids <ids>', 'comma list of commentIds from the insertComment reply, in order']],
    },
    {
      name: 'export-docx', usage: 'export-docx <file>', description: 'a Word file with every open thread as an anchored comment',
      options: [['--out <file>', 'where to write the .docx (default: beside the .md)'], ['--overwrite', 'replace an existing .docx']],
    },
    {
      name: 'tour', usage: 'tour', description: 'the 2-minute tour: copy the practice doc into ~/Documents/doc-review tutorial, post its cards, open it',
      options: [['--dir <folder>', 'where to put the practice doc (default: Documents/doc-review tutorial in the home folder)'], ['--launch', 'open the system browser when no tab is connected (no Browser pane)']],
    },
  ]
}

let whoMemo: string | undefined
/** The human's name in the help text: resolved once per process, on the first parse. */
const who = (): string => (whoMemo ??= nameForAgent())

const isCommand = (s: string): s is CommandName => (COMMANDS as readonly string[]).includes(s)

function buildProgram(capture: (p: ParsedCommand) => void): Command {
  const program = new Command()
  program
    .name('mdr')
    .description(`doc-review v2: local markdown review for ${who()} and Claude`)
    .exitOverride()
    .configureOutput({ writeOut: () => {}, writeErr: () => {}, outputError: () => {} })
    .allowExcessArguments(false)
  for (const def of defs(who())) {
    const cmd = program.command(def.usage).description(def.description).exitOverride().allowExcessArguments(false)
    cmd.configureOutput({ writeOut: () => {}, writeErr: () => {}, outputError: () => {} })
    cmd.addOption(new Option('--root <dir>', 'served root'))
    cmd.addOption(new Option('--pretty', 'indent the JSON output'))
    cmd.addOption(new Option('--verbose', 'progress on stderr'))
    for (const [flags, desc] of def.options) cmd.option(flags, desc)
    cmd.action((...a: unknown[]) => {
      const c = a[a.length - 1] as Command
      const positional = a.slice(0, -2).filter((x): x is string => typeof x === 'string')
      capture({ name: def.name, args: positional, opts: c.opts() })
    })
  }
  return program
}

/** argv WITHOUT node and the script. Throws CliExit (USAGE, exit 3) on any parse error. */
export function parseCommand(argv: readonly string[]): ParsedCommand {
  const first = argv.find((a) => !a.startsWith('-'))
  if (first === undefined) throw cliErr('USAGE', 'no command given', { hint: `commands: ${COMMANDS.join(', ')}` })
  if (!isCommand(first)) throw cliErr('USAGE', `unknown command ${JSON.stringify(first)}`, { hint: `commands: ${COMMANDS.join(', ')}` })
  let parsed: ParsedCommand | null = null
  try {
    buildProgram((p) => {
      parsed = p
    }).parse([...argv], { from: 'user' })
  } catch (e) {
    if (e instanceof CliExit) throw e
    if (e instanceof CommanderError) {
      if (e.code === 'commander.helpDisplayed' || e.code === 'commander.help') throw cliErr('USAGE', `mdr ${first}: see references/cli.md for usage`)
      throw cliErr('USAGE', `mdr ${first}: ${e.message.replace(/^error: /, '')}`)
    }
    throw e
  }
  if (!parsed) throw cliErr('USAGE', `mdr ${first}: could not parse the arguments`)
  return parsed
}

/** Shell-style split of one example line ("mdr comment \"a b\" --body x") for tests; handles '…' and "…" quoting. */
export function splitArgs(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let quote: '"' | "'" | null = null
  let has = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!
    if (quote) {
      if (ch === quote) quote = null
      else if (ch === '\\' && quote === '"' && i + 1 < line.length && '"\\$`'.includes(line[i + 1]!)) cur += line[++i]
      else cur += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      has = true
    } else if (/\s/.test(ch)) {
      if (has || cur) out.push(cur)
      cur = ''
      has = false
    } else {
      cur += ch
      has = true
    }
  }
  if (has || cur) out.push(cur)
  return out
}
