"""Queue Copy works in every prompt status without mutating storage or execution."""
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(
        executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox'])
    page = browser.new_page(viewport={'width': 1200, 'height': 900})
    page.route('https://chatgpt.com/**', lambda route: route.fulfill(
        status=200, content_type='text/html',
        body=(ROOT / 'tests/mock_chat.html').read_text(encoding='utf-8')))
    page.goto('https://chatgpt.com/c/copy-test')
    page.add_style_tag(path=str(ROOT / 'content.css'))
    page.add_script_tag(path=str(ROOT / 'core.js'))
    page.add_script_tag(path=str(ROOT / 'coordinator.js'))
    page.evaluate("""() => {
      window.importScripts = () => {};
      let listener;
      chrome.runtime = {
        id: 'mock-qfc-extension',
        onMessage: {addListener(fn) {listener = fn;}},
        sendMessage(msg) {return new Promise(resolve => listener(msg,
          {id:'mock-qfc-extension',frameId:0,url:location.href}, resolve));}
      };
      Object.defineProperty(navigator, 'locks', {configurable:true, value: {
        request: async (_name, _options, callback) => callback({})
      }});
      window.copied = [];
      Object.defineProperty(navigator, 'clipboard', {configurable:true,
        value:{writeText: async text => {window.copied.push(text);}}});
    }""")
    page.add_script_tag(path=str(ROOT / 'background.js'))
    page.add_script_tag(path=str(ROOT / 'content.js'))
    page.locator('.qfc-dock').click()

    prompt = 'Line one\n\nLine two ' + 'X' * 500
    page.locator('#qfc-compose').fill(prompt)
    page.locator('#qfc-add').click()
    page.wait_for_function("document.querySelector('#qfc-count').textContent === '1'")

    def snapshot():
        return page.evaluate("""async () => (await chrome.runtime.sendMessage({
          app:'qfc-v1.1',command:'getQueue',route:'chat:copy-test'
        })).data""")

    baseline = snapshot()
    item_id = baseline['items'][0]['id']
    user_count = page.locator('[data-message-author-role="user"]').count()
    for status in ['pending', 'sending', 'awaiting']:
        if status != 'pending':
            page.evaluate("""async ({id, type}) => {
              await chrome.runtime.sendMessage({app:'qfc-v1.1',command:'queue',
                route:'chat:copy-test',operationId:'copy-test-'+type,
                mutation:{type,id}});
            }""", {'id': item_id, 'type': status})
            page.wait_for_function(
                "(label) => document.querySelector('#qfc-queue-items').textContent.includes(label)",
                arg='Sending' if status == 'sending' else 'Awaiting')
        before = snapshot()
        page.locator('[data-action="copy"]').click()
        page.wait_for_function(
            "document.querySelector('[data-action=copy]').textContent.includes('Copied')")
        assert page.evaluate('window.copied.at(-1)') == prompt
        assert snapshot() == before
        assert page.locator('[data-message-author-role="user"]').count() == user_count

    # Clipboard rejection is an isolated UI error; no state or status mutation.
    page.evaluate("""() => {
      navigator.clipboard.writeText = async () => {throw new Error('NotAllowedError');};
    }""")
    before = snapshot()
    page.locator('[data-action="copy"]').click()
    page.wait_for_function(
        "document.querySelector('[data-action=copy]').textContent.includes('failed')")
    assert snapshot() == before
    assert page.locator('#qfc-status').inner_text() == 'Paused'

    # Missing clipboard access must fail gracefully as well.
    page.evaluate("""() => {
      Object.defineProperty(navigator, 'clipboard', {configurable:true,value:undefined});
    }""")
    page.locator('[data-action="copy"]').click()
    page.wait_for_function(
        "document.querySelector('[data-action=copy]').textContent.includes('failed')")
    assert snapshot() == before
    print('PASS: full prompt Copy for all queue states and graceful clipboard errors')
    browser.close()
