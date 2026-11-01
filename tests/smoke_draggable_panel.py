"""Browser smoke test for moving the floating Queue panel and persisting per-tab layout."""
from pathlib import Path
from playwright.sync_api import sync_playwright

PROJECT = Path(__file__).resolve().parent.parent
HTML = (PROJECT / 'tests/mock_chat.html').read_text(encoding='utf-8')


def attach(page, persisted=None):
    page.evaluate('''(stored) => {
      const data = stored ? { qfc_panel_position_v1: JSON.stringify(stored) } : {};
      Object.defineProperty(window, 'sessionStorage', {configurable: true, value: {
        getItem(k){return Object.prototype.hasOwnProperty.call(data,k) ? data[k] : null;},
        setItem(k,v){data[k]=String(v);},
        removeItem(k){delete data[k];}
      }});
    }''', persisted)
    page.add_style_tag(path=str(PROJECT / 'content.css'))
    page.add_script_tag(path=str(PROJECT / 'core.js'))
    page.add_script_tag(path=str(PROJECT / 'coordinator.js'))
    page.evaluate('''() => {
      QFC.conversationId = () => 'chat:test';
      window.importScripts = () => {};
      let listener;
      chrome.runtime = {id:'mock-qfc-extension',onMessage:{addListener(fn){listener=fn;}},
        sendMessage(request){return new Promise(resolve=>listener(request,
          {id:'mock-qfc-extension',frameId:0,url:'https://chatgpt.com/c/test'},resolve));}};
      Object.defineProperty(navigator,'locks',{value:{request:async (_name,_opts,cb)=>cb({})}});
    }''')
    page.add_script_tag(path=str(PROJECT / 'background.js'))
    page.add_script_tag(path=str(PROJECT / 'content.js'))
    page.locator('.qfc-dock').wait_for()


def inside_viewport(page):
    rect = page.locator('#qfc-panel').bounding_box()
    width, height = page.evaluate('[innerWidth, innerHeight]')
    assert rect['x'] >= 7 and rect['y'] >= 7, rect
    assert rect['x'] + rect['width'] <= width - 7, rect
    assert rect['y'] + rect['height'] <= height - 7, rect
    return rect


with sync_playwright() as p:
    browser = p.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox'])
    context = browser.new_context(viewport={'width':1100,'height':780})
    page = context.new_page()
    page.set_content(HTML)
    attach(page)
    page.locator('.qfc-dock').click()
    initial = inside_viewport(page)
    grip = page.locator('.qfc-drag-handle').bounding_box()
    cx, cy = grip['x'] + grip['width'] * .4, grip['y'] + grip['height'] * .5
    page.mouse.move(cx, cy)
    page.mouse.down()
    page.mouse.move(cx - 215, cy - 130, steps=8)
    page.mouse.up()
    moved = inside_viewport(page)
    assert moved['x'] < initial['x'] - 185, (initial,moved)
    assert moved['y'] < initial['y'] - 100, (initial,moved)
    saved = page.evaluate('JSON.parse(sessionStorage.getItem("qfc_panel_position_v1"))')
    assert saved['x'] <= -185 and saved['y'] <= -100, saved
    # Buttons still work normally after a drag.
    page.locator('[data-action="tab-workflows"]').click()
    assert not page.locator('#qfc-workflows-view').is_hidden()
    page.locator('[data-action="tab-queue"]').click()
    # Closing and opening retains position and works with the existing Queue button.
    page.locator('.qfc-head-actions [data-action="toggle"]').click()
    assert page.locator('#qfc-panel').is_hidden()
    page.locator('.qfc-dock').click()
    again = inside_viewport(page)
    assert abs(again['x']-moved['x']) <= 2 and abs(again['y']-moved['y']) <= 2, (moved,again)
    # Simulate a refresh with a fresh document and the same tab's session storage.
    # Direct browser navigation is blocked in this test environment.
    restored_page = context.new_page()
    restored_page.set_content(HTML)
    attach(restored_page, saved)
    page.close()
    page = restored_page
    page.locator('.qfc-dock').click()
    restored = inside_viewport(page)
    assert abs(restored['x']-moved['x']) <= 2 and abs(restored['y']-moved['y']) <= 2, (moved,restored)
    # Keyboard accessibility: ArrowLeft moves the panel in 10px increments.
    page.locator('.qfc-drag-handle').focus()
    page.keyboard.press('ArrowLeft')
    after_key = inside_viewport(page)
    assert abs(after_key['x']-restored['x'] + 10) <= 2, (restored,after_key)
    # The reset button restores bottom-right default placement.
    page.locator('[data-action="reset-position"]').click()
    reset = inside_viewport(page)
    assert abs(reset['x']-initial['x']) <= 2 and abs(reset['y']-initial['y']) <= 2, (initial,reset)
    # On a smaller viewport the panel must remain onscreen.
    grip = page.locator('.qfc-drag-handle').bounding_box()
    cx, cy = grip['x'] + grip['width'] * .4, grip['y'] + grip['height'] * .5
    page.mouse.move(cx, cy)
    page.mouse.down()
    page.mouse.move(cx - 590, cy - 270, steps=9)
    page.mouse.up()
    page.set_viewport_size({'width':520,'height':480})
    page.wait_for_timeout(450)
    inside_viewport(page)
    print('PASS: drag, button clicks, collapse/reopen, refresh persistence, keyboard, reset, viewport clamping')
    browser.close()
