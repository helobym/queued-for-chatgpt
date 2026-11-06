"""Project landing routes: Load, Start, queue isolation, migration and navigation safety."""
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
PROJECT_A = '/g/g-p-project-a/project'
PROJECT_B = '/g/g-p-project-b/project'
PROJECT_C = '/g/g-p-project-c/project'
MOCK = (ROOT / 'tests/mock_chat.html').read_text(encoding='utf-8').replace(
    "const user = document.createElement('div');",
    """if (/\\/project\\/?$/.test(location.pathname)) {
        // A Project starts its first conversation when the first prompt is sent.
        history.pushState({}, '', '/g/g-p-project-c/c/created-project-chat');
        dispatchEvent(new Event('popstate'));
      }
      const user = document.createElement('div');""", 1
)


def navigate(page, path):
    page.evaluate("""path => {
      history.pushState({}, '', path);
      dispatchEvent(new Event('popstate'));
    }""", path)


def install(page, stored=None):
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
    }""")
    page.add_script_tag(path=str(ROOT / 'background.js'))
    if stored is not None:
        page.evaluate('(initial) => chrome.storage.local.set(initial)', stored)
    # Unlike older new-chat tests, do not monkey-patch route identification.
    page.add_script_tag(path=str(ROOT / 'content.js'))
    page.locator('.qfc-dock').click()


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(
        executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox'])
    page = browser.new_page(viewport={'width': 1200, 'height': 900})
    page.route('https://chatgpt.com/**', lambda route: route.fulfill(
        status=200, content_type='text/html', body=MOCK))
    page.goto('https://chatgpt.com' + PROJECT_A)
    install(page)

    # A Project landing page must support Load without sending.
    page.locator('[data-action="tab-workflows"]').click()
    page.locator('[data-action="new-workflow"]').click()
    page.locator('#qfc-edit-workflow-name').fill('Project steps')
    page.locator('#qfc-step-0').fill('First Project prompt')
    page.locator('[data-action="add-workflow-step"]').click()
    page.locator('#qfc-step-1').fill('Second Project prompt')
    page.locator('[data-action="save-workflow-edit"]').click()
    page.locator('[data-action="load-workflow"]').click()
    page.wait_for_function("document.querySelector('#qfc-count').textContent === '2'")
    assert page.locator('#qfc-pause').is_disabled()
    assert page.locator('#qfc-start').is_enabled()
    assert page.locator('.qfc-dock').get_attribute('data-phase') == 'paused'
    assert '2 pending' in page.locator('#qfc-dock-count').inner_text()
    assert page.locator('[data-message-author-role="user"]').count() == 1
    route_a = page.evaluate(
        "sessionStorage.getItem('qfc_v1_temporary_conversation_project_g-p-project-a')")
    assert route_a and route_a.startswith('new:'), route_a

    # SPA navigation must keep separate queues and restore the previous one.
    navigate(page, PROJECT_B)
    page.wait_for_function("document.querySelector('#qfc-count').textContent === '0'")
    page.locator('#qfc-compose').fill('Only in Project B')
    page.locator('#qfc-add').click()
    page.wait_for_function("document.querySelector('#qfc-count').textContent === '1'")
    assert '1 pending' in page.locator('#qfc-dock-count').inner_text()
    route_b = page.evaluate(
        "sessionStorage.getItem('qfc_v1_temporary_conversation_project_g-p-project-b')")
    assert route_b and route_a != route_b, (route_a, route_b)
    navigate(page, PROJECT_A + '/')
    page.wait_for_function("document.querySelector('#qfc-count').textContent === '2'")
    assert '2 pending' in page.locator('#qfc-dock-count').inner_text()
    assert page.locator('#qfc-queue-items').get_by_text('First Project prompt').count() == 1

    # A fresh content script and service worker must restore both Project queues.
    saved = page.evaluate("""async routes => chrome.storage.local.get([
      'qfc_v3_workflows', ...routes.map(route => 'qfc_v2_queue_' + route)
    ])""", [route_a, route_b])
    page.reload()
    install(page, saved)
    page.wait_for_function("document.querySelector('#qfc-count').textContent === '2'")
    assert page.evaluate(
        "sessionStorage.getItem('qfc_v1_temporary_conversation_project_g-p-project-a')") == route_a
    navigate(page, PROJECT_B)
    page.wait_for_function("document.querySelector('#qfc-count').textContent === '1'")
    assert page.locator('#qfc-queue-items').get_by_text('Only in Project B').count() == 1

    # Unsupported Project subpages must not be considered New Chat composers.
    navigate(page, '/g/g-p-project-b/project/settings')
    page.wait_for_function("document.querySelector('#qfc-count').textContent === '0'")
    page.locator('[data-action="tab-workflows"]').click()
    page.locator('[data-action="load-workflow"]').click()
    page.wait_for_function(
        "document.querySelector('#qfc-status').textContent.includes('Open a ChatGPT conversation')")
    assert page.locator('#qfc-count').inner_text() == '0'

    # Start Workflow on Project C should send a first prompt, migrate, and continue.
    navigate(page, PROJECT_C)
    page.wait_for_function("document.querySelector('#qfc-status').textContent.includes('New chat: Start sends')")
    page.wait_for_timeout(100)  # Allow the asynchronous Project queue load to settle.
    page.locator('[data-action="start-workflow"]').click()
    page.wait_for_function(
        "document.querySelector('#qfc-status').textContent.includes('Queue complete')",
        timeout=45000)
    assert page.url.endswith('/g/g-p-project-c/c/created-project-chat'), page.url
    assert page.locator('#qfc-count').inner_text() == '0'
    sent = page.locator('[data-message-author-role="user"] .whitespace-pre-wrap').all_inner_texts()
    assert sent[-2:] == ['First Project prompt', 'Second Project prompt'], sent
    assert page.evaluate(
        "sessionStorage.getItem('qfc_v1_temporary_conversation_project_g-p-project-c')") is None
    assert page.evaluate(
        "sessionStorage.getItem('qfc_v1_temporary_conversation_project_g-p-project-a')") == route_a
    print('PASS: Project route recognition, passive Load, Start, migration and isolation')
    browser.close()
