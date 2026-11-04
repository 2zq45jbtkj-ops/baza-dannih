/* ============================================================
   КАЛЕНДАРЬ — недельная сетка с уроками.

   Отдельный файл, а не очередная тысяча строк в index.html: всё,
   что календарю нужно от основного приложения, перечислено здесь
   в одном месте (см. «Контракт» ниже). Остальной код про него
   знает ровно две вещи — state.view и renderCalendarView().

   Контракт с index.html:
     state.view            'student' | 'calendar'
     state.data.students   [{id, name, status}]
     state.activeStudentId
     render()              перерисовать всё приложение
     apiGet / apiSend      тонкие обёртки над fetch
     setStudentView(id)    открыть карточку ученика (см. index.html)

   Время НЕ хранится как timestamptz: событие — это локальная дата
   плюс минуты от полуночи (см. комментарий к calendar_events в
   api/_db.js). Благодаря этому здесь нет ни одного перевода часовых
   поясов, а урок «вторник 18:00» остаётся вторником 18:00.
   ============================================================ */

const CAL_DAY_START = 7;   // первый час в сетке
const CAL_DAY_END   = 23;  // последний (граница, не рисуется строкой)
const CAL_PX_PER_MIN = 0.85;

const CAL_SOURCES = {
  personal: { label: 'Моё',    color: 'var(--terracotta)' },
  studio:   { label: 'Студия', color: 'var(--blue)' }
};

const calState = {
  weekStart: calMonday(new Date()),
  events: [],
  loading: false,
  error: null,
  editing: null,     // черновик события в модалке, либо null
  tick: null         // id интервала, двигающего бегунок
};

/* ---------- мелкие помощники ---------- */

function calEsc(s){
  return String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function calMonday(d){
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  // getDay(): воскресенье = 0, а неделя у нас начинается с понедельника
  const shift = (x.getDay() + 6) % 7;
  x.setDate(x.getDate() - shift);
  return x;
}

function calAddDays(d, n){
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() + n);
  return x;
}

// Локальный ISO-день. Намеренно НЕ toISOString(): тот переводит в UTC и
// в Москве до 03:00 возвращает вчерашнюю дату.
function calISO(d){
  const p = (n)=> String(n).padStart(2,'0');
  return d.getFullYear() + '-' + p(d.getMonth()+1) + '-' + p(d.getDate());
}

function calHM(min){
  const p = (n)=> String(n).padStart(2,'0');
  return p(Math.floor(min/60)) + ':' + p(min%60);
}

function calParseHM(s){
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s||'').trim());
  if(!m) return null;
  const h = Number(m[1]), mm = Number(m[2]);
  if(h > 23 || mm > 59) return null;
  return h*60 + mm;
}

function calNowMin(){
  const n = new Date();
  return n.getHours()*60 + n.getMinutes();
}

const CAL_DOW = ['Пн','Вт','Ср','Чт','Пт','Сб','Вс'];
const CAL_MONTHS = ['января','февраля','марта','апреля','мая','июня',
                    'июля','августа','сентября','октября','ноября','декабря'];

function calStudentName(id){
  const s = (state.data.students || []).find(x => x.id === id);
  return s ? s.name : '';
}

// Что показать в блоке: явный заголовок, иначе имя ученика, иначе «Урок».
function calTitleOf(ev){
  return ev.title || calStudentName(ev.studentId) || 'Урок';
}

function calColorOf(ev){
  return ev.color || (CAL_SOURCES[ev.source] || CAL_SOURCES.personal).color;
}

/* ---------- разворачивание повторов ---------- */

// Превращает хранимые события в конкретные «этот день — этот блок».
// Повторы недельные, поэтому достаточно сверить день недели и границы.
function calOccurrences(days){
  const out = days.map(()=> []);
  days.forEach((dayDate, i) => {
    const iso = calISO(dayDate);
    calState.events.forEach(ev => {
      if(!ev.day) return;
      let hits;
      if(ev.repeatWeekly){
        const base = new Date(ev.day + 'T00:00:00');
        hits = base.getDay() === dayDate.getDay()
            && iso >= ev.day
            && (!ev.repeatUntil || iso <= ev.repeatUntil);
      } else {
        hits = ev.day === iso;
      }
      if(hits) out[i].push(Object.assign({}, ev, { _day: iso }));
    });
    out[i].sort((a,b)=> a.startMin - b.startMin || a.endMin - b.endMin);
  });
  return out;
}

