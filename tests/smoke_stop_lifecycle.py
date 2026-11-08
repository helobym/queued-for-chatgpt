"""v1.2.11: observed Stop lifecycle survives a delayed receipt storage acknowledgement."""
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT=Path(__file__).resolve().parent.parent
with sync_playwright() as playwright:
    browser=playwright.chromium.launch(
        executable_path="/usr/bin/chromium",headless=True,args=["--no-sandbox"])
    page=browser.new_page(viewport={"width":1200,"height":900})
    page.set_content((ROOT/"tests/mock_app_shell.html").read_text(encoding="utf-8"))
    page.evaluate("window.__suppressCompletedActions=true")
    page.add_style_tag(path=str(ROOT/"content.css"))
    page.add_script_tag(path=str(ROOT/"core.js"))
    page.add_script_tag(path=str(ROOT/"coordinator.js"))
    page.evaluate("""() => {
      QFC.conversationId=()=> 'chat:stop-lifecycle';
      window.importScripts=()=>{};
      const handlers=[];
      chrome.runtime={
        id:'mock-qfc-extension',
        onMessage:{addListener(fn){handlers.push(fn);}},
        async sendMessage(message){
          if(message.command==='queue' && message.mutation?.type==='awaiting')
            await new Promise(resolve=>setTimeout(resolve,500));
          return new Promise(resolve=>{
            let handled=false,replied=false;
            for(const fn of handlers){
              const ret=fn(message,{id:'mock-qfc-extension',frameId:0,
                url:'https://chatgpt.com/c/stop-lifecycle',tab:{id:8}},data=>{
                  replied=true;resolve(data);
                });
              if(ret===true)handled=true;
            }
            if(!handled&&!replied)resolve(undefined);
          });
        }
      };
      chrome.commands={onCommand:{addListener(){}}};
      chrome.tabs={onUpdated:{addListener(){}},onRemoved:{addListener(){}},
        async query(){return[];}};
      Object.defineProperty(navigator,'locks',{configurable:true,value:{
        request:async(_name,_opts,fn)=>fn({})
      }});
      document.querySelector('[data-testid="send-button"]').addEventListener(
        'click',()=>{
          const stop=document.createElement('button');
          stop.dataset.testid='stop-button';stop.textContent='Stop';
          document.querySelector('form').append(stop);
          setTimeout(()=>stop.remove(),140);
        },true
      );
    }""")
    page.add_script_tag(path=str(ROOT/"background.js"))
    page.add_script_tag(path=str(ROOT/"content.js"))
    page.locator(".qfc-dock").click()
    for prompt in ("Receipt delayed first", "Second should follow"):
        page.locator("#qfc-compose").fill(prompt)
        page.locator("#qfc-add").click()
        page.locator("#qfc-queue-items").get_by_text(prompt).wait_for()
    page.locator("#qfc-start").click()
    page.wait_for_function(
        "document.querySelector('#qfc-status').textContent.includes('Queue complete.')",
        timeout=35000
    )
    assert page.evaluate("window.__sentCount")==2
    assert page.locator("#qfc-count").inner_text()=="0"
    browser.close()
    print("PASS: observed Stop lifecycle safely bridges delayed receipt verification")
