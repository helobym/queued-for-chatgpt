"""Receipt safety regressions for existing-chat sequential sends (simulated ChatGPT)."""
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
MOCK = (ROOT / 'tests/mock_app_shell.html').read_text(encoding='utf-8')


def open_queue(browser):
    page = browser.new_page(viewport={'width': 1200, 'height': 900})
    page.set_content(MOCK)
    page.add_script_tag(path=str(ROOT / 'core.js'))
    page.add_script_tag(path=str(ROOT / 'coordinator.js'))
    page.evaluate("""() => {
      QFC.conversationId = () => 'chat:receipt-test';
      window.importScripts = () => {};
      let listener;
      chrome.runtime = {
        id: 'mock-qfc-extension',
        onMessage: { addListener(fn){if(!listener) listener=fn; else window.__qfcUiListener=fn;} },
        sendMessage(msg) { return new Promise(resolve =>
          listener(msg, {id: 'mock-qfc-extension', frameId: 0,
            url: 'https://chatgpt.com/c/receipt-test'}, resolve)); }
      };
      Object.defineProperty(navigator, 'locks', {
        value: {request: async (_name, _options, callback) => callback({})}
      });
    }""")
    page.evaluate("""() => {
      chrome.commands = {onCommand:{addListener(fn){window.__qfcCommandListener=fn;}}};
      chrome.tabs = {query:async()=>[],sendMessage:async()=>{}};
    }""")
    page.add_script_tag(path=str(ROOT / 'background.js'))
    # Shorten only the simulated receipt deadline.
    source = (ROOT / 'content.js').read_text(encoding='utf-8')
    source = source.replace('const deadline = Date.now() + 15000;',
                            'const deadline = Date.now() + 1800;', 1)
    page.add_script_tag(content=source)
    page.locator('.qfc-dock').click()
    return page


def add_duplicate_prompts(page):
    for count in (1, 2):
        page.locator('#qfc-compose').fill('Repeat exactly this prompt')
        page.locator('#qfc-add').click()
        page.wait_for_function(
            "(expected) => document.querySelector('#qfc-count').textContent === String(expected)",
            arg=count)


with sync_playwright() as p:
    browser = p.chromium.launch(
        executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox'])

    # Legitimately repeated prompts must be sent twice as distinct user turns.
    page = open_queue(browser)
    add_duplicate_prompts(page)
    page.locator('#qfc-start').click()
    page.wait_for_function(
        "document.querySelector('#qfc-status').textContent.includes('Queue complete')",
        timeout=35000)
    assert page.evaluate('window.__sentCount') == 2
    assert page.locator('#qfc-count').inner_text() == '0'
    page.close()

    # ChatGPT ignores the second click and re-renders the first user message.
    # Old code wrongly treated the replaced DOM node as a new send receipt.
    page = open_queue(browser)
    page.evaluate("""() => {
      window.__ignoredClicks = 0;
      document.querySelector('[data-testid="send-button"]')
        .addEventListener('click', event => {
          if (window.__sentCount !== 1) return;
          event.stopImmediatePropagation();
          window.__ignoredClicks++;
          const unit = document.querySelector(
            '[data-chatgpt-search-unit-key$=":user"]');
          unit.replaceWith(unit.cloneNode(true));
        }, true);
    }""")
    add_duplicate_prompts(page)
    page.locator('#qfc-start').click()
    page.wait_for_function(
        "document.querySelector('#qfc-status').textContent.includes('Could not confirm sent message')",
        timeout=20000)
    assert page.evaluate('window.__sentCount') == 1
    assert page.evaluate('window.__ignoredClicks') == 1
    assert page.locator('#qfc-count').inner_text() == '1'
    assert 'Sending' in page.locator('#qfc-queue-items').inner_text()
    assert 'Awaiting response' not in page.locator('#qfc-queue-items').inner_text()
    assert page.locator('#prompt-textarea').inner_text().strip() == 'Repeat exactly this prompt'
    page.close()

    # An unrelated textbox precedes the actual composer. Transient restored
    # content after the first receipt must clear before the next send.
    page = open_queue(browser)
    page.evaluate("""() => {
      const unrelated = document.createElement('div');
      unrelated.contentEditable = 'true'; unrelated.setAttribute('role', 'textbox');
      unrelated.textContent = 'Unrelated editable content';
      unrelated.id = 'unrelated-editor'; document.body.prepend(unrelated);
      const button = document.querySelector('[data-testid="send-button"]');
      button.addEventListener('click', () => {
        if (window.__sentCount !== 1) return;
        setTimeout(() => {
          const editor = document.querySelector('#prompt-textarea');
          editor.textContent = 'Temporarily restored composer text';
          setTimeout(() => { editor.textContent = ''; }, 3200);
        }, 100);
      });
    }""")
    add_duplicate_prompts(page)
    page.locator('#qfc-start').click()
    page.wait_for_function("document.querySelector('#qfc-status').textContent.includes('Waiting for ChatGPT composer to clear')", timeout=15000)
    assert page.evaluate('window.__sentCount') == 1
    page.wait_for_function("document.querySelector('#qfc-status').textContent.includes('Queue complete')", timeout=35000)
    assert page.evaluate('window.__sentCount') == 2
    assert page.locator('#unrelated-editor').inner_text() == 'Unrelated editable content'
    page.close()

    # A persistent actual draft is never erased or sent; clear it and restart.
    page = open_queue(browser)
    add_duplicate_prompts(page)
    page.locator('#prompt-textarea').fill('My unsent draft')
    page.locator('#qfc-start').click()
    page.wait_for_function("document.querySelector('#qfc-status').textContent.includes('unsent draft')", timeout=12000)
    assert page.locator('#prompt-textarea').inner_text() == 'My unsent draft'
    assert page.evaluate('window.__sentCount') == 0
    assert 'Sending' not in page.locator('#qfc-queue-items').inner_text()
    page.locator('#prompt-textarea').fill('')
    page.locator('#qfc-start').click()
    page.wait_for_function("document.querySelector('#qfc-status').textContent.includes('Queue complete')", timeout=35000)
    assert page.evaluate('window.__sentCount') == 2
    page.close()

    # A draft appearing during storage reservation must not leave a false
    # uncertain item: the runner has not yet attempted insertion.
    page = open_queue(browser)
    add_duplicate_prompts(page)
    page.evaluate("""() => {
      const original = chrome.runtime.sendMessage.bind(chrome.runtime);
      let injected = false;
      chrome.runtime.sendMessage = async msg => {
        const result = await original(msg);
        if (!injected && msg.command === 'queue' && msg.mutation.type === 'sending') {
          injected = true;
          document.querySelector('#prompt-textarea').textContent = 'Draft during reservation';
        }
        return result;
      };
    }""")
    page.locator('#qfc-start').click()
    page.wait_for_function("document.querySelector('#qfc-status').textContent.includes('unsent draft')", timeout=12000)
    assert page.evaluate('window.__sentCount') == 0
    assert page.locator('#prompt-textarea').inner_text() == 'Draft during reservation'
    assert 'Sending' not in page.locator('#qfc-queue-items').inner_text()
    page.locator('#prompt-textarea').fill('')
    page.locator('#qfc-start').click()
    page.wait_for_function("document.querySelector('#qfc-status').textContent.includes('Queue complete')", timeout=35000)
    assert page.evaluate('window.__sentCount') == 2
    page.close()

    print('PASS: repeated sends, ignored clicks, transient composer drafts, persistent drafts and reservation rollback')
    browser.close()