// Пересекающиеся по времени события делят ширину колонки. Простая
// жадная раскладка: копим «пачку» налезающих друг на друга блоков и
// раздаём им слоты. Для расписания педагога этого достаточно —
// настоящий interval-graph тут оверкилл.
function calLayout(list){
  let batch = [], batchEnd = -1;
  const flush = ()=>{
    batch.forEach((ev, i) => { ev._lane = i; ev._lanes = batch.length; });
    batch = []; batchEnd = -1;
  };
  list.forEach(ev => {
    if(batch.length && ev.startMin >= batchEnd) flush();
    batch.push(ev);
    batchEnd = Math.max(batchEnd, ev.endMin);
  });
  flush();
  return list;
}

/* ---------- загрузка ---------- */

async function calLoad(){
  const from = calISO(calState.weekStart);
  const to = calISO(calAddDays(calState.weekStart, 6));
  calState.loading = true;
  calState.error = null;
  try{
    const r = await apiGet('/api/lessons?part=calendar&from=' + from + '&to=' + to);
    calState.events = (r && r.events) || [];
  } catch(err){
    calState.error = String(err.message || err);
    calState.events = [];
  }
  calState.loading = false;
}

/* ---------- отрисовка ---------- */

function renderCalendarView(){
  const main = document.getElementById('mainArea');
  if(!main) return;
  main.innerHTML = `<div class="cal-wrap"><div class="kb-loading">Загружаю календарь…</div></div>`;
  calLoad().then(paintCalendar);
}

function paintCalendar(){
  const main = document.getElementById('mainArea');
  if(!main || state.view !== 'calendar') return;

  const days = [];
  for(let i = 0; i < 7; i++) days.push(calAddDays(calState.weekStart, i));
  const todayISO = calISO(new Date());
  const perDay = calOccurrences(days).map(calLayout);

  const first = days[0], last = days[6];
  const rangeLabel = first.getMonth() === last.getMonth()
    ? `${first.getDate()}–${last.getDate()} ${CAL_MONTHS[first.getMonth()]} ${first.getFullYear()}`
    : `${first.getDate()} ${CAL_MONTHS[first.getMonth()]} — ${last.getDate()} ${CAL_MONTHS[last.getMonth()]} ${last.getFullYear()}`;

  const gridH = (CAL_DAY_END - CAL_DAY_START) * 60 * CAL_PX_PER_MIN;

  let hourRows = '', hourLabels = '';
  for(let h = CAL_DAY_START; h < CAL_DAY_END; h++){
    const top = (h - CAL_DAY_START) * 60 * CAL_PX_PER_MIN;
    hourRows += `<div class="cal-hline" style="top:${top}px"></div>`;
    hourLabels += `<div class="cal-hlabel" style="top:${top}px">${calHM(h*60)}</div>`;
  }

  const columns = days.map((d, i) => {
    const iso = calISO(d);
    const isToday = iso === todayISO;
    const blocks = perDay[i].map(ev => {
      const top = (ev.startMin - CAL_DAY_START*60) * CAL_PX_PER_MIN;
      const h = Math.max(18, (ev.endMin - ev.startMin) * CAL_PX_PER_MIN);
      const lanes = ev._lanes || 1, lane = ev._lane || 0;
      const w = 100 / lanes;
      const color = calColorOf(ev);
      const sub = ev.location || (ev.studentId && ev.title ? calStudentName(ev.studentId) : '');
      return `<div class="cal-ev cal-ev-${calEsc(ev.source)}" data-ev="${calEsc(ev.id)}"
                   style="top:${top}px;height:${h}px;left:${lane*w}%;width:calc(${w}% - 3px);
                          --ev-color:${color}">
                <div class="cal-ev-time">${calHM(ev.startMin)}–${calHM(ev.endMin)}</div>
                <div class="cal-ev-title">${calEsc(calTitleOf(ev))}</div>
                ${sub ? `<div class="cal-ev-sub">${calEsc(sub)}</div>` : ''}
              </div>`;
    }).join('');

    const nowLine = isToday ? calNowLineHTML() : '';

    return `<div class="cal-col${isToday ? ' cal-col-today' : ''}" data-day="${iso}"
                 style="height:${gridH}px">
              ${hourRows}
              ${blocks}
              ${nowLine}
            </div>`;
  }).join('');

  const heads = days.map(d => {
    const iso = calISO(d);
    const isToday = iso === todayISO;
    return `<div class="cal-head${isToday ? ' cal-head-today' : ''}">
              <span class="cal-head-dow">${CAL_DOW[(d.getDay()+6)%7]}</span>
              <span class="cal-head-num">${d.getDate()}</span>
            </div>`;
  }).join('');

  main.innerHTML = `
    <div class="cal-wrap">
      <div class="cal-toolbar">
        <div class="cal-toolbar-left">
          <h1 class="cal-title">Календарь</h1>
          <span class="cal-range">${calEsc(rangeLabel)}</span>
        </div>
        <div class="cal-toolbar-right">
          <div class="cal-legend">
            <span class="cal-dot" style="--ev-color:var(--terracotta)"></span>Моё
            <span class="cal-dot" style="--ev-color:var(--blue)"></span>Студия
          </div>
          <button class="cal-btn" id="calPrev" title="Предыдущая неделя">←</button>
          <button class="cal-btn" id="calToday">Сегодня</button>
          <button class="cal-btn" id="calNext" title="Следующая неделя">→</button>
          <button class="cal-btn cal-btn-primary" id="calAdd">+ Урок</button>
        </div>
      </div>

      <div class="cal-now-bar" id="calNowBar">${calNowSummary()}</div>

      ${calState.error ? `<div class="card-error">Не удалось загрузить календарь: ${calEsc(calState.error)}</div>` : ''}

      <div class="cal-grid">
        <div class="cal-head-row">
          <div class="cal-gutter-head"></div>
          <div class="cal-heads">${heads}</div>
        </div>
        <!-- Шкала часов и колонки лежат ВНУТРИ одного скроллера: если
             прокручивать их по отдельности, подписи часов разъезжаются с
             сеткой. Шапка дней снаружи и остаётся на месте. -->
        <div class="cal-body" id="calBody">
          <div class="cal-body-inner" style="height:${gridH}px">
            <div class="cal-gutter">${hourLabels}${calNowPinHTML(days)}</div>
            <div class="cal-cols">${columns}</div>
          </div>
        </div>
      </div>
    </div>
  `;

  wireCalendar();
  calStartTick();
}

