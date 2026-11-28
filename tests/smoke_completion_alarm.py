"""Chromium integration: actual content script, trusted manual clicks and mocked audio."""
from pathlib import Path
from playwright.sync_api import sync_playwright

PROJECT = Path(__file__).resolve().parent.parent
FIXTURE = PROJECT / 'tests' / 'mock_chat.html'

try:
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox'])
        page = browser.new_page(viewport={"width": 1200, "height": 900})
        page.set_content(FIXTURE.read_text(encoding='utf-8'))
        page.add_style_tag(path=str(PROJECT / 'content.css'))
        page.add_script_tag(path=str(PROJECT / 'core.js'))
        page.add_script_tag(path=str(PROJECT / 'coordinator.js'))
        page.evaluate('''() => {
          window.importScripts = () => {};
          let workerListener;
          window.chrome.runtime = {
            id: 'mock-qfc-extension',
            onMessage: { addListener(fn){if(!workerListener) workerListener=fn; else window.__qfcUiListener=fn;} },
            sendMessage(message) {
              return new Promise(resolve => {
                workerListener(message, { id: 'mock-qfc-extension', frameId: 0, url: 'https://chatgpt.com/c/test-chat' }, resolve);
              });
            }
          };
        }''')
        page.evaluate("""() => {
          chrome.commands = {onCommand:{addListener(fn){window.__qfcCommandListener=fn;}}};
          chrome.tabs = {query:async()=>[],sendMessage:async()=>{}};
        }""")
        page.add_script_tag(path=str(PROJECT / 'background.js'))
        page.evaluate("QFC.conversationId = () => 'chat:test-chat'; Object.defineProperty(navigator, 'locks', { value: { request: async (_name, _opts, callback) => callback({}) } });")
        page.evaluate("""() => {
          window.__qfcAudioStarts = 0; window.__qfcAudioCloses = 0;
          window.AudioContext = class {
            constructor() { this.currentTime=0; this.destination={}; }
            createOscillator() {
              return {frequency:{},connect(){},start(){window.__qfcAudioStarts++},
                stop(){setTimeout(()=>this.onended?.(),1000)}};
            }
            createGain(){return {gain:{setValueAtTime(){},exponentialRampToValueAtTime(){}},connect(){}}}
            resume(){return Promise.resolve()}
            close(){window.__qfcAudioCloses++; return Promise.resolve()}
          }
        }""")
        page.add_script_tag(path=str(PROJECT / 'content.js'))
        page.locator('.qfc-dock').click()
        page.locator('[data-action="open-settings"]').click()
        alarm = page.locator('#qfc-completion-alarm')
        assert not alarm.is_checked()
        editor = page.locator('#prompt-textarea')
        send = page.locator('[data-testid="send-button"]')
        editor.fill('Silent manual response')
        send.click()
        page.wait_for_timeout(2400)
        assert page.evaluate("window.__qfcAudioStarts") == 0
        alarm.check()
        page.wait_for_function("""async()=> (await chrome.storage.local.get('qfc_v1_completion_alarm')).qfc_v1_completion_alarm === true""")
        page.locator('[data-action="settings-back"]').click()
        editor.fill('Audible manual response')
        send.click()
        page.wait_for_function("window.__qfcAudioStarts === 1", timeout=12000)
        page.wait_for_function("window.__qfcAudioCloses === 1", timeout=5000)
        editor.fill('Manually stopped response')
        send.click()
        page.locator('[data-testid="stop-button"]').click(timeout=2000)
        page.wait_for_timeout(2500)
        assert page.evaluate("window.__qfcAudioStarts") == 1
        page.locator('#qfc-compose').fill('Queued alarm response')
        page.locator('#qfc-add').click()
        page.locator('#qfc-start').click()
        page.wait_for_function("document.querySelector('#qfc-status').textContent.includes('Queue complete')", timeout=25000)
        assert page.evaluate("window.__qfcAudioStarts") == 2
        page.wait_for_function("window.__qfcAudioCloses === 2", timeout=5000)
        print('PASS: disabled, manual, cancellation, queued alarm and audio cleanup')
        browser.close()
finally:
    pass
