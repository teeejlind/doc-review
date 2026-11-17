// tests/e2e/t2-cli-copy.spec.ts (fix pass T2 cli; QA_FINDINGS Pass 4 #29). The real built server and the real page, with a
// clipboard that refuses every write (the Claude desktop Browser pane): Send with nobody listening used to end in a dialog
// whose Copy button failed too. The dialog now has the message selected and says "press Cmd+C" (Ctrl+C on Windows), and
// offers no Copy button; with Claude's waiter connected Send never gets near the clipboard.
import type { ArmResult, StatusResult } from '../../shared/types'
import { badgeOf, pageWaiter, tid, toastOf } from '../helpers/int'
import { openEditor } from '../helpers/openEditor'
import { expect, test } from './fixtures'
import { clipWrites, installClipboard, setClipRefuse } from './fixtures/p3'
import { killLoops, ok, startLoop } from './fixtures/p4'

const FILE = 'badge.md'
const DOC = '# Badge\n\nThe member rate is reviewed every quarter.\n\nA second paragraph for company.\n'
const ENV = { MDR_TEST_WAIT_TIMEOUT_S: '30', MDR_TEST_HEARTBEAT_MS: '100', MDR_TEST_WATCHDOG_MS: '2000' }

test.use({ serverKind: 'real', fixtureFiles: [], docFile: FILE, serverEnv: ENV })
test.afterEach(killLoops)

test.describe('#29: the clipboard is refused (the Claude desktop Browser pane)', () => {
  test('Send with nobody listening opens the message selected with "press Cmd+C"; Cmd/Ctrl+C copies all of it; no Copy button', async ({ page, cli, server, tmpRoot, webClient }) => {
    tmpRoot.write(FILE, DOC)
    await installClipboard(page)
    await page.addInitScript(() => Object.defineProperty(navigator, 'platform', { configurable: true, get: () => 'MacIntel' }))
    await page.setViewportSize({ width: 800, height: 600 })
    await openEditor(page, { port: server.port, file: FILE })
    await expect.poll(() => pageWaiter(page)).toBe('none')
    await webClient.createThread({ kind: 'doc' }, 'A note for Claude.')
    await setClipRefuse(page, true)
    await page.locator(tid('send')).click()
    const modal = page.locator(tid('promptModal'))
    await expect(modal).toBeVisible()
    await expect(modal).toHaveAttribute('data-copy', 'manual')
    await expect(modal.locator('.mdr-modal-text')).toHaveText(
      'Claude isn’t listening, and this page can’t copy to your clipboard. The message below is selected: press Cmd+C, then paste it into your Claude conversation.',
    )
    const area = modal.locator('textarea')
    await expect(area).toBeFocused()
    await expect(area).toHaveValue(new RegExp(FILE.replace('.', '\\.')))
    await expect(modal.locator(tid('toastAction'))).toHaveCount(0)
    // the selection is the whole message, and the keyboard copy shortcut sees exactly that
    await page.evaluate(() => {
      const w = window as unknown as { __copied: string[] }
      w.__copied = []
      document.addEventListener('copy', (e) => {
        const t = e.target as HTMLTextAreaElement
        w.__copied.push(t.value.slice(t.selectionStart, t.selectionEnd))
      })
    })
    await page.keyboard.press('ControlOrMeta+C')
    const copied = await page.evaluate(() => (window as unknown as { __copied: string[] }).__copied)
    const value = await area.inputValue()
    expect(copied).toEqual([value])
    expect(value).toContain(FILE)
    // the badge, once Claude is waiting for the paste, does not offer the button that fails either
    await modal.getByRole('button', { name: 'Close' }).click()
    await expect(modal).toHaveCount(0)
    await expect(badgeOf(page)).toContainText('Waiting for you to paste it into Claude')
    const show = badgeOf(page).locator(tid('badgeAction', { 'data-action': 'show-prompt' }))
    await expect(show).toHaveText('Show message')
    expect(await clipWrites(page)).toEqual([])
    await show.click()
    await expect(modal).toHaveAttribute('data-copy', 'manual')
    await expect(area).toBeFocused()
  })

  test('Windows says Ctrl+C', async ({ page, server, tmpRoot, webClient }) => {
    tmpRoot.write(FILE, DOC)
    await installClipboard(page)
    await page.addInitScript(() => Object.defineProperty(navigator, 'platform', { configurable: true, get: () => 'Win32' }))
    await openEditor(page, { port: server.port, file: FILE })
    await expect.poll(() => pageWaiter(page)).toBe('none')
    await webClient.createThread({ kind: 'doc' }, 'A note for Claude.')
    await setClipRefuse(page, true)
    await page.locator(tid('send')).click()
    await expect(page.locator(tid('promptModal')).locator('.mdr-modal-text')).toContainText('press Ctrl+C,')
  })

  test('with Claude’s waiter connected the same refusing browser never sees a dialog: Send just sends', async ({ page, cli, server, tmpRoot, webClient }) => {
    tmpRoot.write(FILE, DOC)
    const abs = cli.abs(FILE)
    await installClipboard(page)
    const arm = ok<ArmResult>(await cli.run(['arm', abs]))
    const loop = startLoop(arm.waiter!, { home: tmpRoot.home, env: ENV })
    expect(ok<StatusResult>(await cli.run(['status', abs, '--wait-waiter', '15'])).presence.waiter).toBe('connected')
    await openEditor(page, { port: server.port, file: FILE })
    await expect.poll(() => pageWaiter(page)).toBe('connected')
    await webClient.createThread({ kind: 'doc' }, 'A note for Claude.')
    await setClipRefuse(page, true)
    await page.locator(tid('send')).click()
    await expect(toastOf(page, 'HANDOFF_SENT')).toContainText('Sent to Claude.')
    await expect(page.locator(tid('promptModal'))).toHaveCount(0)
    const out = await loop.exit(15_000)
    expect(out.code, out.stdout + out.stderr).toBe(0)
  })
})