// Бегунок: линия на позиции текущего времени внутри сегодняшней колонки.
// Сами часы показываются не здесь, а на шкале слева (calNowPinHTML) —
// внутри колонки плашка налезала бы на название урока.
function calNowLineHTML(){
  const m = calNowMin();
  if(m < CAL_DAY_START*60 || m > CAL_DAY_END*60) return '';
  const top = (m - CAL_DAY_START*60) * CAL_PX_PER_MIN;
  return `<div class="cal-now" id="calNowLine" style="top:${top}px"></div>`;
}

// Метка текущего времени на шкале часов. Рисуется, только если сегодняшний
// день попадает в показанную неделю — иначе бегунка на сетке тоже нет.
function calNowPinHTML(days){
  const todayISO = calISO(new Date());
  if(!days.some(d => calISO(d) === todayISO)) return '';
  const m = calNowMin();
  if(m < CAL_DAY_START*60 || m > CAL_DAY_END*60) return '';
  const top = (m - CAL_DAY_START*60) * CAL_PX_PER_MIN;
  return `<div class="cal-now-pin" id="calNowPin" style="top:${top}px">${calHM(m)}</div>`;
}

// «Что сейчас» — текстовая строка над сеткой. Отвечает на вопрос
// «что у меня прямо в эту минуту и что следующее», не заставляя
// вглядываться в сетку.
function calNowSummary(){
  const nowISO = calISO(new Date());
  const m = calNowMin();
  const today = calOccurrences([new Date()])[0];

  const current = today.find(ev => m >= ev.startMin && m < ev.endMin);
  const next = today.find(ev => ev.startMin > m);

  if(current){
    const left = current.endMin - m;
    return `<span class="cal-now-badge" style="--ev-color:${calColorOf(current)}">сейчас</span>
            <b>${calEsc(calTitleOf(current))}</b>
            <span class="cal-now-dim">${calHM(current.startMin)}–${calHM(current.endMin)},
            осталось ${left} мин</span>`
         + (next ? ` <span class="cal-now-sep">·</span> <span class="cal-now-dim">далее
            ${calHM(next.startMin)} ${calEsc(calTitleOf(next))}</span>` : '');
  }
  if(next){
    const inMin = next.startMin - m;
    const h = Math.floor(inMin/60), mm = inMin%60;
    const when = h ? `через ${h} ч ${mm} мин` : `через ${mm} мин`;
    return `<span class="cal-now-badge cal-now-badge-idle">далее</span>
            <b>${calEsc(calTitleOf(next))}</b>
            <span class="cal-now-dim">${calHM(next.startMin)}–${calHM(next.endMin)}, ${when}</span>`;
  }
  return `<span class="cal-now-badge cal-now-badge-idle">сегодня</span>
          <span class="cal-now-dim">${today.length ? 'уроки на сегодня закончились' : 'уроков нет'}</span>`;
}

