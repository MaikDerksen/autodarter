"""Local status page on the Pi (default http://<pi>:3180): pairing code, connection, cameras."""
from __future__ import annotations

import asyncio
import base64

from aiohttp import web

from .app import encode_jpeg
from .config import LOCAL_PORT

PAGE = """<!doctype html>
<html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Autodarter Board</title>
<style>
:root{--bg:#0b0f14;--card:#131a22;--line:#253141;--text:#e8eef4;--muted:#8b98a7;--accent:#22c55e;--warn:#f59e0b;--bad:#ef4444}
*{box-sizing:border-box}body{margin:0;font:15px/1.45 system-ui,sans-serif;background:var(--bg);color:var(--text)}
main{max-width:1100px;margin:0 auto;padding:16px;display:grid;gap:16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:16px}
h1{margin:0;font-size:24px}h2{margin:0 0 8px;font-size:17px}.muted{color:var(--muted)}
.code{font:800 44px/1 ui-monospace,monospace;letter-spacing:8px;color:var(--accent)}
.pill{display:inline-block;padding:2px 10px;border-radius:999px;border:1px solid var(--line);font-weight:700;font-size:13px}
.ok{color:var(--accent)}.warn{color:var(--warn)}.bad{color:var(--bad)}
.cams{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px}
.cams img{width:100%;border-radius:10px;background:#000;aspect-ratio:16/9;object-fit:cover}
input{width:100%;padding:10px;border-radius:10px;border:1px solid var(--line);background:var(--bg);color:var(--text);font-size:15px}
button{padding:10px 14px;border-radius:10px;border:0;background:var(--accent);color:#04140a;font-weight:800;cursor:pointer}
button.sec{background:#1a232e;color:var(--text);border:1px solid var(--line)}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
</style></head><body><main>
<div class="card"><div class="row" style="justify-content:space-between"><h1>Autodarter Board</h1><span id="conn" class="pill">…</span></div>
<p class="muted" id="ids"></p></div>
<div class="card" id="pair"><h2>Kopplung</h2><div id="pairbody" class="muted">…</div></div>
<div class="card"><h2>Server</h2>
<div class="row"><input id="server" placeholder="http://192.168.1.10:3000"><button onclick="saveServer()">Speichern</button></div>
<p class="muted" id="servererr"></p></div>
<div class="card"><div class="row" style="justify-content:space-between"><h2>Erkennung</h2><span id="state" class="pill">…</span></div>
<p id="msg" class="muted"></p><p id="dart"></p>
<div class="row"><button class="sec" onclick="cmd('start')">Start</button><button class="sec" onclick="cmd('stop')">Stopp</button><button class="sec" onclick="cmd('reset')">Reset</button><button class="sec" onclick="if(confirm('Board-Client neu starten?'))cmd('restart')">Neu starten</button>
<span id="simctl" style="display:none" class="row"><button onclick="sim('throw')">🎯 Sim: Dart werfen</button><button class="sec" onclick="sim('bounce')">↩️ Sim: Abpraller</button><button class="sec" onclick="sim('fallout')">⬇️ Sim: Dart fällt raus</button><button class="sec" onclick="sim('takeout')">✋ Sim: Darts ziehen</button></span></div></div>
<div class="card"><h2>Kameras</h2><div class="cams" id="cams"></div></div>
</main><script>
let serverSet=false;
async function refresh(){
  try{
    const r=await fetch('api/status');const s=await r.json();
    document.getElementById('ids').textContent='Board-ID '+s.boardId+' · Version '+s.status.version;
    const c=document.getElementById('conn');c.textContent=s.connected?'Mit Server verbunden':'Nicht verbunden';c.className='pill '+(s.connected?'ok':'bad');
    if(!serverSet){document.getElementById('server').value=s.server||'';serverSet=true;}
    document.getElementById('servererr').textContent=s.serverError||'';
    const pb=document.getElementById('pairbody');
    if(s.claimed){pb.innerHTML='<span class="ok">✔ Mit Konto verbunden</span> – Name: <b>'+(s.name||'')+'</b>'+(s.pairingCode?'<p class="muted">Weitere Spieler fügen das Board mit diesem Code in ihrem Konto hinzu (<b>Boards → Board hinzufügen</b>):</p><div class="code">'+s.pairingCode+'</div>':'');}
    else if(s.pairingCode){pb.innerHTML='<div class="code">'+s.pairingCode+'</div><p class="muted">Diesen Code in der Autodarter-Web-App unter <b>Boards → Board hinzufügen</b> eingeben.</p>';}
    else{pb.textContent='Kopplungscode erscheint, sobald der Server erreichbar ist.';}
    const st=document.getElementById('state');st.textContent=s.status.state+' · '+s.status.darts+' Darts · '+s.status.fps+' FPS';
    st.className='pill '+(s.status.state==='throw'?'ok':(s.status.state.startsWith('takeout')?'warn':'bad'));
    document.getElementById('msg').textContent=s.status.message||'';
    const d=s.lastDart;
    document.getElementById('dart').innerHTML=!d?'':d.out==='bounce'?'Letzter Dart: <b>MISS</b> (Abpraller)':('Letzter Dart: <b>'+(d.out==='fall'?'MISS</b> (rausgefallen, war '+d.label+')':d.label+'</b>')+' ('+d.x.toFixed(1)+' / '+d.y.toFixed(1)+' mm, Kameras '+d.cameras.map(x=>x+1).join(',')+')');
    document.getElementById('simctl').style.display=s.sim?'flex':'none';
    const cams=document.getElementById('cams');
    if(cams.children.length!==s.status.cameras.length){cams.innerHTML=s.status.cameras.map(c=>'<div><img data-i="'+c.index+'"><div class="muted" id="cam'+c.index+'"></div></div>').join('');}
    s.status.cameras.forEach(c=>{const el=document.getElementById('cam'+c.index);if(el)el.innerHTML='Kamera '+(c.index+1)+' · '+c.name+' · '+c.width+'×'+c.height+' · '+c.fps+' FPS · '+(c.calibrated?'<span class="ok">kalibriert</span>':'<span class="warn">nicht kalibriert</span>');});
  }catch(e){document.getElementById('conn').textContent='Board-Client nicht erreichbar';}
}
function refreshImages(){document.querySelectorAll('#cams img').forEach(img=>{img.src='api/camera/'+img.dataset.i+'.jpg?t='+Date.now();});}
async function saveServer(){await fetch('api/server',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({url:document.getElementById('server').value})});serverSet=false;refresh();}
async function cmd(a){await fetch('api/command',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:a})});refresh();}
async function sim(a){await fetch('api/sim/'+a,{method:'POST'});setTimeout(refresh,800);}
refresh();setInterval(refresh,1000);setInterval(refreshImages,1500);setTimeout(refreshImages,300);
</script></body></html>"""


