# Google Docs and Word: import and export

doc-review is where the user and Claude work a draft together. Anything shared with colleagues or outside people ends
up as a Google Doc or a Word file. These are the two bridges:

- **Import** a Google Doc that already has comments (from a colleague, an agency, an exec) into a review, so the user
  and you can work through the feedback item by item.
- **Export** the reviewed document to a new Google Doc or a `.docx`, with every open thread as a real comment anchored
  on its text.

`mdr` never talks to Google. You call the Google connector tools and hand `mdr` what they return; `mdr` prints the
exact requests to send back. Load the tools with ToolSearch first: the Google Docs connector's `read_doc` and
`update_doc`, and the Google Drive connector's `create_file`. There may be several Drive connectors, one per Google
account: use the one whose results show the user's work address as `owner`.

## Import a Google Doc

Use when the user shares a Google Doc link or asks to "pull in", "work through" or "go through the comments on" one.

1. The document id is the part of the link after `/document/d/` and before the next `/`.
2. `read_doc` with `documentId` and `commentsIncluded: true`.
   - A long doc's result is saved to a file and the tool says where: use that path as is. Never read the file
     whole; you don't need to.
   - A short doc's result comes back inline. Save it, exactly as returned, to a `.json` file in your scratch folder.
3. Pick the new file: the folder the user is working in, a short kebab-case name from the doc title, ending in `.md`.
   It must not exist yet: `mdr` never overwrites a file or a review.
4. `mdr import-gdoc "<abs new.md>" --gdoc-json "<path>"` (add `--include-resolved` only if the user wants resolved
   threads too).
5. Read the result: `counts` (threads anchored on their text, threads at doc level, replies, suggestions,
   `skippedResolved`) and `notes` (what was simplified: images, extra tabs). Tell the user in one or two lines.
6. Open the new file with `mdr open` and run the normal loop.

What lands where:

- Every Google comment becomes a thread on the same words; its replies follow it. Each message is posted by you and
  starts with its original author's name ("Sam Smith: …"), because the review only knows the user and Claude.
- A comment whose text was deleted in Google, or that sits only on suggested text, becomes a doc-level comment that
  keeps the quote ("Sam Smith on “old text”: …"). `items[].why` says why.
- Each suggested edit in the Google Doc becomes a doc-review suggestion the user can accept or reject. One that adds or
  removes a paragraph break, or whose text can't be found, becomes a comment that says what it proposed.
- Formatting-only suggestions (bold, styles) are not imported.

Working the feedback: for each imported thread, suggest the change (one `suggest` per decision; the card is the
answer, no reply needed), or reply when there's a question or a judgment the user should read. These threads are
yours by authorship, so resolve one only after the user accepted the change or said to drop it. Never post anything back to the original Google Doc: comments there notify
everyone on the doc, so it is a send and needs the user's explicit OK on that doc. The way back is an export.

## Export to a new Google Doc

1. `mdr export-gdoc "<abs>"` → `fileRef`, `title`, `openThreads`.
2. Drive `create_file` with `title` (the result's title, or the user's), `contentMimeType: "text/markdown"` and
   `base64Content` set to `fileRef` exactly as printed. The app reads the file itself; never paste the document text.
   This creates a new private Google Doc owned by the user, shared with no one.
3. `read_doc` on the new doc's `id` with `commentsIncluded: true`; save the result as in import step 2.
4. `mdr export-gdoc "<abs>" --gdoc-json "<path>"` → `requests` (one `insertComment` per open thread, author name
   first) and `placed` (the quote each one lands on). Pending suggestions travel as comments that say what they would
   change; doc-level threads land on the title as "(General comment)".
5. `update_doc` on the NEW doc with `requests` as printed. Check each returned `plainTextQuote` against
   `placed[i].quote` and tell the user about any mismatch.
6. If `replies` is above 0: `mdr export-gdoc "<abs>" --comment-ids <id1>,<id2>,…` with the `commentId`s from step 5's
   reply in order (one per request), then `update_doc` with the printed `requests`.
7. Give the user the doc's link. Sharing it is theirs: never share it yourself.

Only ever comment on the doc you just created. `export-gdoc --gdoc-json` refuses a doc that already has comments. If the
user wants comments posted on an existing or shared doc, ask first, by name, every time.

## Export to Word

`mdr export-docx "<abs>"` writes `<name>.docx` next to the `.md` (or `--out F`) and prints `out`, `comments`,
`replies` and `general`. Open threads become Word comments by their real author, anchored on their text; replies
thread under them; pending suggestions appear as comments that say what they would change. The document is the
current text (accepted changes in, pending ones not applied). It refuses to overwrite an existing `.docx`: pass
`--overwrite` only when the user says to replace it. Tell the user the path.

PDF with margin comments is not built in. If they need one: open the `.docx` in Word and export to PDF with markup
shown.
