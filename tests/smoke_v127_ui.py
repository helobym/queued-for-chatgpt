"""v1.2.7 integration: workflow view, native command, disclosure and idle observer."""
import json
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
MANIFEST = json.loads((ROOT / 'manifest.json').read_text(encoding='utf-8'))
assert MANIFEST['version'] == '1.2.7'
assert MANIFEST['commands']['toggle-queue-panel']['suggested_key']['default'] == 'Alt+Shift+Q'

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(
        executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox'])
    page = browser.new_page(viewport={'width': 1150, 'height': 800})
    page.set_content((ROOT / 'tests/mock_chat.html').read_text(encoding='utf-8'))
    page.add_style_tag(path=str(ROOT / 'content.css'))
    page.add_script_tag(path=str(ROOT / 'core.js'))
    page.add_script_tag(path=str(ROOT / 'coordinator.js'))
    page.evaluate("""() => {
      QFC.conversationId = () => 'chat:v127';
      window.importScripts = () => {};
      const listeners = [];
      chrome.runtime = {
        id: 'mock-qfc-extension',
        onMessage: { addListener(fn) { listeners.push(fn); } },
        sendMessage(message) {
          return new Promise(resolve => {
            for (const fn of listeners) fn(message,
              {id:'mock-qfc-extension',frameId:0,url:'https://chatgpt.com/c/v127'},resolve);
          });
        }
      };
      chrome.commands = {onCommand:{addListener(fn){window.__qfcCommand=fn;}}};
      chrome.tabs = {
        async query() { return [{id:17}]; },
        async sendMessage(id,message) {
          window.__lastCommandTab = id;
          for (const fn of listeners) fn(message,{id:'mock-qfc-extension'},()=>{});
        }
      };
      Object.defineProperty(navigator,'locks',{configurable:true,value:{
        request: async (_name,_options,callback) => callback({})
      }});
    }""")
    page.add_script_tag(path=str(ROOT / 'background.js'))
    page.add_script_tag(path=str(ROOT / 'content.js'))
    page.locator('.qfc-dock').click()
    page.locator('[data-action="tab-workflows"]').click()

    # An expanded saved workflow stays expanded and stays on Workflows after Load.
    page.locator('[data-action="new-workflow"]').click()
    page.locator('#qfc-edit-workflow-name').fill('Keep my view')
    page.locator('#qfc-step-0').fill('Workflow first step')
    page.locator('[data-action="add-workflow-step"]').click()
    page.locator('#qfc-step-1').fill('Workflow second step')
    page.locator('[data-action="save-workflow-edit"]').click()
    page.locator('[data-action="toggle-workflow"]').click()
    assert page.locator('[data-action="toggle-workflow"]').get_attribute('aria-expanded') == 'true'
    page.locator('[data-action="load-workflow"]').click()
    page.wait_for_function("document.querySelector('#qfc-count').textContent === '2'")
    assert page.locator('#qfc-workflows-view').is_visible()
    assert page.locator('[data-action="toggle-workflow"]').get_attribute('aria-expanded') == 'true'

    # The native command targets one active tab, never sends prompts or changes view.
    page.evaluate("window.__qfcCommand('toggle-queue-panel', {id:17})")
    page.wait_for_function("document.querySelector('#qfc-panel').hidden")
    assert page.evaluate('window.__lastCommandTab') == 17
    assert page.locator('#qfc-count').inner_text() == '2'
    page.evaluate("window.__qfcCommand('toggle-queue-panel')")
    page.wait_for_function("!document.querySelector('#qfc-panel').hidden")
    assert page.locator('#qfc-workflows-view').is_visible()
    assert page.locator('[data-action="toggle-workflow"]').get_attribute('aria-expanded') == 'true'

    # Deferred Queue rendering must catch up when the user explicitly opens it.
    page.locator('[data-action="tab-queue"]').click()
    assert page.locator('#qfc-queue-items').get_by_text('Workflow first step').is_visible()
    assert page.locator('#qfc-queue-items').get_by_text('Workflow second step').is_visible()
    page.once('dialog', lambda dialog: dialog.accept())
    page.locator('[data-action="clear"]').click()
    page.wait_for_function("document.querySelector('#qfc-count').textContent === '0'")
    page.locator('[data-action="tab-workflows"]').click()

    # In the idle state, unrelated text/structural mutations do not perform
    # per-node assistant selector work. Do not impose a timing benchmark.
    page.evaluate("""() => {
      window.__qfcOldClosest = Element.prototype.closest;
      window.__qfcIdleClosest = 0;
      Element.prototype.closest = function(...args) {
        window.__qfcIdleClosest++;
        return window.__qfcOldClosest.apply(this,args);
      };
      const extra = document.createElement('div');
      extra.textContent = 'Unrelated ChatGPT page change';
      document.body.append(extra);
      extra.firstChild.textContent = 'Unrelated streaming text change';
    }""")
    page.wait_for_timeout(80)
    assert page.evaluate('window.__qfcIdleClosest') == 0
    page.evaluate('() => { Element.prototype.closest = window.__qfcOldClosest; }')

    # Start Workflow must run normally, without changing the selected panel page.
    page.locator('[data-action="start-workflow"]').click()
    assert page.locator('#qfc-workflows-view').is_visible()
    page.wait_for_function(
        "document.querySelector('#qfc-status').textContent.includes('Queue complete')",
        timeout=45000)
    assert page.locator('#qfc-count').inner_text() == '0'
    assert page.locator('[data-action="toggle-workflow"]').get_attribute('aria-expanded') == 'true'
    sent = page.locator('[data-message-author-role="user"] .whitespace-pre-wrap').all_inner_texts()
    assert sent[-2:] == ['Workflow first step','Workflow second step'], sent

    # Activity is compact by default, then shows the latest completed step.
    assert page.locator('#qfc-activity').is_visible()
    assert page.locator('#qfc-activity-details').is_hidden()
    activity_button = page.locator('[data-action="toggle-activity"]')
    assert activity_button.get_attribute('aria-expanded') == 'false'
    activity_button.click()
    assert activity_button.get_attribute('aria-expanded') == 'true'
    previous = page.locator('#qfc-activity-previous').inner_text()
    assert 'Workflow second step' in previous and 'Step 2/2' in previous, previous
    page.locator('[data-action="tab-queue"]').click()
    page.locator('[data-action="tab-workflows"]').click()
    assert page.locator('#qfc-activity-details').is_visible()
    activity_button.click()
    assert page.locator('#qfc-activity-details').is_hidden()
    print('PASS: v1.2.7 view retention, native shortcut, activity and idle observer')
    browser.close()
