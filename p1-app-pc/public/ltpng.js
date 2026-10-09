/* WCM LIVE - Custom PNG Lower Thirds: shared data model + renderer.
   Loaded by presenter.html (Control window, Live window, Preview window, OBS /live page) and overlay.html.
   It knows nothing about the dock UI; it only turns a "state" object into a graphic on top of a host element.

   state = { v:1, visible:bool, nonce:int, until:ms|0, item:<normalised item>|null }
   item  = { id, file, name, w, h, x, y, scale, opacity, anim, duration, autoHide, shadow, texts:[ {id,text,x,y,size,color,font,bold,align} ] }
     x / y     centre of the graphic, in % of the screen (0-100)
     scale     width of the graphic, in % of the screen width (5-150)
     texts     x / y = centre of the text block inside the graphic (% of the graphic), size = % of the graphic width        */
(function(){
  'use strict';

  var FONTS = {
    'stage':          { label:'Same as stage text', stack:null },
    'sans-clean':     { label:'Clean Sans',     stack:"-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif" },
    'sans-bold':      { label:'Bold Sans',      stack:"'Arial Black','Helvetica Neue',Arial,sans-serif" },
    'condensed':      { label:'Condensed',      stack:"'Arial Narrow',Arial,sans-serif" },
    'rounded':        { label:'Rounded',        stack:"'Trebuchet MS',Verdana,sans-serif" },
    'serif-classic':  { label:'Classic Serif',  stack:"Georgia,'Cambria','Times New Roman',serif" },
    'serif-elegant':  { label:'Elegant Serif',  stack:"'Palatino Linotype',Palatino,'Book Antiqua',Georgia,serif" },
    'slab':           { label:'Slab Serif',     stack:"'Rockwell','Courier New',Georgia,serif" },
    'display-impact': { label:'Impact',         stack:"Impact,'Arial Black',sans-serif" },
    'script-elegant': { label:'Elegant Script', stack:"'Brush Script MT','Segoe Script',cursive" },
    'mono':           { label:'Monospace',      stack:"'Courier New',Courier,monospace" }
  };
  var TE = "'Noto Sans Telugu','Nirmala UI','Gautami','Vani'";   // Telugu always has a fallback, whatever font is chosen

  // Same effect names as the text lower thirds, so the operator sees one familiar list.
  var FX = {
    fade:       { label:'Fade',                'in':[{opacity:0},{opacity:1}],                                              out:[{opacity:1},{opacity:0}] },
    slideup:    { label:'Slide up',            'in':[{opacity:0,transform:'translateY(5vh)'},{opacity:1,transform:'translateY(0)'}],        out:[{opacity:1,transform:'translateY(0)'},{opacity:0,transform:'translateY(4vh)'}] },
    slideleft:  { label:'Slide in from left',  'in':[{opacity:0,transform:'translateX(-14vw)'},{opacity:1,transform:'translateX(0)'}],     out:[{opacity:1,transform:'translateX(0)'},{opacity:0,transform:'translateX(-14vw)'}] },
    slideright: { label:'Slide in from right', 'in':[{opacity:0,transform:'translateX(14vw)'},{opacity:1,transform:'translateX(0)'}],      out:[{opacity:1,transform:'translateX(0)'},{opacity:0,transform:'translateX(14vw)'}] },
    zoom:       { label:'Zoom',                'in':[{opacity:0,transform:'scale(.88)'},{opacity:1,transform:'scale(1)'}],                  out:[{opacity:1,transform:'scale(1)'},{opacity:0,transform:'scale(.92)'}] },
    blur:       { label:'Blur',                'in':[{opacity:0,filter:'blur(14px)'},{opacity:1,filter:'blur(0)'}],                         out:[{opacity:1,filter:'blur(0)'},{opacity:0,filter:'blur(14px)'}] },
    wipe:       { label:'Wipe (left to right)','in':[{clipPath:'inset(0 100% 0 0)',opacity:1},{clipPath:'inset(0 0 0 0)',opacity:1}],       out:[{clipPath:'inset(0 0 0 0)',opacity:1},{clipPath:'inset(0 0 0 100%)',opacity:1}] },
    none:       { label:'None (instant)',      'in':null, out:null }
  };

  var HEX = /^#[0-9a-f]{6}$/i;
  function clamp(v, lo, hi, d){ v = Number(v); return isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d; }
  function round1(v){ return Math.round(v * 10) / 10; }
  function str(v, max){ return typeof v === 'string' ? v.slice(0, max) : ''; }
  function uid(p){ return p + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-3); }
  function safeFile(f){
    // a file we serve ("/lt-assets/<id>.png") or, with no server, a small embedded PNG
    f = typeof f === 'string' ? f : '';
    if(/^(https?:\/\/[A-Za-z0-9.\-\[\]:]+)?\/lt-assets\/ltp_[a-f0-9]{16}\.png$/.test(f)) return f;   // relative, or absolute when a phone loads the picture from the computer
    if(/^data:image\/png;base64,[A-Za-z0-9+\/=]+$/.test(f) && f.length < 3500000) return f;
    return '';
  }

  function defaultText(over){
    return Object.assign({ id:uid('t'), text:'Name Surname', x:50, y:50, size:5, color:'#ffffff', font:'sans-clean', bold:true, align:'center' }, over || {});
  }
  function normText(t){
    t = t && typeof t === 'object' ? t : {};
    return {
      id:    str(t.id, 24) || uid('t'),
      text:  str(t.text, 200),
      x:     round1(clamp(t.x, 0, 100, 50)),
      y:     round1(clamp(t.y, 0, 100, 50)),
      size:  round1(clamp(t.size, 1, 30, 5)),
      color: HEX.test(t.color) ? t.color.toLowerCase() : '#ffffff',
      font:  FONTS[t.font] ? t.font : 'sans-clean',
      bold:  t.bold !== false && t.bold !== 0 && t.bold !== 'false',
      align: (t.align === 'left' || t.align === 'right') ? t.align : 'center'
    };
  }
  function normItem(o){
    o = o && typeof o === 'object' ? o : {};
    var texts = Array.isArray(o.texts) ? o.texts.slice(0, 4).map(normText) : [];
    return {
      id:       str(o.id, 24) || uid('lp_'),
      file:     safeFile(o.file),
      name:     str(o.name, 80) || 'Lower third',
      w:        Math.round(clamp(o.w, 0, 20000, 0)),
      h:        Math.round(clamp(o.h, 0, 20000, 0)),
      x:        round1(clamp(o.x, -50, 150, 50)),
      y:        round1(clamp(o.y, -50, 150, 84)),
      scale:    round1(clamp(o.scale, 5, 150, 45)),
      opacity:  Math.round(clamp(o.opacity, 0, 100, 100)),
      anim:     FX[o.anim] ? o.anim : 'slideleft',
      duration: Math.round(clamp(o.duration, 100, 3000, 600)),
      autoHide: Math.round(clamp(o.autoHide, 0, 600, 0)),     // seconds; 0 = stays until hidden
      shadow:   o.shadow === true,
      texts:    texts
    };
  }
  function normState(s){
    s = s && typeof s === 'object' ? s : {};
    var item = s.item ? normItem(s.item) : null;
    if(item && !item.file) item = null;
    return { v:1, visible: s.visible === true && !!item, nonce: Math.round(clamp(s.nonce, 0, 1e12, 0)), until: Math.round(clamp(s.until, 0, 1e14, 0)), item: item };
  }
  function parseState(raw){
    if(!raw) return normState(null);
    try{ return normState(typeof raw === 'string' ? JSON.parse(raw) : raw); }catch(e){ return normState(null); }
  }

  /* ----------------------------------------------------------- styles (injected once) ----------------------------------------------------------- */
  var CSS =
    '.ltpng-layer{position:absolute;left:0;top:0;right:0;bottom:0;overflow:hidden;pointer-events:none;z-index:40;}' +
    '.ltpng-pos{position:absolute;container-type:inline-size;}' +
    '.ltpng-fx{position:relative;width:100%;line-height:0;}' +
    '.ltpng-img{display:block;width:100%;height:auto;-webkit-user-drag:none;user-select:none;}' +
    '.ltpng-tx{position:absolute;line-height:1.15;white-space:pre-wrap;transform:translate(-50%,-50%);max-width:96%;}' +
    '.ltpng-tx.sh{text-shadow:0 .06em .18em rgba(0,0,0,.55);}' +
    '.ltpng-tx:empty{display:none;}';
  function injectCss(){
    if(document.getElementById('ltpng-css')) return;
    var s = document.createElement('style'); s.id = 'ltpng-css'; s.textContent = CSS;
    (document.head || document.documentElement).appendChild(s);
  }

  function reducedMotion(){ return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); }
  function fontStack(key){
    var f = FONTS[key];
    return (f && f.stack ? f.stack + ',' : "var(--live-font,var(--stage-font,Georgia,serif)),") + TE + ',sans-serif';
  }

  /* ----------------------------------------------------------- layer controller ----------------------------------------------------------- */
  // create(host, opts)   opts.instant: never animate (editor canvas, small preview boxes)   opts.onHide: called when auto-hide fires
  function create(host, opts){
    opts = opts || {};
    injectCss();
    var layer = document.createElement('div'); layer.className = 'ltpng-layer';
    host.appendChild(layer);
    var pos = null, fxEl = null, img = null, shown = false, curSig = '', lastNonce = -1, hideT = null, token = 0, anims = [];

    function stopAnims(){ anims.forEach(function(a){ try{ a.cancel(); }catch(e){} }); anims = []; }
    function build(){
      pos = document.createElement('div'); pos.className = 'ltpng-pos';
      fxEl = document.createElement('div'); fxEl.className = 'ltpng-fx';
      img = document.createElement('img'); img.className = 'ltpng-img'; img.alt = ''; img.draggable = false;
      fxEl.appendChild(img); pos.appendChild(fxEl); layer.appendChild(pos);
    }
    function destroyNodes(){ if(pos && pos.parentNode) pos.parentNode.removeChild(pos); pos = fxEl = img = null; }

    // write position / size / opacity / texts into the existing nodes (no animation, no flicker)
    function paint(item){
      if(img.getAttribute('src') !== item.file) img.src = item.file;
      pos.style.left = item.x + '%'; pos.style.top = item.y + '%'; pos.style.width = item.scale + '%';
      pos.style.transform = 'translate(-50%,-50%)';
      pos.style.opacity = String(item.opacity / 100);
      var have = fxEl.querySelectorAll('.ltpng-tx');
      for(var i = have.length; i > item.texts.length; i--) fxEl.removeChild(have[i - 1]);
      item.texts.forEach(function(t, i){
        var e = have[i]; if(!e || !e.parentNode){ e = document.createElement('div'); e.className = 'ltpng-tx'; fxEl.appendChild(e); }
        if(e.textContent !== t.text) e.textContent = t.text;
        e.dataset.tid = t.id;
        e.className = 'ltpng-tx' + (item.shadow ? ' sh' : '');
        e.style.left = t.x + '%'; e.style.top = t.y + '%';
        e.style.fontSize = t.size + 'cqw'; e.style.color = t.color; e.style.fontFamily = fontStack(t.font);
        e.style.fontWeight = t.bold ? '700' : '400'; e.style.textAlign = t.align;
        e.style.width = 'max-content';
        if(/[\u0C00-\u0C7F]/.test(t.text)) e.setAttribute('lang', 'te'); else e.removeAttribute('lang');
      });
    }
    function play(which, item, done){
      var fx = FX[item.anim], list = fx && fx[which];
      if(!list || !fxEl.animate || reducedMotion() || opts.instant){ if(done) done(); return; }
      var tk = ++token;
      var a = fxEl.animate(list, { duration: which === 'out' ? Math.min(item.duration, 450) : item.duration, easing: which === 'out' ? 'ease-in' : 'ease-out', fill:'both' });
      anims.push(a);
      a.onfinish = function(){ try{ a.cancel(); }catch(e){} if(tk === token && done) done(); };
    }
    function clearTimer(){ clearTimeout(hideT); hideT = null; }
    function armAutoHide(st){
      clearTimer();
      if(!st.until || opts.instant) return;
      var ms = st.until - Date.now();
      hideT = setTimeout(function(){ api.set(Object.assign({}, st, { visible:false })); if(opts.onHide) opts.onHide(st); }, Math.max(0, ms));
    }

    var api = {
      el: layer,
      set: function(raw){
        var st = normState(raw), item = st.item;
        var want = st.visible && (!st.until || st.until > Date.now());
        if(!want || !item){
          clearTimer();
          if(shown && pos){
            shown = false; var old = item || null; curSig = ''; var p = pos;
            var cfgItem = api._last || old;
            if(cfgItem){ stopAnims(); play('out', cfgItem, function(){ if(!shown && pos === p) destroyNodes(); }); }
            else destroyNodes();
          }
          lastNonce = st.nonce; return;
        }
        var sig = JSON.stringify(item);
        api._last = item;
        if(!shown){
          stopAnims(); if(pos && !img) destroyNodes(); if(!pos) build();
          paint(item); shown = true; curSig = sig; lastNonce = st.nonce;
          play('in', item); armAutoHide(st); return;
        }
        if(st.nonce !== lastNonce){                       // re-triggered while on screen: quick out, swap, in
          lastNonce = st.nonce; curSig = sig; armAutoHide(st); var self = pos;
          if(opts.instant){ paint(item); return; }
          stopAnims();
          play('out', item, function(){ if(pos !== self || !shown) return; paint(item); play('in', item); });
          return;
        }
        if(sig !== curSig){ curSig = sig; paint(item); }  // edited while on screen (editor canvas, Preview): update in place
        armAutoHide(st);
      },
      destroy: function(){ clearTimer(); stopAnims(); destroyNodes(); if(layer.parentNode) layer.parentNode.removeChild(layer); },
      positionEl: function(){ return pos; }
    };
    return api;
  }

  window.LTPNG = { FONTS:FONTS, FX:FX, uid:uid, clamp:clamp, defaultText:defaultText, normItem:normItem, normText:normText, normState:normState, parseState:parseState, create:create, safeFile:safeFile };
})();
