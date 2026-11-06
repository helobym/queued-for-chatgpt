"""Simulated ChatGPT regression: Load is passive when idle and joins an active run."""
from pathlib import Path
from playwright.sync_api import sync_playwright

P = Path(__file__).resolve().parent.parent

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox'])
    page = browser.new_page(viewport={'width': 1200, 'height': 900})
    page.set_content((P / 'tests/mock_chat.html').read_text(encoding='utf-8'))
    page.add_style_tag(path=str(P / 'content.css'))
    page.add_script_tag(path=str(P / 'core.js'))
    page.add_script_tag(path=str(P / 'coordinator.js'))
    page.evaluate("""() => {
      QFC.conversationId = () => 'chat:load-test';
      window.importScripts = () => {};
      let listener;
      chrome.runtime = {
        id: 'mock-qfc-extension',
        onMessage: {addListener(fn) {listener = fn;}},
        sendMessage(message) {return new Promise(resolve => listener(message,
          {id: 'mock-qfc-extension', frameId: 0, url: 'https://chatgpt.com/c/load-test'}, resolve));}
      };
      Object.defineProperty(navigator, 'locks', {value: {
        request: async (_name, _options, callback) => callback({})
      }});
    }""")
    page.add_script_tag(path=str(P / 'background.js'))
    page.add_script_tag(path=str(P / 'content.js'))
    page.locator('.qfc-dock').click()

    page.locator('[data-action="tab-workflows"]').click()
    page.locator('[data-action="new-workflow"]').click()
    page.locator('#qfc-edit-workflow-name').fill('Research flow')
    page.locator('#qfc-step-0').fill('Workflow first')
    page.locator('[data-action="add-workflow-step"]').click()
    page.locator('#qfc-step-1').fill('Workflow second')
    page.locator('[data-action="save-workflow-edit"]').click()
    page.locator('[data-action="load-workflow"]').wait_for()

    # Load into a paused/empty queue: do not start sending.
    page.locator('[data-action="load-workflow"]').click()
    page.locator('#qfc-queue-items').get_by_text('Workflow second').wait_for()
    assert page.locator('#qfc-count').inner_text() == '2'
    assert page.locator('#qfc-pause').is_disabled()
    assert page.locator('[data-message-author-role="user"]').count() == 1

    # Clear the idle queue, then start two manually queued prompts.
    page.once('dialog', lambda dialog: dialog.accept())
    page.locator('[data-action="clear"]').click()
    page.wait_for_function("document.querySelector('#qfc-count').textContent === '0'")
    for prompt in ['Existing first', 'Existing second']:
        page.locator('#qfc-compose').fill(prompt)
        page.locator('#qfc-add').click()
        page.locator('#qfc-queue-items').get_by_text(prompt).wait_for()
    assert page.locator('.qfc-dock').get_attribute('data-phase') == 'paused'
    assert '2 pending' in page.locator('#qfc-dock-count').inner_text()
    page.locator('#qfc-start').click()
    page.wait_for_function(
        "document.querySelectorAll('[data-message-author-role=\"user\"]').length === 2",
        timeout=15000
    )
    assert page.locator('#qfc-pause').is_enabled()
    assert page.locator('.qfc-dock').get_attribute('data-phase') == 'running'
    assert '1 left' in page.locator('#qfc-dock-count').inner_text()

    # Append during the active first response. Its runner must pick up the new tail.
    page.locator('[data-action="tab-workflows"]').click()
    page.locator('[data-action="load-workflow"]').click()
    page.locator('#qfc-queue-items').get_by_text('Workflow second').wait_for()
    assert page.locator('#qfc-pause').is_enabled()
    assert page.locator('.qfc-dock').get_attribute('data-phase') == 'running'
    assert 'left' in page.locator('#qfc-dock-count').inner_text()
    page.wait_for_function(
        "document.querySelector('#qfc-status').textContent.includes('Queue complete')",
        timeout=60000
    )
    sent = page.locator('[data-message-author-role="user"] .whitespace-pre-wrap').all_inner_texts()
    assert sent[-4:] == ['Existing first', 'Existing second', 'Workflow first', 'Workflow second'], sent
    assert page.locator('#qfc-count').inner_text() == '0'
    assert page.locator('.qfc-dock').get_attribute('data-phase') == 'idle'
    assert page.locator('#qfc-activity-current').is_hidden()
    previous = page.locator('#qfc-activity-previous').inner_text()
    assert 'Workflow second' in previous and 'Step 2/2' in previous, previous
    print('PASS: Load is passive when idle and active runner sends appended workflow in order')
    browser.close()
