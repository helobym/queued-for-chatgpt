"""v1.2.11: wheel scroll chains from expanded prompts to the workflow list."""
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT=Path(__file__).resolve().parent.parent
with sync_playwright() as playwright:
    browser=playwright.chromium.launch(
        executable_path="/usr/bin/chromium",headless=True,args=["--no-sandbox"])
    page=browser.new_page(viewport={"width":1100,"height":660})
    page.set_content((ROOT/"tests/mock_chat.html").read_text(encoding="utf-8"))
    page.add_style_tag(path=str(ROOT/"content.css"))
    page.add_script_tag(path=str(ROOT/"core.js"))
    page.add_script_tag(path=str(ROOT/"coordinator.js"))
    page.evaluate("""() => {
      QFC.conversationId=()=> 'chat:scroll';
      window.importScripts=()=>{};
      const handlers=[];
      chrome.runtime={
        id:'mock-qfc-extension',
        onMessage:{addListener(fn){handlers.push(fn);},removeListener(fn){
          const i=handlers.indexOf(fn);if(i>=0)handlers.splice(i,1);
        }},
        sendMessage(message){return new Promise(resolve=>{
          let replied=false,handled=false;
          for(const fn of handlers){
            const r=fn(message,{id:'mock-qfc-extension',frameId:0,
              url:'https://chatgpt.com/c/scroll',tab:{id:7}},data=>{
                replied=true;resolve(data);
              });
            if(r===true)handled=true;
          }
          if(!replied&&!handled)resolve(undefined);
        });}
      };
      chrome.commands={onCommand:{addListener(){}}};
      chrome.tabs={onUpdated:{addListener(){}},onRemoved:{addListener(){}},
        async query(){return[];}};
      Object.defineProperty(navigator,'locks',{configurable:true,value:{
        request:async(_name,_opts,fn)=>fn({})
      }});
    }""")
    page.add_script_tag(path=str(ROOT/"background.js"))
    page.add_script_tag(path=str(ROOT/"content.js"))
    page.locator(".qfc-dock").click()
    page.locator("#qfc-panel").wait_for(state="visible")
    page.locator('[data-action="tab-workflows"]').click()
    page.evaluate("""async()=>{
      for(const name of ['Long workflow','Additional workflow']){
        const steps=Array.from({length:30},(_,i)=>
          'Prompt '+(i+1)+' '+('Read the following detailed procedure. '.repeat(10)));
        const reply=await chrome.runtime.sendMessage({
          app:'qfc-v1.1',command:'workflows',
          operationId:'scroll-create-'+name.replace(/ /g,'-'),
          mutation:{type:'create',name,steps}
        });
        if(!reply.ok)throw new Error(reply.error);
      }
    }""")
    page.locator('[data-action="toggle-workflow"]').first.click()
    details=page.locator(".qfc-workflow-details").first
    details.wait_for(state="visible")
    view=page.locator("#qfc-workflows-view")
    assert details.evaluate("(el)=>el.scrollHeight>el.clientHeight")
    assert view.evaluate("(el)=>el.scrollHeight>el.clientHeight")
    details.evaluate("(el)=>{el.scrollTop=el.scrollHeight}")
    view.evaluate("(el)=>{el.scrollTop=0}")
    box=details.bounding_box()
    assert box is not None
    page.mouse.move(box["x"]+min(box["width"]*0.5,140),
                    box["y"]+min(box["height"]*0.5,95))
    page.mouse.wheel(0,350)
    page.wait_for_function("document.querySelector('#qfc-workflows-view').scrollTop>0")
    browser.close()
    print("PASS: expanded workflow scrolls naturally into the enclosing list")