// Двигаем бегунок и пересчитываем строку «что сейчас» раз в полминуты,
// не перерисовывая всю сетку — иначе каждые 30 секунд слетал бы скролл.
function calStartTick(){
  if(calState.tick) clearInterval(calState.tick);
  calState.tick = setInterval(()=>{
    if(state.view !== 'calendar'){ clearInterval(calState.tick); calState.tick = null; return; }
    const m = calNowMin();
    if(m >= CAL_DAY_START*60 && m <= CAL_DAY_END*60){
      const top = ((m - CAL_DAY_START*60) * CAL_PX_PER_MIN) + 'px';
      const line = document.getElementById('calNowLine');
      if(line) line.style.top = top;
      const pin = document.getElementById('calNowPin');
      if(pin){ pin.style.top = top; pin.textContent = calHM(m); }
    }
    const bar = document.getElementById('calNowBar');
    if(bar) bar.innerHTML = calNowSummary();
  }, 30000);
}

/* ---------- обработчики ---------- */

function wireCalendar(){
  document.getElementById('calPrev').onclick = ()=>{
    calState.weekStart = calAddDays(calState.weekStart, -7);
    renderCalendarView();
  };
  document.getElementById('calNext').onclick = ()=>{
    calState.weekStart = calAddDays(calState.weekStart, 7);
    renderCalendarView();
  };
  document.getElementById('calToday').onclick = ()=>{
    calState.weekStart = calMonday(new Date());
    renderCalendarView();
  };
  document.getElementById('calAdd').onclick = ()=> calOpenEditor(null, calISO(new Date()), 18*60);

  document.querySelectorAll('.cal-ev').forEach(el => {
    el.onclick = (e)=>{
      e.stopPropagation();
      const ev = calState.events.find(x => x.id === el.dataset.ev);
      if(ev) calOpenEditor(ev);
    };
  });

  // Клик по пустому месту колонки — новое событие с этого получаса.
  document.querySelectorAll('.cal-col').forEach(col => {
    col.onclick = (e)=>{
      if(e.target.closest('.cal-ev')) return;
      const rect = col.getBoundingClientRect();
      const min = CAL_DAY_START*60 + Math.round((e.clientY - rect.top) / CAL_PX_PER_MIN / 30) * 30;
      calOpenEditor(null, col.dataset.day, Math.min(min, CAL_DAY_END*60 - 60));
    };
  });

  // Прокручиваем к текущему времени, чтобы не открываться на 7 утра.
  const body = document.getElementById('calBody');
  if(body){
    const m = calNowMin();
    body.scrollTop = Math.max(0, (m - CAL_DAY_START*60 - 90) * CAL_PX_PER_MIN);
  }
}

/* ---------- редактор события ---------- */

function calOpenEditor(ev, dayISO, startMin){
  calState.editing = ev
    ? Object.assign({}, ev)
    : { id: null, source: 'personal', studentId: null, title: '',
        day: dayISO || calISO(new Date()),
        startMin: startMin != null ? startMin : 18*60,
        endMin: (startMin != null ? startMin : 18*60) + 60,
        location: '', note: '', repeatWeekly: false, repeatUntil: null };
  calPaintEditor();
}

