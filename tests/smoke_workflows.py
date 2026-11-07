"""End-to-end simulated ChatGPT page for Saved Queue Workflows, no real account."""
from pathlib import Path
from playwright.sync_api import sync_playwright
P = Path(__file__).resolve().parent.parent
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox'])
    page = browser.new_page(viewport={'width':1200,'height':900})
    page.set_content((P/'tests/mock_chat.html').read_text(encoding='utf-8'))
    page.add_style_tag(path=str(P/'content.css'))
    page.add_script_tag(path=str(P/'core.js'))
    page.add_script_tag(path=str(P/'coordinator.js'))
    page.evaluate('''() => {
      window.importScripts = () => {};
      let workerListener;
      window.chrome.runtime = {
        id: 'mock-qfc-extension',
        onMessage: { addListener(fn){if(!workerListener) workerListener=fn; else window.__qfcUiListener=fn;} },
        sendMessage(message) { return new Promise(resolve => workerListener(message,
          { id: 'mock-qfc-extension', frameId: 0, url: 'https://chatgpt.com/c/test-chat' }, resolve)); }
      };
    }''')
    page.evaluate("""() => {
      chrome.commands = {onCommand:{addListener(fn){window.__qfcCommandListener=fn;}}};
      chrome.tabs = {query:async()=>[],sendMessage:async()=>{}};
    }""")
    page.add_script_tag(path=str(P/'background.js'))
    page.evaluate("QFC.conversationId = () => 'chat:test-chat'; Object.defineProperty(navigator, 'locks', { value: { request: async (_name, _opts, callback) => callback({}) } });")
    page.add_script_tag(path=str(P/'content.js'))
    page.locator('.qfc-dock').click()
    assert page.locator('[data-action="tab-favorites"]').count() == 0
    assert page.locator('.qfc-message-star').count() == 0
    for msg in ['Research this subject', 'Give three conclusions']:
        page.locator('#qfc-compose').fill(msg)
        page.locator('#qfc-add').click()
        page.locator('#qfc-queue-items').get_by_text(msg).wait_for()
    page.locator('#qfc-workflow-name').fill('Research workflow')
    page.locator('[data-action="save-queue-workflow"]').click()
    page.locator('#qfc-workflow-items').get_by_text('Research workflow').wait_for()
    assert page.locator('#qfc-workflow-count').inner_text() == '1'
    assert '2 steps' in page.locator('#qfc-workflow-items').inner_text().lower()
    page.locator('[data-action="edit-workflow"]').click()
    page.locator('#qfc-edit-workflow-name').fill('Research and report')
    page.locator('#qfc-step-1').fill('Give five conclusions')
    page.locator('[data-action="save-workflow-edit"]').click()
    page.locator('#qfc-workflow-items').get_by_text('Research and report').wait_for()
    assert page.locator('.qfc-workflow-details').is_hidden()
    # The tiny disclosure must be immediately before the workflow title,
    # not part of the Start / Load / Edit / Delete actions row.
    disclosure = page.locator('[data-action="toggle-workflow"]')
    heading = page.locator('.qfc-workflow-heading')
    assert disclosure.locator('xpath=..').get_attribute('class').find('qfc-workflow-heading') >= 0
    assert heading.locator('.qfc-workflow-title').inner_text() == 'Research and report'
    assert disclosure.bounding_box()['x'] < heading.locator('.qfc-workflow-title').bounding_box()['x']
    assert disclosure.bounding_box()['width'] <= 32
    assert page.locator('.qfc-workflow-item .qfc-item-actions [data-action="toggle-workflow"]').count() == 0
    disclosure.focus()
    disclosure.press('Enter')
    page.locator('.qfc-workflow-prompt-text').get_by_text('Give five conclusions').wait_for()
    assert page.locator('[data-action="toggle-workflow"]').get_attribute('aria-expanded') == 'true'
    assert page.locator('[data-action="copy-workflow-step"]').count() == 2
    page.locator('[data-action="toggle-workflow"]').click()
    assert page.locator('.qfc-workflow-details').is_hidden()
    assert page.locator('[data-action="toggle-workflow"]').get_attribute('aria-expanded') == 'false'
    # Verify existing queued work was untouched, then load the saved workflow.
    page.locator('[data-action="tab-queue"]').click()
    assert page.locator('#qfc-count').inner_text() == '2'
    page.once('dialog', lambda dialog: dialog.accept())
    page.locator('[data-action="clear"]').click()
    page.wait_for_function("document.querySelector('#qfc-count').textContent === '0'")
    page.locator('[data-action="tab-workflows"]').click()
    page.locator('[data-action="start-workflow"]').click()
    assert page.locator('#qfc-workflows-view').is_visible()
    assert page.locator('#qfc-queue-view').is_hidden()
    page.wait_for_function("document.querySelector('#qfc-status').textContent.includes('Queue complete')", timeout=45000)
    assert page.locator('#qfc-count').inner_text() == '0'
    assert page.locator('[data-message-author-role="user"]').count() >= 3
    print('PASS: save, edit, single-click start, and sequentially send a multi-step workflow; no Favorites controls')
    browser.close()
