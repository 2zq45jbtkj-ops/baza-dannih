// Публичная страница воспроизведения одной записи по непредсказуемому токену.
// GET /api/recording?token=UUID — отдаёт HTML с тем же плеером, что в
// карточке записи в Дневнике занятий/Кабинете (тёмная карточка, метки
// преподавателя на волне), только в режиме только-чтения — без
// переименования/удаления/видимости, это публичная страница без авторизации.
//
// Сама запись лежит как base64 внутри student_intake.reference_takes или
// lesson_log.takes (отдельного файлового хранилища для аудио пока нет) —
// эндпоинт находит take с нужным publicToken и отдаёт его целиком (включая
// peaks/markers) клиенту, который сам конвертирует dataUrl в Blob-URL перед
// тем как отдать его в <audio> — на части мобильных браузеров огромный
// data: URI прямо в src не проигрывался.
const { queryRaw } = require('./_db');

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const token = (req.query && req.query.token) || new URL(req.url, 'http://x').searchParams.get('token');
  if (!token || !/^[0-9a-f-]{36}$/i.test(token)) {
    res.status(400).send('Неверная ссылка на запись.');
    return;
  }

  try {
    const needle = JSON.stringify([{ publicToken: token }]);
    let take = null;
    let studentName = '';

    // Один запрос (UNION ALL) вместо двух последовательных — один сетевой
    // round-trip до Neon вместо двух, см. комментарий у queryRaw в _db.js.
    const r = await queryRaw(
      `SELECT si.reference_takes AS takes, s.name AS name
         FROM student_intake si JOIN students s ON s.id = si.student_id
        WHERE si.reference_takes @> $1::jsonb
       UNION ALL
       SELECT l.takes AS takes, s.name AS name
         FROM lesson_log l JOIN students s ON s.id = l.student_id
        WHERE l.takes @> $1::jsonb
       LIMIT 1`,
      [needle]
    );
    if (r.rows.length) {
      take = (r.rows[0].takes || []).find(t => t.publicToken === token) || null;
      studentName = r.rows[0].name;
    }

    if (!take || !take.dataUrl) {
      res.status(404).send('Запись не найдена — возможно, ссылка устарела.');
      return;
    }

    const payload = {
      name: take.name || 'Запись',
      dataUrl: take.dataUrl,
      durationSec: take.durationSec || 0,
      createdAt: take.createdAt || null,
      peaks: Array.isArray(take.peaks) ? take.peaks : [],
      markers: Array.isArray(take.markers) ? take.markers : [],
      studentName
    };

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(200).send(`<!doctype html>
<html lang="ru"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(take.name || 'Запись')}</title>
<style>
  *{box-sizing:border-box;}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#FBF8F3;color:#23201D;margin:0;padding:32px 16px;display:flex;flex-direction:column;align-items:center;gap:14px;}
  .mono{font-family:'JetBrains Mono',monospace;}
  .name-eyebrow{font-weight:800;font-size:11px;color:#A09488;text-transform:uppercase;letter-spacing:.08em;}
  .vr-box{background:#2A2622;border-radius:16px;padding:18px 20px;max-width:420px;width:100%;user-select:none;-webkit-user-select:none;}
  .vr-take-top{display:flex;align-items:center;gap:16px;}
  .vr-take-title{font-size:13.5px;font-weight:700;color:#F7F3EC;flex:1;min-width:0;}
  .vr-take-meta{font-family:'JetBrains Mono',monospace;font-size:11px;color:#A2968A;margin-left:52px;margin-top:2px;}
  .vr-tr-btn{height:34px;width:34px;border-radius:50%;border:1px solid #3A342E;background:transparent;color:#F7F3EC;font-size:13px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;}
  .vr-take-wave{position:relative;display:flex;gap:1px;align-items:center;height:30px;margin-top:12px;cursor:pointer;}
  .vr-take-bar{flex:1 1 0%;border-radius:2px;background:#5E544B;}
  .vr-take-bar.played{background:#A8452C;}
  .vr-take-pin{position:absolute;top:0;bottom:0;width:6px;border-radius:2px;background:#7C9A62;pointer-events:none;}
  .vr-take-transport{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:8px;}
  .vr-take-time{font-family:'JetBrains Mono',monospace;font-size:11.5px;color:#A2968A;}
  .vr-rate-btn{height:26px;padding:0 9px;border-radius:7px;border:1px solid #3A342E;background:transparent;color:#B5A8A1;font-size:11px;font-weight:600;cursor:pointer;font-family:inherit;}
  .vr-rate-btn.on{color:#C97B62;border-color:#5A3A30;}
  .vr-take-markers{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px;}
  .vr-mk-chip{padding:4px 8px;border-radius:7px;background:#332C26;color:#7C9A62;font-size:11.5px;font-family:'JetBrains Mono',monospace;cursor:pointer;}
  .note{font-size:11.5px;color:#A09488;max-width:420px;text-align:center;}
</style>
</head><body>
  <div class="name-eyebrow">${escapeHtml(payload.studentName)}</div>
  <div id="vrBox" class="vr-box"></div>
  <div class="note">Загружаю запись…</div>
<script>
  var DATA = ${JSON.stringify(payload)};
  function pad(n){ return n<10 ? '0'+n : String(n); }
  function fmtTime(sec){ sec = Math.max(0, Math.floor(sec||0)); return pad(Math.floor(sec/60))+':'+pad(sec%60); }
  function markerTime(m){ return m.t!=null ? m.t : (m.sec||0); }
  function sortedMarkers(markers){ return (markers||[]).slice().sort(function(a,b){ return markerTime(a)-markerTime(b); }); }
  function downsample(peaks, n){
    peaks = peaks||[];
    if(!peaks.length) return Array.from({length:n}).map(function(){ return 0; });
    var out = [];
    var bucket = peaks.length/n;
    for(var i=0;i<n;i++){
      var start = Math.floor(i*bucket), end = Math.max(start+1, Math.floor((i+1)*bucket));
      var m = 0;
      for(var j=start;j<end && j<peaks.length;j++){ m = Math.max(m, peaks[j]); }
      out.push(m);
    }
    var max = Math.max.apply(null, out.concat([0.0001]));
    return out.map(function(v){ return v/max; });
  }

  function escapeHtml(s){
    var d = document.createElement('div'); d.textContent = s==null?'':String(s); return d.innerHTML;
  }

  function render(audioSrc){
    var dur = DATA.durationSec || 0;
    var bars = downsample(DATA.peaks, 90);
    var markers = sortedMarkers(DATA.markers);
    var pins = dur ? markers.map(function(m){
      var pct = Math.min(100, Math.max(0, markerTime(m)/dur*100));
      return '<div class="vr-take-pin" style="left:'+pct+'%;"></div>';
    }).join('') : '';
    var chips = markers.map(function(m){
      return '<span class="vr-mk-chip" data-marker-t="'+markerTime(m)+'">'+fmtTime(markerTime(m))+(m.label?(' '+escapeHtml(m.label)):'')+'</span>';
    }).join('');
    var rateVals = [0.5,0.75,1,1.25,1.5,1.75,2];
    var rateBtns = rateVals.map(function(v){ return '<button type="button" class="vr-rate-btn'+(v===1?' on':'')+'" data-rate="'+v+'">'+v+'×</button>'; }).join('');

    document.getElementById('vrBox').innerHTML =
      '<audio id="vrAudio" src="'+audioSrc+'" preload="metadata" style="display:none;"></audio>'+
      '<div class="vr-take-top">'+
        '<button type="button" class="vr-tr-btn" id="vrPlay">▶</button>'+
        '<div class="vr-take-title">'+escapeHtml(DATA.name)+'</div>'+
      '</div>'+
      '<div class="vr-take-meta" id="vrMeta"></div>'+
      '<div class="vr-take-wave" id="vrWave" data-duration="'+dur+'">'+
        bars.map(function(v){ return '<div class="vr-take-bar" style="height:'+Math.max(2,Math.round(v*28))+'px;"></div>'; }).join('')+
        pins+
      '</div>'+
      '<div class="vr-take-transport">'+
        '<span class="vr-take-time" id="vrTime">0:00 / '+fmtTime(dur)+'</span>'+
        rateBtns+
      '</div>'+
      '<div class="vr-take-markers">'+chips+'</div>';

    document.querySelector('.note').textContent = '';

    var audio = document.getElementById('vrAudio');
    var playBtn = document.getElementById('vrPlay');
    var timeEl = document.getElementById('vrTime');
    var waveEl = document.getElementById('vrWave');

    function updateWave(){
      var d = dur || audio.duration || 0;
      if(!d) return;
      var pct = Math.min(1, audio.currentTime/d);
      var allBars = waveEl.querySelectorAll('.vr-take-bar');
      var cut = Math.floor(pct*allBars.length);
      allBars.forEach(function(b,i){ b.classList.toggle('played', i<cut); });
    }
    audio.addEventListener('timeupdate', function(){
      timeEl.textContent = fmtTime(audio.currentTime)+' / '+fmtTime(dur||audio.duration||0);
      updateWave();
    });
    audio.addEventListener('play', function(){ playBtn.textContent = '❚❚'; });
    audio.addEventListener('pause', function(){ playBtn.textContent = '▶'; });
    audio.addEventListener('ended', function(){ playBtn.textContent = '▶'; });
    playBtn.onclick = function(){ if(audio.paused){ audio.play().catch(function(){}); } else { audio.pause(); } };
    waveEl.onclick = function(e){
      var rect = waveEl.getBoundingClientRect();
      var pct = Math.min(1, Math.max(0, (e.clientX-rect.left)/rect.width));
      audio.currentTime = pct*(dur||audio.duration||0);
    };
    document.querySelectorAll('.vr-rate-btn').forEach(function(b){
      b.onclick = function(){
        audio.playbackRate = parseFloat(b.getAttribute('data-rate'));
        document.querySelectorAll('.vr-rate-btn').forEach(function(x){ x.classList.toggle('on', x===b); });
      };
    });
    document.querySelectorAll('.vr-mk-chip').forEach(function(chip){
      chip.onclick = function(){ audio.currentTime = parseFloat(chip.getAttribute('data-marker-t'))||0; };
    });

    var metaParts = [];
    if(DATA.createdAt){
      var d = new Date(DATA.createdAt);
      if(!isNaN(d)) metaParts.push(pad(d.getDate())+'.'+pad(d.getMonth()+1)+'.'+d.getFullYear());
    }
    metaParts.push(fmtTime(dur));
    document.getElementById('vrMeta').textContent = metaParts.join(' · ');
  }

  // Большой data: URI в src у некоторых мобильных браузеров просто не
  // проигрывается — конвертируем в Blob-URL, это надёжнее.
  fetch(DATA.dataUrl).then(function(r){ return r.blob(); }).then(function(blob){
    render(URL.createObjectURL(blob));
  }).catch(function(){
    render(DATA.dataUrl);
  });
</script>
</body></html>`);
  } catch (err) {
    const status = err.code === 'DB_NOT_CONFIGURED' ? 503 : 500;
    res.status(status).send('Ошибка: ' + (err.message || String(err)));
  }
};