function calPaintEditor(){
  const d = calState.editing;
  document.getElementById('calModal')?.remove();
  if(!d) return;

  const studentOpts = `<option value="">— без ученика —</option>` +
    (state.data.students || [])
      .map(s => `<option value="${calEsc(s.id)}" ${d.studentId===s.id?'selected':''}>${calEsc(s.name)}</option>`)
      .join('');

  const wrap = document.createElement('div');
  wrap.id = 'calModal';
  wrap.className = 'cal-modal-backdrop';
  wrap.innerHTML = `
    <div class="cal-modal">
      <div class="cal-modal-head">
        <h2>${d.id ? 'Урок' : 'Новый урок'}</h2>
        <button class="cal-modal-x" id="calClose">✕</button>
      </div>

      <label class="cal-field">
        <span>Кто</span>
        <select id="calStudent">${studentOpts}</select>
      </label>

      <label class="cal-field">
        <span>Название <i>(необязательно — подставится имя ученика)</i></span>
        <input type="text" id="calTitle" value="${calEsc(d.title)}" placeholder="Урок вокала">
      </label>

      <div class="cal-field-row">
        <label class="cal-field">
          <span>Дата</span>
          <input type="date" lang="ru" id="calDay" value="${calEsc(d.day)}">
        </label>
        <label class="cal-field cal-field-sm">
          <span>С</span>
          <input type="time" id="calStart" value="${calHM(d.startMin)}">
        </label>
        <label class="cal-field cal-field-sm">
          <span>До</span>
          <input type="time" id="calEnd" value="${calHM(d.endMin)}">
        </label>
      </div>

      <label class="cal-field">
        <span>Откуда</span>
        <select id="calSource">
          <option value="personal" ${d.source==='personal'?'selected':''}>Моё расписание</option>
          <option value="studio" ${d.source==='studio'?'selected':''}>Студия</option>
        </select>
      </label>

      <label class="cal-field">
        <span>Место</span>
        <input type="text" id="calLoc" value="${calEsc(d.location)}" placeholder="Кабинет 3 / онлайн">
      </label>

      <label class="cal-check">
        <input type="checkbox" id="calRepeat" ${d.repeatWeekly?'checked':''}>
        <span>Каждую неделю в этот день</span>
      </label>
      <label class="cal-field ${d.repeatWeekly?'':'cal-hidden'}" id="calUntilWrap">
        <span>До какой даты повторять <i>(пусто — бессрочно)</i></span>
        <input type="date" lang="ru" id="calUntil" value="${calEsc(d.repeatUntil||'')}">
      </label>

      <label class="cal-field">
        <span>Заметка</span>
        <textarea id="calNote" rows="2">${calEsc(d.note)}</textarea>
      </label>

      <div class="cal-modal-foot">
        ${d.id ? `<button class="cal-btn cal-btn-danger" id="calDelete">Удалить</button>` : '<span></span>'}
        <div class="cal-modal-foot-right">
          ${d.studentId ? `<button class="cal-btn" id="calGoStudent">К карточке</button>` : ''}
          <button class="cal-btn cal-btn-primary" id="calSave">Сохранить</button>
        </div>
      </div>
      <div class="cal-modal-err" id="calErr"></div>
    </div>
  `;
  document.body.appendChild(wrap);

  const close = ()=>{ calState.editing = null; wrap.remove(); };
  document.getElementById('calClose').onclick = close;
  wrap.onclick = (e)=>{ if(e.target === wrap) close(); };

  document.getElementById('calRepeat').onchange = (e)=>{
    document.getElementById('calUntilWrap').classList.toggle('cal-hidden', !e.target.checked);
  };

  const goBtn = document.getElementById('calGoStudent');
  if(goBtn) goBtn.onclick = ()=>{ const id = d.studentId; close(); setStudentView(id); };

  const delBtn = document.getElementById('calDelete');
  if(delBtn) delBtn.onclick = async ()=>{
    if(!confirm('Удалить этот урок из календаря?')) return;
    await apiSend('/api/lessons?part=calendar&id=' + encodeURIComponent(d.id), 'DELETE', {});
    close();
    renderCalendarView();
  };

  document.getElementById('calSave').onclick = async ()=>{
    const err = document.getElementById('calErr');
    const startMin = calParseHM(document.getElementById('calStart').value);
    const endMin = calParseHM(document.getElementById('calEnd').value);
    const day = document.getElementById('calDay').value;
    if(!day){ err.textContent = 'Укажите дату.'; return; }
    if(startMin == null || endMin == null){ err.textContent = 'Укажите время начала и конца.'; return; }
    if(endMin <= startMin){ err.textContent = 'Конец урока должен быть позже начала.'; return; }

    const repeatWeekly = document.getElementById('calRepeat').checked;
    const payload = {
      id: d.id,
      studentId: document.getElementById('calStudent').value || null,
      title: document.getElementById('calTitle').value.trim(),
      source: document.getElementById('calSource').value,
      day, startMin, endMin,
      location: document.getElementById('calLoc').value.trim(),
      note: document.getElementById('calNote').value.trim(),
      repeatWeekly,
      repeatUntil: repeatWeekly ? (document.getElementById('calUntil').value || null) : null
    };
    err.textContent = '';
    try{
      await apiSend('/api/lessons?part=calendar', 'POST', payload);
      close();
      renderCalendarView();
    } catch(e){
      err.textContent = 'Не удалось сохранить: ' + String(e.message || e);
    }
  };
}
