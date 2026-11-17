// node/tour.ts (onboarding, 2026-11-16). The 2-minute tour: a practice document and the cards Claude leaves on it,
// one card per thing a reviewer does (accept, reject, reply, edit, comment, send). `mdr tour` copies the document into
// a folder of the user's own (never the home folder itself: it can't be served), posts the cards as Claude, and opens
// it like `mdr open`. Plain, friendly, short, nothing company-specific: anyone can be handed this file.
//
// Every quote below appears exactly once in TOUR_MD (tests/unit/node/tour.test.ts checks), so the cards anchor
// without --occurrence.
import type { AgentOp } from '../shared/types'

export const TOUR_FOLDER = 'doc-review tutorial'
export const TOUR_FILE = 'Welcome to doc-review.md'

export const TOUR_MD = `# Welcome to doc-review

This is a practice page, so nothing here matters. Click anything. It takes about two minutes.

Claude left six cards in the margin on the right. Each one asks you to try one thing. Go from top to bottom.

## 1. Accept a suggestion

Our team meets every Tuesday mornng for coffee.

## 2. Reject a suggestion

The plant by the window is called Gerald.

## 3. Reply to a comment

Coffee or tea for the Friday get-together?

## 4. Fix a typo yourself

You start in Suggesting mode, so anything you type shows up as a suggestion that someone else accepts or rejects. When it's your own document and you just want to fix something, switch to Editing.

Teh quick brown fox jumps over the lazy dog.

## 5. Leave your own comment

Pick any sentence in this paragraph and select it with your mouse. Then click Comment and type whatever you like. Short is fine, and Claude will answer you.

## 6. Send it to Claude

When you're done, click Send to Claude at the top right. Claude reads everything you did and answers in the margin.

---

This file lives in your Documents folder, in a folder called "${TOUR_FOLDER}". The strip at the top of the page shows exactly where. Delete it whenever you like.
`

/** The cards, in document order. Claude posts them in one batch. */
export const TOUR_OPS: AgentOp[] = [
  {
    op: 'suggest',
    quote: 'mornng',
    replace: 'morning',
    reason: 'A typo. Click Accept on this card to take the fix.',
  },
  {
    op: 'suggest',
    quote: 'Gerald',
    replace: 'Plant Number 47',
    reason: 'This one is a bad idea. Click Reject to say no.',
  },
  {
    op: 'comment',
    quote: 'Coffee or tea for the Friday get-together?',
    body: 'Which one do you pick? Type your answer in the reply box on this card, then press Reply.',
  },
  {
    op: 'comment',
    quote: 'Teh quick brown fox',
    body: 'Click the Suggesting pill at the top left so it says Editing. Then fix "Teh" to "The" right in the text.',
  },
  {
    op: 'comment',
    quote: 'Pick any sentence in this paragraph and select it with your mouse.',
    body: 'Your turn: select a sentence anywhere in this paragraph, click Comment, and say anything.',
  },
  {
    op: 'comment',
    quote: 'click Send to Claude at the top right',
    body: 'Last step: click Send to Claude (top right). I only reply where there is something to say, the way I will on your real documents.',
  },
]
