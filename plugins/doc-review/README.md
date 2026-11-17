# doc-review

**What it is.** A way to mark up a document with Claude the way you would in Google Docs. Claude opens a Markdown
(`.md`) file as a page beside the chat. You highlight text and leave comments in the margin, and anything you type is
a tracked change (pages open in **Suggesting** mode; switch to **Editing** to change your own doc directly). Claude answers in the margin and proposes changes you accept or reject one
by one. Works both ways: a draft Claude wrote for you to react to, or someone else's document (an agency, a vendor, a
colleague) you want Claude's notes on. For someone else's document Claude only comments and suggests; it never rewrites
it behind your back.

**Where it works.** The **Code tab** of the Claude desktop app, on a Mac (tested) or Windows (beta, untested). Not in
Cowork, not in Claude on the web, not on a phone. Only `.md` files: for Google Docs, Word or PDF, ask Claude to turn it
into Markdown first.

## Install

In a Code session in the Claude desktop app:

```
/plugin marketplace add teeejlind/doc-review
/plugin install doc-review@doc-review
```

Start a new Code session afterward so Claude sees the skill.

## How to use it

Open a Code session on the folder that holds your document and ask in your own words:

> Open `launch-plan.md` so I can comment on it.
> Let me mark up this draft.
> Review this doc. (Claude asks which file if it isn't obvious.)

You can also type `/doc-review:doc-review launch-plan.md`.

1. **The first time only** (about 10 seconds with a normal connection), Claude says it is downloading a small helper
   program (Node.js, about 55 MB on a Mac) from nodejs.org, checks it against a fingerprint built into this plugin,
   and keeps it inside the plugin's own folder. No password, no admin rights, nothing else on your computer changes.
   Claude Code asks you to approve the commands it runs; say yes. Later it opens in a second.
   On your very first review Claude also asks **"Want a 2-minute tour first?"** Say yes and it opens a practice page
   (in `Documents/doc-review tutorial/`) with six cards that each ask you to try one thing: accept a suggestion,
   reject one, reply, fix a typo in Editing mode, leave a comment, and Send to Claude. Claude answers each, and then
   you're set. It's never offered again; say "show me the tour again" any time.
2. **The page opens in the side panel** (Claude's Browser pane) at an address like
   `http://127.0.0.1:8395/?file=launch-plan.md`. If Claude asks whether it may open `127.0.0.1`, say yes: that
   address is this computer, nothing leaves it.
3. **Mark it up.** Select text and click **Comment**. Pages open in **Suggesting**: what you type is tracked for Claude,
   or you, to accept or reject. Click the pill at the top to switch to **Editing** when your changes should go straight
   in (your own draft). Reply to Claude's comments in the same cards.
4. **Click Send to Claude** (or press Cmd+Enter on a Mac, Ctrl+Enter on Windows) when you're done with a pass. Claude
   reads what you did, answers in the margin, and waits for your next pass. If the button copies a prompt instead of
   waking Claude, paste it into the chat: same result.
5. **Say "done"** when you're finished. Claude closes the review.

**Export.** The **Export** menu at the top sends Claude a request to export the review: a new private Google Doc with
the open comments anchored on the right words, or a Word file (`.docx`) with real Word comments. You can also ask in
the chat ("send this to Google Docs", "give me a Word file"), or ask Claude to pull a Google Doc's comments into a
review.

## What Send to Claude does

Nothing happens to Claude while you comment and edit; the page just saves. **Send to Claude** is the "I'm ready for
you" signal: it wakes the session, Claude reads only what changed since last time (your new comments, your edits, your
accept and reject decisions), and replies in the margin. You can send as many rounds as you like.

## Where your file lives

On your computer, exactly where it was. The strip at the top of the page shows the file name and its folder, with
**Reveal in Finder** (**Show in Explorer** on Windows) and **Copy path**. Your comments, suggestions and history are saved right beside it, in
`<name>.md.review.jsonl` and a `.review` folder. They *are* the review: keep them with the document, don't delete them
while you're still working, and send them along with the `.md` if you want someone else to see your comments. Nothing
is uploaded anywhere. The page is served from your own machine and isn't reachable from the network.

A document sitting directly in your home folder won't open (doc-review never serves a whole home folder). Put it in a
folder of its own.

## Your name on comments

Comments and suggestions carry your name. doc-review takes it from your computer's account name. To change it, tell
Claude "call me Ana Díaz on my comments" (it saves that for this computer), or in a terminal run
`mdr config set name "Ana Díaz"`; the `mdr` command lives at `~/.claude/plugins/data/doc-review-doc-review/bin/mdr`
(`mdr config unset name` goes back to the default). Setting the `MDR_USER_NAME` environment variable also works and wins.

## Good to know

- **Your text only changes where you or Claude change it.** Opening and saving a document without editing leaves the
  file byte for byte identical, and one edit touches only the paragraph it is in.
- **Version history** is in the page: every save and every change Claude makes is a version you can compare and restore.
- **It's a beta.** Plain typing and saving are exact. A few edge cases in Suggesting mode (some list edits, odd
  formatting when you accept) are known; check the result of an Accept on anything formatting-heavy.
- **It is a place to give feedback, not to sign off.** Accepting a suggestion is an edit, not an approval; any review or
  compliance sign-off a document needs still happens the normal way.

## If something goes wrong

| What you see | What to do |
|---|---|
| Claude says it only works in the Code tab | You are in Cowork or on the web. Open a **Code** session in the desktop app. |
| "Your company network blocked the download" | Your company's network or proxy refused nodejs.org. Ask IT to allow nodejs.org (the official Node.js site), then ask Claude again. |
| "Couldn't download" during setup | Check your internet connection or VPN. |
| "Doesn't match its fingerprint" | Claude threw the download away and installed nothing. A proxy that rewrites downloads can cause this. Tell IT, or open an issue on the repo. |
| The page says it can't connect | The helper stops itself after 4 idle hours or when the computer restarts. Ask Claude to open the document again. |
| **Send to Claude** copies a prompt instead of waking Claude | That is the fallback. Paste the prompt into the chat. |
| Windows blocks `node.exe` | Company security software can block a program it hasn't seen. Ask IT to allow `node.exe` under `%USERPROFILE%\.claude\plugins\data\doc-review-doc-review`. |
| Something else | Tell Claude what you see; it can run a health check and read the logs. |

## How to stop it

Say "done" and Claude ends the review. The page's helper program also stops itself after 4 idle hours, and when
you restart the computer, so there is nothing to quit. Your review notes stay beside the document either way, and ask Claude to open
the document again whenever you want to pick up where you left off.

## Removing it

`/plugin uninstall doc-review@doc-review`. The helper program (roughly 150 MB on disk) lives in the plugin's
data folder under `~/.claude/plugins/data/` and goes with it; if it is still there afterward you can delete that
folder. Review notes next to your documents are not touched.

## For the plugin owners

- `runtime/` is generated from the doc-review sources by `npm run build:plugin` (a single bundled `mdr.mjs` plus the
  page assets); `runtime/BUILD.txt` records the source commit and checksums, and `runtime/THIRD_PARTY_LICENSES.txt` the
  licenses of what is bundled. Don't edit it by hand.
- `scripts/runtime.lock` pins the Node.js version and the SHA-256 of each official download. To change Node, update the
  version, the base URL and all six hashes together from that release's `SHASUMS256.txt`, then bump the plugin version.
- `scripts/ensure-runtime.sh` (and `.ps1` for Windows) installs Node and the app under the plugin's data folder and
  prints where. It never edits `PATH` or any shell profile.
