"""Simulated browser checks for v1.2.2 Start Workflow safeguards."""
from pathlib import Path
from playwright.sync_api import sync_playwright

P = Path(__file__).resolve().parent.parent


def attach(page):
    page.set_content((P / 'tests/mock_chat.html').read_text(encoding='utf-8'))
    page.add_style_tag(path=str(P / 'content.css'))
    page.add_script_tag(path=str(P / 'core.js'))
    page.add_script_tag(path=str(P / 'coordinator.js'))
    page.evaluate('''() => {
      QFC.conversationId = () => 'chat:test';
      window.importScripts = () => {};
      let listener;
      chrome.runtime = {id:'mock-qfc-extension',onMessage:{addListener(fn){listener=fn;}},
        sendMessage(msg){return new Promise(resolve=>listener(msg,
          {id:'mock-qfc-extension',frameId:0,url:'https://chatgpt.com/c/test'}, resolve));}};
      window.__allowLock = true;
      Object.defineProperty(navigator,'locks',{configurable:true,value:{
        request:async (_name,_opts,cb)=>cb(window.__allowLock ? {} : null)
      }});
    }''')
    page.add_script_tag(path=str(P / 'background.js'))
    page.add_script_tag(path=str(P / 'content.js'))
    page.locator('.qfc-dock').click()


def workflow(page):
    page.locator('[data-action="tab-workflows"]').click()
    page.locator('[data-action="new-workflow"]').click()
    page.locator('#qfc-edit-workflow-name').fill('Save steps')
    page.locator('#qfc-step-0').fill('Workflow step 1')
    page.locator('[data-action="add-workflow-step"]').click()
    page.locator('#qfc-step-1').fill('Workflow step 2')
    page.locator('[data-action="save-workflow-edit"]').click()
    page.locator('#qfc-workflow-items').get_by_text('Save steps').wait_for()
    assert page.locator('[data-action="load-workflow"]').count() == 1
    assert page.locator('[data-action="start-workflow"]').count() == 1


def queued(page, text):
    page.locator('[data-action="tab-queue"]').click()
    page.locator('#qfc-compose').fill(text)
    page.locator('#qfc-add').click()
    page.locator('#qfc-queue-items').get_by_text(text).wait_for()
    page.locator('[data-action="tab-workflows"]').click()


with sync_playwright() as p:
    browser = p.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox'])
    page = browser.new_page(viewport={'width': 1200, 'height': 900})
    attach(page)
    workflow(page)
    queued(page, 'Existing pending prompt')
    # Declining the confirmation must have no storage or send effects.
    page.once('dialog', lambda dialog: dialog.dismiss())
    page.locator('[data-action="start-workflow"]').click()
    assert page.locator('#qfc-count').inner_text() == '1'
    assert page.locator('[data-message-author-role="user"]').count() == 1
    # Accepting explicitly sends the existing prompt FIRST, then workflow steps.
    page.once('dialog', lambda dialog: dialog.accept())
    page.locator('[data-action="start-workflow"]').click()
    page.wait_for_function("document.querySelector('#qfc-status').textContent.includes('Queue complete')", timeout=55000)
    sent = page.locator('[data-message-author-role="user"] .whitespace-pre-wrap').all_inner_texts()
    assert sent[-3:] == ['Existing pending prompt', 'Workflow step 1', 'Workflow step 2'], sent
    assert page.locator('#qfc-count').inner_text() == '0'
    print('PASS: existing queued prompts require approval and send before workflow; dismiss has no effects')
    page.close()

    page = browser.new_page(viewport={'width': 1200, 'height': 900})
    attach(page)
    workflow(page)
    page.evaluate('window.__allowLock = false')
    page.locator('[data-action="start-workflow"]').click()
    page.wait_for_function("document.querySelector('#qfc-status').textContent.includes('Another tab is controlling')")
    assert page.locator('#qfc-count').inner_text() == '0'
    assert page.locator('[data-message-author-role="user"]').count() == 1
    print('PASS: unavailable sender lock does not append workflow or send prompts')
    page.close()

    page = browser.new_page(viewport={'width': 1200, 'height': 900})
    attach(page)
    workflow(page)
    queued(page, 'Uncertain prompt')
    page.evaluate('''async () => {
      const route='chat:test';
      const record = await chrome.runtime.sendMessage({app:'qfc-v1.1',command:'getQueue',route});
      const id = record.data.items[0].id;
      return chrome.runtime.sendMessage({app:'qfc-v1.1',command:'queue',route,
        operationId:'manual-set-sending-test',mutation:{type:'sending',id}});
    }''')
    page.wait_for_function("document.querySelector('#qfc-queue-items').textContent.includes('Sending')")
    page.locator('[data-action="start-workflow"]').click()
    page.wait_for_function("document.querySelector('#qfc-status').textContent.includes('Review uncertain queued prompts')")
    assert page.locator('#qfc-count').inner_text() == '1'
    assert page.locator('[data-message-author-role="user"]').count() == 1
    print('PASS: uncertain in-flight prompt prevents workflow append and auto-send')
    browser.close()
