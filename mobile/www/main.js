(function(){
  var $ = function(id){ return document.getElementById(id); };
  var KEY = 'pr_launch';
  function save(v){ try{ localStorage.setItem(KEY, JSON.stringify(v)); }catch(e){} }
  function load(){ try{ return JSON.parse(localStorage.getItem(KEY) || 'null'); }catch(e){ return null; } }
  function norm(v){
    v = (v || '').trim(); if(!v) return '';
    if(!/^https?:\/\//i.test(v)) v = 'http://' + v;
    try{ var u = new URL(v); if(!u.port) u.port = '8787'; return u.origin; }catch(e){ return ''; }
  }
  // "Can I reach this address?" — a no-cors request resolves for any reachable server, so no CORS setup is needed.
  function reachable(origin){
    return new Promise(function(res){
      var ctl = new AbortController(), t = setTimeout(function(){ ctl.abort(); res(false); }, 3000);
      fetch(origin + '/remote', { mode:'no-cors', cache:'no-store', signal: ctl.signal })
        .then(function(){ clearTimeout(t); res(true); }, function(){ clearTimeout(t); res(false); });
    });
  }
  async function open(origins){
    $('err').textContent = ''; $('go').disabled = true; $('go').textContent = 'Connecting…';
    for(var i = 0; i < origins.length; i++){
      if(origins[i] && await reachable(origins[i])){
        save({ host: origins[i], builtin: $('builtin').checked });
        if($('builtin').checked){
          // The remote page packaged inside this app (needs the server's CORS headers, which server.js sends).
          location.href = 'remote.html?connect=1&host=' + encodeURIComponent(origins[i]) + (origins.length > 1 ? '&alt=' + origins.slice(1).map(function(o){ return encodeURIComponent(o.replace(/^https?:\/\//, '')); }).join(',') : '');
        } else {
          // Default: load the remote page FROM the computer, so it is always the same version as the server.
          location.href = origins[i] + '/remote?connect=1' + (origins.length > 1 ? '&alt=' + origins.filter(function(o, k){ return k !== i; }).map(function(o){ return encodeURIComponent(o.replace(/^https?:\/\//, '')); }).join(',') : '');
        }
        return;
      }
    }
    $('go').disabled = false; $('go').textContent = 'Connect';
    $('err').textContent = 'Could not reach the computer. Check the address, that Presenter is open, and Wi-Fi / Tailscale.';
  }
  $('go').addEventListener('click', function(){
    var h = norm($('host').value);
    if(!h){ $('err').textContent = 'Enter the computer\'s address.'; return; }
    open([h]);
  });
  // QR code from the Presenter "Phone" window: http://IP:PORT/remote?connect=1&alt=IP2,IP3 (no password)
  function fromQR(text){
    var u; try{ u = new URL(text); }catch(e){ $('err').textContent = 'That QR code is not a Presenter link.'; return; }
    var port = u.port || '8787';
    var alts = (u.searchParams.get('alt') || '').split(',').filter(Boolean).map(function(a){ return norm(a.indexOf(':') > -1 ? a : a + ':' + port); });
    open([u.origin].concat(alts));   // the QR code carries no password: it only connects
  }
  $('scan').addEventListener('click', async function(){
    var BS = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.BarcodeScanner;
    if(!BS){ $('err').textContent = 'Scanner not available here — type the details instead.'; return; }
    try{
      try{
        var av = await BS.isGoogleBarcodeScannerModuleAvailable();
        if(!av.available) await BS.installGoogleBarcodeScannerModule();
      }catch(e){}
      var r = await BS.scan({ formats: ['QR_CODE'] });
      if(r && r.barcodes && r.barcodes[0]) fromQR(r.barcodes[0].rawValue);
    }catch(e){ $('err').textContent = 'Scan cancelled or failed — you can type the details instead.'; }
  });
  var last = load();
  if(last){ $('host').value = last.host.replace(/^http:\/\//, ''); $('builtin').checked = !!last.builtin; }
})();