async def start_webui(app) -> web.AppRunner:
    routes = web.RouteTableDef()

    @routes.get("/")
    async def index(_req):
        return web.Response(text=PAGE, content_type="text/html")

    @routes.get("/api/status")
    async def status(_req):
        return web.json_response(
            {
                "boardId": app.store.board_id,
                "pairingCode": app.pairing_code,
                "claimed": app.claimed,
                "name": app.board_name,
                "server": app.store.server_url,
                "connected": app.connected,
                "serverError": app.server_error,
                "status": app.status(),
                "lastDart": app.last_dart,
                "sim": app.sim is not None,
                # somebody played in the last minutes -> the auto-updater postpones updates
                "busy": app.busy,
            }
        )

    @routes.post("/api/server")
    async def set_server(req):
        data = await req.json()
        app.store.set_server_url(str(data.get("url", "")))
        app.request_reconnect()
        return web.json_response({"ok": True})

    @routes.post("/api/command")
    async def command(req):
        data = await req.json()
        action = str(data.get("action", ""))
        # the local page has no login – rebooting the Pi is only possible from the web app
        if action not in ("start", "stop", "reset", "rescan", "restart"):
            raise web.HTTPForbidden(text="action not allowed locally")
        await app.command(action)
        return web.json_response({"ok": True})

    @routes.get("/api/camera/{index}.jpg")
    async def camera(req):
        cam = app.cameras.by_index(int(req.match_info["index"]))
        if cam is None:
            raise web.HTTPNotFound()
        _, frame = cam.latest()
        if frame is None:
            raise web.HTTPNotFound()
        data, _, _ = await asyncio.to_thread(encode_jpeg, frame, 640, 70)
        return web.Response(body=base64.b64decode(data), content_type="image/jpeg", headers={"cache-control": "no-store"})

    @routes.post("/api/sim/throw")
    async def sim_throw(req):
        if app.sim is None:
            raise web.HTTPNotFound()
        data = await req.json() if req.can_read_body else {}
        x, y = app.sim.throw(data.get("x"), data.get("y"))
        return web.json_response({"x": x, "y": y})

    @routes.post("/api/sim/bounce")
    async def sim_bounce(req):
        if app.sim is None:
            raise web.HTTPNotFound()
        data = await req.json() if req.can_read_body else {}
        x, y = app.sim.bounce(data.get("x"), data.get("y"))
        return web.json_response({"x": x, "y": y})

    @routes.post("/api/sim/fallout")
    async def sim_fallout(req):
        if app.sim is None:
            raise web.HTTPNotFound()
        data = await req.json() if req.can_read_body else {}
        return web.json_response({"ok": app.sim.fall_out(int(data.get("index", 0)))})

    @routes.post("/api/sim/takeout")
    async def sim_takeout(_req):
        if app.sim is None:
            raise web.HTTPNotFound()
        app.sim.takeout()
        return web.json_response({"ok": True})

    webapp = web.Application()
    webapp.add_routes(routes)
    runner = web.AppRunner(webapp)
    await runner.setup()
    await web.TCPSite(runner, "0.0.0.0", LOCAL_PORT).start()
    return runner
